import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ContactMessageStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { EmailChannelService } from './email-channel.service';
import { CreateContactMessageDto } from '../dto/create-contact-message.dto';

@Injectable()
export class ContactService {
  private readonly logger = new Logger(ContactService.name);
  // In-memory rate limit: ip -> timestamps (ms). No Redis needed for this volume.
  private readonly rateLimit = new Map<string, number[]>();
  private readonly WINDOW_MS = 60 * 60 * 1000; // 1 hour
  private readonly MAX_PER_WINDOW = 5; // 5 messages / hour / ip

  // Email dedup: email -> last submission timestamp
  private readonly emailThrottle = new Map<string, number>();
  private readonly EMAIL_COOLDOWN_MS = 60_000; // 1 min between same email

  constructor(
    private readonly prisma: PrismaService,
    private readonly emailChannel: EmailChannelService,
    private readonly config: ConfigService,
  ) {}

  async create(dto: CreateContactMessageDto, meta: { ip?: string; userAgent?: string }) {
    const name = dto.name.trim().replace(/\s+/g, ' ');
    const email = dto.email.toLowerCase().trim();
    const subject = dto.subject.trim().replace(/\s+/g, ' ');
    const message = dto.message.trim();

    // ── reCAPTCHA v2 checkbox verification ──────────────────────────────
    // If RECAPTCHA_SECRET_KEY is set, a valid token is required. The check
    // runs *before* honeypot/fast-submit so a bot can't bypass captcha by
    // triggering those earlier cheap paths.
    await this.verifyRecaptcha(dto.recaptchaToken, meta.ip);

    // Honeypot
    if (dto.website && dto.website.trim().length > 0) {
      this.logger.warn(`Honeypot hit from ip=${meta.ip} email=${email} website=${dto.website}`);
      // Silently store as ARCHIVED and return success (don't reveal detection)
      const archived = await this.prisma.contactMessage.create({
        data: {
          name,
          email,
          subject: `[SPAM] ${subject}`.slice(0, 200),
          message: `[HONEYPOT: ${dto.website.slice(0, 200)}]\n${message}`,
          status: ContactMessageStatus.ARCHIVED,
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
      });
      return { id: archived.id, queued: true };
    }

    // Fast bot: submitted < 2s after page load (hpTimestamp is when form was rendered)
    if (dto.hpTimestamp) {
      const ts = Number(dto.hpTimestamp);
      if (Number.isFinite(ts) && Date.now() - ts < 2000) {
        this.logger.warn(`Fast-submit bot detected ip=${meta.ip} email=${email} delta=${Date.now() - ts}ms`);
        // Still store but archived
        const archived = await this.prisma.contactMessage.create({
          data: {
            name,
            email,
            subject: `[FAST] ${subject}`.slice(0, 200),
            message,
            status: ContactMessageStatus.ARCHIVED,
            ip: meta.ip,
            userAgent: meta.userAgent,
          },
        });
        return { id: archived.id, queued: true };
      }
    }

    // Rate limit by IP (distributed-safe)
    if (meta.ip) {
      await this.enforceRateLimit(meta.ip);
    }

    // Rate limit by email: DB-backed (distributed) + in-memory fast path
    try {
      const recentByEmail = await this.prisma.contactMessage.findFirst({
        where: { email, createdAt: { gt: new Date(Date.now() - this.EMAIL_COOLDOWN_MS) } },
        select: { createdAt: true },
        orderBy: { createdAt: 'desc' },
      });
      if (recentByEmail) {
        throw new BadRequestException(
          `Please wait a minute before sending another message from ${email}.`,
        );
      }
    } catch (e) {
      if (e instanceof BadRequestException) throw e;
      this.logger.warn(`Email throttle DB check failed, falling back to memory: ${(e as Error).message}`);
      const lastEmail = this.emailThrottle.get(email) ?? 0;
      if (Date.now() - lastEmail < this.EMAIL_COOLDOWN_MS) {
        throw new BadRequestException(
          `Please wait a minute before sending another message from ${email}.`,
        );
      }
    }
    this.emailThrottle.set(email, Date.now());

    // Basic content validation beyond DTO length: disallow > 5 URLs (link spam)
    const urlCount = (message.match(/https?:\/\//gi) ?? []).length;
    if (urlCount > 5) {
      throw new BadRequestException('Message contains too many links.');
    }

    const created = await this.prisma.contactMessage.create({
      data: {
        name,
        email,
        subject,
        message,
        status: ContactMessageStatus.NEW,
        ip: meta.ip,
        userAgent: meta.userAgent,
      },
    });

    this.logger.log(`Contact message ${created.id} from ${email} — ${subject}`);

    // Best-effort email notification to admins (if SMTP is configured).
    // Don't block the response on SMTP.
    void this.notifyAdmins(created).catch((err) =>
      this.logger.warn(`notifyAdmins failed for ${created.id}: ${err?.message}`),
    );

    return { id: created.id, queued: true };
  }

  private async verifyRecaptcha(token: string | undefined, ip?: string): Promise<void> {
    const secret = (this.config.get<string>('RECAPTCHA_SECRET_KEY') ?? '').trim();
    // Disabled in local dev when no secret is configured — honeypot + rate
    // limits still apply, and the frontend hides the widget. In production
    // always set RECAPTCHA_SECRET_KEY to enforce the checkbox.
    if (!secret) {
      this.logger.debug('RECAPTCHA_SECRET_KEY not set — skipping captcha verification');
      return;
    }

    if (!token || token.trim().length < 20) {
      throw new BadRequestException('Please complete the reCAPTCHA verification.');
    }

    // Google test keys (always succeed without a network call) — useful so
    // local dev with the public test sitekey doesn't need a real secret.
    // https://developers.google.com/recaptcha/docs/faq#id-like-to-run-automated-tests-with-recaptcha.-what-should-i-do
    const isTestSecret = secret === '6LeIxAcTAAAAAGG-vFI1TnRWxMZNFuojJ4WifJWe';
    const isTestToken = token.length > 0;
    if (isTestSecret && isTestToken) {
      if (process.env.NODE_ENV === 'production') {
        this.logger.warn('reCAPTCHA test secret used in production — enforcing remote verification');
      } else {
        this.logger.debug('Using reCAPTCHA test secret — skipping remote verification');
        return;
      }
    }

    try {
      const params = new URLSearchParams({
        secret,
        response: token,
      });
      if (ip) params.set('remoteip', ip);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const res = await fetch('https://www.google.com/recaptcha/api/siteverify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!res.ok) {
        this.logger.warn(`reCAPTCHA verify HTTP ${res.status}`);
        throw new BadRequestException('reCAPTCHA verification failed. Please try again.');
      }

      const data = (await res.json()) as {
        success: boolean;
        challenge_ts?: string;
        hostname?: string;
        'error-codes'?: string[];
      };

      if (!data.success) {
        const codes = data['error-codes']?.join(', ') ?? 'unknown';
        this.logger.warn(`reCAPTCHA failed: ${codes} ip=${ip}`);
        // Map common error codes to friendly messages
        if (codes.includes('timeout-or-duplicate')) {
          throw new BadRequestException('reCAPTCHA expired — please check the box again.');
        }
        throw new BadRequestException('reCAPTCHA verification failed. Please try again.');
      }

      // Optional hostname pinning
      const allowedRaw = (this.config.get<string>('RECAPTCHA_ALLOWED_HOSTNAMES') ?? '').trim();
      if (allowedRaw && data.hostname) {
        const allowed = allowedRaw
          .split(',')
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean);
        if (allowed.length > 0 && !allowed.includes(data.hostname.toLowerCase())) {
          this.logger.warn(`reCAPTCHA hostname mismatch: got ${data.hostname}, allowed ${allowed.join(', ')}`);
          throw new BadRequestException('reCAPTCHA verification failed (hostname mismatch).');
        }
      }

      this.logger.debug(`reCAPTCHA verified for ip=${ip} hostname=${data.hostname}`);
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      this.logger.error(`reCAPTCHA verify error: ${(err as Error).message}`);
      throw new BadRequestException('Could not verify reCAPTCHA. Please try again.');
    }
  }

  private async enforceRateLimit(ip: string) {
    const now = Date.now();
    const windowStart = now - this.WINDOW_MS;

    // Distributed-safe check: count recent rows in DB (survives restart, multi-replica).
    // Kept alongside the in-memory fast path to avoid DB pressure under normal volume.
    try {
      const since = new Date(windowStart);
      const dbCount = await this.prisma.contactMessage.count({
        where: { ip, createdAt: { gt: since } },
      });
      if (dbCount >= this.MAX_PER_WINDOW) {
        throw new BadRequestException(
          'Too many messages from this address. Please try again later.',
        );
      }
    } catch (e) {
      if (e instanceof BadRequestException) throw e;
      // DB unavailable — fall back to in-memory check below
      this.logger.warn(`Contact rate-limit DB check failed, falling back to memory: ${(e as Error).message}`);
    }

    const timestamps = (this.rateLimit.get(ip) ?? []).filter((t) => t > windowStart);
    if (timestamps.length >= this.MAX_PER_WINDOW) {
      throw new BadRequestException(
        'Too many messages from this address. Please try again later.',
      );
    }
    timestamps.push(now);
    this.rateLimit.set(ip, timestamps);
    // Prevent unbounded growth for many IPs
    if (this.rateLimit.size > 5000) {
      // prune oldest entries
      for (const [key, arr] of this.rateLimit.entries()) {
        if (arr.every((t) => t < windowStart)) this.rateLimit.delete(key);
        if (this.rateLimit.size <= 4000) break;
      }
    }
  }

  private async notifyAdmins(msg: { id: string; name: string; email: string; subject: string; message: string }) {
    // Cheap: if email channel not configured, skip.
    const cfg = await this.emailChannel.getConfig();
    if (!cfg.enabled || !cfg.configured) {
      this.logger.debug('Email channel not configured — skipping contact notification email');
      return;
    }

    // Resolve recipients: ADMIN_EMAILS env (same as UsersService allowlist).
    // Fallback to the fromAddress if ADMIN_EMAILS empty.
    const adminEmails = (process.env.ADMIN_EMAILS ?? '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);

    const recipients = adminEmails.length > 0 ? adminEmails : [cfg.fromAddress].filter(Boolean);
    if (recipients.length === 0) return;

    const subject = `[Suchana AI Contact] ${msg.subject} — from ${msg.name}`;
    const text =
      `New contact message received\n` +
      `—\n` +
      `From: ${msg.name} <${msg.email}>\n` +
      `Subject: ${msg.subject}\n` +
      `ID: ${msg.id}\n` +
      `Time: ${new Date().toISOString()}\n` +
      `—\n\n` +
      `${msg.message}\n\n` +
      `—\n` +
      `View in admin: /admin/contact\n`;

    // Send to each admin (individual sends so one failure doesn't block others)
    for (const to of recipients) {
      const ok = await this.emailChannel.send({ to, subject, text });
      if (ok) this.logger.log(`Contact notification sent to ${to} for ${msg.id}`);
    }
  }

  async list(params: {
    page?: number;
    limit?: number;
    status?: ContactMessageStatus;
    search?: string;
    sortOrder?: 'asc' | 'desc';
  }) {
    const page = Math.max(1, params.page ?? 1);
    const limit = Math.min(Math.max(1, params.limit ?? 20), 100);
    const skip = (page - 1) * limit;

    const where: Prisma.ContactMessageWhereInput = {};
    if (params.status) where.status = params.status;
    if (params.search) {
      const q = params.search.trim();
      if (q) {
        where.OR = [
          { name: { contains: q, mode: 'insensitive' } },
          { email: { contains: q, mode: 'insensitive' } },
          { subject: { contains: q, mode: 'insensitive' } },
          { message: { contains: q, mode: 'insensitive' } },
        ];
      }
    }

    const orderBy: Prisma.ContactMessageOrderByWithRelationInput = {
      createdAt: params.sortOrder ?? 'desc',
    };

    const [data, total] = await Promise.all([
      this.prisma.contactMessage.findMany({ where, orderBy, skip, take: limit }),
      this.prisma.contactMessage.count({ where }),
    ]);

    return {
      data,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    };
  }

  async updateStatus(id: string, status: ContactMessageStatus) {
    const existing = await this.prisma.contactMessage.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Message not found');
    return this.prisma.contactMessage.update({ where: { id }, data: { status } });
  }

  async delete(id: string) {
    const existing = await this.prisma.contactMessage.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Message not found');
    await this.prisma.contactMessage.delete({ where: { id } });
    return { deleted: true, id };
  }

  async counts() {
    const grouped = await this.prisma.contactMessage.groupBy({
      by: ['status'],
      _count: { status: true },
    });
    const total = await this.prisma.contactMessage.count();
    const byStatus: Record<string, number> = {};
    for (const g of grouped) byStatus[g.status] = g._count.status;
    return { total, byStatus };
  }
}
