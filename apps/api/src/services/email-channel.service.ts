import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as dns from 'dns';
import * as net from 'net';
import * as nodemailer from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';
import { PrismaService } from '../prisma/prisma.service';
import { SecretCryptoService } from '../common/crypto/secret-crypto.service';

/** app_settings keys owned by this service. Nothing else may write them. */
const KEY = {
  enabled: 'alerts.email.enabled',
  host: 'alerts.email.host',
  port: 'alerts.email.port',
  secure: 'alerts.email.secure',
  username: 'alerts.email.username',
  password: 'alerts.email.password',
  fromAddress: 'alerts.email.fromAddress',
  fromName: 'alerts.email.fromName',
  lastTestedAt: 'alerts.email.lastTestedAt',
  lastTestOk: 'alerts.email.lastTestOk',
} as const;

/**
 * Submission ports only. An admin-supplied host:port is an outbound
 * connection the server makes on their behalf, so without an allowlist this
 * form is a port scanner for anything the API host can reach. Overridable
 * via SMTP_ALLOWED_PORTS for providers on a non-standard submission port.
 */
const DEFAULT_ALLOWED_PORTS = [25, 465, 587, 2525];

/** One admin may fire a test message this often, at most. */
const TEST_COOLDOWN_MS = 30_000;

/** Nothing here should ever hang an admin request or the alert queue. */
const CONNECTION_TIMEOUT_MS = 10_000;
const SOCKET_TIMEOUT_MS = 20_000;

export interface EmailChannelConfig {
  enabled: boolean;
  host: string;
  port: number;
  /** true = implicit TLS (465); false = STARTTLS upgrade on a plain port. */
  secure: boolean;
  username: string;
  fromAddress: string;
  fromName: string;
  /** True when a password is stored. The value itself never leaves the server. */
  passwordConfigured: boolean;
  /** Masked last-4 preview, e.g. "••••x9fA" — never the real password. */
  passwordPreview?: string;
  /** False until every required field is filled in. */
  configured: boolean;
  lastTestedAt: string | null;
  lastTestOk: boolean | null;
}

export interface UpdateEmailChannelInput {
  enabled?: boolean;
  host?: string;
  port?: number;
  secure?: boolean;
  username?: string;
  /** Omitted or empty = keep the stored password. */
  password?: string;
  fromAddress?: string;
  fromName?: string;
}

export interface SendEmailInput {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/**
 * Admin-configured SMTP channel: credentials live in `app_settings` with the
 * password encrypted at rest (SecretCryptoService), and the plaintext never
 * crosses a user-facing response — the admin UI only ever sees
 * `passwordConfigured` + a masked preview.
 *
 * Security posture, in one place because it is the point of this service:
 *  - AES-256-GCM at rest; saving is refused outright if the server has no
 *    SETTINGS_ENCRYPTION_KEY, rather than silently storing plaintext.
 *  - TLS is mandatory. STARTTLS is *required* (not opportunistic) on plain
 *    ports and certificates are always verified — there is deliberately no
 *    "ignore certificate errors" switch to flip.
 *  - Outbound target is constrained: ports are allowlisted and hosts that
 *    resolve to private/loopback/link-local addresses are rejected, so the
 *    form can't be used to probe the API host's internal network (SSRF).
 *  - Test messages only ever go to the requesting admin's own account email,
 *    with a per-admin cooldown, so the panel can't be used as a spam relay.
 *  - Every value that reaches a mail header is CRLF-checked (header
 *    injection) and length-capped.
 */
@Injectable()
export class EmailChannelService {
  private readonly logger = new Logger(EmailChannelService.name);
  private readonly lastTestAt = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: SecretCryptoService,
    private readonly config: ConfigService,
  ) {}

  // ── read ──────────────────────────────────────────────────────────────

