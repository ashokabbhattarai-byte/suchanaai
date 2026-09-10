"use client"

import { useEffect, useRef, useState } from "react"
import { AlertCircle, Check, ChevronDown, Loader2, RefreshCw, Search } from "lucide-react"
import { fetchAiProviderModels } from "@/lib/api"
import type { AiProvider, AiProviderModel } from "@/lib/types"

/** 262144 → "256k", 1048576 → "1M" — model lists are dense enough already. */
export function formatContext(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_048_576).toFixed(tokens % 1_048_576 ? 1 : 0)}M`
  if (tokens >= 1000) return `${Math.round(tokens / 1024)}k`
  return String(tokens)
}

/**
 * Inline model switcher on a provider card: opens a searchable list of what
 * the provider actually serves and saves the pick immediately.
 *
 * The catalogue is fetched lazily on first open rather than on mount — a page
 * with eight providers would otherwise fire eight upstream calls before the
 * admin has asked for anything.
 */
export function ModelSelect({
  provider,
  onSelect,
}: {
  provider: AiProvider
  onSelect: (model: string) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [models, setModels] = useState<AiProviderModel[]>([])
  const [query, setQuery] = useState("")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)

  // Bedrock has no catalogue endpoint — the dialog's free-text field is the
  // only way to set its model, so don't offer a dropdown that can't fill.
  const supported = provider.kind !== "BEDROCK"

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      const { models: found, note } = await fetchAiProviderModels({
        id: provider.id,
        kind: provider.kind,
        baseUrl: provider.baseUrl,
      })
      setModels(found)
      setLoaded(true)
      if (note) setError(note)
      else if (!found.length) setError("The provider returned no models.")
    } catch (e) {
      setModels([])
      setError(e instanceof Error ? e.message : "Could not load models.")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (open && !loaded && !loading) void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false)
    }
    document.addEventListener("mousedown", onClick)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("mousedown", onClick)
      document.removeEventListener("keydown", onKey)
    }
  }, [open])

  const pick = async (id: string) => {
    if (id === provider.model) {
      setOpen(false)
      return
    }
    setSaving(id)
    setError(null)
    try {
      await onSelect(id)
      setOpen(false)
      setQuery("")
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save that model.")
    } finally {
      setSaving(null)
    }
  }

  const visible = models.filter((m) => m.id.toLowerCase().includes(query.trim().toLowerCase()))

  if (!supported) {
    return <span className="font-mono text-[11px] text-vez-mute">{provider.model}</span>
  }

  return (
    <div ref={boxRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-label={`Change model for ${provider.label}`}
        className="flex max-w-[15rem] items-center gap-1 rounded-full border border-vez-line bg-white px-2.5 py-0.5 font-mono text-[11px] text-vez-ink transition-colors hover:border-vez-navy/40 hover:bg-vez-surface"
      >
        <span className="truncate">{provider.model}</span>
        {saving ? (
          <Loader2 className="size-3 shrink-0 animate-spin" />
        ) : (
          <ChevronDown className={`size-3 shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
        )}
      </button>

      {open && (
        <div className="absolute left-0 z-40 mt-1.5 w-[min(22rem,calc(100vw-3rem))] overflow-hidden rounded-[14px] border border-vez-line bg-white shadow-xl">
          <div className="flex items-center gap-2 border-b border-vez-line/70 px-3 py-2">
            <Search className="size-3.5 shrink-0 text-vez-mute" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={loading ? "Loading models…" : `Search ${models.length || ""} models…`}
              spellCheck={false}
              autoComplete="off"
              autoFocus
              className="min-w-0 flex-1 bg-transparent font-mono text-[12px] text-vez-ink outline-none placeholder:font-sans placeholder:text-vez-mute"
            />
            <button
              type="button"
              onClick={load}
              disabled={loading}
              title="Reload the catalogue"
              className="shrink-0 rounded-full p-1 text-vez-mute transition-colors hover:bg-vez-surface hover:text-vez-ink disabled:opacity-50"
            >
              <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
            </button>
          </div>

          {error && (
            <p className="flex items-start gap-1.5 border-b border-vez-line/70 bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-800">
              <AlertCircle className="mt-0.5 size-3 shrink-0" />
              <span className="min-w-0 break-words">{error}</span>
            </p>
          )}

          <ul className="max-h-64 overflow-y-auto overscroll-contain">
            {loading && models.length === 0 && (
              <li className="flex justify-center py-6">
                <Loader2 className="size-4 animate-spin text-vez-mute" />
              </li>
            )}
            {!loading && visible.length === 0 && (
              <li className="px-3 py-4 text-center text-[11px] text-vez-mute">
                {models.length ? "No model matches that search." : "No models to show."}
              </li>
            )}
            {visible.map((m) => (
              <li key={m.id}>
                <button
                  type="button"
                  onClick={() => pick(m.id)}
                  disabled={Boolean(saving)}
                  className={`flex w-full items-center gap-2 border-b border-vez-line/50 px-3 py-2 text-left transition-colors last:border-b-0 hover:bg-vez-surface disabled:opacity-50 ${
                    m.id === provider.model ? "bg-vez-sky/20" : ""
                  }`}
                >
                  <span className="flex size-3.5 shrink-0 items-center justify-center">
                    {saving === m.id ? (
                      <Loader2 className="size-3 animate-spin text-vez-navy" />
                    ) : m.id === provider.model ? (
                      <Check className="size-3.5 text-vez-navy" />
                    ) : null}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-mono text-[12px] text-vez-ink">{m.id}</span>
                    {(m.free || m.contextLength || m.modality) && (
                      <span className="flex flex-wrap items-center gap-1.5 text-[10px] text-vez-mute">
                        {m.free && (
                          <span className="rounded-full bg-emerald-100 px-1.5 text-emerald-700">FREE</span>
                        )}
                        {m.contextLength && <span>{formatContext(m.contextLength)} ctx</span>}
                        {m.modality && <span>· {m.modality}</span>}
                      </span>
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
