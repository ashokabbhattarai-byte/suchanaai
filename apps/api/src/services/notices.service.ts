import {
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { ScrapedItemCategory, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TtlCache } from '../common/cache/ttl-cache';
import { SingleFlight, SingleFlightCooldownError } from '../common/cache/single-flight';
import { SettingsService } from './settings.service';
import { withTraceAsync } from '../common/logger';
import * as crypto from 'crypto';

export interface BulkReextractProgress {
  jobId: string;
  scope: string;
  status: 'running' | 'done' | 'failed';
  total: number;
  processed: number;
  improved: number;
  failed: number;
  scanned: number;
  clean: number;
  messy: number;
  broken: number;
  withAttachment: number;
  queued: number;
  message: string;
  createdAt: string;
  updatedAt: string;
  error?: string;
}

export interface PublicNoticeFilters {
  category?: string;
  sourceId?: string;
  search?: string;
  tag?: string;
  dateFrom?: string;
  dateTo?: string;
  urgency?: string;
  sortBy?: "publishedAt" | "views";
  sortOrder?: "asc" | "desc";
  page?: number;
  limit?: number;
}

// Public read layer over the scraping pipeline's data — no auth, no admin
// fields (schemas, run history, etc.). Kept separate from ScrapingService,
// which owns admin CRUD/trigger/detection concerns.
@Injectable()
export class NoticesService {
  private readonly logger = new Logger(NoticesService.name);
  private readonly aiServiceUrl: string;

  // Hot public read paths are cheap to recompute and change slowly, so serve
  // them from a single-flight TTL cache instead of hitting Postgres on every
  // page load.
  private readonly listCache = new TtlCache<unknown>(
    Number(process.env.NOTICES_LIST_CACHE_MS ?? 10_000),
  );
  private readonly metaCache = new TtlCache<unknown>(
    Number(process.env.NOTICES_META_CACHE_MS ?? 60_000),
  );

  // Debounce view increments to avoid Postgres flood
  private static readonly viewThrottle = new Map<string, number>();

  // Single-flight guard around view-triggered AI enrichment (PDF OCR, LLM
  // summarization). Without it, N users opening the same unanalyzed notice
  // fire N identical AI calls in the same window. Failure backoff (default
  // 60s) additionally stops a flaky AI service from being retried by every
  // viewer at once.
  private readonly aiSingleFlight = new SingleFlight(
    Number(process.env.AI_RETRY_COOLDOWN_MS ?? 60_000),
  );

  // Cheap answer memo for the notice Q&A + global chatbot: identical
  // questions (same notice, same prompt) share the LLM call, so a popular
  // question asked by many users isn't re-generated each time.
  private readonly qaCache = new TtlCache<unknown>(Number(process.env.QA_CACHE_MS ?? 5 * 60_000));

  // Bulk re-extract progress — in-memory like scrape_progress on the AI side.
  // Fire-and-forget void made bulk invisible until it finished; this lets the
  // admin poll live progress. TTL 30m, max 50 entries, process-local.
  private readonly bulkProgress = new Map<string, BulkReextractProgress>();
  private static readonly BULK_TTL_MS = 30 * 60 * 1000;
  private static readonly BULK_MAX_ENTRIES = 50;

  constructor(
    private readonly prisma: PrismaService,
    private readonly httpService: HttpService,
    private readonly config: ConfigService,
    private readonly settings: SettingsService,
  ) {
    this.aiServiceUrl = this.config.get<string>('AI_SERVICE_URL') || 'http://localhost:8000';
  }

  // ── Bulk progress helpers ───────────────────────────────────────────
  private evictBulkProgress() {
    const now = Date.now();
    for (const [k, v] of this.bulkProgress.entries()) {
      if (now - new Date(v.updatedAt).getTime() > NoticesService.BULK_TTL_MS) {
        this.bulkProgress.delete(k);
      }
    }
    if (this.bulkProgress.size > NoticesService.BULK_MAX_ENTRIES) {
      const sorted = [...this.bulkProgress.entries()].sort(
        (a, b) => new Date(a[1].updatedAt).getTime() - new Date(b[1].updatedAt).getTime(),
      );
      for (let i = 0; i < sorted.length - NoticesService.BULK_MAX_ENTRIES; i++) {
        this.bulkProgress.delete(sorted[i][0]);
      }
    }
  }

  getBulkProgress(jobId: string): BulkReextractProgress | null {
    return this.bulkProgress.get(jobId) ?? null;
  }

  getBulkProgressList(): BulkReextractProgress[] {
    return [...this.bulkProgress.values()].sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
  }

  getLatestBulkProgress(): BulkReextractProgress | null {
    const list = this.getBulkProgressList();
    return list[0] ?? null;
  }

  private async probeAiHealth(): Promise<{
    ready: boolean;
    phase: string;
    warming: boolean;
    queueFull: boolean;
    queueWaiting: number;
    queueLimit: number;
  }> {
    const res = await firstValueFrom(
      this.httpService.get(`${this.aiServiceUrl}/health`, { timeout: 5000 }),
    );
    const data = res.data ?? {};
    const phase: string = data.phase ?? data.status ?? 'unknown';
    const warming: boolean = data.warming ?? (phase !== 'ok' && phase !== 'ready');
    const ingest = data.ingest ?? {};
    const waiting = typeof ingest.waiting === 'number' ? ingest.waiting : 0;
    const limit = typeof ingest.limit === 'number' ? ingest.limit : 30;
    const queueFull: boolean = Boolean(ingest.queue_full ?? ingest.queueFull ?? waiting >= limit);
    const ready = !warming && !queueFull && (phase === 'ok' || phase === 'ready');
    return { ready, phase, warming, queueFull, queueWaiting: waiting, queueLimit: limit };
  }

  async findAll(filters: PublicNoticeFilters) {
    const page = filters.page ?? 1;
    const defaultLimit = await this.settings.getNumber('notices.perPage', 20);
    const limit = Math.min(filters.limit ?? defaultLimit, 100);
    const sortBy = filters.sortBy ?? 'publishedAt';
    const sortOrder = filters.sortOrder ?? 'desc';

    // Stable cache key: sort keys and include explicit undefined handling to avoid collisions
    const stableKey = JSON.stringify({ ...filters, page, limit, sortBy, sortOrder }, (k, v) => (v === undefined ? '__undef__' : v), 2);
    const cacheKey = `list:${stableKey}`;
    return this.listCache.remember(cacheKey, async () => {
      const publishedAtFilter: Prisma.DateTimeFilter = {};
      if (filters.dateFrom) publishedAtFilter.gte = new Date(filters.dateFrom);
      if (filters.dateTo) publishedAtFilter.lte = new Date(filters.dateTo);

      const where: Prisma.ScrapedItemWhereInput = {
        ...(filters.category ? { category: filters.category as ScrapedItemCategory } : {}),
        ...(filters.sourceId ? { sourceId: filters.sourceId } : {}),
        ...(filters.urgency ? { aiUrgency: filters.urgency } : {}),
        ...(Object.keys(publishedAtFilter).length ? { publishedAt: publishedAtFilter } : {}),
        ...(filters.search
          ? {
              OR: [
                { title: { contains: filters.search, mode: 'insensitive' } },
                { summary: { contains: filters.search, mode: 'insensitive' } },
                { contentText: { contains: filters.search, mode: 'insensitive' } },
              ],
            }
          : {}),
        ...(filters.tag
          ? {
              tags: {
                array_contains: filters.tag,
              },
            }
          : {}),
      };
      const skip = (page - 1) * limit;

      const [data, total] = await Promise.all([
        this.prisma.scrapedItem.findMany({
          where,
          orderBy: { [sortBy]: sortOrder },
          skip,
          take: limit,
          select: {
            id: true,
            sourceId: true,
            sourceLabel: true,
            category: true,
            title: true,
            sourceUrl: true,
            summary: true,
            attachmentUrl: true,
            publishedAt: true,
            scrapedAt: true,
            views: true,
            aiSummary: true,
            aiSummaryNe: true,
            aiUrgency: true,
          },
        }),
        this.prisma.scrapedItem.count({ where }),
      ]);

      return { data, meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
    });
  }

  async findOne(id: string) {
    const notice = await this.prisma.scrapedItem.findUnique({
      where: { id },
      include: { attachments: true },
    });
    if (!notice) throw new NotFoundException(`Notice ${id} not found`);

    // Throttle view increments: at most once per 30s per notice to prevent
    // burst traffic (popular notice shared on social) from flooding Postgres
    // with concurrent increment queries. Best-effort in-memory debounce.
    const now = Date.now()
    const last = (NoticesService.viewThrottle.get(id) ?? 0)
    if (now - last > 30000) {
      NoticesService.viewThrottle.set(id, now)
      this.prisma.scrapedItem
        .update({ where: { id }, data: { views: { increment: 1 } } })
        .catch(() => undefined);
      // Prune throttle map to prevent unbounded growth
      if (NoticesService.viewThrottle.size > 5000) {
        for (const [k, t] of NoticesService.viewThrottle.entries()) {
          if (now - t > 60000) NoticesService.viewThrottle.delete(k)
          if (NoticesService.viewThrottle.size <= 4000) break
        }
      }
    }

    // PDF-only notice: contentText comes from OCR, so trigger extraction in
    // the background (legacy notices scraped before extraction was added to
    // the pipeline). The page loads immediately; the frontend polls for
    // updated data. Single-flight ensures N concurrent viewers trigger ONE
    // extraction, and `pdfExtractAt` stamps a completion sentinel so a
    // successful notice isn't re-extracted on every subsequent view either.
    if (!notice.contentText && !notice.aiAnalyzedAt) {
      const attachmentUrl = this.findExtractableAttachmentUrl(notice);
      if (attachmentUrl) {
        this.extractPdfAndCache(notice.id, notice.title, attachmentUrl)
          .catch((err: any) => {
            if (err instanceof SingleFlightCooldownError) return; // retry later
            this.logger.warn(`Attachment extraction failed for notice ${notice.id}: ${err.message}`);
          });
      }
    }

    const needsAnalysis =
      notice.contentText &&
      (!notice.aiAnalyzedAt || notice.aiAnalyzedAt < notice.updatedAt);

    // Run the AI enrichment in the background (it can take up to 30s) and
    // return the cached row immediately — the frontend polls for updated data,
    // exactly like the PDF-extraction path below. Keeps first-paint fast.
    if (needsAnalysis) {
      void withTraceAsync(() =>
        this.analyzeAndCache(notice.id, notice.title, notice.contentText!)
          .then((analyzed) => {
            if (analyzed) this.logger.debug(`Notice ${notice.id} analyzed and cached`);
          })
          .catch((err: any) => {
            if (err instanceof SingleFlightCooldownError) return; // another run in cooldown
            this.logger.warn(`Notice analysis failed for ${notice.id}: ${err.message}`);
          }),
      );
    }

    return notice;
  }

  /**
   * Attachment list for the Q&A context, including the legacy single
   * `attachmentUrl` column when it isn't already represented in the
   * attachments table.
   */
  private attachmentContext(notice: {
    attachmentUrl: string | null;
    attachments: { url: string; label: string | null; mimeType: string | null; sizeBytes: number | null }[];
  }): { name: string; url: string; mime_type: string | null; size_bytes: number | null }[] {
    const nameOf = (url: string, label: string | null) =>
      label?.trim() || decodeURIComponent(url.split('/').pop()?.split('?')[0] ?? url);

    const list = notice.attachments.map((a) => ({
      name: nameOf(a.url, a.label),
      url: a.url,
      mime_type: a.mimeType,
      size_bytes: a.sizeBytes,
    }));

    if (notice.attachmentUrl && !list.some((a) => a.url === notice.attachmentUrl)) {
      list.push({
        name: nameOf(notice.attachmentUrl, null),
        url: notice.attachmentUrl,
        mime_type: null,
        size_bytes: null,
      });
    }
    return list;
  }

  // Scanned notices are just as often a photographed/screenshotted image
  // (JPG, PNG) as a PDF — both are OCR-able via the same AI service route,
  // so both count as "extractable" here.
  private static readonly IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tif', '.tiff'];

  private isExtractableUrl(url: string | null | undefined, mimeType?: string | null): boolean {
    if (!url) return false;
    const lower = url.toLowerCase().split('?')[0].split('#')[0];
    if (mimeType?.includes('pdf') || lower.endsWith('.pdf')) return true;
    if (mimeType?.startsWith('image/')) return true;
    return NoticesService.IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext));
  }

  private findExtractableAttachmentUrl(notice: { attachmentUrl: string | null; attachments: { url: string; mimeType: string | null }[] }): string | null {
    // Check attachments table first
    const match = notice.attachments?.find((a) => this.isExtractableUrl(a.url, a.mimeType));
    if (match) return match.url;
    // Fall back to legacy attachmentUrl
    if (this.isExtractableUrl(notice.attachmentUrl)) return notice.attachmentUrl;
    if (notice.attachmentUrl?.includes('pdf')) return notice.attachmentUrl;
    return null;
  }

  private async extractPdfAndCache(id: string, title: string, pdfUrl: string) {
    // Single-flight per notice: N concurrent viewers share one in-flight OCR
    // run, and a failure rejection triggers the single-flight backoff so the
    // AI service isn't pounded by every viewer retrying at once. Note: errors
    // are logged then re-thrown so the backoff kicks in (callers `.catch()`).
    return this.aiSingleFlight.run(`pdf:${id}`, async () => {
      let response;
      try {
        response = await firstValueFrom(
          this.httpService.post(
            `${this.aiServiceUrl}/notices/extract-pdf`,
            { url: pdfUrl, title },
            { timeout: 90000 },
          ),
        );
      } catch (err: any) {
        // axios reduces an upstream 4xx to "Request failed with status code
        // 400", which says nothing. The AI service puts the actual reason
        // (bad URL, not a PDF, download blocked) in the response body.
        const upstream = err.response?.data?.error;
        if (upstream) err.message = upstream;
        this.logger.warn(`PDF extraction failed for notice ${id}: ${err.message}`);
        throw err;
      }
      const meta = {
        chars: String(response.data?.content_text ?? '').length,
        quality: typeof response.data?.quality === 'number' ? response.data.quality : null,
        method: response.data?.method ?? null,
        isOcr: Boolean(response.data?.is_ocr),
      };

      if (!response.data?.content_text) {
        // Stamp the sentinel anyway so a PDF with genuinely no extractable
        // text (e.g. image-only scan with no OCR output) isn't re-extracted
        // on every single view. Real failures (timeout/5xx) reject above and
        // go through the single-flight backoff instead.
        await this.prisma.scrapedItem.update({
          where: { id },
          data: { aiAnalyzedAt: new Date() },
        });
        return meta;
      }

      // Legacy Nepali fonts (Preeti and friends) decode to confident-looking
      // symbol noise — `S Ñ ! ."$% &'( )*(` — which is worse than no text:
      // it renders as garbage on the notice page, pollutes the RAG index, and
      // gets echoed back as chatbot "answers". The AI summary is still kept
      // (the LLM reads the rendered pages, so it stays usable); only the body
      // text is withheld.
      const usableText =
        meta.quality === null || meta.quality >= NoticesService.EXTRACTION_QUALITY_FLOOR;
      if (!usableText) {
        this.logger.warn(
          `Discarding unreadable extracted text for notice ${id} ` +
            `(quality ${meta.quality} < ${NoticesService.EXTRACTION_QUALITY_FLOOR}, method=${meta.method ?? 'unknown'})`,
        );
      }

      const data: any = {
        ...(usableText ? { contentText: response.data.content_text } : {}),
        aiAnalyzedAt: new Date(),
      };
      if (response.data.analyzed) {
        if (response.data.summary) data.aiSummary = response.data.summary;
        if (response.data.summary_ne) data.aiSummaryNe = response.data.summary_ne;
        if (response.data.key_facts) data.keyFacts = response.data.key_facts;
        if (response.data.tags) data.tags = response.data.tags;
        if (response.data.category) data.category = response.data.category;
        if (response.data.category_confidence !== undefined) data.aiCategoryConfidence = response.data.category_confidence;
      }

      // QR codes (payment/link QRs embedded in the PDF) ride in `metadata`
      // alongside whatever structured fields (deadline, reference number)
      // already live there — read-modify-write since Prisma has no partial
      // JSON merge, and this only costs an extra query on the (rare) notices
      // that actually contain one.
      const qrCodes = Array.isArray(response.data.qr_codes) ? response.data.qr_codes : [];
      if (qrCodes.length > 0) {
        const current = await this.prisma.scrapedItem.findUnique({ where: { id }, select: { metadata: true } });
        const existingMetadata = (current?.metadata as Record<string, unknown> | null) ?? {};
        data.metadata = {
          ...existingMetadata,
          qrCodes: qrCodes.map((q: any) => ({ page: q.page, data: q.data, image: q.image_base64 })),
        };
      }

      await this.prisma.scrapedItem.update({ where: { id }, data });
      this.logger.log(
        `Extracted notice ${id}: ${meta.chars} chars, quality=${meta.quality ?? 'n/a'}, method=${meta.method ?? 'n/a'}`,
      );
      return meta;
    });
  }

  /**
   * Rough mirror of the AI service's `_text_quality` scorer, used only to pick
   * re-extraction candidates without shipping every notice's text over HTTP.
   * Devanagari share decides it outright; otherwise English function-word
   * density separates prose from legacy-font noise ("BXXYRCO ; WREVERE …").
   */
  private textQuality(text: string | null): number {
    if (!text || text.trim().length < 40) return 0;
    const sample = text.slice(0, 8000);
    const nonSpace = sample.replace(/\s/g, '');
    if (!nonSpace) return 0;

    const devanagari = (nonSpace.match(/[ऀ-ॿ]/g) ?? []).length / nonSpace.length;
    if (devanagari >= 0.15) return Math.min(1, 0.65 + devanagari);

    const tokens = (sample.toLowerCase().match(/[a-z]{2,}/g) ?? []);
    if (tokens.length < 25) return 0.6;
    const hits = tokens.filter((t) => NoticesService.EN_STOPWORDS.has(t)).length;
    return Math.max(Math.min(1, hits / tokens.length / 0.12), Math.min(0.6, devanagari * 4));
  }

  /**
   * Minimum quality score (0-1) for extracted PDF text to be stored as a
   * notice's body. Mirrors the AI service's extractor.QUALITY_THRESHOLD —
   * below this the "text" is legacy-font/OCR noise rather than language.
   */
  private static readonly EXTRACTION_QUALITY_FLOOR = 0.55;

  private static readonly EN_STOPWORDS = new Set(
    ('the of and to in for is on by with as at from this that shall be will has have are was were ' +
      'it its or an a not all may must which their there been such under within after before date ' +
      'notice office ministry government nepal department').split(' '),
  );

  /** Quality score of a notice's stored text — surfaced so admins can see why. */
  contentQuality(text: string | null): number {
    return Math.round(this.textQuality(text) * 100) / 100;
  }

  /**
   * Admin action: re-run attachment extraction for one notice, overwriting the
   * stored text. Bypasses both the "already analyzed" sentinel and the
   * single-flight failure cooldown — this is a deliberate retry, not the
   * opportunistic background pass triggered by a page view.
   */
  async reextract(id: string) {
    const notice = await this.prisma.scrapedItem.findUnique({
      where: { id },
      include: { attachments: { select: { url: true, mimeType: true } } },
    });
    if (!notice) throw new NotFoundException(`Notice ${id} not found`);

    const attachmentUrl = this.findExtractableAttachmentUrl(notice);
    if (!attachmentUrl) {
      return {
        id,
        updated: false,
        reason: 'This notice has no PDF or image attachment to extract text from.',
      };
    }

    this.aiSingleFlight.reset(`pdf:${id}`);
    const before = this.contentQuality(notice.contentText);

    try {
      const meta = await this.extractPdfAndCache(id, notice.title, attachmentUrl);
      const fresh = await this.prisma.scrapedItem.findUnique({
        where: { id },
        select: { contentText: true },
      });
      const after = this.contentQuality(fresh?.contentText ?? null);

      // The stored text changed, so any memoized answer about it is stale.
      this.qaCache.clear();
      this.listCache.clear();

      return {
        id,
        updated: meta.chars > 0,
        chars: meta.chars,
        isOcr: meta.isOcr,
        method: meta.method,
        qualityBefore: before,
        qualityAfter: after,
        reason:
          meta.chars > 0
            ? undefined
            : 'Extraction produced no text — the attachment may be unreadable.',
      };
    } catch (err: any) {
      if (err instanceof SingleFlightCooldownError) {
        throw new ServiceUnavailableException('An extraction for this notice is already running.');
      }
      this.logger.warn(`Admin re-extract failed for ${id}: ${err.message}`);
      throw new ServiceUnavailableException(`Extraction failed: ${err.message}`);
    }
  }

  /**
   * Classify a notice's extraction health.
   * - clean: quality >= 0.55 (readable, keep)
   * - messy: 0 < quality < 0.55 (garbled legacy-font / OCR noise, re-extract may fix)
   * - broken: quality === 0 (empty / <40 chars, no usable text, needs re-extract if attachable)
   */
  private classifyExtraction(text: string | null): 'clean' | 'messy' | 'broken' {
    const q = this.textQuality(text);
    if (q >= 0.55) return 'clean';
    if (q === 0) return 'broken';
    return 'messy';
  }

  /**
   * Full pipeline health: scans ALL notices (paginated, not capped) and
   * differentiates clean / messy / broken. With attachments vs without is
   * tracked separately because only attachable ones can be fixed by re-extract.
   * Grows safely with catalogue size — offset pagination, 500 per batch.
   */
  async getExtractionHealth() {
    const batchSize = 500;
    let offset = 0;
    let total = 0;
    let withAttachment = 0;
    let withoutAttachment = 0;
    let clean = 0;
    let messy = 0;
    let broken = 0;
    let extractableMessy = 0;
    let extractableBroken = 0;

    for (;;) {
      const batch: Array<{ id: string; contentText: string | null; attachmentUrl: string | null; attachments: { url: string; mimeType: string | null }[] }> =
        await this.prisma.scrapedItem.findMany({
          select: { id: true, contentText: true, attachmentUrl: true, attachments: { select: { url: true, mimeType: true } } },
          orderBy: { scrapedAt: 'desc' },
          skip: offset,
          take: batchSize,
        });
      if (batch.length === 0) break;
      offset += batch.length;
      for (const n of batch) {
        total++;
        const hasAttachment = !!this.findExtractableAttachmentUrl(n as any);
        if (hasAttachment) withAttachment++;
        else withoutAttachment++;
        const cls = this.classifyExtraction(n.contentText);
        if (cls === 'clean') clean++;
        else if (cls === 'messy') {
          messy++;
          if (hasAttachment) extractableMessy++;
        } else {
          broken++;
          if (hasAttachment) extractableBroken++;
        }
      }
      if (batch.length < batchSize) break;
    }

    return {
      total,
      withAttachment,
      withoutAttachment,
      clean,
      messy,
      broken,
      extractableMessy,
      extractableBroken,
      queueable: extractableMessy + extractableBroken,
      // Percentages for UI convenience
      cleanPct: total ? Math.round((clean / total) * 100) : 0,
      messyPct: total ? Math.round((messy / total) * 100) : 0,
      brokenPct: total ? Math.round((broken / total) * 100) : 0,
    };
  }

  /**
   * Admin action: re-extract many notices in the background — now dynamic.
   *
   * - Scans the ENTIRE catalogue via offset pagination (no 200 cap).
   * - Differentiates clean / messy / broken on the fly.
   * - Only queues notices that can actually be fixed (has extractable attachment):
   *   - garbled (default): messy + broken with attachment
   *   - messy: only messy with attachment
   *   - broken: only broken with attachment
   *   - all: every notice with an attachment
   * - `limit` is optional: if omitted, scans all. If provided, caps the number
   *   of SCANNED rows (safety valve), not just queued. Bounded to 10k.
   * - Returns a full breakdown so the UI can show what was done and what remains.
   * - Background worker is concurrency-limited and never throws.
   */
  async reextractBulk(scope: 'garbled' | 'all' | 'broken' | 'messy' = 'garbled', limit?: number) {
    const batchSize = 500;
    const cappedLimit = limit !== undefined ? Math.min(Math.max(1, limit), 10000) : undefined;
    let offset = 0;
    let scanned = 0;
    let clean = 0;
    let messy = 0;
    let broken = 0;
    let withAttachment = 0;
    const queuedIds: string[] = [];

    // Scan all (or up to cappedLimit) with offset pagination — stable for any catalogue size
    scanLoop: for (;;) {
      const take = cappedLimit !== undefined ? Math.min(batchSize, cappedLimit - scanned) : batchSize;
      if (take <= 0) break;
      const batch: Array<{ id: string; contentText: string | null; attachmentUrl: string | null; attachments: { url: string; mimeType: string | null }[] }> =
        await this.prisma.scrapedItem.findMany({
          select: { id: true, contentText: true, attachmentUrl: true, attachments: { select: { url: true, mimeType: true } } },
          orderBy: { scrapedAt: 'desc' },
          skip: offset,
          take,
        });
      if (batch.length === 0) break;
      offset += batch.length;
      for (const n of batch) {
        if (cappedLimit !== undefined && scanned >= cappedLimit) break scanLoop;
        scanned++;
        const hasAttachment = !!this.findExtractableAttachmentUrl(n as any);
        if (hasAttachment) withAttachment++;
        const q = this.textQuality(n.contentText);
        const cls = q >= 0.55 ? 'clean' : q === 0 ? 'broken' : 'messy';
        if (cls === 'clean') clean++;
        else if (cls === 'messy') messy++;
        else broken++;

        const shouldQueue =
          scope === 'all' ? hasAttachment
          : scope === 'broken' ? cls === 'broken' && hasAttachment
          : scope === 'messy' ? cls === 'messy' && hasAttachment
          : cls !== 'clean' && hasAttachment; // garbled = messy+broken

        if (shouldQueue) queuedIds.push(n.id);
      }
      if (batch.length < take) break;
      if (cappedLimit !== undefined && scanned >= cappedLimit) break;
    }

    const queued = queuedIds.length;
    const baseStats = { scanned, clean, messy, broken, withAttachment, withoutAttachment: scanned - withAttachment, queued };

    // ── AI health gate (5s probe) ─────────────────────────────────────
    // If AI is warming or queue full, we still queue but warn and drop
    // concurrency to 1 so the 2-vCPU t3.medium isn't hit by 2×OCR+embed+Qdrant
    // while also serving scrape browser pool (4) and ingest (2) →7 heavy tasks.
    let effectiveConcurrency = 2;
    let healthWarning: string | undefined;
    try {
      const h = await this.probeAiHealth();
      if (!h.ready) {
        effectiveConcurrency = 1;
        healthWarning = `AI ${h.phase} (queue ${h.queueWaiting}/${h.queueLimit}) — concurrency reduced to 1`;
        this.logger.warn(`Bulk re-extract health gate: ${healthWarning} — still queuing ${queued} items`);
      }
    } catch (err: any) {
      effectiveConcurrency = 1;
      healthWarning = `Health probe failed: ${err.message} — concurrency reduced to 1`;
      this.logger.warn(`Bulk re-extract health gate probe failed: ${err.message} — concurrency reduced to 1, still queuing ${queued}`);
    }

    // ── Bulk progress tracking (in-memory, like scrape_progress) ───────
    const jobId = crypto.randomUUID();
    this.evictBulkProgress();
    const nowIso = new Date().toISOString();
    const progressEntry: BulkReextractProgress = {
      jobId,
      scope,
      status: queued === 0 ? 'done' : 'running',
      total: queued,
      processed: 0,
      improved: 0,
      failed: 0,
      scanned,
      clean,
      messy,
      broken,
      withAttachment,
      queued,
      message:
        queued === 0
          ? scanned === 0
            ? 'No notices found.'
            : 'No notices need re-extraction — all scanned items are clean or have no extractable attachment.'
          : healthWarning
            ? `Scanned ${scanned}: ${clean} clean, ${messy} messy, ${broken} broken — queuing ${queued} with warning: ${healthWarning}`
            : `Scanned ${scanned}: ${clean} clean, ${messy} messy, ${broken} broken — queuing ${queued} for background re-extraction.`,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    if (healthWarning) (progressEntry as any).healthWarning = healthWarning;
    this.bulkProgress.set(jobId, progressEntry);

    if (queued > 0) {
      void this.runBulkReextract(queuedIds, effectiveConcurrency, jobId);
    }

    if (queued === 0) {
      return {
        jobId,
        scope,
        ...baseStats,
        extractableMessy: scope === 'messy' || scope === 'garbled' ? queued : undefined,
        message: progressEntry.message,
        progress: progressEntry,
      };
    }

    return {
      jobId,
      scope,
      ...baseStats,
      healthWarning,
      effectiveConcurrency,
      message: progressEntry.message,
      progress: progressEntry,
      // Hint for polling
      progressUrl: `/admin/scraping/items/reextract/progress/${jobId}`,
    };
  }

  /** Background worker for `reextractBulk` — bounded concurrency, rate-limited, health-gated. */
  private async runBulkReextract(ids: string[], concurrency = 2, jobId?: string) {
    // Rate limiting: 500ms pause every 10 items + health check before next batch.
    // Prevents 2856 OCR jobs from spiking CPU on the single-worker AI (2 vCPU).
    const BATCH_SIZE = 10;
    const BATCH_DELAY_MS = 500;
    const HEALTH_PAUSE_MS = 2000;
    const QUEUE_FULL_PAUSE_MS = 5000;

    let cursor = 0;
    let done = 0;
    let improved = 0;
    let failed = 0;

    const update = (patch?: Partial<BulkReextractProgress>) => {
      if (!jobId) return;
      const e = this.bulkProgress.get(jobId);
      if (!e) return;
      e.processed = done;
      e.improved = improved;
      e.failed = failed;
      e.updatedAt = new Date().toISOString();
      if (patch) Object.assign(e, patch);
    };

    const worker = async () => {
      for (;;) {
        const idx = cursor++;
        if (idx >= ids.length) return;
        const id = ids[idx];

        // Every BATCH_SIZE items, add delay + probe AI health; if warming or
        // queue full, pause longer so the 1-worker AI can drain.
        if (idx > 0 && idx % BATCH_SIZE === 0) {
          await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
          try {
            const h = await this.probeAiHealth();
            if (!h.ready) {
              this.logger.warn(
                `Bulk job ${jobId ?? ''}: AI not ready at batch ${idx} (phase=${h.phase}, queue ${h.queueWaiting}/${h.queueLimit}) — pausing ${h.queueFull ? QUEUE_FULL_PAUSE_MS : HEALTH_PAUSE_MS}ms`,
              );
              update({ message: `Paused at ${done}/${ids.length} — AI ${h.phase} (queue ${h.queueWaiting}/${h.queueLimit}), waiting...` });
              await new Promise((r) => setTimeout(r, h.queueFull ? QUEUE_FULL_PAUSE_MS : HEALTH_PAUSE_MS));
              // Re-check after pause; if still full, one more long pause
              if (h.queueFull) {
                try {
                  const h2 = await this.probeAiHealth();
                  if (h2.queueFull) {
                    this.logger.warn(`Bulk job ${jobId ?? ''}: queue still full after pause — pausing additional ${QUEUE_FULL_PAUSE_MS}ms`);
                    await new Promise((r) => setTimeout(r, QUEUE_FULL_PAUSE_MS));
                  }
                } catch {
                  // health re-check failed, continue with re-extract anyway
                }
              }
            }
          } catch (err: any) {
            this.logger.warn(`Bulk job ${jobId ?? ''}: health check failed at batch ${idx}: ${err.message} — continuing`);
          }
        }

        try {
          const result = await this.reextract(id);
          done++;
          if (result.updated && (result.qualityAfter ?? 0) > (result.qualityBefore ?? 0)) {
            improved++;
          }
          update();
        } catch (err: any) {
          done++;
          failed++;
          this.logger.warn(`Bulk re-extract failed for ${id}: ${err.message}`);
          update();
        }
      }
    };

    try {
      await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, worker));
      update({ status: 'done', message: `Finished: ${done}/${ids.length} processed, ${improved} improved, ${failed} failed` } as any);
      if (ids.length > 0) {
        this.logger.log(`Bulk re-extract ${jobId ?? ''} finished: ${ids.length} processed, ${improved} improved, ${failed} failed`);
      }
    } catch (err: any) {
      update({ status: 'failed', error: err.message } as any);
      this.logger.error(`Bulk re-extract ${jobId ?? ''} failed: ${err.message}`);
    }
  }

  private async analyzeAndCache(id: string, title: string, content: string) {
    // Single-flight per notice: N concurrent viewers opening the same
    // unanalyzed notice share ONE summarization call. Errors are re-thrown so
    // the single-flight backoff applies (callers `.catch()`).
    return this.aiSingleFlight.run(`analyze:${id}`, async () => {
      let response;
      try {
        response = await firstValueFrom(
          this.httpService.post(
            `${this.aiServiceUrl}/notices/analyze`,
            { title, content },
            // Background enrichment (not user-facing) but Ollama can still take 10-20s; keep under AI budget
            { timeout: 60000 },
          ),
        );
      } catch (err: any) {
        this.logger.warn(`Notice analysis failed for ${id}: ${err.message}`);
        throw err;
      }
      if (!response.data?.analyzed) {
        // Still stamp aiAnalyzedAt so we don't retry every single view when
        // there's genuinely nothing to summarize (e.g. no LLM configured).
        return this.prisma.scrapedItem.update({
          where: { id },
          data: { aiAnalyzedAt: new Date() },
        });
      }
      return this.prisma.scrapedItem.update({
        where: { id },
        data: {
          aiSummary: response.data.summary,
          aiSummaryNe: response.data.summary_ne ?? null,
          keyFacts: response.data.key_facts ?? [],
          tags: response.data.tags ?? [],
          aiCategoryConfidence: response.data.category_confidence ?? null,
          category: response.data.category ?? undefined,
          aiAnalyzedAt: new Date(),
        },
      });
    });
  }

  async askQuestion(id: string, question: string): Promise<{ answer: string }> {
    const notice = await this.prisma.scrapedItem.findUnique({
      where: { id },
      include: {
        attachments: {
          select: { url: true, label: true, mimeType: true, sizeBytes: true },
        },
      },
    });
    if (!notice) throw new NotFoundException(`Notice ${id} not found`);

    // Identical questions on the same notice share one LLM call (memoized in
    // qaCache). Fallback/error answers are never cached — only real AI
    // answers, so a transient failure isn't served stale for 5 minutes.
    const cacheKey = `qa:${id}:${question}`;
    const cached = this.qaCache.get(cacheKey);
    if (cached) return cached as { answer: string };

    try {
      const response = await firstValueFrom(
        this.httpService.post(
          `${this.aiServiceUrl}/notices/ask`,
          {
            title: notice.title,
            content: notice.contentText ?? '',
            question,
            // Everything the notice page itself shows. Sending only
            // contentText meant the model couldn't answer "is there a PDF?"
            // (it never saw the attachments) and had nothing to fall back on
            // when a scanned/legacy-font PDF extracts as garbled text.
            summary: notice.aiSummary ?? notice.summary ?? '',
            summary_ne: notice.aiSummaryNe ?? '',
            key_facts: Array.isArray(notice.keyFacts) ? notice.keyFacts : [],
            metadata:
              notice.metadata && typeof notice.metadata === 'object' ? notice.metadata : {},
            category: notice.category,
            source_label: notice.sourceLabel,
            source_url: notice.sourceUrl,
            published_at: notice.publishedAt?.toISOString() ?? null,
            attachments: this.attachmentContext(notice),
          },
          // Walking the provider fallback chain costs a retry+backoff per
          // failed provider, so a degraded chain answers in ~35s and Ollama
          // 1.5b on CPU can add another 5-15s. At 30s the request was cut off
          // and the user got an error instead of the answer the AI service
          // was about to return. 120s stays comfortably under AI's 180s and
          // nginx 300s, but above the old 20s frontend that showed "(canceled)".
          { timeout: 120000 },
        ),
      );
      const answer = { answer: String(response.data?.answer ?? '') };
      this.qaCache.set(cacheKey, answer);
      return answer;
    } catch (err: any) {
      this.logger.warn(`Notice Q&A failed for ${id}: ${err.message}`);
      return { answer: 'Sorry, I could not process this question right now — please try again shortly.' };
    }
  }

  /**
   * Hybrid notice search for the floating chatbot:
   * 1. PostgreSQL keyword search (fast, free)
   * 2. Pass results to AI service which uses them or falls back to Qdrant semantic search
   * 3. LLM generates an answer from the retrieved context
   */
  async search(
    question: string,
    category?: string,
    language?: string,
    skipClarification = false,
  ) {
    // Identical chatbot queries (same question + filters) share the LLM call
    // within the TTL window — a popular question asked by many visitors
    // doesn't re-hit the AI service (and possibly Qdrant) each time.
    // skipClarification is part of the key: the same question answers very
    // differently with the ambiguity gate on versus bypassed.
    const cacheKey = `search:${question}:${category ?? ''}:${language ?? ''}:${skipClarification ? 'all' : ''}`;
    const cached = this.qaCache.get(cacheKey);
    if (cached) return cached;

    const intent = parseSearchIntent(question);
    // A question like "latest tender notices" names its own category; honour
    // it when the caller didn't pin one, so the answer can't drift into
    // vacancies and jobs.
    const pageCategory = category as ScrapedItemCategory | undefined;
    const effectiveCategory = pageCategory ?? intent.category;

    let pgResults = await this.keywordSearch(intent, effectiveCategory);
    // What the user typed outranks what page they typed it on. Asking "what's
    // the latest tax policy" while the list happens to be filtered to tenders
    // must not answer "nothing found" when a matching circular or news item
    // exists — so a page filter that yields nothing is dropped and retried.
    if (pgResults.length === 0 && pageCategory && !intent.category) {
      pgResults = await this.keywordSearch(intent, undefined);
    }

    // Step 2: Pass to AI service for hybrid search + LLM answer generation
    try {
      const response = await firstValueFrom(
        this.httpService.post(
          `${this.aiServiceUrl}/notices/search`,
          {
            question,
            pg_results: pgResults.map((r) => ({
              id: r.id,
              title: r.title,
              aiSummary: r.aiSummary,
              category: r.category,
              sourceLabel: r.sourceLabel,
              sourceUrl: r.sourceUrl,
              publishedAt: r.publishedAt?.toISOString() || null,
            })),
            // Only a category the *question* named constrains the semantic
            // leg. A page filter is context, not instruction: hard-filtering
            // Qdrant by it would hide the notice that actually answers a
            // question asked from an unrelated listing page.
            category: intent.category ?? null,
            language: language || 'en',
            top_k: 5,
            // The AI service orders its own Qdrant fallback by similarity,
            // which is the wrong axis for "latest"/"recent" questions.
            recency_intent: intent.wantsLatest,
            // Set once the user has answered (or dismissed) a clarifying
            // question, so re-asking the same thing can't loop on it.
            skip_clarification: skipClarification,
          },
          // RAG via Ollama 1.5b on CPU: 5-15s generation plus fallback retries and Qdrant search; 45s cut slow but valid answers (flood toll queries) mid-generation and surfaced as "(canceled)" after the frontend's 20s abort. 120s matches the frontend LONG_TIMEOUT and stays below AI 180s / nginx 300s.
          { timeout: 120000 },
        ),
      );
      this.qaCache.set(cacheKey, response.data);
      return response.data;
    } catch (err: any) {
      this.logger.warn(`Notice search failed: ${err.message}`);
      // If AI service is down, return a basic response from PG results.
      // Says so explicitly: an unlabelled list reads as a considered answer
      // to the question, when it is really just the search hits.
      if (pgResults.length > 0) {
        return {
          answer:
            `I can't reach the AI assistant right now, so here are the ` +
            `${Math.min(3, pgResults.length)} closest matching notices instead:\n\n` +
            pgResults.slice(0, 3).map((r, i) =>
              `${i + 1}. **${r.title}**` +
              (r.publishedAt ? ` _(${r.publishedAt.toISOString().slice(0, 10)})_` : '') +
              (r.aiSummary ? ` — ${r.aiSummary.slice(0, 150)}...` : '')
            ).join('\n\n'),
          sources: pgResults.slice(0, 5).map((r) => ({
            id: r.id,
            title: r.title,
            category: r.category,
            sourceUrl: r.sourceUrl,
          })),
          model_used: null,
        };
      }
      return {
        answer: 'Sorry, I could not process your search right now. Please try again shortly.',
        sources: [],
        model_used: null,
      };
    }
  }

  /**
   * Keyword leg of the chatbot's hybrid search.
   *
   * The previous version matched the *entire question* as one ILIKE substring
   * ("latest tender notices" against `title`), which no real notice ever
   * contains — so this leg silently returned nothing for every natural
   * language question and the answer came from whatever the semantic
   * fallback happened to surface, dates and category included. Matching per
   * term and ranking the candidates in-process is what makes the answer
   * correspond to the question.
   */
  private async keywordSearch(intent: SearchIntent, category?: ScrapedItemCategory) {
    const select = {
      id: true,
      title: true,
      aiSummary: true,
      category: true,
      sourceLabel: true,
      sourceUrl: true,
      publishedAt: true,
    } as const;
    const where: Prisma.ScrapedItemWhereInput = category ? { category } : {};

    // "Latest tender notices" is *entirely* intent + category once those are
    // parsed out — there is no content word left to match. The honest reading
    // is "the newest ones", not "nothing found".
    if (intent.terms.length === 0) {
      if (!intent.wantsLatest && !category) return [];
      return this.prisma.scrapedItem.findMany({
        where,
        select,
        orderBy: { publishedAt: 'desc' },
        take: 10,
      });
    }

    const candidates = await this.prisma.scrapedItem.findMany({
      where: {
        ...where,
        OR: intent.terms.flatMap((term) => [
          { title: { contains: term, mode: 'insensitive' as const } },
          { aiSummary: { contains: term, mode: 'insensitive' as const } },
          { contentText: { contains: term, mode: 'insensitive' as const } },
        ]),
      },
      select,
      orderBy: { publishedAt: 'desc' },
      // Widened well past the 10 we return: ranking only improves on what it
      // is given, and `publishedAt desc` alone would hand back the newest
      // single-term match ahead of an older notice that matched every term.
      take: 60,
    });

    const scored = candidates.map((row) => {
      let score = 0;
      for (const term of intent.terms) {
        // Title hits are the strongest signal of aboutness, body text the
        // weakest — a term appearing once in a long PDF says little.
        if (row.title?.toLowerCase().includes(term)) score += 3;
        if (row.aiSummary?.toLowerCase().includes(term)) score += 2;
      }
      return { row, score };
    });

    // A term appearing only in a long body PDF scores 0 here. Those are kept
    // solely as a last resort: once anything matched a title or summary, the
    // body-only hits are noise, and passing them to the model as context is
    // how an answer ends up citing a notice that merely contains the word.
    const ranked = scored.some((s) => s.score > 0) ? scored.filter((s) => s.score > 0) : scored;

    const time = (r: (typeof ranked)[number]) => r.row.publishedAt?.getTime() ?? 0;
    ranked.sort((a, b) =>
      // "Latest X" asks for a date ordering over the matching set; every
      // other question wants the best match first.
      intent.wantsLatest ? time(b) - time(a) || b.score - a.score : b.score - a.score || time(b) - time(a),
    );

    return ranked.slice(0, 10).map((s) => s.row);
  }

  async categoryCounts() {
    return this.metaCache.remember('category-counts', async () => {
      const counts = await this.prisma.scrapedItem.groupBy({
        by: ['category'],
        _count: { _all: true },
      });
      return Object.fromEntries(counts.map((c) => [c.category, c._count._all]));
    });
  }

  /** Lightweight source list for the public filter dropdown — name/id only. */
  async listSources() {
    return this.metaCache.remember('sources', async () => {
      return this.prisma.scrapeSource.findMany({
        where: { enabled: true },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      });
    });
  }

  /**
   * id/title/updatedAt for the web app's public sitemap.xml.
   *
   * Newest first and capped: Google's per-sitemap limit is 50k URLs, and the
   * newest notices are the ones worth recrawling. Cached like the other meta
   * reads so a crawler hitting /sitemap.xml can't hammer the database.
   */
  async sitemapFeed(limit?: number) {
    const take = Math.min(Math.max(1, limit ?? 5000), 50000);
    return this.metaCache.remember(`sitemap:${take}`, async () => {
      const rows = await this.prisma.scrapedItem.findMany({
        select: { id: true, title: true, updatedAt: true, publishedAt: true },
        // NULLs sort FIRST under a plain Postgres DESC, so undated rows would
        // occupy the top of the window and push real recent notices out of
        // the sitemap entirely.
        orderBy: { publishedAt: { sort: 'desc', nulls: 'last' } },
        take,
      });
      // Never publish a junk row to a search engine: an "(untitled)" page is
      // a thin result that earns a manual action, not traffic. Same predicate
      // the scraper admits on, so the two can't disagree.
      return rows.filter((r) => this.isIndexableTitle(r.title));
    });
  }

  /** A title real enough to deserve its own indexed page. */
  private isIndexableTitle(title: string | null): boolean {
    const clean = (title ?? '').replace(/\s+/g, ' ').trim();
    if (clean.length < 8) return false;
    if (/^\(?untitled\)?$/i.test(clean)) return false;
    // Devanagari letters start at U+0904 — U+0900-0903 are combining marks.
    return (clean.match(/[A-Za-zऄ-ॿ]/g)?.length ?? 0) >= 5;
  }
}

