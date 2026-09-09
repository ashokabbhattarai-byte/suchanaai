"use client"

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import {
  MessageSquare, ShieldCheck, ListFilter, Cpu, Split, Database,
  Layers, Sparkles, BookOpen, Send, Play, Pause, RotateCcw,
  ZoomIn, ZoomOut, X, Check, Workflow, Clock, Minus, type LucideIcon,
} from "lucide-react"
import { RagRunTrace, RagPipelineStage } from "@/lib/types"

// ─── Graph definition ─────────────────────────────────────────────────────────

type Lane = "web" | "api" | "ai" | "vector" | "llm"

interface NodeDef {
  id: string
  title: string
  service: string
  lane: Lane
  icon: LucideIcon
  note: string
  x: number
  y: number
  // A snake layout: the top row flows right, the bottom row flows back left.
  outPort: "right" | "left" | "bottom"
  inPort: "left" | "right" | "top"
}

const NODE_W = 176
const NODE_H = 100
const CANVAS_W = 1064
const CANVAS_H = 392
const COL = [24, 232, 440, 648, 856]
const ROW = [56, 244]

const NODES: NodeDef[] = [
  {
    id: "request", title: "Question submitted", service: "apps/web", lane: "web", icon: MessageSquare,
    note: "The browser posts the question to the API. Nothing is sent to the AI service yet.",
    x: COL[0], y: ROW[0], inPort: "left", outPort: "right",
  },
  {
    id: "auth", title: "Auth & AI quota", service: "apps/api", lane: "api", icon: ShieldCheck,
    note: "Optional JWT identifies the caller; signed-in users spend one AI question from their monthly allowance. It is only charged after a successful answer.",
    x: COL[1], y: ROW[0], inPort: "left", outPort: "right",
  },
  {
    id: "scope", title: "Document access scope", service: "apps/api", lane: "api", icon: ListFilter,
    note: "Postgres resolves which indexed documents this caller may search — system documents plus their own uploads. Everything else is invisible to retrieval.",
    x: COL[2], y: ROW[0], inPort: "left", outPort: "right",
  },
  {
    id: "embed_query", title: "Embed the question", service: "apps/ai", lane: "ai", icon: Cpu,
    note: "The question becomes a dense vector with the same model used to index the documents, so question and chunks live in one space.",
    x: COL[3], y: ROW[0], inPort: "left", outPort: "right",
  },
  {
    id: "intent", title: "Intent router", service: "apps/ai", lane: "ai", icon: Split,
    note: "Greetings and chit-chat are answered directly. Only real document questions continue to retrieval, which keeps small talk off the vector database.",
    x: COL[4], y: ROW[0], inPort: "left", outPort: "bottom",
  },
  {
    id: "search", title: "Hybrid vector search", service: "Qdrant", lane: "vector", icon: Database,
    note: "Dense (semantic) and BM25 (keyword) searches run in parallel and are fused with Reciprocal Rank Fusion, scoped to the allowed documents.",
    x: COL[4], y: ROW[1], inPort: "top", outPort: "left",
  },
  {
    id: "select_context", title: "Rank, dedupe & merge", service: "apps/ai", lane: "ai", icon: Layers,
    note: "Weak hits are dropped below the score threshold, duplicates removed, and adjacent chunks from the same section merged so a citation covers a real page range.",
    x: COL[3], y: ROW[1], inPort: "right", outPort: "left",
  },
  {
    id: "generate", title: "Generate answer", service: "LLM", lane: "llm", icon: Sparkles,
    note: "The selected chunks are numbered and passed as context. The model must answer from them and cite the block it used.",
    x: COL[2], y: ROW[1], inPort: "right", outPort: "left",
  },
  {
    id: "citations", title: "Verify citations", service: "apps/ai", lane: "ai", icon: BookOpen,
    note: "Any [n] marker pointing past the context actually supplied is stripped, so every citation the reader sees resolves to a real source.",
    x: COL[1], y: ROW[1], inPort: "right", outPort: "left",
  },
  {
    id: "deliver", title: "Answer & sources", service: "apps/web", lane: "web", icon: Send,
    note: "The answer streams back with its source chips — document, page range and section — so every claim can be opened and checked.",
    x: COL[0], y: ROW[1], inPort: "right", outPort: "left",
  },
]

