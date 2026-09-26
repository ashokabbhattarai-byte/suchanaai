"use client"

import { useEffect, useState } from "react"
import { AlertCircle, Eye, EyeOff, Loader2, RefreshCw, X } from "lucide-react"
import { fetchAiProviderModels } from "@/lib/api"
import { formatContext } from "@/components/admin/model-select"
import type {
  AiProvider,
  AiProviderInput,
  AiProviderKind,
  AiProviderModel,
} from "@/lib/types"

/** Detects local/self-hosted endpoints that need no API key by default. */
const SELF_HOSTED_RE =
  /(localhost|127\.0\.0\.1|10\.\d|172\.(?:1[6-9]|2\d|3[0-1])\.\d+|192\.168|\.local)/i
function isSelfHostedUrl(url: string): boolean {
  return SELF_HOSTED_RE.test(url)
}

/** Presets so the common vendors are one click, not a URL hunt. */
const PRESETS: Array<{
  label: string
  kind: AiProviderKind
  baseUrl: string
  model: string
  region?: string
}> = [
  {
    label: "Cloudflare Workers AI (Granite 4.0 Micro) [Top Priority / Fast]",
    kind: "OPENAI_COMPATIBLE",
    baseUrl: "https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1/chat/completions",
    model: "@cf/ibm-granite/granite-4.0-h-micro",
  },
  {
    label: "Cloudflare Workers AI (GLM-4.7-Flash) [Nepali / High Quality]",
    kind: "OPENAI_COMPATIBLE",
    baseUrl: "https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1/chat/completions",
    model: "@cf/zai-org/glm-4.7-flash",
  },
  {
    label: "Cloudflare Workers AI (Llama 3.3 70B Instruct)",
    kind: "OPENAI_COMPATIBLE",
    baseUrl: "https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1/chat/completions",
    model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  },
  {
    label: "Cloudflare Workers AI (Qwen 2.5 7B Instruct)",
    kind: "OPENAI_COMPATIBLE",
    baseUrl: "https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1/chat/completions",
    model: "@cf/qwen/qwen2.5-7b-instruct",
  },
  {
    label: "Groq (GPT OSS 120B / Llama 3.3 70B) [Fallback]",
    kind: "OPENAI_COMPATIBLE",
    baseUrl: "https://api.groq.com/openai/v1/chat/completions",
    model: "openai/gpt-oss-120b",
  },
  {
    label: "OpenCode Go (GLM 5.3 Flash) [Paid subscription]",
    kind: "OPENAI_COMPATIBLE",
    baseUrl: "https://opencode.ai/zen/go/v1/chat/completions",
    model: "glm-5.3-flash",
  },
  {
    label: "OpenAI (GPT-4o Mini)",
    kind: "OPENAI_COMPATIBLE",
    baseUrl: "https://api.openai.com/v1/chat/completions",
    model: "gpt-4o-mini",
  },
  {
    label: "OpenRouter",
    kind: "OPENAI_COMPATIBLE",
    baseUrl: "https://openrouter.ai/api/v1/chat/completions",
    model: "liquid/lfm-2.5-2.6b:free",
  },
  {
    label: "Together AI",
    kind: "OPENAI_COMPATIBLE",
    baseUrl: "https://api.together.xyz/v1/chat/completions",
    model: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
  },
  {
    label: "DeepSeek",
    kind: "OPENAI_COMPATIBLE",
    baseUrl: "https://api.deepseek.com/chat/completions",
    model: "deepseek-chat",
  },
  {
    label: "Mistral",
    kind: "OPENAI_COMPATIBLE",
    baseUrl: "https://api.mistral.ai/v1/chat/completions",
    model: "mistral-large-latest",
  },
]

/**
 * Create/edit dialog for one provider.
 *
 * On edit the API key field starts empty and is only sent when the admin
 * actually types a replacement — the server never returns the stored key, so
 * an empty field must mean "leave it alone", not "clear it".
 */