export interface SearchIntent {
  /** Content words to match, lowercased. Intent/category/stop words removed. */
  terms: string[];
  /** The question asked for the newest items rather than the best match. */
  wantsLatest: boolean;
  /** Category named by the question itself, if any. */
  category?: ScrapedItemCategory;
}

/** Words that carry no retrieval signal in a notice corpus (every row is a "notice"). */
const SEARCH_STOP_WORDS = new Set([
  'a', 'about', 'all', 'am', 'an', 'and', 'announcement', 'announcements', 'any', 'are', 'as',
  'at', 'be', 'been', 'by', 'can', 'do', 'does', 'find', 'for', 'from', 'get', 'give', 'has',
  'have', 'i', 'in', 'is', 'it', 'list', 'me', 'my', 'notice', 'notices', 'of', 'on', 'or',
  'please', 'search', 'show', 'some', 'suchana', 'tell', 'that', 'the', 'there', 'these',
  'this', 'to', 'update', 'updates', 'was', 'were', 'what', 'when', 'where', 'which', 'who',
  'with', 'you', 'your',
]);

/** Recency words — these ask for a date ordering, not a similarity ordering. */
const RECENCY_WORDS = new Set([
  'latest', 'newest', 'recent', 'recently', 'new', 'current', 'today', 'now', 'upcoming',
  'this week', 'nayaa', 'naya',
]);

