"use client"

import React, { useCallback, useEffect, useState } from "react"
import {
  Search,
  Mail,
  Trash2,
  Loader2,
  AlertCircle,
  X,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  Eye,
  CheckCheck,
  Archive,
  Reply,
  Clock,
} from "lucide-react"
import { AdminLayout } from "@/components/admin/admin-layout"
import { useConfirm } from "@/components/ui/confirm-dialog"
import { Header } from "@/components/layout/header"
import {
  fetchContactMessages,
  fetchContactCounts,
  updateContactStatus,
  deleteContactMessage,
  type ContactMessage,
  type ContactMessageStatus,
} from "@/lib/api"
import { toast } from "sonner"

const PAGE_SIZE = 20

const statusStyles: Record<ContactMessageStatus, string> = {
  NEW: "bg-vez-sky text-vez-navy border border-vez-sky",
  READ: "bg-vez-surface text-vez-ink border border-vez-line",
  REPLIED: "bg-emerald-50 text-emerald-700 border border-emerald-200",
  ARCHIVED: "bg-vez-line/40 text-vez-mute border border-vez-line",
}

const statusLabels: Record<ContactMessageStatus, string> = {
  NEW: "New",
  READ: "Read",
  REPLIED: "Replied",
  ARCHIVED: "Archived",
}

function formatDate(d: string) {
  return new Date(d).toLocaleString()
}

