import { Controller, Get, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { Role, ScrapeRunStatus } from '@prisma/client';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { RolesGuard } from '../guards/roles.guard';
import { Roles } from '../decorators/roles.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../services/settings.service';

/** One dependency's live state. `null` latency means it was never contacted. */
interface ComponentStatus {
  id: string;
  label: string;
  status: 'ok' | 'degraded' | 'down' | 'not_configured';
  detail: string;
  latencyMs: number | null;
}

/**
 * Real system status for /admin/system.
 *
 * Everything here is measured at request time or read from the database —
 * the page this replaces displayed hardcoded values ("99.9% uptime",
 * "4.8 MB", a fabricated log feed) that were not merely stale but actively
 * misleading, still claiming localStorage after the Postgres/S3 migration.
 *
 * Checks run concurrently and each is individually guarded: one unreachable
 * dependency must degrade its own row, never fail the whole page — an admin
 * opens this precisely when something is broken.
 */
@Controller('admin/system')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.admin)
export class AdminSystemController {
  private static readonly startedAt = Date.now();

  constructor(
    private readonly prisma: PrismaService,
    private readonly http: HttpService,
    private readonly config: ConfigService,
    private readonly settings: SettingsService,
  ) {}

  @Get('status')
  async status() {
    const [database, aiService, counts, scraping, storage] = await Promise.all([
      this.checkDatabase(),
      this.checkAiService(),
      this.countRows(),
      this.scrapingSummary(),
      Promise.resolve(this.checkStorage()),
    ]);

    const components: ComponentStatus[] = [
      this.checkApi(),
      database,
      ...aiService.components,
      storage,
      this.checkPayments(),
      await this.checkEmail(),
    ];

    // Worst wins: one down dependency means the system is not "operational".
    const worst = components.some((c) => c.status === 'down')
      ? 'down'
      : components.some((c) => c.status === 'degraded')
        ? 'degraded'
        : 'ok';

    return {
      overall: worst,
      checkedAt: new Date().toISOString(),
      components,
      counts,
      scraping,
      runtime: {
        environment: this.config.get<string>('NODE_ENV') ?? 'development',
        nodeVersion: process.version,
        uptimeSeconds: Math.round((Date.now() - AdminSystemController.startedAt) / 1000),
        memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      },
    };
  }

  private checkApi(): ComponentStatus {
    return {
      id: 'api',
      label: 'API service',
      status: 'ok',
      detail: `Serving — up ${formatDuration(Math.round((Date.now() - AdminSystemController.startedAt) / 1000))}`,
      latencyMs: null,
    };
  }

  private async checkDatabase(): Promise<ComponentStatus> {
    const started = Date.now();
    try {
      // A trivial round-trip measures reachability + latency without locking
      // anything or depending on any particular table existing.
      await this.prisma.$queryRaw`SELECT 1`;
      const latencyMs = Date.now() - started;
      let detail = 'Connected';
      try {
        const [row] = await this.prisma.$queryRaw<{ size: string }[]>`
          SELECT pg_size_pretty(pg_database_size(current_database())) AS size`;
        if (row?.size) detail = `Connected · ${row.size} on disk`;
      } catch {
        // Size needs privileges the app role may not have; not worth failing over.
      }
      return {
        id: 'database',
        label: 'PostgreSQL',
        status: latencyMs > 1000 ? 'degraded' : 'ok',
        detail: latencyMs > 1000 ? `${detail} — slow response` : detail,
        latencyMs,
      };
    } catch (e: any) {
      return {
        id: 'database',
        label: 'PostgreSQL',
        status: 'down',
        detail: e?.message ?? 'Unreachable',
        latencyMs: Date.now() - started,
      };
    }
  }

