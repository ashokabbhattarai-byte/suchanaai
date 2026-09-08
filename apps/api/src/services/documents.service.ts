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
  // ── AI concurrency guard (no env) ───────────────────────────────────
  // The AI service is single-worker and bounded to 2 concurrent ingests.
  // If the API blasts 10 POST /documents at once, the AI will queue 8 and
  // eventually return 503 for overflow — this limiter smooths the burst on
  // the API side so requests are paced, retried with backoff, and never
  // thunder-herd the AI. Fixed 3 matches the AI's 2 + 1 headroom for
  // query/health probes, without any env tuning.
  private readonly AI_CONCURRENCY = 3;
  private aiActive = 0;
  private aiQueue: Array<() => void> = [];

  // ── Progress cache: survives AI blips restarts ─────────────────────────
  // The AI service holds progress in a process-local dict, so a restart or a
  // transient DNS blip (ERR_NETWORK_CHANGED) makes /progress return {} / nulls.
  // Previously the UI preserved the last known percent client-side, but a *new*
  // document that hadn't yet had a successful poll would stay stuck at
  // "Queued 0%" until the blip cleared. Caching the last successful entry
  // server-side and synthesising a minimal "Processing..." entry from the
  // authoritative DB status (PROCESSING/PENDING) guarantees the card always has
  // something to render, even before the first poll succeeds.
  private readonly progressCache = new Map<string, { entry: Record<string, any>; ts: number }>();
  private readonly PROGRESS_CACHE_TTL_MS = 2 * 60 * 1000;

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

  private async withAiSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.aiActive >= this.AI_CONCURRENCY) {
      await new Promise<void>((resolve) => this.aiQueue.push(resolve));
    }
    this.aiActive++;
    try {
      return await fn();
    } finally {
      this.aiActive--;
      const next = this.aiQueue.shift();
      if (next) next();
    }
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

    // Create as PROCESSING immediately so the first GET /documents poll
    // already shows the doc in the processingKey set and the UI can
    // display an instant synthetic progress, rather than a brief PENDING
    // window where the card flickers "Queued 0%" until processDocument's
    // first line updates the row.
    const document = await this.prisma.document.create({
      data: { ...rest, storageKey, status: DocumentStatus.PROCESSING },
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

  /** Live ingestion progress for many documents in a single AI-service call.
   *  Retries a couple of times with back-off so a fleeting DNS / interface
   *  blip (the ERR_NAME_NOT_RESOLVED / ERR_NETWORK_CHANGED burst in the
   *  screenshot) does not turn a whole poll tick into an empty `{}` and
   *  freeze every card at its last percent. On AI failure or for docs whose
   *  in-memory entry was lost (AI restart), falls back to a server-side
   *  cache and finally to a synthetic DB-driven "Processing..." entry so
   *  the UI never flickers to "Queued 0%".
   */
  async getProgressBatch(
    ids: string[],
  ): Promise<Record<string, Record<string, any> | null>> {
    if (ids.length === 0) return {};

    let aiProgress: Record<string, Record<string, any> | null> = {};
    let aiSucceeded = false;

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await firstValueFrom(
          this.httpService.get(`${this.aiServiceUrl}/progress`, {
            params: { ids: ids.join(',') },
            timeout: 5000,
          }),
        );
        aiProgress = response.data.progress ?? {};
        aiSucceeded = true;
        // Cache successful live entries so a later blip can replay them
        for (const [k, v] of Object.entries(aiProgress)) {
          if (v) this.progressCache.set(k, { entry: v as Record<string, any>, ts: Date.now() });
        }
        break;
      } catch (err: any) {
        const status = err.response?.status;
        const retryable = !status || status === 429 || (status >= 500 && status <= 504);
        const transientCode = err.code
        const msg = String(err.message ?? '')
        const isNetwork =
          !status &&
          (!!transientCode ||
            /network|econn|enotfound|eai_again|err_name_not_resolved|err_network_changed|timeout|socket hang up/i.test(
              msg + ' ' + String(transientCode ?? ''),
            ));
        if ((retryable || isNetwork) && attempt < 2) {
          const delay = 300 * Math.pow(2, attempt) + Math.random() * 200;
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        // AI service unavailable this tick — fall through to cache / synthetic.
        break;
      }
    }

    // Prune stale cache entries occasionally
    if (this.progressCache.size > 100) {
      const now = Date.now();
      for (const [k, v] of this.progressCache) {
        if (now - v.ts > this.PROGRESS_CACHE_TTL_MS) this.progressCache.delete(k);
      }
    }

    // For any id without a live entry, try cache then synthetic DB fallback.
    // Fetch DB statuses in one query rather than per-id.
    const missingIds = ids.filter((id) => !aiProgress[id]);
    const dbMap = new Map<string, Document>();
    if (missingIds.length > 0) {
      const dbDocs = await this.prisma.document.findMany({
        where: { id: { in: missingIds } },
        select: {
          id: true,
          status: true,
          title: true,
          filename: true,
          chunkCount: true,
          createdAt: true,
        } as any,
      });
      // findMany with select still returns Document-ish objects
      for (const d of dbDocs as unknown as Document[]) {
        dbMap.set(d.id, d);
      }
    }

    const result: Record<string, Record<string, any> | null> = { ...aiProgress };
    for (const id of ids) {
      if (result[id]) continue;
      const cached = this.progressCache.get(id);
      if (cached && Date.now() - cached.ts < this.PROGRESS_CACHE_TTL_MS) {
        result[id] = cached.entry;
        continue;
      }
      const doc = dbMap.get(id);
      if (doc && (doc.status === DocumentStatus.PROCESSING || doc.status === DocumentStatus.PENDING)) {
        // Synthetic: guarantees the card shows "Processing 5-10%" instantly,
        // even before the AI's first progress.update or after a restart.
        result[id] = {
          doc_id: id,
          filename: (doc as any).filename ?? (doc as any).title ?? 'document',
          stage: 'extracting',
          percent: 5,
          total_chunks: (doc as any).chunkCount ?? 0,
          processed_chunks: 0,
          message: 'Starting...',
          error: null,
          status: doc.status,
          updated_at: new Date().toISOString(),
          _synthetic: true,
        };
      } else {
        result[id] = (aiProgress as any)[id] ?? null;
      }
    }
    return result;
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

  async processDocument(document: Document, attempt = 0): Promise<void> {
    const MAX_ATTEMPTS = 5
    // Mark as processing (idempotent — re-embeds land here too)
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

      // Pace outbound AI calls so 10 concurrent uploads don't hit the AI's
      // 503 queue-full at once. The queue is FIFO and cheap — waiting here
      // holds a Node event-loop timer, not a Python worker thread.
      const response = await this.withAiSlot(() =>
        firstValueFrom(
          this.httpService.post(`${this.aiServiceUrl}/documents`, form, {
            headers: {
              ...form.getHeaders(),
            },
            timeout: this.aiIndexTimeoutMs,
            maxBodyLength: Infinity,
            maxContentLength: Infinity,
          }),
        ),
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
      const status: number | undefined = err.response?.status;
      const code: string | undefined = err.code
      const msg: string = err.message ?? ''
      const isTimeout = code === 'ECONNABORTED' || /timeout/i.test(msg)
      const isRateLimited = status === 429
      const isNetworkError =
        !status &&
        (!!code ||
          /network|econn|enotfound|eai_again|err_name_not_resolved|err_network_changed|failed to fetch|socket hang up|ehostunreach|etimedout/i.test(
            msg + ' ' + (code ?? ''),
          ))
      const isTransientStatus =
        status === 408 || status === 429 || status === 502 || status === 503 || status === 504 || status === 500
      const isPermanentClientError = status === 400 || status === 413 || status === 422

      // Permanent content errors (empty extraction, bad MIME, too large after
      // re-check) must not be retried — they'd just fail identically and
      // spam the AI. Everything else is conservatively treated as transient
      // and retried with exponential back-off, keeping the row PROCESSING so
      // the frontend's batch?ids=... poll continues to show live progress
      // instead of flashing FAILED in the middle of a network blip.
      if (isPermanentClientError) {
        this.logger.error(
          `Document processing failed permanently for ${document.id}` +
            `${status ? ` (AI service ${status})` : ''}: ${upstream ?? msg}`,
        );
        await this.prisma.document.update({
          where: { id: document.id },
          data: { status: DocumentStatus.FAILED },
        });
        return
      }

      if (isRateLimited || isNetworkError || isTransientStatus || isTimeout) {
        if (attempt < MAX_ATTEMPTS) {
          // 429 (quota/throttler) waits longest; pure network/DNS blips
          // (ERR_NAME_NOT_RESOLVED / ERR_NETWORK_CHANGED in the screenshot)
          // recover fastest. Scale accordingly but always exponential.
          // Honour Retry-After from AI's 503 queue-full (5s) to avoid
          // hammering while the AI drains its 2-slot pipeline.
          let base =
            isRateLimited ? 60_000 : isNetworkError ? 3_000 : isTimeout ? 8_000 : 6_000
          const retryAfterHeader =
            err.response?.headers?.['retry-after'] ?? err.response?.headers?.['Retry-After']
          if (status === 503 && retryAfterHeader) {
            const secs = parseInt(String(retryAfterHeader), 10)
            if (!isNaN(secs) && secs > 0 && secs < 30) base = Math.min(base, secs * 1000)
          }
          const jitter = Math.random() * 0.4 + 0.8 // 0.8x..1.2x
          const delay = Math.min(base * Math.pow(1.8, attempt) * jitter, 120_000)
          this.logger.warn(
            `Transient ${isRateLimited ? '429' : isNetworkError ? `network(${code ?? 'no-code'})` : `AI ${status ?? 'timeout'}`} for document ${document.id} (attempt ${attempt + 1}/${MAX_ATTEMPTS}): ${upstream ?? msg} — retry in ${Math.round(delay / 1000)}s; leaving as PROCESSING`,
          );
          const t = setTimeout(
            () =>
              void this.processDocument(document, attempt + 1).catch((e) => {
                this.logger.error(`Retry attempt ${attempt + 1} failed for ${document.id}: ${e.message}`);
              }),
            delay,
          );
          if (t.unref) t.unref();
          return
        }
        // Exhausted retries — fall through to mark FAILED but, for timeouts,
        // still schedule reconciliation because the AI worker may yet finish.
      }

      this.logger.error(
        `Document processing failed for ${document.id}` +
          `${status ? ` (AI service ${status})` : ''}: ${upstream ?? msg} (attempt ${attempt + 1}/${MAX_ATTEMPTS})`,
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
      // Note: aiIndexTimeoutMs=600s and AI's /documents timeout=570s + nginx
      // proxy_read_timeout=600s are aligned so a legit 5.4 MB poster PDF
      // (OCR + embedding) succeeds well before either fires; this is only for
      // slow-path large docs that actually do exceed the budget.
      if (isTimeout) {
        this.scheduleReconciliation(document.id);
      } else if (isNetworkError || isTransientStatus) {
        // Even a non-timeout transient that exhausted retries may have
        // actually indexed (e.g. we timed out reading the 201 but the write
        // committed). Give reconciliation one chance.
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