// Stages the AI service measures. Everything else is reported without a timing
// rather than with an invented one.
const TIMED_STAGES = new Set(["embed_query", "intent", "search", "select_context", "generate", "citations"])

const LANE_STYLES: Record<Lane, { chip: string; ring: string; label: string }> = {
  web: { chip: "bg-vez-navy text-white", ring: "ring-vez-navy/30", label: "text-vez-navy" },
  api: { chip: "bg-indigo-500 text-white", ring: "ring-indigo-400/40", label: "text-indigo-600" },
  ai: { chip: "bg-violet-500 text-white", ring: "ring-violet-400/40", label: "text-violet-600" },
  vector: { chip: "bg-amber-500 text-white", ring: "ring-amber-400/40", label: "text-amber-600" },
  llm: { chip: "bg-emerald-500 text-white", ring: "ring-emerald-400/40", label: "text-emerald-600" },
}

// ─── Edge geometry ────────────────────────────────────────────────────────────

function portPoint(node: NodeDef, port: "left" | "right" | "top" | "bottom") {
  switch (port) {
    case "left": return { x: node.x, y: node.y + NODE_H / 2 }
    case "right": return { x: node.x + NODE_W, y: node.y + NODE_H / 2 }
    case "top": return { x: node.x + NODE_W / 2, y: node.y }
    case "bottom": return { x: node.x + NODE_W / 2, y: node.y + NODE_H }
  }
}

function edgePath(from: NodeDef, to: NodeDef): string {
  const a = portPoint(from, from.outPort)
  const b = portPoint(to, to.inPort)
  if (from.outPort === "bottom") {
    return `M ${a.x} ${a.y} C ${a.x} ${a.y + 56}, ${b.x} ${b.y - 56}, ${b.x} ${b.y}`
  }
  const bend = from.outPort === "right" ? 46 : -46
  return `M ${a.x} ${a.y} C ${a.x + bend} ${a.y}, ${b.x - bend} ${b.y}, ${b.x} ${b.y}`
}

const EDGES = NODES.slice(0, -1).map((n, i) => ({
  id: `${n.id}->${NODES[i + 1].id}`,
  d: edgePath(n, NODES[i + 1]),
}))

// ─── Sample run (used before any question has been asked) ─────────────────────

const SAMPLE_RUN: RagRunTrace = {
  question: "What are the e-procurement rules for public bidding?",
  answer:
    "Electronic bidding is mandatory for contracts above the prescribed threshold [1]. Bidders must register on the e-GP portal before submitting, and bid security may be submitted electronically [2].",
  askedAt: new Date().toISOString(),
  authenticated: true,
  documentId: null,
  clientMs: 2380,
  aiMs: 2074,
  searchMode: "hybrid-rrf",
  modelUsed: "openai/gpt-oss-120b",
  scopeDocCount: 12,
  scopeLabel: "All ready documents",
  stages: [
    { id: "embed_query", ms: 88, detail: { model: "intfloat/multilingual-e5-base", dim: 768, chars: 52 } },
    { id: "intent", ms: 31, detail: { route: "document", matched_by: "embedding" } },
    { id: "search", ms: 412, detail: { mode: "hybrid-rrf", collection: "documents", candidates: 15, requested: 15, scope: "12 docs", top_score: 0.871 } },
    { id: "select_context", ms: 6, detail: { threshold: 0.78, in: 15, kept: 4, chars: 3180 } },
    { id: "generate", ms: 1512, detail: { model: "openai/gpt-oss-120b", mode: "grounded", context_blocks: 4, chars: 486 } },
    { id: "citations", ms: 1, detail: { markers: 2, available: 4 } },
  ],
  sources: [
    { doc_id: "d1", chunk_index: 12, content: "Electronic bidding shall be mandatory for procurement exceeding…", score: 0.871, title: "Public Procurement Act 2063", page_range: [24, 25], section_path: "Chapter 5 > Electronic Bidding" },
    { doc_id: "d1", chunk_index: 13, content: "The bid security may be submitted in electronic form through…", score: 0.842, title: "Public Procurement Act 2063", page_range: [26], section_path: "Chapter 5 > Bid Security" },
    { doc_id: "d2", chunk_index: 4, content: "Every bidder shall register in the electronic government procurement…", score: 0.803, title: "e-GP Operating Guideline", page_range: [7], section_path: "Registration" },
    { doc_id: "d2", chunk_index: 9, content: "Bids submitted after the deadline shall be rejected automatically…", score: 0.791, title: "e-GP Operating Guideline", page_range: [11], section_path: "Submission" },
  ],
}

