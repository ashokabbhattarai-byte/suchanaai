import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { PlanTier, UsageMetric } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PlansService } from './plans.service';
import { UsageService } from './usage.service';

/** Machine-readable reasons, so the UI can tailor the upgrade prompt. */
export type QuotaKind =
  | 'ai_questions'
  | 'documents'
  | 'alert_rules'
  | 'whatsapp_notifications'
  | 'upload_size'
  | 'instant_alerts'
  // Signed-out visitor spent their free chats. Not a plan limit — the fix is
  // to sign in, not to pay — so the UI shows a sign-in CTA, not a price page.
  | 'anonymous_ai_questions';

export interface QuotaDenial {
  kind: QuotaKind;
  limit: number | null;
  used: number;
  tier: PlanTier;
  message: string;
}

/**
 * 402 Payment Required — the one status that unambiguously means "your plan
 * doesn't cover this". The body carries `quota` so the frontend can show the
 * right meter and a targeted upgrade CTA instead of a generic error toast.
 */
export class QuotaExceededException extends HttpException {
  constructor(readonly denial: QuotaDenial) {
    super(
      {
        statusCode: HttpStatus.PAYMENT_REQUIRED,
        error: 'Payment Required',
        message: denial.message,
        quota: denial,
      },
      HttpStatus.PAYMENT_REQUIRED,
    );
  }
}

/**
 * Plan enforcement.
 *
 * Every check is "assert, then record" — never record first. A refused request
 * must not consume allowance, otherwise a user at their limit would burn quota
 * on requests that returned an error.
 *
 * Downgrades never delete data: `assertCanAddDocument` blocks *new* uploads
 * while over the cap, but existing documents stay readable. That's the
 * agreed hard-block behaviour, applied only to new usage.
 */
@Injectable()
export class QuotaService {
  private readonly logger = new Logger(QuotaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly plans: PlansService,
    private readonly usage: UsageService,
  ) {}

  private deny(denial: QuotaDenial): never {
    this.logger.log(
      `Quota denied (${denial.kind}) for tier=${denial.tier}: ${denial.used}/${denial.limit}`,
    );
    throw new QuotaExceededException(denial);
  }

  /** Monthly AI questions: RAG chat, notice Q&A and the public chatbot.
   *  Uses FOR UPDATE on the counter row to serialize concurrent checks for the
   *  same user/month.
   */
  async assertCanAskAi(userId: string): Promise<void> {
    const { plan, limits } = await this.plans.effectivePlanFor(userId);
    if (limits.maxAiQuestionsPerMonth === null) return;

    const periodStart = this.usage.currentPeriodStart();
    await this.prisma.$transaction(async (tx) => {
      // Lock the counter row if it exists; otherwise lock the user row to serialize first creation.
      const existing = await tx.usageCounter.findUnique({
        where: { userId_metric_periodStart: { userId, metric: UsageMetric.AI_QUESTION, periodStart } },
        select: { count: true },
      });
      if (existing) {
        await tx.$executeRaw`SELECT 1 FROM "usage_counters" WHERE user_id = ${userId}::uuid AND metric = ${UsageMetric.AI_QUESTION}::"UsageMetric" AND period_start = ${periodStart}::timestamptz FOR UPDATE`;
      } else {
        await tx.$executeRaw`SELECT 1 FROM "users" WHERE id = ${userId}::uuid FOR UPDATE`;
      }
      const used = existing?.count ?? 0;
      const limit = limits.maxAiQuestionsPerMonth!;
      if (used >= limit) {
        this.deny({
          kind: 'ai_questions',
          limit,
          used,
          tier: plan.tier,
          message: `You've used all ${limit} AI questions included in ${plan.name} this month. Upgrade for a bigger allowance.`,
        });
      }
    });
  }

  recordAiQuestion(userId: string, context?: Record<string, unknown>) {
    return this.usage.record(userId, UsageMetric.AI_QUESTION, 1, context);
  }

  // ── Signed-out visitors ────────────────────────────────────────────────
  // A taste of the assistant without an account, then a sign-in wall. Counted
  // per client per UTC day: a lifetime cap would permanently lock out everyone
  // behind a shared office or campus NAT, who look like one client here.

  private get anonDailyLimit(): number {
    const raw = Number(process.env.ANON_AI_QUESTIONS_PER_DAY ?? 5);
    return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 5;
  }

