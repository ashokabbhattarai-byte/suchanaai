"use client"

import React, { useEffect, useState, useCallback, useMemo, useRef, Suspense } from "react"
import { useRouter, usePathname, useSearchParams } from "next/navigation"
import { Search, Trash2, ExternalLink, ChevronLeft, ChevronRight, Loader2, X, SlidersHorizontal, Edit, RotateCcw, BadgeCheck, Tag, ShieldCheck, RefreshCw } from "lucide-react"
import { AdminLayout } from "@/components/admin/admin-layout"
import { useConfirm } from "@/components/ui/confirm-dialog"
import { Header } from "@/components/layout/header"
import {
  fetchScrapedItems,
  deleteScrapedItem,
  fetchScrapeSources,
  correctScrapedItem,
  reextractNotices,
} from "@/lib/api"
import { getStoredJSON, setStoredJSON } from "@/lib/local-store"
import { toast } from "sonner"
import type { ScrapedItem, ScrapedItemCategory, ScrapeSource } from "@/lib/types"

const inputClass =
  "h-11 w-full rounded-full border border-vez-line bg-white px-5 text-sm text-vez-ink outline-none transition-colors placeholder:text-vez-mute focus:border-vez-sky"

const fieldClass =
  "w-full rounded-[12px] border border-vez-line bg-white px-4 py-3 text-sm text-vez-ink outline-none transition-colors placeholder:text-vez-mute focus:border-vez-sky"

const PAGE_SIZE = 20

type SortOption = "publishedAt:desc" | "publishedAt:asc" | "scrapedAt:desc" | "title:asc"
type ScrapedItemFiltersSortBy = "publishedAt" | "scrapedAt" | "title"

// URL query param keys — persists filters/search/page across navigation
// (e.g. opening a notice's original source in a new tab and coming back).
const QP = {
  search: "q",
  category: "category",
  source: "source",
  dateFrom: "from",
  dateTo: "to",
  sort: "sort",
  page: "page",
} as const

// Remembers the last-used filters across full navigations/reloads — URL
// params alone only survive browser back/forward.
const PREFS_KEY = "pnm_admin_notices_prefs"

interface AdminNoticesPrefs {
  search: string
  category: ScrapedItemCategory | ""
  sourceId: string
  dateFrom: string
  dateTo: string
  sort: SortOption
}

const DEFAULT_PREFS: AdminNoticesPrefs = {
  search: "",
  category: "",
  sourceId: "",
  dateFrom: "",
  dateTo: "",
  sort: "publishedAt:desc",
}

