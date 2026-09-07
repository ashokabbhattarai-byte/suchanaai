import {
  Body,
  Controller,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { InternalServiceGuard } from '../guards/internal-service.guard';
import { ScrapingService, RawScrapedItem, ScrapeFailure } from '../services/scraping.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * The AI-service-to-API half of streamed scraping (see
 * ScrapingService.ingestStreamedItems and docs/scraping-pipeline-crawl4ai.md
 * §6.4c). apps/ai POSTs items here AS THEY ARE FOUND during a crawl —
 * seconds after being fetched and summarized — instead of holding the whole
 * run in memory and returning it in one response at the end.
 *
 * This is what makes a deep run survive a timeout: a 504 on the *triggering*
 * request (POST /admin/scraping/sources/:id/run's underlying AI call) no
 * longer discards the work already done, because that work reached Postgres
 * through this endpoint minutes or hours before the outer call ever timed
 * out. `/finish` is the run's own tail — called once, whether the crawl
 * succeeded or failed, so status/schemas/diagnosis land even when the
 * triggering HTTP round-trip itself never completes.
 */
@Controller('internal/scraping')
@UseGuards(InternalServiceGuard)
export class InternalScrapingController {
  constructor(
    private readonly scraping: ScrapingService,
    private readonly prisma: PrismaService,
  ) {}

  /** Body: { items: RawScrapedItem[] }. Safe to call many times per run. */
  @Post('runs/:runId/items')
  async ingestItems(
    @Param('runId', ParseUUIDPipe) runId: string,
    @Body('items') items: RawScrapedItem[],
  ) {
    const run = await this.prisma.scrapeRun.findUnique({
      where: { id: runId },
      include: { source: true },
    });
    if (!run) throw new NotFoundException(`Scrape run ${runId} not found`);
    // An ad-hoc quick-scrape run has no ScrapeSource row to attribute items
    // to — that path already persists synchronously and never streams.
    if (!run.source) throw new NotFoundException(`Run ${runId} has no source to attribute items to`);
    if (!items?.length) return { accepted: 0, rejected: 0 };

    return this.scraping.ingestStreamedItems(runId, run.source, items);
  }

  /**
   * Called once when the AI service's crawl loop finishes — success,
   * partial failure, or a caught exception it can still report structurally.
   * Body: { schemas?, failedUrls?: ScrapeFailure[], stats?, error?: string }.
   * Finalizes the ScrapeRun/ScrapeSource rows from what streaming already
   * persisted (the run's own itemsFound/itemsNew/... counters), not from a
   * full item list — nothing here ever holds one.
   */
  @Post('runs/:runId/finish')
  async finishRun(
    @Param('runId', ParseUUIDPipe) runId: string,
    @Body()
    body: {
      schemas?: Record<string, unknown>;
      failedUrls?: ScrapeFailure[];
      stats?: Record<string, unknown>;
      error?: string;
    },
  ) {
    const run = await this.prisma.scrapeRun.findUnique({
      where: { id: runId },
      include: { source: true },
    });
    if (!run) throw new NotFoundException(`Scrape run ${runId} not found`);
    if (!run.source) throw new NotFoundException(`Run ${runId} has no source to finalize`);

    return this.scraping.finishStreamedRun(
      runId,
      run.source,
      body.schemas ?? {},
      body.failedUrls ?? [],
      body.stats ?? {},
      body.error,
    );
  }
}