  /** Midnight UTC today — the bucket an anonymous counter belongs to. */
  private currentAnonDay(): Date {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  }

  /**
   * Salted SHA-256 of the caller's IP. Salted so the table can't be brute-forced
   * back to an address list — the IPv4 space is small enough to enumerate
   * against an unsalted hash in minutes.
   */
  hashClient(ip: string | undefined): string {
    const salt =
      process.env.ANON_QUOTA_SALT || process.env.JWT_SECRET || 'pnm-anon-quota';
    return createHash('sha256').update(`${salt}:${ip ?? 'unknown'}`).digest('hex');
  }

  /**
   * Assert a signed-out visitor still has free chats today.
   *
   * Read-only: the increment is a separate call made only once the answer
   * actually came back, matching the "assert, then record" rule above — a
   * failed request must not spend a visitor's small allowance.
   */
  async assertAnonymousCanAskAi(clientHash: string): Promise<void> {
    const limit = this.anonDailyLimit;
    if (limit === 0) {
      this.deny({
        kind: 'anonymous_ai_questions',
        limit: 0,
        used: 0,
        tier: PlanTier.FREE,
        message: 'Sign in to use the assistant.',
      });
    }

    const row = await this.prisma.anonAiUsage.findUnique({
      where: { clientHash_day: { clientHash, day: this.currentAnonDay() } },
      select: { count: true },
    });
    const used = row?.count ?? 0;
    if (used >= limit) {
      this.deny({
        kind: 'anonymous_ai_questions',
        limit,
        used,
        tier: PlanTier.FREE,
        message: `You've used your ${limit} free question${limit === 1 ? '' : 's'} for today. Sign in to keep asking — it's free.`,
      });
    }
  }

  /**
   * Spend one free chat. The upsert is atomic, so two questions racing from the
   * same client both count instead of one overwriting the other's read.
   */
  async recordAnonymousAiQuestion(clientHash: string): Promise<void> {
    const day = this.currentAnonDay();
    await this.prisma.anonAiUsage.upsert({
      where: { clientHash_day: { clientHash, day } },
      create: { clientHash, day, count: 1 },
      update: { count: { increment: 1 } },
    });
  }

  /** Free chats left today, for the banner the UI shows before the wall. */
  async anonymousRemaining(clientHash: string): Promise<{ used: number; limit: number }> {
    const row = await this.prisma.anonAiUsage.findUnique({
      where: { clientHash_day: { clientHash, day: this.currentAnonDay() } },
      select: { count: true },
    });
    return { used: row?.count ?? 0, limit: this.anonDailyLimit };
  }

