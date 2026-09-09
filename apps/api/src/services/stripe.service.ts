import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import * as crypto from 'crypto';

/**
 * Stripe client over the REST API.
 *
 * Deliberately dependency-free rather than pulling in the `stripe` SDK: the
 * surface we need is four calls (create checkout session, create portal
 * session, read a subscription, read a customer) plus webhook signature
 * verification. Swapping to the official SDK later is a drop-in replacement
 * for this class — nothing outside it knows how Stripe is reached.
 *
 * Stripe's API takes form-encoded bodies, including for nested objects, hence
 * the `toForm` flattening below.
 */
@Injectable()
export class StripeService {
  private readonly logger = new Logger(StripeService.name);
  private readonly apiBase = 'https://api.stripe.com/v1';
  private readonly secretKey: string;
  private readonly webhookSecret: string;

  constructor(
    private readonly config: ConfigService,
    private readonly http: HttpService,
  ) {
    this.secretKey = this.config.get<string>('STRIPE_SECRET_KEY') ?? '';
    this.webhookSecret = this.config.get<string>('STRIPE_WEBHOOK_SECRET') ?? '';

    if (!this.secretKey) {
      this.logger.warn(
        'STRIPE_SECRET_KEY is not set — checkout and portal will return 503 until it is configured',
      );
    }
  }

  get isConfigured(): boolean {
    return Boolean(this.secretKey);
  }

  /** Stripe wants `a[b][c]=v` form encoding, not JSON. */
  private toForm(data: Record<string, unknown>, prefix = ''): string[] {
    const parts: string[] = [];
    for (const [key, value] of Object.entries(data)) {
      if (value === undefined || value === null) continue;
      const field = prefix ? `${prefix}[${key}]` : key;
      if (typeof value === 'object' && !Array.isArray(value)) {
        parts.push(...this.toForm(value as Record<string, unknown>, field));
      } else if (Array.isArray(value)) {
        value.forEach((item, i) => {
          if (typeof item === 'object' && item !== null) {
            parts.push(...this.toForm(item as Record<string, unknown>, `${field}[${i}]`));
          } else {
            parts.push(`${encodeURIComponent(`${field}[${i}]`)}=${encodeURIComponent(String(item))}`);
          }
        });
      } else {
        parts.push(`${encodeURIComponent(field)}=${encodeURIComponent(String(value))}`);
      }
    }
    return parts;
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: Record<string, unknown>,
    idempotencyKey?: string,
  ): Promise<T> {
    if (!this.isConfigured) {
      throw new ServiceUnavailableException(
        'Payments are not configured on this server (STRIPE_SECRET_KEY missing).',
      );
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    };
    // Protects against double-charging when a client retries a checkout POST.
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

    try {
      const response = await firstValueFrom(
        this.http.request<T>({
          method,
          url: `${this.apiBase}${path}`,
          headers,
          data: body ? this.toForm(body).join('&') : undefined,
          timeout: 20_000,
        }),
      );
      return response.data;
    } catch (err: any) {
      // Stripe explains itself in error.message; axios would otherwise reduce
      // this to "Request failed with status code 400".
      const stripeMessage = err.response?.data?.error?.message;
      this.logger.error(`Stripe ${method} ${path} failed: ${stripeMessage ?? err.message}`);
      throw new BadRequestException(
        stripeMessage ? `Stripe: ${stripeMessage}` : `Stripe request failed: ${err.message}`,
      );
    }
  }

  /**
   * Hosted Checkout for a subscription. Returns the URL to redirect to.
   *
   * `client_reference_id` and `metadata.userId` both carry our user id so the
   * webhook can attribute the subscription even if the customer record is new.
   */
  async createCheckoutSession(params: {
    priceId: string;
    userId: string;
    email: string;
    successUrl: string;
    cancelUrl: string;
    customerId?: string | null;
  }): Promise<{ id: string; url: string }> {
    const body: Record<string, unknown> = {
      mode: 'subscription',
      'line_items[0][price]': params.priceId,
      'line_items[0][quantity]': 1,
      success_url: params.successUrl,
      cancel_url: params.cancelUrl,
      client_reference_id: params.userId,
      allow_promotion_codes: true,
      metadata: { userId: params.userId },
      subscription_data: { metadata: { userId: params.userId } },
    };

    // Reuse the existing customer so a returning subscriber keeps one billing
    // history instead of accumulating duplicate customers.
    if (params.customerId) body.customer = params.customerId;
    else body.customer_email = params.email;

    const session = await this.request<{ id: string; url: string }>(
      'POST',
      '/checkout/sessions',
      body,
    );
    return { id: session.id, url: session.url };
  }