  /** Proxies the AI service's own /health, which also reports Qdrant + model. */
  private async checkAiService(): Promise<{ components: ComponentStatus[] }> {
    const baseUrl = this.config.get<string>('AI_SERVICE_URL') || 'http://localhost:8000';
    const started = Date.now();
    try {
      const response = await firstValueFrom(
        // AI /health is usually fast, but on a cold Ollama host it can take 10-20s (model load, Qdrant probe). 10s aborted it before ready and contributed to "(canceled)" health in the Network tab.
        this.http.get(`${baseUrl}/health`, { timeout: 30000 }),
      );
      const latencyMs = Date.now() - started;
      const body = response.data ?? {};
      const phase = body.status ?? 'unknown';

      return {
        components: [
          {
            id: 'ai',
            label: 'AI service',
            // "warming" is a normal cold start (it downloads a ~1 GB embedding
            // model), so it is degraded rather than down.
            status: phase === 'ok' ? 'ok' : phase === 'warming' ? 'degraded' : 'down',
            detail:
              phase === 'ok'
                ? 'Ready'
                : `${phase}${body.error ? ` — ${body.error}` : ''}`,
            latencyMs,
          },
          {
            id: 'qdrant',
            label: 'Qdrant (vector store)',
            status: body.qdrant ? 'ok' : 'down',
            detail: body.qdrant ? 'Connected' : 'Not reachable from the AI service',
            latencyMs: null,
          },
          {
            id: 'embeddings',
            label: 'Embedding model',
            status: body.model_loaded ? 'ok' : 'degraded',
            detail: body.model_loaded ? 'Loaded' : 'Not loaded yet',
            latencyMs: null,
          },
        ],
      };
    } catch (e: any) {
      // The AI service owns the Qdrant/model probes, so if it is unreachable
      // their true state is unknown — reporting them as "down" would be a guess.
      return {
        components: [
          {
            id: 'ai',
            label: 'AI service',
            status: 'down',
            detail: `${baseUrl} — ${e?.message || e?.code || 'no response'}`,
            latencyMs: Date.now() - started,
          },
          {
            id: 'qdrant',
            label: 'Qdrant (vector store)',
            status: 'degraded',
            detail: 'Unknown — the AI service that probes it is unreachable',
            latencyMs: null,
          },
        ],
      };
    }
  }

  private checkStorage(): ComponentStatus {
    const bucket = this.config.get<string>('S3_BUCKET_NAME');
    const region = this.config.get<string>('AWS_REGION');
    return {
      id: 'storage',
      label: 'S3 storage',
      status: bucket ? 'ok' : 'not_configured',
      detail: bucket ? `${bucket} (${region ?? 'us-east-1'})` : 'S3_BUCKET_NAME is not set',
      latencyMs: null,
    };
  }

  private checkPayments(): ComponentStatus {
    const configured = Boolean(this.config.get<string>('STRIPE_SECRET_KEY'));
    const webhook = Boolean(this.config.get<string>('STRIPE_WEBHOOK_SECRET'));
    return {
      id: 'payments',
      label: 'Payments (Stripe)',
      status: !configured ? 'not_configured' : webhook ? 'ok' : 'degraded',
      detail: !configured
        ? 'STRIPE_SECRET_KEY is not set — checkout returns 503'
        : webhook
          ? 'Key and webhook secret configured'
          : 'Key set, but STRIPE_WEBHOOK_SECRET is missing — upgrades will not activate',
      latencyMs: null,
    };
  }

  private async checkEmail(): Promise<ComponentStatus> {
    const host = await this.settings.getEffective('alerts.email.host');
    const enabled = await this.settings.getEffective('alerts.email.enabled');
    return {
      id: 'email',
      label: 'Email alerts (SMTP)',
      status: !host ? 'not_configured' : enabled === 'true' ? 'ok' : 'degraded',
      detail: !host
        ? 'Not configured — set it up under Alert channels'
        : enabled === 'true'
          ? `Enabled via ${host}`
          : `Configured (${host}) but currently disabled`,
      latencyMs: null,
    };
  }

  private async countRows() {
    const [notices, documents, users, sources, alertRules] = await Promise.all([
      this.prisma.scrapedItem.count(),
      this.prisma.document.count(),
      this.prisma.user.count(),
      this.prisma.scrapeSource.count(),
      this.prisma.alertRule.count(),
    ]);
    return { notices, documents, users, sources, alertRules };
  }

  /** Real scraping posture — last run, and which sources are currently failing. */
  private async scrapingSummary() {
    const [lastRun, failingSources, enabledSources, recentRuns] = await Promise.all([
      this.prisma.scrapeRun.findFirst({
        orderBy: { startedAt: 'desc' },
        select: {
          id: true,
          sourceLabel: true,
          status: true,
          itemsFound: true,
          itemsNew: true,
          startedAt: true,
          finishedAt: true,
          error: true,
        },
      }),
      this.prisma.scrapeRun.count({
        where: {
          status: ScrapeRunStatus.FAILED,
          startedAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
        },
      }),
      this.prisma.scrapeSource.count({ where: { enabled: true } }),
      this.prisma.scrapeRun.count({
        where: { startedAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
      }),
    ]);

    return {
      schedulerEnabled: await this.settings.getBoolean('scraping.enabled', true),
      enabledSources,
      runsLast24h: recentRuns,
      failedRunsLast24h: failingSources,
      lastRun,
    };
  }
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}
