import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PlanTier, SubscriptionStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PlansService } from './plans.service';
import { StripeService, StripeSubscription } from './stripe.service';

/** Stripe subscription statuses → ours. Anything unknown is treated as lapsed. */
const STATUS_MAP: Record<string, SubscriptionStatus> = {
  active: SubscriptionStatus.ACTIVE,
  trialing: SubscriptionStatus.TRIALING,
  past_due: SubscriptionStatus.PAST_DUE,
  unpaid: SubscriptionStatus.PAST_DUE,
  canceled: SubscriptionStatus.CANCELED,
  incomplete: SubscriptionStatus.INCOMPLETE,
  incomplete_expired: SubscriptionStatus.CANCELED,
  paused: SubscriptionStatus.CANCELED,
};

@Injectable()
export class SubscriptionsService {
  private readonly logger = new Logger(SubscriptionsService.name);
  private readonly appUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly plans: PlansService,
    private readonly stripe: StripeService,
    private readonly config: ConfigService,
  ) {
    this.appUrl = (this.config.get<string>('APP_URL') ?? 'http://localhost:3000').replace(/\/$/, '');
  }

  /** Start a paid upgrade. Returns the Stripe Checkout URL to redirect to. */
  async createCheckout(user: { id: string; email: string }, tier: PlanTier) {
    if (tier === PlanTier.FREE) {
      throw new BadRequestException('The Free plan does not require checkout.');
    }

    const plan = await this.plans.findByTier(tier);
    if (!plan.stripePriceId) {
      throw new BadRequestException(
        `${plan.name} has no Stripe price configured. An admin must set it in Admin → Plans.`,
      );
    }

    const existing = await this.prisma.subscription.findUnique({ where: { userId: user.id } });

    const session = await this.stripe.createCheckoutSession({
      priceId: plan.stripePriceId,
      userId: user.id,
      email: user.email,
      customerId: existing?.stripeCustomerId,
      successUrl: `${this.appUrl}/dashboard/billing?checkout=success`,
      cancelUrl: `${this.appUrl}/pricing?checkout=cancelled`,
    });

    this.logger.log(`Checkout session ${session.id} created for user ${user.id} (${tier})`);
    return { url: session.url, sessionId: session.id };
  }

  /** Open Stripe's billing portal for an existing customer. */
  async createPortalSession(userId: string) {
    const subscription = await this.prisma.subscription.findUnique({ where: { userId } });
    if (!subscription?.stripeCustomerId) {
      throw new BadRequestException(
        'No billing account yet — subscribe to a paid plan first.',
      );
    }
    return this.stripe.createPortalSession(
      subscription.stripeCustomerId,
      `${this.appUrl}/dashboard/billing`,
    );
  }

  /**
   * Write Stripe's view of a subscription into our database.
   *
   * Idempotent by design: webhooks arrive out of order and more than once, so
   * this always upserts from the full object rather than applying deltas.
   */
  async syncFromStripe(sub: StripeSubscription, fallbackUserId?: string): Promise<void> {
    const priceId = sub.items?.data?.[0]?.price?.id;
    const plan = priceId ? await this.plans.findByStripePriceId(priceId) : undefined;

    if (!plan) {
      this.logger.warn(
        `Stripe subscription ${sub.id} references price ${priceId} which matches no plan — ignoring`,
      );
      return;
    }

    const userId = sub.metadata?.userId ?? fallbackUserId;
    const existing = userId
      ? await this.prisma.subscription.findUnique({ where: { userId } })
      : await this.prisma.subscription.findUnique({ where: { stripeSubscriptionId: sub.id } });

    const targetUserId = existing?.userId ?? userId;
    if (!targetUserId) {
      this.logger.warn(`Stripe subscription ${sub.id} has no resolvable user — ignoring`);
      return;
    }

    // An admin grant is a deliberate override; Stripe must not undo it.
    if (existing?.grantedByAdmin) {
      this.logger.log(`Skipping Stripe sync for ${targetUserId}: plan was granted by an admin`);
      return;
    }

    const status = STATUS_MAP[sub.status] ?? SubscriptionStatus.CANCELED;
    const data = {
      planId: plan.id,
      status,
      stripeCustomerId: sub.customer,
      stripeSubscriptionId: sub.id,
      currentPeriodStart: sub.current_period_start
        ? new Date(sub.current_period_start * 1000)
        : null,
      currentPeriodEnd: sub.current_period_end ? new Date(sub.current_period_end * 1000) : null,
      cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end),
      canceledAt: sub.canceled_at ? new Date(sub.canceled_at * 1000) : null,
    };

    await this.prisma.subscription.upsert({
      where: { userId: targetUserId },
      create: { userId: targetUserId, ...data },
      update: data,
    });

    this.logger.log(
      `Subscription synced: user=${targetUserId} plan=${plan.tier} status=${status}`,
    );
  }

  /** Handle one verified webhook event. Unknown types are ignored, not errors. */
  async handleWebhookEvent(event: { type: string; data: { object: any } }): Promise<void> {
    const object = event.data?.object ?? {};

    switch (event.type) {
      case 'checkout.session.completed': {
        // The session itself carries only ids; fetch the subscription so the
        // stored period/status match Stripe exactly.
        const subscriptionId = object.subscription;
        const userId = object.client_reference_id ?? object.metadata?.userId;
        if (!subscriptionId) return;
        const sub = await this.stripe.retrieveSubscription(subscriptionId);
        await this.syncFromStripe(sub, userId);
        return;
      }

      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        await this.syncFromStripe(object as StripeSubscription);
        return;

      case 'invoice.payment_failed': {
        // Stripe will also send subscription.updated, but reacting here makes
        // the past-due state visible immediately.
        const customerId = object.customer;
        if (!customerId) return;
        await this.prisma.subscription.updateMany({
          where: { stripeCustomerId: customerId, grantedByAdmin: false },
          data: { status: SubscriptionStatus.PAST_DUE },
        });
        this.logger.warn(`Payment failed for Stripe customer ${customerId}`);
        return;
      }

      default:
        this.logger.debug(`Ignoring Stripe event ${event.type}`);
    }
  }

  /** Admin: grant or change a plan by hand, bypassing Stripe entirely. */
  async grantPlan(userId: string, tier: PlanTier, note?: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!user) throw new NotFoundException(`User ${userId} not found`);

    const plan = await this.plans.findByTier(tier);

    const subscription = await this.prisma.subscription.upsert({
      where: { userId },
      create: {
        userId,
        planId: plan.id,
        status: SubscriptionStatus.ACTIVE,
        grantedByAdmin: true,
        grantNote: note,
      },
      update: {
        planId: plan.id,
        status: SubscriptionStatus.ACTIVE,
        grantedByAdmin: true,
        grantNote: note,
        canceledAt: null,
        cancelAtPeriodEnd: false,
      },
      include: { plan: true },
    });

    this.logger.log(`Admin granted ${tier} to user ${userId}${note ? ` (${note})` : ''}`);
    return subscription;
  }

  /** List Stripe invoices for a user — empty for Free / admin-granted plans. */
  async listInvoicesForUser(userId: string, limit = 12) {
    const subscription = await this.prisma.subscription.findUnique({
      where: { userId },
      select: { stripeCustomerId: true, grantedByAdmin: true },
    });
    if (!subscription?.stripeCustomerId) return [];
    if (!this.stripe.isConfigured) return [];
    try {
      const invoices = await this.stripe.listInvoices(subscription.stripeCustomerId, limit);
      return invoices.map((inv) => ({
        id: inv.id,
        number: inv.number,
        status: inv.status,
        currency: inv.currency,
        amountDue: inv.amount_due,
        amountPaid: inv.amount_paid,
        amountRemaining: inv.amount_remaining,
        created: inv.created ? new Date(inv.created * 1000).toISOString() : null,
        hostedInvoiceUrl: inv.hosted_invoice_url,
        invoicePdf: inv.invoice_pdf,
        periodStart: inv.period_start ? new Date(inv.period_start * 1000).toISOString() : null,
        periodEnd: inv.period_end ? new Date(inv.period_end * 1000).toISOString() : null,
        billingReason: inv.billing_reason,
      }));
    } catch (err) {
      this.logger.warn(`Failed to list invoices for user ${userId}: ${(err as Error).message}`);
      return [];
    }
  }

  /** Admin: revoke a manual grant, returning the user to Free. */
  async revokeGrant(userId: string) {
    const existing = await this.prisma.subscription.findUnique({ where: { userId } });
    if (!existing) throw new NotFoundException('This user has no subscription to revoke.');

    if (!existing.grantedByAdmin) {
      throw new BadRequestException(
        'This is a paid Stripe subscription — cancel it from the billing portal instead.',
      );
    }

    await this.prisma.subscription.delete({ where: { userId } });
    this.logger.log(`Admin grant revoked for user ${userId}`);
    return { revoked: true };
  }
}
