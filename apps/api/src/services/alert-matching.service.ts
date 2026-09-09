import { Injectable, Logger } from '@nestjs/common';
import { AlertNotificationStatus, AlertRule, ScrapedItem, User } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { QuotaService } from './quota.service';
import { SettingsService } from './settings.service';
import { EmailChannelService } from './email-channel.service';
import { EvolutionApiService } from '../integrations/evolution/evolution-api.service';
import { DEFAULT_WHATSAPP_TEMPLATE, renderAlertEmail, renderTemplate } from './alert-template';

// Deliberately NOT WEB_ORIGIN — that's the local-dev CORS allowlist entry
// (e.g. http://localhost:3535) and would produce links WhatsApp never
// renders as tappable (its link detector requires a real-looking domain)
// and that a recipient's phone could never reach anyway. Alert links always
// point at the real public site.
export const NOTICE_URL_BASE = process.env.PUBLIC_SITE_URL || 'https://suchanaai.tech';

export const CATEGORY_META: Record<string, { emoji: string; label: string }> = {
  NOTICE: { emoji: '📢', label: 'Notice' },
  NEWS: { emoji: '📰', label: 'News' },
  PRESS_RELEASE: { emoji: '📰', label: 'Press Release' },
  CIRCULAR: { emoji: '📋', label: 'Circular' },
  TENDER: { emoji: '📄', label: 'Tender' },
  VACANCY: { emoji: '🧑‍💼', label: 'Vacancy' },
  JOB: { emoji: '💼', label: 'Job' },
  INTERNSHIP: { emoji: '🎓', label: 'Internship' },
  OTHER: { emoji: '🔔', label: 'Other' },
};

const URGENCY_META: Record<string, { emoji: string; label: string; rank: number }> = {
  LOW: { emoji: '🟢', label: 'Low urgency', rank: 1 },
  MEDIUM: { emoji: '🟡', label: 'Medium urgency', rank: 2 },
  HIGH: { emoji: '🔴', label: 'High urgency', rank: 3 },
};

/** Which filter dimensions of a rule were satisfied — used to build the "why did I get this" message line. */
interface MatchResult {
  category?: string;
  tag?: string;
  keyword?: string;
  organization?: string;
  urgency?: boolean;
  deadline?: boolean;
}

/** Outbound channels an alert can be delivered over. */
export type AlertChannel = 'whatsapp' | 'email';

