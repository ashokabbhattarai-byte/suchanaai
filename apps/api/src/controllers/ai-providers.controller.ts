import {
  Body,
  Controller,
  Delete,
  Get,
  Logger,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { Throttle } from '@nestjs/throttler';
import { AiProviderKind, Role } from '@prisma/client';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { RolesGuard } from '../guards/roles.guard';
import { Roles } from '../decorators/roles.decorator';
import { AiProvidersService } from '../services/ai-providers.service';
import { TtlCache } from '../common/cache/ttl-cache';

interface ProviderBody {
  label?: string;
  kind?: AiProviderKind;
  baseUrl?: string | null;
  /** AWS region, BEDROCK only. */
  region?: string | null;
  model?: string;
  apiKey?: string;
  enabled?: boolean;
}

/**
 * Admin CRUD for the LLM provider registry, plus health probes.
 *
 * Health is proxied to the AI service (which owns the actual provider
 * adapters) rather than re-implemented here — one source of truth for what
 * "reachable" means, and the probe runs from the host that will make the
 * real calls, so its result reflects that host's network and credentials.
 */
@Controller('admin/ai/providers')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.admin)
export class AiProvidersController {
  private readonly logger = new Logger(AiProvidersController.name);

  // ── Health hardening ──────────────────────────────────────────────────
  // 30s TTL cache avoids live probe on every click; Ollama probe alone is 60s.
  // Circuit breaker prevents deterministic 503 flap when AI is slow/cold.
  private readonly healthCache = new TtlCache<any>(30_000);
  private circuitFailures = 0;
  private circuitOpenedAt = 0;
  private lastHealthyResponse: any | null = null;
  private lastHealthyAt = 0;

  private static readonly HEALTH_TIMEOUT_MS = 90_000;
  private static readonly CIRCUIT_THRESHOLD = 3;
  private static readonly CIRCUIT_COOLDOWN_MS = 30_000;
  private static readonly RETRY_BACKOFF_MS = 700;

  constructor(
    private readonly providers: AiProvidersService,
    private readonly http: HttpService,
    private readonly config: ConfigService,
  ) {}

  private get aiUrl(): string {
    return this.config.get<string>('AI_SERVICE_URL') || 'http://localhost:8000';
  }

  @Get()
  list() {
    return this.providers.list();
  }

  /**
   * Tell the AI service to re-pull the registry now.
   *
   * Its background sync runs on a multi-minute timer, so without this an
   * admin who saves a key sees "No API key configured" on Test and gets the
   * old provider chain on real calls until the timer happens to fire.
   * Best-effort: a provider edit must still succeed if the AI service is down.
   */
  private async notifyAiService(): Promise<void> {
    try {
      const res = await firstValueFrom(
        this.http.post(`${this.aiUrl}/llm/providers/refresh`, {}, { timeout: 10000 }),
      );
      // The AI service answers 200 whether or not the pull worked, so a
      // failed sync used to look like a successful save while the service
      // carried on with its env-var providers.
      if (res.data && res.data.refreshed === false) {
        this.logger.warn(
          `AI service could not reload the provider registry: ${res.data.error ?? 'no reason given'}`,
        );
      }
    } catch (err: any) {
      this.logger.warn(
        `Provider registry saved but the AI service refresh failed: ${err?.message ?? err}`,
      );
    }
  }

  /**
   * Force the AI service to re-pull the registry and report what happened.
   *
   * Exposed because a silently failing sync is indistinguishable from a
   * working one in the panel: the list comes from this database, but the
   * chain that actually answers is whatever the AI service last synced.
   */
  @Post('refresh')
  async refresh() {
    try {
      const res = await firstValueFrom(
        this.http.post(`${this.aiUrl}/llm/providers/refresh`, {}, { timeout: 15000 }),
      );
      return res.data;
    } catch (err: any) {
      throw new ServiceUnavailableException(
        `Could not reach the AI service at ${this.aiUrl} — ${err?.message ?? err}`,
      );
    }
  }

  @Post()
  async create(@Body() body: ProviderBody) {
    const created = await this.providers.create({
      label: body.label ?? '',
      kind: body.kind ?? AiProviderKind.OPENAI_COMPATIBLE,
      model: body.model ?? '',
      baseUrl: body.baseUrl ?? null,
      region: body.region ?? null,
      apiKey: body.apiKey,
      enabled: body.enabled,
    });
    await this.notifyAiService();
    return created;
  }

