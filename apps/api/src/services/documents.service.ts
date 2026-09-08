import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { Document, DocumentStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { S3StorageService } from '../common/storage/s3-storage.service';
import { ListDocumentsDto } from '../dto/list-documents.dto';
import { firstValueFrom } from 'rxjs';
import type { Response } from 'express';
import FormData = require('form-data');

@Injectable()
export class DocumentsService {
  private readonly logger = new Logger(DocumentsService.name);
  private readonly aiServiceUrl: string;
  private readonly aiIndexTimeoutMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly httpService: HttpService,
    private readonly config: ConfigService,
    private readonly storage: S3StorageService,
  ) {
    this.aiServiceUrl =
      this.config.get<string>('AI_SERVICE_URL') || 'http://localhost:8000';
    // Large documents (OCR + embedding) can take a while; default 10 minutes.
    this.aiIndexTimeoutMs = Number(
      this.config.get<string>('AI_INDEX_TIMEOUT_MS') ?? 600000,
    );
  }

  async create(data: {
    id: string;
    title: string;
    filename: string;
    mimeType: string;
    fileSize: number;
    buffer: Buffer;
    uploadedBy: string;
    fileHash: string;
  }): Promise<Document> {
    const { buffer, ...rest } = data;
    const storageKey = this.storage.buildDocumentKey(data.id, data.filename);
    await this.storage.uploadBuffer(storageKey, buffer, data.mimeType);

    const document = await this.prisma.document.create({
      data: { ...rest, storageKey },
    });

    // Process asynchronously - don't block the upload response
    this.processDocument(document).catch((err) => {
      this.logger.error(
        `Failed to process document ${document.id}: ${err.message}`,
      );
    });

    return document;
  }

  /** Find a document by its content hash (for deduplication). */
  async findByHash(fileHash: string): Promise<Document | null> {
    return this.prisma.document.findFirst({
      where: { fileHash },
    });
  }

  async findAll(dto: ListDocumentsDto, userId?: string) {
    const { page = 1, limit = 20, status } = dto;
    const skip = (page - 1) * limit;

    // Show system docs to everyone; user docs only to their owner
    const where: Prisma.DocumentWhereInput = {
      AND: [
        // Scope: system docs OR docs owned by this user
        userId
          ? { OR: [{ isSystem: true }, { uploadedBy: userId }] }
          : { isSystem: true },
        // Optional status filter
        ...(status ? [{ status }] : []),
      ],
    };

    const [documents, total] = await Promise.all([
      this.prisma.document.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: { user: { select: { id: true, name: true, email: true } } },
      }),
      this.prisma.document.count({ where }),
    ]);

    return {
      data: documents,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async findOne(id: string): Promise<Document> {
    const document = await this.prisma.document.findUnique({
      where: { id },
      include: { user: { select: { id: true, name: true, email: true } } },
    });

    if (!document) {
      throw new NotFoundException(`Document with id ${id} not found`);
    }

    return document;
  }

  async remove(id: string): Promise<void> {
    const document = await this.findOne(id);

    // Try to remove from AI service vector store with retries.
    // If AI is temporarily down, we still delete S3/DB but queue a
    // background retry so orphan vectors don't linger in Qdrant.
    let vectorDeleted = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await firstValueFrom(
          this.httpService.delete(`${this.aiServiceUrl}/documents/${id}`, {
            timeout: 5000,
          }),
        );
        vectorDeleted = true;
        break;
      } catch (err: any) {
        const status = err.response?.status;
        // 404 means already gone — treat as success
        if (status === 404) {
          vectorDeleted = true;
          break;
        }
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
          continue;
        }
        this.logger.warn(
          `Failed to delete document ${id} from AI service after 3 attempts: ${err.message}`,
        );
      }
    }

    if (!vectorDeleted) {
      // Fire-and-forget background reconciliation: retry after 30s and 5m
      setTimeout(() => void this.retryVectorDelete(id, 1), 30_000);
      setTimeout(() => void this.retryVectorDelete(id, 2), 5 * 60_000);
    }

    // Delete from database first (if this fails, S3 object remains and can be retried — no orphan DB pointer)
    await this.prisma.document.delete({ where: { id } });

    // Delete the file from S3 (best-effort — deleteObject swallows its own errors)
    await this.storage.deleteObject(document.storageKey);
  }

  private async retryVectorDelete(id: string, attempt: number): Promise<void> {
    try {
      await firstValueFrom(
        this.httpService.delete(`${this.aiServiceUrl}/documents/${id}`, {
          timeout: 5000,
        }),
      );
      this.logger.log(`Background vector delete succeeded for ${id} (attempt ${attempt})`);
    } catch (err: any) {
      const status = err.response?.status;
      if (status === 404) return; // already gone
      this.logger.warn(`Background vector delete failed for ${id} attempt ${attempt}: ${err.message}`);
    }
  }

  /** Re-embed a document's file into the vector store. */
  async embed(id: string): Promise<Document> {
    const document = await this.findOne(id);

    if (document.status === DocumentStatus.PROCESSING) {
      throw new ConflictException('Document is already being processed');
    }
    if (document.status === DocumentStatus.INDEXED) {
      throw new ConflictException('Document is already embedded');
    }

    // Kick off asynchronously; the client polls status/progress.
    this.processDocument(document).catch((err) => {
      this.logger.error(`Failed to embed document ${id}: ${err.message}`);
    });

    return this.prisma.document.update({
      where: { id },
      data: { status: DocumentStatus.PROCESSING },
    });
  }

  /** Remove a document's vectors from the store but keep the file and record. */
  async unembed(id: string): Promise<Document> {
    const document = await this.findOne(id);

    if (document.status === DocumentStatus.PROCESSING) {
      throw new ConflictException(
        'Document is being processed; wait for it to finish',
      );
    }

    try {
      await firstValueFrom(
        this.httpService.delete(`${this.aiServiceUrl}/documents/${id}`),
      );
    } catch (err: any) {
      this.logger.error(
        `Failed to remove vectors for document ${id}: ${err.message}`,
      );
      throw new ConflictException(
        'Could not remove document from the vector store. Is the AI service running?',
      );
    }

    return this.prisma.document.update({
      where: { id },
      data: {
        status: DocumentStatus.UNEMBEDDED,
        chunkCount: null,
        indexedAt: null,
      },
    });
  }

  /** Live ingestion progress for many documents in a single AI-service call. */
  async getProgressBatch(
    ids: string[],
  ): Promise<Record<string, Record<string, any> | null>> {
    if (ids.length === 0) return {};

    try {
      const response = await firstValueFrom(
        this.httpService.get(`${this.aiServiceUrl}/progress`, {
          params: { ids: ids.join(',') },
          timeout: 5000,
        }),
      );
      return response.data.progress ?? {};
    } catch {
      // AI service unavailable — report nothing rather than failing the poll.
      return {};
    }
  }

  /** Proxy live ingestion progress from the AI service. */
  async getProgress(id: string): Promise<Record<string, any>> {
    const document = await this.findOne(id);

    try {
      const response = await firstValueFrom(
        this.httpService.get(`${this.aiServiceUrl}/documents/${id}/progress`, {
          timeout: 5000,
        }),
      );
      return { ...response.data, status: document.status };
    } catch {
      // No live progress available (AI restarted, or processing not started).
      return { doc_id: id, stage: null, percent: null, status: document.status };
    }
  }

  /**
   * Streams live ingestion progress to the browser by directly piping the AI
   * service's own SSE stream through, instead of the API re-polling
   * getProgress() on its own 1s timer (which was a full HTTP round-trip to
   * the AI service *inside* another poll loop, on top of the AI service's
   * own internal 1s tick — doubling latency and request volume for no
   * benefit). This is a straight pass-through, so updates reach the browser
   * as fast as the AI service emits them.
   */
  async streamProgress(id: string, res: Response): Promise<void> {
    const document = await this.findOne(id);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      res.end();
    };

    // AI service unreachable, or the stream drops mid-flight — fall back to
    // a single DB-status snapshot rather than leaving the client hanging.
    const sendFallbackAndFinish = () => {
      if (finished) return;
      res.write(
        `data: ${JSON.stringify({ doc_id: id, stage: null, percent: null, status: document.status })}\n\n`,
      );
      res.write('event: done\ndata: {}\n\n');
      finish();
    };

    let upstream;
    try {
      upstream = await this.httpService.axiosRef.get(
        `${this.aiServiceUrl}/documents/${id}/progress/stream`,
        { responseType: 'stream', timeout: 10000 },
      );
    } catch {
      sendFallbackAndFinish();
      return;
    }

    const upstreamStream = upstream.data as NodeJS.ReadableStream;
    let buffer = '';

    // Re-emit each upstream SSE event, merging in the DB-authoritative
    // status (fetched once above — cheap, and this connection's whole
    // purpose is watching one document finish, so it's not going stale
    // mid-stream in practice).
    const forwardEvent = (rawEvent: string) => {
      if (rawEvent.startsWith('event: done') || rawEvent.startsWith('event: error')) {
        res.write(`${rawEvent}\n\n`);
        return;
      }
      const dataLine = rawEvent.split('\n').find((line) => line.startsWith('data: '));
      if (!dataLine) return;
      try {
        const payload = JSON.parse(dataLine.slice('data: '.length));
        res.write(`data: ${JSON.stringify({ ...payload, status: document.status })}\n\n`);
      } catch {
        res.write(`${rawEvent}\n\n`);
      }
    };

    upstreamStream.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        forwardEvent(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
      }
    });
    upstreamStream.on('end', finish);
    upstreamStream.on('error', sendFallbackAndFinish);

    res.on('close', () => {
      upstreamStream.removeAllListeners();
      (upstreamStream as any).destroy?.();
    });
  }

  /** Short-lived signed URL the browser can download/view the file from directly. */
  async getDownloadUrl(document: Document): Promise<string> {
    if (!(await this.storage.objectExists(document.storageKey))) {
      throw new NotFoundException('File not found in storage');
    }
    return this.storage.getPresignedDownloadUrl(document.storageKey, {
      filename: document.filename,
      contentType: document.mimeType,
    });
  }

  async processDocument(document: Document): Promise<void> {
    // Mark as processing
    await this.prisma.document.update({
      where: { id: document.id },
      data: { status: DocumentStatus.PROCESSING },
    });

    try {
      const fileStream = await this.storage.getObjectStream(document.storageKey);

      const form = new FormData();
      form.append('file', fileStream, {
        filename: document.filename,
        contentType: document.mimeType,
        knownLength: document.fileSize,
      });
      form.append('document_id', document.id);
      form.append('title', document.title);

      const response = await firstValueFrom(
        this.httpService.post(`${this.aiServiceUrl}/documents`, form, {
          headers: {
            ...form.getHeaders(),
          },
          timeout: this.aiIndexTimeoutMs,
          maxBodyLength: Infinity,
          maxContentLength: Infinity,
        }),
      );

      const result = response.data;

      await this.prisma.document.update({
        where: { id: document.id },
        data: {
          status: DocumentStatus.INDEXED,
          chunkCount: result.chunk_count ?? null,
          textLength: result.text_length ?? null,
          isOcr: result.is_ocr ?? false,
          indexedAt: new Date(),
        },
      });

      this.logger.log(`Document ${document.id} processed successfully`);
    } catch (err: any) {
      // The AI service reports why it failed in the response body ("Failed to
      // embed document: …", "No text could be extracted", …). Logging only
      // axios's "Request failed with status code 500" hides all of it.
      const upstream = err.response?.data?.error;
      const status = err.response?.status;
      const isTimeout = err.code === 'ECONNABORTED' || /timeout/i.test(err.message ?? '');
      this.logger.error(
        `Document processing failed for ${document.id}` +
          `${status ? ` (AI service ${status})` : ''}: ${upstream ?? err.message}`,
      );

      await this.prisma.document.update({
        where: { id: document.id },
        data: { status: DocumentStatus.FAILED },
      });

      // A timeout means WE gave up waiting — the AI service's worker thread
      // is not cancelled and keeps running the (CPU-bound) pipeline to
      // completion in the background. Without this, a large document that
      // actually finishes indexing 30s after our timeout would be stuck
      // showing FAILED forever, while its vectors are really sitting in
      // Qdrant. Reconcile against ground truth once it's likely done.
      if (isTimeout) {
        this.scheduleReconciliation(document.id);
      }
    }
  }

  /**
   * Polls the AI service's /documents/:id/status (which checks Qdrant
   * directly, not the AI service's fragile in-memory progress dict) after a
   * client-side timeout, to catch a late-arriving success and correct a
   * stale FAILED status. Bounded: gives up after ~10 extra minutes, matching
   * the original processing budget.
   *
   * In-memory setTimeout is lost on API restart — the stale FAILED row remains
   * but is self-healing: the next /documents/:id/progress poll also checks
   * Qdrant, and an explicit re-embed resolves it. For durability across
   * restarts, a periodic cron could scan FAILED docs older than 5m.
   */
  private scheduleReconciliation(documentId: string, attempt = 0): void {
    const maxAttempts = 20;
    const intervalMs = 30_000;
    if (attempt >= maxAttempts) {
      this.logger.warn(`Reconciliation for document ${documentId} gave up after ${maxAttempts} attempts — will remain FAILED until manual re-embed`);
      return;
    }

    const timer = setTimeout(() => {
      void this.reconcileOnce(documentId, attempt);
    }, intervalMs);
    // Don't block process exit on this timer
    if (timer.unref) timer.unref();
  }

  private async reconcileOnce(documentId: string, attempt: number): Promise<void> {
    try {
      const current = await this.prisma.document.findUnique({ where: { id: documentId } });
      // Someone already resolved this (retry, manual re-embed, etc.) — stop.
      if (!current || current.status !== DocumentStatus.FAILED) return;

      const response = await firstValueFrom(
        this.httpService.get(`${this.aiServiceUrl}/documents/${documentId}/status`, { timeout: 5000 }),
      );
      const { indexed, chunk_count: chunkCount } = response.data ?? {};

      if (indexed && chunkCount > 0) {
        await this.prisma.document.update({
          where: { id: documentId },
          data: { status: DocumentStatus.INDEXED, chunkCount, indexedAt: new Date() },
        });
        this.logger.log(`Reconciled document ${documentId}: late success, ${chunkCount} chunks`);
        return;
      }
    } catch {
      // AI service unreachable this attempt — retry below rather than give up.
    }

    this.scheduleReconciliation(documentId, attempt + 1);
  }
}
