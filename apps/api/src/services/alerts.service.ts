import { Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { AlertNotificationStatus, AlertRule } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AlertMatchingService } from './alert-matching.service';
import { CreateAlertRuleDto } from '../dto/create-alert-rule.dto';
import { UpdateAlertRuleDto } from '../dto/update-alert-rule.dto';

/** One entry of the in-app alert feed behind the header bell. */
export interface AlertFeedEntry {
  id: string;
  status: AlertNotificationStatus;
  channels: string[];
  matchedAt: Date;
  readAt: Date | null;
  ruleName: string;
  notice: {
    id: string;
    title: string;
    category: string;
    sourceLabel: string;
    publishedAt: Date | null;
  };
}

@Injectable()
export class AlertsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly matching: AlertMatchingService,
  ) {}

  findAllForUser(userId: string): Promise<AlertRule[]> {
    return this.prisma.alertRule.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async create(userId: string, dto: CreateAlertRuleDto): Promise<AlertRule> {
    this.assertHasPrimaryDimension({ categories: dto.categories, tags: dto.tags });
    const rule = await this.prisma.alertRule.create({
      data: {
        userId,
        name: dto.name,
        enabled: dto.enabled ?? true,
        priority: dto.priority ?? 'NORMAL',
        categories: dto.categories ?? [],
        tags: dto.tags ?? [],
        keywords: dto.keywords ?? [],
        excludeKeywords: dto.excludeKeywords ?? [],
        organizations: dto.organizations ?? [],
        minUrgency: dto.minUrgency ?? null,
        deadlineWithinDays: dto.deadlineWithinDays ?? null,
      },
    });

    // Match the new rule against notices that already exist, in the
    // background — otherwise it reads "0 matches" until the next scrape run
    // happens to find something, which looks broken. Queued only, never
    // sent instantly: see AlertMatchingService.backfillRule.
    void this.matching.backfillRule(rule.id);

    return rule;
  }

  /** Recent matches for the header bell / dashboard feed, newest first. */
  async feedForUser(userId: string, limit = 20): Promise<{ entries: AlertFeedEntry[]; unread: number }> {
    const take = Math.min(Math.max(1, limit), 50);
    const [rows, unread] = await Promise.all([
      this.prisma.alertNotification.findMany({
        where: { userId },
        include: {
          alertRule: { select: { name: true } },
          scrapedItem: {
            select: { id: true, title: true, category: true, sourceLabel: true, publishedAt: true },
          },
        },
        orderBy: { sentAt: 'desc' },
        take,
      }),
      this.prisma.alertNotification.count({ where: { userId, readAt: null } }),
    ]);

    return {
      unread,
      entries: rows.map((row) => ({
        id: row.id,
        status: row.status,
        channels: row.channels,
        matchedAt: row.sentAt,
        readAt: row.readAt,
        ruleName: row.alertRule.name,
        notice: row.scrapedItem,
      })),
    };
  }

  async markFeedRead(userId: string): Promise<{ read: number }> {
    const { count } = await this.prisma.alertNotification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: new Date() },
    });
    return { read: count };
  }

  async update(userId: string, id: string, dto: UpdateAlertRuleDto): Promise<AlertRule> {
    const rule = await this.getOwned(userId, id);

    // Merge onto the existing rule to check the *resulting* state still has
    // a primary basis — a PATCH clearing a rule's only category/tag
    // shouldn't silently produce a rule with no valid basis, even if it
    // still has optional refinements like keywords set.
    this.assertHasPrimaryDimension({
      categories: dto.categories !== undefined ? dto.categories : rule.categories,
      tags: dto.tags !== undefined ? dto.tags : rule.tags,
    });

    const updated = await this.prisma.alertRule.update({
      where: { id: rule.id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.enabled !== undefined ? { enabled: dto.enabled } : {}),
        ...(dto.priority !== undefined ? { priority: dto.priority } : {}),
        ...(dto.categories !== undefined ? { categories: dto.categories } : {}),
        ...(dto.tags !== undefined ? { tags: dto.tags } : {}),
        ...(dto.keywords !== undefined ? { keywords: dto.keywords } : {}),
        ...(dto.excludeKeywords !== undefined ? { excludeKeywords: dto.excludeKeywords } : {}),
        ...(dto.organizations !== undefined ? { organizations: dto.organizations } : {}),
        ...(dto.minUrgency !== undefined ? { minUrgency: dto.minUrgency } : {}),
        ...(dto.deadlineWithinDays !== undefined ? { deadlineWithinDays: dto.deadlineWithinDays } : {}),
      },
    });

    // Widening a rule (or switching it back on) should show its effect right
    // away. Already-matched notices are deduped by the notification's unique
    // constraint, so re-running this is safe and never double-counts.
    if (updated.enabled && this.touchesFilters(dto)) {
      void this.matching.backfillRule(updated.id);
    }

    return updated;
  }

  /** True when the PATCH could change which notices the rule matches. */
  private touchesFilters(dto: UpdateAlertRuleDto): boolean {
    return (
      dto.enabled !== undefined ||
      dto.categories !== undefined ||
      dto.tags !== undefined ||
      dto.keywords !== undefined ||
      dto.excludeKeywords !== undefined ||
      dto.organizations !== undefined ||
      dto.minUrgency !== undefined ||
      dto.deadlineWithinDays !== undefined
    );
  }

  async remove(userId: string, id: string): Promise<void> {
    const rule = await this.getOwned(userId, id);
    await this.prisma.alertRule.delete({ where: { id: rule.id } });
  }

  /**
   * Category and/or tags are the required, easy primary basis for an alert
   * (e.g. "notify me about all Vacancy notices" or "notify me about anything
   * tagged 'scholarship'"). Keywords, organizations, urgency, and deadline
   * are optional refinements a user can layer on top — but none of them may
   * be the sole basis of a rule, keeping the simple path front-and-center
   * while still allowing full advanced tuning once a category/tag is picked.
   */
  private assertHasPrimaryDimension(dims: { categories?: string[] | null; tags?: string[] | null }): void {
    const hasAny = (dims.categories?.length ?? 0) > 0 || (dims.tags?.length ?? 0) > 0;
    if (!hasAny) {
      throw new BadRequestException('Choose at least one category or tag — that\'s the basis every alert needs. Keywords, organizations, urgency, and deadline are optional refinements on top of that.');
    }
  }

  private async getOwned(userId: string, id: string): Promise<AlertRule> {
    const rule = await this.prisma.alertRule.findUnique({ where: { id } });
    if (!rule) throw new NotFoundException('Alert rule not found');
    if (rule.userId !== userId) throw new ForbiddenException('You can only manage your own alert rules');
    return rule;
  }
}
