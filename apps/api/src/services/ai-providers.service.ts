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
    // PRIMARY. Paid but fast and reliable: Haiku 4.5 is the cheapest Claude
    // and answers in ~0.8s in-region, so it carries normal traffic and
    // everything below is fallback. llm.py calls a first-sorted BEDROCK
    // provider alone rather than racing it, so this costs one paid request per
    // question, not one per question per agent. `effort` is rejected on
    // 4.5-tier models and thinking is off unless given a budget, so a call
    // here is already minimum-spend.
    // Inference-profile ID, not a bare `anthropic.*` one: verified 2026-09-08
    // that this account has no Messages-endpoint access (every `anthropic.*`
    // ID 403s "not available for this account"), so only this legacy
    // InvokeModel path works. Sonnet 4.6 is not on Bedrock here at all.
    {
      slug: 'bedrock',
      label: 'AWS Bedrock (Claude Haiku 4.5)',
      kind: AiProviderKind.BEDROCK,
      baseUrl: null,
      region: 'us-east-1',
      model: 'global.anthropic.claude-haiku-4-5-20251001-v1:0',
      sortOrder: -20,
    },
    // VERY VERY FAST — TOP PRIORITY: Ollama on EC2 services t3.large (2 vCPU, 7.6 GiB, no GPU)
    // 3.80.188.210:11434 — qwen2.5:1.5b (~986 MB, fits easily, ~2-4s on CPU via llama.cpp).
    // FIX 2026-09-08: vLLM at 3.80.188.210:8001 was TOP (-10) but health shows
    // "Could not reach the provider. All connection attempts failed" — EC2
    // i-071d7b2debed5e3ed vLLM at /opt/vllm (Python 3.11) fails with
    // "Failed to infer device type" + "vllm._C_AVX512 missing" on CPU-only
    // t3.large. Root cause: VLLM_TARGET_DEVICE=cpu must be set at BUILD time,
    // and vLLM CPU has NO prebuilt wheels — must build from source (30+ min,
    // gcc12, AVX512). Even when built, vLLM CPU is GPU-optimized and SLOWER
    // on CPU than Ollama (llama.cpp) — 1.5B vLLM ~3-7s vs Ollama ~2-4s,
    // 0.5B vLLM ~1-2s but still needs AVX512. Ollama is the proven CPU path
    // (was qwen2.5:7b 25s but OOM; 1.5b fits and is Responding 2127ms health).
    // So Ollama is TOP (-10), vLLM is SECONDARY (-9) with smaller 0.5B option
    // if admin gets it built, or disabled until fixed. Both are self-hosted
    // OPENAI_COMPATIBLE with no API key (_key_optional). Hedged race
    // (llm.py) fires top 4 concurrently, so fastest wins without 60s wait.
    {
      slug: 'ollama-services',
      label: 'Ollama (Qwen2.5-1.5B) — EC2 services',
      kind: AiProviderKind.OPENAI_COMPATIBLE,
      baseUrl: 'http://3.80.188.210:11434/v1/chat/completions',
      model: 'qwen2.5:1.5b',
      sortOrder: -10,
    },
    {
      slug: 'groq',
      label: 'Groq',
      kind: AiProviderKind.OPENAI_COMPATIBLE,
      baseUrl: 'https://api.groq.com/openai/v1/chat/completions',
      model: 'openai/gpt-oss-120b',
      sortOrder: 1,
    },
    // OpenCode Go — paid subscription, OpenAI-compatible gateway. Restored
    // 2026-09-10 per admin request: was retired to Bedrock/Ollama/Groq-only
    // roster, but admin needs it visible in /admin/ai and functional.
    // Go is /zen/go/v1 (not Zen /zen/v1) — a Zen subscription does not fund Go
    // and every paid Zen model 401s `CreditsError`. Model IDs differ: Go drops
    // the `-free` suffix (`muse-spark-1.2-contributor`, `mimo-v2.5`).
    // Benchmarked 2026-09-10: glm-5.3-flash 3.0s (chosen), deepseek-v4-flash 3.6s,
    // mimo-v2.5 5.9s, qwen3.8-flash 9.0s; muse-spark-* 500 upstream. Needs
    // `x-session-id` + custom User-Agent — handled in apps/ai/app/llm.py
    // `_opencode_headers()` / `_is_opencode()`. Env key fallback is
    // OPENCODE_ZEN_API_KEY / OPENCODE_API_KEY via ai_config_sync _env_key_for.
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
   *
   * Per-slug rather than "seed only when the table is empty": a built-in
   * added after launch (Bedrock) has to reach installs that were seeded
   * before it existed, and those tables are never empty. Note this does
   * resurrect a built-in an admin deleted — disable it instead of deleting
   * if you want it gone for good.
   */
  async onModuleInit() {
    const existing = await this.prisma.aiProvider.findMany({
      select: { slug: true, model: true, sortOrder: true, baseUrl: true, apiKeyEnc: true, enabled: true, isBuiltIn: true, label: true },
    });
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

    // Promote Bedrock from last-resort backstop to primary, on Haiku 4.5.
    // Only fires for a row still on one of the bare `anthropic.*` IDs we used
    // to ship: those address the Bedrock Messages endpoint, which this account
    // has no access to (verified 2026-09-08 — every one returns 403 "not
    // available for this account"), so they can never answer. An admin who
    // picked their own working inference-profile ID keeps it and its position.
    const UNUSABLE_BEDROCK_MODELS = new Set([
      'anthropic.claude-sonnet-5',
      'anthropic.claude-haiku-4-5',
      'anthropic.claude-opus-4-8',
    ]);
    const bedrockBuiltIn = AiProvidersService.BUILT_INS.find((p) => p.slug === 'bedrock')!;
    const bedrockRow = existing.find((p) => p.slug === 'bedrock');
    if (bedrockRow) {
      const patch: Record<string, unknown> = {};
      if (UNUSABLE_BEDROCK_MODELS.has(bedrockRow.model)) {
        patch.model = bedrockBuiltIn.model;
        patch.sortOrder = bedrockBuiltIn.sortOrder;
        patch.enabled = true;
      }
      // An admin who repointed the model by hand leaves the label describing a
      // model the row no longer runs — the panel then reads "Sonnet 5" over a
      // Haiku 4.5 ID. Only the exact stale shipped label is rewritten, so a
      // genuinely custom name is never clobbered.
      const runningModel = (patch.model as string) ?? bedrockRow.model;
      if (
        runningModel === bedrockBuiltIn.model &&
        bedrockRow.label === 'AWS Bedrock (Claude Sonnet 5)'
      ) {
        patch.label = bedrockBuiltIn.label;
      }
      if (Object.keys(patch).length) {
        await this.prisma.aiProvider.update({ where: { slug: 'bedrock' }, data: patch });
        this.logger.warn(
          `Bedrock row healed → ${JSON.stringify(patch)}`,
        );
      }
    }

    // 2026-09-09: admin decision — active roster is Bedrock, Ollama, Groq.
    // Deleted, not disabled: a disabled row still renders (struck through) in
    // the panel and in the fallback-order chips, and the ask was to remove
    // them from the UI entirely. Safe to delete because they are gone from
    // BUILT_INS, so the seeder above cannot bring them back; re-adding one is
    // the normal "Add provider" flow. This drops each row's stored key with
    // it, which is the point of retiring a provider.
    const RETIRED_SLUGS = ['gemini', 'vllm-services', 'openrouter'];
    const toRetire = existing.filter((r) => RETIRED_SLUGS.includes(r.slug));
    if (toRetire.length) {
      await this.prisma.aiProvider.deleteMany({
        where: { slug: { in: toRetire.map((r) => r.slug) } },
      });
      this.logger.warn(
        `Removed retired provider(s): ${toRetire.map((r) => r.slug).join(', ')}`,
      );
    }

    // ── FIX 2026-09-08: Ollama TOP (-10), vLLM SECOND (-9) — swap from previous vLLM TOP
    // Health snapshot 2026-09-08: vLLM http://3.80.188.210:8001 "Could not reach
    // the provider. All connection attempts failed" — EC2 i-071d7b2debed5e3ed
    // t3.large (2 vCPU, 7.6 GiB, no GPU) /opt/vllm Python 3.11 logs:
    // "Failed to infer device type" + "vllm._C_AVX512 missing". Root cause:
    // VLLM_TARGET_DEVICE=cpu must be set at BUILD time (pip install env) and
    // vLLM CPU has NO prebuilt wheels (must build from source with gcc12,
    // AVX512). GPU wheel on CPU-only host fails. Even when built, vLLM CPU
    // (GPU-optimized, continuous batching) is SLOWER than Ollama llama.cpp on
    // CPU: 1.5B vLLM ~3-7s vs Ollama qwen2.5:1.5b ~2-4s (986 MB, Responding
    // 2127ms health). So swap: Ollama TOP (proven CPU), vLLM SECOND (optional,
    // try 0.5B Qwen/Qwen2.5-0.5B-Instruct 0.8GB ~1-2s if you rebuild). Both are
    // self-hosted OPENAI_COMPATIBLE with no API key (_key_optional). Stale
    // keys are cleared idempotently — admin can re-add via "My endpoint needs
    // a key" toggle if auth is ever enabled.
    // Ollama only — vLLM is retired above, so it is disabled rather than
    // repositioned and has no BUILT_INS entry to heal against. Look it up
    // without `!`: a missing entry must skip this block, never crash boot.
    const ollamaBuiltIn = AiProvidersService.BUILT_INS.find((p) => p.slug === 'ollama-services');
    for (const row of ollamaBuiltIn ? existing : ([] as typeof existing)) {
      if (!ollamaBuiltIn) break;
      const isOllamaRow =
        row.slug === 'ollama-services' ||
        (row.baseUrl?.includes(':11434') ?? false) ||
        (row.baseUrl?.toLowerCase().includes('ollama') ?? false);
      if (!isOllamaRow) continue;

      const patch: Record<string, any> = {};
      if (row.sortOrder !== ollamaBuiltIn.sortOrder) patch.sortOrder = ollamaBuiltIn.sortOrder;

      // Only fix baseUrl if it drifted to the private IP, which is not
      // routable from Beanstalk, or lost its /v1/chat/completions suffix.
      if (row.baseUrl !== ollamaBuiltIn.baseUrl) {
        if (
          row.baseUrl?.includes('172.31.95.204:11434') ||
          row.baseUrl === 'http://3.80.188.210:11434' ||
          row.slug === 'ollama-services'
        ) {
          patch.baseUrl = ollamaBuiltIn.baseUrl;
        }
      }

      if (row.slug === 'ollama-services' && !row.isBuiltIn) patch.isBuiltIn = true;
      // Self-hosted takes no key — clear a stale stored one.
      if (row.apiKeyEnc) patch.apiKeyEnc = null;
      if (!row.enabled) patch.enabled = true;

      if (Object.keys(patch).length) {
        await this.prisma.aiProvider.update({ where: { slug: row.slug }, data: patch });
        this.logger.warn(
          `Healed Ollama provider "${row.slug}" → sortOrder ${ollamaBuiltIn.sortOrder}, no API key`,
        );
      }
    }
    // Also handle any extra Ollama-like rows that match host:11434 but have
    // non-canonical slug (e.g. ollama-qwen2-5-7b-ec2-services) — push to -9
    // so they don't collide at -10, but keep the canonical at -10.
    const extraOllamaRows = existing.filter(
      (r) => r.baseUrl?.includes(':11434') && r.slug !== 'ollama-services',
    );
    for (const row of extraOllamaRows) {
      if (row.sortOrder === -10) {
        await this.prisma.aiProvider.update({ where: { slug: row.slug }, data: { sortOrder: -9 } });
        this.logger.log(`Demoted extra Ollama row "${row.slug}" to -9 to keep canonical Ollama at -10`);
      }
    }

    // The OpenRouter retired-model self-heal lived here. It is gone with the
    // provider itself — its BUILT_INS lookup used a non-null assertion, so
    // leaving it behind would dereference undefined and crash boot.
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