  /**
   * Live model catalogue for the picker in the provider dialog.
   *
   * Declared before `:id` for the same reason as `order` below. POST rather
   * than GET because an unsaved provider has no id and the candidate key is
   * in the body — a key must never land in a URL, where it would be logged.
   */
  @Post('models')
  listModels(
    @Body()
    body: { id?: string; kind?: AiProviderKind; baseUrl?: string | null; apiKey?: string },
  ) {
    return this.providers.listModels({
      id: body.id,
      kind: body.kind ?? AiProviderKind.OPENAI_COMPATIBLE,
      baseUrl: body.baseUrl,
      apiKey: body.apiKey,
    });
  }

  /**
   * Declared before `:id` so "order" is never parsed as a UUID — Nest matches
   * routes in declaration order.
   */
  @Put('order')
  async reorder(@Body() body: { ids?: string[] }) {
    const result = await this.providers.reorder(body.ids ?? []);
    await this.notifyAiService();
    return result;
  }

  @Put(':id')
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() body: ProviderBody) {
    const updated = await this.providers.update(id, body);
    await this.notifyAiService();
    return updated;
  }

  @Delete(':id')
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    const removed = await this.providers.remove(id);
    await this.notifyAiService();
    return removed;
  }

  // ── Circuit + error helpers ──────────────────────────────────────────

  private isCircuitOpen(): boolean {
    if (this.circuitFailures < AiProvidersController.CIRCUIT_THRESHOLD) return false;
    const elapsed = Date.now() - this.circuitOpenedAt;
    if (elapsed >= AiProvidersController.CIRCUIT_COOLDOWN_MS) {
      // Cooldown elapsed — half-open: allow one probe to reset or re-trip
      this.circuitFailures = 0;
      this.circuitOpenedAt = 0;
      return false;
    }
    return true;
  }

  private recordSuccess(data: any): void {
    this.circuitFailures = 0;
    this.circuitOpenedAt = 0;
    this.lastHealthyResponse = data;
    this.lastHealthyAt = Date.now();
  }

  private recordFailure(): void {
    this.circuitFailures += 1;
    if (this.circuitFailures >= AiProvidersController.CIRCUIT_THRESHOLD && this.circuitOpenedAt === 0) {
      this.circuitOpenedAt = Date.now();
      this.logger.warn(
        `AI health circuit opened (${this.circuitFailures} consecutive failures) — short-circuiting for ${AiProvidersController.CIRCUIT_COOLDOWN_MS / 1000}s`,
      );
    }
  }

  private classifyHealthError(err: any): {
    kind: 'timeout' | 'auth' | 'not_found' | 'rate_limited' | 'unavailable' | 'network' | 'unknown';
    status?: number;
    message: string;
    retryable: boolean;
  } {
    const status: number | undefined = err?.response?.status;
    const code: string | undefined = err?.code;
    const rawMessage: string = err?.message ?? '';
    const upstream: string | undefined = err?.response?.data?.error || err?.response?.data?.message;

    // timeout: axios ECONNABORTED or explicit timeout string
    if (
      code === 'ECONNABORTED' ||
      rawMessage.toLowerCase().includes('timeout') ||
      rawMessage.includes('timeout of')
    ) {
      return {
        kind: 'timeout',
        status,
        message: `AI service timed out after ${AiProvidersController.HEALTH_TIMEOUT_MS / 1000}s — probe still running or host overloaded`,
        retryable: true,
      };
    }
    if (status === 401) {
      return {
        kind: 'auth',
        status,
        message: upstream ?? 'Provider authentication failed (401 — invalid or missing API key)',
        retryable: false,
      };
    }
    if (status === 403) {
      return {
        kind: 'auth',
        status,
        message: upstream ?? 'Provider authentication failed (403 — forbidden or quota exceeded)',
        retryable: false,
      };
    }
    if (status === 404) {
      return {
        kind: 'not_found',
        status,
        message: upstream ?? 'Provider or model not found (404)',
        retryable: false,
      };
    }
    if (status === 429) {
      return {
        kind: 'rate_limited',
        status,
        message: upstream ?? 'Provider rate-limited (429) — retry after backoff',
        retryable: true,
      };
    }
    if (status === 503 || status === 502 || status === 504) {
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
        message: upstream ?? `Network error to AI service (${code}) — ${this.aiUrl} unreachable`,
        retryable: true,
      };
    }
    // Fallback: surface upstream if present, else raw
    const fallback = upstream || rawMessage || err?.code || err?.response?.statusText || 'the service did not respond';
    return { kind: 'unknown', status, message: fallback, retryable: true };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async fetchHealthWithRetry(slug: string): Promise<any> {
    const url = `${this.aiUrl}/llm/health`;
    const timeout = AiProvidersController.HEALTH_TIMEOUT_MS;
    const doRequest = () =>
      firstValueFrom(this.http.post(url, { slug }, { timeout }));

    try {
      const res = await doRequest();
      return res.data;
    } catch (err: any) {
      const classified = this.classifyHealthError(err);
      // Only retry retryable, transient failures (timeout / 503 / network / 429), never auth/not_found
      if (!classified.retryable) throw err;
      this.logger.warn(
        `AI health probe transient failure (${classified.kind}) — retrying once after ${AiProvidersController.RETRY_BACKOFF_MS}ms: ${classified.message}`,
      );
      await this.sleep(AiProvidersController.RETRY_BACKOFF_MS);
      const retryRes = await doRequest();
      return retryRes.data;
    }
  }

  /** Probe a single provider — the per-card "Test" button. */
  @Post(':id/health')
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  async health(@Param('id', ParseUUIDPipe) id: string) {
    const provider = await this.providers.findOne(id);
    const cacheKey = `health:${provider.slug}`;

    // 30s TTL cache: avoid live Ollama 60s probe on every click; serve cached if fresh
    const cached = this.healthCache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    // Circuit breaker: if AI failed 3 times in a row, short-circuit for 30s
    if (this.isCircuitOpen()) {
      if (this.lastHealthyResponse) {
        this.logger.warn(`AI health circuit open — returning degraded cached response for ${provider.slug}`);
        return {
          ...this.lastHealthyResponse,
          _cached: true,
          _degraded: true,
          _circuitOpen: true,
          _notice: 'AI service circuit open — serving cached health (30s cooldown)',
        };
      }
      if (cached !== undefined) {
        return { ...cached, _degraded: true, _circuitOpen: true };
      }
      throw new ServiceUnavailableException(
        `AI service circuit open — too many recent failures, retry in ${Math.ceil((AiProvidersController.CIRCUIT_COOLDOWN_MS - (Date.now() - this.circuitOpenedAt)) / 1000)}s`,
      );
    }

    try {
      const data = await this.fetchHealthWithRetry(provider.slug);
      // Ollama self-hosted probe alone is 60s (llm.py _probe_one_model, key_optional → 60s), plus Bedrock/Groq fallback chain.
      // AI main.py allows 150s for /llm/health, so 30s here always timed out while the AI was still probing, surfacing as 503 "timeout of 30000ms".
      this.healthCache.set(cacheKey, data, 30_000);
      this.recordSuccess(data);
      return data;
    } catch (err: any) {
      const classified = this.classifyHealthError(err);
      this.recordFailure();

      // If we have a cached healthy response, degrade to it instead of 503 flap
      const stale = this.healthCache.get(cacheKey) ?? this.lastHealthyResponse;
      if (stale) {
        this.logger.warn(
          `AI health probe failed (${classified.kind}) for ${provider.slug} — returning degraded cached response: ${classified.message}`,
        );
        return {
          ...stale,
          _cached: true,
          _degraded: true,
          _error: classified.message,
          _errorKind: classified.kind,
        };
      }

      // Surface the AI service's own error body when available — "timeout of 30000ms" alone hides whether the provider key is bad (401), the model is gone (404), or the service is down.
      const upstream = err?.response?.data?.error || err?.response?.data?.message;
      const reason =
        upstream || classified.message || err?.message || err?.code || err?.response?.statusText || 'the service did not respond';
      const detail = `Could not reach the AI service at ${this.aiUrl} — [${classified.kind}${classified.status ? ` ${classified.status}` : ''}] ${reason}`;
      throw new ServiceUnavailableException(detail);
    }
  }
}
