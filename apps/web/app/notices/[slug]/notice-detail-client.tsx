"use client"

import React, { useCallback, useEffect, useState } from "react"
import { useParams } from "next/navigation"
import Link from "next/link"
import {
  ArrowLeft, Calendar, Eye, Bell, FileText,
  ExternalLink, Building2, Globe, Share2,
  Bookmark, BookmarkCheck, Loader2, Check,
  Paperclip, FileImage, Download, Sparkles,
  CheckCircle, Tag, MessageSquare, Send, ArrowRight,
  AlertTriangle, Clock, Timer, ChevronDown, ChevronUp,
  RefreshCw, QrCode,
} from "lucide-react"
import { Header } from "@/components/layout/header"
import { fetchNotice, askNoticeQuestion, reextractNotice, isQuotaError, isApiError, type QuotaDenial } from "@/lib/api"
import { ErrorState } from "@/components/ui/error-state"
import { ChatMarkdown } from "@/components/chat/chat-markdown"
import { CopyButton } from "@/components/ui/copy-button"
import { useAuth } from "@/lib/auth-context"
import { categoryLabel } from "@/lib/types"
import { useNoticeContext } from "@/lib/notice-context"
import type { PublicNoticeDetail } from "@/lib/types"
import { UpgradePrompt } from "@/components/billing/upgrade-prompt"

const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".gif", ".webp"]

function attachmentKind(url: string): "image" | "file" {
  const path = url.toLowerCase().split("?")[0]
  return IMAGE_EXTENSIONS.some((ext) => path.endsWith(ext)) ? "image" : "file"
}

function attachmentLabel(url: string): string {
  try {
    const name = decodeURIComponent(new URL(url).pathname.split("/").pop() || "attachment")
    return name.length > 40 ? name.slice(0, 37) + "…" : name
  } catch {
    return "Attachment"
  }
}

/**
 * Routes through this app's own `/api/files/attachment/:id` proxy, which
 * redirects to the backend's `/attachments/:id/file` — that endpoint caches
 * the file to S3 on first request and redirects to a presigned URL on every
 * request after. Always going through the id-based proxy (rather than
 * branching on whether `storageKey` happens to be populated yet) means the
 * cache-on-first-view logic lives in exactly one place, server-side.
 *
 * The synthetic "legacy" id (built when a notice only has the old single
 * `attachmentUrl` column and no real Attachment row) has no id to look up,
 * so it falls back to linking the original external URL directly.
 */
function attachmentFileUrl(att: { id: string; url: string }, mode: "inline" | "download" = "inline"): string {
  if (att.id === "legacy") return att.url
  return `/api/files/attachment/${att.id}?mode=${mode}`
}

function formatDate(d: string) {
  return new Date(d).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })
}

function formatDateShort(d: string) {
  return new Date(d).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })
}

function daysUntil(d: string): number {
  const target = new Date(d)
  const now = new Date()
  target.setHours(0, 0, 0, 0)
  now.setHours(0, 0, 0, 0)
  return Math.ceil((target.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
}

function deadlineLabel(d: string): { text: string; color: "red" | "amber" | "green" | "gray" } {
  const days = daysUntil(d)
  if (days < 0) return { text: `${Math.abs(days)} day${Math.abs(days) === 1 ? "" : "s"} overdue`, color: "gray" }
  if (days === 0) return { text: "Due today", color: "red" }
  if (days === 1) return { text: "Due tomorrow", color: "red" }
  if (days <= 3) return { text: `${days} days remaining`, color: "red" }
  if (days <= 7) return { text: `${days} days remaining`, color: "amber" }
  return { text: `${days} days remaining`, color: "green" }
}

type BlockType = "heading" | "numbered-heading" | "subheading" | "paragraph" | "list-item" | "address" | "separator" | "divider" | "related" | "table"

/** Parses a `| a | b | c |` row into `["a", "b", "c"]`. */
function parseTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "")
  return trimmed.split("|").map((c) => c.trim())
}

/** A GFM separator row: `| --- | :--- | ---: |`. */
function isTableSeparatorRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c))
}

function preprocessContent(raw: string): string {
  let text = raw

  // Strip zero-width joiners/non-joiners and other invisible formatting
  // characters — a very common artifact of legacy Devanagari font extraction
  // (PDF text layers built for glyph-shaping, not for copy/paste), e.g.
  // "सङ्‍घीय" reading as "सङ्‍ घीय" with stray joiners breaking words visually.
  // U+200B-200F: zero-width space/ZWNJ/ZWJ/LRM/RLM, U+FEFF: BOM/ZWNBSP.
  text = text.replace(/[\u200B-\u200F\uFEFF]/g, "")

  // Normalize multiple spaces to single
  text = text.replace(/[ \t]{2,}/g, " ")

  // Insert line breaks before Nepali numbered sections (१., २., ३. etc.)
  text = text.replace(/([^\n])\s*([०-९]+[.)]\s)/g, "$1\n\n$2")
  // Insert line breaks before Arabic numbered sections when preceded by sentence-end
  text = text.replace(/([।.?!])\s+(\d+[.)]\s)/g, "$1\n\n$2")
  // Insert line breaks before dash-prefixed sub-points
  text = text.replace(/([।.?!।])\s+(-[^\d-])/g, "$1\n$2")
  text = text.replace(/([^\n-])\s+(-[क-ह])/g, "$1\n$2")
  // Break before "On " heading patterns
  text = text.replace(/([.।])\s+(On\s[A-Z][A-Za-z\s'':,]+)/g, "$1\n\n$2")
  // Break before "Distinguished Guests" / address patterns
  text = text.replace(/([.।])\s+(Distinguished\s|Honourable\s|Ladies\s|Excellencies)/g, "$1\n\n$2")
  // Break before "सम्बन्धित सूचना"
  text = text.replace(/([।.])\s*(सम्बन्धित सूचना)/g, "$1\n\n$2")
  // Break on *** dividers
  text = text.replace(/\s*\*{3,}\s*/g, "\n\n***\n\n")
  // Break before English section-title patterns ending with colon
  text = text.replace(/([.।])\s+([A-Z][A-Za-z]+(?:\s[A-Z][A-Za-z]+){1,6}:)/g, "$1\n\n$2")
  // Break long paragraphs at sentence boundaries for readability (only if paragraph > 500 chars without breaks)
  text = text.replace(/([।])\s+/g, "$1\n")

  // Clean up excessive newlines
  text = text.replace(/\n{4,}/g, "\n\n\n")

  return text.trim()
}

