import {
  BadGatewayException,
  Controller,
  Get,
  Logger,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Query,
  Res,
} from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import type { Response } from 'express';
import * as dns from 'dns/promises';
import * as net from 'net';
import { PrismaService } from '../prisma/prisma.service';
import { S3StorageService } from '../common/storage/s3-storage.service';

const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

/**
 * Serves scraped notices' PDF/image attachments. These are never persisted
 * up front during scraping (see ScrapingService) — the first request for a
 * given attachment fetches it from the original government-site URL, caches
 * it in S3, and stamps `storageKey`/`downloadedAt` on the Attachment row.
 * Every request after that (including this same one, on retry) redirects
 * straight to a presigned S3 URL without touching the source site again.
 * This also means a notice's attachment keeps working even if the original
 * URL later goes offline.
 */
@Controller('attachments')
export class AttachmentsController {
  private readonly logger = new Logger(AttachmentsController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: S3StorageService,
    private readonly httpService: HttpService,
  ) {}

  @Get(':id/file')
  async getFile(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('mode') mode: string | undefined,
    @Res() res: Response,
  ) {
    const attachment = await this.prisma.attachment.findUnique({ where: { id } });
    if (!attachment) {
      throw new NotFoundException('Attachment not found');
    }
    const disposition = mode === 'download' ? 'attachment' : 'inline';

    if (attachment.storageKey && attachment.downloadedAt) {
      // The DB row can outlive the object (bucket lifecycle rule, manual
      // deletion) — verify before redirecting, otherwise the browser lands on
      // a raw S3 "NoSuchKey" XML page instead of the file. When that happens,
      // fall through and re-fetch from the original source below.
      const exists = await this.storage.objectExists(attachment.storageKey);
      if (exists) {
        const url = await this.storage.getPresignedDownloadUrl(attachment.storageKey, {
          filename: attachment.label ?? undefined,
          contentType: attachment.mimeType ?? undefined,
          disposition,
        });
        res.redirect(302, url);
        return;
      }
      this.logger.warn(
        `Attachment ${id} has storageKey ${attachment.storageKey} but the S3 object is missing; re-fetching from source`,
      );
    }

    await this.assertSafeUrl(attachment.url);

    let buffer: Buffer;
    let contentType: string;
    try {
      const response = await firstValueFrom(
        this.httpService.get<ArrayBuffer>(attachment.url, {
          responseType: 'arraybuffer',
          timeout: 30000,
          maxContentLength: MAX_ATTACHMENT_BYTES,
          maxRedirects: 3,
        }),
      );
      buffer = Buffer.from(response.data);
      contentType =
        (response.headers['content-type'] as string | undefined) ??
        attachment.mimeType ??
        'application/octet-stream';
    } catch (err: any) {
      this.logger.warn(
        `Failed to fetch attachment ${id} from ${attachment.url}: ${err.message}`,
      );
      throw new BadGatewayException('Could not fetch this attachment right now');
    }

    const storageKey = this.storage.buildAttachmentKey(attachment.id, attachment.url);
    await this.storage.uploadBuffer(storageKey, buffer, contentType);

    await this.prisma.attachment.update({
      where: { id: attachment.id },
      data: {
        storageKey,
        downloadedAt: new Date(),
        sizeBytes: buffer.length,
        mimeType: contentType,
      },
    });

    const signedUrl = await this.storage.getPresignedDownloadUrl(storageKey, {
      filename: attachment.label ?? undefined,
      contentType,
      disposition,
    });
    res.redirect(302, signedUrl);
  }

  /**
   * Attachment URLs come from scraped external sites, so before this server
   * fetches one on a caller's behalf, block anything that isn't a plain
   * http(s) URL resolving to a public address. Without this, a malicious or
   * compromised source site could use this endpoint as an SSRF proxy to
   * probe internal services (cloud metadata endpoint, sibling containers)
   * reachable from the API server but not from the internet.
   */
  private async assertSafeUrl(rawUrl: string): Promise<void> {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new BadGatewayException('Attachment has an invalid URL');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new BadGatewayException('Attachment URL scheme is not allowed');
    }

    let addresses: string[];
    try {
      const resolved = await dns.lookup(parsed.hostname, { all: true });
      addresses = resolved.map((r) => r.address);
    } catch {
      throw new BadGatewayException('Could not resolve attachment host');
    }

    if (addresses.some((address) => this.isPrivateAddress(address))) {
      throw new BadGatewayException('Attachment host is not allowed');
    }
  }

  private isPrivateAddress(address: string): boolean {
    if (net.isIPv4(address)) {
      const [a, b, c] = address.split('.').map(Number);
      return (
        a === 0 ||
        a === 10 ||
        a === 127 ||
        (a === 100 && b >= 64 && b <= 127) ||
        (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) ||
        (a === 192 && b === 0 && c === 2) ||
        (a === 192 && b === 0) ||
        (a === 198 && b === 51 && c === 100) ||
        (a === 203 && b === 0 && c === 113) ||
        (a === 198 && (b === 18 || b === 19)) ||
        a >= 224
      );
    }
    if (net.isIPv6(address)) {
      const ip = address.toLowerCase();
      if (ip === '::1' || ip === '::') return true;
      const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
      if (mapped) return this.isPrivateAddress(mapped[1]);
      return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(ip);
    }
    return true;
  }
}
