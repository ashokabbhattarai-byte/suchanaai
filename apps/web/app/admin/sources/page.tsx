"use client"

import React, { useState } from "react"
import {
  Plus,
  Play,
  Edit,
  Trash2,
  Info,
  Loader2,
  ToggleLeft,
  ToggleRight,
  X,
} from "lucide-react"
import { AdminLayout } from "@/components/admin/admin-layout"
import { Header } from "@/components/layout/header"

interface ScrapingSource {
  id: string
  name: string
  url: string
  category: string
  frequency: string
  status: "active" | "inactive"
  lastScraped: string | null
  notes: string
}

const defaultSources: ScrapingSource[] = [
  {
    id: "src-1",
    name: "Ministry of Foreign Affairs",
    url: "https://mofa.gov.np/",
    category: "Policy / Administrative",
    frequency: "Daily",
    status: "active",
    lastScraped: "2026-06-02T06:00:00Z",
    notes: "Official MoFA notices and circulars",
  },
  {
    id: "src-2",
    name: "Nepal Gazette Online",
    url: "https://rajpatra.dop.gov.np",
    category: "Policy",
    frequency: "Daily",
    status: "active",
    lastScraped: "2026-06-02T06:00:00Z",
    notes: "Government gazette publications",
  },
  {
    id: "src-3",
    name: "Public Procurement Portal",
    url: "https://bolpatra.gov.np",
    category: "Tender",
    frequency: "Every 6 hours",
    status: "active",
    lastScraped: "2026-06-02T08:00:00Z",
    notes: "All public procurement notices",
  },
  {
    id: "src-4",
    name: "PSC Official Website",
    url: "https://psc.gov.np",
    category: "Exam",
    frequency: "Daily",
    status: "active",
    lastScraped: "2026-06-01T22:00:00Z",
    notes: "Public Service Commission exam notices",
  },
  {
    id: "src-5",
    name: "MoE Job Portal",
    url: "https://education.gov.np/vacancies",
    category: "Job",
    frequency: "Every 12 hours",
    status: "inactive",
    lastScraped: "2026-05-30T12:00:00Z",
    notes: "Education ministry vacancies (currently down)",
  },
]

const categoryOptions = ["Job", "Exam", "Tender", "Policy", "Policy / Administrative", "Other"]
const frequencyOptions = ["Daily", "Every 6 hours", "Every 12 hours", "Weekly", "Manual"]

const inputClass =
  "h-11 w-full rounded-full border border-vez-line bg-white px-5 text-sm text-vez-ink outline-none transition-colors placeholder:text-vez-mute focus:border-vez-sky"

const selectClass =
  "h-11 w-full rounded-full border border-vez-line bg-white px-4 text-sm text-vez-ink outline-none transition-colors focus:border-vez-sky"