export function ProviderDialog({
  provider,
  onClose,
  onSubmit,
}: {
  provider: AiProvider | null
  onClose: () => void
  onSubmit: (input: Partial<AiProviderInput>) => Promise<void>
}) {
  const isEdit = Boolean(provider)
  const [label, setLabel] = useState(provider?.label ?? "")
  const [kind, setKind] = useState<AiProviderKind>(provider?.kind ?? "OPENAI_COMPATIBLE")
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? "")
  const [model, setModel] = useState(provider?.model ?? "")
  const [apiKey, setApiKey] = useState("")
  const [showKey, setShowKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [forceApiKey, setForceApiKey] = useState(false)

  // Model picker lists what the provider actually serves.
  const [models, setModels] = useState<AiProviderModel[]>([])
  const [modelQuery, setModelQuery] = useState("")
  const [loadingModels, setLoadingModels] = useState(false)
  const [modelError, setModelError] = useState<string | null>(null)
  const [customModel, setCustomModel] = useState(false)

  const loadModels = async () => {
    setLoadingModels(true)
    setModelError(null)
    try {
      const { models: found, note } = await fetchAiProviderModels({
        id: provider?.id,
        kind,
        baseUrl: baseUrl || null,
        // Only send a key the admin just typed — omitted means "use the one
        // already stored for this provider", which the server can decrypt.
        apiKey: apiKey.trim() || undefined,
      })
      setModels(found)
      if (note) setModelError(note)
      else if (!found.length) setModelError("The provider returned no models.")
    } catch (e) {
      setModels([])
      setModelError(e instanceof Error ? e.message : "Could not load models.")
    } finally {
      setLoadingModels(false)
    }
  }

  // Editing an existing provider: the endpoint and key are already stored, so
  // fetch the catalogue straight away instead of making the admin click Load
  // before they can see what they may switch to. A new provider has no
  // endpoint yet, so it still waits for one.
  useEffect(() => {
    if (provider?.id && baseUrl) void loadModels()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider?.id])

  const visibleModels = models.filter((m) =>
    m.id.toLowerCase().includes(modelQuery.trim().toLowerCase()),
  )

  const applyPreset = (p: (typeof PRESETS)[number]) => {
    setLabel((l) => l || p.label)
    setKind(p.kind)
    setBaseUrl(p.baseUrl)
    setModel((m) => m || p.model)
    if (isSelfHostedUrl(p.baseUrl)) {
      setApiKey("")
      setForceApiKey(false)
    }
  }

  const submit = async () => {
    setSaving(true)
    setError(null)
    try {
      const selfHostedNow = isSelfHostedUrl(baseUrl) && !forceApiKey
      await onSubmit({
        label,
        kind: "OPENAI_COMPATIBLE",
        baseUrl: baseUrl.trim() || null,
        region: null,
        model,
        ...(selfHostedNow ? { apiKey: "" } : apiKey ? { apiKey } : {}),
      })
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the provider.")
    } finally {
      setSaving(false)
    }
  }

  const canSave =
    label.trim() &&
    model.trim() &&
    Boolean(baseUrl.trim()) &&
    !saving

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="max-h-[90dvh] w-full max-w-lg overflow-y-auto rounded-[24px] bg-white p-6 shadow-2xl sm:p-8"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-5 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-xl text-vez-ink">
              {isEdit ? `Edit ${provider!.label}` : "Add AI provider"}
            </h2>
            <p className="mt-1 text-xs text-vez-mute">
              Any service speaking the OpenAI chat-completions API works — no code change needed.
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-full p-2 text-vez-mute transition-colors hover:bg-vez-surface hover:text-vez-ink"
            aria-label="Close"
          >
            <X className="size-5" />
          </button>
        </div>

        {!isEdit && (
          <div className="mb-5">
            <p className="mb-2 text-xs text-vez-mute">Start from a preset</p>
            <div className="flex flex-wrap gap-1.5">
              {PRESETS.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => applyPreset(p)}
                  className="rounded-full border border-vez-line px-3 py-1.5 text-xs text-vez-ink transition-colors hover:border-vez-sky hover:bg-vez-sky/10 cursor-pointer"
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="space-y-4">
          <Field label="Display name">
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. Cloudflare Workers AI"
              className={inputCls}
            />
          </Field>

          <Field
            label="Endpoint URL"
            hint={
              baseUrl.includes("cloudflare")
                ? "Cloudflare Workers AI: Replace {account_id} with your Cloudflare Account ID (or leave it to auto-resolve from server env). Token requires Workers AI Read permissions."
                : "Must be https. Internal/plain-http hosts need AI_PROVIDER_ALLOWED_HOSTS on the server."
            }
          >
            <input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://api.example.com/v1/chat/completions"
              spellCheck={false}
              autoComplete="off"
              className={inputCls + " font-mono text-[13px]"}
            />
          </Field>

          <Field label="Model">
            {!customModel ? (
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <input
                    value={modelQuery}
                    onChange={(e) => setModelQuery(e.target.value)}
                    placeholder={models.length ? "Search models…" : "Load models to pick one"}
                    spellCheck={false}
                    autoComplete="off"
                    className={inputCls + " font-mono text-[13px]"}
                  />
                  <button
                    type="button"
                    onClick={loadModels}
                    disabled={loadingModels}
                    className="flex min-h-[38px] shrink-0 items-center gap-1.5 rounded-lg border border-vez-line px-3 text-xs text-vez-ink transition-colors hover:bg-vez-surface disabled:opacity-50 cursor-pointer"
                  >
                    {loadingModels ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <RefreshCw className="size-3.5" />
                    )}
                    {models.length ? "Refresh" : "Load"}
                  </button>
                </div>

                {modelError && (
                  <p className="text-xs text-red-600">{modelError}</p>
                )}

                {models.length > 0 && (
                  <ul className="max-h-52 overflow-y-auto rounded-lg border border-vez-line">
                    {visibleModels.map((m) => (
                      <li key={m.id}>
                        <button
                          type="button"
                          onClick={() => setModel(m.id)}
                          className={`flex w-full flex-col items-start gap-0.5 border-b border-vez-line/60 px-3 py-2 text-left transition-colors last:border-b-0 hover:bg-vez-surface cursor-pointer ${
                            model === m.id ? "bg-vez-sky/20" : ""
                          }`}
                        >
                          <span className="font-mono text-[12px] text-vez-ink">{m.id}</span>
                          <span className="flex flex-wrap items-center gap-1.5 text-[11px] text-vez-mute">
                            {m.free && (
                              <span className="rounded-full bg-emerald-100 px-1.5 text-emerald-700">FREE</span>
                            )}
                            {m.contextLength && <span>{formatContext(m.contextLength)} ctx</span>}
                            {m.modality && <span>· {m.modality}</span>}
                          </span>
                        </button>
                      </li>
                    ))}
                    {visibleModels.length === 0 && (
                      <li className="px-3 py-2 text-xs text-vez-mute">No model matches that search.</li>
                    )}
                  </ul>
                )}

                <div className="flex items-center justify-between text-[11px] text-vez-mute">
                  <span>
                    {model ? (
                      <>
                        Selected: <span className="font-mono text-vez-ink">{model}</span>
                      </>
                    ) : (
                      "No model selected"
                    )}
                  </span>
                  <button
                    type="button"
                    onClick={() => setCustomModel(true)}
                    className="underline transition-colors hover:text-vez-ink cursor-pointer"
                  >
                    Use a custom model ID
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-1.5">
                <input
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder="@cf/ibm-granite/granite-4.0-h-micro"
                  spellCheck={false}
                  className={inputCls + " font-mono text-[13px]"}
                />
                <button
                  type="button"
                  onClick={() => setCustomModel(false)}
                  className="self-end text-[11px] text-vez-mute underline transition-colors hover:text-vez-ink cursor-pointer"
                >
                  Pick from the provider&rsquo;s model list
                </button>
              </div>
            )}
          </Field>

          {(() => {
            const selfHosted = isSelfHostedUrl(baseUrl)
            if (selfHosted && !forceApiKey) {
              return (
                <div className="rounded-[14px] border border-emerald-200 bg-emerald-50 px-3.5 py-3">
                  <p className="text-xs font-medium text-emerald-800">Self-hosted — no API key needed</p>
                  <p className="mt-1 text-xs text-emerald-700">
                    {isEdit && provider!.configured
                      ? `A key is stored (${provider!.preview}) but this endpoint type usually needs none. Leave as-is or clear it.`
                      : "Endpoints speak the OpenAI API with no Authorization header. The provider will be called without a key."}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => setForceApiKey(true)}
                      className="text-xs font-medium text-emerald-700 underline underline-offset-2 hover:text-emerald-900"
                    >
                      My endpoint needs an API key →
                    </button>
                    {isEdit && provider!.configured && (
                      <span className="text-xs text-emerald-600">· stored key kept unless you replace it above</span>
                    )}
                  </div>
                </div>
              )
            }
            return (
              <Field
                label={
                  selfHosted
                    ? "API key (self-hosted — optional)"
                    : "API key (optional)"
                }
                hint={
                  isEdit
                    ? provider!.configured
                      ? "Leave blank to keep the stored key."
                      : selfHosted
                        ? "Leave blank — self-hosted endpoints take no key unless you enabled auth."
                        : "Leave blank to keep using the server's environment variable."
                    : selfHosted
                      ? "Only if your self-hosted endpoint has auth enabled — otherwise leave blank."
                      : "Only needed for authenticated vendors (Cloudflare, Groq, OpenRouter, OpenAI, ...). Encrypted at rest."
                }
              >
                <div className="relative">
                  <input
                    type={showKey ? "text" : "password"}
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    // Chrome ignores autoComplete="off" on password-type inputs by
                    // design and offers saved-password autofill anyway;
                    // "new-password" is the one value it actually honors.
                    autoComplete="new-password"
                    spellCheck={false}
                    placeholder={isEdit && provider!.configured ? provider!.preview : selfHosted ? "(leave blank — no auth)" : "sk-… (leave blank if none needed)"}
                    className={inputCls + " pr-11"}
                  />
                  <button
                    type="button"
                    onClick={() => setShowKey((s) => !s)}
                    className="absolute right-3.5 top-1/2 -translate-y-1/2 text-vez-mute hover:text-vez-ink"
                    aria-label={showKey ? "Hide key" : "Show key"}
                  >
                    {showKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                  </button>
                </div>
                {selfHosted && (
                  <button
                    type="button"
                    onClick={() => {
                      setApiKey("")
                      setForceApiKey(false)
                    }}
                    className="mt-1.5 text-xs text-vez-mute underline underline-offset-2 hover:text-vez-ink"
                  >
                    ← No key needed — hide this field
                  </button>
                )}
              </Field>
            )
          })()}

          {error && (
            <div className="flex items-start gap-2 rounded-[12px] bg-red-50 px-3.5 py-3 text-xs text-red-600">
              <AlertCircle className="mt-0.5 size-4 shrink-0" /> {error}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button
              onClick={onClose}
              className="rounded-full border border-vez-line px-5 py-2.5 text-sm text-vez-ink transition-colors hover:bg-vez-surface"
            >
              Cancel
            </button>
            <button
              onClick={submit}
              disabled={!canSave}
              className="flex items-center gap-2 rounded-full bg-vez-navy px-6 py-2.5 text-sm text-white transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              {saving && <Loader2 className="size-4 animate-spin" />}
              {isEdit ? "Save changes" : "Add provider"}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

const inputCls =
  "h-11 w-full rounded-full border border-vez-line bg-white px-4 text-sm text-vez-ink outline-none transition-colors placeholder:text-vez-mute focus:border-vez-sky"

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div>
      <label className="mb-1.5 block text-sm font-medium text-vez-ink">{label}</label>
      {children}
      {hint && <p className="mt-1.5 text-xs text-vez-mute">{hint}</p>}
    </div>
  )
}