interface DeliveryOutcome {
  channels: AlertChannel[];
  errors: string[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

// Hard cap on the in-memory backlog — if a channel or the DB is down/slow for
// a long stretch during a big scrape run, older queued items are dropped
// rather than growing this unbounded and leaking memory. Alerts are
// best-effort notifications, not a durable delivery guarantee.
const MAX_QUEUE_SIZE = 500;

// A re-scraped notice from years ago is not news. Without this, a source that
// rewrites old rows in one run would flood every matching rule at once.
const MAX_ITEM_AGE_DAYS = Number(process.env.ALERTS_MAX_ITEM_AGE_DAYS ?? 30);

// Backfill window for a freshly created rule, so a new alert proves itself
// against notices that already exist instead of sitting at "0 matches" until
// the next scrape happens to find something.
const BACKFILL_DAYS = Number(process.env.ALERTS_BACKFILL_DAYS ?? 14);
const BACKFILL_SCAN_LIMIT = 300;
const BACKFILL_MATCH_LIMIT = 25;

/**
 * Matches a newly scraped/updated notice against every enabled AlertRule.
 * Each set filter dimension on a rule (categories, tags, keywords,
 * organizations, minUrgency, deadlineWithinDays) is AND'd together; values
 * within one dimension are OR'd. excludeKeywords short-circuits the whole rule.
 *
 * Matching is channel-independent: a match is recorded (and counted against
 * the rule) for every user, whether or not they have WhatsApp connected.
 * Delivery is a separate step that fans out over whichever channels the user
 * actually has — see deliver().
 *
 * Matches are delivered instantly, or left PENDING for AlertDigestService to
 * batch — see recordMatch().
 *
 * `enqueue()` is called synchronously from ScrapingService once a ScrapedItem
 * is persisted *and* enriched — it never throws and never blocks the scrape
 * loop. Items are then drained one at a time in the background: a scrape that
 * discovers many new items at once must not fire dozens of concurrent DB
 * queries + sends (which could exhaust the Prisma connection pool or hammer
 * Evolution API), and a single stuck request must not wedge the rest of the
 * queue — see EvolutionApiService's fetch timeout.
 */
@Injectable()
export class AlertMatchingService {
  private readonly logger = new Logger(AlertMatchingService.name);
  private readonly queue: string[] = [];
  private draining = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly evolutionApi: EvolutionApiService,
    private readonly email: EmailChannelService,
    private readonly quota: QuotaService,
    private readonly settings: SettingsService,
  ) {}

  /** Non-blocking, cannot throw — safe to call inline from the scrape loop. */
  enqueue(itemId: string): void {
    if (this.queue.includes(itemId)) return;
    if (this.queue.length >= MAX_QUEUE_SIZE) {
      this.logger.warn(`Alert matching queue full (${MAX_QUEUE_SIZE}) — dropping item ${itemId}`);
      return;
    }
    this.queue.push(itemId);
    void this.drain();
  }

  /** Serialized worker loop — at most one evaluate() in flight at a time. */
  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      let next: string | undefined;
      while ((next = this.queue.shift())) {
        await this.evaluate(next);
      }
    } finally {
      this.draining = false;
    }
  }

  /**
   * Re-reads the item rather than trusting the caller's copy: tags, urgency,
   * key facts and the AI summary are written by the analyze/extract steps
   * that run after the row is first created, and rules match on all of them.
   */
  async evaluate(itemId: string): Promise<void> {
    try {
      const item = await this.prisma.scrapedItem.findUnique({ where: { id: itemId } });
      if (!item) return;
      if (this.isStale(item)) return;

      const rules = await this.prisma.alertRule.findMany({
        where: { enabled: true, user: { status: 'active' } },
        include: { user: true },
        take: 5000, // safe cap; log if truncated to surface needed pagination
      });
      if (rules.length === 0) return;
      if (rules.length >= 5000) {
        this.logger.warn(`Alert evaluate hit cap 5000 rules for item ${item.id} — some rules were not checked; consider pagination`);
      }

      // A user should get at most one message per notice, even if several of
      // their rules independently match it — first match wins.
      const matchedByUser = new Map<string, { user: User; rule: AlertRule; result: MatchResult }>();
      for (const rule of rules) {
        if (matchedByUser.has(rule.userId)) continue;
        const result = this.evaluateRule(rule, item);
        if (result) matchedByUser.set(rule.userId, { user: rule.user, rule, result });
      }
      if (matchedByUser.size === 0) return;

      for (const { user, rule, result } of matchedByUser.values()) {
        await this.recordMatch(user, rule, result, item);
      }
    } catch (error: any) {
      this.logger.error(`evaluate() failed for item ${itemId}: ${error.message}`);
    }
  }

  /**
   * Match a newly created rule against notices that already exist, so it has
   * a real match count immediately. Recorded as PENDING only — a new rule
   * must never fire a burst of instant messages for a fortnight of backlog.
   */
  async backfillRule(ruleId: string): Promise<number> {
    try {
      const rule = await this.prisma.alertRule.findUnique({ where: { id: ruleId } });
      if (!rule || !rule.enabled) return 0;

      const since = new Date(Date.now() - BACKFILL_DAYS * DAY_MS);
      const items = await this.prisma.scrapedItem.findMany({
        where: { scrapedAt: { gte: since } },
        orderBy: { scrapedAt: 'desc' },
        take: BACKFILL_SCAN_LIMIT,
      });

      let matched = 0;
      for (const item of items) {
        if (matched >= BACKFILL_MATCH_LIMIT) break;
        if (!this.evaluateRule(rule, item)) continue;
        const created = await this.claimMatch(rule, item.id);
        if (created) matched += 1;
      }

      if (matched > 0) {
        this.logger.log(`Backfilled ${matched} match(es) for new rule ${ruleId} (${rule.name})`);
      }
      return matched;
    } catch (error: any) {
      this.logger.error(`backfillRule() failed for rule ${ruleId}: ${error.message}`);
      return 0;
    }
  }

  /**
   * Alerts are about notices that are new *to us*, so this measures discovery
   * (scrapedAt, written once at insert and never touched again) rather than
   * the publish date. A source that rewrites a year of old rows in one run
   * therefore can't flood every matching rule.
   */
  private isStale(item: ScrapedItem): boolean {
    return Date.now() - new Date(item.scrapedAt).getTime() > MAX_ITEM_AGE_DAYS * DAY_MS;
  }

  /** Returns which dimensions matched, or null if the rule doesn't match (or has no filters set). */
  private evaluateRule(rule: AlertRule, item: ScrapedItem): MatchResult | null {
    const hasDimension =
      rule.categories.length > 0 ||
      rule.tags.length > 0 ||
      rule.keywords.length > 0 ||
      rule.organizations.length > 0 ||
      rule.minUrgency != null ||
      rule.deadlineWithinDays != null;
    if (!hasDimension) return null;

    const haystack = this.textHaystack(item);

    if (rule.excludeKeywords.length > 0 && rule.excludeKeywords.some((k) => haystack.includes(k.toLowerCase()))) {
      return null;
    }

    const result: MatchResult = {};

    if (rule.categories.length > 0) {
      if (!rule.categories.includes(item.category)) return null;
      result.category = item.category;
    }

    if (rule.tags.length > 0) {
      const itemTags = this.extractTags(item.tags).map((t) => t.toLowerCase());
      const hit = rule.tags.find((t) => itemTags.includes(t.toLowerCase()));
      if (!hit) return null;
      result.tag = hit;
    }

    if (rule.keywords.length > 0) {
      const hit = rule.keywords.find((k) => haystack.includes(k.toLowerCase()));
      if (!hit) return null;
      result.keyword = hit;
    }

    if (rule.organizations.length > 0) {
      const org = (item.sourceLabel || '').toLowerCase();
      const metaOrg = this.extractMetaOrg(item.metadata).toLowerCase();
      const hit = rule.organizations.find((o) => org.includes(o.toLowerCase()) || (metaOrg && metaOrg.includes(o.toLowerCase())));
      if (!hit) return null;
      result.organization = hit;
    }

    if (rule.minUrgency) {
      const itemRank = item.aiUrgency ? URGENCY_META[item.aiUrgency.toUpperCase()]?.rank ?? 0 : 0;
      if (itemRank < URGENCY_META[rule.minUrgency].rank) return null;
      result.urgency = true;
    }

    if (rule.deadlineWithinDays != null) {
      const deadline = this.extractDeadline(item.metadata);
      const d = deadline ? new Date(deadline) : null;
      if (!d || Number.isNaN(d.getTime())) return null;
      const daysUntil = (d.getTime() - Date.now()) / DAY_MS;
      if (daysUntil < 0 || daysUntil > rule.deadlineWithinDays) return null;
      result.deadline = true;
    }

    return result;
  }

  private textHaystack(item: ScrapedItem): string {
    return [item.title, item.summary, item.aiSummary, item.contentText]
      .filter(Boolean)
      .join(' \n ')
      .toLowerCase();
  }

  private extractMetaOrg(metadata: unknown): string {
    if (!metadata || typeof metadata !== 'object') return '';
    const m = metadata as Record<string, unknown>;
    const val = m.issuingOffice ?? m.organization ?? m.office ?? '';
    return typeof val === 'string' ? val : '';
  }

  private extractDeadline(metadata: unknown): string | null {
    if (!metadata || typeof metadata !== 'object') return null;
    const val = (metadata as Record<string, unknown>).deadline;
    return typeof val === 'string' ? val : null;
  }

  private extractTags(tags: unknown): string[] {
    return Array.isArray(tags) ? (tags as unknown[]).map(String).filter(Boolean) : [];
  }

  private formatDate(iso: string | Date | null): string | null {
    if (!iso) return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    return new Intl.DateTimeFormat('en-US', { day: 'numeric', month: 'short', year: 'numeric' }).format(d);
  }

  private truncate(text: string, max: number): string {
    const clean = text.trim().replace(/\s+/g, ' ');
    return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
  }

  /** Human-readable "why you got this" line from the satisfied dimensions. */
  private matchSummary(result: MatchResult): string {
    const parts: string[] = [];
    if (result.category) parts.push(`category ${CATEGORY_META[result.category]?.label ?? result.category}`);
    if (result.tag) parts.push(`tag "${result.tag}"`);
    if (result.keyword) parts.push(`keyword "${result.keyword}"`);
    if (result.organization) parts.push(`organization "${result.organization}"`);
    if (result.urgency) parts.push('urgency threshold');
    if (result.deadline) parts.push('deadline window');
    return parts.join(', ');
  }

  /** Token values for the message templates — see alert-template.ts's TEMPLATE_TOKENS. */
  private buildTemplateData(rule: AlertRule, result: MatchResult, item: ScrapedItem): Record<string, string> {
    const category = CATEGORY_META[item.category] ?? CATEGORY_META.OTHER;
    const urgency = item.aiUrgency ? URGENCY_META[item.aiUrgency.toUpperCase()] : null;
    const summary = item.aiSummary || item.summary;
    const keyFacts = Array.isArray(item.keyFacts) ? (item.keyFacts as unknown[]).map(String).filter(Boolean) : [];

    return {
      categoryEmoji: category.emoji,
      categoryLabel: category.label,
      title: item.title,
      organization: item.sourceLabel ?? '',
      publishedDate: this.formatDate(item.publishedAt) ?? '',
      deadlineDate: this.formatDate(this.extractDeadline(item.metadata)) ?? '',
      urgencyEmoji: urgency?.emoji ?? '',
      urgencyLabel: urgency?.label ?? '',
      summary: summary ? this.truncate(summary, 320) : '',
      keyFacts: keyFacts.length
        ? keyFacts.slice(0, 5).map((f) => `• ${this.truncate(f, 140)}`).join('\n')
        : '',
      matchReason: this.matchSummary(result),
      ruleName: rule.name,
      // URL alone on its own line in the default template — WhatsApp's link
      // auto-detection is most reliable that way; anything sharing the line
      // risks the link not rendering as tappable on some clients. An admin
      // editing the template should keep that convention.
      noticeUrl: `${NOTICE_URL_BASE.replace(/\/+$/, '')}/notices/${item.id}`,
      manageUrl: `${NOTICE_URL_BASE.replace(/\/+$/, '')}/dashboard/alerts`,
    };
  }

  /** Builds a detailed, formatted WhatsApp alert message (WhatsApp markdown: *bold* _italic_).
   * Renders the admin-configurable template (default: DEFAULT_WHATSAPP_TEMPLATE) —
   * see /admin/alerts' template editor and alert-template.ts. */
  async buildMessage(rule: AlertRule, result: MatchResult, item: ScrapedItem): Promise<string> {
    const template = await this.settings.getString('alerts.whatsappTemplate', DEFAULT_WHATSAPP_TEMPLATE);
    return renderTemplate(template, this.buildTemplateData(rule, result, item));
  }

  // ── match recording ───────────────────────────────────────────────────

  /**
   * Write the match down before attempting any delivery, so `matchCount` is a
   * true count of matches rather than of successful sends — the old behaviour
   * left every rule reading "0 matches" for anyone without WhatsApp.
   *
   * Returns false when this user was already notified about this notice.
   */
  private async claimMatch(rule: AlertRule, itemId: string): Promise<boolean> {
    try {
      await this.prisma.$transaction([
        this.prisma.alertNotification.create({
          data: {
            userId: rule.userId,
            alertRuleId: rule.id,
            scrapedItemId: itemId,
            status: AlertNotificationStatus.PENDING,
          },
        }),
        this.prisma.alertRule.update({
          where: { id: rule.id },
          data: { matchCount: { increment: 1 } },
        }),
      ]);
      return true;
    } catch (error: any) {
      // P2002 = the (userId, scrapedItemId) unique constraint: already matched
      // by an earlier rule or an earlier run. Not an error.
      if (error?.code !== 'P2002') {
        this.logger.error(`claimMatch failed for rule ${rule.id} / item ${itemId}: ${error.message}`);
      }
      return false;
    }
  }

  /** Instant send, or leave PENDING for the next digest — see User.digestFrequency / AlertRule.priority. */
  private async recordMatch(user: User, rule: AlertRule, result: MatchResult, item: ScrapedItem): Promise<void> {
    const claimed = await this.claimMatch(rule, item.id);
    if (!claimed) return;

    const instant = rule.priority === 'HIGH' || user.digestFrequency === 'INSTANT';
    if (!instant) return;

    const outcome = await this.deliver(user, rule, result, item);
    await this.settleNotification(user.id, item.id, outcome);
  }

  /** Persist the result of an instant delivery attempt onto the claimed row. */
  private async settleNotification(userId: string, itemId: string, outcome: DeliveryOutcome): Promise<void> {
    const delivered = outcome.channels.length > 0;
    // A total failure stays PENDING on purpose: the digest sweeps PENDING
    // rows, so a transient SMTP/Evolution outage retries instead of silently
    // losing the alert.
    const status = delivered
      ? AlertNotificationStatus.SENT
      : outcome.errors.length > 0
        ? AlertNotificationStatus.PENDING
        : AlertNotificationStatus.SKIPPED;
    try {
      await this.prisma.alertNotification.update({
        where: { userId_scrapedItemId: { userId, scrapedItemId: itemId } },
        data: {
          status,
          channels: outcome.channels,
          error: outcome.errors.length > 0 ? outcome.errors.join('; ') : null,
        },
      });
    } catch (error: any) {
      this.logger.error(`settleNotification failed for user ${userId} / item ${itemId}: ${error.message}`);
    }
  }

  // ── delivery ──────────────────────────────────────────────────────────

  /**
   * Fan out one match over every channel the user actually has. No channel
   * connected is a normal state, not a failure — the match still shows in the
   * in-app feed on the dashboard.
   */
  private async deliver(user: User, rule: AlertRule, result: MatchResult, item: ScrapedItem): Promise<DeliveryOutcome> {
    const channels: AlertChannel[] = [];
    const errors: string[] = [];

    if (user.whatsappVerified && user.whatsappAlertsEnabled && user.whatsappNumber) {
      // WhatsApp delivery costs money per message, so the plan's monthly cap
      // is enforced by the sender. Over the cap nothing is broken — the
      // allowance is simply spent, so it's noted, not raised as an error.
      if (!(await this.quota.canSendWhatsapp(user.id))) {
        this.logger.log(`WhatsApp quota reached for user ${user.id}; skipping WhatsApp delivery`);
      } else {
        try {
          const text = await this.buildMessage(rule, result, item);
          const sent = await this.evolutionApi.sendText(user.whatsappNumber, text);
          if (sent) {
            channels.push('whatsapp');
            await this.quota.recordWhatsappNotification(user.id, {
              alertRuleId: rule.id,
              scrapedItemId: item.id,
              kind: 'instant',
            });
          } else {
            errors.push('WhatsApp send failed');
          }
        } catch (error: any) {
          errors.push(`WhatsApp send failed: ${error.message}`);
        }
      }
    }

    if (user.emailAlertsEnabled && (await this.email.isReady())) {
      try {
        const mail = renderAlertEmail(this.buildTemplateData(rule, result, item));
        const sent = await this.email.send({ to: user.email, ...mail });
        if (sent) channels.push('email');
        else errors.push('Email send failed');
      } catch (error: any) {
        errors.push(`Email send failed: ${error.message}`);
      }
    }

    return { channels, errors };
  }
}