export default function AdminSourcesPage() {
  const [sources, setSources] = useState<ScrapingSource[]>(defaultSources)
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [scrapingId, setScrapingId] = useState<string | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null)
  const [form, setForm] = useState({
    name: "",
    url: "",
    category: "Job",
    frequency: "Daily",
    notes: "",
  })
  const [formErrors, setFormErrors] = useState<Record<string, string>>({})

  const validateForm = () => {
    const errors: Record<string, string> = {}
    if (!form.name.trim()) errors.name = "Source name is required"
    if (!form.url.trim()) errors.url = "URL is required"
    else {
      try {
        new URL(form.url)
      } catch {
        errors.url = "Please enter a valid URL"
      }
    }
    setFormErrors(errors)
    return Object.keys(errors).length === 0
  }

  const handleSubmit = () => {
    if (!validateForm()) return
    if (editingId) {
      setSources(sources.map(s =>
        s.id === editingId ? { ...s, name: form.name, url: form.url, category: form.category, frequency: form.frequency, notes: form.notes } : s
      ))
    } else {
      setSources([...sources, {
        id: `src-${Date.now()}`,
        name: form.name,
        url: form.url,
        category: form.category,
        frequency: form.frequency,
        status: "active",
        lastScraped: null,
        notes: form.notes,
      }])
    }
    resetForm()
  }

  const resetForm = () => {
    setForm({ name: "", url: "", category: "Job", frequency: "Daily", notes: "" })
    setFormErrors({})
    setShowForm(false)
    setEditingId(null)
  }

  const startEdit = (source: ScrapingSource) => {
    setForm({ name: source.name, url: source.url, category: source.category, frequency: source.frequency, notes: source.notes })
    setEditingId(source.id)
    setShowForm(true)
  }

  const toggleSource = (id: string) => {
    setSources(sources.map(s =>
      s.id === id ? { ...s, status: s.status === "active" ? "inactive" : "active" } : s
    ))
  }

  const deleteSource = (id: string) => {
    setSources(sources.filter(s => s.id !== id))
    setDeleteConfirm(null)
  }

  const triggerScrape = (id: string) => {
    setScrapingId(id)
    setTimeout(() => {
      setSources(sources.map(s =>
        s.id === id ? { ...s, lastScraped: new Date().toISOString() } : s
      ))
      setScrapingId(null)
    }, 2000)
  }

  return (
    <div className="min-h-screen bg-white font-poppins">
      <Header />
      <AdminLayout>
        <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-[clamp(28px,3vw,40px)] font-normal leading-tight tracking-[-0.03em] text-vez-ink">
              Scraping sources.
            </h1>
            <p className="mt-2 text-sm text-vez-mute">Manage URLs to scrape for notices</p>
          </div>
          <button
            className="flex items-center gap-2 rounded-full bg-vez-navy px-5 py-2.5 text-sm text-white transition-opacity hover:opacity-90"
            onClick={() => { resetForm(); setShowForm(true) }}
          >
            <Plus className="size-4" /> Add source
          </button>
        </div>

        {/* Info Banner */}
        <div className="mb-6 flex items-start gap-3 rounded-[16px] bg-vez-sky/25 p-4 sm:p-5">
          <Info className="mt-0.5 size-5 shrink-0 text-vez-navy" />
          <p className="text-sm text-vez-ink/80">
            More sources can be added here. Each source will be scraped on schedule and notices will be automatically classified and indexed.
          </p>
        </div>

        {/* Add/Edit Form */}
        {showForm && (
          <div className="mb-6 rounded-[20px] bg-white p-4 sm:p-6 md:p-8 w-full overflow-hidden">
            <div className="mb-6 flex items-center justify-between">
              <h2 className="text-lg text-vez-ink">{editingId ? "Edit source" : "Add new source"}</h2>
              <button
                className="flex size-9 items-center justify-center rounded-full text-vez-mute transition-colors hover:bg-vez-surface hover:text-vez-navy"
                onClick={resetForm}
                aria-label="Close form"
              >
                <X className="size-4" />
              </button>
            </div>
            <div className="space-y-5">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 sm:gap-6">
                <div>
                  <label className="mb-2 block text-sm text-vez-mute">Source name *</label>
                  <input
                    placeholder="e.g. Ministry of Foreign Affairs"
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    className={inputClass}
                  />
                  {formErrors.name && <p className="mt-1.5 text-xs text-red-600">{formErrors.name}</p>}
                </div>
                <div>
                  <label className="mb-2 block text-sm text-vez-mute">URL *</label>
                  <input
                    placeholder="https://example.gov.np/"
                    value={form.url}
                    onChange={(e) => setForm({ ...form, url: e.target.value })}
                    className={inputClass}
                  />
                  {formErrors.url && <p className="mt-1.5 text-xs text-red-600">{formErrors.url}</p>}
                </div>
                <div>
                  <label className="mb-2 block text-sm text-vez-mute">Notice category</label>
                  <select
                    value={form.category}
                    onChange={(e) => setForm({ ...form, category: e.target.value })}
                    className={selectClass}
                  >
                    {categoryOptions.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                <div>
                  <label className="mb-2 block text-sm text-vez-mute">Scrape frequency</label>
                  <select
                    value={form.frequency}
                    onChange={(e) => setForm({ ...form, frequency: e.target.value })}
                    className={selectClass}
                  >
                    {frequencyOptions.map(f => <option key={f} value={f}>{f}</option>)}
                  </select>
                </div>
              </div>
              <div>
                <label className="mb-2 block text-sm text-vez-mute">Notes / description</label>
                <input
                  placeholder="Brief description of this source…"
                  value={form.notes}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })}
                  className={inputClass}
                />
              </div>
              <div className="flex gap-2.5">
                <button
                  onClick={handleSubmit}
                  className="rounded-full bg-vez-navy px-5 py-2.5 text-sm text-white transition-opacity hover:opacity-90"
                >
                  {editingId ? "Save changes" : "Add source"}
                </button>
                <button
                  onClick={resetForm}
                  className="rounded-full px-5 py-2.5 text-sm text-vez-mute transition-colors hover:bg-vez-surface hover:text-vez-navy"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Sources Table - responsive, cards on mobile */}
        <div className="overflow-hidden rounded-[20px] bg-white p-4 sm:p-6">
          <div className="hidden md:block overflow-x-auto rounded-lg border border-vez-line">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b border-vez-line text-left">
                  <th className="p-5 font-normal text-vez-mute">Source</th>
                  <th className="p-5 font-normal text-vez-mute">Category</th>
                  <th className="p-5 font-normal text-vez-mute">Frequency</th>
                  <th className="p-5 font-normal text-vez-mute">Status</th>
                  <th className="p-5 font-normal text-vez-mute">Last scraped</th>
                  <th className="p-5 font-normal text-vez-mute">Actions</th>
                </tr>
              </thead>
              <tbody>
                {sources.map((source) => (
                  <tr key={source.id} className="border-b border-vez-line/50 transition-colors last:border-0 hover:bg-vez-surface/60">
                    <td className="p-5">
                      <div>
                        <p className="text-vez-ink">{source.name}</p>
                        <p className="max-w-[200px] truncate text-xs text-vez-mute">{source.url}</p>
                      </div>
                    </td>
                    <td className="p-5">
                      <span className="rounded-full bg-vez-sky/30 px-3 py-1 text-xs text-vez-navy">{source.category}</span>
                    </td>
                    <td className="p-5 text-vez-mute">{source.frequency}</td>
                    <td className="p-5">
                      <button onClick={() => toggleSource(source.id)} className="flex items-center gap-1.5">
                        {source.status === "active" ? (
                          <>
                            <ToggleRight className="size-5 text-vez-navy" />
                            <span className="text-xs text-vez-navy">Active</span>
                          </>
                        ) : (
                          <>
                            <ToggleLeft className="size-5 text-vez-mute" />
                            <span className="text-xs text-vez-mute">Inactive</span>
                          </>
                        )}
                      </button>
                    </td>
                    <td className="p-5 text-xs text-vez-mute">
                      {source.lastScraped
                        ? new Date(source.lastScraped).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
                        : "Never"
                      }
                    </td>
                    <td className="p-5">
                      <div className="flex items-center gap-1.5">
                        <button
                          className="flex items-center gap-1 rounded-full border border-vez-line px-3.5 py-1.5 text-xs text-vez-ink transition-colors hover:bg-vez-surface disabled:cursor-not-allowed disabled:opacity-50"
                          onClick={() => triggerScrape(source.id)}
                          disabled={scrapingId === source.id || source.status === "inactive"}
                        >
                          {scrapingId === source.id ? (
                            <><Loader2 className="size-3 animate-spin" /> Scraping…</>
                          ) : (
                            <><Play className="size-3" /> Scrape</>
                          )}
                        </button>
                        <button
                          className="flex size-8 items-center justify-center rounded-full text-vez-mute transition-colors hover:bg-vez-surface hover:text-vez-navy"
                          onClick={() => startEdit(source)}
                          aria-label="Edit source"
                        >
                          <Edit className="size-3.5" />
                        </button>
                        {deleteConfirm === source.id ? (
                          <div className="flex items-center gap-1">
                            <button
                              className="rounded-full bg-red-600 px-3.5 py-1.5 text-xs text-white transition-opacity hover:opacity-90"
                              onClick={() => deleteSource(source.id)}
                            >
                              Confirm
                            </button>
                            <button
                              className="rounded-full px-3.5 py-1.5 text-xs text-vez-mute transition-colors hover:bg-vez-surface"
                              onClick={() => setDeleteConfirm(null)}
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <button
                            className="flex size-8 items-center justify-center rounded-full text-vez-mute transition-colors hover:bg-red-50 hover:text-red-600"
                            onClick={() => setDeleteConfirm(source.id)}
                            aria-label="Delete source"
                          >
                            <Trash2 className="size-3.5" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* Mobile cards */}
          <div className="grid gap-3 md:hidden mt-4">
            {sources.map((source) => (
              <div key={source.id} className="rounded-2xl border border-vez-line/50 bg-vez-surface/50 p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-vez-ink">{source.name}</p>
                    <p className="truncate text-xs text-vez-mute">{source.url}</p>
                  </div>
                  <span className="shrink-0 rounded-full bg-vez-sky/30 px-2.5 py-0.5 text-xs text-vez-navy">{source.category}</span>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-vez-mute">
                  <span>{source.frequency}</span>
                  <span>·</span>
                  <button onClick={() => toggleSource(source.id)} className="flex items-center gap-1">
                    {source.status === "active" ? <><ToggleRight className="size-4 text-vez-navy" /><span className="text-vez-navy">Active</span></> : <><ToggleLeft className="size-4 text-vez-mute" /><span>Inactive</span></>}
                  </button>
                </div>
                <p className="mt-2 text-xs text-vez-mute">{source.lastScraped ? new Date(source.lastScraped).toLocaleString() : "Never"}</p>
                <div className="mt-3 flex items-center gap-2">
                  <button onClick={() => triggerScrape(source.id)} disabled={scrapingId === source.id || source.status === "inactive"} className="flex flex-1 items-center justify-center gap-1 rounded-full border border-vez-line bg-white px-3 py-2 text-xs disabled:opacity-50">{scrapingId === source.id ? <><Loader2 className="size-3 animate-spin" /> Scraping…</> : <><Play className="size-3" /> Scrape</>}</button>
                  <button onClick={() => startEdit(source)} className="flex size-10 items-center justify-center rounded-full bg-white border border-vez-line text-vez-mute"><Edit className="size-3.5" /></button>
                  <button onClick={() => setDeleteConfirm(source.id)} className="flex size-10 items-center justify-center rounded-full bg-red-50 text-red-600"><Trash2 className="size-3.5" /></button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </AdminLayout>
    </div>
  )
}
