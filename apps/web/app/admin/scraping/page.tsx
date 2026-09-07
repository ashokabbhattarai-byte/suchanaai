"use client"

import React, { useEffect, useState, useCallback, useRef, Suspense } from "react"
import { useRouter, usePathname, useSearchParams } from "next/navigation"
import {
  Play,
  Plus,
  AlertCircle,
  CheckCircle,
  XCircle,
  Clock,
  Terminal,
  Globe,
  Activity,
  Trash2,
  Edit,
  Loader2,
  X,
  Ban,
  PlayCircle,
  ChevronDown,
  ChevronUp,
  ChevronRight,
  Timer,
  Link2,
  Radar,
  Search,
  Zap,
  Rocket,
  ChevronLeft,
  RefreshCw,
  History,
  ExternalLink,
  Layers,
  Stethoscope,
  Compass,
} from "lucide-react"
import { AdminLayout } from "@/components/admin/admin-layout"
import { SourceDiagnosis } from "@/components/admin/source-diagnosis"
import { Header } from "@/components/layout/header"
import {
  fetchScrapeSources,
  createScrapeSource,
  updateScrapeSource,
  deleteScrapeSource,
  runScrapeSource,
  fetchScrapeRuns,
  fetchScrapeRunProgress,
  retryScrapeRun,
  detectScrapeSitemap,
  checkScrapeSitemap,
  fetchSchedulerStatus,
  setAutoScraping,
  runAllScrapeSources,
  quickScrapeUrl,
  discoverScrapeRoutes,
  diagnoseScrapeSource,
} from "@/lib/api"
import { getStoredJSON, setStoredJSON } from "@/lib/local-store"
import { toast } from "sonner"
import type {
  ScrapeSource,
  ScrapeRun,
  ScrapeRunStatus,
  ScrapePaginationType,
  ScrapeRunProgress,
  SchedulerStatus,
  SitemapCheckResult,
  ScrapeDiagnosis,
  RouteDiscoveryResult,
} from "@/lib/types"

interface SourceFormState {
  id?: string
  name: string
  baseUrl: string
  noticeListUrl: string
  newsListUrl: string
  pressReleaseListUrl: string
  paginationType: ScrapePaginationType
  paginationParam: string
  startPage: number
  maxPages: number
  pollIntervalSeconds: number
  sitemapUrl: string
}

const emptyForm: SourceFormState = {
  name: "",
  baseUrl: "",
  noticeListUrl: "",
  newsListUrl: "",
  pressReleaseListUrl: "",
  paginationType: "QUERY_PARAM",
  paginationParam: "page",
  startPage: 1,
  maxPages: 3,
  pollIntervalSeconds: 900,
  sitemapUrl: "",
}

const PROGRESS_POLL_MS = 1200

const TAB_PREFS_KEY = "pnm_admin_scraping_tab"
const QUICK_HISTORY_KEY = "pnm_admin_quick_scrape_history"
const QUICK_HISTORY_LIMIT = 15

interface QuickScrapeItem {
  id: string
  url: string
  status: "queued" | "scraping" | "exists" | "done" | "error"
  detail?: string
  // Set once the notice is known to exist in the catalogue (fresh save or a
  // prior duplicate) — lets the row link straight to it.
  itemId?: string
  title?: string
}

interface QuickScrapeHistoryEntry {
  url: string
  status: "exists" | "done" | "error"
  detail: string
  at: string
  itemId?: string
  title?: string
}

/** Preset poll intervals shown as one-click chips in the source dialog. */
const POLL_PRESETS = [
  { seconds: 60, label: "1 min" },
  { seconds: 180, label: "3 min" },
  { seconds: 900, label: "15 min" },
  { seconds: 1800, label: "30 min" },
  { seconds: 3600, label: "1 h" },
  { seconds: 21600, label: "6 h" },
  { seconds: 86400, label: "24 h" },
]

