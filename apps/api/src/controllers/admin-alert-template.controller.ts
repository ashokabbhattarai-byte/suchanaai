import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { RolesGuard } from '../guards/roles.guard';
import { Roles } from '../decorators/roles.decorator';
import { TEMPLATE_TOKENS, DEFAULT_WHATSAPP_TEMPLATE, renderTemplate, sampleTemplateData } from '../services/alert-template';

/**
 * Read-model + live preview for the WhatsApp alert template
 * (SettingsService key `alerts.whatsappTemplate`). Saving/resetting the
 * template itself reuses the existing generic settings endpoints
 * (PUT/DELETE /admin/settings) — this controller only adds what those
 * can't do: tell the admin UI which tokens exist, and render a template
 * against realistic sample data without needing a real notice.
 */
@Controller('admin/alerts/template')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.admin)
export class AdminAlertTemplateController {
  /** Token reference + the built-in default, for the editor's sidebar. */
  @Get('tokens')
  tokens() {
    return { tokens: TEMPLATE_TOKENS, default: DEFAULT_WHATSAPP_TEMPLATE };
  }

  /** Body: { template: string }. Renders against a fixed realistic sample notice. */
  @Post('preview')
  preview(@Body('template') template: string) {
    const text = renderTemplate(typeof template === 'string' ? template : '', sampleTemplateData());
    return { preview: text };
  }
}
