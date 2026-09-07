"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { MessageSquareText, Loader2, RotateCcw, Save, Info } from "lucide-react"
import {
  fetchSettings,
  updateSettings,
  resetSetting,
  fetchAlertTemplateTokens,
  previewAlertTemplate,
  AlertTemplateToken,
} from "@/lib/api"
import { toast } from "sonner"

const SETTING_KEY = "alerts.whatsappTemplate"
const PREVIEW_DEBOUNCE_MS = 400

/**
 * Editor for the WhatsApp alert message template — what a user actually
 * receives when a scraped notice matches one of their alert rules. The
 * template itself persists as a plain admin setting (`alerts.whatsappTemplate`,
 * see settings.service.ts); this card exists because a raw textarea in the
 * generic settings page has no idea what tokens are valid or what the
 * message will actually look like rendered — this one shows both.
 */
export function AlertTemplateCard() {
  const [template, setTemplate] = useState("")
  const [savedTemplate, setSavedTemplate] = useState("")
  const [defaultTemplate, setDefaultTemplate] = useState("")
  const [tokens, setTokens] = useState<AlertTemplateToken[]>([])
  const [preview, setPreview] = useState("")
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [previewing, setPreviewing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    Promise.all([fetchSettings(), fetchAlertTemplateTokens()])
      .then(([settings, tokenInfo]) => {
        const row = settings.settings.find((s) => s.key === SETTING_KEY)
        const value = row?.value ?? tokenInfo.default
        setTemplate(value)
        setSavedTemplate(value)
        setDefaultTemplate(tokenInfo.default)
        setTokens(tokenInfo.tokens)
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load the template"))
      .finally(() => setLoading(false))
  }, [])

  const runPreview = useCallback((text: string) => {
    setPreviewing(true)
    previewAlertTemplate(text)
      .then((r) => setPreview(r.preview))
      .catch((e) => setError(e instanceof Error ? e.message : "Preview failed"))
      .finally(() => setPreviewing(false))
  }, [])

  // Live preview, debounced so every keystroke doesn't fire a request.
  useEffect(() => {
    if (loading) return
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => runPreview(template), PREVIEW_DEBOUNCE_MS)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [template, loading])

  const dirty = template !== savedTemplate

  const handleSave = async () => {
    setSaving(true)
    setError(null)
    try {
      const result = await updateSettings({ [SETTING_KEY]: template })
      if (result.errors.length > 0) {
        setError(result.errors[0].message)
        return
      }
      setSavedTemplate(template)
      toast.success("Alert template saved")
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the template")
    } finally {
      setSaving(false)
    }
  }

  const handleReset = async () => {
    if (!confirm("Reset the WhatsApp alert template to the built-in default? Your edits will be lost.")) return
    setResetting(true)
    setError(null)
    try {
      await resetSetting(SETTING_KEY)
      setTemplate(defaultTemplate)
      setSavedTemplate(defaultTemplate)
      toast.success("Template reset to default")
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not reset the template")
    } finally {
      setResetting(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center rounded-[20px] bg-white p-10">
        <Loader2 className="size-5 animate-spin text-vez-mute" />
      </div>
    )
  }

  return (
    <div className="rounded-[20px] bg-white p-6 md:p-8">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-4">
          <div className="flex size-11 items-center justify-center rounded-full bg-vez-navy text-white">
            <MessageSquareText className="size-5" />
          </div>
          <div>
            <h2 className="text-lg text-vez-ink">WhatsApp alert template</h2>
            <p className="mt-1 text-xs text-vez-mute">
              What a user receives when a notice matches their alert rule
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleReset}
            disabled={resetting || saving}
            className="flex items-center gap-1.5 rounded-full border border-vez-line px-4 py-2 text-xs text-vez-ink transition-colors hover:bg-vez-surface disabled:opacity-50"
          >
            {resetting ? <Loader2 className="size-3.5 animate-spin" /> : <RotateCcw className="size-3.5" />}
            Reset to default
          </button>
          <button
            onClick={handleSave}
            disabled={!dirty || saving}
            className="flex items-center gap-1.5 rounded-full bg-vez-navy px-5 py-2 text-xs text-white transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
            Save
          </button>
        </div>
      </div>

      {error && <div className="mt-4 rounded-full bg-red-50 px-4 py-2 text-xs text-red-600">{error}</div>}

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Editor + token reference */}
        <div>
          <label className="mb-1.5 block text-xs font-medium text-vez-ink">Template</label>
          <textarea
            value={template}
            onChange={(e) => setTemplate(e.target.value)}
            rows={20}
            spellCheck={false}
            className="w-full rounded-[12px] border border-vez-line bg-vez-surface/40 p-3 font-mono text-xs leading-relaxed text-vez-ink outline-none transition-colors focus:border-vez-navy"
          />
          {dirty && <p className="mt-1.5 text-[11px] text-amber-600">Unsaved changes</p>}

          <details className="mt-4 rounded-[12px] bg-vez-surface/60 p-3">
            <summary className="flex cursor-pointer items-center gap-1.5 text-xs font-medium text-vez-ink">
              <Info className="size-3.5" /> Available tokens ({tokens.length})
            </summary>
            <ul className="mt-3 space-y-1.5">
              {tokens.map((t) => (
                <li key={t.token} className="text-[11px] leading-relaxed">
                  <code className="rounded bg-white px-1.5 py-0.5 text-vez-navy">{`{{${t.token}}}`}</code>
                  {t.optional && (
                    <code className="ml-1 rounded bg-white px-1.5 py-0.5 text-vez-mute">{`{{#${t.token}}}...{{/${t.token}}}`}</code>
                  )}
                  <span className="ml-2 text-vez-mute">{t.description}</span>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-[11px] text-vez-mute">
              <code className="rounded bg-white px-1 py-0.5">{"{{#field}}...{{/field}}"}</code> shows the enclosed
              text only when that field has a value — use it for anything not every notice has (organization,
              deadline, urgency, summary, key facts). Digest (batched) alerts use a separate, unrelated format.
            </p>
          </details>
        </div>

        {/* Live preview */}
        <div>
          <div className="mb-1.5 flex items-center gap-2">
            <label className="text-xs font-medium text-vez-ink">Live preview</label>
            {previewing && <Loader2 className="size-3 animate-spin text-vez-mute" />}
          </div>
          <div className="rounded-[12px] bg-[#e5ddd5] p-4">
            <div className="ml-auto max-w-[85%] whitespace-pre-wrap break-words rounded-[10px] rounded-tr-none bg-[#d9fdd3] p-3 text-[13px] leading-relaxed text-[#111b21] shadow-sm">
              {renderWhatsappMarkdown(preview)}
            </div>
          </div>
          <p className="mt-1.5 text-[11px] text-vez-mute">Rendered with sample data — not a real notice.</p>
        </div>
      </div>
    </div>
  )
}

/** *bold* and _italic_ → real formatting, so the preview reads like WhatsApp
 * actually renders it, not like raw markdown source. */
function renderWhatsappMarkdown(text: string) {
  const parts = text.split(/(\*[^*\n]+\*|_[^_\n]+_)/g)
  return parts.map((part, i) => {
    if (part.startsWith("*") && part.endsWith("*") && part.length > 2) {
      return <strong key={i}>{part.slice(1, -1)}</strong>
    }
    if (part.startsWith("_") && part.endsWith("_") && part.length > 2) {
      return <em key={i}>{part.slice(1, -1)}</em>
    }
    return <span key={i}>{part}</span>
  })
}
