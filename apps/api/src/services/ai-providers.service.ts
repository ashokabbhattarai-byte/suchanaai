import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiProvider, AiProviderKind } from '@prisma/client';
import * as dns from 'dns/promises';
import * as net from 'net';
import { PrismaService } from '../prisma/prisma.service';
import { SecretCryptoService } from '../common/crypto/secret-crypto.service';

/** Shape sent to the admin UI — never contains a decrypted key. */
export interface AiProviderView {
  id: string;
  slug: string;
  label: string;
  kind: AiProviderKind;
  baseUrl: string | null;
  /** AWS region, BEDROCK only. */
  region: string | null;
  model: string;
  enabled: boolean;
  sortOrder: number;
  isBuiltIn: boolean;
  /** True when a key is stored here (as opposed to falling back to env). */
  configured: boolean;
  /** Masked last-4 preview, e.g. "••••8i30". */
  preview?: string;
}

export interface UpsertProviderInput {
  label?: string;
  kind?: AiProviderKind;
  baseUrl?: string | null;
  region?: string | null;
  model?: string;
  apiKey?: string;
  enabled?: boolean;
}

/** Fallback AWS region when an admin adds a Bedrock provider without one. */
const DEFAULT_BEDROCK_REGION = 'us-west-2';

/**
 * The provider registry behind /admin/ai. Built-ins are seeded rows, so an
 * admin-added provider is not a second-class citizen — same edit, reorder,
 * health-check and delete paths.
 */
@Injectable()
export class AiProvidersService implements OnModuleInit {
  private readonly logger = new Logger(AiProvidersService.name);

  // Seeded once so the registry is never empty on a fresh install. Values
  // mirror the AI service's own env defaults; keys stay null so an existing
  // env-var-configured deployment keeps working untouched until an admin
  // explicitly sets one here.
  private static readonly BUILT_INS: Array<
    Pick<AiProvider, 'slug' | 'label' | 'kind' | 'baseUrl' | 'model' | 'sortOrder'> &
      Partial<Pick<AiProvider, 'region'>>
  > = [
    {
      slug: 'gemini',
      label: 'Google Gemini',
      kind: AiProviderKind.GEMINI,
      baseUrl: null,
      model: 'gemini-3.6-flash',
      sortOrder: 0,
    },
    {
      slug: 'groq',
      label: 'Groq',
      kind: AiProviderKind.OPENAI_COMPATIBLE,
      baseUrl: 'https://api.groq.com/openai/v1/chat/completions',
      model: 'openai/gpt-oss-120b',
      sortOrder: 1,
    },
    {
      slug: 'opencode',
      label: 'OpenCode Zen',
      kind: AiProviderKind.OPENAI_COMPATIBLE,
      baseUrl: 'https://opencode.ai/zen/v1/chat/completions',
      model: 'deepseek-v4-flash-free',
      sortOrder: 2,
    },
    // Last in the chain: the paid, high-reliability backstop for when every
    // free tier above has refused, rate-limited, or run out of credit.
    // `global.` is the cross-region endpoint — highest availability and no
    // regional pricing premium.
    {
      slug: 'bedrock',
      label: 'AWS Bedrock (Claude Sonnet 4.6)',
      kind: AiProviderKind.BEDROCK,
      baseUrl: null,
      region: 'us-west-2',
      model: 'global.anthropic.claude-sonnet-4-6',
      sortOrder: 3,
    },
  ];

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: SecretCryptoService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Seed any built-in that isn't in the registry yet.
   *
   * Per-slug rather than "seed only when the table is empty": a built-in
   * added after launch (Bedrock) has to reach installs that were seeded
   * before it existed, and those tables are never empty. Note this does
   * resurrect a built-in an admin deleted — disable it instead of deleting
   * if you want it gone for good.
   */
  async onModuleInit() {
    const existing = await this.prisma.aiProvider.findMany({ select: { slug: true } });
    const known = new Set(existing.map((p) => p.slug));
    const missing = AiProvidersService.BUILT_INS.filter((p) => !known.has(p.slug));
    if (!missing.length) return;

    // A first-run install seeds everything; an existing one only gains
    // built-ins introduced since it was seeded.
    await this.prisma.aiProvider.createMany({
      data: missing.map((p) => ({ ...p, isBuiltIn: true })),
      skipDuplicates: true,
    });
    this.logger.log(
      `Seeded ${missing.length} built-in AI provider(s): ${missing.map((p) => p.slug).join(', ')}`,
    );
  }

