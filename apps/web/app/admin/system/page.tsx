"use client"

import React, { useCallback, useEffect, useState } from "react"
import Link from "next/link"
import {
  AlertCircle,
  ArrowUpRight,
  Bell,
  CheckCircle2,
  Cpu,
  Database,
  FileText,
  Globe,
  Loader2,
  MinusCircle,
  RefreshCw,
  Users,
  XCircle,
} from "lucide-react"
import { AdminLayout } from "@/components/admin/admin-layout"
import { Header } from "@/components/layout/header"
import { fetchSystemStatus } from "@/lib/api"
import type { ComponentHealth, SystemStatus } from "@/lib/types"

const STATUS_STYLE: Record<
  ComponentHealth,
  { label: string; dot: string; text: string; Icon: typeof CheckCircle2 }
> = {
  ok: { label: "Operational", dot: "bg-green-500", text: "text-green-700", Icon: CheckCircle2 },
  degraded: { label: "Degraded", dot: "bg-amber-500", text: "text-amber-700", Icon: AlertCircle },
  down: { label: "Down", dot: "bg-red-500", text: "text-red-600", Icon: XCircle },
  not_configured: {
    label: "Not configured",
    dot: "bg-vez-line",
    text: "text-vez-mute",
    Icon: MinusCircle,
  },
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const m = Math.floor(seconds / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

export default function AdminSystemPage() {
  const [status, setStatus] = useState<SystemStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // `silent` keeps the page rendered during auto-refresh — blanking a status
  // board every 30s would make a healthy system look like it was flapping.
  const load = useCallback(async (opts: { silent?: boolean } = {}) => {
    if (!opts.silent) setLoading(true)
    try {
      setStatus(await fetchSystemStatus())
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load system status")
    } finally {
      if (!opts.silent) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // Poll while the tab is open; this is a monitoring page, so stale numbers
  // are worse than a little extra traffic. Each check is cheap server-side.
  useEffect(() => {
    const timer = setInterval(() => void load({ silent: true }), 30_000)
    return () => clearInterval(timer)
  }, [load])

  const overall = status ? STATUS_STYLE[status.overall] : null

  return (
    <div className="min-h-screen bg-white font-poppins">
      <Header />
      <AdminLayout>
        <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-[clamp(28px,3vw,40px)] font-normal leading-tight tracking-[-0.03em] text-vez-ink">
              System.
            </h1>
            <p className="mt-2 text-sm text-vez-mute">
              Live health of every service this app depends on, measured on request.
            </p>
          </div>
          <div className="flex items-center gap-3">
            {status && (
              <span className="text-xs text-vez-mute">
                Checked {new Date(status.checkedAt).toLocaleTimeString()}
              </span>
            )}
            <button
              onClick={() => void load({ silent: true })}
              className="flex items-center gap-2 rounded-full border border-vez-line px-4 py-2.5 text-sm text-vez-ink transition-colors hover:bg-vez-surface"
            >
              <RefreshCw className="size-4" /> Refresh
            </button>
          </div>
        </div>

        {error && (
          <div className="mb-6 flex items-center gap-2 rounded-[14px] bg-red-50 px-4 py-3 text-sm text-red-600">
            <AlertCircle className="size-4 shrink-0" /> {error}
            <button onClick={() => load()} className="ml-auto font-medium underline underline-offset-2">
              Retry
            </button>
          </div>
        )}

        {loading ? (
          <div className="flex items-center gap-3 rounded-[20px] border border-vez-line bg-white p-10 text-sm text-vez-mute">
            <Loader2 className="size-4 animate-spin text-vez-navy" /> Checking every service…
          </div>
        ) : status ? (
          <div className="max-w-5xl space-y-5">
            {/* Overall banner */}
            <div
              className={`flex flex-wrap items-center gap-3 rounded-[20px] border p-4 sm:px-6 sm:py-5 ${
                status.overall === "ok"
                  ? "border-green-200 bg-green-50"
                  : status.overall === "down"
                    ? "border-red-200 bg-red-50"
                    : "border-amber-200 bg-amber-50"
              }`}
            >
              {overall && <overall.Icon className={`size-5 shrink-0 ${overall.text}`} />}
              <div className="min-w-0">
                <p className={`text-base font-medium ${overall?.text}`}>
                  {status.overall === "ok"
                    ? "All systems operational"
                    : status.overall === "down"
                      ? "One or more services are down"
                      : "Running with degraded services"}
                </p>
                <p className="mt-0.5 text-xs text-vez-mute">
                  {status.runtime.environment} · Node {status.runtime.nodeVersion} · API up{" "}
                  {formatUptime(status.runtime.uptimeSeconds)} · {status.runtime.memoryMb} MB RSS
                </p>
              </div>
            </div>

            {/* Dependencies */}
            <section className="overflow-hidden rounded-[20px] border border-vez-line bg-white">
              <div className="border-b border-vez-line p-4 sm:px-6 sm:py-4">
                <h2 className="text-sm sm:text-base font-medium text-vez-ink">Services</h2>
                <p className="mt-0.5 text-xs text-vez-mute">
                  Each row is checked live — nothing here is cached or assumed.
                </p>
              </div>
              {status.components.map((c, i) => {
                const s = STATUS_STYLE[c.status]
                return (
                  <div
                    key={c.id}
                    className={`flex flex-wrap items-center gap-x-4 gap-y-1 p-4 sm:px-6 sm:py-4 ${
                      i > 0 ? "border-t border-vez-line" : ""
                    }`}
                  >
                    <span className={`size-2.5 shrink-0 rounded-full ${s.dot}`} />
                    <span className="text-sm text-vez-ink">{c.label}</span>
                    <span className={`text-xs font-medium ${s.text}`}>{s.label}</span>
                    {c.latencyMs !== null && (
                      <span className="text-xs tabular-nums text-vez-mute">{c.latencyMs} ms</span>
                    )}
                    <span className="w-full text-xs text-vez-mute md:ml-auto md:w-auto md:max-w-[55%] md:text-right">
                      {c.detail}
                    </span>
                  </div>
                )
              })}
            </section>

            {/* Content counts — responsive grid */}
            <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4 sm:gap-6">
              {[
                { icon: FileText, label: "Notices", value: status.counts.notices },
                { icon: Database, label: "Documents", value: status.counts.documents },
                { icon: Users, label: "Users", value: status.counts.users },
                { icon: Globe, label: "Sources", value: status.counts.sources },
                { icon: Bell, label: "Alert rules", value: status.counts.alertRules },
              ].map((c) => (
                <div key={c.label} className="rounded-[16px] border border-vez-line bg-white p-4 sm:p-5">
                  <c.icon className="size-4 text-vez-navy" />
                  <p className="mt-3 text-2xl tabular-nums text-vez-ink">
                    {c.value.toLocaleString()}
                  </p>
                  <p className="text-xs text-vez-mute">{c.label}</p>
                </div>
              ))}
            </section>

            {/* Scraping posture */}
            <section className="overflow-hidden rounded-[20px] border border-vez-line bg-white">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-vez-line px-6 py-4">
                <div>
                  <h2 className="text-base font-medium text-vez-ink">Scraping</h2>
                  <p className="mt-0.5 text-xs text-vez-mute">
                    Scheduler{" "}
                    <span
                      className={status.scraping.schedulerEnabled ? "text-green-700" : "text-amber-700"}
                    >
                      {status.scraping.schedulerEnabled ? "enabled" : "disabled"}
                    </span>{" "}
                    · {status.scraping.enabledSources} enabled source
                    {status.scraping.enabledSources === 1 ? "" : "s"}
                  </p>
                </div>
                <Link
                  href="/admin/scraping"
                  className="flex items-center gap-1.5 rounded-full border border-vez-line px-4 py-2 text-xs text-vez-ink transition-colors hover:bg-vez-surface"
                >
                  Open scraping <ArrowUpRight className="size-3.5" />
                </Link>
              </div>

              <div className="flex flex-wrap gap-x-8 gap-y-2 px-6 py-4 text-sm">
                <span className="text-vez-ink">
                  <span className="tabular-nums">{status.scraping.runsLast24h}</span>{" "}
                  <span className="text-vez-mute">runs in 24h</span>
                </span>
                <span className={status.scraping.failedRunsLast24h > 0 ? "text-red-600" : "text-vez-ink"}>
                  <span className="tabular-nums">{status.scraping.failedRunsLast24h}</span>{" "}
                  <span className={status.scraping.failedRunsLast24h > 0 ? "" : "text-vez-mute"}>
                    failed in 24h
                  </span>
                </span>
              </div>

              {status.scraping.lastRun && (
                <div className="border-t border-vez-line px-6 py-4">
                  <p className="mb-1 text-xs uppercase tracking-wide text-vez-mute">Last run</p>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                    <span
                      className={`rounded-full px-2.5 py-0.5 text-[10px] font-medium uppercase ${
                        status.scraping.lastRun.status === "SUCCESS"
                          ? "bg-green-100 text-green-700"
                          : status.scraping.lastRun.status === "FAILED"
                            ? "bg-red-100 text-red-700"
                            : "bg-vez-sky/30 text-vez-navy"
                      }`}
                    >
                      {status.scraping.lastRun.status}
                    </span>
                    <span className="text-vez-ink">{status.scraping.lastRun.sourceLabel}</span>
                    <span className="text-xs text-vez-mute">
                      {status.scraping.lastRun.itemsFound} found ·{" "}
                      {status.scraping.lastRun.itemsNew} new ·{" "}
                      {new Date(status.scraping.lastRun.startedAt).toLocaleString()}
                    </span>
                  </div>
                  {status.scraping.lastRun.error && (
                    <p className="mt-2 break-words rounded-[10px] bg-red-50 px-3 py-2 text-xs text-red-600">
                      {status.scraping.lastRun.error}
                    </p>
                  )}
                </div>
              )}
            </section>

            <p className="flex items-center gap-2 px-1 text-xs text-vez-mute">
              <Cpu className="size-3.5" />
              LLM provider health is checked separately (it makes real billable calls) —{" "}
              <Link href="/admin/ai" className="text-vez-navy underline underline-offset-2">
                open AI &amp; Models
              </Link>
            </p>
          </div>
        ) : null}
      </AdminLayout>
    </div>
  )
}
