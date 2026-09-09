import { Injectable, Logger } from '@nestjs/common';
import { AlertNotificationStatus, DigestFrequency } from '@prisma/client';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { QuotaService } from './quota.service';
import { EmailChannelService } from './email-channel.service';
import { EvolutionApiService } from '../integrations/evolution/evolution-api.service';
import { AlertChannel, CATEGORY_META, NOTICE_URL_BASE } from './alert-matching.service';

const DAY_MS = 24 * 60 * 60 * 1000;

// Users on INSTANT still accumulate PENDING rows: a rule's backfill queues
// them deliberately, and a failed instant send is left PENDING to retry.
// Without a sweep those would sit there forever, so they get a batched
// catch-up — never faster than this, so it can't turn into a message storm.
const INSTANT_CATCHUP_GAP_MS = 30 * 60 * 1000;

// PENDING rows that no channel has been able to take for this long are
// dropped: a fortnight-old "new notice" is not worth delivering, and an
// unbounded queue is worth even less.
const STALE_PENDING_MS = 7 * DAY_MS;

type PendingRow = {
  id: string;
  scrapedItem: { id: string; title: string; category: string };
  alertRule: { name: string };
  sentAt: Date;
};

/**
 * Batches a user's PENDING AlertNotifications (queued by AlertMatchingService
 * for users whose digestFrequency isn't INSTANT, plus backfills and retries)
 * into one message per channel, on a schedule derived from DigestFrequency.
 */
@Injectable()
export class AlertDigestService {
  private readonly logger = new Logger(AlertDigestService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly evolutionApi: EvolutionApiService,
    private readonly email: EmailChannelService,
    private readonly quota: QuotaService,
  ) {}