export default function AdminContactPage() {
  const confirm = useConfirm()
  const [messages, setMessages] = useState<ContactMessage[]>([])
  const [meta, setMeta] = useState({ page: 1, limit: PAGE_SIZE, total: 0, totalPages: 1 })
  const [counts, setCounts] = useState<{ total: number; byStatus: Record<string, number> } | null>(null)
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState("")
  const [debouncedSearch, setDebouncedSearch] = useState("")
  const [statusFilter, setStatusFilter] = useState<"" | ContactMessageStatus>("")
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<ContactMessage | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedSearch(search)
      setPage(1)
    }, 300)
    return () => clearTimeout(t)
  }, [search])

  useEffect(() => {
    setPage(1)
  }, [statusFilter])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [res, c] = await Promise.all([
        fetchContactMessages({
          page,
          limit: PAGE_SIZE,
          search: debouncedSearch || undefined,
          status: (statusFilter || undefined) as ContactMessageStatus | undefined,
        }),
        fetchContactCounts().catch(() => null),
      ])
      setMessages(res.data ?? [])
      setMeta(res.meta ?? { page, limit: PAGE_SIZE, total: 0, totalPages: 1 })
      if (c) setCounts(c)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load messages")
    } finally {
      setLoading(false)
    }
  }, [page, debouncedSearch, statusFilter])

  useEffect(() => {
    void load()
  }, [load])

  async function handleStatus(id: string, next: ContactMessageStatus) {
    setBusyId(id)
    try {
      await updateContactStatus(id, next)
      toast.success(`Marked as ${statusLabels[next]}`)
      // optimistic update in list
      setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, status: next } : m)))
      if (selected?.id === id) setSelected((prev) => (prev ? { ...prev, status: next } : null))
      // refresh counts
      fetchContactCounts().then(setCounts).catch(() => {})
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update")
    } finally {
      setBusyId(null)
    }
  }

  async function handleDelete(id: string) {
    if (!(await confirm({ title: "Delete this message permanently?", confirmLabel: "Delete", danger: true }))) return
    setBusyId(id)
    try {
      await deleteContactMessage(id)
      toast.success("Message deleted")
      if (selected?.id === id) setSelected(null)
      if (messages.length === 1 && page > 1) setPage((p) => p - 1)
      else void load()
      fetchContactCounts().then(setCounts).catch(() => {})
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete")
    } finally {
      setBusyId(null)
    }
  }

  function openMessage(m: ContactMessage) {
    setSelected(m)
    if (m.status === "NEW") {
      void handleStatus(m.id, "READ")
    }
  }

  const totalPages = meta.totalPages
  const activeFilterCount = [statusFilter, debouncedSearch].filter(Boolean).length

  return (
    <div className="min-h-screen bg-white font-poppins">
      <Header />
      <AdminLayout>
        <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-[clamp(28px,3vw,40px)] font-normal leading-tight tracking-[-0.03em] text-vez-ink">
              Contact inbox.
            </h1>
            <p className="mt-2 text-sm text-vez-mute">
              {loading ? "Loading…" : `${meta.total} message${meta.total === 1 ? "" : "s"}`}
              {counts && (
                <span className="ml-2 text-xs">
                  · {counts.byStatus.NEW ?? 0} new · {counts.byStatus.READ ?? 0} read · {counts.byStatus.ARCHIVED ?? 0} archived
                </span>
              )}
            </p>
          </div>
          <button
            onClick={() => void load()}
            className="flex items-center gap-1.5 rounded-full border border-vez-line px-4 py-2.5 text-xs text-vez-ink hover:bg-vez-surface"
          >
            <RefreshCw className="size-3.5" /> Refresh
          </button>
        </div>

        {/* Counts cards - responsive */}
        {counts && (
          <div className="mb-6 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6">
            {[
              { label: "Total", value: counts.total, key: "total" as const },
              { label: "New", value: counts.byStatus.NEW ?? 0, key: "NEW" as const },
              { label: "Read", value: counts.byStatus.READ ?? 0, key: "READ" as const },
              { label: "Replied", value: counts.byStatus.REPLIED ?? 0, key: "REPLIED" as const },
            ].map((c) => (
              <button
                key={c.label}
                onClick={() => setStatusFilter(c.key === "total" ? "" : (c.key as ContactMessageStatus))}
                className={`rounded-[16px] border bg-white p-4 text-left transition-colors ${statusFilter === c.key || (c.key === "total" && !statusFilter) ? "border-vez-navy bg-vez-sky/10" : "border-vez-line hover:bg-vez-surface/50"}`}
              >
                <p className="text-xs text-vez-mute">{c.label}</p>
                <p className="mt-1 text-xl text-vez-ink tabular-nums">{c.value}</p>
              </button>
            ))}
          </div>
        )}

        {error && (
          <div className="mb-6 flex items-center gap-2 rounded-[14px] bg-red-50 px-4 py-3 text-sm text-red-600">
            <AlertCircle className="size-4 shrink-0" /> {error}
          </div>
        )}

        <div className="rounded-[20px] bg-white p-4 sm:p-6">
          <div className="mb-5 flex flex-wrap items-center gap-3">
            <div className="relative max-w-sm flex-1 min-w-[220px]">
              <Search className="absolute left-4 top-1/2 size-4 -translate-y-1/2 text-vez-mute pointer-events-none" />
              <input
                placeholder="Search name, email, subject…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-11 min-h-[44px] w-full rounded-full border border-vez-line bg-white pl-11 pr-5 text-sm text-vez-ink outline-none placeholder:text-vez-mute focus:border-vez-sky"
              />
            </div>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as "" | ContactMessageStatus)}
              className="h-11 rounded-full border border-vez-line bg-white px-4 text-sm text-vez-ink outline-none focus:border-vez-sky"
            >
              <option value="">All statuses</option>
              <option value="NEW">New</option>
              <option value="READ">Read</option>
              <option value="REPLIED">Replied</option>
              <option value="ARCHIVED">Archived</option>
            </select>
            {activeFilterCount > 0 && (
              <button
                onClick={() => {
                  setSearch("")
                  setDebouncedSearch("")
                  setStatusFilter("")
                }}
                className="flex items-center gap-1.5 text-sm text-vez-mute hover:text-vez-navy"
              >
                <X className="size-3.5" /> Clear
              </button>
            )}
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-16 text-vez-mute">
              <Loader2 className="size-5 animate-spin" />
            </div>
          ) : messages.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-16 text-center">
              <Mail className="size-8 text-vez-mute/40" />
              <p className="text-sm text-vez-mute">{activeFilterCount > 0 ? "No messages match these filters." : "No messages yet. Contact submissions will appear here."}</p>
            </div>
          ) : (
            <>
              {/* Desktop table - scroll on overflow, cards on mobile */}
              <div className="hidden md:block overflow-x-auto rounded-lg border border-vez-line -mx-2 md:mx-0">
                <table className="w-full min-w-[640px] text-sm">
                  <thead>
                    <tr className="border-b border-vez-line text-left">
                      <th className="pb-3 font-normal text-vez-mute">From</th>
                      <th className="pb-3 font-normal text-vez-mute">Subject</th>
                      <th className="pb-3 font-normal text-vez-mute">Status</th>
                      <th className="pb-3 font-normal text-vez-mute">Date</th>
                      <th className="pb-3 font-normal text-vez-mute">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {messages.map((m) => (
                      <tr key={m.id} className="border-b border-vez-line/50 hover:bg-vez-surface/40">
                        <td className="py-3.5 pr-4">
                          <div className="min-w-0">
                            <p className="truncate text-vez-ink font-medium max-w-[180px]">{m.name}</p>
                            <p className="truncate text-xs text-vez-mute max-w-[180px]">{m.email}</p>
                          </div>
                        </td>
                        <td className="py-3.5 pr-4">
                          <button onClick={() => openMessage(m)} className="max-w-[260px] truncate text-left text-vez-ink hover:underline underline-offset-2">
                            {m.subject}
                          </button>
                          <p className="truncate text-xs text-vez-mute max-w-[260px]">{m.message.slice(0, 80)}</p>
                        </td>
                        <td className="py-3.5 pr-4">
                          <span className={`rounded-full px-2.5 py-1 text-xs border ${statusStyles[m.status]}`}>{statusLabels[m.status]}</span>
                        </td>
                        <td className="py-3.5 pr-4 text-xs text-vez-mute whitespace-nowrap">
                          <span className="flex items-center gap-1">
                            <Clock className="size-3" /> {formatDate(m.createdAt)}
                          </span>
                        </td>
                        <td className="py-3.5">
                          <div className="flex items-center gap-1">
                            <button
                              onClick={() => openMessage(m)}
                              className="flex size-8 items-center justify-center rounded-full text-vez-mute hover:bg-vez-surface hover:text-vez-navy"
                              aria-label="View"
                            >
                              <Eye className="size-3.5" />
                            </button>
                            <a
                              href={`mailto:${encodeURIComponent(m.email)}?subject=${encodeURIComponent(`Re: ${m.subject}`)}&body=${encodeURIComponent(`Hi ${m.name},\n\nRe: ${m.subject}\n\n`)}`}
                              className="flex size-8 items-center justify-center rounded-full text-vez-mute hover:bg-vez-surface hover:text-vez-navy"
                              aria-label="Reply by email"
                              title="Reply by email"
                            >
                              <Reply className="size-3.5" />
                            </a>
                            <button
                              onClick={() => void handleDelete(m.id)}
                              disabled={busyId === m.id}
                              className="flex size-8 items-center justify-center rounded-full text-vez-mute hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
                              aria-label="Delete"
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

              {/* Mobile cards */}
              <div className="grid gap-3 md:hidden">
                {messages.map((m) => (
                  <div key={m.id} className="rounded-2xl border border-vez-line/50 bg-vez-surface/50 p-4">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-vez-ink">{m.name}</p>
                        <p className="truncate text-xs text-vez-mute">{m.email}</p>
                      </div>
                      <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs border ${statusStyles[m.status]}`}>{statusLabels[m.status]}</span>
                    </div>
                    <button onClick={() => openMessage(m)} className="mt-3 block text-left">
                      <p className="text-sm font-medium text-vez-ink line-clamp-2">{m.subject}</p>
                      <p className="mt-1 text-xs text-vez-mute line-clamp-2">{m.message}</p>
                    </button>
                    <p className="mt-2 text-xs text-vez-mute">{formatDate(m.createdAt)}</p>
                    <div className="mt-3 flex items-center gap-2">
                      <button onClick={() => openMessage(m)} className="flex flex-1 items-center justify-center gap-1.5 rounded-full border border-vez-line bg-white px-3 py-2 text-xs">
                        <Eye className="size-3.5" /> View
                      </button>
                      <a
                        href={`mailto:${encodeURIComponent(m.email)}?subject=${encodeURIComponent(`Re: ${m.subject}`)}`}
                        className="flex flex-1 items-center justify-center gap-1.5 rounded-full border border-vez-line bg-white px-3 py-2 text-xs"
                      >
                        <Reply className="size-3.5" /> Reply
                      </a>
                      <button onClick={() => void handleDelete(m.id)} className="flex size-11 items-center justify-center rounded-full bg-red-50 text-red-600">
                        <Trash2 className="size-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>

              {totalPages > 1 && (
                <div className="mt-6 flex flex-wrap items-center justify-between gap-3 text-sm">
                  <p className="text-vez-mute">
                    Page {meta.page} of {totalPages} · {meta.total} total
                  </p>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      onClick={() => setPage((p) => Math.max(1, p - 1))}
                      disabled={page <= 1}
                      className="flex size-8 items-center justify-center rounded-full border border-vez-line disabled:opacity-40"
                    >
                      <ChevronLeft className="size-4" />
                    </button>
                    <button
                      onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                      disabled={page >= totalPages}
                      className="flex size-8 items-center justify-center rounded-full border border-vez-line disabled:opacity-40"
                    >
                      <ChevronRight className="size-4" />
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </AdminLayout>

      {/* Detail drawer */}
      {selected && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={() => setSelected(null)}>
          <div className="h-full w-full max-w-lg overflow-y-auto bg-white p-4 sm:p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <h3 className="text-base sm:text-lg text-vez-ink break-words">{selected.subject}</h3>
                <p className="text-sm text-vez-mute break-words">
                  From {selected.name} &lt;{selected.email}&gt; · {formatDate(selected.createdAt)}
                </p>
                {selected.ip && <p className="text-xs text-vez-mute">IP: {selected.ip}</p>}
              </div>
              <button onClick={() => setSelected(null)} className="rounded-full p-1.5 text-vez-mute hover:bg-vez-surface shrink-0">
                <X className="size-4" />
              </button>
            </div>

            <div className="mb-4 flex flex-wrap gap-2">
              <span className={`rounded-full px-3 py-1 text-xs border ${statusStyles[selected.status]}`}>{statusLabels[selected.status]}</span>
            </div>

            <div className="rounded-[14px] bg-vez-surface/60 p-4">
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-vez-ink">{selected.message}</p>
            </div>

            <div className="mt-6 grid grid-cols-2 gap-2">
              <button
                onClick={() => void handleStatus(selected.id, "READ")}
                disabled={busyId === selected.id}
                className="flex items-center justify-center gap-1.5 rounded-full border border-vez-line px-4 py-2.5 text-sm hover:bg-vez-surface disabled:opacity-50"
              >
                <Eye className="size-4" /> Mark read
              </button>
              <button
                onClick={() => void handleStatus(selected.id, "REPLIED")}
                disabled={busyId === selected.id}
                className="flex items-center justify-center gap-1.5 rounded-full bg-vez-navy px-4 py-2.5 text-sm text-white hover:opacity-90 disabled:opacity-50"
              >
                <CheckCheck className="size-4" /> Mark replied
              </button>
              <button
                onClick={() => void handleStatus(selected.id, "ARCHIVED")}
                disabled={busyId === selected.id}
                className="flex items-center justify-center gap-1.5 rounded-full border border-vez-line px-4 py-2.5 text-sm hover:bg-vez-surface disabled:opacity-50"
              >
                <Archive className="size-4" /> Archive
              </button>
              <a
                href={`mailto:${encodeURIComponent(selected.email)}?subject=${encodeURIComponent(`Re: ${selected.subject}`)}&body=${encodeURIComponent(`Hi ${selected.name},\n\n`)}`}
                className="flex items-center justify-center gap-1.5 rounded-full border border-vez-line px-4 py-2.5 text-sm hover:bg-vez-surface"
              >
                <Reply className="size-4" /> Reply via email
              </a>
            </div>

            <button
              onClick={() => void handleDelete(selected.id)}
              disabled={busyId === selected.id}
              className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-full bg-red-50 px-4 py-2.5 text-sm text-red-600 hover:bg-red-100 disabled:opacity-50"
            >
              <Trash2 className="size-4" /> Delete message
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
