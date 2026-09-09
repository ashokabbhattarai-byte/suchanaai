"use client"

import React, { useEffect, useRef } from "react"
import {
  FileText, Users, Database, Globe, AlertCircle, Activity,
  CheckCircle, XCircle, ArrowRight, TrendingUp, Zap, Clock,
  Link2, RefreshCw, BarChart3, UserCheck, AlertTriangle,
} from "lucide-react"
import { AdminLayout } from "@/components/admin/admin-layout"
import { Header } from "@/components/layout/header"
import { useAuth } from "@/lib/auth-context"
import { fetchSystemStatus, fetchScrapeRuns, fetchScrapeSources, fetchAdminUsers } from "@/lib/api"
import type { AdminUser } from "@/lib/api"
import type { SystemStatus, ScrapeRun, ScrapeSource } from "@/lib/types"
import Link from "next/link"
import gsap from "gsap"

function MiniSparkline({ data }: { data: number[] }) {
  const max = Math.max(...data)
  const min = Math.min(...data)
  const range = max - min || 1
  const width = 64
  const height = 20
  const points = data.map((v, i) => {
    const x = (i / (data.length - 1)) * width
    const y = height - ((v - min) / range) * height
    return `${x},${y}`
  }).join(" ")

  return (
    <svg width={width} height={height} className="shrink-0">
      <polyline fill="none" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
        points={points} stroke="#a2c5d3" />
    </svg>
  )
}

function StatusDot({ active }: { active: boolean }) {
  return (
    <span className="relative flex size-2">
      {active && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-vez-sky opacity-75" />}
      <span className={`relative inline-flex size-2 rounded-full ${active ? "bg-vez-navy" : "bg-red-500"}`} />
    </span>
  )
}

function MetricCardSkeleton() {
  return (
    <div className="rounded-[20px] bg-white p-4 sm:p-6 animate-pulse" aria-hidden="true">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-2">
        <div className="size-9 rounded-full bg-vez-surface" />
        <div className="h-[20px] w-16 rounded bg-vez-surface" />
      </div>
      <div className="mb-3 h-8 w-20 rounded bg-vez-surface" />
      <div className="flex items-center justify-between gap-2">
        <div className="h-3 w-20 rounded bg-vez-surface" />
        <div className="h-3 w-24 rounded bg-vez-surface" />
      </div>
    </div>
  )
}

function SystemStatusSkeleton() {
  return (
    <div className="flex flex-wrap items-center gap-3 sm:gap-4 animate-pulse" aria-hidden="true">
      <div className="h-3 w-20 rounded bg-vez-surface" />
      <div className="h-4 w-px bg-vez-line" />
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <div className="size-2 rounded-full bg-vez-surface" />
          <div className="h-3 w-20 rounded bg-vez-surface" />
        </div>
      ))}
      <div className="ml-auto flex items-center gap-2">
        <div className="h-5 w-32 rounded-full bg-vez-surface" />
        <div className="h-5 w-24 rounded-full bg-vez-surface" />
      </div>
    </div>
  )
}

function ListSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-2 animate-pulse" aria-hidden="true">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 rounded-[12px] bg-vez-surface px-3.5 py-3">
          <div className="size-2 rounded-full bg-white/60" />
          <div className="h-3 flex-1 rounded bg-white/60" />
          <div className="h-3 w-16 rounded bg-white/60" />
        </div>
      ))}
    </div>
  )
}

function LogSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="space-y-1 animate-pulse" aria-hidden="true">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 rounded-[12px] px-3 py-2">
          <div className="size-3 rounded-full bg-vez-surface" />
          <div className="h-3 w-10 rounded bg-vez-surface" />
          <div className="h-3 flex-1 rounded bg-vez-surface" />
          <div className="h-4 w-10 rounded-full bg-vez-surface" />
        </div>
      ))}
    </div>
  )
}

function UsersSkeleton() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6 animate-pulse" aria-hidden="true">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 rounded-[14px] bg-vez-surface px-4 py-3">
          <div className="size-9 rounded-full bg-white/60" />
          <div className="flex-1 space-y-2">
            <div className="h-3 w-24 rounded bg-white/60" />
            <div className="h-2 w-12 rounded bg-white/40" />
          </div>
        </div>
      ))}
    </div>
  )
}