  // Every 30 minutes rather than hourly, so the INSTANT catch-up sweep is
  // actually prompt and a daily digest drifts by at most half an hour.
  @Cron(CronExpression.EVERY_30_MINUTES)
  async tick(): Promise<void> {
    try {
      await this.dropStalePending();
      // Everyone with a channel that can receive something. INSTANT users are
      // included for the catch-up sweep described above.
      const users = await this.prisma.user.findMany({
        where: {
          status: 'active',
          OR: [
            { whatsappAlertsEnabled: true, whatsappVerified: true },
            { emailAlertsEnabled: true },
          ],
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
    const intervalMs =
      frequency === 'WEEKLY' ? 7 * DAY_MS : frequency === 'DAILY' ? DAY_MS : INSTANT_CATCHUP_GAP_MS;
    return Date.now() - lastSentAt.getTime() >= intervalMs;
  }

  async sendDigestFor(userId: string): Promise<void> {
    const pending = await this.prisma.alertNotification.findMany({
      where: { userId, status: AlertNotificationStatus.PENDING },
      include: { scrapedItem: true, alertRule: true },
      orderBy: { sentAt: 'asc' },
      take: 500, // bound DB load; buildDigestMessage slices 15 for display
    });
    // Nothing queued — don't touch lastDigestSentAt, so a digest fires as
    // soon as something actually matches rather than waiting a full cycle.
    if (pending.length === 0) return;

    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const delivered: AlertChannel[] = [];
    const errors: string[] = [];

    if (user.whatsappVerified && user.whatsappAlertsEnabled && user.whatsappNumber) {
      // One digest is one billable WhatsApp message regardless of how many
      // notices it batches, so it's checked and counted like any other send.
      if (!(await this.quota.canSendWhatsapp(userId))) {
        this.logger.log(`WhatsApp quota reached for user ${userId}; digest skips WhatsApp`);
      } else {
        const sent = await this.evolutionApi.sendText(
          user.whatsappNumber,
          this.buildDigestText(user.digestFrequency, pending),
        );
        if (sent) {
          delivered.push('whatsapp');
          await this.quota.recordWhatsappNotification(userId, {
            kind: 'digest',
            batched: pending.length,
          });
        } else {
          errors.push('WhatsApp digest send failed');
        }
      }
    }

    if (user.emailAlertsEnabled && (await this.email.isReady())) {
      const sent = await this.email.send({
        to: user.email,
        subject: this.digestSubject(user.digestFrequency, pending.length),
        text: this.buildDigestText(user.digestFrequency, pending),
        html: this.buildDigestHtml(user.digestFrequency, pending),
      });
      if (sent) delivered.push('email');
      else errors.push('Email digest send failed');
    }

    if (delivered.length === 0) {
      // No channel took it. Leave the rows PENDING so the next tick retries
      // once WhatsApp reconnects / SMTP comes back / the month rolls over.
      this.logger.warn(
        `Digest not delivered for user ${userId} — ${pending.length} notification(s) stay PENDING` +
          (errors.length ? ` (${errors.join('; ')})` : ' (no channel available)'),
      );
      return;
    }

    await this.prisma.alertNotification.updateMany({
      where: { id: { in: pending.map((p) => p.id) } },
      data: { status: AlertNotificationStatus.SENT, channels: delivered, error: null },
    });
    await this.prisma.user.update({ where: { id: userId }, data: { lastDigestSentAt: new Date() } });
    this.logger.log(
      `Digest delivered to user ${userId} over ${delivered.join(' + ')} (${pending.length} notice(s))`,
    );
  }

  /** Give up on PENDING rows nothing could take within STALE_PENDING_MS. */
  private async dropStalePending(): Promise<void> {
    const cutoff = new Date(Date.now() - STALE_PENDING_MS);
    const { count } = await this.prisma.alertNotification.updateMany({
      where: { status: AlertNotificationStatus.PENDING, sentAt: { lt: cutoff } },
      data: {
        status: AlertNotificationStatus.SKIPPED,
        error: 'Not delivered within 7 days — no channel accepted it',
      },
    });
    if (count > 0) this.logger.warn(`Dropped ${count} stale PENDING alert notification(s)`);
  }

  private periodLabel(frequency: DigestFrequency): string {
    return frequency === 'WEEKLY' ? 'Weekly' : frequency === 'DAILY' ? 'Daily' : 'Alert';
  }

  private digestSubject(frequency: DigestFrequency, count: number): string {
    return `${this.periodLabel(frequency)} digest — ${count} new match${count === 1 ? '' : 'es'}`;
  }

  private buildDigestText(frequency: DigestFrequency, pending: PendingRow[]): string {
    const base = NOTICE_URL_BASE.replace(/\/+$/, '');
    const lines: string[] = [];
    lines.push(`📬 *${this.periodLabel(frequency)} Alert Digest* — ${pending.length} new match${pending.length === 1 ? '' : 'es'}`);
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

  private buildDigestHtml(frequency: DigestFrequency, pending: PendingRow[]): string {
    const base = NOTICE_URL_BASE.replace(/\/+$/, '');
    const esc = (v: string) =>
      v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const shown = pending.slice(0, 15);

    const rows = shown
      .map((p) => {
        const category = CATEGORY_META[p.scrapedItem.category] ?? CATEGORY_META.OTHER;
        return `<li style="margin:0 0 16px">
          <a href="${base}/notices/${p.scrapedItem.id}" style="color:#12203a;font-size:15px;font-weight:600;text-decoration:none">${esc(category.emoji)} ${esc(p.scrapedItem.title)}</a>
          <div style="margin-top:3px;font-size:12px;color:#5b6b86">${esc(p.alertRule.name)}</div>
        </li>`;
      })
      .join('');

    return `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f4f6f8;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#12203a">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:16px;padding:28px">
    <h1 style="margin:0 0 4px;font-size:19px;font-weight:600">📬 ${this.periodLabel(frequency)} alert digest</h1>
    <p style="margin:0 0 20px;font-size:13px;color:#5b6b86">${pending.length} new match${pending.length === 1 ? '' : 'es'}</p>
    <ul style="margin:0;padding-left:18px">${rows}</ul>
    ${pending.length > shown.length ? `<p style="margin:12px 0 0;font-size:13px;color:#5b6b86">…and ${pending.length - shown.length} more.</p>` : ''}
    <hr style="margin:24px 0 14px;border:0;border-top:1px solid #e6eaf0" />
    <p style="margin:0;font-size:12px;color:#5b6b86"><a href="${base}/dashboard/alerts" style="color:#5b6b86">Manage your alerts</a></p>
  </div>
</body></html>`;
  }
}
