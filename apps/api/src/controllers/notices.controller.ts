import { Controller, Get, Post, Param, ParseUUIDPipe, Query, Body, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { User } from '@prisma/client';
import { NoticesService } from '../services/notices.service';
import { QuotaService } from '../services/quota.service';
import { OptionalJwtAuthGuard } from '../guards/optional-jwt-auth.guard';
import { CurrentUser } from '../decorators/current-user.decorator';
import { AskNoticeDto } from '../dto/ask-notice.dto';

/**
 * Caller's address for the signed-out allowance. `trust proxy` is set in
 * main.ts, so `req.ip` is already the client rather than the load balancer;
 * the header is read first only because it is what the deployed nginx/ALB
 * populates, and falls back through to the socket for local runs.
 */
function clientIp(req: Request): string | undefined {
  const forwarded = req.headers['x-forwarded-for'];
  return (
    (typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : undefined) ??
    req.ip ??
    (req.socket?.remoteAddress as string | undefined)
  );
}

// Public read-only endpoints for browsing scraped notices/news — no auth
// required. Admin CRUD/trigger endpoints live under /admin/scraping.
@Controller('notices')
export class NoticesController {
  constructor(
    private readonly noticesService: NoticesService,
    private readonly quota: QuotaService,
  ) {}

  @Get()
  async findAll(
    @Query('category') category?: string,
    @Query('sourceId') sourceId?: string,
    @Query('search') search?: string,
    @Query('tag') tag?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
    @Query('urgency') urgency?: string,
    @Query('sortBy') sortBy?: 'publishedAt' | 'views',
    @Query('sortOrder') sortOrder?: 'asc' | 'desc',
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const parsedPage = Math.max(1, parseInt(page ?? '1', 10) || 1);
    const parsedLimit = limit ? Math.min(100, Math.max(1, parseInt(limit, 10) || 20)) : undefined;
    return this.noticesService.findAll({
      category,
      sourceId,
      search,
      tag,
      dateFrom,
      dateTo,
      urgency,
      sortBy,
      sortOrder,
      page: parsedPage,
      limit: parsedLimit,
    });
  }

  /**
   * The floating chatbot. Signed-in users spend their monthly plan allowance;
   * signed-out visitors get a small daily allowance and then a sign-in wall.
   *
   * The guard is Optional rather than required because the wall is the point:
   * a visitor should be able to try the assistant before being asked for an
   * account, and only then be told what signing in buys.
   */
  @Post('search')
  @UseGuards(OptionalJwtAuthGuard)
  async search(
    @Body()
    body: {
      question: string;
      category?: string;
      language?: string;
      skipClarification?: boolean;
    },
    @CurrentUser() user: User | null,
    @Req() req: Request,
  ) {
    if (!body.question?.trim()) {
      return { answer: '', sources: [], model_used: null };
    }

    // A clarifying follow-up is the same question being re-asked with the
    // ambiguity gate off, so charging for it would bill twice for one answer.
    const isFollowUp = body.skipClarification === true;
    const clientHash = user ? null : this.quota.hashClient(clientIp(req));

    if (user) {
      await this.quota.assertCanAskAi(user.id);
    } else if (clientHash && !isFollowUp) {
      await this.quota.assertAnonymousCanAskAi(clientHash);
    }

    const result = await this.noticesService.search(
      body.question.trim(),
      body.category,
      body.language,
      isFollowUp,
    );

    // Charged after the answer, and never for a clarifying question — that is
    // a request for more input, not an answer the visitor asked for.
    const answered = !(result as { clarification?: unknown })?.clarification;
    if (user) {
      if (answered) await this.quota.recordAiQuestion(user.id, { surface: 'chatbot' });
    } else if (clientHash && answered && !isFollowUp) {
      await this.quota.recordAnonymousAiQuestion(clientHash);
    }

    return result;
  }

  /**
   * Free chats left today for a signed-out visitor, so the chat UI can warn
   * before the wall instead of only at it. Meaningless once signed in, which
   * the `anonymous` flag says outright.
   */
  @Get('meta/chat-allowance')
  @UseGuards(OptionalJwtAuthGuard)
  async chatAllowance(@CurrentUser() user: User | null, @Req() req: Request) {
    if (user) return { anonymous: false, used: 0, limit: null, remaining: null };
    const { used, limit } = await this.quota.anonymousRemaining(
      this.quota.hashClient(clientIp(req)),
    );
    return { anonymous: true, used, limit, remaining: Math.max(0, limit - used) };
  }

  @Get('meta/category-counts')
  async categoryCounts() {
    return this.noticesService.categoryCounts();
  }

  /** Minimal id/slug/updatedAt feed for the web app's public sitemap.xml. */
  @Get('meta/sitemap')
  async sitemapFeed(@Query('limit') limit?: string) {
    const parsedLimit = limit ? Math.min(50000, Math.max(1, parseInt(limit, 10) || 5000)) : undefined;
    return this.noticesService.sitemapFeed(parsedLimit);
  }

  @Get('meta/sources')
  async listSources() {
    return this.noticesService.listSources();
  }

  @Get(':id')
  async findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.noticesService.findOne(id);
  }

  /**
   * Per-notice Q&A. Signed-in users spend their monthly AI allowance;
   * signed-out visitors draw on the same daily free allowance as the chatbot.
   *
   * Deliberately the same counter, not a second one: the chat widget falls
   * through from here to /search for anything the notice can't answer, so two
   * separate allowances would let a visitor take double by alternating
   * between them.
   */
  @Post(':id/ask')
  @UseGuards(OptionalJwtAuthGuard)
  async ask(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AskNoticeDto,
    @CurrentUser() user: User | null,
    @Req() req: Request,
  ) {
    const clientHash = user ? null : this.quota.hashClient(clientIp(req));
    if (user) {
      await this.quota.assertCanAskAi(user.id);
    } else if (clientHash) {
      await this.quota.assertAnonymousCanAskAi(clientHash);
    }

    const answer = await this.noticesService.askQuestion(id, dto.question);

    if (user) {
      await this.quota.recordAiQuestion(user.id, { surface: 'notice_ask', noticeId: id });
    } else if (clientHash) {
      await this.quota.recordAnonymousAiQuestion(clientHash);
    }

    return answer;
  }
}