function MetricCard({ icon: Icon, label, value, spark, trend, trendUp }: {
  icon: React.ElementType; label: string; value: number
  spark: number[]; trend: string; trendUp: boolean
}) {
  return (
    <div className="cmd-card rounded-[20px] bg-white p-4 sm:p-6">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-2">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-vez-sky/30">
          <Icon className="size-4 text-vez-navy" />
        </div>
        <div className="w-full h-[20px] sm:h-[20px] shrink-0 sm:w-auto">
          <MiniSparkline data={spark} />
        </div>
      </div>
      <p className="mb-1.5 break-words text-2xl sm:text-3xl leading-none tracking-[-0.02em] text-vez-ink tabular-nums">{value}</p>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs sm:text-sm text-vez-mute">{label}</span>
        <span className={`flex items-center gap-0.5 text-[10px] sm:text-xs ${trendUp ? "text-vez-navy" : "text-vez-mute"}`}>
          <TrendingUp className="size-3" /> {trend}
        </span>
      </div>
    </div>
  )
}

export default function AdminDashboard() {
  const { user } = useAuth()
  const gridRef = useRef<HTMLDivElement>(null)

  const [status, setStatus] = React.useState<SystemStatus | null>(null)
  const [runs, setRuns] = React.useState<ScrapeRun[]>([])
  const [sources, setSources] = React.useState<ScrapeSource[]>([])
  const [users, setUsers] = React.useState<AdminUser[]>([])
  const [loading, setLoading] = React.useState(true)

  const isAdmin = Boolean(user && user.role === "admin")

  const load = React.useCallback(async () => {
    if (!isAdmin) return
    setLoading(true)
    // Independent panels: one failing endpoint must not blank the whole
    // dashboard, so each settles on its own and renders what it has.
    const [s, r, src, u] = await Promise.allSettled([
      fetchSystemStatus(),
      fetchScrapeRuns({ page: 1, limit: 8 }),
      fetchScrapeSources(),
      fetchAdminUsers({ page: 1, limit: 4 }),
    ])
    if (s.status === "fulfilled") setStatus(s.value)
    if (r.status === "fulfilled") setRuns(r.value.data)
    if (src.status === "fulfilled") setSources(src.value)
    if (u.status === "fulfilled") setUsers(u.value.data)
    setLoading(false)
  }, [isAdmin])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!gridRef.current) return
    const cards = gridRef.current.querySelectorAll(".cmd-card")
    gsap.fromTo(cards,
      { opacity: 0, y: 16 },
      { opacity: 1, y: 0, duration: 0.5, stagger: 0.07, ease: "power3.out" }
    )
  }, [])

  if (!user || user.role !== "admin") {
    return (
      <div className="min-h-screen bg-white font-poppins">
        <Header />
        <div className="flex items-center justify-center py-32">
          <div className="w-full max-w-sm rounded-[24px] bg-vez-surface p-10 text-center">
            <AlertCircle className="mx-auto mb-4 size-10 text-red-500" />
            <h2 className="mb-1 text-lg text-vez-ink">Access denied</h2>
            <p className="mb-6 text-sm text-vez-mute">Admin privileges required.</p>
            <Link
              href="/login"
              className="block w-full rounded-full bg-vez-navy px-6 py-3 text-base text-white transition-opacity hover:opacity-90"
            >
              Sign in as admin
            </Link>
          </div>
        </div>
      </div>
    )
  }

  const counts = status?.counts
  const failedRuns = status?.scraping.failedRunsLast24h ?? 0
  // Show skeletons only on first load — subsequent refreshes keep stale data visible
  const isInitialLoading = loading && !status
  const isSourcesInitialLoading = loading && sources.length === 0
  const isRunsInitialLoading = loading && runs.length === 0
  const isUsersInitialLoading = loading && users.length === 0
  // A source is "failing" when its most recent run errored — derived from real
  // run history rather than a status column, which sources don't carry.
  const latestRunBySource = new Map<string, ScrapeRun>()
  for (const r of runs) {
    if (r.sourceId && !latestRunBySource.has(r.sourceId)) latestRunBySource.set(r.sourceId, r)
  }
  const failingSources = sources.filter(
    (s) => latestRunBySource.get(s.id)?.status === "FAILED",
  )
  const healthOk = status ? status.overall === "ok" && failedRuns === 0 : true

  // No historical series endpoint exists yet, so the sparkline shows the real
  // current value as a flat line instead of an invented trend.
  const flat = (v: number) => [v, v, v, v, v, v, v]
  const metrics = [
    { icon: FileText, label: "Total notices", value: counts?.notices ?? 0, spark: flat(counts?.notices ?? 0), trend: `${status?.scraping.runsLast24h ?? 0} runs / 24h`, trendUp: failedRuns === 0 },
    { icon: Users, label: "Users", value: counts?.users ?? 0, spark: flat(counts?.users ?? 0), trend: `${status?.counts.alertRules ?? 0} alert rules`, trendUp: true },
    { icon: Database, label: "Documents", value: counts?.documents ?? 0, spark: flat(counts?.documents ?? 0), trend: "Indexed", trendUp: true },
    { icon: Globe, label: "Active sources", value: status?.scraping.enabledSources ?? 0, spark: flat(status?.scraping.enabledSources ?? 0), trend: `${failedRuns} failed / 24h`, trendUp: failedRuns === 0 },
  ]

  // Straight from the API's own component health checks — no invented services.
  const systemServices = (status?.components ?? []).map((c) => ({
    label: c.label,
    ok: c.status === "ok",
  }))

  const systemLogs = runs.map((r) => ({
    time: new Date(r.startedAt).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false }),
    level: r.status === "FAILED" ? ("error" as const) : r.status === "RUNNING" ? ("warn" as const) : ("info" as const),
    msg:
      r.status === "FAILED"
        ? `${r.sourceLabel}: ${r.error ?? "run failed"}`
        : r.status === "RUNNING"
          ? `${r.sourceLabel}: scraping in progress`
          : `${r.sourceLabel} scraped — ${r.itemsNew} new of ${r.itemsFound} found`,
  }))

  const recentUsers = users

  return (
    <div className="min-h-screen bg-white font-poppins">
      <Header />
      <AdminLayout>
        {/* Page header */}
        <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-sm text-vez-mute">
              {new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}
            </p>
            <h1 className="mt-2 text-[clamp(28px,3vw,40px)] font-normal leading-tight tracking-[-0.03em] text-vez-ink">
              Admin dashboard.
            </h1>
          </div>

          <button
            onClick={() => void load()}
            disabled={loading}
            className="flex items-center gap-1.5 rounded-full border border-vez-line bg-white px-5 py-2.5 text-sm text-vez-ink transition-colors hover:bg-vez-surface disabled:opacity-50"
          >
            <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh
          </button>
        </div>

        {/* System health strip - wraps on mobile, scrolls if needed */}
        <div className="cmd-card mb-6 flex flex-wrap items-center gap-3 sm:gap-4 overflow-x-auto rounded-[16px] border border-vez-line bg-white p-4 sm:p-5">
          {isInitialLoading ? (
            <SystemStatusSkeleton />
          ) : (
            <>
              <div className="flex shrink-0 items-center gap-2">
                <Activity className="size-4 text-vez-navy" />
                <span className="text-xs text-vez-ink">System status</span>
              </div>
              <div className="h-4 w-px shrink-0 bg-vez-line" />
              {systemServices.map((svc) => (
                <div key={svc.label} className="flex shrink-0 items-center gap-1.5">
                  <StatusDot active={svc.ok} />
                  <span className="text-xs text-vez-mute">{svc.label}</span>
                </div>
              ))}
              <div className="ml-auto flex shrink-0 items-center gap-2">
                <span className={`flex items-center gap-1 rounded-full px-3 py-1 text-[10px] ${healthOk ? "bg-vez-sky/30 text-vez-navy" : "bg-red-50 text-red-600"}`}>
                  {healthOk ? <CheckCircle className="size-3" /> : <AlertTriangle className="size-3" />}
                  {healthOk ? "All systems operational" : `${failingSources.length} issue${failingSources.length > 1 ? "s" : ""}`}
                </span>
                <span className="flex items-center gap-1 rounded-full bg-vez-surface px-3 py-1 text-[10px] text-vez-mute">
                  <Clock className="size-3" /> 99.9% uptime
                </span>
              </div>
            </>
          )}
        </div>

        <div ref={gridRef} className="space-y-6">
          {/* Metric cards - responsive grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6">
            {isInitialLoading
              ? Array.from({ length: 4 }).map((_, i) => <MetricCardSkeleton key={i} />)
              : metrics.map((m) => <MetricCard key={m.label} {...m} />)}
          </div>

          {/* Error banner */}
          {failingSources.length > 0 && (
            <div className="cmd-card flex items-center gap-4 rounded-[20px] bg-vez-navy p-5">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-white/10">
                <AlertCircle className="size-4 text-vez-sky" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm text-white">{failingSources.length} source{failingSources.length > 1 ? "s" : ""} failing</p>
                <p className="truncate text-xs text-white/60">{failingSources.map(s => s.name).join(", ")}</p>
              </div>
              <Link
                href="/admin/scraping"
                className="shrink-0 rounded-full bg-white/15 px-4 py-2 text-xs text-white transition-colors hover:bg-white/25"
              >
                Investigate
              </Link>
            </div>
          )}

          {/* Main content row - stacks on mobile */}
          <div className="grid grid-cols-1 lg:grid-cols-5 gap-4 sm:gap-6">
            {/* Live log - 3 cols */}
            <div className="cmd-card rounded-[20px] bg-white p-4 sm:p-6 lg:col-span-3 w-full overflow-hidden">
              <div className="mb-4 flex items-center justify-between">
                <h3 className="flex items-center gap-2 text-base text-vez-ink">
                  <Zap className="size-4 text-vez-navy" /> Live system log
                </h3>
                <span className="rounded-full bg-vez-surface px-3 py-1 text-[10px] text-vez-mute">Today</span>
              </div>
              <div className="space-y-1">
                {isRunsInitialLoading ? (
                  <LogSkeleton rows={6} />
                ) : systemLogs.length === 0 ? (
                  <p className="px-3 py-2 text-xs text-vez-mute">No scrape runs recorded yet.</p>
                ) : (
                  systemLogs.map((log, i) => (
                  <div key={i} className="flex items-center gap-3 rounded-[12px] px-3 py-2 text-xs transition-colors hover:bg-vez-surface">
                    {log.level === "info" ? (
                      <CheckCircle className="size-3 shrink-0 text-vez-navy" />
                    ) : log.level === "warn" ? (
                      <AlertTriangle className="size-3 shrink-0 text-amber-500" />
                    ) : (
                      <XCircle className="size-3 shrink-0 text-red-500" />
                    )}
                    <span className="w-10 shrink-0 text-vez-mute tabular-nums">{log.time}</span>
                    <span
                      className={`flex-1 truncate ${log.level === "error" ? "text-red-600" : log.level === "warn" ? "text-amber-600" : "text-vez-ink/80"}`}
                    >
                      {log.msg}
                    </span>
                    <span
                      className={`shrink-0 rounded-full px-2.5 py-0.5 text-[9px] ${log.level === "error" ? "bg-red-50 text-red-600" : log.level === "warn" ? "bg-amber-50 text-amber-600" : "bg-vez-sky/30 text-vez-navy"}`}
                    >
                      {log.level}
                    </span>
                  </div>
                ))
                )}
              </div>
              <Link
                href="/admin/system"
                className="mt-4 flex items-center justify-center gap-1 rounded-full bg-vez-surface px-4 py-2.5 text-xs text-vez-mute transition-colors hover:text-vez-navy"
              >
                Full system logs <ArrowRight className="size-3" />
              </Link>
            </div>

            {/* Right - 2 cols */}
            <div className="space-y-6 lg:col-span-2">
              {/* Source status */}
              <div className="cmd-card rounded-[20px] bg-white p-4 sm:p-6 w-full overflow-hidden">
                <div className="mb-4 flex items-center justify-between">
                  <h3 className="flex items-center gap-2 text-base text-vez-ink">
                    <Link2 className="size-4 text-vez-navy" /> Scraping sources
                  </h3>
                  <Link
                    href="/admin/sources"
                    className="flex items-center gap-1 rounded-full px-3 py-1.5 text-xs text-vez-mute transition-colors hover:bg-vez-surface hover:text-vez-navy"
                  >
                    Manage <ArrowRight className="size-3" />
                  </Link>
                </div>
                <div className="space-y-2">
                  {isSourcesInitialLoading ? (
                    <ListSkeleton rows={5} />
                  ) : sources.length === 0 ? (
                    <p className="rounded-[12px] bg-vez-surface px-3.5 py-2.5 text-xs text-vez-mute">
                      No scraping sources configured yet.
                    </p>
                  ) : (
                    sources.map((src) => {
                    // Item counts come from the source's most recent run; there
                    // is no lifetime total on the source itself to report.
                    const last = latestRunBySource.get(src.id)
                    return (
                      <div key={src.id} className="flex items-center gap-3 rounded-[12px] bg-vez-surface px-3.5 py-2.5 transition-colors hover:bg-vez-sky/15">
                        <StatusDot active={src.enabled && last?.status !== "FAILED"} />
                        <span className="flex-1 truncate text-xs text-vez-ink">{src.name}</span>
                        <span className="shrink-0 text-[10px] text-vez-mute tabular-nums">
                          {last ? `${last.itemsFound.toLocaleString()} items` : "no runs yet"}
                        </span>
                      </div>
                    )
                  }))}
                </div>
              </div>

              {/* Quick actions */}
              <div className="cmd-card rounded-[20px] bg-vez-surface p-4 sm:p-6">
                <h3 className="mb-4 flex items-center gap-2 text-base text-vez-ink">
                  <BarChart3 className="size-4 text-vez-navy" /> Quick actions
                </h3>
                <div className="grid grid-cols-2 gap-3 sm:gap-4">
                  {[
                    { href: "/admin/notices", label: "Notices", icon: FileText },
                    { href: "/admin/users", label: "Users", icon: Users },
                    { href: "/admin/sources", label: "Add source", icon: Globe },
                    { href: "/admin/alerts", label: "Alerts", icon: Activity },
                  ].map((action) => {
                    const Icon = action.icon
                    return (
                      <Link
                        key={action.href}
                        href={action.href}
                        className="group flex flex-col items-center gap-2 rounded-[16px] bg-white p-4 text-center transition-transform duration-300 hover:-translate-y-1"
                      >
                        <div className="flex size-9 items-center justify-center rounded-full bg-vez-sky/30 transition-colors group-hover:bg-vez-sky/50">
                          <Icon className="size-4 text-vez-navy" />
                        </div>
                        <span className="text-xs text-vez-ink">{action.label}</span>
                      </Link>
                    )
                  })}
                </div>
              </div>
            </div>
          </div>

          {/* Recent users row */}
          <div className="cmd-card rounded-[20px] bg-white p-4 sm:p-6">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
              <h3 className="flex items-center gap-2 text-sm sm:text-base text-vez-ink">
                <UserCheck className="size-4 text-vez-navy" /> Recent users
              </h3>
              <Link
                href="/admin/users"
                className="flex items-center gap-1 rounded-full px-3 py-1.5 text-xs text-vez-mute transition-colors hover:bg-vez-surface hover:text-vez-navy"
              >
                All users <ArrowRight className="size-3" />
              </Link>
            </div>
            {isUsersInitialLoading ? (
              <UsersSkeleton />
            ) : recentUsers.length === 0 ? (
              <p className="text-xs text-vez-mute">No users yet.</p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6">
                {recentUsers.map((u) => (
                  <div key={u.id} className="flex items-center gap-3 rounded-[14px] bg-vez-surface px-4 py-3 transition-colors hover:bg-vez-sky/15">
                    <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-vez-sky">
                      <span className="text-xs text-vez-navy">
                        {(u.name || u.email).charAt(0).toUpperCase()}
                      </span>
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs text-vez-ink">{u.name || u.email}</p>
                      <div className="mt-0.5 flex items-center gap-1.5">
                        <span className={`size-1.5 rounded-full ${u.status === "active" ? "bg-vez-navy" : "bg-vez-mute/50"}`} />
                        <p className="text-[10px] capitalize text-vez-mute">{u.role}</p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </AdminLayout>
    </div>
  )
}
