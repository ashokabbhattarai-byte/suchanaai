import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Query,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  Body,
  Res,
  ParseUUIDPipe,
  BadRequestException,
  ForbiddenException,
  PayloadTooLargeException,
  Catch,
  ArgumentsHost,
  ExceptionFilter,
  UseFilters,
  HttpException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { MulterError, memoryStorage } from 'multer';
import { Response } from 'express';
import { SkipThrottle } from '@nestjs/throttler';
import { User } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../guards/optional-jwt-auth.guard';
import { CurrentUser } from '../decorators/current-user.decorator';
import { DocumentsService } from '../services/documents.service';
import { QuotaService } from '../services/quota.service';
import { UploadDocumentDto } from '../dto/upload-document.dto';
import { ListDocumentsDto } from '../dto/list-documents.dto';
import * as crypto from 'crypto';

const ALLOWED_MIME_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  'image/png',
  'image/jpeg',
];

/**
 * Embeddable document ceiling. This is the *infrastructure* hard cap — the
 * largest file the AI pipeline (memory, Qdrant) can handle. Per-plan limits
 * (5 MB FREE, up to maxUploadMb for paid tiers) are enforced separately by
 * QuotaService.assertCanAddDocument, which returns 402 with upgrade guidance.
 * Set to the maximum of all plan maxUploadMb values so a paid user is never
 * blocked by this ceiling before the plan-aware check.
 *
 * Default 100 MB covers all current tiers (FREE 5 / PRO 25 / MAX 100); raise
 * via MAX_UPLOAD_MB env if a larger plan is configured — env may only raise,
 * never lower, the ceiling so a misconfigured env never blocks paid users.
 */
export const MAX_FILE_SIZE_MB = Math.max(Number(process.env.MAX_UPLOAD_MB) || 100, 100);
const MAX_FILE_SIZE = MAX_FILE_SIZE_MB * 1024 * 1024;

/**
 * Multer aborts an oversized upload with a raw `MulterError`, which Nest would
 * surface as an opaque 500. Translate it into the same 413 the explicit size
 * check returns, so the UI always shows one clear message.
 */
@Catch(MulterError, BadRequestException)
class MulterExceptionFilter implements ExceptionFilter {
  catch(error: MulterError | BadRequestException, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse();
    if (error instanceof BadRequestException) {
      const status = error.getStatus();
      response.status(status).json(error.getResponse());
      return;
    }
    const exception =
      (error as MulterError).code === 'LIMIT_FILE_SIZE'
        ? new PayloadTooLargeException(
            `File is larger than the ${MAX_FILE_SIZE_MB} MB limit.`,
          )
        : new BadRequestException(`Upload failed: ${(error as Error).message}`);
    const status = (exception as HttpException).getStatus();
    response.status(status).json(exception.getResponse());
  }
}

function isValidMagic(buffer: Buffer, mime: string): boolean {
  if (!buffer || buffer.length < 4) return false;
  if (mime === 'application/pdf') {
    return buffer.slice(0, 4).toString() === '%PDF';
  }
  if (mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    return buffer[0] === 0x50 && buffer[1] === 0x4b;
  }
  if (mime === 'image/png') {
    return buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47;
  }
  if (mime === 'image/jpeg') {
    return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }
  if (mime === 'text/plain') {
    return true;
  }
  return false;
}

// Buffered in memory, not written to local disk — DocumentsService.create()
// uploads the buffer straight to S3. Files here are capped at MAX_FILE_SIZE
// (a few MB), so holding one in memory per concurrent upload is cheap.
const storage = memoryStorage();

@Controller('documents')
export class DocumentsController {
  constructor(
    private readonly documentsService: DocumentsService,
    private readonly quota: QuotaService,
  ) {}