/** Human-friendly rendering of a seconds-based interval. */
function formatInterval(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h`
  return `${Math.round(hours / 24)} d`
}

/** When the scheduler will next probe this source (or null if unknown). */
function nextPollAt(source: ScrapeSource): Date | null {
  if (!source.enabled || !source.lastRunAt) return null
  return new Date(new Date(source.lastRunAt).getTime() + source.pollIntervalSeconds * 1000)
}

/** Human-friendly run duration, e.g. "2m 14s", "48s", "312 ms". */
function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—"
  if (ms < 1000) return `${Math.round(ms)} ms`
  const totalSeconds = Math.round(ms / 1000)
  if (totalSeconds < 60) return `${totalSeconds}s`
  const m = Math.floor(totalSeconds / 60)
  const s = totalSeconds % 60
  return s > 0 ? `${m}m ${s}s` : `${m}m`
}

/**
 * Pagination page window: keeps the first/last page visible and shows up to
 * three pages around the current one, with ellipses for the gaps.
 */
function pageWindow(current: number, total: number): (number | "…")[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1)
  const pages: (number | "…")[] = [1]
  const start = Math.max(2, current - 1)
  const end = Math.min(total - 1, current + 1)
  if (start > 2) pages.push("…")
  for (let p = start; p <= end; p++) pages.push(p)
  if (end < total - 1) pages.push("…")
  pages.push(total)
  return pages
}

/** Small inline trend line for a source's recent run item-counts. */
function MiniSparkline({ data }: { data: number[] }) {
  if (data.length < 2) return null
  const max = Math.max(...data, 1)
  const min = Math.min(...data, 0)
  const range = max - min || 1
  const width = 64
  const height = 20
  const points = data
    .map((v, i) => {
      const x = (i / (data.length - 1)) * width
      const y = height - ((v - min) / range) * height
      return `${x},${y}`
    })
    .join(" ")

  return (
    <svg width={width} height={height} className="shrink-0">
      <polyline
        fill="none"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        points={points}
        stroke="#a2c5d3"
      />
    </svg>
  )
}

function AdminScrapingPageContent() {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const didMountSync = useRef(false)

  const [activeTab, setActiveTabState] = useState<"sources" | "logs">(
    () =>
      (searchParams.get("tab") as "sources" | "logs" | null) ??
      getStoredJSON(TAB_PREFS_KEY, { tab: "sources" as const }).tab,
  )

  // Re-sync from the URL on back/forward, and push tab changes to the URL
  // (no new history entry) so the selected tab survives navigating away
  // and back (e.g. opening a source's site in a new tab). Skipped on the
  // very first run so it doesn't stomp a tab restored from localStorage
  // before the URL reflects it.
  const searchParamsString = searchParams.toString()
  useEffect(() => {
    if (!didMountSync.current) {
      didMountSync.current = true
      return
    }
    setActiveTabState((searchParams.get("tab") as "sources" | "logs" | null) ?? "sources")
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParamsString])

  useEffect(() => {
    setStoredJSON(TAB_PREFS_KEY, { tab: activeTab })
  }, [activeTab])

  function setActiveTab(tab: "sources" | "logs") {
    setActiveTabState(tab)
    router.replace(tab === "sources" ? pathname : `${pathname}?tab=${tab}`, { scroll: false })
    if (tab === "logs") void loadLogs()
  }

  function clearLogFilters() {
    setLogSourceFilter("")
    setLogStatusFilter("")
    setLogPage(1)
  }

  const [sources, setSources] = useState<ScrapeSource[]>([])
  const [runs, setRuns] = useState<ScrapeRun[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [runningIds, setRunningIds] = useState<Set<string>>(new Set())
  const [progressBySource, setProgressBySource] = useState<Record<string, ScrapeRunProgress>>({})
  // sourceId -> stop function for its progress poller.
  const pollTimers = useRef<Record<string, () => void>>({})

  const [dialogOpen, setDialogOpen] = useState(false)
  const [form, setForm] = useState<SourceFormState>(emptyForm)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [scheduler, setScheduler] = useState<SchedulerStatus | null>(null)
  // Sitemap tooling state (edit mode only — detection needs a saved source).
  const [detectingSitemap, setDetectingSitemap] = useState(false)
  const [checkingSitemap, setCheckingSitemap] = useState(false)
  const [sitemapNotice, setSitemapNotice] = useState<{ tone: "ok" | "info" | "error"; text: string } | null>(null)
  const [checkResult, setCheckResult] = useState<SitemapCheckResult | null>(null)
  // Listing-URL auto-detection, in the add/edit dialog.
  const [discovering, setDiscovering] = useState(false)
  const [discovery, setDiscovery] = useState<RouteDiscoveryResult | null>(null)
  // Per-source diagnosis state: which source is being re-diagnosed, which
  // diagnosis fix is being applied, and which panels are expanded.
  const [diagnosingId, setDiagnosingId] = useState<string | null>(null)
  const [applyingFix, setApplyingFix] = useState<string | null>(null)
  // Global controls state.
  const [runningAll, setRunningAll] = useState(false)
  const [togglingAuto, setTogglingAuto] = useState(false)
  const [runAllNotice, setRunAllNotice] = useState<{ tone: "ok" | "info" | "error"; text: string } | null>(null)
  // Admin "paste a link" quick-scrape — ingest one or more notice/news/
  // press-release URLs directly, no source pre-configuration required.
  const [quickUrlsText, setQuickUrlsText] = useState("")
  const [quickBatchRunning, setQuickBatchRunning] = useState(false)
  const [quickNotice, setQuickNotice] = useState<{ tone: "ok" | "info" | "error"; text: string } | null>(null)
  const [quickItems, setQuickItems] = useState<QuickScrapeItem[]>([])
  const [quickHistory, setQuickHistory] = useState<QuickScrapeHistoryEntry[]>(
    () => getStoredJSON(QUICK_HISTORY_KEY, { items: [] as QuickScrapeHistoryEntry[] }).items,
  )
  const [quickHistoryOpen, setQuickHistoryOpen] = useState(false)
  const [quickDialogOpen, setQuickDialogOpen] = useState(false)

  useEffect(() => {
    setStoredJSON(QUICK_HISTORY_KEY, { items: quickHistory })
  }, [quickHistory])

  /** Cap + prepend a quick-scrape outcome to the persisted recent-history list. */
  function pushQuickHistory(entry: Omit<QuickScrapeHistoryEntry, "at">) {
    setQuickHistory((prev) => [{ ...entry, at: new Date().toISOString() }, ...prev].slice(0, QUICK_HISTORY_LIMIT))
  }

  // Logs tab — server-side paginated run history.
  const [logRuns, setLogRuns] = useState<ScrapeRun[]>([])
  const [logMeta, setLogMeta] = useState({ page: 1, limit: 20, total: 0, totalPages: 1 })
  const [logPage, setLogPage] = useState(1)
  const [logLimit, setLogLimit] = useState(20)
  const [logSourceFilter, setLogSourceFilter] = useState("")
  const [logStatusFilter, setLogStatusFilter] = useState<"" | ScrapeRunStatus>("")
  const [logLoading, setLogLoading] = useState(false)
  const [logError, setLogError] = useState<string | null>(null)
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null)
  const [retryingRunId, setRetryingRunId] = useState<string | null>(null)
  // Whether any run on the current page is still RUNNING — drives the live
  // auto-refresh of the logs table without spamming the API when idle.
  const hasLiveRunsRef = useRef(false)

  const loadAll = useCallback(async () => {
    try {
      const [sourcesData, runsData, schedulerData] = await Promise.allSettled([
        fetchScrapeSources(),
        fetchScrapeRuns({ limit: 30 }),
        fetchSchedulerStatus(),
      ])
      if (sourcesData.status === "fulfilled") setSources(sourcesData.value)
      if (runsData.status === "fulfilled") setRuns(runsData.value.data ?? runsData.value)
      if (schedulerData.status === "fulfilled") setScheduler(schedulerData.value)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load scraping data")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadAll()
  }, [loadAll])

  /** Load the current page of run logs (silent = keep the table on screen). */
  const loadLogs = useCallback(async (silent = false) => {
    if (!silent) setLogLoading(true)
    try {
      const res = await fetchScrapeRuns({
        page: logPage,
        limit: logLimit,
        sourceId: logSourceFilter || undefined,
        status: logStatusFilter || undefined,
      })
      setLogRuns(res.data ?? [])
      setLogMeta(res.meta ?? { page: logPage, limit: logLimit, total: 0, totalPages: 1 })
      setLogError(null)
      hasLiveRunsRef.current = (res.data ?? []).some((r) => r.status === "RUNNING")
    } catch (err) {
      setLogError(err instanceof Error ? err.message : "Failed to load run logs")
    } finally {
      if (!silent) setLogLoading(false)
    }
  }, [logPage, logLimit, logSourceFilter, logStatusFilter])

  useEffect(() => {
    void loadLogs()
  }, [loadLogs])

  // When filters shrink the result set past the current page, back up to a
  // valid page instead of showing an empty table.
  useEffect(() => {
    if (logPage > logMeta.totalPages && logMeta.totalPages > 0) {
      setLogPage(Math.max(1, logMeta.totalPages))
    }
  }, [logMeta.totalPages, logPage])

  // Live refresh: while anything is scraping and the Logs tab is open, silently
  // re-fetch the current page so RUNNING rows resolve into their final status.
  // Self-scheduling (not setInterval) so a slow response can't queue a second
  // request, and paused while the tab is hidden — nobody is reading it.
  useEffect(() => {
    if (activeTab !== "logs") return
    if (!(runningIds.size > 0 || runningAll || hasLiveRunsRef.current)) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>

    const tick = async () => {
      if (!document.hidden) await loadLogs(true)
      if (!cancelled) timer = setTimeout(tick, 4000)
    }

    timer = setTimeout(tick, 4000)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [activeTab, runningIds, runningAll, loadLogs])

  useEffect(() => {
    // Stop all pollers on unmount.
    const timers = pollTimers.current
    return () => {
      Object.values(timers).forEach((stop) => stop())
    }
  }, [])

  function openCreateDialog() {
    setForm(emptyForm)
    setShowAdvanced(false)
    setFormError(null)
    setSitemapNotice(null)
    setCheckResult(null)
    setDiscovery(null)
    setDialogOpen(true)
  }

  function openEditDialog(source: ScrapeSource) {
    setForm({
      id: source.id,
      name: source.name,
      baseUrl: source.baseUrl,
      noticeListUrl: source.noticeListUrl ?? "",
      newsListUrl: source.newsListUrl ?? "",
      pressReleaseListUrl: source.pressReleaseListUrl ?? "",
      paginationType: source.paginationType,
      paginationParam: source.paginationParam,
      startPage: source.startPage,
      maxPages: source.maxPages,
      pollIntervalSeconds: source.pollIntervalSeconds,
      sitemapUrl: source.sitemapUrl ?? "",
    })
    setShowAdvanced(source.paginationType !== "QUERY_PARAM" || source.startPage !== 1 || source.maxPages !== 3)
    setFormError(null)
    setSitemapNotice(null)
    setCheckResult(null)
    setDiscovery(null)
    setDialogOpen(true)
  }

  /** One-time sitemap detection, persisted on the source. Edit mode only. */
  async function handleDetectSitemap() {
    if (!form.id) return
    setDetectingSitemap(true)
    setSitemapNotice(null)
    try {
      const updated = await detectScrapeSitemap(form.id)
      setForm((prev) => ({ ...prev, sitemapUrl: updated.sitemapUrl ?? "" }))
      setSitemapNotice(
        updated.sitemapUrl
          ? { tone: "ok", text: `Sitemap found and cached: ${updated.sitemapUrl}` }
          : {
              tone: "info",
              text: "No usable sitemap found — this source will use HTML polling on its interval.",
            },
      )
    } catch (err) {
      setSitemapNotice({
        tone: "error",
        text: err instanceof Error ? err.message : "Sitemap detection failed",
      })
    } finally {
      setDetectingSitemap(false)
    }
  }

  /**
   * Auto-detect this site's listing URLs from its own navigation. Works
   * before the source is saved — it only needs the base URL — so it is the
   * intended way to fill the form rather than browsing the site by hand.
   */
  async function handleDiscoverRoutes() {
    const baseUrl = form.baseUrl.trim()
    if (!baseUrl) {
      setFormError("Enter the site's base URL first")
      return
    }
    setDiscovering(true)
    setDiscovery(null)
    setFormError(null)
    try {
      const result = await discoverScrapeRoutes(baseUrl)
      setDiscovery(result)
      // Only fill fields the admin left empty — never overwrite a URL they
      // typed themselves.
      setForm((prev) => ({
        ...prev,
        noticeListUrl: prev.noticeListUrl || result.best.NOTICE || "",
        newsListUrl: prev.newsListUrl || result.best.NEWS || "",
        pressReleaseListUrl: prev.pressReleaseListUrl || result.best.PRESS_RELEASE || "",
      }))
      const found = Object.keys(result.best).length
      if (found) toast.success(`Found ${found} listing URL(s)`)
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "URL detection failed")
    } finally {
      setDiscovering(false)
    }
  }

  /** Re-run failure analysis for one source, on demand. */
  async function handleDiagnose(id: string) {
    setDiagnosingId(id)
    try {
      await diagnoseScrapeSource(id)
      await loadAll()
      toast.success("Diagnosis updated")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Diagnosis failed")
    } finally {
      setDiagnosingId(null)
    }
  }

  /** Apply a diagnosis's suggested settings change to the source. */
  async function handleApplyFix(source: ScrapeSource, diagnosis: ScrapeDiagnosis) {
    const summary = Object.entries(diagnosis.patch)
      .map(([field, value]) => `  ${field} → ${value}`)
      .join("\n")
    if (!window.confirm(`Apply this fix to "${source.name}"?\n\n${summary}`)) return

    setApplyingFix(`${source.id}:${diagnosis.code}`)
    try {
      await updateScrapeSource(source.id, diagnosis.patch as Record<string, never>)
      toast.success("Fix applied — run the source to confirm it works")
      await loadAll()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not apply the fix")
    } finally {
      setApplyingFix(null)
    }
  }

  /** Cheap poll: sitemap URLs not yet known to this source. */
  async function handleCheckSitemap() {
    if (!form.id) return
    setCheckingSitemap(true)
    setSitemapNotice(null)
    try {
      const result = await checkScrapeSitemap(form.id)
      setCheckResult(result)
      setSitemapNotice({
        tone: result.new_urls.length > 0 ? "info" : "ok",
        text:
          result.new_urls.length > 0
            ? `${result.new_urls.length} new URL(s) of ${result.total_locs} in the sitemap — a full crawl will pick them up.`
            : `All ${result.total_locs} sitemap URL(s) are already scraped.`,
      })
    } catch (err) {
      setSitemapNotice({
        tone: "error",
        text: err instanceof Error ? err.message : "Sitemap check failed",
      })
    } finally {
      setCheckingSitemap(false)
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!form.noticeListUrl && !form.newsListUrl && !form.pressReleaseListUrl) {
      setFormError("Provide at least one listing URL (notice, news, or press release)")
      return
    }
    setSaving(true)
    setFormError(null)
    try {
      const payload = {
        name: form.name,
        baseUrl: form.baseUrl,
        noticeListUrl: form.noticeListUrl || undefined,
        newsListUrl: form.newsListUrl || undefined,
        pressReleaseListUrl: form.pressReleaseListUrl || undefined,
        paginationType: form.paginationType,
        paginationParam: form.paginationParam || "page",
        startPage: form.startPage,
        maxPages: form.maxPages,
        pollIntervalSeconds: Math.max(60, form.pollIntervalSeconds),
        sitemapUrl: form.sitemapUrl.trim() || null,
      }
      if (form.id) {
        await updateScrapeSource(form.id, payload)
      } else {
        await createScrapeSource(payload)
      }
      toast.success(form.id ? "Source updated" : "Source added")
      setDialogOpen(false)
      await loadAll()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Failed to save source")
    } finally {
      setSaving(false)
    }
  }

  function stopPolling(sourceId: string) {
    const stop = pollTimers.current[sourceId]
    if (stop) {
      stop()
      delete pollTimers.current[sourceId]
    }
  }

  /**
   * Poll one run's progress. The next request is scheduled only after the
   * previous one settles — with setInterval, a slow API meant every tick
   * queued another request, and when the backlog finally drained each of them
   * saw "done" and fired its own full reload.
   */
  function pollProgress(
    sourceId: string,
    runId: string,
    onDone?: (stage: "done" | "failed") => void,
  ) {
    stopPolling(sourceId)
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>

    const tick = async () => {
      try {
        const progress = await fetchScrapeRunProgress(runId)
        if (cancelled) return
        setProgressBySource((prev) => ({ ...prev, [sourceId]: progress }))
        if (progress.stage === "done" || progress.stage === "failed") {
          stopPolling(sourceId)
          setRunningIds((prev) => {
            const next = new Set(prev)
            next.delete(sourceId)
            return next
          })
          await loadAll()
          onDone?.(progress.stage)
          return
        }
      } catch {
        // Transient poll failure — keep trying until polling is stopped.
      }
      if (!cancelled) timer = setTimeout(tick, PROGRESS_POLL_MS)
    }

    pollTimers.current[sourceId] = () => {
      cancelled = true
      clearTimeout(timer)
    }
    timer = setTimeout(tick, PROGRESS_POLL_MS)
  }

  /** `deep` walks every page of every listing instead of the newest few. */
  async function handleRun(id: string, deep = false) {
    setRunningIds((prev) => new Set(prev).add(id))
    setProgressBySource((prev) => ({ ...prev, [id]: { run_id: "", stage: "running", messages: [], error: null } }))
    setError(null)
    try {
      const { runId } = await runScrapeSource(id, undefined, deep)
      if (deep) toast.success("Deep scrape started — walking every listing page")
      pollProgress(id, runId)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Scrape run failed")
      setRunningIds((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    }
  }

  /** Retry a specific run (e.g. FAILED) directly from the Logs tab. */
  async function handleRetryRun(run: ScrapeRun) {
    setRetryingRunId(run.id)
    try {
      const { runId } = await retryScrapeRun(run.id)
      toast.success("Retry started")
      if (run.sourceId) pollProgress(run.sourceId, runId)
      await loadLogs(true)
      await loadAll()
    } catch (err) {
      setLogError(err instanceof Error ? err.message : "Retry failed")
    } finally {
      setRetryingRunId(null)
    }
  }

  async function handleToggleEnabled(source: ScrapeSource) {
    try {
      await updateScrapeSource(source.id, { enabled: !source.enabled })
      toast.success(source.enabled ? "Source disabled" : "Source enabled")
      await loadAll()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update source")
    }
  }

  /** Bulk trigger: one run for every enabled source that isn't already scraping. */
  async function handleRunAll(deep = false) {
    if (runningAll) return
    setRunningAll(true)
    setRunAllNotice(null)
    setError(null)
    try {
      const result = await runAllScrapeSources(deep)
      const scheduled = result.results.filter((r) => r.status === "scheduled")
      for (const r of scheduled) {
        const runId = r.runId
        if (!runId) continue
        setRunningIds((prev) => new Set(prev).add(r.sourceId))
        setProgressBySource((prev) => ({
          ...prev,
          [r.sourceId]: { run_id: runId, stage: "running", messages: [], error: null },
        }))
        pollProgress(r.sourceId, runId)
      }
      const disabled = result.results.filter((r) => r.status === "disabled").length
      const alreadyRunning = result.results.filter((r) => r.status === "already-running").length
      setRunAllNotice({
        tone: result.scheduled > 0 ? "ok" : "info",
        text:
          result.scheduled > 0
            ? `Started ${result.scheduled} ${deep ? "deep " : ""}scrape run(s).${deep ? " Every listing page will be walked — this takes far longer than a normal run." : ""}${disabled > 0 || alreadyRunning > 0 ? ` Skipped: ${disabled} disabled, ${alreadyRunning} already running.` : ""}`
            : `Nothing to run — ${disabled} disabled, ${alreadyRunning} already running.`,
      })
      await loadAll()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Bulk run failed")
    } finally {
      setRunningAll(false)
    }
  }

  /**
   * Admin "paste a link" quick-scrape: ingest one or more arbitrary
   * notice/news/press-release URLs (one per line) directly. No source needs
   * to be configured first — the API reuses a matching source for each
   * domain or auto-creates a minimal one, then crawls just that URL as a
   * detail page. Requests are sent one at a time (not their crawls, which
   * run in the background) so two links on the same domain don't collide
   * with the API's per-source "already running" lock.
   */
  async function handleQuickScrape(e: React.FormEvent) {
    e.preventDefault()
    if (quickBatchRunning) return

    const seen = new Set<string>()
    const validUrls: string[] = []
    for (const line of quickUrlsText.split("\n").map((l) => l.trim()).filter(Boolean)) {
      if (seen.has(line)) continue
      seen.add(line)
      try {
        const parsed = new URL(line)
        if (parsed.protocol === "http:" || parsed.protocol === "https:") validUrls.push(line)
      } catch {
        // not a valid absolute URL — skip it
      }
    }
    if (validUrls.length === 0) {
      setQuickNotice({ tone: "error", text: "Paste at least one valid http(s) link, one per line." })
      return
    }

    const items: QuickScrapeItem[] = validUrls.map((url, i) => ({
      id: `${Date.now()}-${i}`,
      url,
      status: "queued",
    }))
    setQuickItems(items)
    setQuickNotice(null)
    setQuickBatchRunning(true)

    const setItemStatus = (id: string, patch: Partial<QuickScrapeItem>) =>
      setQuickItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...patch } : it)))

    for (const item of items) {
      setItemStatus(item.id, { status: "scraping" })
      try {
        const result = await quickScrapeUrl(item.url)
        if (result.alreadyExists) {
          const detail = `Already in the catalogue: "${result.item.title}"`
          const patch = { status: "exists" as const, detail, itemId: result.item.id, title: result.item.title }
          setItemStatus(item.id, patch)
          pushQuickHistory({ url: item.url, ...patch })
        } else {
          setItemStatus(item.id, {
            detail: result.sourceCreated ? "New source created for this domain — crawling…" : "Crawling…",
          })
          setRunningIds((prev) => new Set(prev).add(result.sourceId))
          setProgressBySource((prev) => ({
            ...prev,
            [result.sourceId]: { run_id: result.runId, stage: "running", messages: [], error: null },
          }))
          pollProgress(result.sourceId, result.runId, async (stage) => {
            if (stage !== "done") {
              const detail = "Scrape failed — see Logs for details"
              setItemStatus(item.id, { status: "error", detail })
              pushQuickHistory({ url: item.url, status: "error", detail })
              return
            }
            // The run just persisted this URL — re-check resolves the saved
            // notice's id/title so the row can link straight to it.
            let itemId: string | undefined
            let title: string | undefined
            try {
              const check = await quickScrapeUrl(item.url)
              if (check.alreadyExists) {
                itemId = check.item.id
                title = check.item.title
              }
            } catch {
              // best-effort — chip still shows "done" without a deep link
            }
            const detail = "Scraped and saved"
            setItemStatus(item.id, { status: "done", detail, itemId, title })
            pushQuickHistory({ url: item.url, status: "done", detail, itemId, title })
          })
        }
      } catch (err) {
        const detail = err instanceof Error ? err.message : "Failed to scrape that link"
        setItemStatus(item.id, { status: "error", detail })
        pushQuickHistory({ url: item.url, status: "error", detail })
      }
    }

    setQuickUrlsText("")
    setQuickBatchRunning(false)
    await loadAll()
  }

  /** Global auto-scraping on/off — persisted, manual "Run now" unaffected. */
  async function handleToggleAutoScraping() {
    if (togglingAuto) return
    setTogglingAuto(true)
    setError(null)
    try {
      const status = await setAutoScraping(!(scheduler?.autoScraping ?? true))
      setScheduler(status)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update auto-scraping")
    } finally {
      setTogglingAuto(false)
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("Delete this source? Its scraped items and run history will also be removed.")) return
    try {
      await deleteScrapeSource(id)
      toast.success("Source deleted")
      await loadAll()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete source")
    }
  }

  const activeSources = sources.filter((s) => s.enabled).length
  const totalItems = sources.reduce((sum, s) => sum + s.itemCount, 0)
  const erroredSources = sources.filter((s) => s.lastStatus === "FAILED").length
  const autoScraping = scheduler?.autoScraping ?? true

  return (
    <div className="min-h-screen bg-white font-poppins">
      <Header />
      <AdminLayout>
        <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-[clamp(28px,3vw,40px)] font-normal leading-tight tracking-[-0.03em] text-vez-ink">
              Web scraping.
            </h1>
            <p className="mt-2 text-sm text-vez-mute">
              Add any government or public website — notice/news listings are detected and scraped automatically
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              onClick={() => {
                setQuickNotice(null)
                setQuickDialogOpen(true)
              }}
              className="flex items-center gap-2 rounded-full border border-vez-line px-5 py-2.5 text-sm text-vez-ink transition-colors hover:bg-vez-surface"
            >
              <Link2 className="size-4" /> Scrape a link
            </button>
            <button
              onClick={openCreateDialog}
              className="flex items-center gap-2 rounded-full bg-vez-navy px-5 py-2.5 text-sm text-white transition-opacity hover:opacity-90"
            >
              <Plus className="size-4" /> Add source
            </button>
          </div>
        </div>

        {error && (
          <div className="mb-6 flex items-center gap-2 rounded-[14px] bg-red-50 px-4 py-3 text-sm text-red-600">
            <AlertCircle className="size-4 shrink-0" /> {error}
          </div>
        )}

        {/* Global controls: run-all + auto-scraping switch */}
        <div className="mb-6 flex flex-wrap items-center justify-between gap-4 rounded-[20px] bg-white p-5">
          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={() => handleRunAll(false)}
              disabled={runningAll || activeSources === 0}
              className="flex items-center gap-2 rounded-full bg-vez-navy px-6 py-2.5 text-sm text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              title={activeSources === 0 ? "No enabled sources to run" : "Run every enabled source once"}
            >
              {runningAll ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Rocket className="size-4" />
              )}
              {runningAll ? "Starting runs…" : "Run all sources"}
            </button>
            <button
              onClick={() => {
                if (
                  window.confirm(
                    "Deep scrape every enabled source?\n\nEach source's listings are walked page by page to the end of the archive, not just the newest few. This can take an hour and makes far more requests to each site.",
                  )
                ) {
                  void handleRunAll(true)
                }
              }}
              disabled={runningAll || activeSources === 0}
              className="flex items-center gap-2 rounded-full border border-vez-line px-5 py-2.5 text-sm text-vez-navy transition-colors hover:bg-vez-surface disabled:cursor-not-allowed disabled:opacity-50"
              title="Walk every listing page of every enabled source (full archive backfill)"
            >
              <Layers className="size-4" /> Deep scrape all
            </button>
            <span className="text-xs text-vez-mute">
              {activeSources} enabled
              {runningIds.size > 0 && (
                <>
                  {" · "}
                  <span className="text-vez-navy">{runningIds.size} running</span>
                </>
              )}
            </span>
          </div>

          <div className="flex items-center gap-3">
            <span className="text-xs text-vez-mute">Auto-scraping</span>
            <button
              role="switch"
              aria-checked={autoScraping}
              aria-label="Toggle automatic scraping"
              onClick={handleToggleAutoScraping}
              disabled={togglingAuto}
              className={`relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                autoScraping ? "bg-vez-navy" : "bg-vez-line"
              }`}
            >
              <span
                className={`absolute left-0.5 top-0.5 size-5 rounded-full bg-white shadow transition-transform ${
                  autoScraping ? "translate-x-5" : ""
                }`}
              />
            </button>
          </div>

          {runAllNotice && (
            <p
              className={`w-full text-xs ${
                runAllNotice.tone === "error" ? "text-red-600" : runAllNotice.tone === "ok" ? "text-vez-ink" : "text-vez-mute"
              }`}
            >
              {runAllNotice.text}
            </p>
          )}
        </div>

        {/* Scheduler status banner */}
        {scheduler && (
          <div
            className={`mb-6 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-[14px] px-4 py-3 text-xs text-vez-mute ${
              autoScraping ? "bg-vez-navy/[0.04]" : "bg-vez-line/40"
            }`}
          >
            <span className="flex items-center gap-1.5">
              {autoScraping ? (
                <>
                  <Zap className="size-3.5 text-vez-navy" />
                  <span className="font-medium text-vez-ink">Auto-polling on</span>
                </>
              ) : (
                <>
                  <Ban className="size-3.5" />
                  <span className="font-medium text-vez-ink">Auto-polling paused</span>
                </>
              )}
              {" — cron"}
              <code className="rounded bg-white px-1.5 py-0.5 font-mono">{scheduler.cron}</code>
            </span>
            <span>
              {scheduler.concurrency} concurrent crawl{scheduler.concurrency === 1 ? "" : "s"}
            </span>
            <span>min interval {scheduler.minPollIntervalSeconds}s</span>
            <span>stale-run timeout {Math.round(scheduler.staleRunTimeoutSeconds / 60)} min</span>
            {!autoScraping && (
              <span className="font-medium text-vez-ink">manual runs only</span>
            )}
            {scheduler.lastTickAt && (
              <span className="ml-auto">
                last tick {new Date(scheduler.lastTickAt).toLocaleTimeString()} ·{" "}
                {scheduler.lastDueCount} source(s) due
              </span>
            )}
          </div>
        )}

        {/* Stats row */}
        <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">
          {[
            { label: "Active sources", value: activeSources, icon: Globe },
            { label: "Total sources", value: sources.length, icon: Terminal },
            { label: "Scraped items", value: totalItems.toLocaleString(), icon: Activity },
            { label: "Errors", value: erroredSources, icon: AlertCircle },
          ].map((stat, i) => {
            const Icon = stat.icon
            return (
              <div key={i} className="flex items-center gap-3.5 rounded-[16px] bg-white p-5">
                <div className="flex size-10 items-center justify-center rounded-full bg-vez-sky/30">
                  <Icon className="size-4 text-vez-navy" />
                </div>
                <div>
                  <p className="text-xl text-vez-ink tabular-nums">{stat.value}</p>
                  <p className="text-xs text-vez-mute">{stat.label}</p>
                </div>
              </div>
            )
          })}
        </div>

        {/* Tabs - pill style */}
        <div className="mb-6 flex w-fit items-center gap-1 rounded-full bg-white p-1.5">
          {[
            { id: "sources" as const, label: "Sources", icon: Globe },
            { id: "logs" as const, label: "Logs", icon: Terminal },
          ].map((tab) => {
            const Icon = tab.icon
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-2 rounded-full px-4 py-2 text-sm transition-colors ${
                  activeTab === tab.id ? "bg-vez-navy text-white" : "text-vez-mute hover:text-vez-navy"
                }`}
              >
                <Icon className="size-4" />
                {tab.label}
              </button>
            )
          })}
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-20 text-vez-mute">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : (
          <>
            {/* Sources Tab */}
            {activeTab === "sources" && (
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                {sources.length === 0 && (
                  <div className="col-span-full rounded-[20px] bg-white p-10 text-center text-sm text-vez-mute">
                    No sources yet. Click &quot;Add source&quot; to start scraping a government or public website.
                  </div>
                )}
                {sources.map((source) => {
                  const isRunning = runningIds.has(source.id)
                  const categories = [
                    source.noticeListUrl && "Notice",
                    source.newsListUrl && "News",
                    source.pressReleaseListUrl && "Press Release",
                  ].filter(Boolean).join(" + ")
                  const progress = progressBySource[source.id]
                  const paginationLabel =
                    source.paginationType === "NONE"
                      ? "Single page"
                      : source.paginationType === "PATH_TEMPLATE"
                        ? `Path template · up to ${source.maxPages} pages`
                        : `?${source.paginationParam}=N · up to ${source.maxPages} pages`

                  const sitemapLabel = source.sitemapUrl
                    ? "Fast-path sitemap"
                    : source.sitemapCheckedAt
                      ? "No sitemap (HTML poll)"
                      : "Sitemap not checked yet"
                  const nextPoll = nextPollAt(source)
                  const isOverdue = nextPoll !== null && nextPoll.getTime() <= Date.now()

                  const sourceRuns = runs
                    .filter((r) => r.sourceId === source.id && r.status === "SUCCESS")
                    .slice(0, 7)
                    .reverse()
                  const sparklineData = sourceRuns.map((r) => r.itemsFound)
                  const totalFound = sourceRuns.reduce((s, r) => s + r.itemsFound, 0)
                  const totalSkipped = sourceRuns.reduce((s, r) => s + r.itemsSkipped, 0)
                  const dedupRate = totalFound > 0 ? Math.round((totalSkipped / totalFound) * 100) : null

                  return (
                    <div key={source.id} className="rounded-[20px] bg-white p-6">
                      <div className="mb-4 flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <h3 className="flex items-center gap-1.5 text-base text-vez-ink">
                            {source.name}
                            {source.isAdHoc && (
                              <span
                                className="inline-flex items-center gap-1 rounded-full bg-vez-sky/30 px-2 py-0.5 text-[10px] font-medium text-vez-navy"
                                title="Auto-created from a pasted link — no listing pages configured"
                              >
                                <Link2 className="size-2.5" /> Manual
                              </span>
                            )}
                          </h3>
                          <p className="mt-0.5 max-w-[260px] truncate text-xs text-vez-mute">{source.baseUrl}</p>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          {sparklineData.length >= 2 && (
                            <div title="Items found on listing, recent runs">
                              <MiniSparkline data={sparklineData} />
                            </div>
                          )}
                          <span
                            className={`flex items-center gap-1 rounded-full px-3 py-1 text-xs capitalize ${
                              !source.enabled
                                ? "border border-vez-line text-vez-mute"
                                : source.lastStatus === "FAILED"
                                  ? "bg-red-50 text-red-600"
                                  : "bg-vez-sky/30 text-vez-navy"
                            }`}
                          >
                            {!source.enabled ? (
                              <Ban className="size-3" />
                            ) : source.lastStatus === "FAILED" ? (
                              <AlertCircle className="size-3" />
                            ) : (
                              <CheckCircle className="size-3" />
                            )}
                            {!source.enabled ? "disabled" : source.lastStatus?.toLowerCase() ?? "not run yet"}
                          </span>
                        </div>
                      </div>
                      {source.isAdHoc ? (
                        <div className="mb-4 grid grid-cols-2 gap-3 rounded-[14px] bg-vez-surface px-4 py-3 text-xs">
                          <div>
                            <span className="text-vez-mute">Category</span>
                            <p className="mt-0.5 text-vez-ink">{categories || "—"}</p>
                          </div>
                          <div>
                            <span className="text-vez-mute">Items scraped</span>
                            <p className="mt-0.5 text-vez-ink">{source.itemCount.toLocaleString()}</p>
                          </div>
                          <div className="col-span-2 text-vez-mute">
                            Created from a pasted link — no listing pages, not polled automatically.
                            Use &quot;Scrape a link&quot; above to add more from this domain.
                          </div>
                        </div>
                      ) : (
                      <div className="mb-4 grid grid-cols-2 gap-3 rounded-[14px] bg-vez-surface px-4 py-3 text-xs">
                        <div>
                          <span className="text-vez-mute">Category</span>
                          <p className="mt-0.5 text-vez-ink">{categories || "—"}</p>
                        </div>
                        <div>
                          <span className="text-vez-mute">Items scraped</span>
                          <p className="mt-0.5 text-vez-ink">{source.itemCount.toLocaleString()}</p>
                        </div>
                        <div className="col-span-2">
                          <span className="text-vez-mute">Pagination</span>
                          <p className="mt-0.5 text-vez-ink">{paginationLabel}</p>
                        </div>
                        <div className="col-span-2">
                          <span className="text-vez-mute">Auto-polling</span>
                          <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-vez-ink">
                            <span className="flex items-center gap-1">
                              <Timer className="size-3 text-vez-mute" />
                              every {formatInterval(source.pollIntervalSeconds)}
                            </span>
                            {!autoScraping ? (
                              <span className="flex items-center gap-1">
                                <Ban className="size-3" /> auto-scraping paused
                              </span>
                            ) : nextPoll && !isOverdue ? (
                              <span className="text-vez-mute">
                                next in ~
                                {Math.max(1, Math.round((nextPoll.getTime() - Date.now()) / 60000))}
                                min
                              </span>
                            ) : isOverdue ? (
                              <span className="flex items-center gap-1 text-vez-navy">
                                <Zap className="size-3" /> due now
                              </span>
                            ) : null}
                          </p>
                        </div>
                        <div className="col-span-2">
                          <span className="text-vez-mute">Sitemap fast-path</span>
                          <p className="mt-0.5 flex items-center gap-1 text-vez-ink">
                            <Link2 className="size-3 shrink-0 text-vez-mute" />
                            <span className="truncate">{sitemapLabel}</span>
                          </p>
                        </div>
                        {dedupRate !== null && (
                          <div className="col-span-2">
                            <span className="text-vez-mute">Dedup efficiency (recent runs)</span>
                            <p className="mt-0.5 text-vez-ink">
                              {dedupRate}% already-scraped items skipped without re-fetching
                            </p>
                          </div>
                        )}
                      </div>
                      )}
                      {source.lastRunAt && !isRunning && (
                        <p className="mb-4 text-xs text-vez-mute">
                          Last run: {new Date(source.lastRunAt).toLocaleString()}
                        </p>
                      )}

                      {/* Why the last run failed and what to change about it */}
                      <SourceDiagnosis
                        source={source}
                        isRunning={isRunning}
                        applyingFix={applyingFix}
                        diagnosing={diagnosingId === source.id}
                        onApplyFix={(d) => handleApplyFix(source, d)}
                        onAutoDetect={() => openEditDialog(source)}
                        onEdit={() => openEditDialog(source)}
                        onRun={() => handleRun(source.id)}
                        onDiagnose={() => handleDiagnose(source.id)}
                      />


                      {/* Live progress messages while a run is in flight */}
                      {isRunning && progress && (
                        <div className="mb-4 max-h-32 space-y-1 overflow-y-auto rounded-[12px] bg-vez-navy/[0.04] px-3 py-2.5 text-xs">
                          {progress.messages.length === 0 ? (
                            <p className="flex items-center gap-1.5 text-vez-mute">
                              <Loader2 className="size-3 animate-spin" /> Starting…
                            </p>
                          ) : (
                            progress.messages.slice(-6).map((m, i) => (
                              <p key={i} className="truncate text-vez-mute">
                                {m.text}
                              </p>
                            ))
                          )}
                        </div>
                      )}

                      <div className="flex items-center gap-2">
                        {!source.isAdHoc && (
                          <>
                            <button
                              onClick={() => handleRun(source.id)}
                              disabled={isRunning || !source.enabled}
                              className="flex items-center gap-1.5 rounded-full bg-vez-navy px-4 py-2 text-xs text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                              title={`Crawl the newest ${source.maxPages} listing page(s)`}
                            >
                              {isRunning ? <Loader2 className="size-3 animate-spin" /> : <Play className="size-3" />}
                              {isRunning ? "Scraping…" : "Run now"}
                            </button>
                            <button
                              onClick={() => {
                                if (
                                  window.confirm(
                                    `Deep scrape "${source.name}"?\n\nEvery listing page is walked to the end of the archive, not just the newest ${source.maxPages}. This takes much longer and makes many more requests to the site.`,
                                  )
                                ) {
                                  void handleRun(source.id, true)
                                }
                              }}
                              disabled={isRunning || !source.enabled}
                              className="flex items-center gap-1.5 rounded-full border border-vez-line px-4 py-2 text-xs text-vez-navy transition-colors hover:bg-vez-surface disabled:opacity-50"
                              title="Walk every listing page to the end of the archive"
                            >
                              <Layers className="size-3" /> All pages
                            </button>
                            <button
                              onClick={() => handleToggleEnabled(source)}
                              className="flex items-center gap-1.5 rounded-full px-4 py-2 text-xs text-vez-mute transition-colors hover:bg-vez-surface hover:text-vez-navy"
                            >
                              {source.enabled ? <Ban className="size-3" /> : <PlayCircle className="size-3" />}
                              {source.enabled ? "Disable" : "Enable"}
                            </button>
                            <button
                              onClick={() => openEditDialog(source)}
                              className="flex items-center gap-1.5 rounded-full px-4 py-2 text-xs text-vez-mute transition-colors hover:bg-vez-surface hover:text-vez-navy"
                            >
                              <Edit className="size-3" /> Edit
                            </button>
                            <button
                              onClick={() => handleDiagnose(source.id)}
                              disabled={diagnosingId === source.id}
                              className="flex items-center gap-1.5 rounded-full px-4 py-2 text-xs text-vez-mute transition-colors hover:bg-vez-surface hover:text-vez-navy disabled:opacity-50"
                              title="Work out why this source is failing and what to change"
                            >
                              {diagnosingId === source.id ? (
                                <Loader2 className="size-3 animate-spin" />
                              ) : (
                                <Stethoscope className="size-3" />
                              )}
                              {diagnosingId === source.id ? "Diagnosing…" : "Diagnose"}
                            </button>
                          </>
                        )}
                        <button
                          onClick={() => handleDelete(source.id)}
                          className="flex size-8 items-center justify-center rounded-full text-vez-mute transition-colors hover:bg-red-50 hover:text-red-600"
                          aria-label="Delete source"
                        >
                          <Trash2 className="size-3" />
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}

            {/* Logs Tab */}
            {activeTab === "logs" && (
              <div className="rounded-[20px] bg-white p-6">
                <div className="mb-5 flex items-center justify-between">
                  <div>
                    <h2 className="text-lg text-vez-ink">Scraping logs</h2>
                    <p className="mt-0.5 text-sm text-vez-mute">
                      Run history across all sources
                      {logMeta.total > 0 && (
                        <span className="ml-1.5 text-xs text-vez-mute/80">
                          · {logMeta.total.toLocaleString()} run{logMeta.total === 1 ? "" : "s"}
                        </span>
                      )}
                    </p>
                  </div>
                  <button
                    onClick={() => {
                      loadAll()
                      void loadLogs()
                    }}
                    className="flex items-center gap-1.5 rounded-full border border-vez-line px-4 py-2 text-xs text-vez-ink transition-colors hover:bg-vez-surface"
                  >
                    <Activity className="size-3.5" /> Refresh
                  </button>
                </div>

                {/* Filters */}
                <div className="mb-4 flex flex-wrap items-center gap-2">
                  <select
                    value={logSourceFilter}
                    onChange={(e) => {
                      setLogSourceFilter(e.target.value)
                      setLogPage(1)
                    }}
                    className="h-9 max-w-[220px] rounded-[10px] border border-vez-line bg-white px-3 text-xs text-vez-ink outline-none focus:border-vez-navy"
                    aria-label="Filter by source"
                  >
                    <option value="">All sources</option>
                    {sources.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                  <select
                    value={logStatusFilter}
                    onChange={(e) => {
                      setLogStatusFilter(e.target.value as "" | ScrapeRunStatus)
                      setLogPage(1)
                    }}
                    className="h-9 rounded-[10px] border border-vez-line bg-white px-3 text-xs text-vez-ink outline-none focus:border-vez-navy"
                    aria-label="Filter by status"
                  >
                    <option value="">All statuses</option>
                    <option value="SUCCESS">Success</option>
                    <option value="FAILED">Failed</option>
                    <option value="RUNNING">Running</option>
                  </select>
                  {(logSourceFilter || logStatusFilter) && (
                    <button
                      onClick={clearLogFilters}
                      className="flex items-center gap-1 rounded-full px-3 py-1.5 text-xs text-vez-mute transition-colors hover:bg-vez-surface hover:text-vez-navy"
                    >
                      <X className="size-3" /> Clear filters
                    </button>
                  )}
                  <div className="ml-auto flex items-center gap-2">
                    <label className="text-xs text-vez-mute" htmlFor="log-page-size">
                      Rows
                    </label>
                    <select
                      id="log-page-size"
                      value={logLimit}
                      onChange={(e) => {
                        setLogLimit(Number(e.target.value))
                        setLogPage(1)
                      }}
                      className="h-9 rounded-[10px] border border-vez-line bg-white px-3 text-xs text-vez-ink outline-none focus:border-vez-navy"
                    >
                      <option value={20}>20</option>
                      <option value={50}>50</option>
                      <option value={100}>100</option>
                    </select>
                  </div>
                </div>

                {logError ? (
                  <div className="flex items-center gap-2 rounded-[12px] bg-red-50 px-4 py-3 text-sm text-red-600">
                    <AlertCircle className="size-4 shrink-0" /> {logError}
                  </div>
                ) : logLoading && logRuns.length === 0 ? (
                  <div className="flex items-center justify-center gap-2 py-14 text-sm text-vez-mute">
                    <Loader2 className="size-4 animate-spin" /> Loading run history…
                  </div>
                ) : logRuns.length === 0 ? (
                  <div className="flex flex-col items-center gap-2 py-14 text-vez-mute">
                    <Terminal className="size-6 opacity-40" />
                    <p className="text-sm">
                      {logSourceFilter || logStatusFilter
                        ? "No runs match the current filters."
                        : "No scrape runs yet — trigger one from the Sources tab."}
                    </p>
                    {(logSourceFilter || logStatusFilter) && (
                      <button
                        onClick={clearLogFilters}
                        className="mt-1 rounded-full border border-vez-line px-4 py-1.5 text-xs text-vez-ink transition-colors hover:bg-vez-surface"
                      >
                        Clear filters
                      </button>
                    )}
                  </div>
                ) : (
                  <>
                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-xs">
                        <thead>
                          <tr className="border-b border-vez-line text-vez-mute">
                            <th className="whitespace-nowrap py-2.5 pr-3 font-medium">Status</th>
                            <th className="whitespace-nowrap py-2.5 pr-3 font-medium">Started</th>
                            <th className="whitespace-nowrap py-2.5 pr-3 font-medium">Source</th>
                            <th className="whitespace-nowrap py-2.5 pr-3 font-medium">Duration</th>
                            <th className="whitespace-nowrap py-2.5 pr-3 font-medium">Outcome</th>
                            <th className="whitespace-nowrap py-2.5 pr-3 font-medium">Details</th>
                            <th className="whitespace-nowrap py-2.5 font-medium">Actions</th>
                          </tr>
                        </thead>
                        <tbody>
                          {logRuns.map((run) => {
                            const started = new Date(run.startedAt)
                            const duration =
                              run.status === "RUNNING" || !run.finishedAt
                                ? null
                                : new Date(run.finishedAt).getTime() - started.getTime()
                            const hasFailureDetail = (run.failedUrls?.length ?? 0) > 0
                            const isExpanded = expandedRunId === run.id
                            return (
                              <React.Fragment key={run.id}>
                              <tr
                                className="border-b border-vez-line/60 transition-colors last:border-0 hover:bg-vez-surface/60"
                              >
                                <td className="whitespace-nowrap py-3 pr-3">
                                  <span
                                    className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-[10px] font-medium capitalize ${
                                      run.status === "SUCCESS"
                                        ? "bg-vez-sky/30 text-vez-navy"
                                        : run.status === "FAILED"
                                          ? "bg-red-50 text-red-600"
                                          : "bg-amber-50 text-amber-600"
                                    }`}
                                  >
                                    {run.status === "SUCCESS" ? (
                                      <CheckCircle className="size-3" />
                                    ) : run.status === "FAILED" ? (
                                      <XCircle className="size-3" />
                                    ) : (
                                      <Clock className="size-3 animate-pulse" />
                                    )}
                                    {run.status.toLowerCase()}
                                  </span>
                                </td>
                                <td className="whitespace-nowrap py-3 pr-3 tabular-nums text-vez-ink">
                                  {started.toLocaleString()}
                                </td>
                                <td className="max-w-[200px] truncate py-3 pr-3 text-vez-ink" title={run.sourceLabel}>
                                  {run.sourceLabel}
                                </td>
                                <td className="whitespace-nowrap py-3 pr-3 tabular-nums text-vez-mute">
                                  {duration === null ? "—" : formatDuration(duration)}
                                </td>
                                <td className="py-3 pr-3">
                                  <span className="flex flex-wrap gap-1">
                                    {run.itemsFound > 0 && (
                                      <span className="rounded-full bg-vez-surface px-2 py-0.5 text-[10px] text-vez-ink">
                                        {run.itemsFound} found
                                      </span>
                                    )}
                                    {run.itemsNew > 0 && (
                                      <span
                                        className="rounded-full bg-vez-sky/30 px-2 py-0.5 text-[10px] text-vez-navy"
                                        title="New items stored"
                                      >
                                        {run.itemsNew} new
                                      </span>
                                    )}
                                    {run.itemsUpdated > 0 && (
                                      <span
                                        className="rounded-full bg-vez-sky/20 px-2 py-0.5 text-[10px] text-vez-navy"
                                        title="Updated items"
                                      >
                                        {run.itemsUpdated} upd
                                      </span>
                                    )}
                                    {run.itemsSkipped > 0 && (
                                      <span
                                        className="rounded-full bg-vez-surface px-2 py-0.5 text-[10px] text-vez-mute"
                                        title="Already scraped, skipped"
                                      >
                                        {run.itemsSkipped} deduped
                                      </span>
                                    )}
                                    {run.itemsFound === 0 && run.itemsNew === 0 && run.itemsSkipped === 0 && (
                                      <span className="text-vez-mute">—</span>
                                    )}
                                  </span>
                                </td>
                                <td className="max-w-[260px] py-3 pr-3">
                                  {run.status === "FAILED" ? (
                                    <button
                                      onClick={() => hasFailureDetail && setExpandedRunId(isExpanded ? null : run.id)}
                                      className={`flex items-center gap-1.5 text-red-600 ${hasFailureDetail ? "cursor-pointer hover:underline" : "cursor-default"}`}
                                      title={run.error ?? undefined}
                                    >
                                      <AlertCircle className="size-3 shrink-0" />
                                      <span className="truncate">{run.error ?? "Scrape failed"}</span>
                                      {hasFailureDetail && (
                                        isExpanded ? <ChevronUp className="size-3 shrink-0" /> : <ChevronDown className="size-3 shrink-0" />
                                      )}
                                    </button>
                                  ) : run.status === "RUNNING" ? (
                                    <span className="flex items-center gap-1.5 whitespace-nowrap text-vez-mute">
                                      <Loader2 className="size-3 animate-spin" /> scraping…
                                    </span>
                                  ) : run.itemsSummarized > 0 ? (
                                    <span className="text-vez-mute">{run.itemsSummarized} summarized</span>
                                  ) : (
                                    <span className="text-vez-mute">—</span>
                                  )}
                                </td>
                                <td className="whitespace-nowrap py-3">
                                  {run.status === "FAILED" && (
                                    <button
                                      onClick={() => handleRetryRun(run)}
                                      disabled={retryingRunId === run.id || !run.sourceId}
                                      className="flex items-center gap-1.5 rounded-full border border-vez-line px-3 py-1 text-[11px] text-vez-ink transition-colors hover:bg-vez-surface disabled:opacity-50"
                                    >
                                      {retryingRunId === run.id ? (
                                        <Loader2 className="size-3 animate-spin" />
                                      ) : (
                                        <RefreshCw className="size-3" />
                                      )}
                                      Retry
                                    </button>
                                  )}
                                </td>
                              </tr>
                              {isExpanded && hasFailureDetail && (
                                <tr className="border-b border-vez-line/60 bg-vez-surface/50 last:border-0">
                                  <td colSpan={7} className="px-3 py-3">
                                    {(() => {
                                      // Rows written before outcome existed have no
                                      // field — treat those as failures.
                                      const issues = run.failedUrls!
                                      const failed = issues.filter((f) => (f.outcome ?? "failed") === "failed")
                                      const skipped = issues.filter((f) => f.outcome === "skipped")
                                      return (
                                        <>
                                          <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px] font-medium uppercase tracking-wide">
                                            {failed.length > 0 && (
                                              <span className="text-red-700">{failed.length} failed</span>
                                            )}
                                            {skipped.length > 0 && (
                                              <span className="text-vez-mute">{skipped.length} skipped</span>
                                            )}
                                            <button
                                              onClick={() => {
                                                const text = issues
                                                  .map((f) => `${(f.outcome ?? "failed").toUpperCase()}\t${f.stage}\t${f.url}\t${f.error}`)
                                                  .join("\n")
                                                void navigator.clipboard.writeText(text)
                                              }}
                                              className="ml-auto rounded-full border border-vez-line bg-white px-2.5 py-1 text-[10px] normal-case tracking-normal text-vez-ink transition-colors hover:bg-vez-surface"
                                              title="Copy every URL with its stage and reason, for auditing offline"
                                            >
                                              Copy all
                                            </button>
                                          </div>
                                          <ul className="max-h-64 space-y-2 overflow-y-auto text-xs">
                                            {[...failed, ...skipped].map((f, i) => {
                                              const isSkip = f.outcome === "skipped"
                                              return (
                                                <li key={i} className="rounded-[10px] bg-white px-3 py-2">
                                                  <span
                                                    className={`mr-1.5 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${
                                                      isSkip
                                                        ? "bg-vez-line/50 text-vez-mute"
                                                        : "bg-red-100 text-red-700"
                                                    }`}
                                                  >
                                                    {isSkip ? "skipped" : "failed"} · {f.stage}
                                                  </span>
                                                  <a
                                                    href={f.url}
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                    className="break-all text-vez-navy underline"
                                                  >
                                                    {f.url}
                                                  </a>
                                                  <p className="mt-1 text-vez-mute">{f.error}</p>
                                                </li>
                                              )
                                            })}
                                          </ul>
                                        </>
                                      )
                                    })()}
                                  </td>
                                </tr>
                              )}
                              </React.Fragment>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>

                    {/* Pagination */}
                    <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-vez-line pt-4 text-xs">
                      <p className="tabular-nums text-vez-mute">
                        Showing {logMeta.total === 0 ? 0 : (logPage - 1) * logLimit + 1}–
                        {Math.min(logPage * logLimit, logMeta.total)} of{" "}
                        {logMeta.total.toLocaleString()} run{logMeta.total === 1 ? "" : "s"}
                      </p>
                      {logMeta.totalPages > 1 && (
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => setLogPage((p) => Math.max(1, p - 1))}
                            disabled={logPage <= 1 || logLoading}
                            className="flex size-8 items-center justify-center rounded-[10px] border border-vez-line text-vez-ink transition-colors hover:bg-vez-surface disabled:cursor-not-allowed disabled:opacity-40"
                            aria-label="Previous page"
                          >
                            <ChevronLeft className="size-4" />
                          </button>
                          {pageWindow(logPage, logMeta.totalPages).map((p, i) =>
                            typeof p === "number" ? (
                              <button
                                key={p}
                                onClick={() => setLogPage(p)}
                                disabled={logLoading}
                                className={`size-8 rounded-[10px] text-xs tabular-nums transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                                  p === logPage
                                    ? "bg-vez-navy text-white"
                                    : "border border-vez-line text-vez-ink hover:bg-vez-surface"
                                }`}
                                aria-label={`Page ${p}`}
                                aria-current={p === logPage ? "page" : undefined}
                              >
                                {p}
                              </button>
                            ) : (
                              <span key={`gap-${i}`} className="px-1 text-vez-mute">
                                …
                              </span>
                            ),
                          )}
                          <button
                            onClick={() => setLogPage((p) => Math.min(logMeta.totalPages, p + 1))}
                            disabled={logPage >= logMeta.totalPages || logLoading}
                            className="flex size-8 items-center justify-center rounded-[10px] border border-vez-line text-vez-ink transition-colors hover:bg-vez-surface disabled:cursor-not-allowed disabled:opacity-40"
                            aria-label="Next page"
                          >
                            <ChevronRight className="size-4" />
                          </button>
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>
            )}
          </>
        )}

        {/* Add/Edit source dialog — wide, two/three-column layout that fits
            the viewport without internal scrolling */}
        {dialogOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
            <div className="flex max-h-[calc(100vh-2rem)] w-full max-w-4xl flex-col overflow-hidden rounded-[20px] bg-white shadow-2xl">
              {/* Header */}
              <div className="flex items-start justify-between gap-4 border-b border-vez-line px-6 py-4">
                <div>
                  <h2 className="text-lg font-medium text-vez-ink">
                    {form.id ? "Edit source" : "Add source"}
                  </h2>
                  <p className="mt-0.5 text-xs text-vez-mute">
                    {form.id
                      ? "Update how this official portal is crawled and polled."
                      : "Register an official portal to start aggregating its notices."}
                  </p>
                </div>
                <button
                  onClick={() => setDialogOpen(false)}
                  className="flex size-8 shrink-0 items-center justify-center rounded-full text-vez-mute transition-colors hover:bg-vez-surface"
                  aria-label="Close"
                >
                  <X className="size-4" />
                </button>
              </div>

              <form onSubmit={handleSubmit} className="flex flex-col">
                <div className="flex-1 overflow-y-auto px-6 py-5">
                  <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                    <div>
                      <label className="mb-1 block text-xs font-medium text-vez-mute">Name</label>
                      <input
                        required
                        autoFocus={!form.id}
                        value={form.name}
                        onChange={(e) => setForm({ ...form, name: e.target.value })}
                        placeholder="e.g. Ministry of Home Affairs"
                        className="w-full rounded-[10px] border border-vez-line bg-white px-3 py-2 text-sm text-vez-ink outline-none transition-colors placeholder:text-vez-mute focus:border-vez-navy"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-medium text-vez-mute">Website base URL</label>
                      <input
                        required
                        type="url"
                        value={form.baseUrl}
                        onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
                        placeholder="https://example.gov.np"
                        className="w-full rounded-[10px] border border-vez-line bg-white px-3 py-2 text-sm text-vez-ink outline-none transition-colors placeholder:text-vez-mute focus:border-vez-navy"
                      />
                    </div>
                  </div>

                  {/* Listing pages */}
                  <div className="mt-5">
                    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                      <p className="text-xs font-medium text-vez-ink">Listing pages</p>
                      <button
                        type="button"
                        onClick={handleDiscoverRoutes}
                        disabled={discovering || !form.baseUrl.trim()}
                        className="flex items-center gap-1.5 rounded-full border border-vez-line px-3 py-1.5 text-xs text-vez-navy transition-colors hover:bg-vez-surface disabled:opacity-50"
                        title="Read the site's navigation and find its notice/news pages"
                      >
                        {discovering ? (
                          <Loader2 className="size-3 animate-spin" />
                        ) : (
                          <Compass className="size-3" />
                        )}
                        {discovering ? "Detecting…" : "Auto-detect URLs"}
                      </button>
                    </div>

                    {discovery && (
                      <div className="mb-3 rounded-[12px] bg-vez-surface px-3 py-2.5 text-xs">
                        {discovery.routes.length === 0 ? (
                          <p className="text-vez-mute">
                            No listing pages were found on this site.
                          </p>
                        ) : (
                          <>
                            <p className="mb-2 text-vez-mute">
                              Checked {discovery.checked} page(s). Click one to use it.
                            </p>
                            <ul className="space-y-1.5">
                              {discovery.routes.map((route) => (
                                <li key={route.url} className="flex items-start gap-2">
                                  <button
                                    type="button"
                                    onClick={() =>
                                      setForm((prev) => ({
                                        ...prev,
                                        ...(route.category === "NOTICE"
                                          ? { noticeListUrl: route.url }
                                          : route.category === "NEWS"
                                            ? { newsListUrl: route.url }
                                            : { pressReleaseListUrl: route.url }),
                                      }))
                                    }
                                    className="flex-1 text-left"
                                  >
                                    <span
                                      className={`mr-1.5 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${
                                        route.verified
                                          ? "bg-emerald-100 text-emerald-700"
                                          : "bg-vez-navy/10 text-vez-mute"
                                      }`}
                                    >
                                      {route.category.replace("_", " ")}
                                    </span>
                                    <span className="break-all text-vez-navy underline-offset-2 hover:underline">
                                      {route.url}
                                    </span>
                                    <span className="block text-vez-mute">
                                      {route.verified
                                        ? `${route.row_count} notice link(s) found`
                                        : route.evidence.join(" · ")}
                                    </span>
                                  </button>
                                </li>
                              ))}
                            </ul>
                          </>
                        )}
                        {discovery.notes.map((note) => (
                          <p key={note} className="mt-2 text-vez-mute">
                            {note}
                          </p>
                        ))}
                      </div>
                    )}

                    <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                      <div>
                        <label className="mb-1 block text-xs text-vez-mute">Notice listing page URL</label>
                        <input
                          type="url"
                          value={form.noticeListUrl}
                          onChange={(e) => setForm({ ...form, noticeListUrl: e.target.value })}
                          placeholder="https://example.gov.np/notices"
                          className="w-full rounded-[10px] border border-vez-line bg-white px-3 py-2 text-sm text-vez-ink outline-none transition-colors placeholder:text-vez-mute focus:border-vez-navy"
                        />
                      </div>
                      <div>
                        <label className="mb-1 block text-xs text-vez-mute">News listing page URL</label>
                        <input
                          type="url"
                          value={form.newsListUrl}
                          onChange={(e) => setForm({ ...form, newsListUrl: e.target.value })}
                          placeholder="https://example.gov.np/news"
                          className="w-full rounded-[10px] border border-vez-line bg-white px-3 py-2 text-sm text-vez-ink outline-none transition-colors placeholder:text-vez-mute focus:border-vez-navy"
                        />
                      </div>
                      <div>
                        <label className="mb-1 block text-xs text-vez-mute">Press release listing page URL</label>
                        <input
                          type="url"
                          value={form.pressReleaseListUrl}
                          onChange={(e) => setForm({ ...form, pressReleaseListUrl: e.target.value })}
                          placeholder="https://example.gov.np/press-release"
                          className="w-full rounded-[10px] border border-vez-line bg-white px-3 py-2 text-sm text-vez-ink outline-none transition-colors placeholder:text-vez-mute focus:border-vez-navy"
                        />
                      </div>
                    </div>
                    <p className="mt-2 text-[11px] leading-relaxed text-vez-mute">
                      Provide at least one listing URL. The extraction pattern (title, link, date) is detected
                      automatically on the first run and cached for future runs.
                    </p>
                  </div>

                  {/* Polling & sitemap fast-path — side by side */}
                  <div className="mt-5 grid grid-cols-1 gap-5 rounded-[12px] border border-vez-line px-4 py-4 md:grid-cols-2">
                    <div>
                      <p className="text-xs font-medium text-vez-ink">Auto-poll interval</p>
                      <div className="mb-2 mt-2.5 flex flex-wrap gap-1.5">
                        {POLL_PRESETS.map((preset) => (
                          <button
                            key={preset.seconds}
                            type="button"
                            onClick={() => setForm({ ...form, pollIntervalSeconds: preset.seconds })}
                            className={`rounded-full px-3 py-1 text-xs transition-colors ${
                              form.pollIntervalSeconds === preset.seconds
                                ? "bg-vez-navy text-white"
                                : "border border-vez-line text-vez-mute hover:bg-vez-surface hover:text-vez-navy"
                            }`}
                          >
                            {preset.label}
                          </button>
                        ))}
                      </div>
                      <div className="flex items-center gap-2">
                        <input
                          type="number"
                          min={60}
                          max={86400}
                          value={form.pollIntervalSeconds}
                          onChange={(e) =>
                            setForm({ ...form, pollIntervalSeconds: Number(e.target.value) || 60 })
                          }
                          className="h-9 w-24 rounded-[10px] border border-vez-line bg-white px-3 text-sm text-vez-ink outline-none transition-colors placeholder:text-vez-mute focus:border-vez-navy"
                        />
                        <span className="text-xs text-vez-mute">seconds</span>
                        <span className="ml-auto text-xs font-medium text-vez-ink">
                          every {formatInterval(form.pollIntervalSeconds)}
                        </span>
                      </div>
                      <p className="mt-2 text-[11px] leading-relaxed text-vez-mute">
                        How often the automatic scheduler probes this source. Sources with a sitemap
                        use one cheap request; HTML-only sources run a full crawl each time, so give
                        those a slower cadence (15 min or more).
                      </p>
                    </div>

                    <div className="flex flex-col border-t border-vez-line/60 pt-4 md:border-l md:border-t-0 md:pl-5 md:pt-0">
                      <label className="mb-1.5 block text-xs text-vez-mute">
                        Sitemap fast-path URL
                      </label>
                      <div className="flex items-center gap-2">
                        <input
                          type="url"
                          value={form.sitemapUrl}
                          onChange={(e) => setForm({ ...form, sitemapUrl: e.target.value })}
                          placeholder="https://example.gov.np/sitemap-news.xml"
                          className="h-9 w-full min-w-0 rounded-[10px] border border-vez-line bg-white px-3 text-sm text-vez-ink outline-none transition-colors placeholder:text-vez-mute focus:border-vez-navy"
                        />
                        <button
                          type="button"
                          onClick={handleDetectSitemap}
                          disabled={detectingSitemap || !form.id}
                          className="flex shrink-0 items-center gap-1 rounded-full border border-vez-line px-3 py-1.5 text-xs text-vez-ink transition-colors hover:bg-vez-surface disabled:cursor-not-allowed disabled:opacity-50"
                          title={
                            form.id
                              ? "Detect the sitemap from robots.txt / sitemap.xml and cache it"
                              : "Save the source first, then detect its sitemap"
                          }
                        >
                          {detectingSitemap ? (
                            <><Loader2 className="size-3 animate-spin" /> Detecting…</>
                          ) : (
                            <><Radar className="size-3" /> Detect</>
                          )}
                        </button>
                        {form.id && form.sitemapUrl.trim() && (
                          <button
                            type="button"
                            onClick={handleCheckSitemap}
                            disabled={checkingSitemap}
                            className="flex shrink-0 items-center gap-1 rounded-full border border-vez-line px-3 py-1.5 text-xs text-vez-ink transition-colors hover:bg-vez-surface disabled:cursor-not-allowed disabled:opacity-50"
                            title="One cheap request — how many sitemap URLs are not yet scraped"
                          >
                            {checkingSitemap ? (
                              <><Loader2 className="size-3 animate-spin" /> Checking…</>
                            ) : (
                              <><Search className="size-3" /> Check</>
                            )}
                          </button>
                        )}
                      </div>
                      {sitemapNotice && (
                        <p
                          className={`mt-1.5 text-[11px] leading-relaxed ${
                            sitemapNotice.tone === "error"
                              ? "text-red-600"
                              : sitemapNotice.tone === "ok"
                                ? "text-vez-ink"
                                : "text-vez-mute"
                          }`}
                        >
                          {sitemapNotice.text}
                        </p>
                      )}
                      {!form.id && (
                        <p className="mt-1.5 text-[11px] text-vez-mute">
                          Sitemap detection runs automatically on the first scheduled poll. Save the
                          source first to detect it right now.
                        </p>
                      )}
                    </div>
                  </div>

                  {/* Advanced: pagination */}
                  <button
                    type="button"
                    onClick={() => setShowAdvanced((v) => !v)}
                    className="mt-4 flex w-full items-center gap-1.5 rounded-[10px] border border-vez-line px-3 py-2 text-xs font-medium text-vez-ink transition-colors hover:bg-vez-surface"
                  >
                    {showAdvanced ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                    Advanced: pagination
                  </button>

                  {showAdvanced && (
                    <div className="mt-2 grid grid-cols-1 gap-4 rounded-[12px] bg-vez-surface px-4 py-4 md:grid-cols-2">
                      <div>
                        <label className="mb-1 block text-xs text-vez-mute">Pagination style</label>
                        <select
                          value={form.paginationType}
                          onChange={(e) =>
                            setForm({ ...form, paginationType: e.target.value as ScrapePaginationType })
                          }
                          className="h-10 w-full rounded-[10px] border border-vez-line bg-white px-3 text-sm text-vez-ink outline-none transition-colors placeholder:text-vez-mute focus:border-vez-navy"
                        >
                          <option value="QUERY_PARAM">Query parameter (?page=2, ?start=20, …)</option>
                          <option value="PATH_TEMPLATE">Path template ({"{page}"} placeholder in the URL)</option>
                          <option value="NONE">No pagination — single page only</option>
                        </select>
                      </div>
                      {form.paginationType === "QUERY_PARAM" && (
                        <div>
                          <label className="mb-1 block text-xs text-vez-mute">Query parameter name</label>
                          <input
                            value={form.paginationParam}
                            onChange={(e) => setForm({ ...form, paginationParam: e.target.value })}
                            placeholder="page"
                            className="h-10 w-full rounded-[10px] border border-vez-line bg-white px-3 text-sm text-vez-ink outline-none transition-colors placeholder:text-vez-mute focus:border-vez-navy"
                          />
                        </div>
                      )}
                      {form.paginationType === "PATH_TEMPLATE" && (
                        <p className="flex items-center text-xs text-vez-mute md:col-span-2">
                          Put a literal <code className="mx-1 rounded bg-white px-1 py-0.5">{"{page}"}</code> token in the listing
                          URL above, e.g. <code className="mx-1 rounded bg-white px-1 py-0.5">.../notices/page/{"{page}"}/</code>
                        </p>
                      )}
                      {form.paginationType !== "NONE" && (
                        <div className="grid grid-cols-2 gap-3 md:col-span-2">
                          <div>
                            <label className="mb-1 block text-xs text-vez-mute">Start page number</label>
                            <input
                              type="number"
                              min={0}
                              value={form.startPage}
                              onChange={(e) => setForm({ ...form, startPage: Number(e.target.value) || 1 })}
                              className="h-10 w-full rounded-[10px] border border-vez-line bg-white px-3 text-sm text-vez-ink outline-none transition-colors placeholder:text-vez-mute focus:border-vez-navy"
                            />
                          </div>
                          <div>
                            <label className="mb-1 block text-xs text-vez-mute">Max pages per run</label>
                            <input
                              type="number"
                              min={1}
                              max={100}
                              value={form.maxPages}
                              onChange={(e) => setForm({ ...form, maxPages: Number(e.target.value) || 1 })}
                              className="h-10 w-full rounded-[10px] border border-vez-line bg-white px-3 text-sm text-vez-ink outline-none transition-colors placeholder:text-vez-mute focus:border-vez-navy"
                            />
                            <p className="mt-1 text-[11px] text-vez-mute">
                              Higher values crawl deeper into a source&apos;s archive so more historical government notices get captured. HTML-only sources (no sitemap) run a full crawl per poll, so pair a high page count with a slower auto-poll interval.
                            </p>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* Footer — sticky, error + actions */}
                <div className="flex items-center justify-between gap-4 border-t border-vez-line bg-vez-surface/40 px-6 py-3.5">
                  {formError ? (
                    <p className="flex items-center gap-1.5 text-xs text-red-600">
                      <AlertCircle className="size-3.5 shrink-0" />
                      {formError}
                    </p>
                  ) : (
                    <span className="text-xs text-vez-mute">
                      {form.id ? "Changes apply on the next scheduled poll." : "Polling starts after the source is saved and enabled."}
                    </span>
                  )}
                  <div className="flex shrink-0 items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setDialogOpen(false)}
                      className="rounded-full px-5 py-2.5 text-sm text-vez-mute transition-colors hover:bg-vez-surface"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={saving}
                      className="flex items-center gap-1.5 rounded-full bg-vez-navy px-5 py-2.5 text-sm text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                    >
                      {saving && <Loader2 className="size-3.5 animate-spin" />}
                      {form.id ? "Save changes" : "Add source"}
                    </button>
                  </div>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* Quick-scrape dialog: paste one or more notice/news/press-release
            links directly, no source pre-configuration required. */}
        {quickDialogOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
            <div className="flex max-h-[calc(100vh-2rem)] w-full max-w-2xl flex-col overflow-hidden rounded-[20px] bg-white shadow-2xl">
              <div className="flex items-start justify-between gap-4 border-b border-vez-line px-6 py-4">
                <div>
                  <h2 className="flex items-center gap-2 text-lg font-medium text-vez-ink">
                    <Link2 className="size-4 text-vez-navy" /> Scrape a link
                  </h2>
                  <p className="mt-0.5 text-xs text-vez-mute">
                    Paste direct links to notices, press releases, or news articles — one per line. Each
                    is scraped and saved immediately, no source setup required.
                  </p>
                </div>
                <button
                  onClick={() => setQuickDialogOpen(false)}
                  className="flex size-8 shrink-0 items-center justify-center rounded-full text-vez-mute transition-colors hover:bg-vez-surface"
                  aria-label="Close"
                >
                  <X className="size-4" />
                </button>
              </div>

              <div className="flex-1 overflow-y-auto px-6 py-5">
                <form onSubmit={handleQuickScrape} className="flex flex-col gap-2">
                  <textarea
                    rows={3}
                    autoFocus
                    value={quickUrlsText}
                    onChange={(e) => setQuickUrlsText(e.target.value)}
                    placeholder={"https://example.gov.np/notices/some-notice\nhttps://example.gov.np/press/another-one"}
                    className="w-full resize-y rounded-[10px] border border-vez-line bg-white px-3 py-2 text-sm text-vez-ink outline-none transition-colors placeholder:text-vez-mute focus:border-vez-navy"
                  />
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-[11px] text-vez-mute">
                      {quickUrlsText.trim()
                        ? `${quickUrlsText.split("\n").map((l) => l.trim()).filter(Boolean).length} link(s) — one per line`
                        : "One link per line"}
                    </span>
                    <button
                      type="submit"
                      disabled={quickBatchRunning || !quickUrlsText.trim()}
                      className="flex shrink-0 items-center gap-1.5 rounded-full bg-vez-navy px-5 py-2.5 text-sm text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {quickBatchRunning ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
                      {quickBatchRunning ? "Scraping…" : "Scrape now"}
                    </button>
                  </div>
                </form>

                {quickNotice && (
                  <p className={`mt-2 text-xs ${quickNotice.tone === "error" ? "text-red-600" : "text-vez-mute"}`}>
                    {quickNotice.text}
                  </p>
                )}

                {/* Live per-link status for the batch currently in flight */}
                {quickItems.length > 0 && (
                  <ul className="mt-4 space-y-1.5 border-t border-vez-line pt-4">
                    {quickItems.map((item) => {
                      const tone =
                        item.status === "done"
                          ? "bg-vez-sky/30 text-vez-navy"
                          : item.status === "exists"
                            ? "bg-vez-line/40 text-vez-mute"
                            : item.status === "error"
                              ? "bg-red-50 text-red-600"
                              : "bg-amber-50 text-amber-600"
                      return (
                        <li key={item.id} className="flex flex-wrap items-center gap-2 text-xs">
                          <span className={`flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium capitalize ${tone}`}>
                            {item.status === "done" || item.status === "exists" ? (
                              <CheckCircle className="size-3" />
                            ) : item.status === "error" ? (
                              <XCircle className="size-3" />
                            ) : (
                              <Loader2 className="size-3 animate-spin" />
                            )}
                            {item.status === "scraping" ? "scraping…" : item.status}
                          </span>
                          <a
                            href={item.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="min-w-0 truncate text-vez-ink underline decoration-vez-line hover:text-vez-navy"
                          >
                            {item.url}
                          </a>
                          {item.detail && <span className="shrink-0 text-vez-mute">— {item.detail}</span>}
                          {item.itemId && (
                            <a
                              href={`/notices/${item.itemId}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="flex shrink-0 items-center gap-1 rounded-full bg-vez-sky/20 px-2 py-0.5 text-[10px] font-medium text-vez-navy transition-colors hover:bg-vez-sky/30"
                              title={item.title}
                            >
                              View notice <ExternalLink className="size-2.5" />
                            </a>
                          )}
                        </li>
                      )
                    })}
                  </ul>
                )}

                {/* Collapsible history of past quick-scrapes, persisted locally */}
                {quickHistory.length > 0 && (
                  <div className="mt-4 border-t border-vez-line pt-4">
                    <button
                      type="button"
                      onClick={() => setQuickHistoryOpen((v) => !v)}
                      className="flex items-center gap-1 text-xs text-vez-mute transition-colors hover:text-vez-navy"
                    >
                      <History className="size-3.5" />
                      Recent ({quickHistory.length})
                      {quickHistoryOpen ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
                    </button>
                    {quickHistoryOpen && (
                      <ul className="mt-2.5 max-h-48 space-y-1.5 overflow-y-auto text-xs">
                        {quickHistory.map((h, i) => (
                          <li key={i} className="flex flex-wrap items-center gap-2">
                            <span
                              className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium capitalize ${
                                h.status === "done"
                                  ? "bg-vez-sky/30 text-vez-navy"
                                  : h.status === "exists"
                                    ? "bg-vez-line/40 text-vez-mute"
                                    : "bg-red-50 text-red-600"
                              }`}
                            >
                              {h.status}
                            </span>
                            <a
                              href={h.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="min-w-0 truncate text-vez-ink underline decoration-vez-line hover:text-vez-navy"
                            >
                              {h.url}
                            </a>
                            {h.itemId && (
                              <a
                                href={`/notices/${h.itemId}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="flex shrink-0 items-center gap-1 rounded-full bg-vez-sky/20 px-2 py-0.5 text-[10px] font-medium text-vez-navy transition-colors hover:bg-vez-sky/30"
                                title={h.title}
                              >
                                View <ExternalLink className="size-2.5" />
                              </a>
                            )}
                            <span className="ml-auto shrink-0 text-vez-mute">{new Date(h.at).toLocaleTimeString()}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </AdminLayout>
    </div>
  )
}

export default function AdminScrapingPage() {
  return (
    <Suspense fallback={null}>
      <AdminScrapingPageContent />
    </Suspense>
  )
}
