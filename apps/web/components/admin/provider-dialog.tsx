"use client"

import { useState } from "react"
import { AlertCircle, Eye, EyeOff, Loader2, X } from "lucide-react"
import type { AiProvider, AiProviderInput, AiProviderKind } from "@/lib/types"

/** Presets so the common vendors are one click, not a URL hunt. */
const PRESETS: Array<{
  label: string
  kind: AiProviderKind
  baseUrl: string
  model: string
  region?: string
}> = [
  {
    label: "AWS Bedrock (Claude Sonnet 4.6)",
    kind: "BEDROCK",
    baseUrl: "",
    region: "us-west-2",
    model: "global.anthropic.claude-sonnet-4-6",
  },
  {
    label: "OpenAI",
    kind: "OPENAI_COMPATIBLE",
    baseUrl: "https://api.openai.com/v1/chat/completions",
    model: "gpt-4o-mini",
  },
  {
    label: "OpenRouter",
    kind: "OPENAI_COMPATIBLE",
    baseUrl: "https://openrouter.ai/api/v1/chat/completions",
    model: "meta-llama/llama-3.3-70b-instruct",
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
  const [region, setRegion] = useState(provider?.region ?? "us-west-2")
  const [model, setModel] = useState(provider?.model ?? "")
  const [apiKey, setApiKey] = useState("")
  const [showKey, setShowKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const applyPreset = (p: (typeof PRESETS)[number]) => {
    setLabel((l) => l || p.label)
    setKind(p.kind)
    setBaseUrl(p.baseUrl)
    if (p.region) setRegion(p.region)
    setModel((m) => m || p.model)
  }

  const submit = async () => {
    setSaving(true)
    setError(null)
    try {
      await onSubmit({
        label,
        kind,
        // Only an OpenAI-compatible provider is URL-addressed; Gemini derives
        // its URL from the model and Bedrock from the region.
        baseUrl: kind === "OPENAI_COMPATIBLE" ? baseUrl : null,
        region: kind === "BEDROCK" ? region : null,
        model,
        // Only include the key when non-empty — see the note above.
        ...(apiKey ? { apiKey } : {}),
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
    (kind === "OPENAI_COMPATIBLE" ? Boolean(baseUrl.trim()) : true) &&
    (kind === "BEDROCK" ? Boolean(region.trim()) : true) &&
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
                  className="rounded-full border border-vez-line px-3 py-1.5 text-xs text-vez-ink transition-colors hover:border-vez-sky hover:bg-vez-sky/10"
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
              placeholder="e.g. OpenRouter"
              className={inputCls}
            />
          </Field>

          <Field label="API format">
            <div className="flex flex-wrap gap-1.5">
              {(
                [
                  ["OPENAI_COMPATIBLE", "OpenAI-compatible"],
                  ["GEMINI", "Google Gemini"],
                  ["BEDROCK", "AWS Bedrock (Claude)"],
                ] as const
              ).map(([value, text]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setKind(value)}
                  className={`rounded-full px-4 py-2 text-sm transition-colors ${
                    kind === value
                      ? "bg-vez-navy text-white"
                      : "border border-vez-line text-vez-ink hover:bg-vez-surface"
                  }`}
                >
                  {text}
                </button>
              ))}
            </div>
          </Field>

          {kind === "OPENAI_COMPATIBLE" && (
            <Field
              label="Endpoint URL"
              hint="Must be https. Internal/plain-http hosts need AI_PROVIDER_ALLOWED_HOSTS on the server."
            >
              <input
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://api.example.com/v1/chat/completions"
                spellCheck={false}
                className={inputCls + " font-mono text-[13px]"}
              />
            </Field>
          )}

          {kind === "BEDROCK" && (
            <Field
              label="AWS region"
              hint="Where the Bedrock endpoint is called. Must be a region your account has Claude model access in."
            >
              <input
                value={region}
                onChange={(e) => setRegion(e.target.value)}
                placeholder="us-west-2"
                spellCheck={false}
                className={inputCls + " font-mono text-[13px]"}
              />
            </Field>
          )}

          <Field
            label="Model"
            hint={
              kind === "BEDROCK"
                ? "Bedrock model ID. The global.* prefix routes cross-region — best availability, no regional pricing premium."
                : undefined
            }
          >
            <input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={
                kind === "BEDROCK" ? "global.anthropic.claude-sonnet-4-6" : "gpt-4o-mini"
              }
              spellCheck={false}
              className={inputCls + " font-mono text-[13px]"}
            />
          </Field>

          <Field
            label={kind === "BEDROCK" ? "Bedrock API key" : "API key"}
            hint={
              isEdit
                ? provider!.configured
                  ? "Leave blank to keep the stored key."
                  : "Leave blank to keep using the server's environment variable."
                : kind === "BEDROCK"
                  ? "A Bedrock bearer token (AWS console → Bedrock → API keys), not an Anthropic key. Encrypted at rest."
                  : "Encrypted at rest and never shown again once saved."
            }
          >
            <div className="relative">
              <input
                type={showKey ? "text" : "password"}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                placeholder={isEdit && provider!.configured ? provider!.preview : "sk-…"}
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
          </Field>

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