// ─── Node payload inspector data ──────────────────────────────────────────────

interface NodeIO {
  input: unknown
  output: unknown
}

function stageOf(run: RagRunTrace, id: string): RagPipelineStage | undefined {
  return run.stages.find(s => s.id === id)
}

// Stage details are always primitives, so they can be read and re-serialised directly.
type StageDetail = Record<string, string | number | boolean | null | undefined>

function buildNodeIO(nodeId: string, run: RagRunTrace): NodeIO {
  const d = (id: string): StageDetail => (stageOf(run, id)?.detail ?? {}) as StageDetail

  switch (nodeId) {
    case "request":
      return {
        input: { question: run.question, askedAt: run.askedAt },
        output: {
          method: "POST",
          path: "/rag/query",
          body: { question: run.question, documentId: run.documentId, topK: 5 },
        },
      }
    case "auth":
      return {
        input: { authorization: run.authenticated ? "Bearer <jwt>" : null, guard: "OptionalJwtAuthGuard" },
        output: run.authenticated
          ? { authenticated: true, quota: "assertCanAskAi → allowed", metered: true }
          : { authenticated: false, quota: "not metered", visibility: "system documents only" },
      }
    case "scope":
      return {
        input: {
          where: run.authenticated
            ? { OR: [{ isSystem: true }, { uploadedBy: "<me>" }], status: "INDEXED" }
            : { isSystem: true, status: "INDEXED" },
        },
        output: run.documentId
          ? { docId: run.documentId, scope: "single document" }
          : { allowedDocIds: run.scopeDocCount, scope: run.scopeLabel },
      }
    case "embed_query":
      return {
        input: { text: run.question, kind: "query", chars: d("embed_query").chars },
        output: { model: d("embed_query").model, vector: `float32[${d("embed_query").dim ?? "?"}]` },
      }
    case "intent":
      return {
        input: { question: run.question, signals: ["lexical phrases", "embedding similarity"] },
        output: { route: d("intent").route, matchedBy: d("intent").matched_by },
      }
    case "search": {
      const s = d("search")
      return {
        input: {
          dense: `float32[${d("embed_query").dim ?? 768}]`,
          sparse: "bm25",
          fusion: "RRF",
          limit: s.requested,
          filter: s.scope,
        },
        output: {
          collection: s.collection,
          mode: s.mode,
          candidates: s.candidates,
          topScore: s.top_score,
        },
      }
    }
    case "select_context": {
      const s = d("select_context")
      return {
        input: { candidates: s.in, scoreThreshold: s.threshold },
        output: { kept: s.kept, contextChars: s.chars, merged: "adjacent chunks joined" },
      }
    }
    case "generate": {
      const s = d("generate")
      return {
        input: { model: s.model, mode: s.mode, contextBlocks: s.context_blocks ?? 0 },
        output: { chars: s.chars, answer: truncate(run.answer, 260) },
      }
    }
    case "citations": {
      const s = d("citations")
      return {
        input: { answerMarkers: "[n]", availableBlocks: s.available },
        output: { resolved: s.markers, droppedOutOfRange: true },
      }
    }
    case "deliver":
      return {
        input: { answerChars: run.answer.length, sources: run.sources.length },
        output: {
          modelUsed: run.modelUsed,
          searchMode: run.searchMode,
          sources: run.sources.slice(0, 4).map(s => ({
            title: s.title || "Untitled",
            score: Number(s.score.toFixed(3)),
            pages: s.page_range ?? null,
            section: s.section_path ?? null,
          })),
          roundTripMs: run.clientMs,
        },
      }
    default:
      return { input: null, output: null }
  }
}

