import { Body, Controller, Param, Patch, UseGuards } from '@nestjs/common';
import { InternalServiceGuard } from '../guards/internal-service.guard';
import { AiProvidersService } from '../services/ai-providers.service';

/**
 * AI-service-to-API direction for provider self-healing (see
 * llm.py's self_heal_openrouter). When the AI service finds a provider's
 * configured model consistently unresponsive but a fallback from its own
 * vetted OPENROUTER_FREE_MODELS list answering instead, it calls this to
 * persist that fallback as the new primary — so the admin panel and every
 * future request try a known-good model first instead of re-discovering
 * the same dead model is dead on every cycle.
 */
@Controller('internal/ai-providers')
@UseGuards(InternalServiceGuard)
export class InternalAiProvidersController {
  constructor(private readonly providers: AiProvidersService) {}

  /** Body: { model: string }. Silently ignores an unknown slug. */
  @Patch(':slug/model')
  async updateModel(@Param('slug') slug: string, @Body('model') model: string) {
    if (typeof model === 'string' && model.trim()) {
      await this.providers.updateModelBySlug(slug, model.trim());
    }
    return { ok: true };
  }
}
