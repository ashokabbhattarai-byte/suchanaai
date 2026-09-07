import {
  Body,
  BadRequestException,
  Controller,
  Delete,
  Get,
  Param,
  Put,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { RolesGuard } from '../guards/roles.guard';
import { InternalServiceGuard } from '../guards/internal-service.guard';
import { Roles } from '../decorators/roles.decorator';
import { SettingsService } from '../services/settings.service';
import { AiProvidersService } from '../services/ai-providers.service';
import { ScrapingSchedulerService } from '../services/scraping-scheduler.service';

@Controller('admin/settings')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.admin)
export class SettingsController {
  constructor(
    private readonly settings: SettingsService,
    private readonly scheduler: ScrapingSchedulerService,
  ) {}

  /** Admin UI catalog: schema definitions merged with persisted values. */
  @Get()
  async list() {
    const [settings, groups] = await Promise.all([
      this.settings.listAll(),
      Promise.resolve(this.settings.groups),
    ]);
    const byGroup = (group: string) => settings.filter((s) => s.group === group);
    return {
      groups: groups.map((g) => ({
        ...g,
        changed: byGroup(g.id).filter((s) => s.overridden).length,
      })),
      settings,
    };
  }

  /**
   * Batch apply. All-or-nothing is not enforced: valid keys are persisted and
   * invalid ones reported, so one misspelled field never blocks the rest.
   * Returns the fresh state plus a hint of what runtime subsystems were
   * re-applied as a side-effect.
   */
  @Put()
  async update(@Body() body: { values?: Record<string, string> }) {
    const values = body.values ?? (body as unknown as Record<string, string>);
    const result = await this.settings.setMany(values);

    const schedulerTouched = ['scraping.enabled', 'scraping.cron', 'scraping.concurrency',
      'scraping.staleTimeoutSec', 'scraping.minPollSec'].some(
      (k) => result.applied.some((a) => a.key === k),
    );
    const schedulerResult = schedulerTouched ? await this.scheduler.applyConfig() : undefined;

    const [groups, rows] = await Promise.all([Promise.resolve(this.settings.groups), this.settings.listAll()]);
    const view = {
      groups: groups.map((g) => ({
        ...g,
        changed: rows.filter((s) => s.group === g.id && s.overridden).length,
      })),
      settings: rows,
    };

    return {
      ...view,
      applied: result.applied,
      errors: result.errors,
      runtime: schedulerResult ? { scheduler: schedulerResult } : undefined,
    };
  }

  /** Restore the schema default for one key. */
  @Delete(':key')
  async reset(@Param('key') key: string) {
    const removed = await this.settings.reset(key);
    if (!removed) throw new BadRequestException(`Unknown setting key: ${key}`);
    if (['scraping.enabled', 'scraping.cron', 'scraping.concurrency',
      'scraping.staleTimeoutSec', 'scraping.minPollSec'].includes(key)) {
      await this.scheduler.applyConfig();
    }
    return { key, reset: true };
  }
}

/** Public, unauthenticated subset for the frontend footer/SEO. */
@Controller('public/settings')
export class PublicSettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  async publicSettings() {
    return this.settings.publicSettings();
  }
}

/**
 * Lets the AI service (apps/ai) pick up admin-configured LLM API
 * keys/models on a short polling interval, without a redeploy and without
 * ever putting a decrypted key through a user-facing endpoint. Only fields
 * the admin has actually overridden are included — null means "keep your
 * own env-var default", so an unconfigured field here never blanks out a
 * working env-based key on the AI service.
 */
@Controller('internal/ai-config')
@UseGuards(InternalServiceGuard)
export class InternalAiConfigController {
  constructor(
    private readonly providers: AiProvidersService,
    private readonly settings: SettingsService,
  ) {}

  @Get()
  async get() {
    // Decrypted keys cross this boundary — the guard above is the only thing
    // standing in front of them, which is why it fails closed.
    const [providerList, answers, summaries, conversation] = await Promise.all([
      this.providers.listForRuntime(),
      this.settings.getEffective('ai.temperature.answers'),
      this.settings.getEffective('ai.temperature.summaries'),
      this.settings.getEffective('ai.temperature.conversation'),
    ]);
    return {
      providers: providerList,
      // Sampling temperature per task. Sent as effective values (persisted
      // override else schema default) rather than only-if-overridden: unlike
      // an API key, a temperature has no "keep your env var" fallback worth
      // preserving — the admin panel is the single source of truth for it.
      temperatures: {
        answers: Number(answers),
        summaries: Number(summaries),
        conversation: Number(conversation),
      },
    };
  }
}

/**
 * Live LLM provider health for the admin panel. Proxies to the AI service's
 * /llm/health, which makes a real (tiny) call to each configured provider —
 * so this reports what an actual request would hit right now, including the
 * effect of any priority/key change saved seconds ago.
 */
@Controller('admin/ai')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.admin)
export class AdminAiHealthController {
  constructor(
    private readonly http: HttpService,
    private readonly config: ConfigService,
  ) {}

  @Get('health')
  async health() {
    const baseUrl =
      this.config.get<string>('AI_SERVICE_URL') || 'http://localhost:8000';
    try {
      const response = await firstValueFrom(
        // Generous timeout: this fans out to three external providers, and a
        // rate-limited or slow one is exactly the case an admin is here to
        // diagnose — a premature timeout would hide it behind a generic error.
        this.http.get(`${baseUrl}/llm/health`, { timeout: 45000 }),
      );
      return response.data;
    } catch (err: any) {
      // axios connection errors often carry an empty `message`, which used to
      // surface in the admin panel as a bare "…health check:" with no reason.
      const reason =
        err?.message || err?.code || err?.response?.statusText || 'the service did not respond';
      throw new ServiceUnavailableException(
        `Could not reach the AI service at ${baseUrl} — ${reason}`,
      );
    }
  }
}