  // ── URL safety ─────────────────────────────────────────────────────────
  //
  // A custom provider means an admin types a URL this server will POST an API
  // key to. Even behind an admin-only route that is an SSRF primitive, so the
  // endpoint must be public HTTPS — or a host explicitly allowlisted by the
  // operator via env (for a self-hosted vLLM/Ollama box).

  private allowlistedHosts(): string[] {
    return (this.config.get<string>('AI_PROVIDER_ALLOWED_HOSTS') ?? '')
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean);
  }

  private async assertSafeEndpoint(rawUrl: string): Promise<void> {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new BadRequestException('Endpoint must be a valid URL.');
    }

    const host = parsed.hostname.toLowerCase();
    const allowlisted = this.allowlistedHosts().includes(host);

    // An allowlisted host is a deliberate operator decision, so it may use
    // http and may resolve privately — that is the entire point of the list.
    if (allowlisted) return;

    if (parsed.protocol !== 'https:') {
      throw new BadRequestException(
        'Endpoint must use https. To use an internal or plain-http host, add it to AI_PROVIDER_ALLOWED_HOSTS on the server.',
      );
    }

    let addresses: string[];
    try {
      addresses = (await dns.lookup(host, { all: true })).map((r) => r.address);
    } catch {
      throw new BadRequestException(`Could not resolve "${host}".`);
    }
    if (addresses.some((a) => this.isPrivateAddress(a))) {
      throw new BadRequestException(
        `"${host}" resolves to a private address. Add it to AI_PROVIDER_ALLOWED_HOSTS if this is intentional.`,
      );
    }
  }

  /** Mirrors AttachmentsController's guard — RFC1918, loopback, link-local, metadata. */
  private isPrivateAddress(address: string): boolean {
    if (net.isIPv4(address)) {
      const [a, b] = address.split('.').map(Number);
      return (
        a === 10 ||
        a === 127 ||
        a === 0 ||
        (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168)
      );
    }
    const lower = address.toLowerCase();
    return (
      lower === '::1' ||
      lower.startsWith('fc') ||
      lower.startsWith('fd') ||
      lower.startsWith('fe80')
    );
  }

  // ── Reads ──────────────────────────────────────────────────────────────

  private toView(p: AiProvider): AiProviderView {
    return {
      id: p.id,
      slug: p.slug,
      label: p.label,
      kind: p.kind,
      baseUrl: p.baseUrl,
      region: p.region,
      model: p.model,
      enabled: p.enabled,
      sortOrder: p.sortOrder,
      isBuiltIn: p.isBuiltIn,
      configured: Boolean(p.apiKeyEnc),
      preview: p.apiKeyEnc ? this.crypto.preview(p.apiKeyEnc) : undefined,
    };
  }

  async list(): Promise<AiProviderView[]> {
    const rows = await this.prisma.aiProvider.findMany({ orderBy: { sortOrder: 'asc' } });
    return rows.map((r) => this.toView(r));
  }

  /**
   * Full config including DECRYPTED keys, for the AI service only. Never
   * reachable from a user-facing route — see InternalAiConfigController.
   */
  async listForRuntime() {
    const rows = await this.prisma.aiProvider.findMany({ orderBy: { sortOrder: 'asc' } });
    return rows.map((r) => ({
      slug: r.slug,
      label: r.label,
      kind: r.kind,
      baseUrl: r.baseUrl,
      region: r.region,
      model: r.model,
      enabled: r.enabled,
      apiKey: r.apiKeyEnc ? this.safeDecrypt(r.apiKeyEnc, r.slug) : null,
    }));
  }

  private safeDecrypt(value: string, slug: string): string | null {
    try {
      return this.crypto.decrypt(value);
    } catch (e: any) {
      this.logger.warn(`Could not decrypt API key for provider "${slug}": ${e.message}`);
      return null;
    }
  }

  async findOne(id: string): Promise<AiProvider> {
    const row = await this.prisma.aiProvider.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Provider not found');
    return row;
  }

  // ── Writes ─────────────────────────────────────────────────────────────

  async create(input: UpsertProviderInput & { label: string; kind: AiProviderKind; model: string }) {
    if (!input.label?.trim()) throw new BadRequestException('Name is required.');
    if (!input.model?.trim()) throw new BadRequestException('Model is required.');

    if (input.kind === AiProviderKind.OPENAI_COMPATIBLE) {
      if (!input.baseUrl?.trim()) {
        throw new BadRequestException('Endpoint URL is required for OpenAI-compatible providers.');
      }
      await this.assertSafeEndpoint(input.baseUrl);
    }
    if (input.kind === AiProviderKind.BEDROCK && input.region !== undefined && !input.region?.trim()) {
      throw new BadRequestException('AWS region is required for Bedrock providers.');
    }

    const slug = await this.uniqueSlug(input.label);
    const last = await this.prisma.aiProvider.findFirst({ orderBy: { sortOrder: 'desc' } });

    const created = await this.prisma.aiProvider.create({
      data: {
        slug,
        label: input.label.trim(),
        kind: input.kind,
        // Only OPENAI_COMPATIBLE is URL-addressed — Gemini derives its URL
        // from the model and Bedrock from the region, so a value on either
        // is noise.
        baseUrl:
          input.kind === AiProviderKind.OPENAI_COMPATIBLE ? input.baseUrl!.trim() : null,
        region:
          input.kind === AiProviderKind.BEDROCK
            ? (input.region?.trim() || DEFAULT_BEDROCK_REGION)
            : null,
        model: input.model.trim(),
        apiKeyEnc: input.apiKey ? this.crypto.encrypt(input.apiKey) : null,
        enabled: input.enabled ?? true,
        sortOrder: (last?.sortOrder ?? -1) + 1,
        isBuiltIn: false,
      },
    });
    this.logger.log(`AI provider created: ${created.slug} (${created.kind})`);
    return this.toView(created);
  }

  async update(id: string, input: UpsertProviderInput) {
    const existing = await this.findOne(id);
    const kind = input.kind ?? existing.kind;

    let baseUrl = input.baseUrl === undefined ? existing.baseUrl : input.baseUrl;
    // Only OPENAI_COMPATIBLE carries a URL. Gemini and Bedrock are addressed
    // by model and region, so requiring one here would make every edit of a
    // Bedrock provider — including just pasting its key — fail validation.
    if (kind !== AiProviderKind.OPENAI_COMPATIBLE) {
      baseUrl = null;
    } else if (baseUrl) {
      // Re-validate on every change: an allowlist edit or DNS change can make
      // a previously-accepted host unsafe.
      if (baseUrl !== existing.baseUrl) await this.assertSafeEndpoint(baseUrl);
    } else {
      throw new BadRequestException('Endpoint URL is required for OpenAI-compatible providers.');
    }

    let region = input.region === undefined ? existing.region : input.region;
    if (kind === AiProviderKind.BEDROCK) {
      region = region?.trim() || DEFAULT_BEDROCK_REGION;
    } else {
      region = null;
    }

    const updated = await this.prisma.aiProvider.update({
      where: { id },
      data: {
        // Built-in slugs are immutable so ordering/health stay stable, but
        // their label, model, key and endpoint are all editable.
        label: input.label?.trim() ?? existing.label,
        kind,
        baseUrl,
        region,
        model: input.model?.trim() ?? existing.model,
        enabled: input.enabled ?? existing.enabled,
        ...(input.apiKey !== undefined
          ? { apiKeyEnc: input.apiKey ? this.crypto.encrypt(input.apiKey) : null }
          : {}),
      },
    });
    if (input.apiKey !== undefined) {
      // Audit trail: name and length only, never the value.
      this.logger.log(
        input.apiKey
          ? `API key updated for provider "${updated.slug}" (${input.apiKey.length} chars)`
          : `API key cleared for provider "${updated.slug}"`,
      );
    }
    return this.toView(updated);
  }

  async remove(id: string) {
    const existing = await this.findOne(id);
    if (existing.isBuiltIn) {
      throw new BadRequestException(
        'Built-in providers cannot be deleted — disable it instead, which stops it being called at all.',
      );
    }
    await this.prisma.aiProvider.delete({ where: { id } });
    this.logger.log(`AI provider deleted: ${existing.slug}`);
    return { id, deleted: true };
  }

  /** Persist a new fallback chain. `ids` is the full list, in display order. */
  async reorder(ids: string[]) {
    const rows = await this.prisma.aiProvider.findMany({ select: { id: true } });
    const known = new Set(rows.map((r) => r.id));
    const unknown = ids.filter((id) => !known.has(id));
    if (unknown.length) throw new BadRequestException('Unknown provider id in ordering.');
    if (ids.length !== rows.length) {
      throw new BadRequestException('Ordering must include every provider exactly once.');
    }

    await this.prisma.$transaction(
      ids.map((id, index) =>
        this.prisma.aiProvider.update({ where: { id }, data: { sortOrder: index } }),
      ),
    );
    return this.list();
  }

  private async uniqueSlug(label: string): Promise<string> {
    const base =
      label
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 40) || 'provider';
    let candidate = base;
    for (let n = 2; ; n++) {
      const clash = await this.prisma.aiProvider.findUnique({ where: { slug: candidate } });
      if (!clash) return candidate;
      candidate = `${base}-${n}`;
    }
  }
}
