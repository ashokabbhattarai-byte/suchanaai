"use client"

import React, { useState, useRef, useEffect, useMemo, useCallback } from "react"
import {
  FileText, Search, Send, Upload, Bot, User,
  MessageSquare, ChevronRight,
  LayoutPanelLeft, BookOpen, Copy, Trash2,
  ThumbsUp, ThumbsDown, RefreshCw, CheckCircle,
  AlertCircle, Loader2, X, File, Download, ArrowRight,
} from "lucide-react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { Header } from "@/components/layout/header"
import { ChatMessage, RagDocument, RagSource, DocumentProgress } from "@/lib/types"
import { useAuth } from "@/lib/auth-context"
import Link from "next/link"
import {
  fetchDocuments, uploadDocument, deleteDocument, ragQuery,
  embedDocument, unembedDocument, fetchDocumentsProgress,
  fetchBillingSummary,
  isQuotaError, isApiError, isNetworkError, type QuotaDenial,
} from "@/lib/api"
import { UpgradePrompt } from "@/components/billing/upgrade-prompt"
import { useConfirm } from "@/components/ui/confirm-dialog"
import { toast } from "sonner"
import { toastApiError } from "@/lib/toast"

// Titles often arrive as raw filenames ("_Hamro_Life_Bank_SRS.pdf");
// humanize them for display in the source chips.
function prettySourceTitle(s: RagSource): string {
  const raw = s.title || "Untitled document"
  return raw
    .replace(/\.[^.]+$/, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

// One chip per document with its citation numbers combined ("[1][2]"),
// instead of a chip per chunk repeating the same name.
function groupSources(sources: RagSource[]) {
  const groups = new Map<
    string,
    { title: string; refs: number[]; score: number; preview: string; pages: number[]; sections: string[] }
  >()
  sources.forEach((s, i) => {
    const pages = (s.page_range ?? []).filter((p): p is number => typeof p === "number")
    const section = (s.section_path ?? "").trim()
    const existing = groups.get(s.doc_id)
    if (existing) {
      existing.refs.push(i + 1)
      existing.score = Math.max(existing.score, s.score)
      existing.pages.push(...pages)
      if (section && !existing.sections.includes(section)) existing.sections.push(section)
    } else {
      groups.set(s.doc_id, {
        title: prettySourceTitle(s),
        refs: [i + 1],
        score: s.score,
        preview: s.content.slice(0, 300),
        pages: [...pages],
        sections: section ? [section] : [],
      })
    }
  })
  // A chip covering several chunks spans every page they touch.
  return [...groups.values()].map((g) => ({
    ...g,
    pageLabel:
      g.pages.length === 0
        ? null
        : Math.min(...g.pages) === Math.max(...g.pages)
          ? `p. ${Math.min(...g.pages)}`
          : `pp. ${Math.min(...g.pages)}–${Math.max(...g.pages)}`,
  }))
}

type ViewMode = "split" | "chat" | "library"
type MobileTab = "library" | "chat"

const suggestions = [
  "What does the constitution say about fundamental rights?",
  "How is the national budget allocated?",
  "What are the e-procurement rules?",
  "What are civil service promotion requirements?",
]

const stageLabels: Record<string, string> = {
  queued: "Queued",
  extracting: "Reading document",
  chunking: "Organizing",
  embedding: "Embedding",
  indexing: "Finalizing",
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatMimeType(mime: string): string {
  if (mime.includes("pdf")) return "PDF"
  if (mime.includes("wordprocessingml")) return "DOCX"
  if (mime.includes("text/plain")) return "TXT"
  if (mime.includes("image/png")) return "PNG"
  if (mime.includes("image/jpeg")) return "JPEG"
  return mime.split("/").pop()?.toUpperCase() ?? "FILE"
}

// ─── Markdown ─────────────────────────────────────────────────────────────────

function Markdown({ content }: { content: string }) {
  return (
    // A paragraph that is only bold text is a section heading: give it room
    // above and pull its list up close, so groups read as groups.
    <div className="[&>p:has(>strong:only-child)]:mb-1.5 [&>p:has(>strong:only-child)]:mt-4 [&>p:first-child]:mt-0">
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        p: ({ children }) => <p className="mb-3 leading-relaxed last:mb-0">{children}</p>,
        ul: ({ children }) => <ul className="mb-3 list-disc space-y-1.5 pl-5 last:mb-0 marker:text-vez-mute/50">{children}</ul>,
        ol: ({ children }) => <ol className="mb-3 list-decimal space-y-1.5 pl-5 last:mb-0 marker:text-vez-mute/50">{children}</ol>,
        li: ({ children }) => <li className="pl-0.5 leading-relaxed">{children}</li>,
        strong: ({ children }) => <strong className="font-semibold text-vez-ink">{children}</strong>,
        a: ({ href, children }) => (
          <a href={href} target="_blank" rel="noreferrer" className="text-vez-navy underline underline-offset-2">{children}</a>
        ),
        h1: ({ children }) => <p className="mb-1.5 mt-4 text-base font-semibold text-vez-ink first:mt-0">{children}</p>,
        h2: ({ children }) => <p className="mb-1.5 mt-4 text-base font-semibold text-vez-ink first:mt-0">{children}</p>,
        h3: ({ children }) => <p className="mb-1.5 mt-4 font-semibold text-vez-ink first:mt-0">{children}</p>,
        code: ({ children }) => (
          <code className="rounded bg-vez-sky/20 px-1.5 py-0.5 font-mono text-[13px] text-vez-navy">{children}</code>
        ),
        blockquote: ({ children }) => (
          <blockquote className="mb-2 border-l-2 border-vez-sky pl-3 text-vez-mute last:mb-0">{children}</blockquote>
        ),
        table: ({ children }) => (
          <div className="mb-3 max-w-full overflow-x-auto last:mb-0">
            <table className="w-full min-w-[520px] border-collapse text-[13px]">{children}</table>
          </div>
        ),
        th: ({ children }) => <th className="whitespace-nowrap border border-vez-line/60 bg-vez-sky/10 px-3 py-2 text-left font-semibold">{children}</th>,
        td: ({ children }) => <td className="border border-vez-line/60 px-3 py-2 align-top">{children}</td>,
      }}
    >
      {content}
    </ReactMarkdown>
    </div>
  )
}

// ─── Embed toggle ─────────────────────────────────────────────────────────────

function EmbedToggle({ on, busy, onChange }: { on: boolean; busy: boolean; onChange: () => void }) {
  return (
    <button
      role="switch"
      aria-checked={on}
      aria-label={on ? "Make this document unsearchable" : "Make this document searchable"}
      disabled={busy}
      onClick={onChange}
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors duration-200 disabled:cursor-not-allowed disabled:opacity-50 ${
        on ? "bg-emerald-500" : "bg-vez-line"
      }`}
    >
      <span
        className={`absolute top-0.5 flex size-5 items-center justify-center rounded-full bg-white shadow transition-all duration-200 ${
          on ? "left-[22px]" : "left-0.5"
        }`}
      >
        {busy && <Loader2 className="size-3 animate-spin text-vez-mute" />}
      </span>
    </button>
  )
}

// ─── DocCard ──────────────────────────────────────────────────────────────────

function DocCard({ doc, progress, toggleBusy, canManage, onToggleEmbed, onDelete, onAsk }: {
  doc: RagDocument
  progress?: DocumentProgress
  toggleBusy: boolean
  canManage: boolean
  onToggleEmbed: () => void
  onDelete: () => void
  onAsk: () => void
}) {
  const isIndexed = doc.status === "INDEXED"
  const isProcessing = doc.status === "PENDING" || doc.status === "PROCESSING"
  const isFailed = doc.status === "FAILED"
  const isUnembedded = doc.status === "UNEMBEDDED"
  const showControls = canManage && !doc.isSystem

  // Never show 0% for a processing doc — 0 reads as "Queued/stuck" and flickers
  // when a transient network blip hides the first poll. Fall back to 2 so the
  // bar and number stay visibly alive even before the first real percent lands
  // (matches the AI's queued 0-3% start).
  const percent = isProcessing ? (progress?.percent ?? 2) : 0
  // When the AI has accepted the job but the first progress poll hasn't
  // landed yet (or a transient ERR_NETWORK_CHANGED burst hid it), show
  // "Processing" rather than "Queued" so the card already feels alive.
  // The bar itself stays indeterminate at 5% until the first real percent arrives.
  const stageLabel = progress?.stage
    ? (stageLabels[progress.stage] ?? progress.message ?? "Processing")
    : isProcessing
      ? "Processing"
      : "Queued"
  // Rich detail: prefer explicit chunk counts, fallback to the AI's message
  const progressDetail = (() => {
    if (!isProcessing || !progress) return null
    if (progress.total_chunks && progress.total_chunks > 0) {
      const done = progress.processed_chunks ?? 0
      // Show "Embedding 12/48" when in the embedding stage
      if (progress.stage === "embedding" || progress.stage === "indexing") {
        return `${done}/${progress.total_chunks} chunks`
      }
    }
    if (progress.message && progress.message !== stageLabel) return progress.message
    return null
  })()

  return (
    <div className="flex h-full min-w-0 flex-col rounded-2xl border border-vez-line/50 bg-white p-4 shadow-sm transition-all hover:border-vez-sky/50 hover:shadow-md sm:p-6">
      <div className="mb-3 flex items-start gap-3 sm:gap-4">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-vez-sky/20 sm:size-11">
          <FileText className="size-5 text-vez-navy" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="line-clamp-2 min-w-0 flex-1 break-words text-[15px] font-medium leading-snug text-vez-ink sm:line-clamp-3">{doc.title}</p>
            {doc.isSystem && (
              <span className="shrink-0 rounded-md bg-vez-navy/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-vez-navy">
                System
              </span>
            )}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <span className="rounded-md bg-vez-surface px-2 py-0.5 text-xs font-medium text-vez-mute">
              {formatMimeType(doc.mimeType)}
            </span>
            <span className="rounded-md bg-vez-surface px-2 py-0.5 text-xs text-vez-mute">
              {formatFileSize(doc.fileSize)}
            </span>
            {isIndexed && (
              <span className="flex items-center gap-1 rounded-md bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
                <CheckCircle className="size-3" /> Ready to search
              </span>
            )}
            {isFailed && (
              <span className="flex items-center gap-1 rounded-md bg-red-50 px-2 py-0.5 text-xs font-medium text-red-600">
                <AlertCircle className="size-3" /> Failed
              </span>
            )}
            {doc.isOcr && (
              <span className="rounded-md bg-purple-50 px-2 py-0.5 text-xs font-medium text-purple-700">
                OCR
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Embed state row */}
      {isProcessing ? (
        <div className="mb-3 rounded-xl bg-vez-surface/70 px-3.5 py-3">
          <div className="mb-2 flex items-center justify-between gap-2 text-xs">
            <span className="flex items-center gap-1.5 font-medium text-vez-navy">
              <Loader2 className="size-3 animate-spin" /> {stageLabel}
            </span>
            <span className="tabular-nums text-vez-mute">{Math.max(percent, 2)}%</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-vez-line/50">
            <div
              className="h-full rounded-full bg-vez-navy transition-all duration-500"
              style={{ width: `${Math.max(percent, 3)}%` }}
            />
          </div>
          {progressDetail && (
            <p className="mt-1.5 truncate text-[11px] leading-none text-vez-mute">{progressDetail}</p>
          )}
        </div>
      ) : (
        <div className="mb-3 flex flex-col gap-3 rounded-xl bg-vez-surface/70 p-3 sm:flex-row sm:items-center sm:justify-between sm:px-4 sm:py-3">
          <div className="min-w-0 flex-1">
            <p className="break-words text-sm font-medium text-vez-ink">
              {isIndexed ? "Ready" : isFailed ? "Couldn't be prepared" : "Not ready yet"}
            </p>
            <p className="break-words text-xs text-vez-mute line-clamp-2">
              {isIndexed
                ? "You can ask questions about this"
                : isFailed
                  ? showControls ? "Turn off and on to try again" : "Please try uploading it again"
                  : showControls ? "Turn on to make it searchable" : "Not yet available"}
            </p>
          </div>
          {showControls && (
            <EmbedToggle on={isIndexed} busy={toggleBusy} onChange={onToggleEmbed} />
          )}
        </div>
      )}

      <div className="flex flex-col gap-2 border-t border-vez-line/40 pt-3 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
        <div className="flex flex-wrap items-center gap-1">
          <button
            className="flex min-h-[44px] items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-vez-navy transition-colors hover:bg-vez-sky/15 disabled:cursor-not-allowed disabled:opacity-40"
            onClick={onAsk}
            disabled={!isIndexed}
          >
            <MessageSquare className="size-4" /> Ask about this
          </button>
          <a
            href={`/api/files/document/${doc.id}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex min-h-[44px] items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-vez-mute transition-colors hover:bg-vez-surface hover:text-vez-ink"
            title="Download original file"
          >
            <Download className="size-4" /> <span className="hidden sm:inline">Download</span>
          </a>
        </div>

        {showControls && (
          <button
            className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-red-500 transition-colors hover:bg-red-50 hover:text-red-600"
            onClick={onDelete}
          >
            <Trash2 className="size-4" /> Delete
          </button>
        )}
      </div>
    </div>
  )
}

// ─── Upload Modal ─────────────────────────────────────────────────────────────

// Hard infra ceiling (matches MAX_FILE_SIZE_MB in documents.controller.ts, currently 100).
// Per-plan limits (e.g. FREE 5 MB) are lower and fetched via billing summary
// so the UI can warn plan-aware before the upload, and the server enforces
// with 402 quota errors that carry an upgrade CTA.
const HARD_CAP_MB = 100
const HARD_CAP_BYTES = HARD_CAP_MB * 1024 * 1024

function UploadModal({ onClose, onUploaded }: { onClose: () => void; onUploaded: () => void }) {
  const [file, setFile] = useState<File | null>(null)
  const [title, setTitle] = useState("")
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState<number | null>(null)
  const [error, setError] = useState("")
  const [quota, setQuota] = useState<QuotaDenial | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [planLimitMb, setPlanLimitMb] = useState<number | null>(null)
  const [planLimitLoading, setPlanLimitLoading] = useState(true)
  const inputRef = useRef<HTMLInputElement>(null)

  // Fetch plan-aware limit so the drop-zone hint and pre-check use the user's
  // actual maxUploadMb (FREE 5, PRO 25, MAX 100) instead of just the infra cap.
  useEffect(() => {
    let cancelled = false
    fetchBillingSummary()
      .then(s => { if (!cancelled) setPlanLimitMb(s.limits.maxUploadMb) })
      .catch(() => { if (!cancelled) setPlanLimitMb(null) })
      .finally(() => { if (!cancelled) setPlanLimitLoading(false) })
    return () => { cancelled = true }
  }, [])

  const effectiveLimitMb = planLimitMb ?? HARD_CAP_MB
  const effectiveLimitBytes = effectiveLimitMb * 1024 * 1024
  // The real ceiling is the lower of plan and infra — a paid plan never
  // exceeds the infra 100 MB cap (matches MAX_FILE_SIZE_MB in documents.controller.ts).
  const displayLimitMb = Math.min(effectiveLimitMb, HARD_CAP_MB)
  const clientLimitBytes = Math.min(effectiveLimitBytes, HARD_CAP_BYTES)

  const handleUpload = async () => {
    if (!file || !title.trim()) return
    // Re-validate immediately before upload — avoids wasting bandwidth if the
    // plan changed since the file was picked, and turns a 413 after 2 min into
    // an instant client error.
    if (file.size > clientLimitBytes) {
      const sizeMb = (file.size / 1024 / 1024).toFixed(1)
      if (planLimitMb !== null && planLimitMb < HARD_CAP_MB) {
        setError(
          `"${file.name}" is ${sizeMb} MB — your plan allows up to ${displayLimitMb} MB. Upgrade for larger uploads.`,
        )
      } else {
        setError(`"${file.name}" is ${sizeMb} MB — the limit is ${displayLimitMb} MB.`)
      }
      return
    }
    setUploading(true)
    setUploadProgress(0)
    setError("")
    setQuota(null)
    try {
      // True multipart/form-data streaming with progress. The onProgress
      // callback drives the XHR upload path in lib/api.ts (fetch has no
      // upload progress); callers without a callback fall back to fetch.
      // 10-minute timeout covers 100 MB on slow 3G.
      await uploadDocument(file, title.trim(), (pct) => setUploadProgress(pct))
      onUploaded()
      onClose()
    } catch (e) {
      setUploadProgress(null)
      // A plan limit is not a failure to retry — show what ran out and how to
      // fix it, instead of a red error the user can only stare at.
      if (isQuotaError(e)) setQuota(e.quota)
      else if (isNetworkError(e)) setError(e.message)
      else if (isApiError(e)) {
        // Preserve server's plan-aware message; enrich only if generic.
        if (e.status === 413) {
          setError(e.message || `File too large — limit is ${displayLimitMb} MB. Try a smaller file or upgrade your plan.`)
        } else if (e.status === 429) {
          setError(e.message || "Too many requests — please wait a moment and retry.")
        } else if (e.status === 502 || e.status === 504 || e.status >= 500) {
          setError(e.message || `Server error (${e.status}) — please try again in a moment.`)
        } else if (e.status === 402) {
          setError(e.message)
        } else {
          setError(e.message)
        }
      } else setError(e instanceof Error ? e.message : "Upload failed")
    } finally {
      setUploading(false)
    }
  }

  /** Reject oversized files here rather than after a long upload that 413s. */
  const acceptFile = (candidate: File | null) => {
    if (!candidate) {
      setFile(null)
      setUploadProgress(null)
      return
    }
    if (candidate.size > clientLimitBytes) {
      setFile(null)
      setUploadProgress(null)
      const sizeMb = (candidate.size / 1024 / 1024).toFixed(1)
      if (planLimitMb !== null && planLimitMb < HARD_CAP_MB) {
        setError(
          `"${candidate.name}" is ${sizeMb} MB — your plan allows up to ${displayLimitMb} MB. Upgrade for larger uploads.`,
        )
      } else {
        setError(
          `"${candidate.name}" is ${sizeMb} MB — the limit is ${displayLimitMb} MB.`,
        )
      }
      return
    }
    setError("")
    setQuota(null)
    setUploadProgress(null)
    setFile(candidate)
    if (!title) setTitle(candidate.name.replace(/\.[^.]+$/, ""))
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    // Large drags (5-100MB) are handled here without reading the file into
    // memory — acceptFile only inspects `File.size`/name, streaming happens
    // later via FormData in uploadDocument.
    acceptFile(e.dataTransfer.files[0] ?? null)
  }

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    acceptFile(e.target.files?.[0] ?? null)
    // Reset the input so the same file can be re-picked after an error.
    if (e.target) e.target.value = ""
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      onClick={uploading ? undefined : onClose}
    >
      <div className="max-h-[90dvh] w-full max-w-lg overflow-y-auto rounded-3xl bg-white p-6 shadow-2xl sm:p-8" onClick={e => e.stopPropagation()}>
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h2 className="text-xl font-semibold text-vez-ink">Upload Document</h2>
            <p className="mt-1 text-sm text-vez-mute">Ready to search a moment after upload</p>
          </div>
          <button
            onClick={onClose}
            disabled={uploading}
            aria-label="Close upload dialog"
            className="rounded-full p-2 text-vez-mute transition-colors hover:bg-vez-surface hover:text-vez-ink disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <X className="size-5" />
          </button>
        </div>

        <div className="space-y-5">
          {/* File drop zone */}
          <div
            onDragOver={e => { e.preventDefault(); setDragOver(true) }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
          >
            <input
              ref={inputRef}
              type="file"
              accept=".pdf,.docx,.txt,.png,.jpg,.jpeg"
              onChange={handleFileSelect}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              disabled={uploading}
              className={`flex w-full flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed px-6 py-8 transition-all sm:py-10 disabled:opacity-60 disabled:cursor-not-allowed ${
                dragOver
                  ? "border-vez-navy bg-vez-sky/10"
                  : file
                    ? "border-emerald-300 bg-emerald-50/50"
                    : "border-vez-line hover:border-vez-sky hover:bg-vez-sky/5"
              }`}
            >
              {file ? (
                <>
                  <div className="flex size-14 items-center justify-center rounded-2xl bg-emerald-100">
                    <File className="size-7 text-emerald-600" />
                  </div>
                  <div className="text-center">
                    <p className="text-base font-medium text-vez-ink">{file.name}</p>
                    <p className="mt-1 text-sm text-vez-mute">{formatFileSize(file.size)} · Click to change</p>
                  </div>
                </>
              ) : (
                <>
                  <div className="flex size-14 items-center justify-center rounded-2xl bg-vez-surface">
                    <Upload className="size-7 text-vez-mute" />
                  </div>
                  <div className="text-center">
                    <p className="text-base font-medium text-vez-ink">Drop file here or click to browse</p>
                    <p className="mt-1 text-sm text-vez-mute">
                      PDF, DOCX, TXT, PNG, JPEG - up to {planLimitLoading ? "…" : displayLimitMb} MB{planLimitMb !== null && !planLimitLoading && planLimitMb < HARD_CAP_MB ? " on your plan" : ""}
                    </p>
                  </div>
                </>
              )}
            </button>
          </div>

          {/* Title input */}
          <div>
            <label className="mb-2 block text-sm font-medium text-vez-ink">Document Title</label>
            <input
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="e.g. Nepal Constitution 2072"
              disabled={uploading}
              className="h-12 w-full rounded-xl border border-vez-line px-4 text-base text-vez-ink outline-none transition-colors placeholder:text-vez-mute/60 focus:border-vez-navy focus:ring-2 focus:ring-vez-sky/30 disabled:opacity-60 disabled:cursor-not-allowed"
              maxLength={200}
            />
          </div>

          {/* Multipart upload progress — visible for large files (5-100MB) */}
          {uploading && uploadProgress !== null && file && (
            <div className="space-y-2 rounded-xl bg-vez-surface/70 px-4 py-3">
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="flex items-center gap-1.5 font-medium text-vez-navy">
                  <Loader2 className="size-3.5 animate-spin" />
                  Uploading… {uploadProgress}%
                </span>
                <span className="tabular-nums text-vez-mute">
                  {formatFileSize(Math.round((file.size * uploadProgress) / 100))} / {formatFileSize(file.size)}
                </span>
              </div>
              <div
                className="h-2 overflow-hidden rounded-full bg-vez-line/40"
                role="progressbar"
                aria-valuenow={uploadProgress}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label="Upload progress"
              >
                <div
                  className="h-full rounded-full bg-vez-navy transition-all duration-300 ease-out"
                  style={{ width: `${uploadProgress}%` }}
                />
              </div>
              <p className="text-xs leading-relaxed text-vez-mute">
                Streaming as <span className="font-mono">multipart/form-data</span> — keep this tab open. Large files (up to 100&nbsp;MB) use a 10-minute timeout.
              </p>
            </div>
          )}

          {quota && <UpgradePrompt quota={quota} onDismiss={() => setQuota(null)} />}

          {error && (
            <div className="flex items-start gap-2 rounded-xl bg-red-50 px-4 py-3">
              <AlertCircle className="mt-0.5 size-4 shrink-0 text-red-500" />
              <div className="min-w-0 flex-1">
                <p className="text-sm text-red-600 break-words">{error}</p>
                {/* 402 quota, 413 limit, or nginx HTML mapped to 413 — all deserve an upgrade CTA */}
                {(error.toLowerCase().includes("upgrade") || error.toLowerCase().includes("limit") || error.toLowerCase().includes("too large") || error.toLowerCase().includes("allows up to")) && (
                  <Link href="/pricing" className="mt-1.5 inline-flex items-center gap-1 text-xs font-medium text-red-700 underline underline-offset-2 hover:text-red-800">
                    View plans <ArrowRight className="size-3" />
                  </Link>
                )}
                {error.toLowerCase().includes("too many requests") && (
                  <p className="mt-1 text-xs text-red-600/80">Please wait a minute before retrying.</p>
                )}
                {(error.toLowerCase().includes("server error") || error.toLowerCase().includes("timed out")) && (
                  <p className="mt-1 text-xs text-red-600/80">Large files need a stable connection — try again or use a smaller file.</p>
                )}
              </div>
            </div>
          )}

          <button
            onClick={handleUpload}
            disabled={!file || !title.trim() || uploading}
            className="flex h-12 w-full items-center justify-center gap-2.5 rounded-xl bg-vez-navy text-base font-medium text-white transition-all hover:bg-vez-navy/90 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {uploading ? <Loader2 className="size-5 animate-spin" /> : <Upload className="size-5" />}
            {uploading ? (uploadProgress !== null ? `Uploading… ${uploadProgress}%` : "Uploading...") : "Upload document"}
          </button>
          {uploading && (
            <p className="text-center text-xs text-vez-mute">Don&apos;t close this window until the upload completes.</p>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function RagPage() {
  const confirm = useConfirm()
  const { user } = useAuth()

  const [view, setView] = useState<ViewMode>("split")
  const [mobileTab, setMobileTab] = useState<MobileTab>("chat")
  const [libWidth, setLibWidth] = useState(380)
  const resizing = useRef(false)
  const splitRef = useRef<HTMLDivElement>(null)
  const [docSearch, setDocSearch] = useState("")
  const [chatInput, setChatInput] = useState("")
  const [typing, setTyping] = useState(false)
  // Set when the AI allowance runs out; rendered above the composer.
  const [chatQuota, setChatQuota] = useState<QuotaDenial | null>(null)
  const [docs, setDocs] = useState<RagDocument[]>([])
  const [docsLoading, setDocsLoading] = useState(true)
  const [showUpload, setShowUpload] = useState(false)
  const [selectedDocId, setSelectedDocId] = useState<string | undefined>()
  const [progressMap, setProgressMap] = useState<Record<string, DocumentProgress>>({})
  const [togglingIds, setTogglingIds] = useState<Set<string>>(new Set())
  const [messages, setMessages] = useState<ChatMessage[]>([{
    id: "sys-1", role: "assistant",
    content: "Hi! Ask me anything about your documents — I'll answer with references to where I found it.",
    timestamp: new Date().toISOString(),
  }])
  const [ratings, setRatings] = useState<Record<string, "up" | "down">>({})
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const chatEndRef = useRef<HTMLDivElement>(null)

  const indexedDocs = docs.filter(d => d.status === "INDEXED")
  const embeddedCount = indexedDocs.length

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages, typing])

  const loadDocs = useCallback(async (opts: { silent?: boolean } = {}) => {
    try {
      if (!opts.silent) setDocsLoading(true)
      const response = await fetchDocuments(1, 100)
      setDocs(response.data)
    } catch (e) {
      // Silent polls stay quiet — only the user-triggered load reports failure.
      if (!opts.silent) toastApiError(e, "Could not load your documents")
    } finally {
      if (!opts.silent) setDocsLoading(false)
    }
  }, [])

  useEffect(() => { loadDocs() }, [loadDocs])

  // Live progress polling while documents are embedding.
  const processingKey = docs
    .filter(d => d.status === "PENDING" || d.status === "PROCESSING")
    .map(d => d.id)
    .join(",")

  useEffect(() => {
    if (!processingKey) return
    const ids = processingKey.split(",").filter(Boolean)
    if (ids.length === 0) return
    // Seed optimistic placeholders instantly so the user sees "Processing 5%"
    // the moment the card appears, without waiting for the first poll to
    // return. Prevents the initial "Queued 0%" flash before the AI's
    // progress.start has been polled.
    setProgressMap(prev => {
      const seeded: Record<string, DocumentProgress> = {}
      for (const id of ids) {
        if (!prev[id]) {
          seeded[id] = {
            doc_id: id,
            stage: "queued",
            percent: 2,
            total_chunks: 0,
            processed_chunks: 0,
            message: "Queued — starting...",
          }
        }
      }
      return Object.keys(seeded).length ? { ...prev, ...seeded } : prev
    })
    let cancelled = false
    let ticks = 0
    let backoffMs = 3000
    let _consecutiveFailures = 0

    let timer: ReturnType<typeof setTimeout>

    const tick = async () => {
      const ok = await pollOnce()
      // Only reset to the brisk 3s cadence after a clean, successful probe.
      // pollOnce itself already pushed backoffMs out for 429 / network blips
      // (the ERR_NETWORK_CHANGED / ERR_NAME_NOT_RESOLVED burst in the
      // screenshot is a transient DNS / interface event that clears in seconds,
      // so a short exponential back-off rides it out without hammering the API).
      if (ok) {
        backoffMs = 3000
        _consecutiveFailures = 0
      }
      // Schedule the next poll only once this one settled: with setInterval a
      // slow API queued a request per tick, and the pile-up starved every
      // other call the page makes (chat queries included).
      // 3000ms keeps us at 20 req/min — the global ThrottlerGuard limit —
      // and backoff handles the 429 / network case without user-visible errors.
      if (!cancelled) timer = setTimeout(tick, backoffMs)
    }

    const pollOnce = async (): Promise<boolean> => {
      ticks += 1
      let result: Record<string, DocumentProgress | null> = {}
      try {
        result = await fetchDocumentsProgress(ids)
      } catch (e) {
        _consecutiveFailures += 1
        if (isApiError(e) && e.status === 429) {
          backoffMs = Math.min(backoffMs * 1.5, 10000)
        } else if (isNetworkError(e) || e instanceof TypeError || (typeof navigator !== "undefined" && !navigator.onLine)) {
          // Chrome net::ERR_NETWORK_CHANGED / ERR_NAME_NOT_RESOLVED,
          // Safari NSURLError, Firefox NetworkError — all surface as
          // TypeError("Failed to fetch") / NetworkError here. Back off a
          // little; the requestJson layer already retried 3× with jitter, so
          // reaching here means the blip lasted seconds, not milliseconds.
          backoffMs = Math.min(backoffMs * 1.4, 8000)
        } else if (isApiError(e) && e.status >= 500) {
          backoffMs = Math.min(backoffMs * 1.35, 8000)
        } else {
          backoffMs = Math.min(backoffMs * 1.2, 6000)
        }
        // Keep the last known progress on screen while the network
        // recovers — clearing it would flicker every card back to
        // "Queued 0%" even though the AI is still embedding.
        return false
      }
      if (cancelled) return false

      // The API now always returns a live, cached, or synthetic entry for
      // processing docs, so a transient AI restart no longer yields {} and
      // the client no longer needs to preserve the previous percent to avoid
      // a 32% -> 0% jump. Still guard against regressions: a retry's fresh
      // "extracting 5%" must not overwrite a later "embedding 45%" that
      // arrived from a successful poll.
      const next: Record<string, DocumentProgress> = {}
      let anyFinished = false
      let anyProgress = false
      for (const id of ids) {
        const entry = result[id]
        if (!entry) continue
        anyProgress = true
        next[id] = entry
        if (entry.stage === "done" || entry.stage === "failed") anyFinished = true
      }
      if (anyProgress) {
        setProgressMap(prev => {
          const merged: Record<string, DocumentProgress> = { ...prev }
          for (const [k, v] of Object.entries(next)) {
            const prevEntry = prev[k]
            if (prevEntry && v.percent != null && prevEntry.percent != null && v.percent < prevEntry.percent && v.stage !== "done" && v.stage !== "failed") {
              // Monotonic client-side guard: ignore backward jumps (e.g.
              // synthetic 5% after we already showed 42%). Terminal stages
              // are exempt so "done 100%" always wins.
              continue
            }
            merged[k] = v
          }
          return merged
        })
        _consecutiveFailures = 0
      }
      // Refresh the list when something finished - or periodically as a
      // safety net in case the AI service has no progress entry for a doc.
      // Every 4th tick (12s) is quick enough to surface a completion that
      // missed the "done" stage due to a blip, without hammering the API.
      if (anyFinished || ticks % 4 === 0) loadDocs({ silent: true })
      // If we went offline between ticks, linger a bit longer before the next probe.
      if (typeof navigator !== "undefined" && !navigator.onLine) {
        backoffMs = Math.min(Math.max(backoffMs, 5000), 10000)
      }
      return true
    }

    void tick()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [processingKey, loadDocs])

  const filteredDocs = useMemo(() =>
    docs.filter(d =>
      d.title.toLowerCase().includes(docSearch.toLowerCase()) ||
      d.filename.toLowerCase().includes(docSearch.toLowerCase())
    ),
    [docs, docSearch]
  )

  const handleDelete = async (id: string) => {
    if (
      !(await confirm({
        title: "Delete this document?",
        description: "You won't be able to ask questions about it anymore.",
        confirmLabel: "Delete",
        danger: true,
      }))
    )
      return
    try {
      await deleteDocument(id)
      setDocs(prev => prev.filter(d => d.id !== id))
      toast.success("Document deleted")
    } catch (e) {
      toastApiError(e, "Delete failed")
    }
  }

  const handleToggleEmbed = async (doc: RagDocument) => {
    setTogglingIds(prev => new Set(prev).add(doc.id))
    // Optimistic: show "Processing" instantly on re-embed so the toggle feels
    // fast — don't wait for the embed POST + first poll round-trip.
    if (doc.status !== "INDEXED") {
      setProgressMap(prev => ({
        ...prev,
        [doc.id]: {
          doc_id: doc.id,
          stage: "queued",
          percent: 2,
          total_chunks: 0,
          processed_chunks: 0,
          message: "Queued — starting...",
        },
      }))
    }
    try {
      const updated = doc.status === "INDEXED"
        ? await unembedDocument(doc.id)
        : await embedDocument(doc.id)
      setDocs(prev => prev.map(d => (d.id === doc.id ? { ...d, ...updated } : d)))
      toast.success(doc.status === "INDEXED" ? "Removed from search" : "Preparing document…")
    } catch (e) {
      toastApiError(e, "Could not update this document")
    } finally {
      setTogglingIds(prev => {
        const next = new Set(prev)
        next.delete(doc.id)
        return next
      })
    }
  }

  const sendMessage = async (text?: string, docIdOverride?: string) => {
    const q = (text ?? chatInput).trim()
    if (!q || typing) return

    const userMsg: ChatMessage = {
      id: Date.now().toString(),
      role: "user",
      content: q,
      timestamp: new Date().toISOString(),
    }
    setMessages(prev => [...prev, userMsg])
    setChatInput("")
    setTyping(true)

    try {
      const result = await ragQuery(q, docIdOverride ?? selectedDocId)
      const assistantMsg: ChatMessage = {
        id: (Date.now() + 1).toString(),
        role: "assistant",
        content: result.answer,
        timestamp: new Date().toISOString(),
        sources: result.sources.length > 0 ? result.sources : undefined,
        modelUsed: result.model_used,
      }
      setMessages(prev => [...prev, assistantMsg])
    } catch (e) {
      // A spent AI allowance is a billing state, not a chat failure — surface
      // it as an upgrade prompt below the composer instead of a bot apology.
      if (isQuotaError(e)) {
        setChatQuota(e.quota)
        setTyping(false)
        return
      }
      setMessages(prev => [...prev, {
        id: (Date.now() + 1).toString(),
        role: "assistant",
        content: `Sorry, I couldn't process your question. ${e instanceof Error ? e.message : "Please try again."}`,
        timestamp: new Date().toISOString(),
      }])
    } finally {
      setTyping(false)
    }
  }

  const clearChat = () => {
    setMessages([{
      id: "sys-clear", role: "assistant",
      content: "Conversation cleared. Ask me anything about your documents.",
      timestamp: new Date().toISOString(),
    }])
    setRatings({})
    setSelectedDocId(undefined)
  }

  // Clamp the library pane to a sane share of the split container.
  // 55% keeps a balanced split at 1024/1280/1440 breakpoints and leaves
  // room for the 20px resizer + gap scale (4/8). Min 320 preserves
  // readable line length (~35 chars) on 375px base.
  const clampLibWidth = useCallback((width: number) => {
    const maxW = splitRef.current ? splitRef.current.offsetWidth * 0.55 : 640
    return Math.min(Math.max(width, 320), maxW)
  }, [])

  // Drag to resize — pointer events cover mouse, touch and pen alike.
  const handleResizeStart = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    e.preventDefault()
    resizing.current = true
    const startX = "touches" in e ? e.touches[0].clientX : e.clientX
    const startWidth = libWidth

    const onMove = (ev: MouseEvent | TouchEvent) => {
      if (!resizing.current) return
      const x = "touches" in ev ? ev.touches[0]?.clientX : ev.clientX
      if (x === undefined) return
      setLibWidth(clampLibWidth(startWidth + x - startX))
    }

    const onUp = () => {
      resizing.current = false
      document.removeEventListener("mousemove", onMove)
      document.removeEventListener("mouseup", onUp)
      document.removeEventListener("touchmove", onMove)
      document.removeEventListener("touchend", onUp)
      document.body.style.cursor = ""
      document.body.style.userSelect = ""
    }

    document.body.style.cursor = "col-resize"
    document.body.style.userSelect = "none"
    document.addEventListener("mousemove", onMove)
    document.addEventListener("mouseup", onUp)
    document.addEventListener("touchmove", onMove, { passive: false })
    document.addEventListener("touchend", onUp)
  }, [libWidth, clampLibWidth])

  // Arrow keys resize too, so the split isn't mouse-only.
  const handleResizeKey = useCallback((e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 64 : 16
    if (e.key === "ArrowLeft") {
      e.preventDefault()
      setLibWidth(w => clampLibWidth(w - step))
    } else if (e.key === "ArrowRight") {
      e.preventDefault()
      setLibWidth(w => clampLibWidth(w + step))
    }
  }, [clampLibWidth])

  const askAboutDoc = (doc: RagDocument) => {
    setSelectedDocId(doc.id)
    sendMessage(`What are the key provisions of "${doc.title}"?`, doc.id)
    if (view === "library") setView("split")
    setMobileTab("chat")
  }

  // ─── Library panel ──────────────────────────────────────────────────────────

  const Library = (
    <div className="flex h-full min-h-0 min-w-0 max-w-full flex-col overflow-hidden overflow-x-hidden rounded-2xl border border-vez-line/50 bg-vez-surface/50">
      {/* Header */}
      <div className="shrink-0 border-b border-vez-line bg-white px-4 py-4 sm:px-6 sm:py-5">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-base font-semibold text-vez-ink">Document Library</h2>
          {user && (
            <button
              onClick={() => setShowUpload(true)}
              className="flex items-center gap-2 rounded-lg border border-vez-line bg-white px-3.5 py-2 text-sm font-medium text-vez-ink shadow-sm transition-all hover:border-vez-sky hover:bg-vez-sky/10 hover:shadow"
            >
              <Upload className="size-4" /> Upload
            </button>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-vez-mute">
          <span className="flex items-center gap-1.5 font-medium text-vez-navy">
            <span className="size-2 rounded-full bg-emerald-500" />
            {embeddedCount} ready to search
          </span>
          <span className="text-vez-line">|</span>
          <span>{docs.length} {docs.length === 1 ? "document" : "documents"}</span>
        </div>
      </div>

      {/* Search */}
      <div className="shrink-0 border-b border-vez-line/60 bg-white px-4 py-3 sm:px-5 sm:py-4">
        <div className="relative">
          <Search className="absolute left-4 top-1/2 size-4 -translate-y-1/2 text-vez-mute" />
          <input
            value={docSearch}
            onChange={e => setDocSearch(e.target.value)}
            placeholder="Search documents..."
            className="h-11 min-h-[44px] w-full rounded-xl border border-vez-line bg-vez-surface/50 pl-11 pr-4 text-[16px] sm:text-sm text-vez-ink outline-none transition-colors placeholder:text-vez-mute focus:border-vez-sky focus:bg-white focus-visible:ring-2 focus-visible:ring-vez-navy/10"
          />
        </div>
      </div>

      {/* Doc list — min-w-0 prevents DocCard from forcing horizontal scroll on large viewports */}
      <div className="flex-1 min-w-0 space-y-3 overflow-y-auto overflow-x-hidden p-4 sm:p-6">
        {docsLoading ? (
          <div className="flex flex-col items-center justify-center py-16 text-vez-mute">
            <Loader2 className="mb-3 size-7 animate-spin" />
            <p className="text-sm">Loading documents...</p>
          </div>
        ) : filteredDocs.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-vez-mute">
            <div className="mb-4 flex size-16 items-center justify-center rounded-2xl bg-vez-surface">
              <FileText className="size-8 opacity-40" />
            </div>
            <p className="text-base font-medium text-vez-ink/60">
              {docSearch ? "No matching documents" : "No documents yet"}
            </p>
            <p className="mt-1 text-sm text-vez-mute">
              {docSearch ? "Try a different search term" : "Upload your first document to get started"}
            </p>
            {!docSearch && user && (
              <button
                onClick={() => setShowUpload(true)}
                className="mt-5 flex items-center gap-2 rounded-xl bg-vez-navy px-5 py-2.5 text-sm font-medium text-white shadow-md transition-all hover:bg-vez-navy/90"
              >
                <Upload className="size-4" /> Upload Document
              </button>
            )}
          </div>
        ) : (
          filteredDocs.map(doc => (
            <DocCard
              key={doc.id}
              doc={doc}
              progress={progressMap[doc.id]}
              toggleBusy={togglingIds.has(doc.id)}
              canManage={!!user}
              onToggleEmbed={() => handleToggleEmbed(doc)}
              onDelete={() => handleDelete(doc.id)}
              onAsk={() => askAboutDoc(doc)}
            />
          ))
        )}
      </div>
    </div>
  )

  // ─── Chat panel ─────────────────────────────────────────────────────────────

  const Chat = (
    <div className="flex h-full min-h-0 min-w-0 max-w-full flex-col overflow-hidden overflow-x-hidden rounded-2xl border border-vez-line/50 bg-white shadow-sm">
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-vez-line px-4 py-3.5 sm:px-6 sm:py-5">
        <div className="flex min-w-0 items-center gap-3 sm:gap-4">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-vez-navy sm:size-11">
            <Bot className="size-5 text-white" />
          </div>
          <div className="min-w-0">
            <p className="text-base font-semibold text-vez-ink">Ask your documents</p>
            <p className="mt-0.5 flex items-center gap-1.5 truncate text-xs text-vez-mute sm:text-sm">
              <span className="size-2 shrink-0 rounded-full bg-emerald-500" />
              {embeddedCount} {embeddedCount === 1 ? "document" : "documents"} ready · Ask anything
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1 sm:gap-2">
          {selectedDocId && (
            <button
              className="flex items-center gap-1.5 rounded-lg bg-vez-sky/20 px-3 py-1.5 text-xs font-medium text-vez-navy transition-colors hover:bg-vez-sky/30"
              onClick={() => setSelectedDocId(undefined)}
              title="Clear document filter"
            >
              Filtered <X className="size-3" />
            </button>
          )}
          <button
            className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-vez-mute transition-colors hover:bg-vez-surface hover:text-vez-navy"
            onClick={clearChat}
          >
            <Trash2 className="size-4" /> <span className="hidden sm:inline">Clear</span>
          </button>
        </div>
      </div>

      {/* Messages — min-w-0 + overflow-x-hidden prevents table/long text from forcing page scroll on large screens */}
      <div className="flex-1 min-w-0 space-y-5 overflow-y-auto overflow-x-hidden px-4 py-4 sm:px-6 sm:py-5">
        {messages.map(msg => (
          <div key={msg.id} className={`flex gap-2.5 sm:gap-3 ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
            {msg.role === "assistant" && (
              <div className="mt-1 flex size-8 shrink-0 items-center justify-center rounded-xl bg-vez-sky/30 sm:size-9">
                <Bot className="size-4 text-vez-navy sm:size-4.5" />
              </div>
            )}
            <div className="max-w-[85%] space-y-2 sm:max-w-[80%]">
              <div className={`rounded-2xl px-4 py-3 text-[15px] leading-relaxed sm:px-5 ${
                msg.role === "user"
                  ? "rounded-br-md bg-vez-navy text-white"
                  : "rounded-bl-md bg-vez-surface text-vez-ink"
              }`}>
                {msg.role === "assistant" ? <Markdown content={msg.content} /> : msg.content}
              </div>
              {msg.modelUsed === "extractive" && (
                <div className="flex items-start gap-1.5 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
                  <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
                  <span>Showing matching text from your documents — a written answer isn&apos;t available right now.</span>
                </div>
              )}
              {msg.sources && msg.sources.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[11px] font-medium uppercase tracking-wide text-vez-mute/70">Sources</span>
                  {groupSources(msg.sources).map((g, i) => (
                    <span
                      key={i}
                      title={
                        (g.sections.length > 0 ? `${g.sections.join(" · ")}\n\n` : "") + g.preview
                      }
                      className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-vez-sky/30 bg-vez-sky/10 px-2.5 py-1 text-xs font-medium text-vez-navy"
                    >
                      <BookOpen className="size-3 shrink-0" />
                      <span className="shrink-0 font-mono text-[11px] text-vez-navy/70">
                        {g.refs.map(n => `[${n}]`).join("")}
                      </span>
                      <span className="max-w-40 truncate">{g.title}</span>
                      {g.pageLabel && (
                        <span className="shrink-0 font-mono text-[10px] text-vez-navy/70">{g.pageLabel}</span>
                      )}
                      {g.sections[0] && (
                        <span className="hidden max-w-32 truncate text-[10px] text-vez-navy/60 sm:inline">
                          § {g.sections[0]}
                        </span>
                      )}
                    </span>
                  ))}
                </div>
              )}
              {msg.role === "assistant" && !msg.id.startsWith("sys") && (
                <div className="flex gap-1">
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(msg.content)
                      setCopiedId(msg.id)
                      setTimeout(() => setCopiedId(prev => prev === msg.id ? null : prev), 2000)
                    }}
                    className={`rounded-lg p-2 transition-colors ${copiedId === msg.id ? "text-emerald-600 bg-emerald-50" : "text-vez-mute/60 hover:bg-vez-surface hover:text-vez-mute"}`}
                  >
                    {copiedId === msg.id ? <CheckCircle className="size-3.5" /> : <Copy className="size-3.5" />}
                  </button>
                  <button
                    onClick={() => setRatings(r => ({ ...r, [msg.id]: "up" }))}
                    className={`rounded-lg p-2 transition-colors hover:bg-vez-surface hover:text-vez-mute ${ratings[msg.id] === "up" ? "text-vez-navy bg-vez-sky/20" : "text-vez-mute/60"}`}
                  >
                    <ThumbsUp className="size-3.5" />
                  </button>
                  <button
                    onClick={() => setRatings(r => ({ ...r, [msg.id]: "down" }))}
                    className={`rounded-lg p-2 transition-colors hover:bg-vez-surface hover:text-vez-mute ${ratings[msg.id] === "down" ? "text-red-500 bg-red-50" : "text-vez-mute/60"}`}
                  >
                    <ThumbsDown className="size-3.5" />
                  </button>
                </div>
              )}
            </div>
            {msg.role === "user" && (
              <div className="mt-1 flex size-8 shrink-0 items-center justify-center rounded-xl bg-vez-surface sm:size-9">
                <User className="size-4 text-vez-mute sm:size-4.5" />
              </div>
            )}
          </div>
        ))}
        {typing && (
          <div className="flex gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-vez-sky/30">
              <Bot className="size-4.5 text-vez-navy" />
            </div>
            <div className="flex items-center gap-2 rounded-2xl rounded-bl-md bg-vez-surface px-5 py-4">
              {[0, 150, 300].map(d => (
                <span key={d} className="size-2 animate-bounce rounded-full bg-vez-navy/40" style={{ animationDelay: `${d}ms` }} />
              ))}
            </div>
          </div>
        )}
        {messages.length <= 1 && !typing && (
          <div className="mt-4 space-y-3">
            <p className="px-1 text-sm font-medium text-vez-mute">Try asking:</p>
            {suggestions.map(q => (
              <button key={q} onClick={() => sendMessage(q)}
                className="group flex w-full items-center justify-between rounded-xl border border-vez-line/50 bg-vez-surface/50 px-4 py-3.5 text-left transition-all hover:border-vez-sky/50 hover:bg-vez-sky/10 hover:shadow-sm sm:px-5 sm:py-4">
                <span className="text-[15px] text-vez-mute group-hover:text-vez-ink">{q}</span>
                <ChevronRight className="size-4 shrink-0 text-vez-mute/40 transition-transform group-hover:translate-x-0.5 group-hover:text-vez-navy" />
              </button>
            ))}
          </div>
        )}
        <div ref={chatEndRef} />
      </div>

      {/* Input */}
      <div className="shrink-0 border-t border-vez-line px-4 py-3 sm:px-5 sm:py-4">
        {chatQuota && (
          <div className="mb-3">
            <UpgradePrompt quota={chatQuota} compact onDismiss={() => setChatQuota(null)} />
          </div>
        )}
        <div className="flex gap-2 sm:gap-3">
          <input
            value={chatInput}
            onChange={e => setChatInput(e.target.value)}
            onKeyDown={e => e.key === "Enter" && sendMessage()}
            placeholder={embeddedCount === 0 ? "Upload a document to get started..." : "Ask a question about your documents..."}
            className="h-12 min-h-[44px] min-w-0 flex-1 rounded-xl border border-vez-line bg-vez-surface/50 px-4 text-[16px] sm:text-[15px] text-vez-ink outline-none transition-all placeholder:text-vez-mute focus:border-vez-navy focus:bg-white focus:ring-2 focus:ring-vez-sky/30 disabled:opacity-50 sm:px-5"
            disabled={embeddedCount === 0 || typing}
          />
          <button
            className="flex size-12 min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-xl bg-vez-navy text-white shadow-md transition-all hover:bg-vez-navy/90 hover:shadow-lg disabled:opacity-40 disabled:shadow-none cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-vez-navy focus-visible:ring-offset-2"
            onClick={() => sendMessage()}
            disabled={!chatInput.trim() || typing}
            aria-label="Send message"
          >
            <Send className="size-5" />
          </button>
        </div>
      </div>
    </div>
  )

  // ─── render ──────────────────────────────────────────────────────────────────

  return (
    <div className="flex h-[calc(100dvh-5rem-env(safe-area-inset-top))] min-h-0 flex-col overflow-hidden overflow-x-hidden bg-white font-poppins">
      <Header />

      <div className="mx-auto flex w-full max-w-7xl min-w-0 min-h-0 flex-1 flex-col gap-4 overflow-x-hidden px-4 py-4 sm:gap-6 sm:px-6 sm:py-6 lg:px-8">

        {/* Top bar */}
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 sm:gap-4">
          <div className="flex min-w-0 items-center gap-3 sm:gap-4">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-vez-navy shadow-md sm:size-12">
              <FileText className="size-5 text-white" />
            </div>
            <div className="min-w-0">
              <h1 className="break-words text-lg font-semibold tracking-tight text-vez-ink sm:text-xl lg:text-2xl">My documents</h1>
              <p className="mt-0.5 break-words text-xs text-vez-mute sm:text-sm">
                {embeddedCount === 0
                  ? "Upload a document to start asking questions"
                  : `${embeddedCount} ${embeddedCount === 1 ? "document" : "documents"} ready to search`}
              </p>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <button
              onClick={() => loadDocs()}
              aria-label="Refresh documents"
              className="flex size-10 items-center justify-center rounded-lg bg-vez-surface text-vez-mute transition-colors hover:bg-vez-sky/15 hover:text-vez-navy sm:size-11"
            >
              <RefreshCw className="size-4" />
            </button>

          {/* View switcher — tablet and up */}
          <div className="hidden items-center gap-1 rounded-xl bg-vez-surface p-1.5 md:flex">
            {([
              { id: "library", icon: BookOpen,        label: "Library" },
              { id: "split",   icon: LayoutPanelLeft, label: "Split" },
              { id: "chat",    icon: MessageSquare,   label: "Chat" },
            ] as const).map(m => {
              const Icon = m.icon
              return (
                <button key={m.id} onClick={() => setView(m.id)}
                  className={`flex min-h-[44px] items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-all cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-vez-navy/20 ${
                    view === m.id
                      ? "bg-vez-navy text-white shadow-sm"
                      : "text-vez-mute hover:text-vez-navy"
                  }`}>
                  <Icon className="size-4" />
                  <span className="hidden lg:inline">{m.label}</span>
                </button>
              )
            })}
          </div>
          </div>
        </div>

        {/* Panels */}
        <div className="min-h-0 flex-1 min-w-0 overflow-x-hidden">
          {/* Tablet and up — md: 50/50 with gap-4 (16px), lg+: dragged width + 20px resizer gap (spacing scale 4/8) */}
          <div className="hidden h-full min-w-0 md:block overflow-x-hidden">
            {view === "split" && (
              <div ref={splitRef} className="flex h-full min-w-0 gap-4 lg:gap-0">
                {/* Tablet splits evenly; desktop honours the dragged width. */}
                <div className="h-full min-w-0 w-full shrink-0 md:w-1/2 lg:w-[var(--lib-w)] max-w-full" style={{ ["--lib-w" as string]: `${libWidth}px` }}>
                  {Library}
                </div>
                <div
                  role="separator"
                  aria-orientation="vertical"
                  aria-label="Resize document list"
                  tabIndex={0}
                  onMouseDown={handleResizeStart}
                  onTouchStart={handleResizeStart}
                  onKeyDown={handleResizeKey}
                  className="group hidden h-full w-5 shrink-0 cursor-col-resize touch-none items-center justify-center focus-visible:outline-none lg:flex"
                >
                  <div className="h-8 w-1 rounded-full bg-vez-line transition-colors group-hover:bg-vez-navy/40 group-focus-visible:bg-vez-navy group-active:bg-vez-navy" />
                </div>
                <div className="h-full min-w-0 flex-1 max-w-full">
                  {Chat}
                </div>
              </div>
            )}
            {view === "library" && <div className="mx-auto h-full max-w-3xl">{Library}</div>}
            {view === "chat" && <div className="mx-auto h-full max-w-3xl">{Chat}</div>}
          </div>

          {/* Mobile: one panel + bottom tabs */}
          <div className="flex h-full flex-col gap-3 md:hidden">
            <div className="min-h-0 flex-1">
              {mobileTab === "library" ? Library : Chat}
            </div>
            <div className="grid shrink-0 grid-cols-2 gap-1 rounded-2xl bg-vez-surface p-1.5">
              {([
                { id: "library", icon: BookOpen,      label: "Library" },
                { id: "chat",    icon: MessageSquare, label: "Chat" },
              ] as const).map(m => {
                const Icon = m.icon
                return (
                  <button
                    key={m.id}
                    onClick={() => setMobileTab(m.id)}
                    className={`flex min-h-[44px] items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium transition-all cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-vez-navy/20 ${
                      mobileTab === m.id
                        ? "bg-vez-navy text-white shadow-sm"
                        : "text-vez-mute"
                    }`}
                  >
                    <Icon className="size-4" />
                    {m.label}
                  </button>
                )
              })}
            </div>
          </div>
        </div>
      </div>

      {showUpload && <UploadModal onClose={() => setShowUpload(false)} onUploaded={() => loadDocs()} />}
    </div>
  )
}