function AdminNoticesPageContent() {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const didMountSync = useRef(false)
  const confirm = useConfirm()

  const storedPrefs = getStoredJSON(PREFS_KEY, DEFAULT_PREFS)

  const [items, setItems] = useState<ScrapedItem[]>([])
  const [sources, setSources] = useState<ScrapeSource[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(() => Number(searchParams.get(QP.page)) || 1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Bulk re-extraction. The API queues the work and returns immediately, so
  // this reports what was queued rather than waiting for OCR to finish.
  const [bulkReextracting, setBulkReextracting] = useState(false)
  const [bulkNote, setBulkNote] = useState<{ tone: "info" | "error"; text: string } | null>(null)

  async function handleBulkReextract(scope: "garbled" | "all") {
    if (bulkReextracting) return
    if (
      scope === "all" &&
      !(await confirm({
        title: "Re-extract every notice with an attachment?",
        description: "This re-runs OCR and can take a while.",
        confirmLabel: "Re-extract all",
      }))
    ) {
      return
    }
    setBulkReextracting(true)
    setBulkNote(null)
    try {
      const result = await reextractNotices(scope)
      setBulkNote({ tone: "info", text: result.message })
    } catch (err) {
      setBulkNote({
        tone: "error",
        text: err instanceof Error ? err.message : "Bulk re-extraction failed",
      })
    } finally {
      setBulkReextracting(false)
    }
  }

  const [search, setSearch] = useState(() => searchParams.get(QP.search) ?? storedPrefs.search)
  const [debouncedSearch, setDebouncedSearch] = useState(
    () => searchParams.get(QP.search) ?? storedPrefs.search,
  )
  const [category, setCategory] = useState<ScrapedItemCategory | "">(
    () => (searchParams.get(QP.category) as ScrapedItemCategory | null) ?? storedPrefs.category,
  )
  const [sourceId, setSourceId] = useState(() => searchParams.get(QP.source) ?? storedPrefs.sourceId)
  const [dateFrom, setDateFrom] = useState(() => searchParams.get(QP.dateFrom) ?? storedPrefs.dateFrom)
  const [dateTo, setDateTo] = useState(() => searchParams.get(QP.dateTo) ?? storedPrefs.dateTo)
  const [sort, setSort] = useState<SortOption>(
    () => (searchParams.get(QP.sort) as SortOption | null) ?? storedPrefs.sort,
  )
  const [showFilters, setShowFilters] = useState(false)

  // Notice editor drawer state
  const [editingItem, setEditingItem] = useState<ScrapedItem | null>(null)
  // "" only until openEditor seeds it from the notice being edited.
  const [editCategory, setEditCategory] = useState<ScrapedItemCategory | "">("")
  const [editTags, setEditTags] = useState<string>("")
  const [editConfidence, setEditConfidence] = useState<number | null>(null)
  const [editing, setEditing] = useState(false)

  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedSearch(search)
      setPage(1)
    }, 350)
    return () => clearTimeout(t)
  }, [search])

  useEffect(() => {
    fetchScrapeSources().then(setSources).catch((e) => console.error("scrape sources:", e))
  }, [])

  const [sortBy, sortOrder] = sort.split(":") as [ScrapedItemFiltersSortBy, "asc" | "desc"]

  // Re-sync local state whenever the URL's query string changes (covers
  // browser back/forward restoring a previously-filtered view). Skipped on
  // the very first run — the lazy useState initializers above already
  // derived the correct mount-time value (URL param, else remembered
  // preference, else default).
  const searchParamsString = searchParams.toString()
  useEffect(() => {
    if (!didMountSync.current) {
      didMountSync.current = true
      return
    }
    setSearch(searchParams.get(QP.search) ?? "")
    setDebouncedSearch(searchParams.get(QP.search) ?? "")
    setCategory((searchParams.get(QP.category) as ScrapedItemCategory | null) ?? "")
    setSourceId(searchParams.get(QP.source) ?? "")
    setDateFrom(searchParams.get(QP.dateFrom) ?? "")
    setDateTo(searchParams.get(QP.dateTo) ?? "")
    setSort((searchParams.get(QP.sort) as SortOption | null) ?? "publishedAt:desc")
    setPage(Number(searchParams.get(QP.page)) || 1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParamsString])

  // Remember filters/search/sort (not page) for the next visit, independent
  // of whether the URL still carries them.
  useEffect(() => {
    setStoredJSON(PREFS_KEY, {
      search: debouncedSearch,
      category,
      sourceId,
      dateFrom,
      dateTo,
      sort,
    } satisfies AdminNoticesPrefs)
  }, [debouncedSearch, category, sourceId, dateFrom, dateTo, sort])

  // Push current filter/sort/page state into the URL (no new history entry).
  useEffect(() => {
    const params = new URLSearchParams()
    if (debouncedSearch) params.set(QP.search, debouncedSearch)
    if (category) params.set(QP.category, category)
    if (sourceId) params.set(QP.source, sourceId)
    if (dateFrom) params.set(QP.dateFrom, dateFrom)
    if (dateTo) params.set(QP.dateTo, dateTo)
    if (sort !== "publishedAt:desc") params.set(QP.sort, sort)
    if (page > 1) params.set(QP.page, String(page))
    const qs = params.toString()
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch, category, sourceId, dateFrom, dateTo, sort, page])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetchScrapedItems({
        page,
        limit: PAGE_SIZE,
        category: category || undefined,
        sourceId: sourceId || undefined,
        search: debouncedSearch || undefined,
        dateFrom: dateFrom || undefined,
        dateTo: dateTo || undefined,
        sortBy,
        sortOrder,
      })
      setItems(res.data ?? [])
      setTotal(res.meta?.total ?? 0)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load notices")
    } finally {
      setLoading(false)
    }
  }, [page, category, sourceId, debouncedSearch, dateFrom, dateTo, sortBy, sortOrder])

  useEffect(() => {
    load()
  }, [load])

  function updateFilter<T>(setter: (v: T) => void) {
    return (value: T) => {
      setter(value)
      setPage(1)
    }
  }

  const setCategoryAndReset = updateFilter(setCategory)
  const setSourceIdAndReset = updateFilter(setSourceId)
  const setDateFromAndReset = updateFilter(setDateFrom)
  const setDateToAndReset = updateFilter(setDateTo)
  const setSortAndReset = updateFilter(setSort)

  function clearFilters() {
    setSearch("")
    setDebouncedSearch("")
    setCategory("")
    setSourceId("")
    setDateFrom("")
    setDateTo("")
    setSort("publishedAt:desc")
    setPage(1)
  }

  function openEditor(item: ScrapedItem) {
    setEditingItem(item)
    setEditCategory(item.category)
    setEditTags(item.tags?.join(", ") ?? "")
    setEditConfidence(item.aiCategoryConfidence ?? null)
  }

  function closeEditor() {
    setEditingItem(null)
    setEditing(false)
  }

  async function handleSaveEdit() {
    if (!editingItem) return
    setEditing(true)
    try {
      await correctScrapedItem(editingItem.id, {
        category: editCategory || undefined,
        tags: editTags.split(",").map((t) => t.trim()).filter(Boolean),
        aiCategoryConfidence: editConfidence ?? undefined,
      })
      toast.success("Notice updated")
      await load()
      closeEditor()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update notice")
    } finally {
      setEditing(false)
    }
  }

  async function handleReClassify() {
    if (!editingItem) return
    setEditing(true)
    try {
      await correctScrapedItem(editingItem.id, { reClassify: true })
      toast.success("Notice re-classified")
      await load()
      closeEditor()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Re-classification failed")
    } finally {
      setEditing(false)
    }
  }

  const activeFilterCount = [category, sourceId, dateFrom, dateTo, debouncedSearch].filter(Boolean).length

  async function handleDelete(id: string) {
    if (!(await confirm({ title: "Remove this notice from the list?", confirmLabel: "Remove", danger: true }))) return
    try {
      await deleteScrapedItem(id)
      toast.success("Notice removed")
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete notice")
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  const sourceName = useMemo(() => {
    const map = new Map(sources.map((s) => [s.id, s.name]))
    return (item: ScrapedItem) => (item.sourceId && map.get(item.sourceId)) || item.sourceLabel
  }, [sources])

  return (
    <div className="min-h-screen bg-white font-poppins">
      <Header />
      <AdminLayout>
        <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-[clamp(28px,3vw,40px)] font-normal leading-tight tracking-[-0.03em] text-vez-ink">
              Notice management.
            </h1>
            <p className="mt-2 text-sm text-vez-mute">{total.toLocaleString()} scraped notices &amp; news</p>
          </div>
          <div className="flex flex-col items-end gap-1.5">
            <div className="flex items-center gap-2">
              <button
                onClick={() => handleBulkReextract("garbled")}
                disabled={bulkReextracting}
                className="flex items-center gap-2 rounded-full bg-vez-navy px-5 py-2.5 text-sm text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                title="Re-run extraction on notices whose stored text is unreadable"
              >
                {bulkReextracting ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <RefreshCw className="size-4" />
                )}
                Fix unreadable extractions
              </button>
              <button
                onClick={() => handleBulkReextract("all")}
                disabled={bulkReextracting}
                className="rounded-full border border-vez-line px-4 py-2.5 text-sm text-vez-ink transition-colors hover:bg-vez-surface disabled:cursor-not-allowed disabled:opacity-50"
                title="Re-run extraction on every notice that has an attachment"
              >
                Re-extract all
              </button>
            </div>
            {bulkNote && (
              <p className={`text-xs ${bulkNote.tone === "error" ? "text-red-600" : "text-vez-mute"}`}>
                {bulkNote.text}
              </p>
            )}
          </div>
        </div>

        {error && (
          <div className="mb-6 rounded-[14px] bg-red-50 px-4 py-3 text-sm text-red-600">{error}</div>
        )}

        <div className="rounded-[20px] bg-white p-6">
          <div className="mb-5 flex flex-wrap items-center gap-3">
            <div className="relative max-w-sm flex-1">
              <Search className="absolute left-4 top-1/2 size-4 -translate-y-1/2 text-vez-mute" />
              <input
                placeholder="Search title or content…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className={`${inputClass} pl-11`}
              />
            </div>
            <button
              onClick={() => setShowFilters((v) => !v)}
              className={`flex items-center gap-2 rounded-full px-4 py-2.5 text-sm transition-colors ${
                showFilters ? "bg-vez-navy text-white" : "border border-vez-line text-vez-ink hover:bg-vez-surface"
              }`}
            >
              <SlidersHorizontal className="size-4" />
              Filters
              {activeFilterCount > 0 && (
                <span className="flex size-5 items-center justify-center rounded-full bg-white/20 text-[10px]">
                  {activeFilterCount}
                </span>
              )}
            </button>
            {activeFilterCount > 0 && (
              <button
                onClick={clearFilters}
                className="flex items-center gap-1.5 text-sm text-vez-mute transition-colors hover:text-vez-navy"
              >
                <X className="size-3.5" /> Clear
              </button>
            )}
          </div>

          {showFilters && (
            <div className="mb-6 grid grid-cols-1 gap-4 rounded-[14px] bg-vez-surface px-5 py-4 sm:grid-cols-2 lg:grid-cols-5">
              <div>
                <label className="mb-1 block text-xs text-vez-mute">Category</label>
                <select
                  value={category}
                  onChange={(e) => setCategoryAndReset(e.target.value as ScrapedItemCategory | "")}
                  className={`${fieldClass} h-10 py-0`}
                >
                  <option value="">All categories</option>
                  <option value="NOTICE">Notice</option>
                  <option value="NEWS">News</option>
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs text-vez-mute">Source</label>
                <select
                  value={sourceId}
                  onChange={(e) => setSourceIdAndReset(e.target.value)}
                  className={`${fieldClass} h-10 py-0`}
                >
                  <option value="">All sources</option>
                  {sources.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs text-vez-mute">Published from</label>
                <input
                  type="date"
                  value={dateFrom}
                  onChange={(e) => setDateFromAndReset(e.target.value)}
                  className={`${fieldClass} h-10 py-0`}
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-vez-mute">Published to</label>
                <input
                  type="date"
                  value={dateTo}
                  onChange={(e) => setDateToAndReset(e.target.value)}
                  className={`${fieldClass} h-10 py-0`}
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-vez-mute">Sort by</label>
                <select
                  value={sort}
                  onChange={(e) => setSortAndReset(e.target.value as SortOption)}
                  className={`${fieldClass} h-10 py-0`}
                >
                  <option value="publishedAt:desc">Newest published</option>
                  <option value="publishedAt:asc">Oldest published</option>
                  <option value="scrapedAt:desc">Recently scraped</option>
                  <option value="title:asc">Title (A–Z)</option>
                </select>
              </div>
            </div>
          )}

          {loading ? (
            <div className="flex items-center justify-center py-16 text-vez-mute">
              <Loader2 className="size-5 animate-spin" />
            </div>
          ) : items.length === 0 ? (
            <p className="py-16 text-center text-sm text-vez-mute">No notices match these filters.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-vez-line text-left">
                    <th className="pb-3 font-normal text-vez-mute">Title</th>
                    <th className="pb-3 font-normal text-vez-mute">Category</th>
                    <th className="pb-3 font-normal text-vez-mute">Source</th>
                    <th className="pb-3 font-normal text-vez-mute">Published</th>
                    <th className="pb-3 font-normal text-vez-mute">Scraped</th>
                    <th className="pb-3 font-normal text-vez-mute">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => (
                    <tr key={item.id} className="border-b border-vez-line/50 transition-colors hover:bg-vez-surface/60">
                      <td className="max-w-[320px] py-3.5 pr-4 text-vez-ink">
                        <span className="line-clamp-2">{item.title}</span>
                      </td>
                      <td className="py-3.5 pr-4">
                        <span className="rounded-full bg-vez-sky/30 px-3 py-1 text-xs capitalize text-vez-navy">
                          {item.category.toLowerCase()}
                        </span>
                      </td>
                      <td className="max-w-[160px] truncate py-3.5 pr-4 text-vez-mute">{sourceName(item)}</td>
                      <td className="whitespace-nowrap py-3.5 pr-4 text-vez-mute">
                        {item.publishedAt ? new Date(item.publishedAt).toLocaleDateString() : "—"}
                      </td>
                      <td className="whitespace-nowrap py-3.5 pr-4 text-vez-mute">
                        {new Date(item.scrapedAt).toLocaleDateString()}
                      </td>
                      <td className="py-3.5">
                        <div className="flex items-center gap-1">
                          <a
                            href={item.sourceUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex size-8 items-center justify-center rounded-full text-vez-mute transition-colors hover:bg-vez-surface hover:text-vez-navy"
                            aria-label="Open original source"
                          >
                            <ExternalLink className="size-3.5" />
                          </a>
                          <button
                            onClick={() => openEditor(item)}
                            className="flex size-8 items-center justify-center rounded-full text-vez-mute transition-colors hover:bg-vez-sky/20 hover:text-vez-sky"
                            aria-label="Edit category & tags"
                          >
                            <Edit className="size-3.5" />
                          </button>
                          <button
                            onClick={() => handleDelete(item.id)}
                            className="flex size-8 items-center justify-center rounded-full text-vez-mute transition-colors hover:bg-red-50 hover:text-red-600"
                            aria-label="Delete notice"
                          >
                            <Trash2 className="size-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {totalPages > 1 && (
            <div className="mt-5 flex items-center justify-between text-sm">
              <p className="text-vez-mute">
                Page {page} of {totalPages}
              </p>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page <= 1}
                  className="flex size-8 items-center justify-center rounded-full border border-vez-line text-vez-ink transition-colors hover:bg-vez-surface disabled:opacity-40"
                  aria-label="Previous page"
                >
                  <ChevronLeft className="size-4" />
                </button>
                <button
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={page >= totalPages}
                  className="flex size-8 items-center justify-center rounded-full border border-vez-line text-vez-ink transition-colors hover:bg-vez-surface disabled:opacity-40"
                  aria-label="Next page"
                >
                  <ChevronRight className="size-4" />
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Notice Editor Drawer */}
        {editingItem && (
          <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 px-4 py-6 sm:px-0" onClick={closeEditor}>
            <div className="w-full max-w-md bg-white rounded-t-[20px] sm:rounded-[20px] shadow-xl overflow-hidden animate-fade-in-up" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between border-b border-vez-line px-6 py-4">
                <h3 className="text-lg font-medium text-vez-ink">Edit notice</h3>
                <button onClick={closeEditor} className="flex size-8 items-center justify-center rounded-full text-vez-mute transition-colors hover:bg-vez-surface" aria-label="Close editor">
                  <X className="size-4" />
                </button>
              </div>

              <div className="p-6 space-y-5">
                <div>
                  <label className="mb-1 block text-xs text-vez-mute">Title</label>
                  <p className="text-sm text-vez-ink line-clamp-2">{editingItem.title}</p>
                </div>

                <div>
                  <label className="mb-1 block text-xs text-vez-mute">Category</label>
                  <select
                    value={editCategory}
                    onChange={(e) => setEditCategory(e.target.value as ScrapedItemCategory)}
                    className="w-full rounded-[12px] border border-vez-line bg-white px-4 py-3 text-sm text-vez-ink outline-none transition-colors focus:border-vez-sky"
                  >
                    <option value="NOTICE">Notice</option>
                    <option value="NEWS">News</option>
                    <option value="PRESS_RELEASE">Press Release</option>
                    <option value="CIRCULAR">Circular</option>
                    <option value="TENDER">Tender</option>
                    <option value="VACANCY">Vacancy</option>
                    <option value="JOB">Job</option>
                    <option value="INTERNSHIP">Internship</option>
                    <option value="OTHER">Other</option>
                  </select>
                </div>

                <div>
                  <label className="mb-1 block text-xs text-vez-mute">Tags (comma-separated)</label>
                  <input
                    type="text"
                    value={editTags}
                    onChange={(e) => setEditTags(e.target.value)}
                    placeholder="e.g. Kathmandu University, Ministry of Education, vacancy"
                    className="w-full rounded-[12px] border border-vez-line bg-white px-4 py-3 text-sm text-vez-ink outline-none transition-colors placeholder:text-vez-mute focus:border-vez-sky"
                  />
                  <p className="mt-1 text-xs text-vez-mute">Enter tags separated by commas</p>
                </div>

                <div>
                  <label className="mb-1 block text-xs text-vez-mute">AI Confidence</label>
                  <div className="flex items-center gap-3">
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      max="1"
                      value={editConfidence ?? 0}
                      onChange={(e) => setEditConfidence(e.target.value ? parseFloat(e.target.value) : null)}
                      className="w-24 rounded-[12px] border border-vez-line bg-white px-4 py-3 text-sm text-vez-ink outline-none transition-colors focus:border-vez-sky"
                    />
                    {editConfidence !== null && (
                      <BadgeCheck className={`size-5 ${editConfidence >= 0.7 ? "text-emerald-600" : editConfidence >= 0.5 ? "text-amber-600" : "text-red-600"}`} />
                    )}
                    <span className="text-xs text-vez-mute">
                      {editConfidence !== null ? Math.round(editConfidence * 100) + "%" : "—"}
                    </span>
                  </div>
                </div>

                <div className="flex flex-col sm:flex-row gap-3 pt-2">
                  <button
                    onClick={handleReClassify}
                    disabled={editing}
                    className="flex-1 flex items-center justify-center gap-2 rounded-full bg-vez-navy px-5 py-2.5 text-sm text-white transition-opacity disabled:opacity-50"
                  >
                    <RotateCcw className="size-4" />
                    Re-classify with AI
                  </button>
                  <button
                    onClick={handleSaveEdit}
                    disabled={editing}
                    className="flex-1 flex items-center justify-center gap-2 rounded-full border border-vez-line bg-white px-5 py-2.5 text-sm text-vez-ink transition-colors hover:bg-vez-surface disabled:opacity-50"
                  >
                    <ShieldCheck className="size-4" />
                    Save changes
                  </button>
                </div>

                <button
                  onClick={closeEditor}
                  className="flex w-full items-center justify-center gap-2 text-sm text-vez-mute transition-colors hover:text-vez-navy"
                >
                  <X className="size-3.5" />
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}
      </AdminLayout>
    </div>
  )
}

export default function AdminNoticesPage() {
  return (
    <Suspense fallback={null}>
      <AdminNoticesPageContent />
    </Suspense>
  )
}
