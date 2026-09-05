import {
  Body,
  Controller,
  Delete,
  Get,
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
import { AiProviderKind, Role } from '@prisma/client';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { RolesGuard } from '../guards/roles.guard';
import { Roles } from '../decorators/roles.decorator';
import { AiProvidersService } from '../services/ai-providers.service';

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

  @Post()
  create(@Body() body: ProviderBody) {
    return this.providers.create({
      label: body.label ?? '',
      kind: body.kind ?? AiProviderKind.OPENAI_COMPATIBLE,
      model: body.model ?? '',
      baseUrl: body.baseUrl ?? null,
      region: body.region ?? null,
      apiKey: body.apiKey,
      enabled: body.enabled,
    });
  }

  /**
   * Declared before `:id` so "order" is never parsed as a UUID — Nest matches
   * routes in declaration order.
   */
  @Put('order')
  reorder(@Body() body: { ids?: string[] }) {
    return this.providers.reorder(body.ids ?? []);
  }

  @Put(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() body: ProviderBody) {
    return this.providers.update(id, body);
  }

  @Delete(':id')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.providers.remove(id);
  }

  /** Probe a single provider — the per-card "Test" button. */
  @Post(':id/health')
  async health(@Param('id', ParseUUIDPipe) id: string) {
    const provider = await this.providers.findOne(id);
    try {
      const response = await firstValueFrom(
        this.http.post(
          `${this.aiUrl}/llm/health`,
          { slug: provider.slug },
          { timeout: 30000 },
        ),
      );
      return response.data;
    } catch (err: any) {
      const reason =
        err?.message || err?.code || err?.response?.statusText || 'the service did not respond';
      throw new ServiceUnavailableException(
        `Could not reach the AI service at ${this.aiUrl} — ${reason}`,
      );
    }
  }
}