  @Post()
  @SkipThrottle()
  @UseGuards(JwtAuthGuard)
  @UseFilters(MulterExceptionFilter)
  @UseInterceptors(
    FileInterceptor('file', {
      storage,
      limits: { fileSize: MAX_FILE_SIZE },
      fileFilter: (_req, file, cb) => {
        if (ALLOWED_MIME_TYPES.includes(file.mimetype)) {
          cb(null, true);
        } else {
          cb(
            new BadRequestException(
              `File type ${file.mimetype} is not allowed. Allowed types: PDF, DOCX, TXT, PNG, JPEG`,
            ),
            false,
          );
        }
      },
    }),
  )
  async upload(
    @UploadedFile() file: Express.Multer.File,
    @Body() dto: UploadDocumentDto,
    @CurrentUser() user: User,
  ) {
    if (!file) {
      throw new BadRequestException('File is required');
    }

    // Multer truncates at the limit rather than rejecting; nothing to clean
    // up on disk now that uploads are memory-buffered, just reject.
    if (file.size > MAX_FILE_SIZE) {
      throw new PayloadTooLargeException(
        `File is ${(file.size / 1024 / 1024).toFixed(1)} MB — the limit is ${MAX_FILE_SIZE_MB} MB.`,
      );
    }

    if (file.buffer && !isValidMagic(file.buffer, file.mimetype)) {
      throw new BadRequestException('File content does not match declared type');
    }

    // Multer's hard cap is the infrastructure ceiling; the plan-aware limit
    // gives the user a 402 with quota details and an upgrade CTA. Check the
    // plan first so the error is actionable (Multer's 413 is generic).
    await this.quota.assertCanAddDocument(user.id, file.size);

    // Compute SHA-256 hash for deduplication
    const fileHash = crypto.createHash('sha256').update(file.buffer).digest('hex');

    // Check for existing document with same hash
    const existing = await this.documentsService.findByHash(fileHash);
    if (existing) {
      return {
        ...existing,
        deduplicated: true,
      };
    }

    // A real UUID — not a truncated content hash. That used to produce a
    // technically-hex-valid-but-not-RFC4122-compliant string (random bits in
    // the version/variant nibbles), which silently failed strict `@IsUUID()`
    // validation on ~75% of uploads the moment a query referenced the
    // document (e.g. "documentId must be a UUID" in RAG chat). Dedup by
    // content already works independently via the fileHash column below.
    const docId = uuidv4();

    let document;
    try {
      document = await this.documentsService.create({
        id: docId,
        title: dto.title,
        filename: file.originalname,
        mimeType: file.mimetype,
        fileSize: file.size,
        buffer: file.buffer,
        uploadedBy: user.id,
        fileHash: fileHash,
      });
    } catch (e: any) {
      // Race: another concurrent upload with same hash won the unique constraint
      if (e?.code === 'P2002' && e?.meta?.target?.includes('file_hash')) {
        const raced = await this.documentsService.findByHash(fileHash);
        if (raced) {
          return { ...raced, deduplicated: true };
        }
      }
      throw e;
    }

    // Recorded only once the document exists — a deduplicated or rejected
    // upload must not spend allowance.
    await this.quota.recordDocumentUpload(user.id, {
      documentId: document.id,
      filename: file.originalname,
      sizeBytes: file.size,
    });

    return document;
  }

  // Returns system docs + user's own docs (scoped)
  @Get()
  @UseGuards(OptionalJwtAuthGuard)
  async findAll(
    @Query() dto: ListDocumentsDto,
    @CurrentUser() user: User | null,
  ) {
    return this.documentsService.findAll(dto, user?.id);
  }

  @SkipThrottle()
  @Get('progress/batch')
  @UseGuards(OptionalJwtAuthGuard)
  async progressBatch(
    @Query('ids') ids?: string,
  ) {
    const docIds = (ids ?? '').split(',').filter(Boolean).slice(0, 50);
    return this.documentsService.getProgressBatch(docIds);
  }

  @Get(':id')
  @UseGuards(OptionalJwtAuthGuard)
  async findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.documentsService.findOne(id);
  }

  @Post(':id/embed')
  @UseGuards(JwtAuthGuard)
  async embed(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: User,
  ) {
    const doc = await this.documentsService.findOne(id);
    if (!doc.isSystem && doc.uploadedBy !== user.id) {
      throw new ForbiddenException('You can only embed your own documents');
    }
    return this.documentsService.embed(id);
  }

  @Post(':id/unembed')
  @UseGuards(JwtAuthGuard)
  async unembed(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: User,
  ) {
    const doc = await this.documentsService.findOne(id);
    if (doc.isSystem) {
      throw new ForbiddenException('System documents cannot be unembedded');
    }
    if (doc.uploadedBy !== user.id) {
      throw new ForbiddenException('You can only unembed your own documents');
    }
    return this.documentsService.unembed(id);
  }

  @SkipThrottle()
  @Get(':id/progress')
  @UseGuards(OptionalJwtAuthGuard)
  async progress(@Param('id', ParseUUIDPipe) id: string) {
    return this.documentsService.getProgress(id);
  }

  @SkipThrottle()
  @Get(':id/progress/stream')
  @UseGuards(OptionalJwtAuthGuard)
  async progressStream(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    await this.documentsService.streamProgress(id, res);
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard)
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: User,
  ) {
    const doc = await this.documentsService.findOne(id);
    if (doc.isSystem) {
      throw new ForbiddenException('System documents cannot be deleted');
    }
    if (doc.uploadedBy !== user.id) {
      throw new ForbiddenException('You can only delete your own documents');
    }
    await this.documentsService.remove(id);
    return { message: 'Document deleted successfully' };
  }

  @Get(':id/download')
  @UseGuards(OptionalJwtAuthGuard)
  async download(
    @Param('id', ParseUUIDPipe) id: string,
    @Res() res: Response,
  ) {
    const document = await this.documentsService.findOne(id);
    const url = await this.documentsService.getDownloadUrl(document);
    res.redirect(302, url);
  }
}
