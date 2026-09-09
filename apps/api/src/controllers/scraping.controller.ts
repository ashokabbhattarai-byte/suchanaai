import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  ParseUUIDPipe,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { Role, ScrapeRunStatus } from '@prisma/client';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { RolesGuard } from '../guards/roles.guard';
import { Roles } from '../decorators/roles.decorator';
import { ScrapingService } from '../services/scraping.service';
import { ScrapingSchedulerService } from '../services/scraping-scheduler.service';
import { NoticesService } from '../services/notices.service';
import {
  CreateScrapeSourceDto,
  UpdateScrapeSourceDto,
  QuickScrapeDto,
  DiscoverRoutesDto,
} from '../dto/scrape-source.dto';
import { ScrapedItemCategory } from '@prisma/client';

@Controller('admin/scraping')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.admin)
export class ScrapingController {
  constructor(
    private readonly scrapingService: ScrapingService,
    private readonly scheduler: ScrapingSchedulerService,
    private readonly noticesService: NoticesService,
  ) {}

  /** Effective scheduler configuration + last tick, for the admin UI. */
  @Get('scheduler')
  async schedulerStatus() {
    return this.scheduler.getSchedulerStatus();
  }

  /** Global on/off switch for automatic scraping. Manual runs are unaffected. */
  @Patch('scheduler/auto-scraping')
  async setAutoScraping(@Body('enabled') enabled?: boolean) {
    if (typeof enabled !== 'boolean') {
      throw new BadRequestException('enabled must be a boolean');
    }
    await this.scheduler.setAutoScraping(enabled);
    return this.scheduler.getSchedulerStatus();
  }

  /** Bulk trigger: runs every enabled source that isn't already scraping.
   * `deep: true` makes each run walk every listing page instead of the newest few. */
  @Post('sources/run-all')
  async runAllSources(
    @Body('categories') categories?: ('NOTICE' | 'NEWS' | 'PRESS_RELEASE')[],
    @Body('deep') deep?: boolean,
  ) {
    return this.scrapingService.runAllSources(categories, deep === true);
  }

  @Get('sources')
  async listSources() {
    return this.scrapingService.listSources();
  }

  /**
   * Admin "paste a link" quick-scrape: ingest one arbitrary notice/news/
   * press-release URL directly, with no Source pre-configuration required.
   * Reuses an existing Source for the URL's domain if one exists, otherwise
   * auto-creates a minimal ad-hoc one (see ScrapingService.quickScrape).
   */
  @Post('quick-scrape')
  async quickScrape(@Body() dto: QuickScrapeDto) {
    return this.scrapingService.quickScrape(dto.url);
  }

  @Post('sources')
  async createSource(@Body() dto: CreateScrapeSourceDto) {
    return this.scrapingService.createSource(dto);
  }

  @Patch('sources/:id')
  async updateSource(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateScrapeSourceDto,
  ) {
    return this.scrapingService.updateSource(id, dto);
  }

  @Delete('sources/:id')
  async deleteSource(@Param('id', ParseUUIDPipe) id: string) {
    return this.scrapingService.deleteSource(id);
  }

  /** `deep: true` crawls every page of each listing (archive backfill) rather
   * than the newest `maxPages`, and does not stop on a page of known items. */
  @Post('sources/:id/run')
  async runSource(
    @Param('id', ParseUUIDPipe) id: string,
    @Body('categories') categories?: ('NOTICE' | 'NEWS')[],
    @Body('deep') deep?: boolean,
  ) {
    return this.scrapingService.runSource(id, categories, deep === true);
  }

  /**
   * Find a site's real notice/news/press-release listing routes from its own
   * navigation, and prove each one by crawling it. Lets the admin paste a
   * home page instead of hunting for the right listing URL.
   */
  @Post('discover-routes')
  async discoverRoutes(@Body() dto: DiscoverRoutesDto) {
    return this.scrapingService.discoverRoutes(dto.baseUrl);
  }

  /**
   * Explain this source's most recent failure and what to change about it,
   * on demand — the same analysis a failed run records automatically.
   */
  @Post('sources/:id/diagnose')
  async diagnoseSource(@Param('id', ParseUUIDPipe) id: string) {
    return this.scrapingService.diagnoseSource(id);
  }

  /** Re-detect sitemaps for every source currently cached as having none. */
  @Post('sources/redetect-sitemaps')
  async redetectSitemaps() {
    return this.scrapingService.redetectMissingSitemaps();
  }

  /** One-time sitemap detection (robots.txt → sitemap.xml → best child).
   * Persists the cached sitemap URL on the source; safe to call again. */
  @Post('sources/:id/detect-sitemap')
  async detectSitemap(@Param('id', ParseUUIDPipe) id: string) {
    return this.scrapingService.detectSitemap(id);
  }

  /** Cheap sitemap poll — returns the sitemap's URLs not yet known to this
   * source, without triggering a full crawl. */
  @Post('sources/:id/check')
  async checkSitemap(@Param('id', ParseUUIDPipe) id: string) {
    return this.scrapingService.checkSitemap(id);
  }