function truncate(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function formatMs(ms: number) {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`
  // A sub-millisecond stage is real work, not a zero.
  if (ms > 0 && ms < 1) return "<1 ms"
  return `${Math.round(ms)} ms`
}

// ─── JSON viewer ──────────────────────────────────────────────────────────────

function JsonBlock({ label, value }: { label: string; value: unknown }) {
  const nodes = useMemo(() => {
    const text = JSON.stringify(value, null, 2) ?? "null"
    const token = /("(?:\\.|[^"\\])*"\s*:)|("(?:\\.|[^"\\])*")|(-?\d+(?:\.\d+)?)|(true|false|null)/g
    const out: React.ReactNode[] = []
    let last = 0
    let key = 0
    let m: RegExpExecArray | null
    while ((m = token.exec(text)) !== null) {
      if (m.index > last) out.push(text.slice(last, m.index))
      const cls = m[1]
        ? "text-vez-navy font-semibold"
        : m[2]
          ? "text-emerald-700"
          : m[3]
            ? "text-amber-700"
            : "text-violet-700"
      out.push(<span key={key++} className={cls}>{m[0]}</span>)
      last = m.index + m[0].length
    }
    out.push(text.slice(last))
    return out
  }, [value])

  return (
    <div>
      <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-vez-mute/70">{label}</p>
      <pre className="max-h-52 overflow-y-auto whitespace-pre-wrap break-words rounded-xl border border-vez-line/60 bg-vez-surface/60 p-3 font-mono text-[11px] leading-relaxed text-vez-ink">
        {nodes}
      </pre>
    </div>
  )
}

// ─── Playback ─────────────────────────────────────────────────────────────────

type NodeStatus = "idle" | "running" | "done" | "skipped"

// Real durations drive the pacing, clamped so a 1 ms stage is still visible and
// a slow LLM call doesn't stall the demo. The number shown is always the real one.
const EDGE_MS = 240

function nodeDuration(nodeId: string, run: RagRunTrace): number {
  const stage = stageOf(run, nodeId)
  if (!stage) return 340
  return Math.min(Math.max(stage.ms, 420), 1500)
}

interface Step {
  kind: "node" | "edge"
  index: number
  ms: number
}

function buildSchedule(run: RagRunTrace, ran: boolean[]): Step[] {
  const steps: Step[] = []
  NODES.forEach((n, i) => {
    steps.push({ kind: "node", index: i, ms: ran[i] ? nodeDuration(n.id, run) : 220 })
    if (i < NODES.length - 1) steps.push({ kind: "edge", index: i, ms: EDGE_MS })
  })
  return steps
}

// ─── Main component ───────────────────────────────────────────────────────────

export function WorkflowPreview({
  run,
  isSample,
  onClose,
}: {
  run: RagRunTrace | null
  isSample: boolean
  onClose: () => void
}) {
  const trace = run ?? SAMPLE_RUN
  const sample = isSample || !run

  // A node "ran" if the AI measured it, or if it sits outside the AI service
  // (request/auth/scope/deliver always happen). Stages absent from a chat-route
  // answer render as skipped, which is exactly what the demo should show.
  const ran = useMemo(
    () => NODES.map(n => (TIMED_STAGES.has(n.id) ? !!stageOf(trace, n.id) : true)),
    [trace],
  )

  const schedule = useMemo(() => buildSchedule(trace, ran), [trace, ran])

  const [stepIdx, setStepIdx] = useState(0)
  const [playing, setPlaying] = useState(true)
  const [speed, setSpeed] = useState(1)
  const [pinnedId, setPinnedId] = useState<string | null>(null)
  const [logs, setLogs] = useState<string[]>([])
  const [zoom, setZoom] = useState(1)
  const [autoZoom, setAutoZoom] = useState(true)

  const viewportRef = useRef<HTMLDivElement>(null)
  const logRef = useRef<HTMLDivElement>(null)
  const reducedMotion = useRef(false)

  useEffect(() => {
    reducedMotion.current =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    if (reducedMotion.current) setPlaying(false)
  }, [])

  // Fit the canvas to the viewport until the user zooms by hand.
  useLayoutEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const fit = () => {
      if (!autoZoom) return
      const available = el.clientWidth - 32
      // Phones can't fit the graph and stay legible, so keep the nodes readable
      // and let the canvas pan instead of shrinking the text to nothing.
      const floor = window.innerWidth < 640 ? 0.8 : 0.45
      setZoom(Math.min(1, Math.max(floor, available / CANVAS_W)))
    }
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [autoZoom])

  const done = stepIdx >= schedule.length
  const current = done ? null : schedule[stepIdx]
  const activeNodeIndex = current?.kind === "node" ? current.index : -1
  const activeEdgeIndex = current?.kind === "edge" ? current.index : -1
  const completedNodes = useMemo(() => {
    if (done) return NODES.length
    // Every node before the current step has finished.
    return current?.kind === "node" ? current.index : (current?.index ?? 0) + 1
  }, [current, done])

  // The driver: one timer per step, restarted when speed changes.
  useEffect(() => {
    if (!playing || done) return
    const step = schedule[stepIdx]
    const timer = setTimeout(() => {
      if (step.kind === "node") {
        const node = NODES[step.index]
        const stage = stageOf(trace, node.id)
        const timing = stage ? formatMs(stage.ms) : ran[step.index] ? "—" : "skipped"
        setLogs(prev => [...prev, `${node.service.padEnd(9)} ${node.title} · ${timing}`])
      }
      setStepIdx(i => i + 1)
    }, step.ms / speed)
    return () => clearTimeout(timer)
  }, [playing, done, stepIdx, schedule, speed, trace, ran])

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: "smooth" })
  }, [logs])

  // Esc closes; the page behind must not scroll while the canvas is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    document.addEventListener("keydown", onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = "hidden"
    return () => {
      document.removeEventListener("keydown", onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [onClose])

  const restart = useCallback(() => {
    setStepIdx(0)
    setLogs([])
    setPinnedId(null)
    setPlaying(true)
  }, [])

  const statusOf = useCallback(
    (index: number): NodeStatus => {
      const reached = done || index < completedNodes || index === activeNodeIndex
      if (!ran[index]) return reached ? "skipped" : "idle"
      if (done || index < completedNodes) return "done"
      if (index === activeNodeIndex) return "running"
      return "idle"
    },
    [ran, completedNodes, done, activeNodeIndex],
  )

  // The inspector follows the run unless the user pinned a node.
  const inspectedIndex = pinnedId
    ? NODES.findIndex(n => n.id === pinnedId)
    : done
      ? NODES.length - 1
      : Math.max(0, activeNodeIndex >= 0 ? activeNodeIndex : (current?.index ?? 0))
  const inspected = NODES[Math.max(0, inspectedIndex)]
  const inspectedStage = stageOf(trace, inspected.id)
  const inspectedStatus = statusOf(Math.max(0, inspectedIndex))
  const io = useMemo(() => buildNodeIO(inspected.id, trace), [inspected.id, trace])

  const overheadMs =
    trace.aiMs != null ? Math.max(0, Math.round(trace.clientMs - trace.aiMs)) : null

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-vez-navy/60 p-0 backdrop-blur-sm sm:p-4 md:p-6"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="AI answer pipeline"
    >
      <div
        className="flex h-dvh w-full flex-col overflow-hidden bg-white shadow-2xl sm:h-[88dvh] sm:max-w-7xl sm:rounded-3xl"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-vez-line px-4 py-3 sm:px-6 sm:py-4">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-vez-navy">
            <Workflow className="size-5 text-white" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base font-semibold text-vez-ink sm:text-lg">AI answer pipeline</h2>
              <span
                className={`rounded-md px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                  sample
                    ? "bg-amber-50 text-amber-700"
                    : "bg-emerald-50 text-emerald-700"
                }`}
              >
                {sample ? "Sample run" : "Live run"}
              </span>
            </div>
            <p className="mt-0.5 truncate text-xs text-vez-mute sm:text-sm">
              {sample
                ? "Ask a question, then reopen this to replay your own run"
                : `“${truncate(trace.question, 90)}”`}
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            <button
              onClick={() => setPlaying(p => !p)}
              disabled={done}
              aria-label={playing ? "Pause" : "Play"}
              className="flex size-9 items-center justify-center rounded-lg bg-vez-surface text-vez-navy transition-colors hover:bg-vez-sky/20 disabled:opacity-40"
            >
              {playing ? <Pause className="size-4" /> : <Play className="size-4" />}
            </button>
            <button
              onClick={restart}
              aria-label="Replay"
              className="flex size-9 items-center justify-center rounded-lg bg-vez-surface text-vez-navy transition-colors hover:bg-vez-sky/20"
            >
              <RotateCcw className="size-4" />
            </button>
            <div className="hidden items-center rounded-lg bg-vez-surface p-1 sm:flex">
              {[0.5, 1, 2].map(s => (
                <button
                  key={s}
                  onClick={() => setSpeed(s)}
                  className={`rounded-md px-2 py-1 text-xs font-medium transition-colors ${
                    speed === s ? "bg-vez-navy text-white" : "text-vez-mute hover:text-vez-navy"
                  }`}
                >
                  {s}×
                </button>
              ))}
            </div>
            <div className="hidden items-center rounded-lg bg-vez-surface p-1 md:flex">
              <button
                onClick={() => { setAutoZoom(false); setZoom(z => Math.max(0.42, z - 0.12)) }}
                aria-label="Zoom out"
                className="flex size-7 items-center justify-center rounded-md text-vez-mute hover:text-vez-navy"
              >
                <ZoomOut className="size-4" />
              </button>
              <button
                onClick={() => setAutoZoom(true)}
                className="px-1.5 text-[11px] font-medium tabular-nums text-vez-mute hover:text-vez-navy"
                title="Fit to width"
              >
                {Math.round(zoom * 100)}%
              </button>
              <button
                onClick={() => { setAutoZoom(false); setZoom(z => Math.min(1.4, z + 0.12)) }}
                aria-label="Zoom in"
                className="flex size-7 items-center justify-center rounded-md text-vez-mute hover:text-vez-navy"
              >
                <ZoomIn className="size-4" />
              </button>
            </div>
            <button
              onClick={onClose}
              aria-label="Close pipeline preview"
              className="flex size-9 items-center justify-center rounded-lg text-vez-mute transition-colors hover:bg-vez-surface hover:text-vez-ink"
            >
              <X className="size-5" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col lg:flex-row">
          {/* Canvas — a fixed slice of the screen on phones, the rest is the inspector */}
          <div
            ref={viewportRef}
            className="vz-flow-grid relative h-[42dvh] min-w-0 shrink-0 overflow-auto p-4 lg:h-auto lg:min-h-0 lg:flex-1"
          >
            <div
              className="relative mx-auto"
              style={{
                width: CANVAS_W * zoom,
                height: CANVAS_H * zoom,
              }}
            >
              <div
                className="absolute left-0 top-0 origin-top-left"
                style={{ width: CANVAS_W, height: CANVAS_H, transform: `scale(${zoom})` }}
              >
                {/* Wires */}
                <svg
                  width={CANVAS_W}
                  height={CANVAS_H}
                  className="pointer-events-none absolute inset-0"
                  aria-hidden="true"
                >
                  <defs>
                    <marker id="vz-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                      <path d="M 0 0 L 10 5 L 0 10 z" className="fill-vez-line" />
                    </marker>
                    <marker id="vz-arrow-live" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                      <path d="M 0 0 L 10 5 L 0 10 z" className="fill-emerald-500" />
                    </marker>
                  </defs>
                  {EDGES.map((e, i) => {
                    // Both step kinds share an index, so every edge before the
                    // current step has already been traversed.
                    const settled = done || (current != null && i < current.index)
                    const live = i === activeEdgeIndex
                    // A wire into or out of a stage that never ran stays grey.
                    const carried = (settled || live) && ran[i] && ran[i + 1]
                    return (
                      <g key={e.id}>
                        <path
                          d={e.d}
                          fill="none"
                          strokeWidth={2}
                          strokeLinecap="round"
                          className={carried ? "stroke-emerald-400/70" : "stroke-vez-line"}
                          markerEnd={carried ? "url(#vz-arrow-live)" : "url(#vz-arrow)"}
                        />
                        {live && carried && (
                          <path
                            d={e.d}
                            fill="none"
                            strokeWidth={2.5}
                            strokeLinecap="round"
                            strokeDasharray="7 9"
                            className="vz-flow-dash stroke-emerald-500"
                          />
                        )}
                      </g>
                    )
                  })}
                </svg>

                {/* Travelling packet on the wire currently in transit */}
                {activeEdgeIndex >= 0 && ran[activeEdgeIndex] && ran[activeEdgeIndex + 1] && !reducedMotion.current && (
                  <span
                    key={`packet-${activeEdgeIndex}-${stepIdx}`}
                    className="vz-flow-packet pointer-events-none absolute left-0 top-0 size-2.5 rounded-full bg-emerald-500 shadow-[0_0_0_4px_rgba(16,185,129,0.18)]"
                    style={{
                      offsetPath: `path("${EDGES[activeEdgeIndex].d}")`,
                      animationDuration: `${EDGE_MS / speed}ms`,
                    }}
                  />
                )}

                {/* Nodes */}
                {NODES.map((node, i) => {
                  const status = statusOf(i)
                  const stage = stageOf(trace, node.id)
                  const lane = LANE_STYLES[node.lane]
                  const Icon = node.icon
                  const isInspected = i === inspectedIndex
                  return (
                    <button
                      key={node.id}
                      type="button"
                      onClick={() => setPinnedId(prev => (prev === node.id ? null : node.id))}
                      style={{ left: node.x, top: node.y, width: NODE_W, height: NODE_H }}
                      className={`absolute flex flex-col justify-between rounded-2xl border bg-white p-3 text-left shadow-sm transition-all duration-300 ${
                        status === "running"
                          ? `border-emerald-400 shadow-lg ring-4 ${lane.ring} vz-flow-pulse`
                          : status === "done"
                            ? "border-emerald-200"
                            : status === "skipped"
                              ? "border-dashed border-vez-line bg-vez-surface/50 opacity-60"
                              : "border-vez-line/70 opacity-70"
                      } ${isInspected ? "outline outline-2 outline-offset-2 outline-vez-navy/25" : ""}`}
                    >
                      <div className="flex items-start gap-2">
                        <span className={`flex size-7 shrink-0 items-center justify-center rounded-lg ${lane.chip}`}>
                          <Icon className="size-4" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="line-clamp-2 block text-[12.5px] font-semibold leading-[1.2] text-vez-ink">
                            {node.title}
                          </span>
                          <span className={`mt-0.5 block text-[10px] font-semibold uppercase tracking-wide ${lane.label}`}>
                            {node.service}
                          </span>
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-1">
                        <span
                          className={`flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium ${
                            status === "running"
                              ? "bg-emerald-50 text-emerald-700"
                              : status === "done"
                                ? "bg-emerald-50/60 text-emerald-700"
                                : status === "skipped"
                                  ? "bg-vez-surface text-vez-mute"
                                  : "bg-vez-surface text-vez-mute/70"
                          }`}
                        >
                          {status === "running" && <span className="size-1.5 animate-pulse rounded-full bg-emerald-500" />}
                          {status === "done" && <Check className="size-3" />}
                          {status === "skipped" && <Minus className="size-3" />}
                          {status === "running" ? "running" : status === "done" ? "done" : status === "skipped" ? "skipped" : "idle"}
                        </span>
                        <span className="font-mono text-[10px] tabular-nums text-vez-mute">
                          {stage ? formatMs(stage.ms) : status === "skipped" ? "—" : "·"}
                        </span>
                      </div>
                    </button>
                  )
                })}
              </div>
            </div>
          </div>

          {/* Inspector */}
          <aside className="flex min-h-0 min-w-0 flex-1 flex-col border-t border-vez-line bg-white lg:w-[350px] lg:flex-none lg:border-l lg:border-t-0">
            <div className="shrink-0 border-b border-vez-line/70 px-4 py-3">
              <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-vez-mute/70">
                Node {inspectedIndex + 1} of {NODES.length}
              </p>
              <div className="mt-1 flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-vez-ink">{inspected.title}</p>
                  <p className={`text-[11px] font-semibold uppercase tracking-wide ${LANE_STYLES[inspected.lane].label}`}>
                    {inspected.service}
                  </p>
                </div>
                <span className="shrink-0 rounded-md bg-vez-surface px-2 py-1 font-mono text-[11px] tabular-nums text-vez-ink">
                  {inspectedStage ? formatMs(inspectedStage.ms) : "not timed"}
                </span>
              </div>
              {pinnedId && (
                <button
                  onClick={() => setPinnedId(null)}
                  className="mt-2 text-[11px] font-medium text-vez-navy underline underline-offset-2"
                >
                  Pinned — follow the run instead
                </button>
              )}
            </div>

            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
              <p className="rounded-xl bg-vez-sky/10 px-3 py-2.5 text-[12px] leading-relaxed text-vez-ink">
                {inspected.note}
              </p>

              {inspectedStatus === "skipped" ? (
                <p className="rounded-xl border border-dashed border-vez-line px-3 py-2.5 text-[12px] text-vez-mute">
                  This stage did not run for this question — the intent router answered it
                  directly, so retrieval was skipped.
                </p>
              ) : (
                <>
                  <JsonBlock label="Input" value={io.input} />
                  <JsonBlock label="Output" value={io.output} />
                </>
              )}
            </div>

            {/* Execution log */}
            <div className="shrink-0 border-t border-vez-line/70">
              <div className="flex items-center justify-between px-4 py-2">
                <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-vez-mute/70">
                  Execution log
                </p>
                <span className="flex items-center gap-1 text-[11px] text-vez-mute">
                  <Clock className="size-3" />
                  {done ? "finished" : playing ? "running" : "paused"}
                </span>
              </div>
              <div
                ref={logRef}
                className="h-24 overflow-y-auto bg-vez-navy px-4 py-2 font-mono text-[10.5px] leading-relaxed text-vez-sky/90"
              >
                {logs.length === 0 ? (
                  <p className="text-vez-sky/40">waiting for the first node…</p>
                ) : (
                  logs.map((l, i) => (
                    <p key={i} className="whitespace-pre">
                      <span className="text-emerald-400">✓</span> {l}
                    </p>
                  ))
                )}
                {done && (
                  <p className="mt-1 text-emerald-400">
                    ✓ run finished in {formatMs(trace.clientMs)}
                  </p>
                )}
              </div>
            </div>
          </aside>
        </div>

        {/* Footer summary */}
        <div className="flex min-w-0 shrink-0 flex-wrap items-center gap-x-4 gap-y-1.5 overflow-hidden border-t border-vez-line bg-vez-surface/50 px-4 py-2.5 text-[11px] text-vez-mute sm:px-6">
          <Stat label="Round trip" value={formatMs(trace.clientMs)} />
          <Stat label="AI service" value={trace.aiMs != null ? formatMs(trace.aiMs) : "—"} />
          {overheadMs != null && <Stat label="API + network" value={formatMs(overheadMs)} />}
          <Stat label="Retrieval" value={trace.searchMode ?? "skipped"} />
          <Stat label="Model" value={trace.modelUsed ?? "none"} />
          <Stat label="Sources" value={String(trace.sources.length)} />
          <span className="ml-auto hidden text-vez-mute/70 sm:inline">
            Timings are real; playback is paced for readability.
          </span>
        </div>
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex items-center gap-1.5 whitespace-nowrap">
      <span className="uppercase tracking-wide text-vez-mute/60">{label}</span>
      <span className="font-mono font-medium tabular-nums text-vez-ink">{value}</span>
    </span>
  )
}
