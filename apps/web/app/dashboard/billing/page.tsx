"use client"

import { useCallback, useEffect, useState } from "react"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { Suspense } from "react"
import {
  AlertCircle,
  ArrowUpRight,
  Bell,
  CheckCircle,
  CreditCard,
  FileText,
  Loader2,
  MessageSquare,
  RefreshCw,
  Send,
} from "lucide-react"
import { Header } from "@/components/layout/header"
import { DashboardLayout } from "@/components/dashboard/dashboard-layout"
import { ErrorState } from "@/components/ui/error-state"
import { UsageMeterBar } from "@/components/billing/upgrade-prompt"
import {
  fetchBillingSummary,
  openBillingPortal,
  formatPlanPrice,
  type BillingSummary,
} from "@/lib/api"

const STATUS_COPY: Record<BillingSummary["status"], { label: string; tone: string }> = {
  ACTIVE: { label: "Active", tone: "bg-emerald-50 text-emerald-700" },
  TRIALING: { label: "Trial", tone: "bg-vez-sky/30 text-vez-navy" },
  PAST_DUE: { label: "Payment failed", tone: "bg-amber-50 text-amber-700" },
  CANCELED: { label: "Canceled", tone: "bg-vez-line/60 text-vez-mute" },
  INCOMPLETE: { label: "Incomplete", tone: "bg-amber-50 text-amber-700" },
}

function BillingPageContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  // Captured once on mount rather than derived from searchParams on every
  // render — the effect below strips the query param right after, and if
  // this were derived live it would flip back to false the instant that
  // happens, hiding the "payment received" banner immediately.
  const [justCheckedOut] = useState(() => searchParams.get("checkout") === "success")

  const [summary, setSummary] = useState<BillingSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<unknown>(null)
  const [openingPortal, setOpeningPortal] = useState(false)

  // `silent` skips the loading state so background refreshes (post-checkout
  // polling, the manual Refresh button while data is already on screen)
  // don't blank the whole page back to a spinner — only the very first load
  // does that.
  const load = useCallback(async (opts: { silent?: boolean } = {}) => {
    if (!opts.silent) setLoading(true)
    try {
      const data = await fetchBillingSummary()
      setSummary(data)
      setError(null)
    } catch (err) {
      if (!opts.silent) setError(err)
    } finally {
      if (!opts.silent) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // Stripe's webhook lands a moment after the redirect back, so the first
  // read can still show the old plan. A couple of silent background
  // refreshes cover that gap without flashing the page. The query param is
  // also stripped immediately so reloading this URL later doesn't replay
  // the banner and these refreshes for a purchase that already happened.
  useEffect(() => {
    if (!justCheckedOut) return
    router.replace("/dashboard/billing", { scroll: false })
    const timers = [2500, 6000].map((delay) => setTimeout(() => void load({ silent: true }), delay))
    return () => timers.forEach(clearTimeout)
  }, [justCheckedOut, load, router])

  const handlePortal = async () => {
    setOpeningPortal(true)
    setError(null)
    try {
      const { url } = await openBillingPortal()
      window.location.href = url
    } catch (err) {
      setError(err)
      setOpeningPortal(false)
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-[280px] items-center justify-center py-16 text-vez-mute">
        <Loader2 className="size-6 animate-spin" />
      </div>
    )
  }

  if (!summary) {
    return <ErrorState error={error} title="Your plan could not be loaded" onRetry={load} />
  }

  const status = STATUS_COPY[summary.status]
  const periodEnd = summary.currentPeriodEnd ? new Date(summary.currentPeriodEnd) : null
  const usage = summary.usage
  const isPaid = summary.plan.tier !== "FREE"

  const meters = [
    { label: "AI questions", icon: MessageSquare, ...usage.aiQuestions },
    { label: "Documents", icon: FileText, ...usage.documents },
    { label: "Alert rules", icon: Bell, ...usage.alertRules },
    { label: "WhatsApp alerts", icon: Send, ...usage.whatsappNotifications },
  ]

  return (
    <div className="w-full max-w-full min-w-0 space-y-4 overflow-x-hidden sm:space-y-6">
      {justCheckedOut && (
        <div className="flex items-start gap-2 overflow-hidden rounded-[14px] bg-emerald-50 px-3 py-3 text-sm text-emerald-700 sm:px-4">
          <CheckCircle className="mt-0.5 size-4 shrink-0" />
          <span className="min-w-0 flex-1 break-words">Payment received — welcome to {summary.plan.name}. It can take a few seconds to appear.</span>
        </div>
      )}

      {error != null && (
        <div className="flex items-start gap-2 overflow-hidden rounded-[14px] bg-red-50 px-3 py-3 text-sm text-red-600 sm:px-4">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span className="min-w-0 flex-1 break-words">
            {error instanceof Error ? error.message : "Could not open the billing portal"}
          </span>
          <button
            onClick={() => setError(null)}
            className="shrink-0 rounded-full px-2 py-1 text-xs text-red-700 hover:bg-red-100 cursor-pointer min-h-[28px]"
            aria-label="Dismiss error"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Current plan — gradient hero for paid tiers, quieter card for Free */}
      <section
        className={`w-full max-w-full min-w-0 overflow-hidden rounded-[24px] p-4 sm:p-6 lg:p-8 ${
          isPaid
            ? "bg-gradient-to-br from-vez-navy to-[#0b2a52] text-white shadow-lg shadow-vez-navy/15"
            : "border border-vez-line bg-white"
        }`}
      >
        <div className="flex w-full min-w-0 flex-col gap-4 sm:gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0 flex-1 overflow-hidden">
            <div className="flex flex-wrap items-center gap-2 sm:gap-2.5">
              <span
                className={`text-[11px] uppercase tracking-wide ${isPaid ? "text-white/60" : "text-vez-mute"}`}
              >
                Current plan
              </span>
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-2.5">
              <h2 className={`break-words text-2xl sm:text-3xl ${isPaid ? "text-white" : "text-vez-ink"}`}>
                {summary.plan.name}
              </h2>
              <span
                className={`shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-medium ${
                  isPaid ? "bg-white/15 text-white" : status.tone
                }`}
              >
                {status.label}
              </span>
              {summary.cancelAtPeriodEnd && (
                <span className="shrink-0 rounded-full bg-amber-400/20 px-2.5 py-0.5 text-[11px] font-medium text-amber-100">
                  Cancels at period end
                </span>
              )}
            </div>
            {summary.plan.tagline && (
              <p className={`mt-1.5 break-words text-sm ${isPaid ? "text-white/70" : "text-vez-mute"}`}>
                {summary.plan.tagline}
              </p>
            )}
            <p className={`mt-3 break-words text-sm ${isPaid ? "text-white/90" : "text-vez-ink"}`}>
              {formatPlanPrice(summary.plan.priceMonthlyCents, summary.plan.currency)}
              {summary.plan.priceMonthlyCents > 0 && (
                <span className={isPaid ? "text-white/60" : "text-vez-mute"}> / month</span>
              )}
              {periodEnd && (
                <span className={isPaid ? "text-white/60" : "text-vez-mute"}>
                  {" · "}
                  {summary.cancelAtPeriodEnd ? "ends" : "renews"} {periodEnd.toLocaleDateString()}
                </span>
              )}
            </p>
          </div>

          <div className="flex shrink-0 flex-wrap items-center gap-2 sm:gap-3">
            <Link
              href="/pricing"
              prefetch={false}
              className={`flex min-h-[44px] cursor-pointer items-center justify-center gap-1.5 rounded-full px-5 py-2.5 text-sm font-medium transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 ${
                isPaid
                  ? "bg-white text-vez-navy focus-visible:ring-white/50"
                  : "bg-vez-navy text-white focus-visible:ring-vez-navy"
              }`}
            >
              {summary.plan.tier === "MAX" ? "Compare plans" : "Upgrade"}
              <ArrowUpRight className="size-3.5 shrink-0" />
            </Link>
            {/* Only a real Stripe customer has a portal to open. */}
            {!summary.isDefault && summary.paymentsConfigured && (
              <button
                onClick={handlePortal}
                disabled={openingPortal}
                aria-busy={openingPortal}
                className={`flex min-h-[44px] cursor-pointer items-center justify-center gap-1.5 rounded-full border px-5 py-2.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:opacity-60 ${
                  isPaid
                    ? "border-white/25 text-white hover:bg-white/10 focus-visible:ring-white/50"
                    : "border-vez-line text-vez-ink hover:bg-vez-surface focus-visible:ring-vez-navy"
                }`}
              >
                {openingPortal ? (
                  <Loader2 className="size-3.5 animate-spin shrink-0" />
                ) : (
                  <CreditCard className="size-3.5 shrink-0" />
                )}
                Manage billing
              </button>
            )}
          </div>
        </div>

        {summary.status === "PAST_DUE" && (
          <p
            className={`mt-5 break-words rounded-[12px] px-3.5 py-2.5 text-xs leading-relaxed ${
              isPaid ? "bg-amber-400/15 text-amber-100" : "bg-amber-50 text-amber-800"
            }`}
          >
            We couldn&apos;t take the last payment. Your plan keeps working until the end of the current
            period — update your card in &quot;Manage billing&quot; to avoid losing access.
          </p>
        )}
      </section>

      {/* Usage */}
      <section className="w-full max-w-full min-w-0 overflow-hidden rounded-[24px] border border-vez-line bg-white p-4 sm:p-6 lg:p-8">
        <div className="mb-5 flex min-w-0 items-center justify-between gap-2 sm:mb-6">
          <div className="min-w-0 flex-1 overflow-hidden">
            <h3 className="break-words text-base font-medium text-vez-ink">This month&apos;s usage</h3>
            <p className="mt-0.5 break-words text-xs text-vez-mute">
              Resets {new Date(usage.periodEnd).toLocaleDateString()}
            </p>
          </div>
          <button
            onClick={() => void load({ silent: true })}
            className="flex min-h-[36px] shrink-0 cursor-pointer items-center gap-1.5 rounded-full border border-vez-line px-3 py-1.5 text-xs font-medium text-vez-ink transition-colors hover:bg-vez-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-vez-navy/20 sm:px-3.5"
          >
            <RefreshCw className="size-3 shrink-0" /> Refresh
          </button>
        </div>

        <div className="grid w-full min-w-0 grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-6 lg:grid-cols-3 xl:grid-cols-4 overflow-hidden">
          {meters.map((m) => (
            <div
              key={m.label}
              className="min-w-0 overflow-hidden rounded-[16px] bg-vez-surface/60 p-4 sm:p-5"
            >
              <div className="mb-3 flex size-9 items-center justify-center rounded-xl bg-white">
                <m.icon className="size-4 text-vez-navy" />
              </div>
              <UsageMeterBar label={m.label} used={m.used} limit={m.limit} />
            </div>
          ))}
        </div>

        <div className="mt-7 grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-6 lg:grid-cols-4 border-t border-vez-line pt-6 text-xs text-vez-mute">
          <div className="min-w-0 overflow-hidden">
            <p className="break-words text-base text-vez-ink">{summary.limits.maxUploadMb} MB</p>
            <p className="break-words">Max upload size</p>
          </div>
          <div className="min-w-0 overflow-hidden">
            <p className="break-words text-base text-vez-ink">
              {summary.limits.allowInstantAlerts ? "Instant" : "Daily digest"}
            </p>
            <p className="break-words">Alert delivery</p>
          </div>
          <div className="min-w-0 overflow-hidden">
            <p className="break-words text-base text-vez-ink">
              {summary.limits.maxDocuments === null ? "Unlimited" : summary.limits.maxDocuments}
            </p>
            <p className="break-words">Document limit</p>
          </div>
          <div className="min-w-0 overflow-hidden">
            <p className="break-words text-base text-vez-ink">
              {summary.limits.maxAiQuestionsPerMonth === null
                ? "Unlimited"
                : summary.limits.maxAiQuestionsPerMonth}
            </p>
            <p className="break-words">AI questions / month</p>
          </div>
        </div>
      </section>
    </div>
  )
}

export default function BillingPage() {
  return (
    <div className="min-h-screen w-full max-w-full overflow-x-hidden bg-white font-poppins">
      <Header />
      <DashboardLayout>
        <div className="mx-auto w-full max-w-7xl min-w-0 overflow-hidden">
          <div className="mb-6 w-full max-w-full min-w-0 overflow-hidden sm:mb-8">
            <h1 className="break-words text-[clamp(22px,6vw,40px)] font-normal leading-tight tracking-[-0.03em] text-vez-ink">
              Plan &amp; usage.
            </h1>
            <p className="mt-1 break-words text-sm text-vez-mute sm:mt-2">
              What your membership includes, and what you&apos;ve used this month.
            </p>
          </div>
          <Suspense
            fallback={
              <div className="flex items-center justify-center py-24 text-vez-mute">
                <Loader2 className="size-6 animate-spin" />
              </div>
            }
          >
            <BillingPageContent />
          </Suspense>
        </div>
      </DashboardLayout>
    </div>
  )
}
