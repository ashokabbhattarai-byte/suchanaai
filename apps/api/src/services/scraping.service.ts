import { Injectable, Logger, NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import {
  ScrapedItemCategory,
  ScrapeRunStatus,
  ScrapePaginationType,
  ScrapeSource,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from './settings.service';
import { AlertMatchingService } from './alert-matching.service';
import * as crypto from 'crypto';

/**
 * Minimum extraction-quality score (0-1, from the AI service's
 * extractor._text_quality) for PDF text to be stored as a notice's body.
 * Mirrors the AI service's own QUALITY_THRESHOLD: below this the "text" is
 * legacy-font/OCR noise rather than language.
 */
const EXTRACTION_QUALITY_FLOOR = 0.55;

/**
 * One page/URL the AI service's crawler (crawl4ai) failed to fetch or parse
 * during a run — surfaced by the scraper instead of being discarded into its
 * own stdout log, so the admin can see exactly where and why a run failed.
 */
interface ScrapeFailure {
  url: string;
  stage: 'schema_detection' | 'listing' | 'detail' | 'raw_fetch' | 'sitemap' | string;
  error: string;
  // "skipped" entries are deliberate decisions (already scraped, not an
  // article URL, untitled), not problems. Undefined on pre-existing rows.
  outcome?: 'failed' | 'skipped';
  reason?: string;
}

interface RawAttachment {
  url: string;
  label: string | null;
  mime_type: string | null;
  size_bytes: number | null;
}

interface RawScrapedItem {
  category: string;
  title: string;
  source_url: string;
  published_at: string | null;
  summary: string | null;
  content_text: string | null;
  content_html: string | null;
  attachment_url: string | null;
  source_slug: string | null;
  attachments: RawAttachment[];
  ai_summary: string | null;
  ai_summary_ne: string | null;
  ai_urgency: string | null;
  ai_category_confidence: number | null;
  metadata: Record<string, unknown> | null;
}

export interface CreateScrapeSourceInput {
  name: string;
  baseUrl: string;
  noticeListUrl?: string | null;
  newsListUrl?: string | null;
  pressReleaseListUrl?: string | null;
  paginationType?: ScrapePaginationType;
  paginationParam?: string;
  startPage?: number;
  maxPages?: number;
  pollIntervalSeconds?: number;
  sitemapUrl?: string | null;
}

export interface UpdateScrapeSourceInput {
  name?: string;
  baseUrl?: string;
  noticeListUrl?: string | null;
  newsListUrl?: string | null;
  pressReleaseListUrl?: string | null;
  enabled?: boolean;
  paginationType?: ScrapePaginationType;
  paginationParam?: string;
  startPage?: number;
  maxPages?: number;
  pollIntervalSeconds?: number;
  sitemapUrl?: string | null;
}

@Injectable()
export class ScrapingService {
  private readonly logger = new Logger(ScrapingService.name);
  private readonly aiServiceUrl: string;
  // A run is considered abandoned (API crashed mid-crawl, etc.) after this
  // many seconds; the scheduler then reclaims it as FAILED so the source can
  // be polled again. The actual per-source concurrency lock is the DB: a
  // RUNNING ScrapeRun row newer than this timeout (see #findActiveRun) —
  // survives API restarts and works across multiple API replicas.
  private readonly staleRunTimeoutSeconds: number;
  // Interval used as the *effective floor* for auto-polling when the admin
  // sets a sitemap fast-path below what politeness allows.
  private readonly minPollIntervalSeconds: number;

  constructor(
    private readonly httpService: HttpService,
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly alertMatching: AlertMatchingService,
  ) {
    this.aiServiceUrl =
      this.config.get<string>('AI_SERVICE_URL') || 'http://localhost:8000';
    this.staleRunTimeoutSeconds =
      Number(this.config.get<string>('SCRAPING_STALE_TIMEOUT_SECONDS')) || 3600;
    this.minPollIntervalSeconds =
      Number(this.config.get<string>('SCRAPING_MIN_POLL_INTERVAL_SECONDS')) || 60;
  }

  // --- Source CRUD ---

  async listSources() {
    const sources = await this.prisma.scrapeSource.findMany({
      orderBy: { createdAt: 'asc' },
      include: { _count: { select: { items: true } } },
    });
    return sources.map((s) => ({ ...s, itemCount: s._count.items, _count: undefined }));
  }

  async getSource(id: string) {
    const source = await this.prisma.scrapeSource.findUnique({ where: { id } });
    if (!source) throw new NotFoundException(`Scrape source ${id} not found`);
    return source;
  }

  async createSource(input: CreateScrapeSourceInput) {
    if (!input.noticeListUrl && !input.newsListUrl && !input.pressReleaseListUrl) {
      throw new ConflictException(
        'At least one listing URL (notice, news, or press release) is required',
      );
    }
    return this.prisma.scrapeSource.create({
      data: {
        name: input.name,
        baseUrl: input.baseUrl,
        noticeListUrl: input.noticeListUrl || null,
        newsListUrl: input.newsListUrl || null,
        pressReleaseListUrl: input.pressReleaseListUrl || null,
        ...(input.paginationType ? { paginationType: input.paginationType } : {}),
        ...(input.paginationParam ? { paginationParam: input.paginationParam } : {}),
        ...(input.startPage ? { startPage: input.startPage } : {}),
        ...(input.maxPages ? { maxPages: input.maxPages } : {}),
        pollIntervalSeconds:
          input.pollIntervalSeconds ??
          (input.sitemapUrl ? 180 : 900),
        sitemapUrl: input.sitemapUrl || null,
        ...(input.sitemapUrl ? { sitemapCheckedAt: new Date() } : {}),
      },
    });
  }

  async updateSource(id: string, input: UpdateScrapeSourceInput) {
    await this.getSource(id);
    const data: Prisma.ScrapeSourceUpdateInput = {
      ...input,
      // Listing URL changes invalidate any cached extraction schema for that
      // category — the old selectors were derived from the old page.
      ...(input.noticeListUrl !== undefined ? { noticeSchema: Prisma.JsonNull } : {}),
      ...(input.newsListUrl !== undefined ? { newsSchema: Prisma.JsonNull } : {}),
      ...(input.pressReleaseListUrl !== undefined
        ? { pressReleaseSchema: Prisma.JsonNull }
        : {}),
    };
    // A base-URL change invalidates a cached sitemap too — the old one may
    // belong to a different host entirely.
    if (input.baseUrl !== undefined) {
      data.sitemapUrl = null;
      data.sitemapCheckedAt = null;
    }
    // Clearing the sitemap URL also clears the "detected once" flag so a
    // future detection can run again.
    if (input.sitemapUrl === null) {
      data.sitemapCheckedAt = null;
    } else if (input.sitemapUrl !== undefined) {
      data.sitemapUrl = input.sitemapUrl;
      data.sitemapCheckedAt = new Date();
    }
    return this.prisma.scrapeSource.update({ where: { id }, data });
  }

  async deleteSource(id: string) {
    await this.getSource(id);
    await this.prisma.scrapeSource.delete({ where: { id } });
    return { deleted: true };
  }

  /**
   * Admin "paste a link" quick-scrape: ingest one arbitrary notice / news /
   * press-release URL without requiring a pre-configured Source. Reuses
   * whatever Source already owns that URL's domain (configured or a prior
   * ad-hoc one); otherwise auto-creates a minimal, disabled-from-scheduling
   * Source for the domain so the normal detail-page crawl + persistence
   * pipeline (runSourceFromUrls) can be reused unchanged.
   */
  async quickScrape(rawUrl: string) {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new BadRequestException('Not a valid URL');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new BadRequestException('URL must be http or https');
    }
    const url = parsed.toString();
    const origin = parsed.origin;

    const existingItem = await this.prisma.scrapedItem.findUnique({
      where: { sourceUrl: url },
    });
    if (existingItem) {
      return {
        alreadyExists: true as const,
        item: { id: existingItem.id, title: existingItem.title, category: existingItem.category },
      };
    }

    let source = await this.prisma.scrapeSource.findFirst({
      where: { baseUrl: { equals: origin, mode: 'insensitive' } },
    });
    let sourceCreated = false;
    if (!source) {
      source = await this.prisma.scrapeSource.create({
        data: {
          name: parsed.hostname,
          baseUrl: origin,
          isAdHoc: true,
          enabled: true,
          pollIntervalSeconds: 900,
        },
      });
      sourceCreated = true;
    }

    const { runId } = await this.runSourceFromUrls(source.id, [url]);
    return { alreadyExists: false as const, runId, sourceId: source.id, sourceCreated };
  }

  // --- Run ---

  /**
   * Trigger a scrape run for one source. Returns immediately with the run id
   * so the admin UI can poll live progress messages while the (potentially
   * multi-page, multi-detail-fetch) crawl runs in the background — mirrors
   * the fire-and-forget pattern used for document ingestion.
   *
   * Concurrency is guarded by the DB rather than an in-memory Set: a fresh
   * RUNNING ScrapeRun row acts as the lock, so it survives API restarts and
   * holds even if the API is scaled to multiple replicas.
   */
  async runSource(id: string, categories?: ('NOTICE' | 'NEWS' | 'PRESS_RELEASE')[]) {
    const source = await this.getSource(id);
    if (!source.enabled) {
      throw new ConflictException('This source is disabled');
    }
    const active = await this.findActiveRun(id);
    if (active) {
      throw new ConflictException(
        `A scrape run is already in progress for this source (started ${active.startedAt.toISOString()})`,
      );
    }

    const run = await this.prisma.scrapeRun.create({
      data: { sourceId: id, sourceLabel: source.name, status: ScrapeRunStatus.RUNNING },
    });

    this.executeRun(run.id, source, categories).catch((err: any) => {
      this.logger.error(`Unhandled error in scrape run ${run.id}: ${err.message}`);
    });

    return { runId: run.id };
  }

  /**
   * Sitemap-driven full crawl: scrape the exact <loc> URLs a sitemap check
   * already reported as new, directly as detail pages — no listing-page
   * crawl. Some sites' category URLs 404 while their sitemap stays healthy
   * (mohp.gov.np serves only an SVG error page at /category/*); for those
   * the listing crawl yields zero items, so the sitemap URLs ARE the crawl.
   */
  async runSourceFromUrls(id: string, urls: string[]) {
    const source = await this.getSource(id);
    if (!source.enabled) {
      throw new ConflictException('This source is disabled');
    }
    if (!urls.length) {
      throw new ConflictException('No URLs to scrape');
    }
    const active = await this.findActiveRun(id);
    if (active) {
      throw new ConflictException(
        `A scrape run is already in progress for this source (started ${active.startedAt.toISOString()})`,
      );
    }

    const run = await this.prisma.scrapeRun.create({
      data: { sourceId: id, sourceLabel: source.name, status: ScrapeRunStatus.RUNNING },
    });

    this.executeRunFromUrls(run.id, source, urls).catch((err: any) => {
      this.logger.error(`Unhandled error in sitemap scrape run ${run.id}: ${err.message}`);
    });

    return { runId: run.id };
  }

  /**
   * Retry a specific (typically FAILED) run from the admin Logs view: looks
   * up which source the run belonged to and kicks off a fresh full run for
   * it via the normal runSource() path — same lock/lifecycle as "Run now",
   * just reachable directly from a failed run row instead of hunting down
   * the matching source card.
   */
  async retryRun(runId: string) {
    const run = await this.prisma.scrapeRun.findUnique({ where: { id: runId } });
    if (!run) throw new NotFoundException(`Scrape run ${runId} not found`);
    if (!run.sourceId) {
      throw new ConflictException('This run has no associated source to retry');
    }
    return this.runSource(run.sourceId);
  }

  /**
   * Convenience bulk trigger for the admin UI: runs every enabled source that
   * isn't already (freshly) RUNNING. Each source goes through the same
   * runSource() path — the DB-backed lock prevents overlap, and disabled or
   * busy sources are reported rather than erroring the whole batch.
   */
  async runAllSources(categories?: ('NOTICE' | 'NEWS' | 'PRESS_RELEASE')[]) {
    const sources = await this.prisma.scrapeSource.findMany({
      orderBy: { createdAt: 'asc' },
    });

    // One query for all active RUNNING runs instead of N sequential findActiveRun calls
    const activeRuns = await this.prisma.scrapeRun.findMany({
      where: {
        status: ScrapeRunStatus.RUNNING,
        startedAt: { gte: new Date(Date.now() - this.staleRunTimeoutSeconds * 1000) },
        sourceId: { not: null },
      },
      select: { sourceId: true },
    });
    const activeSourceIds = new Set(activeRuns.map((r) => r.sourceId!));

    const results: {
      sourceId: string;
      sourceName: string;
      runId: string | null;
      status: 'scheduled' | 'already-running' | 'disabled';
    }[] = [];

    for (const source of sources) {
      if (!source.enabled) {
        results.push({ sourceId: source.id, sourceName: source.name, runId: null, status: 'disabled' });
        continue;
      }
      if (activeSourceIds.has(source.id)) {
        results.push({ sourceId: source.id, sourceName: source.name, runId: null, status: 'already-running' });
        continue;
      }
      try {
        const { runId } = await this.runSource(source.id, categories);
        results.push({ sourceId: source.id, sourceName: source.name, runId, status: 'scheduled' });
        // Mark as active immediately to avoid double-scheduling within this same batch loop
        activeSourceIds.add(source.id);
      } catch {
        // A source could race into a RUNNING state between the check above
        // and runSource — never fail the whole batch for that.
        results.push({ sourceId: source.id, sourceName: source.name, runId: null, status: 'already-running' });
      }
    }

    return {
      scheduled: results.filter((r) => r.status === 'scheduled').length,
      skipped: results.length - results.filter((r) => r.status === 'scheduled').length,
      results,
    };
  }

  /**
   * The DB-backed per-source lock: the most recent RUNNING run for the
   * source, if it started within the stale-run window. Any RUNNING row older
   * than the window is treated as an abandoned run (crashed process) and
   * does not block a fresh run.
   */
  async findActiveRun(sourceId: string) {
    return this.prisma.scrapeRun.findFirst({
      where: {
        sourceId,
        status: ScrapeRunStatus.RUNNING,
        startedAt: { gte: new Date(Date.now() - this.staleRunTimeoutSeconds * 1000) },
      },
      orderBy: { startedAt: 'desc' },
    });
  }

  /**
   * Reclaim abandoned RUNNING runs (API crashed mid-crawl) as FAILED so the
   * scheduler can poll the source again. Safe to call repeatedly; a no-op
   * when there is nothing stale.
   */
  async recoverStaleRuns() {
    const cutoff = new Date(Date.now() - this.staleRunTimeoutSeconds * 1000);
    const stale = await this.prisma.scrapeRun.findMany({
      where: { status: ScrapeRunStatus.RUNNING, startedAt: { lt: cutoff } },
    });
    for (const run of stale) {
      this.logger.warn(
        `Reclaiming stale scrape run ${run.id} (started ${run.startedAt.toISOString()}) as FAILED`,
      );
      const message = `Abandoned run reclaimed by scheduler (started ${run.startedAt.toISOString()}) — the crawl likely hung or the server restarted mid-run`;
      await this.prisma.scrapeRun.update({
        where: { id: run.id },
        data: {
          status: ScrapeRunStatus.FAILED,
          error: message,
          finishedAt: new Date(),
        },
      });
      // Bump the source so it becomes eligible again without a re-scrape
      // storm on the very next tick.
      if (run.sourceId) {
        await this.prisma.scrapeSource.update({
          where: { id: run.sourceId },
          data: {
            lastRunAt: new Date(),
            lastStatus: ScrapeRunStatus.FAILED,
            lastError: message,
            lastFailedUrls: Prisma.JsonNull,
          },
        });
      }
    }
    return stale.length;
  }

  /**
   * Record that the scheduler polled a source's sitemap and found nothing
   * new — the poll itself satisfies the interval, so lastRunAt advances but
   * no ScrapeRun row is created (a check is not a scrape).
   */
  async markSourcePolled(id: string) {
    return this.prisma.scrapeSource.update({
      where: { id },
      data: { lastRunAt: new Date() },
    });
  }

  /**
   * One-time sitemap detection for a source (the cheap fast-path). Persists
   * the winning sitemap URL — or caches null so detection is never retried
   * every tick — and returns the updated source. Tightens the poll interval
   * from the slow HTML default to the fast 3-min cadence when a sitemap is
   * found, since the source can now be probed cheaply.
   */
  async detectSitemap(id: string) {
    const source = await this.getSource(id);
    const response = await firstValueFrom(
      this.httpService.post(
        `${this.aiServiceUrl}/scrape/sitemap/detect`,
        { base_url: source.baseUrl },
        { timeout: 30000 },
      ),
    );
    const sitemapUrl: string | null = response.data?.sitemap_url || null;
    const checkedAt = new Date(response.data?.checked_at || Date.now());
    this.logger.log(
      `Sitemap detection for ${source.name}: ${sitemapUrl ? `found ${sitemapUrl}` : 'no usable sitemap'}`,
    );
    return this.prisma.scrapeSource.update({
      where: { id },
      data: {
        sitemapUrl,
        sitemapCheckedAt: checkedAt,
        // A sitemap fast-path makes cheap polling possible — tighten the
        // interval so new notices surface sooner, unless the admin already
        // set a custom cadence.
        ...(sitemapUrl && source.pollIntervalSeconds >= 900
          ? { pollIntervalSeconds: 180 }
          : {}),
      },
    });
  }

  /**
   * Re-run detection for every source currently cached as having no sitemap.
   *
   * Detection runs once and the verdict is cached forever, so a source whose
   * sitemap was unreadable at the time — gzipped `.xml.gz` files parsed as
   * "not XML" until that was fixed, or a portal that happened to be down —
   * is stuck paying for full crawls indefinitely. This clears those verdicts.
   */
  async redetectMissingSitemaps() {
    const candidates = await this.prisma.scrapeSource.findMany({
      where: { sitemapUrl: null, isAdHoc: false },
      select: { id: true, name: true },
    });

    // Detection is up to three 30s probes per source, so doing this inline
    // would hold the admin request open for minutes and time out. Returns
    // immediately; progress lands in the logs and on the source cards.
    void this.runRedetection(candidates);
    return { scheduled: candidates.length };
  }

  /** Bounded-concurrency re-detection, run in the background. */
  private async runRedetection(sources: { id: string; name: string }[]) {
    const CONCURRENCY = 4;
    let found = 0;
    let failed = 0;
    const queue = [...sources];

    const worker = async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        try {
          const updated = await this.detectSitemap(next.id);
          if (updated.sitemapUrl) found++;
        } catch (err: any) {
          failed++;
          this.logger.warn(`Sitemap re-detection failed for ${next.name}: ${err.message}`);
        }
      }
    };

    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    this.logger.log(
      `Sitemap re-detection finished: ${found} found, ${failed} failed, ${sources.length} checked`,
    );
  }

  /**
   * Cheap sitemap poll: asks the AI service for the sitemap's <loc> entries
   * that are not yet known to this source. No crawl4ai/Playwright involved.
   * Returns { sitemap_url, checked_at, new_urls, total_locs }.
   */
  async checkSitemap(id: string) {
    const source = await this.getSource(id);
    if (!source.sitemapUrl) {
      throw new ConflictException('This source has no sitemap URL configured');
    }
    const knownUrls = (
      await this.prisma.scrapedItem.findMany({
        where: { sourceId: id },
        select: { sourceUrl: true },
      })
    ).map((r) => r.sourceUrl);
    const response = await firstValueFrom(
      this.httpService.post(
        `${this.aiServiceUrl}/scrape/check`,
        {
          base_url: source.baseUrl,
          sitemap_url: source.sitemapUrl,
          known_urls: knownUrls,
          // Lets the AI service skip child sitemaps untouched since our last
          // successful poll instead of fetching every one of them.
          since: source.lastRunAt?.toISOString() ?? null,
        },
        { timeout: 30000 },
      ),
    );
    return response.data as {
      sitemap_url: string | null;
      checked_at: string;
      new_urls: string[];
      total_locs: number;
    };
  }

  /**
   * Cheap "anything new?" probe for a source with no usable sitemap: fetches
   * only page 1 of each listing and returns detail URLs not already stored.
   * No detail pages, no OCR, no LLM — comparable in cost to a sitemap check,
   * so HTML-only sources can be polled on a short interval and only pay for
   * a full crawl when something actually appeared.
   */
  async checkListing(id: string) {
    const source = await this.getSource(id);

    const categoryUrls: Record<string, string> = {};
    if (source.noticeListUrl) categoryUrls.NOTICE = source.noticeListUrl;
    if (source.newsListUrl) categoryUrls.NEWS = source.newsListUrl;
    if (source.pressReleaseListUrl) categoryUrls.PRESS_RELEASE = source.pressReleaseListUrl;
    if (Object.keys(categoryUrls).length === 0) {
      throw new ConflictException('This source has no listing URL configured');
    }

    const knownUrls = (
      await this.prisma.scrapedItem.findMany({
        where: { sourceId: id },
        select: { sourceUrl: true },
      })
    ).map((r) => r.sourceUrl);

    const cachedSchemas: Record<string, unknown> = {};
    if (source.noticeSchema) cachedSchemas.NOTICE = source.noticeSchema;
    if (source.newsSchema) cachedSchemas.NEWS = source.newsSchema;
    if (source.pressReleaseSchema) cachedSchemas.PRESS_RELEASE = source.pressReleaseSchema;

    const response = await firstValueFrom(
      this.httpService.post(
        `${this.aiServiceUrl}/scrape/listing/check`,
        {
          base_url: source.baseUrl,
          category_urls: categoryUrls,
          cached_schemas: cachedSchemas,
          known_urls: knownUrls,
          pagination: {
            type: source.paginationType,
            param: source.paginationParam,
            start_page: source.startPage,
          },
        },
        { timeout: 60000 },
      ),
    );
    return response.data as {
      new_urls: string[];
      total_seen: number;
      checked_at: string;
    };
  }

  /** The actual crawl + persistence, run detached from the triggering request. */
  private async executeRun(
    runId: string,
    source: ScrapeSource,
    categories?: ('NOTICE' | 'NEWS' | 'PRESS_RELEASE')[],
  ) {
    try {
      const categoryUrls: Record<string, string> = {};
      const wantedCategories = categories ?? ['NOTICE', 'NEWS', 'PRESS_RELEASE'];
      if (wantedCategories.includes('NOTICE') && source.noticeListUrl) {
        categoryUrls.NOTICE = source.noticeListUrl;
      }
      if (wantedCategories.includes('NEWS') && source.newsListUrl) {
        categoryUrls.NEWS = source.newsListUrl;
      }
      if (wantedCategories.includes('PRESS_RELEASE') && source.pressReleaseListUrl) {
        categoryUrls.PRESS_RELEASE = source.pressReleaseListUrl;
      }
      if (Object.keys(categoryUrls).length === 0) {
        throw new ConflictException(
          'This source has no listing URL configured for the requested categories',
        );
      }

      const knownUrls = (
        await this.prisma.scrapedItem.findMany({
          where: { sourceId: source.id },
          select: { sourceUrl: true },
        })
      ).map((r) => r.sourceUrl);

      // Admin-tunable (SettingsService) — how many items the AI service may
      // summarize in parallel. Read per-run so an admin change applies on the
      // next poll without a restart.
      const summarizeConcurrency = await this.settings.getNumber(
        'scraping.summarizeConcurrency',
        2,
      );

      const cachedSchemas: Record<string, unknown> = {};
      if (source.noticeSchema) cachedSchemas.NOTICE = source.noticeSchema;
      if (source.newsSchema) cachedSchemas.NEWS = source.newsSchema;
      if (source.pressReleaseSchema) cachedSchemas.PRESS_RELEASE = source.pressReleaseSchema;

      const response = await firstValueFrom(
        this.httpService.post(
          `${this.aiServiceUrl}/scrape/source`,
          {
            base_url: source.baseUrl,
            category_urls: categoryUrls,
            cached_schemas: cachedSchemas,
            known_urls: knownUrls,
            max_pages: source.maxPages,
            summarize_concurrency: summarizeConcurrency,
            run_id: runId,
            pagination: {
              type: source.paginationType,
              param: source.paginationParam,
              start_page: source.startPage,
            },
          },
          { timeout: 600000 },
        ),
      );

      const items: RawScrapedItem[] = response.data.items ?? [];
      const schemas: Record<string, unknown> = response.data.schemas ?? {};
      const failedUrls: ScrapeFailure[] = response.data.failed_urls ?? [];

      // Listing crawl produced nothing but a sitemap exists — some sites'
      // category URLs 404 while the sitemap stays healthy (mohp.gov.np).
      // Fall back to crawling the sitemap's new URLs directly so a manual
      // "Run now" still yields data for these sources.
      if (items.length === 0 && source.sitemapUrl) {
        this.logger.log(
          `Listing crawl for ${source.name} yielded 0 items; falling back to sitemap URLs`,
        );
        const check = await this.checkSitemap(source.id);
        const newUrls: string[] = check.new_urls ?? [];
        if (newUrls.length) {
          const sitemapResponse = await firstValueFrom(
            this.httpService.post(
              `${this.aiServiceUrl}/scrape/sitemap-crawl`,
              {
                base_url: source.baseUrl,
                urls: newUrls,
                known_urls: knownUrls,
                summarize_concurrency: summarizeConcurrency,
                run_id: runId,
              },
              { timeout: 600000 },
            ),
          );
          const sitemapItems: RawScrapedItem[] = sitemapResponse.data.items ?? [];
          const sitemapFailures: ScrapeFailure[] = sitemapResponse.data.failed_urls ?? [];
          failedUrls.push(...sitemapFailures);
          if (sitemapItems.length) {
            const freshIds = await this.persistItems(runId, source, sitemapItems, schemas, failedUrls);
            if (freshIds.length) {
              this.embedNewNotices(source.id, freshIds).catch((err: any) => {
                this.logger.warn(`Background embedding failed: ${err.message}`);
              });
            }
            return;
          }
        }
      }

      const freshIds = await this.persistItems(runId, source, items, schemas, failedUrls);

      // Embed newly summarized notices into vector store (fire-and-forget)
      if (freshIds.length) {
        this.embedNewNotices(source.id, freshIds).catch((err: any) => {
          this.logger.warn(`Background embedding failed: ${err.message}`);
        });
      }
    } catch (err: any) {
      // No per-URL detail available here — the AI service call itself failed
      // (network error, timeout, non-2xx before any page was even crawled),
      // so there's nothing more granular than the one error message.
      const message = err.response?.data?.error ?? err.message;
      this.logger.error(`Scrape run failed for source ${source.id}: ${message}`);
      await this.prisma.scrapeRun.update({
        where: { id: runId },
        data: {
          status: ScrapeRunStatus.FAILED,
          error: message,
          finishedAt: new Date(),
        },
      });
      await this.prisma.scrapeSource.update({
        where: { id: source.id },
        data: {
          lastRunAt: new Date(),
          lastStatus: ScrapeRunStatus.FAILED,
          lastError: message,
          lastFailedUrls: Prisma.JsonNull,
        },
      });
    }
  }

  /**
   * Execution path for runSourceFromUrls: POST the sitemap's new URLs to the
   * AI service's /scrape/sitemap-crawl, then persist items through the exact
   * same dedup/attachment/summarize pipeline as a listing crawl (share code
   * via a private persistItems helper).
   */
  private async executeRunFromUrls(
    runId: string,
    source: ScrapeSource,
    urls: string[],
  ) {
    try {
      const knownUrls = (
        await this.prisma.scrapedItem.findMany({
          where: { sourceId: source.id },
          select: { sourceUrl: true },
        })
      ).map((r) => r.sourceUrl);

      const summarizeConcurrency = await this.settings.getNumber(
        'scraping.summarizeConcurrency',
        2,
      );

      const response = await firstValueFrom(
        this.httpService.post(
          `${this.aiServiceUrl}/scrape/sitemap-crawl`,
          {
            base_url: source.baseUrl,
            urls,
            known_urls: knownUrls,
            summarize_concurrency: summarizeConcurrency,
            run_id: runId,
          },
          { timeout: 600000 },
        ),
      );

      const items: RawScrapedItem[] = response.data.items ?? [];
      const failedUrls: ScrapeFailure[] = response.data.failed_urls ?? [];
      const freshIds = await this.persistItems(runId, source, items, {}, failedUrls);

      // Embed newly summarized notices into vector store (fire-and-forget)
      if (freshIds.length) {
        this.embedNewNotices(source.id, freshIds).catch((err: any) => {
          this.logger.warn(`Background embedding failed: ${err.message}`);
        });
      }
    } catch (err: any) {
      const message = err.response?.data?.error ?? err.message;
      this.logger.error(`Sitemap scrape run failed for source ${source.id}: ${message}`);
      await this.prisma.scrapeRun.update({
        where: { id: runId },
        data: {
          status: ScrapeRunStatus.FAILED,
          error: message,
          finishedAt: new Date(),
        },
      });
      await this.prisma.scrapeSource.update({
        where: { id: source.id },
        data: {
          lastRunAt: new Date(),
          lastStatus: ScrapeRunStatus.FAILED,
          lastError: message,
          lastFailedUrls: Prisma.JsonNull,
        },
      });
    }
  }

  /**
   * Shared persistence pipeline for both crawl modes (listing and sitemap):
   * dedup against existing items, create/update rows + attachments,
   * trigger PDF extraction / LLM analysis where needed, record run and
   * source status. `schemas` is only saved to the source by the listing
   * crawl; the sitemap crawl passes an empty object. Returns the IDs of
   * notices that received a fresh AI summary this run — callers embed only
   * those into the vector store instead of re-embedding the whole corpus.
   */
  /**
   * Whether a scraped row deserves a catalogue entry.
   *
   * This product aggregates one thing: notices, news and press releases
   * published by government bodies. A row with no real title is markup the
   * extractor misread — navigation, a "read more" link, a category index —
   * and storing it is what produced pages of "(untitled) / Other / —".
   */
  private isStorableItem(item: { title?: string | null; source_url?: string | null }): boolean {
    if (!item?.source_url) return false;

    const title = (item.title ?? '').replace(/\s+/g, ' ').trim();
    if (title.length < 8) return false;
    if (/^\(?untitled\)?$/i.test(title)) return false;

    // Must contain real words in either script, not just digits/punctuation.
    // U+0904-U+097F covers Devanagari letters (Nepali script) — deliberately
    // starting at U+0904 (अ, the first actual letter) rather than U+0900:
    // U+0900-U+0903 are combining signs/marks, not letters, and using one as
    // a character-class range boundary is exactly what eslint's
    // no-misleading-character-class rule (rightly) rejects.
    const letters = title.match(/[A-Za-z\u0904-\u097F]/g)?.length ?? 0;
    return letters >= 5;
  }

  /**
   * Find (and optionally delete) catalogue rows that are not real notices —
   * the "(untitled)" placeholders stored before admission control existed.
   *
   * Dry run by default: deletion is irreversible, so the caller must ask for
   * it explicitly after seeing the count and a sample.
   */
  async cleanupJunkItems(opts: { deleteThem?: boolean; limit?: number } = {}) {
    const limit = Math.min(Math.max(1, opts.limit ?? 5000), 20000);

    // Cheap pre-filter in SQL (short or literally "(untitled)"), then apply
    // the same predicate used on ingest so the two can never disagree.
    const candidates = await this.prisma.scrapedItem.findMany({
      where: { OR: [{ title: { contains: 'untitled' } }, { title: '' }] },
      select: { id: true, title: true, sourceUrl: true, sourceLabel: true },
      take: limit,
    });
    const junk = candidates.filter(
      (row) => !this.isStorableItem({ title: row.title, source_url: row.sourceUrl }),
    );

    if (!opts.deleteThem) {
      return {
        deleted: 0,
        found: junk.length,
        dryRun: true,
        sample: junk.slice(0, 5).map((r) => ({ title: r.title, source: r.sourceLabel })),
        message:
          junk.length > 0
            ? `${junk.length} unusable row(s) found. Re-run with deleteThem=true to remove them.`
            : 'No unusable rows found.',
      };
    }

    const junkIds = junk.map((r) => r.id);
    const result = await this.prisma.scrapedItem.deleteMany({
      where: { id: { in: junkIds } },
    });
    await this.unembedNotices(junkIds);
    this.logger.warn(`Admin cleanup deleted ${result.count} unusable scraped row(s)`);
    return {
      deleted: result.count,
      found: junk.length,
      dryRun: false,
      sample: [],
      message: `Deleted ${result.count} unusable row(s).`,
    };
  }

  private async persistItems(
    runId: string,
    source: ScrapeSource,
    items: RawScrapedItem[],
    schemas: Record<string, unknown>,
    failedUrls: ScrapeFailure[] = [],
  ): Promise<string[]> {
    /* eslint-disable-next-line no-param-reassign */
    // Defence in depth: the scraper already rejects non-notice rows, but a
    // regression there must never refill the catalogue with "(untitled)"
    // placeholders. Filtering here also keeps rejected rows out of the
    // existence lookup below, so they cost no database work at all.
    const rejected = items.filter((item) => !this.isStorableItem(item));
    if (rejected.length > 0) {
      this.logger.warn(
        `Discarded ${rejected.length} unusable scraped row(s) (no usable title): ` +
          rejected.slice(0, 3).map((i) => i.source_url).join(', '),
      );
      items = items.filter((item) => this.isStorableItem(item));
    }

    // One batch lookup instead of one findUnique per item — the dedup
    // check itself shouldn't be N database round-trips.
    const existingItems = await this.prisma.scrapedItem.findMany({
      where: { sourceUrl: { in: items.map((i) => i.source_url) } },
    });
    const existingByUrl = new Map(existingItems.map((i) => [i.sourceUrl, i]));

    let itemsNew = 0;
    let itemsUpdated = 0;
    let itemsSkipped = 0;
    let itemsSummarized = 0;
    let itemsSummaryFailed = 0;
    const freshlySummarizedIds: string[] = [];

    const validCategories = new Set([
      'NOTICE', 'NEWS', 'PRESS_RELEASE', 'CIRCULAR', 'TENDER', 'VACANCY', 'JOB', 'INTERNSHIP', 'OTHER',
    ]);

    for (const item of items) {
      const contentHash = crypto
        .createHash('sha256')
        .update(`${item.title}|${item.content_text ?? ''}`)
        .digest('hex');

      const resolvedCategory = validCategories.has(item.category)
        ? (item.category as ScrapedItemCategory)
        : ScrapedItemCategory.OTHER;

      // Track AI summarization status from the Python service
      if (item.ai_summary) {
        itemsSummarized++;
      } else if (item.content_text) {
        itemsSummaryFailed++;
      }

      const existing = existingByUrl.get(item.source_url);

      // A content hash is only meaningful when the item's detail page was
      // actually re-fetched this run. Known URLs are skipped by the scraper
      // (`fetch_detail` only runs for unknown URLs), so `content_text` is
      // null for them — hashing `title|` against the stored `title|content`
      // would always differ and rewrite every row + its attachments on every
      // poll. Only run the content-changed path on fresh content.
      const hasFreshContent = item.content_text != null || item.content_html != null;

      if (!existing) {
        const created = await this.prisma.scrapedItem.create({
          data: {
            sourceId: source.id,
            sourceLabel: source.name,
            category: resolvedCategory,
            sourceSlug: item.source_slug,
            title: item.title,
            sourceUrl: item.source_url,
            summary: item.summary,
            contentText: item.content_text,
            contentHtml: item.content_html,
            attachmentUrl: item.attachment_url,
            publishedAt: item.published_at ? new Date(item.published_at) : null,
            contentHash,
            aiSummary: item.ai_summary,
            aiSummaryNe: item.ai_summary_ne,
            aiUrgency: item.ai_urgency,
            aiCategoryConfidence: item.ai_category_confidence,
            metadata: item.metadata ? (item.metadata as Prisma.InputJsonValue) : undefined,
            aiAnalyzedAt: item.ai_summary ? new Date() : null,
          },
        });
        itemsNew++;
        if (item.ai_summary) freshlySummarizedIds.push(created.id);

        // Queue for alert matching — synchronous, cannot throw, never blocks
        // or slows the scrape loop. Processed one at a time in the
        // background so a burst of new items can't flood the DB/WhatsApp
        // API with concurrent requests (see AlertMatchingService.enqueue).
        this.alertMatching.enqueue(created);

        // Create attachment records
        if (item.attachments?.length) {
          await this.prisma.attachment.createMany({
            data: item.attachments.map((att) => ({
              itemId: created.id,
              url: att.url,
              label: att.label,
              mimeType: att.mime_type,
              sizeBytes: att.size_bytes,
            })),
          });
        }

        // PDF-only notices: extract content via OCR at scrape time
        if (!item.content_text && !item.ai_summary) {
          const pdfUrl = this.findPdfUrl(item.attachment_url, item.attachments);
          if (pdfUrl) {
            const summarized = await this.extractPdfForNotice(created.id, item.title, pdfUrl);
            if (summarized) freshlySummarizedIds.push(created.id);
          }
        }

        // Fallback: if AI service didn't summarize but has text, analyze now
        if (!item.ai_summary && item.content_text) {
          const summarized = await this.analyzeNotice(created.id, item.title, item.content_text);
          if (summarized) freshlySummarizedIds.push(created.id);
        }
      } else if (hasFreshContent && existing.contentHash !== contentHash) {
        await this.prisma.scrapedItem.update({
          where: { id: existing.id },
          data: {
            title: item.title,
            category: resolvedCategory,
            sourceSlug: item.source_slug,
            summary: item.summary,
            contentText: item.content_text ?? existing.contentText,
            contentHtml: item.content_html ?? existing.contentHtml,
            attachmentUrl: item.attachment_url,
            publishedAt: item.published_at ? new Date(item.published_at) : existing.publishedAt,
            contentHash,
            aiSummary: item.ai_summary ?? existing.aiSummary,
            aiSummaryNe: item.ai_summary_ne ?? existing.aiSummaryNe,
            aiUrgency: item.ai_urgency ?? existing.aiUrgency,
            aiCategoryConfidence: item.ai_category_confidence,
            metadata: item.metadata ? (item.metadata as Prisma.InputJsonValue) : undefined,
            aiAnalyzedAt: item.ai_summary ? new Date() : existing.aiAnalyzedAt,
          },
        });
        itemsUpdated++;
        if (item.ai_summary) freshlySummarizedIds.push(existing.id);
        if (item.attachments?.length) {
          await this.prisma.attachment.deleteMany({ where: { itemId: existing.id } });
          await this.prisma.attachment.createMany({
            data: item.attachments.map((att) => ({
              itemId: existing.id,
              url: att.url,
              label: att.label,
              mimeType: att.mime_type,
              sizeBytes: att.size_bytes,
            })),
          });
        }
      } else if (item.attachment_url && existing.attachmentUrl !== item.attachment_url) {
        await this.prisma.scrapedItem.update({
          where: { id: existing.id },
          data: { attachmentUrl: item.attachment_url },
        });
        itemsUpdated++;
      } else {
        itemsSkipped++;
      }
    }

    // A run that fetched nothing at all — every listing/detail page it tried
    // errored — is a failure, not "nothing new today". Without this check
    // it silently reports SUCCESS with itemsFound: 0, which is exactly what
    // made MOFA/NRB-style outages invisible: the source card just showed
    // "0 items scraped" forever with no failed/error signal anywhere.
    // Only real failures count toward this. `failedUrls` also carries
    // deliberate skips (already-scraped, non-article URLs, untitled rows) so
    // an admin can audit them — but a run that found nothing because
    // everything was already scraped is a healthy no-op, not an outage.
    const hardFailures = failedUrls.filter((f) => (f.outcome ?? 'failed') === 'failed');
    const allAttemptsFailed = items.length === 0 && hardFailures.length > 0;
    const status = allAttemptsFailed ? ScrapeRunStatus.FAILED : ScrapeRunStatus.SUCCESS;
    const aggregateError = allAttemptsFailed
      ? `All ${hardFailures.length} page(s)/URL(s) failed to load — ${hardFailures[0].stage}: ${hardFailures[0].error}` +
        (hardFailures.length > 1 ? ` (+${hardFailures.length - 1} more)` : '')
      : null;

    await this.prisma.scrapeRun.update({
      where: { id: runId },
      data: {
        status,
        itemsFound: items.length,
        itemsNew,
        itemsUpdated,
        itemsSkipped,
        itemsSummarized,
        itemsSummaryFailed,
        error: aggregateError,
        failedUrls: failedUrls.length ? (failedUrls as unknown as Prisma.InputJsonValue) : Prisma.JsonNull,
        finishedAt: new Date(),
      },
    });

    await this.prisma.scrapeSource.update({
      where: { id: source.id },
      data: {
        lastRunAt: new Date(),
        lastStatus: status,
        lastError: aggregateError,
        lastFailedUrls: failedUrls.length ? (failedUrls as unknown as Prisma.InputJsonValue) : Prisma.JsonNull,
        ...(schemas.NOTICE ? { noticeSchema: schemas.NOTICE as Prisma.InputJsonValue } : {}),
        ...(schemas.NEWS ? { newsSchema: schemas.NEWS as Prisma.InputJsonValue } : {}),
        ...(schemas.PRESS_RELEASE ? { pressReleaseSchema: schemas.PRESS_RELEASE as Prisma.InputJsonValue } : {}),
      },
    });

    return freshlySummarizedIds;
  }

  /**
   * Send notices with aiSummary to the AI service for vector embedding.
   * Only the items that actually received a fresh summary this run are
   * embedded (they arrive with `aiSummary` from the scrape). This avoids
   * re-embedding the whole corpus on every poll — previously the first
   * arbitrary 200 summarized notices were re-sent each run and nothing
   * beyond them ever made it into the vector store.
   */
  private async embedNewNotices(sourceId: string, ids?: string[]) {
    const notices = await this.prisma.scrapedItem.findMany({
      // Requiring an AI summary kept 51% of the catalogue out of the vector
      // store entirely — those notices have a body, so they are searchable and
      // answerable; only ones with neither summary nor body are not.
      where: ids?.length
        ? { id: { in: ids } }
        : {
            sourceId,
            OR: [{ aiSummary: { not: null } }, { contentText: { not: null } }],
          },
      select: {
        id: true,
        title: true,
        aiSummary: true,
        contentText: true,
        category: true,
        sourceLabel: true,
        sourceUrl: true,
        publishedAt: true,
      },
      take: 200,
    });

    if (!notices.length) return;

    const payload = notices.map((n) => ({
      id: n.id,
      title: n.title,
      ai_summary: n.aiSummary || '',
      // Most notices never get an AI summary, so the body is what makes them
      // findable and answerable at all. Capped here rather than in the AI
      // service so a 1.4MB notice doesn't become a 1.4MB HTTP payload.
      content: (n.contentText || '').slice(0, 4000),
      category: n.category,
      source_label: n.sourceLabel,
      source_url: n.sourceUrl,
      published_at: n.publishedAt?.toISOString() || null,
    }));

    try {
      await firstValueFrom(
        this.httpService.post(
          `${this.aiServiceUrl}/notices/embed`,
          { notices: payload },
          { timeout: 120000 },
        ),
      );
      this.logger.log(`Embedded ${notices.length} notices into vector store`);
    } catch (err: any) {
      this.logger.warn(`Notice embedding request failed: ${err.message}`);
    }
  }

  /**
   * Summarize and embed notices that never got an AI summary.
   *
   * Only notices with an `aiSummary` are embedded, so every notice the scrape
   * stored while the LLM was unavailable is invisible to RAG — the chat can
   * neither find nor cite it. This re-runs analysis for those and indexes
   * whatever gets a summary. Returns as soon as the work is queued.
   */
  async backfillSummaries(opts: { limit?: number; concurrency?: number } = {}) {
    const limit = Math.min(Math.max(1, opts.limit ?? 500), 5000);
    const concurrency = Math.min(Math.max(1, opts.concurrency ?? 2), 8);

    const pending = await this.prisma.scrapedItem.findMany({
      where: { aiSummary: null, contentText: { not: null } },
      select: { id: true, title: true, contentText: true },
      orderBy: { publishedAt: 'desc' },
      take: limit,
    });

    if (!pending.length) {
      return { queued: 0, message: 'No notices need summarizing.' };
    }

    void this.runSummaryBackfill(pending, concurrency);
    return {
      queued: pending.length,
      message: `Summarizing ${pending.length} notice(s) in the background; they are embedded as they complete.`,
    };
  }

  /** Worker pool for backfillSummaries — newest notices first, then embed. */
  private async runSummaryBackfill(
    items: { id: string; title: string; contentText: string | null }[],
    concurrency: number,
  ) {
    let cursor = 0;
    const summarized: string[] = [];

    const worker = async () => {
      while (cursor < items.length) {
        const item = items[cursor++];
        try {
          const ok = await this.analyzeNotice(item.id, item.title, item.contentText ?? '');
          if (ok) summarized.push(item.id);
        } catch (err: any) {
          this.logger.warn(`Backfill failed for notice ${item.id}: ${err.message}`);
        }
      }
    };

    await Promise.all(Array.from({ length: concurrency }, worker));

    // embedNewNotices caps each request at 200 notices.
    for (let i = 0; i < summarized.length; i += 200) {
      await this.embedNewNotices('', summarized.slice(i, i + 200));
    }
    this.logger.log(
      `Summary backfill finished: ${summarized.length}/${items.length} notice(s) summarized and embedded`,
    );
  }

  /** Pre-analyze a notice via the AI service and cache results in the DB. */
  /** Returns true when a summary was persisted (i.e. this notice should be embedded). */
  private async analyzeNotice(id: string, title: string, content: string): Promise<boolean> {
    try {
      const response = await firstValueFrom(
        this.httpService.post(
          `${this.aiServiceUrl}/notices/analyze`,
          { title, content },
          { timeout: 30000 },
        ),
      );
      if (response.data?.analyzed) {
        await this.prisma.scrapedItem.update({
          where: { id },
          data: {
            aiSummary: response.data.summary,
            keyFacts: response.data.key_facts ?? [],
            tags: response.data.tags ?? [],
            aiAnalyzedAt: new Date(),
          },
        });
        return true;
      }
      await this.prisma.scrapedItem.update({
        where: { id },
        data: { aiAnalyzedAt: new Date() },
      });
      return false;
    } catch (err: any) {
      this.logger.warn(`Pre-analysis failed for notice ${id}: ${err.message}`);
      return false;
    }
  }

  // Scanned notices are just as often a photographed/screenshotted image
  // (JPG, PNG) as a PDF — both are OCR-able via the same AI service route.
  private static readonly IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tif', '.tiff'];

  private isExtractableUrl(url: string | null | undefined, mimeType?: string | null): boolean {
    if (!url) return false;
    const lower = url.toLowerCase().split('?')[0].split('#')[0];
    if (mimeType?.includes('pdf') || lower.endsWith('.pdf')) return true;
    if (mimeType?.startsWith('image/')) return true;
    return ScrapingService.IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext));
  }

  private findPdfUrl(
    attachmentUrl: string | null,
    attachments: RawAttachment[],
  ): string | null {
    const match = attachments?.find((a) => this.isExtractableUrl(a.url, a.mime_type));
    if (match) return match.url;
    if (this.isExtractableUrl(attachmentUrl)) return attachmentUrl;
    if (attachmentUrl?.includes('pdf')) return attachmentUrl;
    return null;
  }

  /** Returns true when a summary was persisted (i.e. this notice should be embedded). */
  private async extractPdfForNotice(id: string, title: string, pdfUrl: string): Promise<boolean> {
    try {
      const response = await firstValueFrom(
        this.httpService.post(
          `${this.aiServiceUrl}/notices/extract-pdf`,
          { url: pdfUrl, title },
          { timeout: 90000 },
        ),
      );
      if (!response.data?.content_text) return false;

      // The AI service scores how plausible the extracted text is (see
      // extractor._text_quality). A legacy Nepali font (Preeti and friends)
      // decodes to confident-looking symbol noise — `S Ñ ! ."$% &'( )*(` —
      // which is worse than having no text at all: it renders as garbage on
      // the notice page, pollutes the RAG index, and gets echoed back as
      // "answers" by the chatbot. Keep the AI summary (the LLM reads the
      // rendered pages, so it stays usable) but don't persist the body text.
      const quality: number | undefined =
        typeof response.data.quality === 'number' ? response.data.quality : undefined;
      const usableText = quality === undefined || quality >= EXTRACTION_QUALITY_FLOOR;
      if (!usableText) {
        this.logger.warn(
          `Discarding unreadable PDF text for notice ${id} ` +
            `(quality ${quality!.toFixed(2)} < ${EXTRACTION_QUALITY_FLOOR}, method=${response.data.method ?? 'unknown'})`,
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
      }

      await this.prisma.scrapedItem.update({ where: { id }, data });
      this.logger.log(`PDF extracted and cached for notice ${id}`);
      return Boolean(response.data.summary);
    } catch (err: any) {
      this.logger.warn(`PDF extraction at scrape time failed for ${id}: ${err.message}`);
      return false;
    }
  }

  /** Proxy live status messages from the AI service for a run in progress. */
  async getRunProgress(runId: string) {
    try {
      const response = await firstValueFrom(
        this.httpService.get(`${this.aiServiceUrl}/scrape/progress/${runId}`, {
          timeout: 5000,
        }),
      );
      return response.data;
    } catch {
      return { run_id: runId, stage: null, messages: [] };
    }
  }

  // --- Read ---

  async listItems(filters: {
    sourceId?: string;
    category?: 'NOTICE' | 'NEWS';
    search?: string;
    dateFrom?: string;
    dateTo?: string;
    sortBy?: 'publishedAt' | 'scrapedAt' | 'title';
    sortOrder?: 'asc' | 'desc';
    page?: number;
    limit?: number;
  }) {
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 20;
    const sortBy = filters.sortBy ?? 'publishedAt';
    const sortOrder = filters.sortOrder ?? 'desc';

    const publishedAtFilter: Prisma.DateTimeFilter = {};
    if (filters.dateFrom) publishedAtFilter.gte = new Date(filters.dateFrom);
    if (filters.dateTo) publishedAtFilter.lte = new Date(filters.dateTo);

    const where: Prisma.ScrapedItemWhereInput = {
      ...(filters.sourceId ? { sourceId: filters.sourceId } : {}),
      ...(filters.category ? { category: filters.category as ScrapedItemCategory } : {}),
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
    };
    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
      this.prisma.scrapedItem.findMany({
        where,
        orderBy: { [sortBy]: sortOrder },
        skip,
        take: limit,
      }),
      this.prisma.scrapedItem.count({ where }),
    ]);

    return { data, meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }

  async deleteItem(id: string) {
    const item = await this.prisma.scrapedItem.findUnique({ where: { id } });
    if (!item) throw new NotFoundException(`Scraped item ${id} not found`);
    await this.prisma.scrapedItem.delete({ where: { id } });
    await this.unembedNotices([id]);
    return { deleted: true };
  }

  /**
   * Drop notices from the vector store. Deleting the row alone left the vector
   * behind, so a removed notice kept surfacing as a RAG citation.
   */
  private async unembedNotices(ids: string[]) {
    if (!ids.length) return;
    try {
      await firstValueFrom(
        this.httpService.post(
          `${this.aiServiceUrl}/notices/delete`,
          { ids },
          { timeout: 30000 },
        ),
      );
      this.logger.log(`Removed ${ids.length} notice(s) from vector store`);
    } catch (err: any) {
      this.logger.warn(`Notice un-embedding request failed: ${err.message}`);
    }
  }

  async updateNotice(id: string, data: { category?: string; tags?: string[]; aiCategoryConfidence?: number }) {
    const item = await this.prisma.scrapedItem.findUnique({ where: { id } });
    if (!item) throw new NotFoundException(`Scraped item ${id} not found`);
    const updateData: any = {};
    if (data.category) updateData.category = data.category as any;
    if (data.tags !== undefined) updateData.tags = data.tags;
    if (data.aiCategoryConfidence !== undefined) updateData.aiCategoryConfidence = data.aiCategoryConfidence;
    return this.prisma.scrapedItem.update({
      where: { id },
      data: updateData,
    });
  }

  /**
   * Re-run full AI analysis on an existing notice (contentText required).
   * Legacy/PDF-only notices may not have contentText yet if the extraction
   * pipeline hasn't visited them — attempt an on-demand extraction from the
   * attachment before giving up, same as the lazy path in NoticesService.
   */
  async reClassifyNotice(id: string) {
    let item = await this.prisma.scrapedItem.findUnique({
      where: { id },
      include: { attachments: true },
    });
    if (!item) throw new NotFoundException(`Scraped item ${id} not found`);

    if (!item.contentText) {
      const attachmentUrl = this.findPdfUrl(
        item.attachmentUrl,
        item.attachments.map((a) => ({
          url: a.url,
          mime_type: a.mimeType,
          label: a.label,
          size_bytes: a.sizeBytes,
        })),
      );
      if (attachmentUrl) {
        await this.extractPdfForNotice(id, item.title, attachmentUrl);
        item = await this.prisma.scrapedItem.findUnique({ where: { id }, include: { attachments: true } });
      }
    }

    if (!item?.contentText) {
      throw new BadRequestException('Notice has no contentText to re-classify');
    }
    // Delegate to the AI service's analyze endpoint; it will run classification + summary
    const response = await firstValueFrom(
      this.httpService.post(
        `${this.aiServiceUrl}/notices/analyze`,
        { title: item.title, content: item.contentText },
        { timeout: 30000 },
      ),
    );
    if (!response.data?.analyzed) {
      return { reClassified: false, reason: 'AI analysis returned no result' };
    }
    const data: any = {
      aiSummary: response.data.summary,
      aiSummaryNe: response.data.summary_ne ?? null,
      keyFacts: response.data.key_facts ?? [],
      tags: response.data.tags ?? [],
      aiCategoryConfidence: response.data.category_confidence ?? null,
      category: response.data.category ?? undefined,
      aiAnalyzedAt: new Date(),
    };
    await this.prisma.scrapedItem.update({ where: { id }, data });
    return { reClassified: true, ...data };
  }

  async listRuns(filters: {
    sourceId?: string;
    status?: ScrapeRunStatus;
    page?: number;
    limit?: number;
  }) {
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 20;
    const where: Prisma.ScrapeRunWhereInput = {
      ...(filters.sourceId ? { sourceId: filters.sourceId } : {}),
      ...(filters.status ? { status: filters.status } : {}),
    };
    const [data, total] = await Promise.all([
      this.prisma.scrapeRun.findMany({
        where,
        orderBy: { startedAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.scrapeRun.count({ where }),
    ]);
    return { data, meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }
}