function FormattedContent({ text }: { text: string }) {
  const lines = preprocessContent(text).split("\n")
  const blocks: Array<{ type: BlockType; content: string; number?: string; caption?: string; rows?: string[][] }> = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) {
      if (blocks.length > 0 && blocks[blocks.length - 1].type !== "separator") {
        blocks.push({ type: "separator", content: "" })
      }
      continue
    }

    // Tables appended by the PDF extractor: a "Table (page N):" caption
    // followed by GFM pipe rows (header, then a --- separator, then body).
    const tableCaptionMatch = /^Table \(page \d+\):$/i.test(line)
    if (tableCaptionMatch) {
      const rows: string[][] = []
      let j = i + 1
      while (j < lines.length && lines[j].trim().startsWith("|")) {
        const cells = parseTableRow(lines[j])
        if (!isTableSeparatorRow(cells)) rows.push(cells)
        j++
      }
      if (rows.length > 0) {
        blocks.push({ type: "table", content: "", caption: line, rows })
        i = j - 1
        continue
      }
      // No pipe rows followed — not actually a table, fall through and let
      // it render as an ordinary line below.
    }

    // *** dividers
    if (/^\*{3,}$/.test(line)) {
      blocks.push({ type: "divider", content: "" })
      continue
    }

    // "सम्बन्धित सूचना" / "Related" footer — stop rendering
    if (/^(सम्बन्धित सूचना|Related\s+(notices|news|information))/i.test(line)) {
      blocks.push({ type: "related", content: line })
      continue
    }

    const isShort = line.length < 140

    // Numbered section headings: "१." "२." "1." "2." etc
    const numberedMatch = line.match(/^([०-९]+|\d+)[.)]\s+(.+)/)
    if (numberedMatch) {
      const body = numberedMatch[2]
      // If the numbered line is long (contains full paragraph after the heading part),
      // split at the first sentence boundary
      if (body.length > 120) {
        const sentenceEnd = body.search(/[।.]\s/)
        if (sentenceEnd > 20 && sentenceEnd < 120) {
          blocks.push({ type: "numbered-heading", content: body.slice(0, sentenceEnd + 1).trim(), number: numberedMatch[1] })
          blocks.push({ type: "paragraph", content: body.slice(sentenceEnd + 1).trim() })
          continue
        }
      }
      blocks.push({ type: "numbered-heading", content: body, number: numberedMatch[1] })
      continue
    }

    // Dash/hyphen-prefixed sub-points
    const dashMatch = line.match(/^[-–—]\s*(.+)/)
    if (dashMatch && dashMatch[1].length > 2) {
      blocks.push({ type: "list-item", content: dashMatch[1] })
      continue
    }

    // Bullet/symbol list items
    if (/^[•●▪►]\s/.test(line)) {
      blocks.push({ type: "list-item", content: line.replace(/^[•●▪►]\s+/, "") })
      continue
    }

    // English lettered/roman list
    if (/^[a-z][.)]\s/.test(line)) {
      blocks.push({ type: "list-item", content: line.replace(/^[a-z][.)]\s+/, "") })
      continue
    }

    // ALL CAPS headings
    const isAllCaps = line === line.toUpperCase() && line.length > 3 && /[A-Z]/.test(line)
    if (isAllCaps && isShort) {
      blocks.push({ type: "heading", content: line })
      continue
    }

    // "On ..." subheadings
    if (/^On\s[A-Z]/.test(line) && isShort && !line.endsWith(".") && !line.endsWith("।")) {
      blocks.push({ type: "subheading", content: line })
      continue
    }

    // Colon-ended short lines
    if (line.endsWith(":") && line.length < 90) {
      blocks.push({ type: "subheading", content: line.replace(/:$/, "") })
      continue
    }

    // Title-like short lines (English): capitalized words, no period/purnabiram
    const words = line.split(" ")
    const isTitlePattern = isShort && words.length >= 2 && words.length <= 14 &&
      !line.endsWith(".") && !line.endsWith(",") && !line.endsWith("।") &&
      /^[A-Z]/.test(line) &&
      (words.filter((w: string) => /^[A-Z]/.test(w)).length / words.length > 0.6)

    // Address block (Distinguished Guests, etc.)
    const isAddress = /^(Distinguished|Honourable|Ladies|Friends|Excellencies|Namaskar|Dr\s|Mr\s|Prof)/i.test(line) &&
      isShort && (line.endsWith(",") || line.endsWith("."))

    if (isAddress) {
      blocks.push({ type: "address", content: line })
    } else if (isTitlePattern) {
      blocks.push({ type: "subheading", content: line })
    } else {
      blocks.push({ type: "paragraph", content: line })
    }
  }

  // Render
  const rendered: React.ReactNode[] = []
  let idx = 0
  let inRelated = false

  while (idx < blocks.length) {
    const block = blocks[idx]

    if (block.type === "related") { inRelated = true; idx++; continue }
    if (inRelated) { idx++; continue }
    if (block.type === "separator") { idx++; continue }

    if (block.type === "table" && block.rows) {
      const [header, ...body] = block.rows
      rendered.push(
        <div key={idx} className="my-6 -mx-4 overflow-x-auto rounded-[14px] border border-vez-line sm:mx-0">
          <table className="w-full min-w-[600px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-vez-line bg-vez-surface/60">
                {header.map((cell, c) => (
                  <th key={c} className="px-4 py-2.5 text-left font-medium text-vez-ink">
                    {cell}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {body.map((row, r) => (
                <tr key={r} className={r % 2 === 1 ? "bg-vez-surface/30" : undefined}>
                  {row.map((cell, c) => (
                    <td key={c} className="border-t border-vez-line px-4 py-2.5 text-vez-ink/90">
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
      idx++
      continue
    }

    if (block.type === "divider") {
      rendered.push(
        <hr key={idx} className="my-8 border-vez-line" />
      )
      idx++
    } else if (block.type === "heading") {
      rendered.push(
        <h2 key={idx} className="mt-10 mb-4 border-b border-vez-line pb-3 text-xl font-bold tracking-tight text-vez-ink first:mt-0">
          {block.content}
        </h2>
      )
      idx++
    } else if (block.type === "numbered-heading") {
      rendered.push(
        <div key={idx} className="mt-8 mb-3 flex items-start gap-4 rounded-xl bg-gradient-to-r from-vez-sky/10 to-transparent py-4 pl-4 pr-6 first:mt-0">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-vez-navy text-sm font-bold text-white shadow-sm">
            {block.number}
          </span>
          <h3 className="pt-1.5 text-base font-bold leading-snug text-vez-ink md:text-[17px]">
            {block.content}
          </h3>
        </div>
      )
      idx++
    } else if (block.type === "subheading") {
      rendered.push(
        <h3 key={idx} className="mt-8 mb-3 border-l-4 border-vez-navy/40 pl-4 text-[17px] font-semibold text-vez-ink">
          {block.content}
        </h3>
      )
      idx++
    } else if (block.type === "address") {
      const addressLines: string[] = []
      while (idx < blocks.length && blocks[idx].type === "address") {
        addressLines.push(blocks[idx].content)
        idx++
      }
      rendered.push(
        <div key={`addr-${idx}`} className="my-5 rounded-2xl border border-vez-line/60 bg-vez-surface/40 px-6 py-4">
          <div className="space-y-1 text-[15px] leading-relaxed text-vez-ink/75 italic">
            {addressLines.map((l, j) => <p key={j}>{l}</p>)}
          </div>
        </div>
      )
    } else if (block.type === "list-item") {
      const items: string[] = []
      while (idx < blocks.length && blocks[idx].type === "list-item") {
        items.push(blocks[idx].content)
        idx++
      }
      rendered.push(
        <div key={`list-${idx}`} className="my-4 rounded-xl border-l-[3px] border-vez-navy/20 bg-vez-surface/30 py-3 pl-5 pr-4">
          <ul className="space-y-3">
            {items.map((item, j) => (
              <li key={j} className="flex items-start gap-3">
                <span className="mt-[10px] size-[6px] shrink-0 rounded-full bg-vez-navy/50" />
                <span className="text-[15px] leading-[1.8] text-vez-ink">{item}</span>
              </li>
            ))}
          </ul>
        </div>
      )
    } else {
      // Group consecutive paragraphs for visual spacing
      rendered.push(
        <p key={idx} className="text-[15px] leading-[1.9] text-vez-ink/90">
          {block.content}
        </p>
      )
      idx++
    }
  }

  return (
    <article className="formatted-content space-y-4 [&>*:first-child]:mt-0">
      {rendered}
    </article>
  )
}

const SUGGESTED_QUESTIONS = [
  "What is this notice about?",
  "Who does this affect?",
  "Are there any deadlines mentioned?",
  "What should I do next?",
]

function AttachmentSection({
  attachments,
  contentText,
  keyFacts,
}: {
  attachments: Array<{ id: string; url: string; mimeType: string | null; sizeBytes: number | null; storageKey: string | null; label: string | null }>
  contentText: string | null
  keyFacts: string[] | null
}) {
  const [expanded, setExpanded] = useState(true)
  const hasExtractedContent = !!contentText

  return (
    <section>
      <div className="mb-4 flex items-center gap-2">
        <Paperclip className="size-5 text-vez-navy" />
        <h2 className="text-lg text-vez-ink">
          Document{attachments.length > 1 ? "s" : ""} & Extracted Content
        </h2>
      </div>

      <div className="space-y-4">
        {attachments.map((att) => (
          <div key={att.id ?? att.url} className="overflow-hidden rounded-[16px] border border-vez-line bg-white">
            {/* File header with download */}
            <div className="flex flex-col gap-3 border-b border-vez-line bg-vez-surface/50 p-4 sm:flex-row sm:items-center sm:gap-4 sm:px-5 sm:py-4">
              <div className="flex size-11 shrink-0 items-center justify-center rounded-[12px] bg-vez-sky/30">
                {attachmentKind(att.url) === "image" ? (
                  <FileImage className="size-5 text-vez-navy" />
                ) : (
                  <FileText className="size-5 text-vez-navy" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className="break-words text-sm font-medium text-vez-ink line-clamp-2 sm:line-clamp-1">
                  {att.label || attachmentLabel(att.url)}
                </p>
                <p className="break-words text-xs text-vez-mute">
                  {att.sizeBytes ? `${(att.sizeBytes / 1024).toFixed(0)} KB` : ""}
                  {att.sizeBytes && att.mimeType ? " · " : ""}
                  {att.mimeType || ""}
                </p>
              </div>
              <a
                href={attachmentFileUrl(att, "download")}
                target="_blank"
                rel="noopener noreferrer"
                download={att.label || attachmentLabel(att.url)}
                className="flex w-full items-center justify-center gap-2 rounded-full bg-vez-navy px-4 py-2.5 text-xs text-white transition-opacity hover:opacity-90 sm:w-auto"
              >
                <Download className="size-3.5" /> Download
              </a>
            </div>

            {/* Inline image preview for images */}
            {attachmentKind(att.url) === "image" && (
              <div className="flex justify-center bg-gray-50 p-4 sm:p-6">
                <img
                  src={attachmentFileUrl(att)}
                  alt={att.label || "Attachment preview"}
                  className="max-h-[500px] w-full rounded-lg object-contain"
                />
              </div>
            )}

            {/* Inline PDF viewer */}
            {attachmentKind(att.url) === "file" && (att.mimeType?.includes("pdf") || att.url?.toLowerCase().endsWith(".pdf")) && (
              <div className="border-b border-vez-line bg-gray-50 p-4 sm:p-6">
                <div className="-mx-4 overflow-x-auto sm:mx-0">
                  <iframe
                    src={attachmentFileUrl(att)}
                    title={att.label || "PDF Document"}
                    className="h-[400px] w-full min-w-[600px] rounded-lg border border-vez-line sm:h-[600px]"
                  />
                </div>
              </div>
            )}

            {/* Extracted content for non-image files */}
            {attachmentKind(att.url) === "file" && hasExtractedContent && (
              <div className="p-4 sm:p-6">
                <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex items-center gap-2">
                    <Sparkles className="size-4 text-vez-navy" />
                    <span className="text-sm font-medium text-vez-navy">Extracted Content</span>
                    <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium text-emerald-700">AI Processed</span>
                  </div>
                  <button
                    onClick={() => setExpanded(!expanded)}
                    className="flex items-center gap-1 text-xs text-vez-mute transition-colors hover:text-vez-navy"
                  >
                    {expanded ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
                    {expanded ? "Collapse" : "Expand"}
                  </button>
                </div>

                {expanded && (
                  <div className="space-y-4">
                    {/* Key facts extracted from document */}
                    {keyFacts && keyFacts.length > 0 && (
                      <div className="rounded-[12px] bg-vez-sky/8 p-4">
                        <p className="mb-2.5 text-xs font-medium uppercase tracking-wide text-vez-navy/70">Key Points from Document</p>
                        <ul className="space-y-2">
                          {keyFacts.map((fact, i) => (
                            <li key={i} className="flex items-start gap-2.5">
                              <CheckCircle className="mt-0.5 size-4 shrink-0 text-vez-navy" />
                              <span className="text-sm leading-relaxed text-vez-ink">{fact}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {/* Extracted text preview */}
                    <div className="relative">
                      <div className={`overflow-hidden rounded-[12px] bg-vez-surface/70 p-5 ${contentText && contentText.length > 800 ? "max-h-[320px]" : ""}`}>
                        <p className="text-sm leading-relaxed text-vez-ink line-clamp-[12]">
                          {contentText?.slice(0, 600)}
                          {contentText && contentText.length > 600 ? "…" : ""}
                        </p>
                      </div>
                      {contentText && contentText.length > 400 && (
                        <div className="absolute inset-x-0 bottom-0 flex items-end justify-center rounded-b-[12px] bg-gradient-to-t from-vez-surface/95 to-transparent pb-3 pt-12">
                          <button
                            onClick={() => {
                              const el = document.getElementById("full-content-section")
                              el?.scrollIntoView({ behavior: "smooth" })
                            }}
                            className="flex items-center gap-1.5 rounded-full bg-white px-4 py-2 text-xs text-vez-navy shadow-sm border border-vez-line transition-colors hover:bg-vez-sky/10"
                          >
                            Read full content below <ArrowRight className="size-3" />
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  )
}

export default function NoticeDetailClient() {
  const params = useParams()
  const slug = params.slug as string
  const noticeId = slug.slice(-36)
  const { setActiveNotice } = useNoticeContext()

  const [notice, setNotice] = useState<PublicNoticeDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [loadError, setLoadError] = useState<unknown>(null)
  const [saved, setSaved] = useState(false)
  const [copied, setCopied] = useState(false)

  const [question, setQuestion] = useState("")
  const [qaHistory, setQaHistory] = useState<Array<{ q: string; a: string }>>([])
  const [answering, setAnswering] = useState(false)
  const [askQuota, setAskQuota] = useState<QuotaDenial | null>(null)
  const [extracting, setExtracting] = useState(false)

  // Admin-only re-extraction of this notice's attachment text.
  const { user } = useAuth()
  const isAdmin = user?.role === "admin"
  const [reextracting, setReextracting] = useState(false)
  const [reextractNote, setReextractNote] = useState<{ tone: "ok" | "info" | "error"; text: string } | null>(null)

  async function handleReextract() {
    if (reextracting) return
    setReextracting(true)
    setReextractNote(null)
    try {
      const result = await reextractNotice(noticeId)
      const fresh = await fetchNotice(noticeId)
      setNotice(fresh)
      if (!result.updated) {
        setReextractNote({ tone: "info", text: result.reason ?? "No text could be extracted." })
      } else {
        const improved =
          typeof result.qualityAfter === "number" && typeof result.qualityBefore === "number"
            ? result.qualityAfter > result.qualityBefore
            : null
        setReextractNote({
          tone: improved === false ? "info" : "ok",
          text:
            `Extracted ${result.chars?.toLocaleString()} characters` +
            (result.method ? ` via ${result.method}` : "") +
            (typeof result.qualityAfter === "number"
              ? ` · quality ${Math.round((result.qualityBefore ?? 0) * 100)}% → ${Math.round(result.qualityAfter * 100)}%`
              : ""),
        })
      }
    } catch (err) {
      setReextractNote({
        tone: "error",
        text: err instanceof Error ? err.message : "Re-extraction failed",
      })
    } finally {
      setReextracting(false)
    }
  }

  const loadNotice = useCallback(() => {
    let cancelled = false
    setLoading(true)
    setNotFound(false)
    setLoadError(null)
    fetchNotice(noticeId)
      .then((data) => {
        if (!cancelled) setNotice(data)
      })
      .catch((err) => {
        if (cancelled) return
        // A real 404 means the notice doesn't exist — anything else (network
        // drop, 5xx) is transient, so offer a retry instead of claiming it's gone.
        if (isApiError(err) && err.status === 404) {
          setNotFound(true)
        } else {
          setLoadError(err)
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [noticeId])

  useEffect(() => loadNotice(), [loadNotice])

  // If the notice loaded but has no content and has an OCR-able attachment
  // (PDF or a scanned image), the backend is extracting it now. Show an
  // indicator and poll once after a delay.
  useEffect(() => {
    if (!notice || notice.contentText) return
    const isExtractable = (url: string | null | undefined, mimeType?: string | null) => {
      if (!url) return false
      const lower = url.toLowerCase().split("?")[0].split("#")[0]
      if (mimeType?.includes("pdf") || lower.endsWith(".pdf")) return true
      if (mimeType?.startsWith("image/")) return true
      return IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext))
    }
    const hasExtractableAttachment =
      notice.attachments?.some((a) => isExtractable(a.url, a.mimeType)) ||
      isExtractable(notice.attachmentUrl) ||
      notice.attachmentUrl?.toLowerCase().includes("pdf")
    if (!hasExtractableAttachment) return

    setExtracting(true)
    const timer = setTimeout(() => {
      fetchNotice(noticeId)
        .then((data) => setNotice(data))
        .catch(() => {})
        .finally(() => setExtracting(false))
    }, 5000)
    return () => clearTimeout(timer)
  }, [notice, noticeId, notice?.id, notice?.contentText, notice?.attachments, notice?.attachmentUrl])

  // Set active notice in global context for floating chatbot
  useEffect(() => {
    if (!notice) return
    setActiveNotice({
      id: notice.id,
      title: notice.title,
      contentText: notice.contentText,
      aiSummary: notice.aiSummary,
      keyFacts: notice.keyFacts,
      sourceLabel: notice.sourceLabel,
    })
    return () => setActiveNotice(null)
  }, [notice, notice?.id, notice?.title, notice?.contentText, notice?.aiSummary, notice?.keyFacts, notice?.sourceLabel, setActiveNotice])

  async function handleShare() {
    try {
      await navigator.clipboard.writeText(window.location.href)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard access denied — nothing else to fall back to here.
    }
  }

  async function handleAsk(q?: string) {
    const finalQuestion = (q ?? question).trim()
    if (!finalQuestion || answering || !notice) return
    setAnswering(true)
    setQuestion("")
    setAskQuota(null)
    try {
      const { answer } = await askNoticeQuestion(notice.id, finalQuestion)
      setQaHistory((prev) => [...prev, { q: finalQuestion, a: answer }])
    } catch (e) {
      // A spent AI allowance is a billing state, not a chat failure — surface
      // it as an upgrade prompt instead of a bot apology.
      if (isQuotaError(e)) {
        setAskQuota(e.quota)
        return
      }
      setQaHistory((prev) => [
        ...prev,
        { q: finalQuestion, a: "Sorry, I couldn't process that question right now. Please try again." },
      ])
    } finally {
      setAnswering(false)
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-screen flex-col bg-white font-poppins">
        <Header />
        <div className="flex flex-1 flex-col items-center justify-center gap-3">
          <Loader2 className="size-6 animate-spin text-vez-navy" />
          <p className="text-sm text-vez-mute">Loading notice…</p>
          <p className="text-xs text-vez-mute/60">PDF documents may take a moment to process</p>
        </div>
      </div>
    )
  }

  if (loadError && !notice) {
    return (
      <div className="flex min-h-screen flex-col bg-white font-poppins">
        <Header />
        <div className="flex flex-1 items-center justify-center px-6">
          <ErrorState error={loadError} onRetry={loadNotice} />
        </div>
      </div>
    )
  }

  if (notFound || !notice) {
    return (
      <div className="flex min-h-screen flex-col bg-white font-poppins">
        <Header />
        <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6">
          <FileText className="size-16 text-vez-mute/20" />
          <h1 className="text-2xl text-vez-ink">Notice not found</h1>
          <p className="text-vez-mute">The notice you&apos;re looking for doesn&apos;t exist or has been removed.</p>
          <Link href="/notices" className="mt-4 rounded-full bg-vez-navy px-6 py-3 text-sm text-white transition-opacity hover:opacity-90">
            ← Browse all notices
          </Link>
        </div>
      </div>
    )
  }

  const deadline = notice.metadata?.deadline as string | undefined
  const deadlineInfo = deadline ? deadlineLabel(deadline) : null

  return (
    <div className="min-h-screen bg-white font-poppins">
      <Header />

      {/* ── Sticky Date Banner ── */}
      {(deadline || notice.publishedAt) && (
        <div suppressHydrationWarning className="sticky top-0 z-40 border-b border-vez-line bg-white/95 backdrop-blur-sm shadow-sm">
          <div className="mx-auto flex max-w-[1480px] items-center justify-between gap-3 px-4 py-3 sm:px-6 lg:px-8">
            <div className="flex flex-wrap items-center gap-3 sm:gap-4 lg:gap-6">
              {deadline && deadlineInfo && (
                <div className="flex items-center gap-2.5">
                  <div className={`flex size-9 items-center justify-center rounded-full ${
                    deadlineInfo.color === "red" ? "bg-red-100" :
                    deadlineInfo.color === "amber" ? "bg-amber-100" :
                    deadlineInfo.color === "green" ? "bg-emerald-100" : "bg-gray-100"
                  }`}>
                    <Timer className={`size-4.5 ${
                      deadlineInfo.color === "red" ? "text-red-600" :
                      deadlineInfo.color === "amber" ? "text-amber-600" :
                      deadlineInfo.color === "green" ? "text-emerald-600" : "text-gray-500"
                    }`} />
                  </div>
                  <div>
                    <p suppressHydrationWarning className={`text-sm font-medium ${
                      deadlineInfo.color === "red" ? "text-red-700" :
                      deadlineInfo.color === "amber" ? "text-amber-700" :
                      deadlineInfo.color === "green" ? "text-emerald-700" : "text-gray-600"
                    }`}>
                      Deadline: {formatDate(deadline)}
                    </p>
                    <p suppressHydrationWarning className={`text-xs ${
                      deadlineInfo.color === "red" ? "text-red-500" :
                      deadlineInfo.color === "amber" ? "text-amber-500" :
                      deadlineInfo.color === "green" ? "text-emerald-500" : "text-gray-400"
                    }`}>
                      {deadlineInfo.text}
                    </p>
                  </div>
                </div>
              )}
              {notice.publishedAt && (
                <div className="flex items-center gap-2.5">
                  <div className="flex size-9 items-center justify-center rounded-full bg-vez-sky/20">
                    <Calendar className="size-4.5 text-vez-navy" />
                  </div>
                  <div>
                    <p suppressHydrationWarning className="text-sm font-medium text-vez-ink">Published: {formatDate(notice.publishedAt)}</p>
                    <p className="text-xs text-vez-mute">{notice.sourceLabel}</p>
                  </div>
                </div>
              )}
            </div>
            <div suppressHydrationWarning className="hidden items-center gap-2 text-xs text-vez-mute md:flex">
              <Eye className="size-3.5" /> {notice.views.toLocaleString()} views
            </div>
          </div>
        </div>
      )}

      {/* Page hero / title section */}
      <section className="border-b border-vez-line bg-vez-surface/50 pt-6 pb-6 sm:pt-8 sm:pb-8">
        <div className="mx-auto max-w-[1480px] px-4 sm:px-6 lg:px-8">
          {/* Breadcrumb */}
          <nav className="mb-3 flex items-center gap-2 text-sm text-vez-mute">
            <Link href="/notices" className="transition-colors hover:text-vez-navy">Notices</Link>
            <span>/</span>
            <span className="text-vez-ink">{categoryLabel(notice.category)}</span>
          </nav>

          {/* Badges */}
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-vez-sky/30 px-4 py-1.5 text-sm text-vez-navy">
              {categoryLabel(notice.category)}
            </span>
            {notice.aiUrgency === "HIGH" && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-red-100 px-4 py-1.5 text-sm text-red-700">
                <AlertTriangle className="size-3.5" /> Urgent
              </span>
            )}
            {notice.aiUrgency === "MEDIUM" && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-100 px-4 py-1.5 text-sm text-amber-700">
                <Clock className="size-3.5" /> Important
              </span>
            )}
            {notice.aiSummary && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-white px-4 py-1.5 text-sm text-vez-mute border border-vez-line">
                <Sparkles className="size-3.5" /> AI summarized
              </span>
            )}
          </div>

          {/* Title */}
          <h1 className="max-w-4xl break-words text-xl leading-tight text-vez-ink sm:text-2xl lg:text-3xl xl:text-4xl">
            {notice.title}
          </h1>

          {/* Meta */}
          <div className="mt-3 flex flex-wrap items-center gap-3 sm:gap-5 text-sm text-vez-mute">
            <span className="flex items-center gap-2">
              <Building2 className="size-4" /> {notice.sourceLabel}
            </span>
            {notice.publishedAt && (
              <span className="flex items-center gap-2">
                <Calendar className="size-4" /> {formatDate(notice.publishedAt)}
              </span>
            )}
            <span className="flex items-center gap-2">
              <Eye className="size-4" /> {notice.views.toLocaleString()} views
            </span>
          </div>

          {/* Action buttons */}
          <div className="mt-4 flex flex-col flex-wrap items-center gap-3 sm:flex-row">
            <button
              onClick={() => setSaved(!saved)}
              className={`flex items-center gap-2 rounded-full px-5 py-2.5 text-sm transition-all ${
                saved ? "bg-vez-navy text-white" : "bg-white text-vez-ink border border-vez-line hover:bg-vez-surface"
              }`}
            >
              {saved ? <BookmarkCheck className="size-4" /> : <Bookmark className="size-4" />}
              {saved ? "Saved" : "Save notice"}
            </button>
            <Link
              href="/login"
              className="flex items-center gap-2 rounded-full bg-vez-navy px-5 py-2.5 text-sm text-white transition-opacity hover:opacity-90"
            >
              <Bell className="size-4" /> Set alert
            </Link>
            <button
              onClick={handleShare}
              className="flex items-center gap-2 rounded-full bg-white px-5 py-2.5 text-sm text-vez-ink border border-vez-line transition-colors hover:bg-vez-surface"
            >
              {copied ? <Check className="size-4 text-vez-navy" /> : <Share2 className="size-4" />}
              {copied ? "Link copied" : "Share"}
            </button>
            <a
              href={notice.sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 rounded-full bg-white px-5 py-2.5 text-sm text-vez-ink border border-vez-line transition-colors hover:bg-vez-surface"
            >
              <ExternalLink className="size-4" /> View original
            </a>
          </div>
        </div>
      </section>

      {/* Main content area - two columns */}
      <div className="mx-auto max-w-[1480px] px-4 py-6 sm:px-6 sm:py-8 lg:px-8 lg:py-10">
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3 lg:gap-8">

          {/* ── Left: Main content ── */}
          <div className="min-w-0 space-y-6 sm:space-y-8 lg:col-span-2">
            {/* AI Summary — English & Nepali */}
            {(notice.aiSummary || notice.aiSummaryNe) && (
              <section>
                <div className="mb-4 flex items-center gap-2">
                  <Sparkles className="size-5 text-vez-navy" />
                  <h2 className="text-lg text-vez-ink">AI Summary</h2>
                </div>
                <div className="space-y-4">
                  {notice.aiSummary && (
                    <div className="rounded-[16px] bg-vez-sky/10 p-4 sm:p-6 lg:p-8">
                      <p className="mb-2 text-xs font-medium uppercase tracking-wide text-vez-navy/60">English</p>
                      <p className="break-words text-sm leading-relaxed text-vez-ink sm:text-base lg:text-lg lg:leading-relaxed">
                        {notice.aiSummary}
                      </p>
                    </div>
                  )}
                  {notice.aiSummaryNe && (
                    <div className="rounded-[16px] bg-amber-50/60 p-4 sm:p-6 lg:p-8">
                      <p className="mb-2 text-xs font-medium uppercase tracking-wide text-amber-700/60">नेपाली</p>
                      <p className="break-words text-sm leading-relaxed text-vez-ink sm:text-base lg:text-lg lg:leading-relaxed" lang="ne">
                        {notice.aiSummaryNe}
                      </p>
                    </div>
                  )}
                </div>
              </section>
            )}

            {/* Key Facts */}
            {notice.keyFacts && notice.keyFacts.length > 0 && (
              <section>
                <h2 className="mb-4 text-lg sm:text-xl text-vez-ink">Key Facts</h2>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4">
                  {notice.keyFacts.map((fact, i) => (
                    <div key={i} className="flex min-w-0 items-start gap-3 rounded-[12px] bg-vez-surface p-4 sm:p-5">
                      <CheckCircle className="mt-0.5 size-5 shrink-0 text-vez-navy" />
                      <span className="min-w-0 break-words text-sm leading-relaxed text-vez-ink">{fact}</span>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* Metadata — non-deadline, non-qrCodes fields (qrCodes gets its own section below) */}
            {notice.metadata && Object.keys(notice.metadata).filter(k => k !== "deadline" && k !== "qrCodes").length > 0 && (
              <section>
                <h2 className="mb-3 text-lg sm:text-xl text-vez-ink">Details</h2>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4">
                  {Object.entries(notice.metadata)
                    .filter(([k]) => k !== "deadline" && k !== "qrCodes")
                    .map(([key, value]) => (
                      <div key={key} className="rounded-[12px] bg-vez-surface p-4">
                        <p className="text-xs text-vez-mute capitalize">{key.replace(/([A-Z])/g, " $1").trim()}</p>
                        <p className="text-sm text-vez-ink">{String(value)}</p>
                      </div>
                    ))}
                </div>
              </section>
            )}

            {/* QR codes detected in the PDF attachment — payment/link QRs are
                common in government relief/donation notices, and the extractor
                decodes their payload as well as cropping the code itself. */}
            {notice.metadata?.qrCodes && notice.metadata.qrCodes.length > 0 && (
              <section>
                <div className="mb-3 flex items-center gap-2">
                  <QrCode className="size-5 text-vez-navy" />
                  <h2 className="text-lg text-vez-ink">QR Codes</h2>
                </div>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-6 lg:grid-cols-3">
                  {notice.metadata.qrCodes.map((qr, i) => (
                    <div key={i} className="flex h-full min-w-0 flex-col items-center gap-3 rounded-[14px] border border-vez-line bg-white p-4 sm:p-6 text-center">
                      {qr.image && (
                        <img
                          src={`data:image/png;base64,${qr.image}`}
                          alt={`QR code from page ${qr.page}`}
                          className="size-32 rounded-lg border border-vez-line/60 object-contain"
                        />
                      )}
                      <p className="text-xs text-vez-mute">Page {qr.page}</p>
                      {/^https?:\/\//i.test(qr.data) ? (
                        <a
                          href={qr.data}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="break-all text-sm text-vez-navy underline underline-offset-2"
                        >
                          {qr.data}
                        </a>
                      ) : (
                        <p className="break-all text-sm text-vez-ink">{qr.data}</p>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* Admin: fix a bad extraction without leaving the page */}
            {isAdmin && (notice.attachments?.length > 0 || notice.attachmentUrl) && (
              <section className="rounded-[16px] border border-vez-line bg-vez-surface/50 p-4 sm:p-5">
                <div className="flex flex-col flex-wrap items-center justify-between gap-3 sm:flex-row">
                  <div>
                    <p className="text-sm font-medium text-vez-ink">Admin: extraction</p>
                    <p className="mt-0.5 text-xs text-vez-mute">
                      Re-run text extraction on the attachment — OCRs the document again and
                      refreshes the summary and key facts.
                    </p>
                  </div>
                  <button
                    onClick={handleReextract}
                    disabled={reextracting}
                    className="flex shrink-0 items-center gap-2 rounded-full bg-vez-navy px-5 py-2.5 text-xs text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {reextracting ? (
                      <><Loader2 className="size-3.5 animate-spin" /> Re-extracting…</>
                    ) : (
                      <><RefreshCw className="size-3.5" /> Re-extract content</>
                    )}
                  </button>
                </div>
                {reextractNote && (
                  <p
                    className={`mt-2.5 text-xs ${
                      reextractNote.tone === "error"
                        ? "text-red-600"
                        : reextractNote.tone === "ok"
                          ? "text-vez-ink"
                          : "text-vez-mute"
                    }`}
                  >
                    {reextractNote.text}
                  </p>
                )}
              </section>
            )}

            {/* Attachments — with inline extracted content */}
            {(notice.attachments?.length > 0 || notice.attachmentUrl) && (
              <AttachmentSection
                attachments={notice.attachments?.length ? notice.attachments : notice.attachmentUrl ? [{ id: "legacy", url: notice.attachmentUrl, label: null, mimeType: null, sizeBytes: null, storageKey: null }] : []}
                contentText={notice.contentText}
                keyFacts={notice.keyFacts}
              />
            )}

            {/* Full Content */}
            <section id="full-content-section">
              <div className="mb-5 flex items-center gap-2">
                <FileText className="size-5 text-vez-navy" />
                <h2 className="text-lg sm:text-xl font-semibold text-vez-ink">Full Content</h2>
              </div>
              <div className="rounded-[20px] border border-vez-line bg-white p-4 shadow-sm sm:p-6 lg:p-8 xl:p-10">
                {notice.contentText ? (
                  <FormattedContent text={notice.contentText} />
                ) : extracting ? (
                  <div className="flex flex-col items-center gap-3 py-8 text-center">
                    <Loader2 className="size-6 animate-spin text-vez-navy" />
                    <p className="text-sm font-medium text-vez-ink">Extracting document content…</p>
                    <p className="text-xs text-vez-mute">Running OCR and AI analysis on the document</p>
                  </div>
                ) : notice.attachmentUrl || (notice.attachments?.length > 0) ? (
                  <div className="flex flex-col items-center gap-3 py-6 text-center">
                    <FileText className="size-8 text-vez-mute/30" />
                    <p className="text-sm text-vez-mute">
                      Content extraction is being processed — reload to check if it&apos;s ready, or view the original document above.
                    </p>
                  </div>
                ) : (
                  <p className="text-sm text-vez-mute">
                    Full content wasn&apos;t captured for this item — view it on the original source.
                  </p>
                )}
              </div>
              <p suppressHydrationWarning className="mt-3 flex items-center gap-2 text-xs text-vez-mute">
                <Calendar className="size-3" /> Last updated: {formatDateShort(notice.updatedAt)}
              </p>
            </section>

            {/* Ask AI section */}
            {(notice.contentText || notice.attachmentUrl || notice.attachments?.length > 0) && (
              <section>
                <div className="mb-4 flex items-center gap-2">
                  <MessageSquare className="size-5 text-vez-navy" />
                  <h2 className="text-lg text-vez-ink">Ask AI about this notice</h2>
                </div>

                <div className="rounded-[16px] border border-vez-line bg-white p-4 sm:p-6">
                  {qaHistory.length === 0 && (
                    <div className="mb-4 grid grid-cols-1 gap-2 sm:grid-cols-2 sm:gap-3">
                      {SUGGESTED_QUESTIONS.map((q) => (
                        <button
                          key={q}
                          onClick={() => handleAsk(q)}
                          disabled={answering}
                          className="group flex items-center justify-between rounded-[10px] bg-vez-surface px-4 py-3 text-left text-sm text-vez-ink transition-colors hover:bg-vez-sky/15 disabled:opacity-50"
                        >
                          <span>{q}</span>
                          <ArrowRight className="size-3.5 text-vez-mute opacity-0 group-hover:opacity-100" />
                        </button>
                      ))}
                    </div>
                  )}

                  {qaHistory.length > 0 && (
                    <div className="mb-4 max-h-[400px] space-y-4 overflow-y-auto">
                      {qaHistory.map((item, i) => (
                        <div key={i} className="space-y-2">
                          <div className="ml-auto max-w-[80%] rounded-[14px] rounded-br-[4px] bg-vez-sky/25 px-4 py-3 text-right text-sm text-vez-ink">
                            {item.q}
                          </div>
                          <div className="mr-auto max-w-[85%] rounded-[14px] rounded-bl-[4px] bg-vez-surface px-4 py-3">
                            <div className="mb-1.5 flex items-center gap-1.5">
                              <Sparkles className="size-3 text-vez-navy" />
                              <span className="text-xs text-vez-navy">Suchana AI</span>
                            </div>
                            <div className="text-sm leading-relaxed text-vez-ink [&_a]:text-vez-navy [&_code]:text-vez-navy [&_strong]:text-vez-ink [&_th]:text-vez-ink">
                              <ChatMarkdown content={item.a} />
                            </div>
                            <CopyButton text={item.a} className="-ml-1.5 mt-1" />
                          </div>
                        </div>
                      ))}
                      {answering && (
                        <div className="mr-auto rounded-[14px] bg-vez-surface px-4 py-3">
                          <div className="flex items-center gap-1.5">
                            <span className="size-1.5 animate-bounce rounded-full bg-vez-navy" />
                            <span className="size-1.5 animate-bounce rounded-full bg-vez-navy [animation-delay:150ms]" />
                            <span className="size-1.5 animate-bounce rounded-full bg-vez-navy [animation-delay:300ms]" />
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {askQuota && (
                    <div className="mb-4">
                      <UpgradePrompt quota={askQuota} compact onDismiss={() => setAskQuota(null)} />
                    </div>
                  )}

                  <div className="flex flex-col gap-2 border-t border-vez-line pt-4 sm:flex-row">
                    <input
                      value={question}
                      onChange={(e) => setQuestion(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && handleAsk()}
                      placeholder="Ask a question about this notice…"
                      className="h-11 min-h-[44px] w-full min-w-0 flex-1 rounded-full border border-vez-line bg-vez-surface px-5 text-[16px] sm:text-sm text-vez-ink outline-none placeholder:text-vez-mute focus:border-vez-sky focus:bg-white"
                      disabled={answering}
                    />
                    <button
                      onClick={() => handleAsk()}
                      disabled={!question.trim() || answering}
                      className="flex size-11 min-h-[44px] shrink-0 items-center justify-center rounded-full bg-vez-navy text-white transition-opacity disabled:opacity-40"
                    >
                      <Send className="size-4" />
                    </button>
                  </div>
                </div>
              </section>
            )}
          </div>

          {/* ── Right: Sidebar ── */}
          <aside className="min-w-0 space-y-6 lg:col-span-1">
            <div className="sticky top-20 space-y-4 sm:space-y-6">
              {/* Deadline card — high prominence */}
              {deadline && deadlineInfo && (
                <div className={`rounded-[16px] p-5 ${
                  deadlineInfo.color === "red" ? "bg-red-50 border border-red-200" :
                  deadlineInfo.color === "amber" ? "bg-amber-50 border border-amber-200" :
                  deadlineInfo.color === "green" ? "bg-emerald-50 border border-emerald-200" :
                  "bg-gray-50 border border-gray-200"
                }`}>
                  <div className="flex items-center gap-3 mb-2">
                    <Timer className={`size-5 ${
                      deadlineInfo.color === "red" ? "text-red-600" :
                      deadlineInfo.color === "amber" ? "text-amber-600" :
                      deadlineInfo.color === "green" ? "text-emerald-600" : "text-gray-500"
                    }`} />
                    <div>
                      <p className="text-xs font-medium uppercase tracking-wide text-vez-mute">Deadline</p>
                      <p suppressHydrationWarning className={`text-base font-semibold ${
                        deadlineInfo.color === "red" ? "text-red-700" :
                        deadlineInfo.color === "amber" ? "text-amber-700" :
                        deadlineInfo.color === "green" ? "text-emerald-700" : "text-gray-600"
                      }`}>{formatDate(deadline)}</p>
                    </div>
                  </div>
                  <div className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ${
                    deadlineInfo.color === "red" ? "bg-red-100 text-red-700" :
                    deadlineInfo.color === "amber" ? "bg-amber-100 text-amber-700" :
                    deadlineInfo.color === "green" ? "bg-emerald-100 text-emerald-700" :
                    "bg-gray-100 text-gray-600"
                  }`}>
                    <Clock className="size-3" />
                    {deadlineInfo.text}
                  </div>
                </div>
              )}

              <div className="rounded-[16px] border border-vez-line bg-white p-4 sm:p-6">
                <h3 className="mb-4 text-sm font-medium text-vez-ink">Notice Details</h3>
                <dl className="space-y-3 sm:space-y-4">
                  {[
                    { label: "Source", value: notice.sourceLabel, icon: Building2 },
                    ...(notice.publishedAt
                      ? [{ label: "Published", value: formatDate(notice.publishedAt), icon: Calendar }]
                      : []),
                    { label: "Views", value: notice.views.toLocaleString(), icon: Eye },
                    { label: "Indexed", value: formatDateShort(notice.scrapedAt), icon: Globe },
                  ].map((item) => {
                    const Icon = item.icon
                    return (
                      <div key={item.label} className="flex items-start gap-3">
                        <Icon className="mt-0.5 size-4 shrink-0 text-vez-mute" />
                        <div>
                          <dt className="text-xs text-vez-mute">{item.label}</dt>
                          <dd className="text-sm text-vez-ink">{item.value}</dd>
                        </div>
                      </div>
                    )
                  })}
                </dl>
              </div>

              {/* Tags */}
              {notice.tags && notice.tags.length > 0 && (
                <div className="rounded-[16px] border border-vez-line bg-white p-4 sm:p-6">
                  <h3 className="mb-3 text-sm font-medium text-vez-ink">Tags</h3>
                  <div className="flex flex-wrap gap-2 sm:gap-3">
                    {notice.tags.map((tag) => (
                      <Link
                        key={tag}
                        href={`/notices?q=${encodeURIComponent(tag)}`}
                        className="inline-flex items-center gap-1.5 rounded-full bg-vez-surface px-3 py-1.5 text-xs text-vez-mute transition-colors hover:bg-vez-sky/20 hover:text-vez-navy"
                      >
                        <Tag className="size-3" /> {tag}
                      </Link>
                    ))}
                  </div>
                </div>
              )}

              {/* CTA */}
              <div className="rounded-[16px] bg-vez-sky/20 p-4 sm:p-6">
                <h3 className="mb-2 text-sm font-medium text-vez-ink">Never miss similar notices</h3>
                <p className="mb-4 text-xs text-vez-mute">
                  Get instant alerts when new {categoryLabel(notice.category)} notices are published.
                </p>
                <Link
                  href="/login"
                  className="flex w-full items-center justify-center gap-2 rounded-full bg-vez-navy px-5 py-3 text-sm text-white transition-opacity hover:opacity-90"
                >
                  <Bell className="size-4" /> Set up alerts
                </Link>
              </div>
            </div>
          </aside>
        </div>
      </div>

      {/* Back link footer */}
      <div className="border-t border-vez-line bg-vez-surface/50">
        <div className="mx-auto flex max-w-[1480px] flex-col items-center justify-between gap-3 px-4 py-6 sm:flex-row sm:px-6 lg:px-8">
          <Link href="/notices" className="flex items-center gap-2 text-sm text-vez-mute transition-colors hover:text-vez-navy">
            <ArrowLeft className="size-4" /> Back to all notices
          </Link>
          <a
            href={notice.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 text-sm text-vez-navy transition-colors hover:underline"
          >
            View on {notice.sourceLabel} <ExternalLink className="size-3.5" />
          </a>
        </div>
      </div>
    </div>
  )
}