  /**
   * Documents are a *stock*, not a flow: the cap is on how many a user keeps
   * embedded at once, so deleting one frees a slot.
   *
   * Uses SELECT FOR UPDATE on the user row to serialize concurrent uploads
   * for the same user — prevents TOCTOU where two parallel requests both see
   * count=limit-1 and both succeed.
   */
  async assertCanAddDocument(userId: string, fileSizeBytes?: number): Promise<void> {
    const { plan, limits } = await this.plans.effectivePlanFor(userId);

    if (fileSizeBytes !== undefined) {
      const maxBytes = limits.maxUploadMb * 1024 * 1024;
      if (fileSizeBytes > maxBytes) {
        this.deny({
          kind: 'upload_size',
          limit: limits.maxUploadMb,
          used: Math.round(fileSizeBytes / 1024 / 1024),
          tier: plan.tier,
          message: `This file is ${(fileSizeBytes / 1024 / 1024).toFixed(1)} MB. ${plan.name} allows uploads up to ${limits.maxUploadMb} MB.`,
        });
      }
    }

    if (limits.maxDocuments === null) return;

    // Serialize per-user document count checks via row-level lock.
    const docLimit = limits.maxDocuments!;
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT 1 FROM "users" WHERE id = ${userId}::uuid FOR UPDATE`;
      const owned = await tx.document.count({ where: { uploadedBy: userId } });
      if (owned >= docLimit) {
        this.deny({
          kind: 'documents',
          limit: docLimit,
          used: owned,
          tier: plan.tier,
          message: `${plan.name} includes ${docLimit} documents and you have ${owned}. Delete one or upgrade to add more.`,
        });
      }
    });
  }

  recordDocumentUpload(userId: string, context?: Record<string, unknown>) {
    return this.usage.record(userId, UsageMetric.DOCUMENT_UPLOAD, 1, context);
  }

  /** Alert rules are a stock too — the cap is on rules held, not created. */
  async assertCanAddAlertRule(userId: string): Promise<void> {
    const { plan, limits } = await this.plans.effectivePlanFor(userId);
    if (limits.maxAlertRules === null) return;

    const ruleLimit = limits.maxAlertRules!;
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT 1 FROM "users" WHERE id = ${userId}::uuid FOR UPDATE`;
      const owned = await tx.alertRule.count({ where: { userId } });
      if (owned >= ruleLimit) {
        this.deny({
          kind: 'alert_rules',
          limit: ruleLimit,
          used: owned,
          tier: plan.tier,
          message: `${plan.name} includes ${ruleLimit} alert rules and you have ${owned}. Delete one or upgrade for more.`,
        });
      }
    });
  }

  /**
   * Instant delivery is a paid feature; free users are held to a digest.
   * Returns the cadence the user is actually allowed, so callers can degrade
   * gracefully instead of failing a settings save.
   */
  async canUseInstantAlerts(userId: string): Promise<boolean> {
    const { limits } = await this.plans.effectivePlanFor(userId);
    return limits.allowInstantAlerts;
  }

  async assertCanUseInstantAlerts(userId: string): Promise<void> {
    const { plan, limits } = await this.plans.effectivePlanFor(userId);
    if (limits.allowInstantAlerts) return;
    this.deny({
      kind: 'instant_alerts',
      limit: null,
      used: 0,
      tier: plan.tier,
      message: `Instant alerts are a paid feature. ${plan.name} delivers a daily digest instead.`,
    });
  }

  /**
   * WhatsApp deliveries cost real money per message, so this is checked by the
   * *sender* rather than a user request. It returns a boolean instead of
   * throwing: a delivery that would exceed the cap is skipped and logged, not
   * an error surfaced to anyone.
   */
  async canSendWhatsapp(userId: string): Promise<boolean> {
    const { limits } = await this.plans.effectivePlanFor(userId);
    if (limits.maxWhatsappPerMonth === null) return true;
    if (limits.maxWhatsappPerMonth === 0) return false;

    const used = await this.usage.currentCount(userId, UsageMetric.WHATSAPP_NOTIFICATION);
    return used < limits.maxWhatsappPerMonth;
  }

  recordWhatsappNotification(userId: string, context?: Record<string, unknown>) {
    return this.usage.record(userId, UsageMetric.WHATSAPP_NOTIFICATION, 1, context);
  }

  /** Everything the billing panel needs: plan, limits and usage vs each. */
  async entitlementsFor(userId: string) {
    const [effective, usage, documents, alertRules] = await Promise.all([
      this.plans.effectivePlanFor(userId),
      this.usage.snapshotFor(userId),
      this.prisma.document.count({ where: { uploadedBy: userId } }),
      this.prisma.alertRule.count({ where: { userId } }),
    ]);

    const meter = (used: number, limit: number | null) => ({
      used,
      limit,
      remaining: limit === null ? null : Math.max(0, limit - used),
      exceeded: limit !== null && used >= limit,
    });

    return {
      plan: {
        tier: effective.plan.tier,
        name: effective.plan.name,
        tagline: effective.plan.tagline,
        priceMonthlyCents: effective.plan.priceMonthlyCents,
        currency: effective.plan.currency,
      },
      status: effective.status,
      isDefault: effective.isDefault,
      currentPeriodEnd: effective.currentPeriodEnd,
      cancelAtPeriodEnd: effective.cancelAtPeriodEnd,
      limits: effective.limits,
      usage: {
        aiQuestions: meter(usage.aiQuestions, effective.limits.maxAiQuestionsPerMonth),
        documents: meter(documents, effective.limits.maxDocuments),
        alertRules: meter(alertRules, effective.limits.maxAlertRules),
        whatsappNotifications: meter(
          usage.whatsappNotifications,
          effective.limits.maxWhatsappPerMonth,
        ),
        periodStart: usage.periodStart,
        periodEnd: usage.periodEnd,
      },
    };
  }
}
