import { Controller, Get, Logger, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { Throttle } from '@nestjs/throttler';
import { Role, ScrapeRunStatus } from '@prisma/client';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { RolesGuard } from '../guards/roles.guard';
import { Roles } from '../decorators/roles.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../services/settings.service';
import { TtlCache } from '../common/cache/ttl-cache';

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
  private readonly logger = new Logger(AdminSystemController.name);

  // ── AI health hardening ───────────────────────────────────────────────
  // 30s TTL cache + circuit breaker mirror ai-providers health hardening.
  private readonly aiHealthCache = new TtlCache<{ components: ComponentStatus[] }>(30_000);
  private aiCircuitFailures = 0;
  private aiCircuitOpenedAt = 0;
  private lastAiHealthy: { components: ComponentStatus[] } | null = null;

  private static readonly AI_HEALTH_TIMEOUT_MS = 45_000;
  private static readonly AI_CIRCUIT_THRESHOLD = 3;
  private static readonly AI_CIRCUIT_COOLDOWN_MS = 30_000;
  private static readonly AI_RETRY_BACKOFF_MS = 650;

  constructor(
    private readonly prisma: PrismaService,
    private readonly http: HttpService,
    private readonly config: ConfigService,
    private readonly settings: SettingsService,
  ) {}

  @Get('status')
  @Throttle({ default: { ttl: 60000, limit: 20 } })
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

  // ── Circuit + error helpers for AI health ──────────────────────────────

  private isAiCircuitOpen(): boolean {
    if (this.aiCircuitFailures < AdminSystemController.AI_CIRCUIT_THRESHOLD) return false;
    const elapsed = Date.now() - this.aiCircuitOpenedAt;
    if (elapsed >= AdminSystemController.AI_CIRCUIT_COOLDOWN_MS) {
      this.aiCircuitFailures = 0;
      this.aiCircuitOpenedAt = 0;
      return false;
    }
    return true;
  }

  private recordAiSuccess(result: { components: ComponentStatus[] }): void {
    this.aiCircuitFailures = 0;
    this.aiCircuitOpenedAt = 0;
    this.lastAiHealthy = result;
    this.aiHealthCache.set('ai:health', result, 30_000);
  }

  private recordAiFailure(): void {
    this.aiCircuitFailures += 1;
    if (this.aiCircuitFailures >= AdminSystemController.AI_CIRCUIT_THRESHOLD && this.aiCircuitOpenedAt === 0) {
      this.aiCircuitOpenedAt = Date.now();
      this.logger.warn(
        `AI system health circuit opened (${this.aiCircuitFailures} consecutive failures) — short-circuiting for ${AdminSystemController.AI_CIRCUIT_COOLDOWN_MS / 1000}s`,
      );
    }
  }

  private classifyAiError(err: any): {
    kind: 'timeout' | 'auth' | 'unavailable' | 'network' | 'unknown';
    status?: number;
    message: string;
    retryable: boolean;
  } {
    const status: number | undefined = err?.response?.status;
    const code: string | undefined = err?.code;
    const rawMessage: string = err?.message ?? '';
    const upstream: string | undefined = err?.response?.data?.error || err?.response?.data?.message;

    if (code === 'ECONNABORTED' || rawMessage.toLowerCase().includes('timeout')) {
      return {
        kind: 'timeout',
        status,
        message: `AI service timed out after ${AdminSystemController.AI_HEALTH_TIMEOUT_MS / 1000}s`,
        retryable: true,
      };
    }
    if (status === 401 || status === 403) {
      return {
        kind: 'auth',
        status,
        message: upstream ?? `AI service auth failed (${status})`,
        retryable: false,
      };
    }
    if (status === 503 || status === 502 || status === 504 || status === 429) {
      return {
        kind: 'unavailable',
        status,
        message: upstream ?? `AI service unavailable (${status})`,
        retryable: true,
      };
    }
    if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ECONNRESET' || code === 'EHOSTUNREACH') {
      return {
        kind: 'network',
        status,
        message: upstream ?? `Network error (${code}) — AI service unreachable`,
        retryable: true,
      };
    }
    const fallback = upstream || rawMessage || code || err?.response?.statusText || 'no response';
    return { kind: 'unknown', status, message: fallback, retryable: true };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async fetchAiHealthWithRetry(baseUrl: string): Promise<any> {
    const timeout = AdminSystemController.AI_HEALTH_TIMEOUT_MS;
    const doRequest = () => firstValueFrom(this.http.get(`${baseUrl}/health`, { timeout }));
    try {
      const res = await doRequest();
      return res.data;
    } catch (err: any) {
      const classified = this.classifyAiError(err);
      if (!classified.retryable) throw err;
      this.logger.warn(
        `AI /health transient failure (${classified.kind}) — retrying once after ${AdminSystemController.AI_RETRY_BACKOFF_MS}ms: ${classified.message}`,
      );
      await this.sleep(AdminSystemController.AI_RETRY_BACKOFF_MS);
      const retryRes = await doRequest();
      return retryRes.data;
    }
  }

  /** Proxies the AI service's own /health, which also reports Qdrant + model. */
  private async checkAiService(): Promise<{ components: ComponentStatus[] }> {
    const baseUrl = this.config.get<string>('AI_SERVICE_URL') || 'http://localhost:8000';
    const started = Date.now();

    // 30s TTL cache: avoid hammering AI /health on every dashboard poll
    const cached = this.aiHealthCache.get('ai:health');
    if (cached) {
      return cached;
    }

    // Circuit breaker: short-circuit if AI failed 3 times in a row
    if (this.isAiCircuitOpen()) {
      const stale = this.lastAiHealthy ?? this.aiHealthCache.get('ai:health');
      if (stale) {
        this.logger.warn('AI system health circuit open — returning degraded cached components');
        // Mark ai component as degraded due to circuit, preserve other components as cached
        const degraded: ComponentStatus[] = stale.components.map((c) =>
          c.id === 'ai'
            ? { ...c, status: 'degraded' as const, detail: `${c.detail} (cached — circuit open)` }
            : c,
        );
        return { components: degraded };
      }
      // No cache — return degraded placeholder instead of throwing 503 (must not fail the whole page)
      return {
        components: [
          {
            id: 'ai',
            label: 'AI service',
            status: 'degraded',
            detail: `Circuit open — too many recent failures, retry in ${Math.ceil((AdminSystemController.AI_CIRCUIT_COOLDOWN_MS - (Date.now() - this.aiCircuitOpenedAt)) / 1000)}s (${baseUrl})`,
            latencyMs: null,
          },
          {
            id: 'qdrant',
            label: 'Qdrant (vector store)',
            status: 'degraded',
            detail: 'Unknown — AI service circuit open',
            latencyMs: null,
          },
          {
            id: 'embeddings',
            label: 'Embedding model',
            status: 'degraded',
            detail: 'Unknown — AI service circuit open',
            latencyMs: null,
          },
        ],
      };
    }

    try {
      const data = await this.fetchAiHealthWithRetry(baseUrl);
      const latencyMs = Date.now() - started;
      const body = data ?? {};
      const phase = body.status ?? 'unknown';

      const result: { components: ComponentStatus[] } = {
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
      this.recordAiSuccess(result);
      return result;
    } catch (e: any) {
      const classified = this.classifyAiError(e);
      this.recordAiFailure();

      // Never throw 503 — return degraded components so the page still renders.
      // Distinguish error kinds for actionable detail, and degrade (not down) for transient.
      const stale = this.aiHealthCache.get('ai:health') ?? this.lastAiHealthy;
      if (stale) {
        this.logger.warn(`AI /health failed (${classified.kind}) — returning degraded cached components: ${classified.message}`);
        const degraded: ComponentStatus[] = stale.components.map((c) =>
          c.id === 'ai'
            ? {
                ...c,
                status: 'degraded' as const,
                detail: `[${classified.kind}${classified.status ? ` ${classified.status}` : ''}] ${classified.message} (cached)`,
                latencyMs: Date.now() - started,
              }
            : c,
        );
        return { components: degraded };
      }

      // No cache: return degraded with classified detail
      const isAuth = classified.kind === 'auth';
      return {
        components: [
          {
            id: 'ai',
            label: 'AI service',
            // auth failures are configuration errors → degraded (not down) — service is reachable but misconfigured
            status: isAuth ? 'degraded' : classified.kind === 'timeout' || classified.kind === 'network' ? 'degraded' : 'down',
            detail: `[${classified.kind}${classified.status ? ` ${classified.status}` : ''}] ${baseUrl} — ${classified.message}`,
            latencyMs: Date.now() - started,
          },
          {
            id: 'qdrant',
            label: 'Qdrant (vector store)',
            status: 'degraded',
            detail: 'Unknown — the AI service that probes it is unreachable',
            latencyMs: null,
          },
          {
            id: 'embeddings',
            label: 'Embedding model',
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
