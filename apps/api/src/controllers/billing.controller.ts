import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PlanTier, User } from '@prisma/client';
import type { Request } from 'express';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { CurrentUser } from '../decorators/current-user.decorator';
import { PlansService } from '../services/plans.service';
import { QuotaService } from '../services/quota.service';
import { SubscriptionsService } from '../services/subscriptions.service';
import { StripeService } from '../services/stripe.service';

/** Public plan catalogue — powers the pricing page for signed-out visitors. */
@ApiTags('plans')
@Controller('plans')
export class PlansController {
  constructor(private readonly plans: PlansService) {}

  @Get()
  @ApiOperation({ summary: 'Publicly listed membership plans' })
  async list() {
    const plans = await this.plans.listPublic();
    // Never expose Stripe ids to anonymous callers; they're admin config.
    return plans.map((p) => ({
      tier: p.tier,
      name: p.name,
      tagline: p.tagline,
      description: p.description,
      priceMonthlyCents: p.priceMonthlyCents,
      priceYearlyCents: p.priceYearlyCents,
      currency: p.currency,
      features: p.features ?? [],
      limits: PlansService.limitsOf(p),
      sortOrder: p.sortOrder,
      purchasable: Boolean(p.stripePriceId) && p.priceMonthlyCents > 0,
    }));
  }
}

@ApiTags('billing')
@Controller('billing')
@UseGuards(JwtAuthGuard)
export class BillingController {
  constructor(
    private readonly quota: QuotaService,
    private readonly subscriptions: SubscriptionsService,
    private readonly stripe: StripeService,
  ) {}

  /** Current plan, limits and this month's usage against each of them. */
  @Get('me')
  @ApiOperation({ summary: 'Current plan, entitlements and usage' })
  async me(@CurrentUser() user: User) {
    const entitlements = await this.quota.entitlementsFor(user.id);
    return { ...entitlements, paymentsConfigured: this.stripe.isConfigured };
  }

  /** Recent Stripe invoices for the signed-in user (empty if Free or not a Stripe customer). */
  @Get('invoices')
  @ApiOperation({ summary: 'Recent invoices for the current user' })
  async invoices(@CurrentUser() user: User) {
    return this.subscriptions.listInvoicesForUser(user.id);
  }

  /** Begin an upgrade: returns a Stripe Checkout URL to redirect to. */
  @Post('checkout')
  @ApiOperation({ summary: 'Create a Stripe Checkout session' })
  async checkout(@CurrentUser() user: User, @Body('tier') tier?: string) {
    const requested = (tier ?? '').toUpperCase();
    if (requested !== PlanTier.PRO && requested !== PlanTier.MAX) {
      throw new BadRequestException("tier must be 'PRO' or 'MAX'");
    }
    return this.subscriptions.createCheckout(
      { id: user.id, email: user.email },
      requested as PlanTier,
    );
  }

  /** Manage an existing subscription in Stripe's hosted portal. */
  @Post('portal')
  @ApiOperation({ summary: 'Create a Stripe billing portal session' })
  async portal(@CurrentUser() user: User) {
    return this.subscriptions.createPortalSession(user.id);
  }
}

/**
 * Stripe webhook receiver.
 *
 * Unauthenticated by design — Stripe can't carry our JWT. Authenticity comes
 * from the signature over the *raw* body, so this reads `req.rawBody` (enabled
 * via `rawBody: true` in main.ts); the parsed body would have different bytes
 * and every signature would fail.
 */
@ApiTags('billing')
@Controller('webhooks')
export class StripeWebhookController {
  constructor(
    private readonly stripe: StripeService,
    private readonly subscriptions: SubscriptionsService,
  ) {}

  @Post('stripe')
  async handle(@Req() req: Request & { rawBody?: Buffer }) {
    const signature = req.headers['stripe-signature'];
    const raw = req.rawBody;

    if (!raw) {
      throw new BadRequestException(
        'Raw request body unavailable — Stripe signatures cannot be verified.',
      );
    }

    const event = this.stripe.verifyWebhook(raw, Array.isArray(signature) ? signature[0] : signature ?? '');

    // Acknowledge fast: Stripe retries on timeout, and a slow handler turns
    // one event into duplicates. Processing is idempotent, so returning before
    // it finishes is safe.
    void this.subscriptions.handleWebhookEvent(event);

    return { received: true };
  }
}