  @Get('items')
  async listItems(
    @Query('sourceId') sourceId?: string,
    @Query('category') category?: 'NOTICE' | 'NEWS',
    @Query('search') search?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
    @Query('sortBy') sortBy?: 'publishedAt' | 'scrapedAt' | 'title',
    @Query('sortOrder') sortOrder?: 'asc' | 'desc',
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.scrapingService.listItems({
      sourceId,
      category,
      search,
      dateFrom,
      dateTo,
      sortBy,
      sortOrder,
      page: Math.max(1, parseInt(page ?? '1', 10) || 1),
      limit: Math.min(100, Math.max(1, parseInt(limit ?? '20', 10) || 20)),
    });
  }

  @Delete('items/:id')
  async deleteItem(@Param('id', ParseUUIDPipe) id: string) {
    return this.scrapingService.deleteItem(id);
  }

  /**
   * Full pipeline health: how many notices are clean / messy / broken.
   * Scans the entire catalogue dynamically (cursor pagination), so it stays
   * accurate as the corpus grows past 2800. No side effects.
   */
  @Get('items/extraction-health')
  async extractionHealth() {
    return this.noticesService.getExtractionHealth();
  }

  /**
   * Re-run attachment text extraction in the background — now dynamic.
   * - No hard 200 cap: when `limit` is omitted, scans the whole catalogue.
   * - Differentiates clean / messy / broken and only queues fixable ones.
   * - Scopes: garbled (messy+broken, default), messy, broken, all.
   * - Bounded concurrency (2 → 1 if AI warming/queue full), returns immediately; work continues in background.
   * - Rate-limited: 500ms every 10 items + health check before next batch to avoid CPU spike on 2 vCPU t3.medium.
   * - Progress: poll GET items/reextract/progress/:jobId (or list) for live percent.
   */
  @Post('items/reextract')
  async reextractItems(
    @Body('scope') scope?: 'garbled' | 'all' | 'broken' | 'messy',
    @Body('limit') limit?: number,
  ) {
    const allowed = new Set(['garbled', 'all', 'broken', 'messy']);
    if (scope && !allowed.has(scope)) {
      throw new BadRequestException("scope must be 'garbled' | 'all' | 'broken' | 'messy'");
    }
    if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) {
      throw new BadRequestException('limit must be a positive number if provided');
    }
    return this.noticesService.reextractBulk((scope as any) ?? 'garbled', limit);
  }

  /** Bulk re-extract progress — in-memory like scrape_progress. Poll for live status. */
  @Get('items/reextract/progress')
  async bulkProgressList() {
    return {
      jobs: this.noticesService.getBulkProgressList(),
      latest: this.noticesService.getLatestBulkProgress(),
    };
  }

  @Get('items/reextract/progress/:jobId')
  async bulkProgressById(@Param('jobId') jobId: string) {
    const job = this.noticesService.getBulkProgress(jobId);
    if (!job) throw new NotFoundException(`Bulk job ${jobId} not found`);
    return job;
  }

  /**
   * Summarize + embed notices that have content but no AI summary — those are
   * invisible to the RAG chat until they are indexed. Returns once queued.
   */
  @Post('items/backfill-summaries')
  async backfillSummaries(
    @Body('limit') limit?: number,
    @Body('concurrency') concurrency?: number,
  ) {
    return this.scrapingService.backfillSummaries({ limit, concurrency });
  }

  /**
   * Report (and with `deleteThem: true`, remove) catalogue rows that are not
   * real notices — the "(untitled)" placeholders stored before the scraper
   * had admission control. Dry run unless deletion is explicitly requested.
   */
  @Post('items/cleanup-junk')
  async cleanupJunk(
    @Body('deleteThem') deleteThem?: boolean,
    @Body('limit') limit?: number,
  ) {
    return this.scrapingService.cleanupJunkItems({ deleteThem: deleteThem === true, limit });
  }

  /** Re-run extraction for a single notice, overwriting its stored text. */
  @Post('items/:id/reextract')
  async reextractItem(@Param('id', ParseUUIDPipe) id: string) {
    return this.noticesService.reextract(id);
  }

  @Get('runs')
  async listRuns(
    @Query('sourceId') sourceId?: string,
    @Query('status') status?: ScrapeRunStatus,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.scrapingService.listRuns({
      sourceId,
      status,
      page: page ? Math.max(1, parseInt(page, 10) || 1) : undefined,
      limit: limit ? Math.min(100, Math.max(1, parseInt(limit, 10) || 20)) : undefined,
    });
  }

  @Get('runs/:id/progress')
  async runProgress(@Param('id', ParseUUIDPipe) id: string) {
    return this.scrapingService.getRunProgress(id);
  }

  /** Re-run the source a given run belongs to — retry directly from a failed run row. */
  @Post('runs/:id/retry')
  async retryRun(@Param('id', ParseUUIDPipe) id: string) {
    return this.scrapingService.retryRun(id);
  }

  /** Admin correction: update category, tags, and trigger re-classification. */
  @Patch('items/:id')
  async correctNotice(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: {
      category?: ScrapedItemCategory;
      tags?: string[];
      aiCategoryConfidence?: number;
      reClassify?: boolean;
    },
  ) {
    if (body.reClassify) {
      // Re-run full AI analysis on the existing content
      return this.scrapingService.reClassifyNotice(id);
    }
    const data: any = {};
    if (body.category) data.category = body.category;
    if (body.tags !== undefined) data.tags = body.tags;
    if (body.aiCategoryConfidence !== undefined) data.aiCategoryConfidence = body.aiCategoryConfidence;
    return this.scrapingService.updateNotice(id, data);
  }
}