  /** Stripe-hosted portal: upgrades, downgrades, cancel, invoices, cards. */
  async createPortalSession(customerId: string, returnUrl: string): Promise<{ url: string }> {
    return this.request<{ url: string }>('POST', '/billing_portal/sessions', {
      customer: customerId,
      return_url: returnUrl,
    });
  }

  /** List recent invoices for a Stripe customer (latest first). */
  async listInvoices(customerId: string, limit = 12): Promise<StripeInvoice[]> {
    if (!customerId) return [];
    const res = await this.request<{ data: StripeInvoice[] }>(
      'GET',
      `/invoices?customer=${encodeURIComponent(customerId)}&limit=${Math.min(Math.max(limit, 1), 100)}`,
    );
    return res.data ?? [];
  }

  async retrieveSubscription(subscriptionId: string): Promise<StripeSubscription> {
    return this.request<StripeSubscription>('GET', `/subscriptions/${subscriptionId}`);
  }

  /**
   * Verify a webhook came from Stripe.
   *
   * The `Stripe-Signature` header is `t=<timestamp>,v1=<hmac>` where the HMAC
   * is SHA-256 over `<timestamp>.<raw body>` keyed by the webhook secret. The
   * raw body matters: any re-serialisation changes the bytes and breaks the
   * signature, which is why the controller reads it before JSON parsing.
   */
  verifyWebhook(rawBody: Buffer | string, signatureHeader: string, toleranceSeconds = 300): any {
    if (!this.webhookSecret) {
      throw new BadRequestException('STRIPE_WEBHOOK_SECRET is not configured');
    }
    if (!signatureHeader) {
      throw new BadRequestException('Missing Stripe-Signature header');
    }

    const parts = signatureHeader.split(',').reduce<Record<string, string[]>>((acc, part) => {
      const [key, value] = part.split('=');
      if (!key || !value) return acc;
      (acc[key.trim()] ??= []).push(value.trim());
      return acc;
    }, {});

    const timestamp = parts['t']?.[0];
    const signatures = parts['v1'] ?? [];
    if (!timestamp || signatures.length === 0) {
      throw new BadRequestException('Malformed Stripe-Signature header');
    }

    // Replay protection: an old, valid signature must not be accepted forever.
    const age = Math.abs(Date.now() / 1000 - Number(timestamp));
    if (!Number.isFinite(age) || age > toleranceSeconds) {
      throw new BadRequestException('Stripe webhook timestamp outside tolerance');
    }

    const payload = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
    const expected = crypto
      .createHmac('sha256', this.webhookSecret)
      .update(`${timestamp}.${payload}`, 'utf8')
      .digest('hex');

    // Constant-time compare so the check can't be probed byte by byte.
    const expectedBuf = Buffer.from(expected, 'utf8');
    const matched = signatures.some((sig) => {
      const sigBuf = Buffer.from(sig, 'utf8');
      return (
        sigBuf.length === expectedBuf.length && crypto.timingSafeEqual(sigBuf, expectedBuf)
      );
    });

    if (!matched) throw new BadRequestException('Stripe webhook signature mismatch');

    try {
      return JSON.parse(payload);
    } catch {
      throw new BadRequestException('Stripe webhook body is not valid JSON');
    }
  }
}

/** The subset of Stripe's subscription object this app reads. */
export interface StripeSubscription {
  id: string;
  customer: string;
  status: string;
  cancel_at_period_end: boolean;
  current_period_start: number;
  current_period_end: number;
  canceled_at: number | null;
  items: { data: Array<{ price: { id: string } }> };
  metadata?: Record<string, string>;
}

/** Minimal Stripe invoice shape we surface to the frontend. */
export interface StripeInvoice {
  id: string;
  number: string | null;
  status: string | null;
  currency: string;
  amount_due: number;
  amount_paid: number;
  amount_remaining: number;
  created: number;
  hosted_invoice_url: string | null;
  invoice_pdf: string | null;
  period_start: number | null;
  period_end: number | null;
  billing_reason: string | null;
  description?: string | null;
}
