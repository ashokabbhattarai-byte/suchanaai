import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Readable } from 'stream';

export interface PresignedUrlOptions {
  /** Sets Content-Disposition so the browser downloads/displays with this filename. */
  filename?: string;
  /** "attachment" forces Save As; "inline" lets the browser render it (img/iframe preview). Defaults to "attachment". */
  disposition?: 'inline' | 'attachment';
  contentType?: string;
  expiresInSeconds?: number;
}

/**
 * Thin wrapper around the S3 SDK for this app's two file categories:
 * user-uploaded RAG documents ("documents/…") and cached copies of scraped
 * notice attachments ("attachments/…"). The bucket is private — nothing is
 * ever served via a public object URL, only short-lived presigned URLs
 * generated on demand (see getPresignedDownloadUrl).
 *
 * Credentials: uses the AWS SDK's default provider chain. On hosts with no
 * IAM role attached (e.g. the Oracle box), set AWS_ACCESS_KEY_ID /
 * AWS_SECRET_ACCESS_KEY explicitly; on AWS compute with an instance role
 * (Elastic Beanstalk/EC2/ECS), leave them unset and the role is used
 * automatically.
 */
@Injectable()
export class S3StorageService {
  private readonly logger = new Logger(S3StorageService.name);
  private readonly client: S3Client;
  private readonly bucket: string;
  private static readonly DEFAULT_PRESIGN_TTL_SECONDS = 300;

  constructor(private readonly config: ConfigService) {
    this.bucket = this.config.getOrThrow<string>('S3_BUCKET_NAME');
    const accessKeyId = this.config.get<string>('AWS_ACCESS_KEY_ID');
    const secretAccessKey = this.config.get<string>('AWS_SECRET_ACCESS_KEY');

    this.client = new S3Client({
      region: this.config.get<string>('AWS_REGION') || 'us-east-1',
      ...(accessKeyId && secretAccessKey
        ? { credentials: { accessKeyId, secretAccessKey } }
        : {}),
    });
  }

  /**
   * Upload a fully-buffered file (used for the RAG document upload path).
   * Uses @aws-sdk/lib-storage Upload which automatically switches to
   * multipart for payloads >5 MB. This chunks a 100 MB buffer into
   * ~5-10 MB parts so the 350 MB EB container never holds the whole
   * payload in a single PutObject plus lib-storage never duplicates it.
   * Small files still go as a single PutObject under the hood.
   */
  async uploadBuffer(
    key: string,
    body: Buffer,
    contentType: string,
  ): Promise<void> {
    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      },
    });
    await upload.done();
  }

  /**
   * Streaming upload for Readable sources (e.g. diskStorage temp file
   * or proxied fetch). Also multipart-aware via lib-storage — parts are
   * uploaded as the stream is consumed, so peak RSS stays near one
   * partSize instead of the whole file. Pass contentLength when known
   * (lets lib-storage pre-calculate part count); otherwise it falls
   * back to chunked streaming.
   */
  async uploadStream(
    key: string,
    stream: Readable,
    contentType: string,
    contentLength?: number,
  ): Promise<void> {
    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: this.bucket,
        Key: key,
        Body: stream,
        ContentType: contentType,
        ...(contentLength ? { ContentLength: contentLength } : {}),
      },
    });
    await upload.done();
  }

  /** Fetch an object back as a readable stream (used to forward a document to the AI service). */
  async getObjectStream(key: string): Promise<Readable> {
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    return result.Body as Readable;
  }

  /** Best-effort delete — logs and swallows failures so a missing object never blocks a DB delete. */
  async deleteObject(key: string): Promise<void> {
    try {
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
      );
    } catch (err: any) {
      this.logger.warn(`Failed to delete S3 object "${key}": ${err.message}`);
    }
  }

  async objectExists(key: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Short-lived, signed GET URL. This is the only way a browser ever reaches
   * an object — the bucket itself blocks all public access.
   */
  async getPresignedDownloadUrl(
    key: string,
    opts: PresignedUrlOptions = {},
  ): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ResponseContentDisposition: this.buildContentDisposition(opts),
      ResponseContentType: opts.contentType,
    });
    return getSignedUrl(this.client, command, {
      expiresIn: opts.expiresInSeconds ?? S3StorageService.DEFAULT_PRESIGN_TTL_SECONDS,
    });
  }

  /**
   * HTTP header values must be Latin-1 — many scraped notice titles are
   * Devanagari, so a naive `filename="..."` would put non-ASCII bytes
   * straight into the header and get rejected by S3 (or mangled by the
   * browser) at download time. RFC 6266 fixes this: keep a stripped ASCII
   * `filename` for old clients, and carry the real name UTF-8/percent-encoded
   * in `filename*`, which every modern browser prefers over the fallback.
   */
  private buildContentDisposition(opts: PresignedUrlOptions): string | undefined {
    const type = opts.disposition ?? 'attachment';
    if (!opts.filename) return type;

    const asciiFallback =
      opts.filename
        .replace(/[^\x20-\x7e]/g, '')
        .replace(/"/g, '')
        .trim() || 'file';
    const encoded = encodeURIComponent(opts.filename);
    return `${type}; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
  }

  /** Key for a user-uploaded / system-seeded RAG document. */
  buildDocumentKey(id: string, originalFilename: string): string {
    return `documents/${id}${this.extOf(originalFilename)}`;
  }

  /** Key for a cached copy of a scraped notice's attachment. */
  buildAttachmentKey(id: string, sourceUrl: string): string {
    return `attachments/${id}${this.extFromUrl(sourceUrl)}`;
  }

  private extOf(filename: string): string {
    const idx = filename.lastIndexOf('.');
    return idx !== -1 ? filename.slice(idx).slice(0, 10) : '';
  }

  private extFromUrl(url: string): string {
    try {
      return this.extOf(new URL(url).pathname);
    } catch {
      return '';
    }
  }
}
