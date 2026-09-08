import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DigestFrequency } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { QuotaService } from './quota.service';
import { EvolutionApiService } from '../integrations/evolution/evolution-api.service';
import { CATEGORY_META, NOTICE_URL_BASE } from './alert-matching.service';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Batches a user's PENDING AlertNotifications (queued by AlertMatchingService
 * for users whose digestFrequency isn't INSTANT) into one WhatsApp message,
 * on a schedule derived from DigestFrequency. HIGH-priority rules never
 * reach here — they're sent instantly regardless of this setting.
 */
@Injectable()
export class AlertDigestService {
  private readonly logger = new Logger(AlertDigestService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly evolutionApi: EvolutionApiService,
    private readonly quota: QuotaService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async tick(): Promise<void> {
    try {
      const users = await this.prisma.user.findMany({
        where: {
          digestFrequency: { in: ['DAILY', 'WEEKLY'] },
          whatsappAlertsEnabled: true,
          whatsappVerified: true,
        },
      });
      for (const user of users) {
        if (this.isDue(user.digestFrequency, user.lastDigestSentAt)) {
          await this.sendDigestFor(user.id);
        }
      }
    } catch (error: any) {
      this.logger.error(`tick() failed: ${error.message}`);
    }
  }

  private isDue(frequency: DigestFrequency, lastSentAt: Date | null): boolean {
    if (!lastSentAt) return true;
    const intervalMs = frequency === 'WEEKLY' ? 7 * DAY_MS : DAY_MS;
    return Date.now() - lastSentAt.getTime() >= intervalMs;
  }

  async sendDigestFor(userId: string): Promise<void> {
    const pending = await this.prisma.alertNotification.findMany({
      where: { userId, status: 'PENDING' },
      include: { scrapedItem: true, alertRule: true },
      orderBy: { sentAt: 'asc' },
      take: 500, // bound DB load; buildDigestMessage slices 15 for display
    });
    // Nothing queued — don't touch lastDigestSentAt, so a digest fires as
    // soon as something actually matches rather than waiting a full cycle.
    if (pending.length === 0) return;

    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });

    // One digest is one billable WhatsApp message regardless of how many
    // notices it batches, so it's checked and counted like any other send.
    // If quota is exhausted, send a single "quota exceeded" notice and drop
    // PENDING items older than 7 days to prevent unbounded growth.
    if (!(await this.quota.canSendWhatsapp(userId))) {
      this.logger.log(
        `WhatsApp quota reached for user ${userId}; ${pending.length} notification(s) stay PENDING`,
      );
      const staleCutoff = new Date(Date.now() - 7 * DAY_MS);
      const staleIds = pending.filter((p) => new Date(p.sentAt) < staleCutoff).map((p) => p.id);
      if (staleIds.length > 0) {
        await this.prisma.alertNotification.updateMany({
          where: { id: { in: staleIds } },
          data: { status: 'FAILED', error: 'Dropped: quota exceeded and notification aged >7d' },
        });
        this.logger.warn(`Dropped ${staleIds.length} stale PENDING notifications for user ${userId} (quota exceeded)`);
      }
      return;
    }

    const text = this.buildDigestMessage(user.digestFrequency, pending);
    const sent = await this.evolutionApi.sendText(user.whatsappNumber!, text);

    if (!sent) {
      this.logger.warn(`Digest send failed for user ${userId} — ${pending.length} notification(s) stay PENDING for retry next tick`);
      return;
    }

    await this.quota.recordWhatsappNotification(userId, {
      kind: 'digest',
      batched: pending.length,
    });

    await this.prisma.alertNotification.updateMany({
      where: { id: { in: pending.map((p) => p.id) } },
      data: { status: 'SENT' },
    });
    await this.prisma.user.update({ where: { id: userId }, data: { lastDigestSentAt: new Date() } });
  }

  private buildDigestMessage(
    frequency: DigestFrequency,
    pending: Array<{ scrapedItem: { id: string; title: string; category: string }; alertRule: { name: string } }>,
  ): string {
    const period = frequency === 'WEEKLY' ? 'Weekly' : 'Daily';
    const base = NOTICE_URL_BASE.replace(/\/+$/, '');
    const lines: string[] = [];
    lines.push(`📬 *${period} Alert Digest* — ${pending.length} new match${pending.length === 1 ? '' : 'es'}`);
    lines.push('───────────────');

    const shown = pending.slice(0, 15);
    for (const p of shown) {
      const item = p.scrapedItem;
      const category = CATEGORY_META[item.category] ?? CATEGORY_META.OTHER;
      lines.push('');
      lines.push(`${category.emoji} *${item.title}*`);
      lines.push(`_${p.alertRule.name}_`);
      // URL alone on its own line so WhatsApp reliably auto-links it.
      lines.push(`${base}/notices/${item.id}`);
    }

    if (pending.length > shown.length) {
      lines.push('');
      lines.push(`…and ${pending.length - shown.length} more.`);
    }

    lines.push('');
    lines.push('───────────────');
    lines.push('_Manage your alerts:_');
    lines.push(`${base}/dashboard/alerts`);
    return lines.join('\n');
  }
}
