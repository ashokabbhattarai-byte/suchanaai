import { Injectable, Logger } from '@nestjs/common';
import { AlertRule, ScrapedItem, User } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { QuotaService } from './quota.service';
import { SettingsService } from './settings.service';
import { EvolutionApiService } from '../integrations/evolution/evolution-api.service';
import { DEFAULT_WHATSAPP_TEMPLATE, renderTemplate } from './alert-template';

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

// Hard cap on the in-memory backlog — if Evolution API or the DB is down/slow
// for a long stretch during a big scrape run, older queued items are dropped
// rather than growing this unbounded and leaking memory. Alerts are
// best-effort notifications, not a durable delivery guarantee.
const MAX_QUEUE_SIZE = 500;

/**
 * Matches a newly scraped/updated notice against every enabled AlertRule
 * belonging to a user who has verified + enabled WhatsApp alerts. Each set
 * filter dimension on a rule (categories, tags, keywords, organizations,
 * minUrgency, deadlineWithinDays) is AND'd together; values within one
 * dimension are OR'd. excludeKeywords short-circuits the whole rule.
 *
 * Matches are delivered instantly, or queued as PENDING for
 * AlertDigestService to batch — see recordMatch().
 *
 * `enqueue()` is called synchronously from ScrapingService right after each
 * ScrapedItem is persisted — it never throws and never blocks the scrape
 * loop. Items are then drained one at a time in the background: a scrape
 * that discovers many new items at once must not fire dozens of concurrent
 * DB queries + WhatsApp sends (which could exhaust the Prisma connection
 * pool or hammer Evolution API), and a single stuck WhatsApp request must
 * not wedge the rest of the queue — see EvolutionApiService's fetch timeout.
 */
@Injectable()
export class AlertMatchingService {
  private readonly logger = new Logger(AlertMatchingService.name);
  private readonly queue: ScrapedItem[] = [];
  private draining = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly evolutionApi: EvolutionApiService,
    private readonly quota: QuotaService,
    private readonly settings: SettingsService,
  ) {}

  /** Non-blocking, cannot throw — safe to call inline from the scrape loop. */
  enqueue(item: ScrapedItem): void {
    if (this.queue.length >= MAX_QUEUE_SIZE) {
      this.logger.warn(`Alert matching queue full (${MAX_QUEUE_SIZE}) — dropping item ${item.id}`);
      return;
    }
    this.queue.push(item);
    void this.drain();
  }

  /** Serialized worker loop — at most one evaluate() in flight at a time. */
  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      let next: ScrapedItem | undefined;
      while ((next = this.queue.shift())) {
        await this.evaluate(next);
      }
    } finally {
      this.draining = false;
    }
  }

  async evaluate(item: ScrapedItem): Promise<void> {
    try {
      const rules = await this.prisma.alertRule.findMany({
        where: {
          enabled: true,
          user: { whatsappAlertsEnabled: true, whatsappVerified: true },
        },
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
      this.logger.error(`evaluate() failed for item ${item.id}: ${error.message}`);
    }
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
      const daysUntil = (d.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
      if (daysUntil < 0 || daysUntil > rule.deadlineWithinDays) return null;
      result.deadline = true;
    }

    return result;
  }

  private textHaystack(item: ScrapedItem): string {
    return [item.title, item.summary, item.contentText].filter(Boolean).join(' \n ').toLowerCase();
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

  /** Token values for the WhatsApp template — see alert-template.ts's TEMPLATE_TOKENS. */
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

  /** Instant send, or queue as PENDING for the next digest — see User.digestFrequency / AlertRule.priority. */
  private async recordMatch(user: User, rule: AlertRule, result: MatchResult, item: ScrapedItem): Promise<void> {
    const instant = rule.priority === 'HIGH' || user.digestFrequency === 'INSTANT';
    if (instant) {
      await this.notifyOne(user, rule, result, item);
      return;
    }
    try {
      await this.prisma.alertNotification.upsert({
        where: { userId_scrapedItemId: { userId: user.id, scrapedItemId: item.id } },
        create: { userId: user.id, alertRuleId: rule.id, scrapedItemId: item.id, status: 'PENDING' },
        update: {},
      });
      await this.prisma.alertRule.update({ where: { id: rule.id }, data: { matchCount: { increment: 1 } } });
    } catch (error: any) {
      this.logger.error(`queue-for-digest failed for user ${user.id} / item ${item.id}: ${error.message}`);
    }
  }

  private async notifyOne(user: User, rule: AlertRule, result: MatchResult, item: ScrapedItem): Promise<void> {
    const text = await this.buildMessage(rule, result, item);

    // WhatsApp delivery costs money per message, so the plan's monthly cap is
    // enforced by the sender. Over the cap the notification is recorded as
    // SKIPPED rather than failed — nothing is broken, the allowance is spent.
    if (!(await this.quota.canSendWhatsapp(user.id))) {
      this.logger.log(`WhatsApp quota reached for user ${user.id}; skipping alert delivery`);
      await this.prisma.alertNotification.upsert({
        where: { userId_scrapedItemId: { userId: user.id, scrapedItemId: item.id } },
        create: {
          userId: user.id,
          alertRuleId: rule.id,
          scrapedItemId: item.id,
          status: 'FAILED',
          error: 'Monthly WhatsApp allowance reached for this plan',
        },
        update: { status: 'FAILED', error: 'Monthly WhatsApp allowance reached for this plan' },
      });
      return;
    }

    try {
      const sent = await this.evolutionApi.sendText(user.whatsappNumber!, text);
      if (sent) {
        await this.quota.recordWhatsappNotification(user.id, {
          alertRuleId: rule.id,
          scrapedItemId: item.id,
          kind: 'instant',
        });
      }
      await this.prisma.alertNotification.upsert({
        where: { userId_scrapedItemId: { userId: user.id, scrapedItemId: item.id } },
        create: {
          userId: user.id,
          alertRuleId: rule.id,
          scrapedItemId: item.id,
          status: sent ? 'SENT' : 'FAILED',
          error: sent ? null : 'Evolution API send failed',
        },
        update: { status: sent ? 'SENT' : 'FAILED', error: sent ? null : 'Evolution API send failed' },
      });
      if (sent) {
        await this.prisma.alertRule.update({
          where: { id: rule.id },
          data: { matchCount: { increment: 1 } },
        });
      }
    } catch (error: any) {
      this.logger.error(`notifyOne failed for user ${user.id} / item ${item.id}: ${error.message}`);
    }
  }
}
