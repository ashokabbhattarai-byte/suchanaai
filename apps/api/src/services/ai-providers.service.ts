import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { AiProvider, AiProviderKind } from '@prisma/client';
import * as dns from 'dns/promises';
import * as net from 'net';
import { PrismaService } from '../prisma/prisma.service';
import { SecretCryptoService } from '../common/crypto/secret-crypto.service';

/** One entry of a provider's live model catalogue, for the admin picker. */
export interface ProviderModel {
  id: string;
  contextLength: number | null;
  free: boolean;
  modality: string | null;
}

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
const DEFAULT_BEDROCK_REGION = 'us-east-1';

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
    // First in the chain. OpenRouter meters requests per day (50/day, 1000/day
    // after $10, 20 RPM shared across all :free models) rather than tokens
    // per day, so a long RAG context costs no more than a one-line question.
    // Primary is liquid/lfm-2.5-2.6b:free — 2.6B ultra-fast <600ms vs
    // nemotron-lightning's ~12.9s; gemma-4-26b is next in chain for powerful
    // Devanagari fallback. sortOrder is -1 rather than 0 so it also lands ahead
    // of the providers already seeded at 0..3 on installs that predate it.
    {
      slug: 'openrouter',
      label: 'OpenRouter',
      kind: AiProviderKind.OPENAI_COMPATIBLE,
      baseUrl: 'https://openrouter.ai/api/v1/chat/completions',
      model: 'liquid/lfm-2.5-2.6b:free',
      sortOrder: -1,
    },
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
    // Model IDs on the Bedrock Messages endpoint carry an `anthropic.` prefix
    // and no inference-profile prefix; Sonnet 4.6 is not served there at all.
    {
      slug: 'bedrock',
      label: 'AWS Bedrock (Claude Sonnet 5)',
      kind: AiProviderKind.BEDROCK,
      baseUrl: null,
      region: 'us-east-1',
      model: 'anthropic.claude-sonnet-5',
      sortOrder: 3,
    },
  ];

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: SecretCryptoService,
    private readonly config: ConfigService,
    private readonly http: HttpService,
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
    const existing = await this.prisma.aiProvider.findMany({ select: { slug: true, model: true } });
    const known = new Set(existing.map((p) => p.slug));
    const missing = AiProvidersService.BUILT_INS.filter((p) => !known.has(p.slug));
    if (missing.length) {
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

    // Self-heal retired free models: minimax/* was removed from OpenRouter
    // (404) and nemotron-lightning as primary was 12.9s in prod. Promote any
    // row still pointing at a dead/slow model to the new live fast primary.
    const RETIRED_MODELS = new Set([
      'minimax/minimax-m3:free',
      'minimax/minimax-m2.7:free',
      'nvidia/nemotron-3.5-lightning:free',
    ]);
    const livePrimary = AiProvidersService.BUILT_INS.find((p) => p.slug === 'openrouter')!.model;
    for (const row of existing) {
      if (row.slug === 'openrouter' && RETIRED_MODELS.has(row.model)) {
        await this.prisma.aiProvider.update({
          where: { slug: 'openrouter' },
          data: { model: livePrimary },
        });
        this.logger.warn(
          `Migrated OpenRouter primary from retired/slow "${row.model}" to "${livePrimary}"`,
        );
        break;
      }
    }
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

  /**
   * Live model catalogue for a provider, so the admin picks an ID that exists
   * instead of typing one.
   *
   * Typed model IDs are how the registry ended up pointing at models the
   * vendor had retired — the call then fails at answer time, which reads as
   * "the AI is down" rather than "that model is gone".
   *
   * `apiKey` is the plaintext key when the admin is entering a new one; when
   * omitted the stored key for `id` is used, so listing models works while
   * editing a saved provider without re-typing its key.
   */
  async listModels(input: {
    id?: string;
    kind: AiProviderKind;
    baseUrl?: string | null;
    apiKey?: string;
  }): Promise<{ models: ProviderModel[]; note?: string }> {
    let key = input.apiKey?.trim() || null;
    let kind = input.kind;
    let baseUrl = input.baseUrl ?? null;

    if (input.id) {
      const saved = await this.findOne(input.id);
      kind = input.kind ?? saved.kind;
      baseUrl = baseUrl ?? saved.baseUrl;
      if (!key && saved.apiKeyEnc) key = this.safeDecrypt(saved.apiKeyEnc, saved.slug);
    }

    if (kind === AiProviderKind.BEDROCK) {
      return {
        models: [],
        note: 'Bedrock has no public model-list endpoint here — enter the model ID manually.',
      };
    }

    if (kind === AiProviderKind.GEMINI) {
      if (!key) throw new BadRequestException('An API key is required to list Gemini models.');
      return { models: await this.fetchGeminiModels(key) };
    }

    if (!baseUrl?.trim()) {
      throw new BadRequestException('An endpoint URL is required to list models.');
    }
    return { models: await this.fetchOpenAiCompatibleModels(baseUrl, key) };
  }

  /**
   * Providers expose the catalogue at /models alongside /chat/completions, so
   * the listing URL is derived from the endpoint already configured rather
   * than asking the admin for a second URL.
   */
  private modelsUrlFrom(chatUrl: string): string {
    const trimmed = chatUrl.trim().replace(/\/+$/, '');
    const idx = trimmed.lastIndexOf('/chat/completions');
    if (idx !== -1) return `${trimmed.slice(0, idx)}/models`;
    return `${trimmed}/models`;
  }

  private async fetchOpenAiCompatibleModels(
    chatUrl: string,
    apiKey: string | null,
  ): Promise<ProviderModel[]> {
    const url = this.modelsUrlFrom(chatUrl);
    let data: any;
    try {
      const res = await firstValueFrom(
        this.http.get(url, {
          timeout: 20000,
          headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        }),
      );
      data = res.data;
    } catch (err: any) {
      const status = err?.response?.status;
      throw new BadRequestException(
        status === 401 || status === 403
          ? 'The provider rejected that API key when listing models.'
          : `Could not list models from ${url}: ${err?.message ?? err}`,
      );
    }

    const rows: any[] = Array.isArray(data?.data) ? data.data : [];
    return rows
      .map((m) => {
        const id = String(m?.id ?? '');
        // OpenRouter reports pricing per token as decimal strings; "0" in both
        // prompt and completion is what makes a model actually free, which is
        // more reliable than the ":free" suffix convention.
        const prompt = Number(m?.pricing?.prompt ?? NaN);
        const completion = Number(m?.pricing?.completion ?? NaN);
        const free =
          id.endsWith(':free') ||
          (Number.isFinite(prompt) && prompt === 0 && Number.isFinite(completion) && completion === 0);
        return {
          id,
          contextLength: Number(m?.context_length ?? m?.top_provider?.context_length) || null,
          free,
          modality: m?.architecture?.modality ?? null,
        };
      })
      .filter((m) => m.id)
      .sort((a, b) => (b.contextLength ?? 0) - (a.contextLength ?? 0));
  }

  private async fetchGeminiModels(apiKey: string): Promise<ProviderModel[]> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`;
    let data: any;
    try {
      const res = await firstValueFrom(this.http.get(url, { timeout: 20000 }));
      data = res.data;
    } catch (err: any) {
      const status = err?.response?.status;
      throw new BadRequestException(
        status === 400 || status === 401 || status === 403
          ? 'Google rejected that key. Gemini needs an API key from aistudio.google.com (starts with "AIza"), not an OAuth token.'
          : `Could not list Gemini models: ${err?.message ?? err}`,
      );
    }

    const rows: any[] = Array.isArray(data?.models) ? data.models : [];
    return rows
      .filter((m) => (m?.supportedGenerationMethods ?? []).includes('generateContent'))
      .map((m) => ({
        id: String(m?.name ?? '').replace(/^models\//, ''),
        contextLength: Number(m?.inputTokenLimit) || null,
        // Gemini's free tier is per-key, not per-model, so nothing here is
        // marked free — the model list can't tell us the caller's tier.
        free: false,
        modality: null,
      }))
      .filter((m) => m.id)
      .sort((a, b) => (b.contextLength ?? 0) - (a.contextLength ?? 0));
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

  /**
   * Self-heal entry point: the AI service calls this (via
   * InternalAiProvidersController) when it finds the configured model for a
   * provider consistently failing but a fallback model from its own vetted
   * list answering instead — see llm.py's self_heal_openrouter. Deliberately
   * narrow (model only, by slug, no validation beyond existence) so this
   * can never be used to change anything but which model is tried.
   */
  async updateModelBySlug(slug: string, model: string): Promise<void> {
    const existing = await this.prisma.aiProvider.findUnique({ where: { slug } });
    if (!existing) {
      this.logger.warn(`Self-heal: unknown provider slug "${slug}", ignoring`);
      return;
    }
    if (existing.model === model) return;
    await this.prisma.aiProvider.update({ where: { slug }, data: { model } });
    this.logger.warn(
      `Self-heal: provider "${slug}" model auto-rotated from "${existing.model}" to "${model}" (configured model was unresponsive)`,
    );
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
