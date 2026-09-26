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
    // PRIMARY / TOP PRIORITY: Cloudflare Workers AI
    {
      slug: 'cloudflare',
      label: 'Cloudflare Workers AI',
      kind: AiProviderKind.OPENAI_COMPATIBLE,
      baseUrl: 'https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1/chat/completions',
      model: '@cf/ibm-granite/granite-4.0-h-micro',
      sortOrder: -120,
    },
    {
      slug: 'groq',
      label: 'Groq',
      kind: AiProviderKind.OPENAI_COMPATIBLE,
      baseUrl: 'https://api.groq.com/openai/v1/chat/completions',
      model: 'openai/gpt-oss-120b',
      sortOrder: 1,
    },
    // OpenCode Go — paid subscription, OpenAI-compatible gateway.
    {
      slug: 'opencode',
      label: 'OpenCode Go (GLM 5.3 Flash)',
      kind: AiProviderKind.OPENAI_COMPATIBLE,
      baseUrl: 'https://opencode.ai/zen/go/v1/chat/completions',
      model: 'glm-5.3-flash',
      sortOrder: 2,
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
   */
  async onModuleInit() {
    // Purge retired / decommissioned providers (Gemini, Bedrock, Ollama, vLLM, OpenRouter)
    const RETIRED_SLUGS = [
      'vllm-services',
      'openrouter',
      'gemini',
      'bedrock',
      'ollama-services',
    ];
    try {
      const deleted = await this.prisma.aiProvider.deleteMany({
        where: {
          OR: [
            { slug: { in: RETIRED_SLUGS } },
            { kind: { in: [AiProviderKind.GEMINI, AiProviderKind.BEDROCK] } },
            { baseUrl: { contains: ':11434' } },
            { baseUrl: { contains: 'ollama' } },
            { slug: { startsWith: 'ollama' } },
            { slug: { startsWith: 'bedrock' } },
            { slug: { startsWith: 'gemini' } },
          ],
        },
      });
      if (deleted.count > 0) {
        this.logger.warn(`Purged ${deleted.count} retired/decommissioned AI provider(s) (Gemini, Bedrock, Ollama, etc.)`);
      }
    } catch (e: any) {
      this.logger.warn(`Failed to delete retired AI providers: ${e?.message ?? e}`);
    }

    const existing = await this.prisma.aiProvider.findMany({
      select: { slug: true, model: true, sortOrder: true, baseUrl: true, apiKeyEnc: true, enabled: true, isBuiltIn: true, label: true },
    });
    const known = new Set(existing.map((p) => p.slug));
    const missing = AiProvidersService.BUILT_INS.filter((p) => !known.has(p.slug));
    if (missing.length) {
      await this.prisma.aiProvider.createMany({
        data: missing.map((p) => ({ ...p, isBuiltIn: true })),
        skipDuplicates: true,
      });
      this.logger.log(
        `Seeded ${missing.length} built-in AI provider(s): ${missing.map((p) => p.slug).join(', ')}`,
      );
    }

    // Ensure Cloudflare Workers AI is the top priority primary provider
    const cfBuiltIn = AiProvidersService.BUILT_INS.find((p) => p.slug === 'cloudflare')!;
    const defaultCfToken = this.config.get<string>('CLOUDFLARE_API_TOKEN')?.trim() || '';
    const defaultCfAccountId = this.config.get<string>('CLOUDFLARE_ACCOUNT_ID')?.trim() || '';
    const resolvedCfBaseUrl = defaultCfAccountId
      ? `https://api.cloudflare.com/client/v4/accounts/${defaultCfAccountId}/ai/v1/chat/completions`
      : cfBuiltIn.baseUrl;

    const cfRow = await this.prisma.aiProvider.findUnique({ where: { slug: 'cloudflare' } });
    if (!cfRow) {
      await this.prisma.aiProvider.create({
        data: {
          slug: 'cloudflare',
          label: cfBuiltIn.label,
          kind: cfBuiltIn.kind,
          baseUrl: resolvedCfBaseUrl,
          model: this.config.get<string>('CLOUDFLARE_AI_MODEL')?.trim() || cfBuiltIn.model,
          sortOrder: cfBuiltIn.sortOrder,
          enabled: true,
          isBuiltIn: true,
          apiKeyEnc: defaultCfToken ? this.crypto.encrypt(defaultCfToken) : null,
        },
      });
      this.logger.log(`Created primary Cloudflare provider with default model ${cfBuiltIn.model}`);
    } else {
      const patch: Record<string, unknown> = {};
      if (cfRow.sortOrder > -120) patch.sortOrder = -120;
      if (!cfRow.apiKeyEnc && defaultCfToken) {
        patch.apiKeyEnc = this.crypto.encrypt(defaultCfToken);
      }
      if (cfRow.baseUrl && cfRow.baseUrl.includes('{account_id}') && defaultCfAccountId) {
        patch.baseUrl = `https://api.cloudflare.com/client/v4/accounts/${defaultCfAccountId}/ai/v1/chat/completions`;
      }
      if (!cfRow.enabled) patch.enabled = true;
      if (Object.keys(patch).length) {
        await this.prisma.aiProvider.update({ where: { slug: 'cloudflare' }, data: patch });
        this.logger.log(`Cloudflare provider promoted to top priority: ${JSON.stringify(patch)}`);
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

    if (baseUrl?.trim() && this.isCloudflare(baseUrl)) {
      return { models: await this.fetchCloudflareModels(baseUrl, key) };
    }

    if (!baseUrl?.trim()) {
      throw new BadRequestException('An endpoint URL is required to list models.');
    }
    return { models: await this.fetchOpenAiCompatibleModels(baseUrl, key) };
  }

  private isCloudflare(url: string): boolean {
    return url.includes('api.cloudflare.com') || url.includes('cloudflare');
  }

  private async fetchCloudflareModels(
    chatUrl: string,
    apiKey: string | null,
  ): Promise<ProviderModel[]> {
    const fallbackModels: ProviderModel[] = [
      { id: '@cf/ibm-granite/granite-4.0-h-micro', contextLength: 128000, free: true, modality: 'cheapest / fast' },
      { id: '@cf/zai-org/glm-4.7-flash', contextLength: 128000, free: true, modality: 'nepali / high-quality' },
      { id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', contextLength: 128000, free: false, modality: 'fast-reasoning' },
      { id: '@cf/qwen/qwen2.5-7b-instruct', contextLength: 32768, free: true, modality: 'balanced' },
      { id: '@cf/meta/llama-3.1-8b-instruct', contextLength: 128000, free: true, modality: 'general' },
      { id: '@cf/google/gemma-7b-it', contextLength: 8192, free: true, modality: 'fast' },
      { id: '@cf/mistral/mistral-7b-instruct-v0.1', contextLength: 32768, free: true, modality: 'general' },
    ];

    let accountId = '';
    const match = chatUrl.match(/accounts\/([^/]+)\/ai/);
    if (match && match[1] && match[1] !== '{account_id}') {
      accountId = match[1];
    } else {
      accountId = this.config.get<string>('CLOUDFLARE_ACCOUNT_ID')?.trim() || '';
    }

    const token = apiKey || this.config.get<string>('CLOUDFLARE_API_TOKEN')?.trim() || '';

    if (!accountId || !token) {
      return fallbackModels;
    }

    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/models/search?task=Text%20Generation`;
    try {
      const res = await firstValueFrom(
        this.http.get(url, {
          timeout: 15000,
          headers: { Authorization: `Bearer ${token}` },
        }),
      );
      const rows: any[] = Array.isArray(res.data?.result) ? res.data.result : [];
      if (!rows.length) return fallbackModels;
      return rows
        .map((m) => {
          const id = String(m?.name ?? '');
          const ctxProp = m?.properties?.find?.((p: any) => p?.property_id === 'context_window');
          const contextLength = ctxProp ? Number(ctxProp.value) || null : null;
          return {
            id,
            contextLength,
            free: id.includes('granite') || id.includes('glm-4.7') || id.includes('qwen2.5'),
            modality: m?.description?.slice(0, 40) || 'text->text',
          };
        })
        .filter((m) => m.id);
    } catch (err: any) {
      this.logger.warn(`Could not fetch live Cloudflare models: ${err?.message ?? err}. Returning standard catalog.`);
      return fallbackModels;
    }
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

    const slug = await this.uniqueSlug(input.label);
    const last = await this.prisma.aiProvider.findFirst({ orderBy: { sortOrder: 'desc' } });

    const created = await this.prisma.aiProvider.create({
      data: {
        slug,
        label: input.label.trim(),
        kind: input.kind,
        baseUrl: input.baseUrl?.trim() || null,
        region: null,
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
    if (baseUrl) {
      if (baseUrl !== existing.baseUrl) await this.assertSafeEndpoint(baseUrl);
    } else {
      throw new BadRequestException('Endpoint URL is required.');
    }

    const updated = await this.prisma.aiProvider.update({
      where: { id },
      data: {
        label: input.label?.trim() ?? existing.label,
        kind,
        baseUrl,
        region: null,
        model: input.model?.trim() ?? existing.model,
        enabled: input.enabled ?? existing.enabled,
        ...(input.apiKey !== undefined
          ? { apiKeyEnc: input.apiKey ? this.crypto.encrypt(input.apiKey) : null }
          : {}),
      },
    });
    if (input.apiKey !== undefined) {
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