/**
 * Question words that name a category. Kept deliberately small and
 * unambiguous: a wrong guess here narrows the corpus to the wrong slice,
 * which is worse than not guessing at all.
 */
const CATEGORY_WORDS: Record<string, ScrapedItemCategory> = {
  tender: ScrapedItemCategory.TENDER,
  tenders: ScrapedItemCategory.TENDER,
  bid: ScrapedItemCategory.TENDER,
  bids: ScrapedItemCategory.TENDER,
  procurement: ScrapedItemCategory.TENDER,
  bolpatra: ScrapedItemCategory.TENDER,
  vacancy: ScrapedItemCategory.VACANCY,
  vacancies: ScrapedItemCategory.VACANCY,
  job: ScrapedItemCategory.JOB,
  jobs: ScrapedItemCategory.JOB,
  internship: ScrapedItemCategory.INTERNSHIP,
  internships: ScrapedItemCategory.INTERNSHIP,
  circular: ScrapedItemCategory.CIRCULAR,
  circulars: ScrapedItemCategory.CIRCULAR,
  news: ScrapedItemCategory.NEWS,
};

/**
 * Split a chatbot question into the parts retrieval can actually use.
 *
 * "Latest tender notices" → terms: [], wantsLatest: true, category: TENDER.
 * Nothing is left to keyword-match, and that is the correct outcome: the
 * caller answers it as "the newest tenders" instead of matching the literal
 * phrase against notice titles and finding nothing.
 */
export function parseSearchIntent(question: string): SearchIntent {
  // \p{M} is load-bearing, not decorative: Devanagari vowel signs (ि, े, ो…)
  // are combining marks, not letters, so a \p{L}\p{N}-only filter shreds
  // "शिक्षक" into "श"/"क"/"षक" and the length filter below then drops the
  // fragments — every Nepali question would arrive with zero search terms.
  const words = question
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s]+/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);

  const wantsLatest = words.some((w) => RECENCY_WORDS.has(w));
  const category = words.map((w) => CATEGORY_WORDS[w]).find(Boolean);

  const terms = words.filter(
    (w) =>
      w.length > 2 &&
      !SEARCH_STOP_WORDS.has(w) &&
      !RECENCY_WORDS.has(w) &&
      // Already expressed as a category filter — matching the literal word
      // "tender" against titles would then rank English-titled notices above
      // the Nepali ones that make up most of the corpus.
      !(category && CATEGORY_WORDS[w] === category),
  );

  return { terms: Array.from(new Set(terms)), wantsLatest, category };
}
