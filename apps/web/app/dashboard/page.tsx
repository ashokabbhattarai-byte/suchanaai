"use client"

import React, { useState, useEffect, useRef } from "react"
import Link from "next/link"
import {
  Eye, Bookmark, Bell, TrendingUp, FileText, Search,
  ArrowRight, AlertCircle, Zap, CheckCircle,
  CalendarClock, Activity, BarChart3, CreditCard, Receipt, Download, ExternalLink,
} from "lucide-react"
import { Header } from "@/components/layout/header"
import { DashboardLayout } from "@/components/dashboard/dashboard-layout"
import { useAuth } from "@/lib/auth-context"
import { useAlerts } from "@/lib/alerts-context"
import { toast } from "sonner"
import { CATEGORY_ORDER, categoryLabel, ScrapedItemCategory } from "@/lib/types"
import { fetchBillingSummary, fetchInvoices, formatPlanPrice, fetchNotices, type Invoice, type BillingSummary } from "@/lib/api"
import type { ScrapedItem } from "@/lib/types"
import gsap from "gsap"

function StatCard({
  label, value, sub, icon, trend,
}: {
  label: string; value: string; sub: string
  icon: React.ReactNode; trend?: string; trendUp?: boolean
}) {
  return (
    <div className="dash-card flex min-w-0 flex-col gap-3 overflow-hidden rounded-[20px] bg-white p-4 sm:p-5">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <span className="min-w-0 truncate text-xs sm:text-sm text-vez-mute">{label}</span>
        <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-vez-sky/30 text-vez-navy sm:size-9">
          {icon}
        </div>
      </div>
      <div className="min-w-0">
        <p className="break-words text-xl leading-none tracking-[-0.02em] text-vez-ink tabular-nums sm:text-2xl lg:text-3xl">{value}</p>
        <div className="mt-2 flex flex-wrap items-center gap-1.5 sm:gap-2">
          <span className="text-[11px] text-vez-mute sm:text-xs">{sub}</span>
          {trend && (
            <span className="shrink-0 rounded-full bg-vez-sky/30 px-2 py-0.5 text-[9px] leading-none text-vez-navy sm:px-2.5 sm:text-[10px]">
              {trend}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

const inputClass =
  "h-11 min-h-[44px] w-full rounded-full border border-vez-line bg-white px-5 text-[16px] sm:text-sm text-vez-ink outline-none transition-colors placeholder:text-vez-mute focus:border-vez-sky focus:bg-white"

export default function DashboardPage() {
  const { user } = useAuth()
  const { alerts, addAlert, error: alertError, quotaError } = useAlerts()
  const [wizardData, setWizardData] = useState({ name: "", categories: [] as ScrapedItemCategory[] })
  const gridRef = useRef<HTMLDivElement>(null)
  const [billing, setBilling] = useState<BillingSummary | null>(null)
  const [invoices, setInvoices] = useState<Invoice[]>([])
  const [invoicesLoading, setInvoicesLoading] = useState(false)
  const [notices, setNotices] = useState<ScrapedItem[]>([])
  const [noticesTotal, setNoticesTotal] = useState(0)
  const [noticesLoading, setNoticesLoading] = useState(true)

  useEffect(() => {
    if (!gridRef.current) return
    const cards = gridRef.current.querySelectorAll(".dash-card")
    gsap.fromTo(cards,
      { opacity: 0, y: 20 },
      { opacity: 1, y: 0, duration: 0.5, stagger: 0.06, ease: "power3.out" }
    )
  }, [])

  // The quick-create wizard has no room for a persistent inline error card —
  // surface addAlert's failure (from the shared alerts context) as a toast
  // instead, once it lands. Must run unconditionally (before the `!user`
  // early return below) — hooks can't be called conditionally.
  useEffect(() => {
    if (quotaError) {
      toast.error(quotaError.message, {
        action: { label: "View plans", onClick: () => { window.location.href = "/pricing" } },
      })
    } else if (alertError) {
      toast.error(alertError)
    }
  }, [alertError, quotaError])

  // Load billing + invoices when signed in — only for paid users do we show invoices
  useEffect(() => {
    if (!user) return
    let cancelled = false
    ;(async () => {
      try {
        const summary = await fetchBillingSummary()
        if (cancelled) return
        setBilling(summary)
        if (summary.plan.tier !== "FREE") {
          setInvoicesLoading(true)
          try {
            const inv = await fetchInvoices()
            if (!cancelled) setInvoices(inv)
          } catch {
            if (!cancelled) setInvoices([])
          } finally {
            if (!cancelled) setInvoicesLoading(false)
          }
        }
      } catch {
        // billing is best-effort on the dashboard; don't surface as toast
      }
    })()
    return () => {
      cancelled = true
    }
  }, [user])

  // Load real notices for dashboard — replaces mockNotices
  useEffect(() => {
    if (!user) return
    let cancelled = false
    setNoticesLoading(true)
    ;(async () => {
      try {
        const res = await fetchNotices({ limit: 12, sortBy: "publishedAt", sortOrder: "desc" })
        if (cancelled) return
        setNotices(res.data ?? [])
        setNoticesTotal(res.meta?.total ?? res.data.length)
      } catch {
        if (!cancelled) {
          setNotices([])
          setNoticesTotal(0)
        }
      } finally {
        if (!cancelled) setNoticesLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [user])

  if (!user) {
    return (
      <div className="min-h-screen bg-white font-poppins">
        <Header />
        <div className="flex items-center justify-center py-32">
          <div className="w-full max-w-sm rounded-[24px] bg-vez-surface p-10 text-center">
            <AlertCircle className="mx-auto mb-4 size-10 text-vez-mute" />
            <h2 className="mb-1 text-lg text-vez-ink">Sign in required</h2>
            <p className="mb-6 text-sm text-vez-mute">Access your personalised notice feed and alerts.</p>
            <Link
              href="/login"
              className="block w-full rounded-full bg-vez-navy px-6 py-3 text-base text-white transition-opacity hover:opacity-90"
            >
              Sign in
            </Link>
          </div>
        </div>
      </div>
    )
  }

  const hasAlerts = alerts.length > 0
  const activeAlertCount = alerts.filter(a => a.enabled).length
  const totalMatches = alerts.reduce((s, a) => s + a.matchCount, 0)
  // Real data derived from API — no mocks
  const recommendedNotices = notices.slice(0, 5)
  const urgentNotices = notices.filter(n => {
    const withUrgency = n as unknown as { aiUrgency?: string; priority?: string }
    return withUrgency.aiUrgency === "HIGH" || withUrgency.priority === "high" || n.category === "VACANCY" || n.category === "TENDER"
  }).slice(0, 2)
  // Activity derived from real alerts + notices if no dedicated endpoint
  const recentActivities = [
    ...alerts.slice(0, 2).map(a => ({
      id: `alert-${a.id}`,
      description: `Alert active: ${a.name} — ${a.matchCount} matches`,
      timestamp: a.createdAt ?? new Date().toISOString(),
      type: "alert" as const,
    })),
    ...notices.slice(0, 4).map(n => ({
      id: `notice-${n.id}`,
      description: `New notice: ${n.title.slice(0, 60)}`,
      timestamp: n.publishedAt ?? n.scrapedAt ?? new Date().toISOString(),
      type: "view" as const,
    })),
  ].slice(0, 6)

  const handleWizardSubmit = async () => {
    if (!wizardData.name || wizardData.categories.length === 0) return
    const ok = await addAlert({
      name: wizardData.name,
      categories: wizardData.categories,
      tags: [],
      keywords: [],
      excludeKeywords: [],
      organizations: [],
      minUrgency: null,
      deadlineWithinDays: null,
      priority: "NORMAL",
      enabled: true,
    })
    if (ok) {
      toast.success("Alert created")
      setWizardData({ name: "", categories: [] })
    }
  }

  const toggleWizardCategory = (cat: ScrapedItemCategory) => {
    setWizardData((w) => ({
      ...w,
      categories: w.categories.includes(cat) ? w.categories.filter((c) => c !== cat) : [...w.categories, cat],
    }))
  }

  return (
    <div className="min-h-screen w-full max-w-full overflow-x-hidden bg-white font-poppins">
      <Header />
      <DashboardLayout>
        {/* Page header */}
        <div className="mb-6 flex w-full max-w-full min-w-0 flex-wrap items-end justify-between gap-3 sm:mb-8 sm:gap-4">
          <div className="min-w-0 flex-1">
            <p className="text-xs text-vez-mute sm:text-sm">
              {new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}
            </p>
            <h1 className="mt-1 min-w-0 break-words text-[clamp(22px,6vw,40px)] font-normal leading-tight tracking-[-0.03em] text-vez-ink sm:mt-2">
              Good morning, <span className="break-all">{user.username}</span>.
            </h1>
          </div>

          <Link
            href="/notices"
            className="flex shrink-0 items-center gap-1.5 rounded-full bg-vez-navy px-4 py-2.5 text-sm text-white transition-opacity hover:opacity-90 sm:px-5"
          >
            <Search className="size-4 shrink-0" />
            Browse notices
          </Link>
        </div>

        <div ref={gridRef} className="w-full max-w-full min-w-0 space-y-4 overflow-x-hidden sm:space-y-6">
          {/* Stats row - real data, responsive: 1 col mobile, 2 on sm, 4 on lg */}
          <div className="grid w-full max-w-full min-w-0 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6">
            <StatCard
              label="Notices available"
              value={noticesLoading ? "—" : noticesTotal.toLocaleString()}
              sub={noticesLoading ? "loading…" : `${notices.length} loaded • this month`}
              trend={noticesTotal > 0 ? `${noticesTotal} total` : undefined}
              icon={<Eye className="size-4" />}
            />
            <StatCard
              label="Saved"
              value={noticesLoading ? "—" : "0"}
              sub="notices bookmarked"
              trend="Use bookmark on notices"
              icon={<Bookmark className="size-4" />}
            />
            <StatCard
              label="Active alerts"
              value={String(activeAlertCount)}
              sub={`${totalMatches} total matches`}
              trend={activeAlertCount > 0 ? "Active" : "None set"}
              icon={<Bell className="size-4" />}
            />
            <StatCard
              label="Member since"
              value={new Date(user.createdAt).toLocaleDateString("en-US", { month: "short", year: "numeric" })}
              sub={user.role}
              icon={<CheckCircle className="size-4" />}
            />
          </div>

          {/* Urgent notices banner — real data */}
          {noticesLoading ? (
            <div className="dash-card w-full max-w-full min-w-0 overflow-hidden rounded-[20px] bg-vez-navy p-4 sm:p-6 animate-pulse">
              <div className="h-5 w-32 rounded bg-white/20" />
              <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
                <div className="h-16 rounded-[16px] bg-white/10" />
                <div className="h-16 rounded-[16px] bg-white/10" />
              </div>
            </div>
          ) : urgentNotices.length > 0 ? (
            <div className="dash-card w-full max-w-full min-w-0 overflow-hidden rounded-[20px] bg-vez-navy p-4 sm:p-6">
              <div className="mb-3 flex flex-wrap items-center gap-2 sm:mb-4 sm:gap-2.5">
                <CalendarClock className="size-4 shrink-0 text-vez-sky sm:size-5" />
                <span className="text-sm text-white sm:text-base">Urgent notices</span>
                <span className="shrink-0 rounded-full bg-white/15 px-3 py-0.5 text-xs text-white">
                  {urgentNotices.length} active
                </span>
              </div>
              <div className="grid w-full min-w-0 grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
                {urgentNotices.map((n) => (
                  <Link
                    key={n.id}
                    href={`/notices/${n.id}`}
                    className="group flex min-w-0 items-center gap-3 overflow-hidden rounded-[16px] bg-white/10 p-3 transition-colors hover:bg-white/20 sm:p-4"
                  >
                    <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-vez-sky/30 sm:size-9">
                      <FileText className="size-3.5 text-vez-sky sm:size-4" />
                    </div>
                    <div className="min-w-0 flex-1 overflow-hidden">
                      <p className="truncate text-sm text-white">{n.title}</p>
                      <p className="truncate text-xs text-white/60">{n.sourceLabel || "Notice"}</p>
                    </div>
                    <ArrowRight className="hidden size-4 shrink-0 text-vez-sky opacity-0 transition-all group-hover:translate-x-0.5 group-hover:opacity-100 sm:block" />
                  </Link>
                ))}
              </div>
            </div>
          ) : null}

          {/* Main grid */}
          <div className="grid w-full max-w-full min-w-0 grid-cols-1 gap-4 sm:gap-6 lg:grid-cols-3">
            {/* Left - 2 cols */}
            <div className="min-w-0 space-y-4 sm:space-y-6 lg:col-span-2">
              {/* Alert setup wizard — quick, responsive, quota-aware */}
              {!hasAlerts ? (
                <div className="dash-card w-full max-w-full min-w-0 overflow-hidden rounded-[20px] bg-vez-sky/25 p-4 sm:p-6">
                  <div className="mb-4 flex min-w-0 items-start gap-3 sm:mb-5">
                    <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-white sm:size-10">
                      <Zap className="size-4 text-vez-navy" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-medium text-vez-ink sm:text-base">Set up your first alert — quick</p>
                        {billing && (
                          <span className="rounded-full bg-white px-2.5 py-0.5 text-[11px] tabular-nums text-vez-ink border border-vez-line">
                            {billing.usage.alertRules.used} / {billing.limits.maxAlertRules === null ? "∞" : billing.limits.maxAlertRules} {billing.limits.maxAlertRules === null ? "" : "alerts"} · {billing.plan.name}
                          </span>
                        )}
                      </div>
                      <p className="mt-0.5 text-xs leading-relaxed text-vez-mute sm:text-sm">One name + one category is enough. Takes 10 seconds.</p>
                      {billing && billing.usage.alertRules.exceeded && (
                        <p className="mt-1 text-xs font-medium text-amber-700">Alert limit reached on {billing.plan.name} — delete one or <Link href="/pricing" className="underline underline-offset-2">upgrade</Link>.</p>
                      )}
                    </div>
                  </div>
                  <div className="min-w-0 space-y-3">
                    <input
                      placeholder="Alert name (e.g. Vacancy Updates)"
                      value={wizardData.name}
                      onChange={(e) => setWizardData({ ...wizardData, name: e.target.value })}
                      className={inputClass}
                      autoComplete="off"
                      inputMode="text"
                    />
                    <div className="flex flex-wrap gap-1.5 sm:gap-2">
                      {CATEGORY_ORDER.map((cat) => (
                        <button
                          key={cat}
                          onClick={() => toggleWizardCategory(cat)}
                          className={`min-h-[38px] rounded-full px-3 py-1.5 text-[11px] transition-colors sm:px-3.5 sm:text-xs sm:min-h-[40px] ${
                            wizardData.categories.includes(cat)
                              ? "bg-vez-navy text-white"
                              : "bg-white text-vez-mute hover:text-vez-navy border border-transparent hover:border-vez-line"
                          }`}
                        >
                          {categoryLabel(cat)}
                        </button>
                      ))}
                    </div>
                    <div className="flex flex-col gap-2.5 sm:flex-row sm:flex-wrap sm:items-center">
                      <button
                        onClick={handleWizardSubmit}
                        disabled={!wizardData.name || wizardData.categories.length === 0 || (billing?.usage.alertRules.exceeded ?? false)}
                        className="flex min-h-[44px] w-full items-center justify-center rounded-full bg-vez-navy px-5 py-2.5 text-sm text-white transition-opacity hover:opacity-90 disabled:opacity-40 sm:w-auto"
                        title={billing?.usage.alertRules.exceeded ? "Alert limit reached — upgrade your plan" : undefined}
                      >
                        Create alert
                      </button>
                      <Link
                        href="/dashboard/alerts"
                        className="flex min-h-[44px] break-words items-center justify-center rounded-full px-3 py-2 text-xs leading-relaxed text-vez-mute transition-colors hover:bg-white hover:text-vez-navy sm:px-5 sm:py-2.5 sm:text-sm sm:justify-start"
                      >
                        Need tags & keywords? Full builder →
                      </Link>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="dash-card w-full max-w-full min-w-0 overflow-hidden rounded-[20px] bg-vez-surface p-4 sm:p-6">
                  <div className="mb-3 flex min-w-0 items-center justify-between gap-2 sm:mb-4">
                    <h3 className="flex min-w-0 items-center gap-1.5 text-sm font-medium text-vez-ink sm:gap-2 sm:text-base">
                      <Bell className="size-3.5 shrink-0 text-vez-navy sm:size-4" />
                      <span className="truncate">Active alerts</span>
                      <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-vez-navy px-1.5 text-[10px] text-white">{activeAlertCount}</span>
                    </h3>
                    <Link
                      href="/dashboard/alerts"
                      className="flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1.5 text-xs text-vez-mute transition-colors hover:bg-white hover:text-vez-navy sm:px-3"
                    >
                      Manage <ArrowRight className="size-3 shrink-0" />
                    </Link>
                  </div>
                  <div className="space-y-2.5">
                    {alerts.filter(a => a.enabled).slice(0, 3).map((alert) => (
                      <div key={alert.id} className="flex min-w-0 flex-col gap-2 rounded-[14px] bg-white px-3 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-3 sm:px-4">
                        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 sm:gap-2.5">
                          <span className="size-2 shrink-0 rounded-full bg-vez-navy" />
                          <span className="min-w-0 truncate text-sm font-medium text-vez-ink">{alert.name}</span>
                          <span className="max-w-full break-words rounded-full bg-vez-sky/30 px-2 py-0.5 text-[9px] leading-relaxed text-vez-navy sm:px-2.5 sm:text-[10px]">
                            {[
                              alert.categories.length && `${alert.categories.length} categor${alert.categories.length > 1 ? "ies" : "y"}`,
                              alert.tags.length && `${alert.tags.length} tag${alert.tags.length > 1 ? "s" : ""}`,
                              alert.keywords.length && `${alert.keywords.length} keyword${alert.keywords.length > 1 ? "s" : ""}`,
                              alert.organizations.length && `${alert.organizations.length} org${alert.organizations.length > 1 ? "s" : ""}`,
                              alert.minUrgency && "urgency",
                              alert.deadlineWithinDays != null && "deadline",
                            ].filter(Boolean).join(" + ") || "no filters"}
                          </span>
                        </div>
                        <span className="shrink-0 self-start rounded-full bg-vez-sky/20 px-2.5 py-0.5 text-xs text-vez-mute sm:self-auto sm:bg-transparent sm:px-0">{alert.matchCount} matches</span>
                      </div>
                    ))}
                    {alerts.length > 3 && (
                      <p className="pt-1 text-center text-xs text-vez-mute">+{alerts.length - 3} more alerts</p>
                    )}
                  </div>
                </div>
              )}

              {/* Recommended notices */}
              <div className="dash-card w-full max-w-full min-w-0 overflow-hidden rounded-[20px] bg-white p-4 sm:p-6">
                <div className="mb-3 flex min-w-0 items-center justify-between gap-2 sm:mb-4">
                  <h3 className="flex min-w-0 items-center gap-1.5 truncate text-sm font-medium text-vez-ink sm:gap-2 sm:text-base">
                    <TrendingUp className="size-3.5 shrink-0 text-vez-navy sm:size-4" /> <span className="truncate">Recommended for you</span>
                  </h3>
                  <Link
                    href="/notices"
                    className="flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1.5 text-xs text-vez-mute transition-colors hover:bg-vez-surface hover:text-vez-navy sm:px-3"
                  >
                    View all <ArrowRight className="size-3 shrink-0 sm:size-3.5" />
                  </Link>
                </div>
                <div className="w-full min-w-0 space-y-0">
                  {noticesLoading ? (
                    <div className="space-y-2 animate-pulse">
                      {[1,2,3].map(i => <div key={i} className="h-14 rounded-[14px] bg-vez-surface" />)}
                    </div>
                  ) : recommendedNotices.length === 0 ? (
                    <p className="py-8 text-center text-sm text-vez-mute">No notices yet — check back soon.</p>
                  ) : recommendedNotices.map((notice) => (
                    <Link
                      key={notice.id}
                      href={`/notices/${notice.id}`}
                      className="group flex w-full min-w-0 items-center gap-2.5 overflow-hidden rounded-[14px] border-b border-vez-line/50 px-2 py-3 transition-colors last:border-0 hover:bg-vez-surface sm:gap-3 sm:px-3"
                    >
                      <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-vez-sky/30 sm:size-9">
                        <FileText className="size-3.5 text-vez-navy sm:size-4" />
                      </div>
                      <div className="min-w-0 flex-1 overflow-hidden">
                        <p className="truncate text-sm text-vez-ink">{notice.title}</p>
                        <div className="mt-0.5 flex min-w-0 items-center gap-1 sm:gap-1.5">
                          <span className="min-w-0 truncate text-xs text-vez-mute">{notice.sourceLabel || "Notice"}</span>
                          <span className="hidden shrink-0 text-xs text-vez-mute/60 sm:inline">·</span>
                          <span className="hidden shrink-0 text-xs text-vez-mute sm:inline">{notice.publishedAt ? new Date(notice.publishedAt).toLocaleDateString() : ""}</span>
                        </div>
                      </div>
                      <div className="hidden shrink-0 items-center gap-1.5 sm:flex sm:gap-2">
                        <span className="rounded-full bg-vez-surface px-2 py-0.5 text-[10px] capitalize text-vez-mute sm:px-2.5">{notice.category}</span>
                        {((notice as unknown as { aiUrgency?: string }).aiUrgency === "HIGH") && (
                          <span className="size-2 rounded-full bg-vez-navy" />
                        )}
                        <ArrowRight className="size-3.5 text-vez-navy opacity-0 transition-all group-hover:translate-x-0.5 group-hover:opacity-100" />
                      </div>
                    </Link>
                  ))}
                </div>
              </div>

              {/* Engagement summary */}
              <div className="dash-card w-full max-w-full min-w-0 overflow-hidden rounded-[20px] bg-white p-4 sm:p-6">
                <div className="mb-4 flex items-center gap-2 sm:mb-5 sm:gap-2.5">
                  <BarChart3 className="size-4 shrink-0 text-vez-navy sm:size-5" />
                  <h3 className="text-sm font-medium text-vez-ink sm:text-base">This month</h3>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4">
                  {[
                    { label: "Searches", value: "23", icon: Search },
                    { label: "Docs read", value: "14", icon: FileText },
                    { label: "Alerts fired", value: totalMatches.toString(), icon: Bell },
                  ].map((item) => {
                    const Icon = item.icon
                    return (
                      <div key={item.label} className="flex min-w-0 flex-col items-center gap-1.5 overflow-hidden rounded-[14px] bg-vez-surface p-3 text-center sm:gap-2 sm:rounded-[16px] sm:p-4 lg:p-5">
                        <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-white sm:size-9">
                          <Icon className="size-3.5 text-vez-navy sm:size-4" />
                        </div>
                        <p className="text-lg font-medium text-vez-ink tabular-nums sm:text-2xl">{item.value}</p>
                        <p className="break-words text-[10px] leading-tight text-vez-mute sm:text-xs">{item.label}</p>
                      </div>
                    )
                  })}
                </div>
              </div>

              {/* Invoices — visible only after upgrade */}
              {billing && billing.plan.tier !== "FREE" && (
                <div className="dash-card w-full max-w-full min-w-0 overflow-hidden rounded-[20px] bg-white p-4 sm:p-6">
                  <div className="mb-4 flex min-w-0 items-center justify-between gap-2">
                    <h3 className="flex items-center gap-2 text-sm font-medium text-vez-ink sm:text-base">
                      <Receipt className="size-4 text-vez-navy" /> Invoices
                    </h3>
                    <Link
                      href="/dashboard/billing"
                      className="flex shrink-0 items-center gap-1 rounded-full px-3 py-1.5 text-xs text-vez-mute transition-colors hover:bg-vez-surface hover:text-vez-navy"
                    >
                      All invoices <ArrowRight className="size-3" />
                    </Link>
                  </div>

                  {invoicesLoading ? (
                    <div className="space-y-3 animate-pulse" aria-hidden="true">
                      {Array.from({ length: 2 }).map((_, i) => (
                        <div key={i} className="flex items-center gap-3 rounded-[14px] bg-vez-surface px-4 py-3">
                          <div className="size-9 rounded-xl bg-white" />
                          <div className="flex-1 space-y-2">
                            <div className="h-3 w-28 rounded bg-white" />
                            <div className="h-2 w-40 rounded bg-white/70" />
                          </div>
                          <div className="h-5 w-16 rounded-full bg-white" />
                        </div>
                      ))}
                    </div>
                  ) : invoices.length === 0 ? (
                    <div className="rounded-[14px] bg-vez-surface px-4 py-6 text-center">
                      <Receipt className="mx-auto size-6 text-vez-mute/40" />
                      <p className="mt-2 text-sm text-vez-ink">No invoices yet</p>
                      <p className="mx-auto mt-1 max-w-sm text-xs leading-relaxed text-vez-mute">
                        Your Stripe receipts will appear here after the first billing cycle.
                      </p>
                      <Link
                        href="/dashboard/billing"
                        className="mt-3 inline-flex items-center gap-1 rounded-full bg-vez-navy px-4 py-2 text-xs text-white hover:opacity-90"
                      >
                        Go to billing <ArrowRight className="size-3" />
                      </Link>
                    </div>
                  ) : (
                    <div className="space-y-2.5">
                      {invoices.slice(0, 3).map((inv) => {
                        const isPaidInv = inv.status === "paid"
                        const amt = isPaidInv ? inv.amountPaid : inv.amountDue
                        return (
                          <div
                            key={inv.id}
                            className="flex flex-col gap-2 rounded-[14px] border border-vez-line/40 px-3 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-4"
                          >
                            <div className="flex min-w-0 items-center gap-3">
                              <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-vez-surface">
                                <Receipt className="size-3.5 text-vez-navy" />
                              </div>
                              <div className="min-w-0">
                                <p className="truncate text-sm font-medium text-vez-ink">
                                  {inv.number ?? `Invoice ${inv.id.slice(0, 8)}`} · {formatPlanPrice(amt, inv.currency)}
                                </p>
                                <p className="truncate text-xs text-vez-mute">
                                  {inv.created ? new Date(inv.created).toLocaleDateString() : ""} ·{" "}
                                  <span className="capitalize">{inv.status}</span>
                                </p>
                              </div>
                            </div>
                            <div className="flex shrink-0 items-center gap-1.5 self-start sm:self-auto">
                              {inv.hostedInvoiceUrl && (
                                <a
                                  href={inv.hostedInvoiceUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="flex items-center gap-1 rounded-full border border-vez-line px-3 py-1.5 text-xs text-vez-ink hover:bg-vez-surface"
                                >
                                  <ExternalLink className="size-3" /> View
                                </a>
                              )}
                              {inv.invoicePdf && (
                                <a
                                  href={inv.invoicePdf}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="flex items-center gap-1 rounded-full bg-vez-navy px-3 py-1.5 text-xs text-white hover:opacity-90"
                                >
                                  <Download className="size-3" /> PDF
                                </a>
                              )}
                            </div>
                          </div>
                        )
                      })}
                      {invoices.length > 3 && (
                        <Link
                          href="/dashboard/billing"
                          className="block pt-1 text-center text-xs text-vez-mute hover:text-vez-navy"
                        >
                          +{invoices.length - 3} more on billing page
                        </Link>
                      )}
                    </div>
                  )}
                  <p className="mt-3 text-xs text-vez-mute">
                    Plan: <span className="font-medium text-vez-ink">{billing.plan.name}</span> ·{" "}
                    <Link href="/dashboard/billing" className="underline underline-offset-2 hover:text-vez-ink">
                      Manage billing
                    </Link>
                  </p>
                </div>
              )}
            </div>

            {/* Right - 1 col */}
            <div className="min-w-0 space-y-4 sm:space-y-6">
              {/* Activity feed */}
              <div className="dash-card w-full max-w-full min-w-0 overflow-hidden rounded-[20px] bg-white p-4 sm:p-6">
                <div className="mb-3 flex min-w-0 items-center justify-between gap-2 sm:mb-4">
                  <h3 className="flex min-w-0 items-center gap-1.5 truncate text-sm font-medium text-vez-ink sm:gap-2 sm:text-base">
                    <Activity className="size-3.5 shrink-0 text-vez-navy sm:size-4" /> <span className="truncate">Activity log</span>
                  </h3>
                  <Link
                    href="/dashboard/activity"
                    className="flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1.5 text-xs text-vez-mute transition-colors hover:bg-vez-surface hover:text-vez-navy sm:px-3"
                  >
                    All <ArrowRight className="size-3 shrink-0 sm:size-3.5" />
                  </Link>
                </div>
                <div className="relative">
                  <div className="absolute bottom-2 left-[5px] top-2 w-px bg-vez-line" />
                  {recentActivities.map((activity) => (
                    <div key={activity.id} className="relative flex min-w-0 items-start gap-3 py-2.5">
                      <span className="z-10 mt-1.5 size-2.5 shrink-0 rounded-full border-2 border-white bg-vez-sky" />
                      <div className="min-w-0 flex-1 overflow-hidden">
                        <p className="break-words text-sm leading-relaxed text-vez-ink/90">{activity.description}</p>
                        <p className="mt-1 break-words text-xs text-vez-mute">
                          {new Date(activity.timestamp).toLocaleDateString("en-US", {
                            month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
                          })}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Quick actions */}
              <div className="dash-card w-full max-w-full min-w-0 overflow-hidden rounded-[20px] bg-vez-surface p-4 sm:p-6">
                <h3 className="mb-3 flex items-center gap-2 text-sm font-medium text-vez-ink sm:mb-4 sm:text-base">
                  <TrendingUp className="size-3.5 text-vez-navy sm:size-4" /> Quick actions
                </h3>
                <div className="grid grid-cols-2 gap-2 sm:gap-3">
                  {[
                    { href: "/notices", label: "Browse", icon: Search },
                    { href: "/documents", label: "Doc search", icon: FileText },
                    { href: "/dashboard/alerts", label: "My alerts", icon: Bell },
                    { href: "/dashboard/saved", label: "Saved", icon: Bookmark },
                    { href: "/dashboard/billing", label: "Billing", icon: CreditCard },
                  ].map((action) => {
                    const Icon = action.icon
                    return (
                      <Link
                        key={action.href}
                        href={action.href}
                        className="group flex min-w-0 flex-col items-center gap-2 overflow-hidden rounded-[14px] bg-white p-3 text-center transition-transform duration-300 hover:-translate-y-1 sm:gap-2.5 sm:rounded-[16px] sm:p-4"
                      >
                        <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-vez-sky/30 transition-colors group-hover:bg-vez-sky/50 sm:size-9">
                          <Icon className="size-3.5 text-vez-navy sm:size-4" />
                        </div>
                        <span className="break-words text-[11px] leading-tight text-vez-ink sm:text-xs">{action.label}</span>
                      </Link>
                    )
                  })}
                </div>
              </div>

              {/* Notice categories */}
              <div className="dash-card w-full max-w-full min-w-0 overflow-hidden rounded-[20px] bg-white p-4 sm:p-6">
                <h3 className="mb-3 text-sm font-medium text-vez-ink sm:mb-4 sm:text-base">Browse by category</h3>
                <div className="space-y-1 sm:space-y-1.5">
                  {[
                    { label: "Vacancies", count: 14 },
                    { label: "Tenders", count: 8 },
                    { label: "Exams", count: 11 },
                    { label: "Policy", count: 5 },
                  ].map((cat) => (
                    <Link
                      key={cat.label}
                      href="/notices"
                      className="group flex min-w-0 items-center gap-2 rounded-full px-2 py-2 transition-colors hover:bg-vez-surface sm:gap-3 sm:px-3"
                    >
                      <span className="size-2 shrink-0 rounded-full bg-vez-sky" />
                      <span className="min-w-0 flex-1 truncate text-sm text-vez-ink">{cat.label}</span>
                      <span className="shrink-0 text-xs text-vez-mute">{cat.count}</span>
                      <ArrowRight className="hidden size-3 shrink-0 text-vez-mute opacity-0 transition-opacity group-hover:opacity-100 sm:block" />
                    </Link>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </DashboardLayout>
    </div>
  )
}