  async getConfig(): Promise<EmailChannelConfig> {
    const stored = await this.readAll();
    // DB (app_settings) is primary; env SMTP_* is fallback so `SMTP_HOST=…` on Beanstalk works without manual /admin/alerts
    const envHost = (this.config.get<string>('SMTP_HOST') ?? '').trim().toLowerCase();
    const envPort = this.config.get<string>('SMTP_PORT');
    const envUser = (this.config.get<string>('SMTP_USER') ?? '').trim();
    const envPass = this.config.get<string>('SMTP_PASSWORD') ?? '';
    const envFrom = (this.config.get<string>('SMTP_FROM') ?? '').trim();
    // Parse "Display <addr@>" → name/address
    let envFromName = '';
    let envFromAddress = '';
    if (envFrom) {
      const m = envFrom.match(/^(.*)<\s*([^>]+)\s*>$/);
      if (m) {
        envFromName = m[1].trim().replace(/^["']|["']$/g, '');
        envFromAddress = m[2].trim();
      } else {
        envFromAddress = envFrom;
      }
    }
    const host = (stored.get(KEY.host) ?? '') || envHost;
    const port = Number(stored.get(KEY.port) ?? envPort ?? '587');
    const username = (stored.get(KEY.username) ?? '') || envUser;
    const fromAddress = (stored.get(KEY.fromAddress) ?? '') || envFromAddress;
    const encryptedPassword = stored.get(KEY.password);
    // DB encrypted password takes precedence; env plain password is fallback (not persisted)
    const envPasswordConfigured = Boolean(envPass && envPass.trim().length >= 4);
    const passwordConfigured = Boolean(encryptedPassword) || envPasswordConfigured;
    const lastTestOk = stored.get(KEY.lastTestOk);

    const fromNameStored = stored.get(KEY.fromName) ?? '';
    const fromName = fromNameStored || envFromName;
    const secureRaw = stored.get(KEY.secure);
    // env has no explicit secure flag — infer from port (465 = implicit TLS)
    const secure = secureRaw !== undefined ? secureRaw === 'true' : port === 465;
    // If nothing in DB yet, treat env-provided host as implicitly enabled
    const enabledRaw = stored.get(KEY.enabled);
    const enabled = enabledRaw !== undefined ? enabledRaw === 'true' : Boolean(envHost && envPasswordConfigured);

    return {
      enabled,
      host,
      port: Number.isFinite(port) ? port : 587,
      secure,
      username,
      fromAddress,
      fromName,
      passwordConfigured,
      passwordPreview: encryptedPassword
        ? this.crypto.preview(encryptedPassword)
        : envPasswordConfigured
          ? `••••${envPass.trim().slice(-4)}`
          : undefined,
      configured: Boolean(host && username && fromAddress && passwordConfigured),
      lastTestedAt: stored.get(KEY.lastTestedAt) ?? null,
      lastTestOk: lastTestOk === undefined ? null : lastTestOk === 'true',
    };
  }

  // ── write ─────────────────────────────────────────────────────────────

  async update(
    actor: { id: string; email: string },
    input: UpdateEmailChannelInput,
  ): Promise<EmailChannelConfig> {
    const current = await this.getConfig();
    const writes: Record<string, string> = {};

    if (input.host !== undefined) {
      writes[KEY.host] = this.assertHostname(input.host.trim().toLowerCase());
    }
    if (input.port !== undefined) {
      writes[KEY.port] = String(this.assertPort(input.port));
    }
    if (input.secure !== undefined) writes[KEY.secure] = String(input.secure);
    if (input.username !== undefined) {
      writes[KEY.username] = this.assertHeaderSafe(input.username.trim(), 'Username', 320);
    }
    if (input.fromAddress !== undefined) {
      writes[KEY.fromAddress] = this.assertEmail(input.fromAddress.trim(), 'From address');
    }
    if (input.fromName !== undefined) {
      writes[KEY.fromName] = this.assertHeaderSafe(input.fromName.trim(), 'From name', 120);
    }

    // Empty string means "leave it alone" — the UI renders a blank password
    // box on every load (the real value is never sent to it), so treating
    // blank as a delete would wipe the credential on any unrelated save.
    if (input.password) {
      if (!this.crypto.isConfigured) {
        throw new ServiceUnavailableException(
          'SETTINGS_ENCRYPTION_KEY is not configured on this server — refusing to store an SMTP password in plaintext.',
        );
      }
      const password = this.assertHeaderSafe(input.password, 'Password', 256);
      writes[KEY.password] = this.crypto.encrypt(password);
    }

    // Turning the channel on is only meaningful once it can actually send.
    if (input.enabled !== undefined) {
      if (input.enabled) {
        const next = {
          host: writes[KEY.host] ?? current.host,
          username: writes[KEY.username] ?? current.username,
          fromAddress: writes[KEY.fromAddress] ?? current.fromAddress,
          hasPassword: Boolean(writes[KEY.password]) || current.passwordConfigured,
        };
        if (!next.host || !next.username || !next.fromAddress || !next.hasPassword) {
          throw new BadRequestException(
            'Fill in host, username, password and from address before enabling email alerts.',
          );
        }
      }
      writes[KEY.enabled] = String(input.enabled);
    }

    for (const [key, value] of Object.entries(writes)) {
      await this.prisma.appSetting.upsert({
        where: { key },
        create: { key, value },
        update: { value },
      });
    }

    // Audit trail: who changed what, never any value. The password entry is
    // recorded by length alone so a credential rotation is provable without
    // the log ever holding the credential.
    this.logger.log(
      `Email channel updated by ${actor.email} (${actor.id}): ${Object.keys(writes)
        .map((k) => (k === KEY.password ? `${k}=<${input.password!.length} chars>` : k))
        .join(', ')}`,
    );

    return this.getConfig();
  }

  // ── test ──────────────────────────────────────────────────────────────

  /**
   * Verify the stored credentials with a real SMTP handshake, then send a
   * single message *to the requesting admin's own account email*. The
   * recipient is never client-supplied: an admin panel that mails arbitrary
   * addresses is an open relay with a login page in front of it.
   */
  async sendTest(actor: { id: string; email: string }): Promise<{
    ok: true;
    sentTo: string;
    testedAt: string;
  }> {
    const since = Date.now() - (this.lastTestAt.get(actor.id) ?? 0);
    if (since < TEST_COOLDOWN_MS) {
      throw new HttpException(
        `Wait ${Math.ceil((TEST_COOLDOWN_MS - since) / 1000)}s before sending another test message.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    this.lastTestAt.set(actor.id, Date.now());

    const recipient = this.assertEmail(actor.email, 'Your account email');
    const transport = await this.buildTransport();

    try {
      await transport.verify();
      await transport.sendMail({
        from: await this.fromHeader(),
        to: recipient,
        subject: 'Suchana AI — email alert channel test',
        text:
          'This is a test message from the Suchana AI admin panel.\n\n' +
          'If you are reading it, the SMTP credentials saved for the email alert channel work.',
      });
      await this.recordTest(true);
      this.logger.log(`Email channel test sent to ${recipient} by ${actor.id}`);
      return { ok: true, sentTo: recipient, testedAt: new Date().toISOString() };
    } catch (error: any) {
      await this.recordTest(false);
      // SMTP errors quote back the server's greeting, which can include the
      // username; surface the code and a generic reason instead.
      const reason = error?.code ?? error?.responseCode ?? 'connection failed';
      this.logger.warn(`Email channel test failed (${reason}) for ${actor.id}`);
      throw new BadRequestException(
        `Could not send the test message — SMTP reported: ${reason}. Check host, port, username and password.`,
      );
    } finally {
      transport.close();
    }
  }

  // ── send (for the alert pipeline) ─────────────────────────────────────

  /**
   * True when send() could actually deliver. The alert pipeline checks this
   * first so "the admin hasn't set SMTP up" is recorded as a skipped channel
   * rather than a delivery failure.
   */
  async isReady(): Promise<boolean> {
    const config = await this.getConfig();
    return config.enabled && config.configured;
  }

  /**
   * Deliver one alert email. Returns false rather than throwing when the
   * channel is off or misconfigured, so a broken SMTP box can never take
   * down the alert queue — matching EvolutionApiService.sendText().
   */
  async send(input: SendEmailInput): Promise<boolean> {
    const config = await this.getConfig();
    if (!config.enabled || !config.configured) return false;

    let transport: nodemailer.Transporter | undefined;
    try {
      transport = await this.buildTransport();
      await transport.sendMail({
        from: await this.fromHeader(),
        to: this.assertEmail(input.to, 'Recipient'),
        subject: this.assertHeaderSafe(input.subject, 'Subject', 200),
        text: input.text,
        html: input.html,
      });
      return true;
    } catch (error: any) {
      this.logger.error(`send failed: ${error?.code ?? error?.message ?? 'unknown error'}`);
      return false;
    } finally {
      transport?.close();
    }
  }

  // ── internals ─────────────────────────────────────────────────────────

  private async readAll(): Promise<Map<string, string>> {
    const rows = await this.prisma.appSetting.findMany({
      where: { key: { in: Object.values(KEY) } },
    });
    return new Map(rows.map((r) => [r.key, r.value]));
  }

  private async recordTest(ok: boolean): Promise<void> {
    const at = new Date().toISOString();
    for (const [key, value] of [
      [KEY.lastTestedAt, at],
      [KEY.lastTestOk, String(ok)],
    ] as const) {
      await this.prisma.appSetting.upsert({
        where: { key },
        create: { key, value },
        update: { value },
      });
    }
  }

  private async fromHeader(): Promise<string> {
    const config = await this.getConfig();
    return config.fromName
      ? `"${config.fromName.replace(/"/g, '')}" <${config.fromAddress}>`
      : config.fromAddress;
  }

  private async password(): Promise<string> {
    const rows = await this.readAll();
    const stored = rows.get(KEY.password);
    if (stored) {
      try {
        return this.crypto.decrypt(stored);
      } catch {
        // Wrong/rotated SETTINGS_ENCRYPTION_KEY, or a tampered row. GCM catches
        // both; re-entering the password is the only fix.
        throw new ServiceUnavailableException(
          'The stored SMTP password could not be decrypted (encryption key changed?) — re-enter it.',
        );
      }
    }
    // Fallback to env plain SMTP_PASSWORD (Beanstalk) when DB has no encrypted entry
    const envPass = this.config.get<string>('SMTP_PASSWORD') ?? '';
    if (envPass && envPass.trim().length >= 4) return envPass.trim();
    throw new BadRequestException('No SMTP password is stored — save one first.');
  }

  private async buildTransport(): Promise<nodemailer.Transporter> {
    const config = await this.getConfig();
    if (!config.host || !config.username || !config.fromAddress) {
      throw new BadRequestException(
        'Fill in host, username, password and from address before testing.',
      );
    }
    this.assertPort(config.port);
    await this.assertPublicHost(config.host);

    const options: SMTPTransport.Options = {
      host: config.host,
      port: config.port,
      secure: config.secure,
      // Fail the connection rather than fall back to cleartext: opportunistic
      // STARTTLS is downgradeable by anything on the path.
      requireTLS: !config.secure,
      auth: { user: config.username, pass: await this.password() },
      tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2', servername: config.host },
      connectionTimeout: CONNECTION_TIMEOUT_MS,
      greetingTimeout: CONNECTION_TIMEOUT_MS,
      socketTimeout: SOCKET_TIMEOUT_MS,
    };
    // One message per connection (no pool): no socket holds a decrypted
    // credential in memory between sends.
    return nodemailer.createTransport(options);
  }

  private allowedPorts(): number[] {
    const raw = this.config.get<string>('SMTP_ALLOWED_PORTS');
    if (!raw) return DEFAULT_ALLOWED_PORTS;
    const parsed = raw
      .split(',')
      .map((p) => Number(p.trim()))
      .filter((p) => Number.isInteger(p) && p > 0 && p <= 65535);
    return parsed.length ? parsed : DEFAULT_ALLOWED_PORTS;
  }

  private assertPort(port: number): number {
    if (!this.allowedPorts().includes(port)) {
      throw new BadRequestException(
        `Port ${port} is not an allowed SMTP submission port (${this.allowedPorts().join(', ')}).`,
      );
    }
    return port;
  }

  private assertHostname(host: string): string {
    if (!host || host.length > 253 || !/^[a-z0-9.-]+$/.test(host) || host.includes('..')) {
      throw new BadRequestException('Enter a valid SMTP hostname, e.g. smtp.gmail.com.');
    }
    return host;
  }

  /**
   * SSRF guard: resolve the hostname and refuse anything pointing inside the
   * network the API itself sits in. Checked at connect time (not just on
   * save) because DNS can be re-pointed after the fact.
   */
  private async assertPublicHost(host: string): Promise<void> {
    if (this.config.get<string>('SMTP_ALLOW_PRIVATE_HOSTS') === 'true') return;

    let addresses: dns.LookupAddress[];
    try {
      addresses = await dns.promises.lookup(host, { all: true });
    } catch {
      throw new BadRequestException(`Could not resolve SMTP host "${host}".`);
    }
    for (const { address } of addresses) {
      if (this.isPrivateAddress(address)) {
        throw new BadRequestException(
          `"${host}" resolves to a private address (${address}); only public SMTP servers are allowed.`,
        );
      }
    }
  }

  private isPrivateAddress(address: string): boolean {
    if (net.isIPv4(address)) {
      const [a, b] = address.split('.').map(Number);
      return (
        a === 0 || // "this network"
        a === 10 ||
        a === 127 || // loopback
        (a === 100 && b >= 64 && b <= 127) || // CGNAT
        (a === 169 && b === 254) || // link-local, incl. cloud metadata 169.254.169.254
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) ||
        (a === 192 && b === 0) ||
        (a === 198 && (b === 18 || b === 19)) || // benchmarking
        a >= 224 // multicast + reserved
      );
    }
    if (net.isIPv6(address)) {
      const ip = address.toLowerCase();
      if (ip === '::1' || ip === '::') return true;
      // IPv4-mapped (::ffff:10.0.0.1) — check the embedded v4 address.
      const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
      if (mapped) return this.isPrivateAddress(mapped[1]);
      return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(ip); // ULA, link-local, multicast
    }
    return true; // unparseable — fail closed
  }

  private assertEmail(value: string, label: string): string {
    const email = this.assertHeaderSafe(value, label, 320);
    if (!/^[^\s@,;<>]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(email)) {
      throw new BadRequestException(`${label} must be a valid email address.`);
    }
    return email;
  }

  /**
   * Anything that ends up in a mail header must not carry CR/LF (or NUL) —
   * that's how a From/Subject value turns into extra injected headers.
   */
  private assertHeaderSafe(value: string, label: string, max: number): string {
    if (!value) throw new BadRequestException(`${label} cannot be empty.`);
    if (value.length > max) {
      throw new BadRequestException(`${label} must be at most ${max} characters.`);
    }
    if (/[\r\n\0]/.test(value)) {
      throw new BadRequestException(`${label} contains illegal control characters.`);
    }
    return value;
  }
}
