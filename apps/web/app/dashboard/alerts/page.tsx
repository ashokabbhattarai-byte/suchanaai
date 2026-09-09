"use client"

import React, { useState, useEffect } from "react"
import Link from "next/link"
import {
  Bell, Plus, AlertCircle, Trash2, ToggleLeft, ToggleRight, Zap,
  Search, FolderOpen, Building2, Ban, Gauge, CalendarClock, ChevronDown, ChevronUp, Tag, X,
  Crown, Compass, Sparkles, Loader2,
} from "lucide-react"
import { Header } from "@/components/layout/header"
import { DashboardLayout } from "@/components/dashboard/dashboard-layout"
import { WhatsappConnectCard } from "@/components/alerts/whatsapp-connect-card"
import { UpgradePrompt, UsageMeterBar } from "@/components/billing/upgrade-prompt"
import { useAuth } from "@/lib/auth-context"
import { useAlerts } from "@/lib/alerts-context"
import { NewAlertRuleInput, fetchBillingSummary, type BillingSummary } from "@/lib/api"
import { AlertRule, AlertUrgency, CATEGORY_ORDER, CANONICAL_TAGS, categoryLabel, ScrapedItemCategory } from "@/lib/types"
import { toast } from "sonner"

const inputClass =
  "h-11 min-h-[44px] w-full rounded-full border border-vez-line bg-white px-5 text-[16px] sm:text-sm text-vez-ink outline-none transition-colors placeholder:text-vez-mute focus:border-vez-sky focus:bg-white"

const URGENCY_OPTIONS: { id: AlertUrgency | ""; label: string }[] = [
  { id: "", label: "Any urgency" },
  { id: "LOW", label: "Low or above" },
  { id: "MEDIUM", label: "Medium or above" },
  { id: "HIGH", label: "High only" },
]

const URGENCY_BADGE: Record<AlertUrgency, string> = { LOW: "🟢 Low+", MEDIUM: "🟡 Medium+", HIGH: "🔴 High" }

// Quick presets — one tap creates an alert instantly, no form friction
const QUICK_PRESETS: Array<{ label: string; icon: typeof Bell; categories: ScrapedItemCategory[]; tags?: string[] }> = [
  { label: "Vacancy alerts", icon: Building2, categories: ["VACANCY"] },
  { label: "Tender notices", icon: FolderOpen, categories: ["TENDER"] },
  { label: "PSC / Lok Sewa", icon: Search, categories: ["NOTICE", "VACANCY"], tags: ["psc"] },
  { label: "Press releases", icon: Bell, categories: ["PRESS_RELEASE"] },
  { label: "All notices", icon: Zap, categories: ["NOTICE"] },
]

const emptyForm = {
  name: "",
  priority: "NORMAL" as "NORMAL" | "HIGH",
  categories: [] as string[],
  tags: [] as string[],
  keywords: "",
  excludeKeywords: "",
  organizations: "",
  minUrgency: "" as AlertUrgency | "",
  deadlineEnabled: false,
  deadlineWithinDays: 7,
}

const parseCsv = (s: string): string[] => s.split(",").map((x) => x.trim()).filter(Boolean)

function buildPayload(form: typeof emptyForm): NewAlertRuleInput {
  return {
    name: form.name,
    enabled: true,
    priority: form.priority,
    categories: form.categories as NewAlertRuleInput["categories"],
    tags: form.tags,
    keywords: parseCsv(form.keywords),
    excludeKeywords: parseCsv(form.excludeKeywords),
    organizations: parseCsv(form.organizations),
    minUrgency: form.minUrgency || null,
    deadlineWithinDays: form.deadlineEnabled ? form.deadlineWithinDays : null,
  }
}

// Category and/or tags are the required, easy basis for every alert —
function hasPrimaryDimension(form: typeof emptyForm): boolean {
  return form.categories.length > 0 || form.tags.length > 0
}

export default function AlertsPage() {
  const { user } = useAuth()
  const { alerts, error, quotaError, clearQuotaError, addAlert, toggleAlert, deleteAlert } = useAlerts()
  const [showCreate, setShowCreate] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [form, setForm] = useState(emptyForm)
  const [tagQuery, setTagQuery] = useState("")
  const [creating, setCreating] = useState(false)
  const [quickCreating, setQuickCreating] = useState<string | null>(null)
  const [billing, setBilling] = useState<BillingSummary | null>(null)
  const [billingLoading, setBillingLoading] = useState(false)

  // Load plan + quota so the page can show "2 / 3 alerts used" and disable creation proactively
  useEffect(() => {
    if (!user) return
    setBillingLoading(true)
    fetchBillingSummary()
      .then(setBilling)
      .catch(() => {})
      .finally(() => setBillingLoading(false))
  }, [user, alerts.length, quotaError])

  if (!user) {
    return (
      <div className="min-h-screen bg-white font-poppins">
        <Header />
        <div className="flex items-center justify-center py-16 sm:py-32 px-4">
          <div className="w-full max-w-sm rounded-[24px] bg-vez-surface p-8 sm:p-10 text-center">
            <AlertCircle className="mx-auto mb-4 size-10 text-vez-mute" />
            <h2 className="mb-1 text-lg text-vez-ink">Sign in required</h2>
            <p className="mb-6 text-sm text-vez-mute">Please sign in to manage alerts.</p>
            <Link
              href="/login"
              className="block w-full min-h-[44px] rounded-full bg-vez-navy px-6 py-3 text-base text-white transition-opacity hover:opacity-90 flex items-center justify-center"
            >
              Sign in
            </Link>
          </div>
        </div>
      </div>
    )
  }

  const canSubmit = !!form.name && hasPrimaryDimension(form)
  const alertUsage = billing?.usage.alertRules
  const planLimits = billing?.limits
  const tierName = billing?.plan.name ?? "Free"
  const isQuotaExceeded = alertUsage ? alertUsage.exceeded : false
  const quotaHint = planLimits?.maxAlertRules === null
    ? "Unlimited alerts on this plan"
    : planLimits?.maxAlertRules != null
      ? `${alertUsage?.used ?? alerts.length} / ${planLimits.maxAlertRules} used`
      : `${alerts.length} configured`

  const handleCreate = async () => {
    if (!canSubmit) return
    setCreating(true)
    const ok = await addAlert(buildPayload(form))
    setCreating(false)
    if (ok) {
      toast.success("Alert created")
      setForm(emptyForm)
      setTagQuery("")
      setShowAdvanced(false)
      setShowCreate(false)
    }
  }

  const handleQuickCreate = async (preset: typeof QUICK_PRESETS[number]) => {
    const name = preset.label
    // Prevent duplicate naming — add suffix if exists
    const existingNames = new Set(alerts.map(a => a.name))
    let finalName = name
    let n = 2
    while (existingNames.has(finalName)) {
      finalName = `${name} ${n++}`
    }
    setQuickCreating(preset.label)
    const ok = await addAlert({
      name: finalName,
      enabled: true,
      priority: "NORMAL",
      categories: preset.categories,
      tags: preset.tags ?? [],
      keywords: [],
      excludeKeywords: [],
      organizations: [],
      minUrgency: null,
      deadlineWithinDays: null,
    })
    setQuickCreating(null)
    if (ok) toast.success(`${finalName} — alert created`)
  }

  const toggleCategory = (cat: string) => {
    setForm((f) => ({
      ...f,
      categories: f.categories.includes(cat) ? f.categories.filter((c) => c !== cat) : [...f.categories, cat],
    }))
  }

  const toggleTag = (tag: string) => {
    setForm((f) => ({
      ...f,
      tags: f.tags.includes(tag) ? f.tags.filter((t) => t !== tag) : [...f.tags, tag],
    }))
  }

  const matchingTags = tagQuery.trim()
    ? CANONICAL_TAGS.filter((t) => t.includes(tagQuery.trim().toLowerCase()) && !form.tags.includes(t)).slice(0, 12)
    : []

  return (
    <div className="min-h-screen w-full max-w-full overflow-x-hidden bg-white font-poppins">
      <Header />
      <DashboardLayout>
        {/* Header: title + quota meter + quick plan badge */}
        <div className="mb-6 flex w-full max-w-full min-w-0 flex-col gap-4 overflow-x-hidden sm:mb-8">
          <div className="flex w-full max-w-full min-w-0 flex-wrap items-end justify-between gap-3 sm:gap-4">
            <div className="min-w-0 flex-1">
              <h1 className="break-words text-[clamp(22px,6vw,40px)] font-normal leading-tight tracking-[-0.03em] text-vez-ink">
                My alerts.
              </h1>
              <p className="mt-1 text-sm text-vez-mute sm:mt-2 flex flex-wrap items-center gap-2">
                <span>{alerts.length} alert rule{alerts.length !== 1 ? "s" : ""} configured</span>
                {billingLoading ? (
                  <span className="inline-flex items-center gap-1 text-xs text-vez-mute/60"><Loader2 className="size-3 animate-spin" /> loading quota…</span>
                ) : (
                  <span className="rounded-full bg-vez-surface px-2.5 py-0.5 text-xs tabular-nums text-vez-ink">{quotaHint}</span>
                )}
                {billing && (
                  <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-medium ${billing.plan.tier === "MAX" ? "bg-vez-navy text-white" : billing.plan.tier === "PRO" ? "bg-vez-sky text-vez-navy" : "bg-vez-line/60 text-vez-mute"}`}>
                    {billing.plan.tier === "MAX" ? <Crown className="size-3" /> : billing.plan.tier === "PRO" ? <Zap className="size-3" /> : <Compass className="size-3" />}
                    {tierName}
                  </span>
                )}
              </p>
            </div>
            <button
              className="flex shrink-0 items-center gap-2 rounded-full bg-vez-navy px-4 py-2.5 text-sm text-white transition-opacity hover:opacity-90 sm:px-5 min-h-[44px] disabled:opacity-40 disabled:cursor-not-allowed"
              onClick={() => setShowCreate(!showCreate)}
              disabled={isQuotaExceeded}
              title={isQuotaExceeded ? "Alert limit reached — upgrade your plan" : undefined}
            >
              <Plus className="size-4 shrink-0" /> {showCreate ? "Close" : "New alert"}
            </button>
          </div>

          {/* Quota meter: shows plan limits before hitting the wall */}
          {billing && alertUsage && (
            <div className="w-full max-w-full min-w-0 overflow-hidden rounded-[16px] border border-vez-line/50 bg-vez-surface/40 p-4 sm:p-5">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                <div className="min-w-0 flex-1 max-w-md">
                  <UsageMeterBar label="Alert rules" used={alertUsage.used} limit={alertUsage.limit} />
                  <p className="mt-2 text-xs leading-relaxed text-vez-mute">
                    {planLimits?.maxAlertRules === null ? (
                      <>Unlimited alerts on <span className="font-medium text-vez-ink">{tierName}</span> — create as many as you need.</>
                    ) : (
                      <>
                        <span className="font-medium text-vez-ink">{tierName}</span> includes <span className="font-medium tabular-nums text-vez-ink">{planLimits?.maxAlertRules}</span> alert rules.
                        {alertUsage.remaining !== null && alertUsage.remaining <= 1 && alertUsage.remaining >= 0 && !alertUsage.exceeded && (
                          <> Only <span className="font-medium text-amber-700">{alertUsage.remaining}</span> slot left.</>
                        )}
                        {alertUsage.exceeded && <> You&apos;ve hit the limit — delete one or upgrade.</>}
                        {alertUsage.used === 0 && <> Create one below to get notified instantly.</>}
                      </>
                    )}
                    {" "}
                    <Link href="/pricing" className="underline underline-offset-2 hover:text-vez-navy">View plans</Link>
                    {" · "}
                    <Link href="/dashboard/billing" className="underline underline-offset-2 hover:text-vez-navy">Manage billing</Link>
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2 self-start sm:self-auto">
                  <span className={`rounded-full px-2.5 py-1 text-xs tabular-nums ${alertUsage.exceeded ? "bg-red-100 text-red-700" : alertUsage.remaining !== null && alertUsage.remaining <= 1 ? "bg-amber-100 text-amber-800" : "bg-white text-vez-mute border border-vez-line"}`}>
                    {alertUsage.used} / {alertUsage.limit === null ? "∞" : alertUsage.limit}
                  </span>
                  {(alertUsage.exceeded || (alertUsage.remaining !== null && alertUsage.remaining <= 1 && !billingLoading)) && (
                    <Link href="/pricing" className="inline-flex min-h-[36px] items-center gap-1 rounded-full bg-vez-navy px-3.5 py-1.5 text-xs font-medium text-white hover:opacity-90">
                      <Sparkles className="size-3" /> Upgrade
                    </Link>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        <WhatsappConnectCard />

        {error && (
          <div className="mb-6 flex min-w-0 items-center gap-2 overflow-hidden rounded-[14px] bg-red-50 px-4 py-3 text-sm text-red-600">
            <AlertCircle className="size-4 shrink-0" />
            <span className="min-w-0 flex-1 break-words">{error}</span>
          </div>
        )}

        {quotaError && (
          <div className="mb-6">
            <UpgradePrompt quota={quotaError} onDismiss={clearQuotaError} />
          </div>
        )}

        {isQuotaExceeded && !quotaError && !showCreate && (
          <div className="mb-6 overflow-hidden rounded-[14px] border border-amber-200 bg-amber-50 px-4 py-3">
            <div className="flex items-start gap-2.5">
              <AlertCircle className="mt-0.5 size-4 shrink-0 text-amber-600" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-amber-900">Alert limit reached on {tierName}</p>
                <p className="mt-1 text-xs leading-relaxed text-amber-800">Delete an existing alert to free a slot, or upgrade — Pro includes 25 rules, Max is unlimited.</p>
                <div className="mt-2.5 flex flex-wrap gap-2">
                  <Link href="/pricing" className="inline-flex min-h-[36px] items-center gap-1.5 rounded-full bg-amber-900 px-3.5 py-1.5 text-xs font-medium text-white hover:opacity-90">
                    <Crown className="size-3" /> View plans
                  </Link>
                  <Link href="/dashboard/billing" className="inline-flex min-h-[36px] items-center rounded-full bg-white px-3.5 py-1.5 text-xs font-medium text-amber-900 hover:bg-amber-100">Manage billing</Link>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Quick presets — one-tap alert creation, fully responsive */}
        {!showCreate && (
          <div className="mb-6 w-full max-w-full min-w-0 overflow-hidden rounded-[20px] bg-vez-sky/15 border border-vez-sky/20 p-4 sm:p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="flex items-center gap-1.5 text-sm font-medium text-vez-ink">
                <Zap className="size-4 text-vez-navy" /> Quick alerts — one tap to create
              </h3>
              <span className="text-[11px] text-vez-mute hidden sm:inline">Instant • respects your plan quota</span>
            </div>
            <p className="mt-1 text-xs leading-relaxed text-vez-mute">Tap a preset to create an alert immediately. You can fine-tune later in the list below.</p>
            <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 sm:gap-2.5">
              {QUICK_PRESETS.map((preset) => {
                const Icon = preset.icon
                const isCreatingThis = quickCreating === preset.label
                const disabled = isQuotaExceeded || isCreatingThis
                return (
                  <button
                    key={preset.label}
                    onClick={() => handleQuickCreate(preset)}
                    disabled={disabled}
                    className="flex min-h-[44px] w-full min-w-0 items-center gap-2.5 rounded-full border border-vez-line bg-white px-4 py-2.5 text-left text-sm text-vez-ink shadow-sm transition-all hover:border-vez-navy/30 hover:bg-vez-surface hover:shadow disabled:opacity-40 disabled:cursor-not-allowed sm:gap-3"
                  >
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-vez-sky/30 text-vez-navy">
                      {isCreatingThis ? <Loader2 className="size-4 animate-spin" /> : <Icon className="size-4" />}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[13px] sm:text-sm font-medium">{preset.label}</span>
                    <Plus className="size-3.5 shrink-0 text-vez-mute hidden sm:block" />
                  </button>
                )
              })}
            </div>
          </div>
        )}

        {/* Create Alert Form — responsive on phones (text-[16px] prevents iOS zoom) */}
        {showCreate && (
          <div className="mb-6 w-full max-w-full min-w-0 overflow-hidden rounded-[20px] bg-vez-sky/25 p-4 sm:p-6 md:p-8">
            <h2 className="text-lg text-vez-ink">Create new alert</h2>
            <p className="mt-1 text-sm text-vez-mute">
              Pick a category and/or tag to start — that&apos;s the easy way. Add keywords, organizations, urgency, or a
              deadline window on top if you want more precision.
            </p>
            {billing && planLimits && planLimits.maxAlertRules !== null && alertUsage && (
              <p className="mt-2 text-xs tabular-nums text-vez-mute">
                Using {alertUsage.used} of {planLimits.maxAlertRules} on {tierName} · {alertUsage.remaining !== null && alertUsage.remaining > 0 ? `${alertUsage.remaining} left` : "no slots left"} —{" "}
                <Link href="/pricing" className="underline underline-offset-2 hover:text-vez-navy">upgrade</Link> for more.
              </p>
            )}
            <div className="mt-6 space-y-5">
              <div>
                <label className="mb-2 block text-sm text-vez-mute">Alert name</label>
                <input
                  placeholder="e.g. Vacancy Updates"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className={inputClass}
                  autoComplete="off"
                  inputMode="text"
                />
              </div>

              <div>
                <label className="mb-2 flex flex-wrap items-center gap-1.5 text-sm text-vez-ink">
                  <FolderOpen className="size-3.5 shrink-0" /> Categories <span className="text-vez-mute">(pick at least one, or a tag below)</span>
                </label>
                <div className="flex flex-wrap gap-2">
                  {CATEGORY_ORDER.map((cat) => (
                    <button
                      key={cat}
                      onClick={() => toggleCategory(cat)}
                      className={`min-h-[36px] rounded-full px-3.5 py-1.5 text-xs sm:text-sm transition-colors sm:min-h-[38px] ${
                        form.categories.includes(cat)
                          ? "bg-vez-navy text-white"
                          : "bg-white text-vez-mute hover:text-vez-navy border border-transparent hover:border-vez-line"
                      }`}
                    >
                      {categoryLabel(cat)}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="mb-2 flex flex-wrap items-center gap-1.5 text-sm text-vez-ink">
                  <Tag className="size-3.5 shrink-0" /> Tags <span className="text-vez-mute">(pick at least one, or a category above)</span>
                </label>
                {form.tags.length > 0 && (
                  <div className="mb-2 flex flex-wrap gap-2">
                    {form.tags.map((t) => (
                      <button
                        key={t}
                        onClick={() => toggleTag(t)}
                        className="flex min-h-[36px] items-center gap-1 rounded-full bg-vez-navy px-3.5 py-1.5 text-xs text-white sm:min-h-[38px]"
                      >
                        {t} <X className="size-3 shrink-0" />
                      </button>
                    ))}
                  </div>
                )}
                <input
                  placeholder="Search tags: scholarship, tender, election…"
                  value={tagQuery}
                  onChange={(e) => setTagQuery(e.target.value)}
                  className={inputClass}
                  autoComplete="off"
                  inputMode="search"
                />
                {matchingTags.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {matchingTags.map((t) => (
                      <button
                        key={t}
                        onClick={() => { toggleTag(t); setTagQuery("") }}
                        className="min-h-[36px] rounded-full bg-white px-3.5 py-1.5 text-xs text-vez-mute hover:text-vez-navy sm:min-h-[38px]"
                      >
                        + {t}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <button
                onClick={() => setShowAdvanced(!showAdvanced)}
                className="flex min-h-[44px] w-full min-w-0 items-start gap-1.5 break-words text-left text-sm text-vez-navy sm:w-auto"
              >
                <span className="mt-0.5 shrink-0">{showAdvanced ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}</span>
                <span className="min-w-0 flex-1 break-words">{showAdvanced ? "Hide advanced filters" : "Advanced filters (optional — keywords, organization, exclude, urgency, deadline)"}</span>
              </button>

              {showAdvanced && (
                <div className="w-full min-w-0 space-y-5 overflow-hidden rounded-[16px] bg-white/60 p-4 sm:p-5">
                  <div>
                    <label className="mb-2 flex items-center gap-1.5 text-sm text-vez-mute">
                      <Search className="size-3.5 shrink-0" /> Also require these keywords (comma separated)
                    </label>
                    <input
                      placeholder="section officer, lok sewa, PSC"
                      value={form.keywords}
                      onChange={(e) => setForm({ ...form, keywords: e.target.value })}
                      className={inputClass}
                    />
                  </div>

                  <div>
                    <label className="mb-2 flex items-center gap-1.5 text-sm text-vez-mute">
                      <Building2 className="size-3.5 shrink-0" /> Organizations (comma separated)
                    </label>
                    <input
                      placeholder="Nepal Rastra Bank, Ministry of Education"
                      value={form.organizations}
                      onChange={(e) => setForm({ ...form, organizations: e.target.value })}
                      className={inputClass}
                    />
                  </div>

                  <div>
                    <label className="mb-2 flex items-center gap-1.5 text-sm text-vez-mute">
                      <Ban className="size-3.5 shrink-0" /> Exclude if it mentions (comma separated)
                    </label>
                    <input
                      placeholder="cancelled, postponed"
                      value={form.excludeKeywords}
                      onChange={(e) => setForm({ ...form, excludeKeywords: e.target.value })}
                      className={inputClass}
                    />
                  </div>

                  <div>
                    <label className="mb-2 flex items-center gap-1.5 text-sm text-vez-mute">
                      <Gauge className="size-3.5 shrink-0" /> Minimum urgency
                    </label>
                    <div className="flex flex-wrap gap-2">
                      {URGENCY_OPTIONS.map((opt) => (
                        <button
                          key={opt.id}
                          onClick={() => setForm({ ...form, minUrgency: opt.id })}
                          className={`min-h-[36px] rounded-full px-3.5 py-1.5 text-xs transition-colors sm:min-h-[38px] ${
                            form.minUrgency === opt.id
                              ? "bg-vez-navy text-white"
                              : "bg-white text-vez-mute hover:text-vez-navy"
                          }`}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div>
                    <label className="mb-2 flex items-center gap-1.5 text-sm text-vez-mute">
                      <CalendarClock className="size-3.5 shrink-0" /> Only notices with a deadline coming up
                    </label>
                    <div className="flex flex-wrap items-center gap-3">
                      <button
                        onClick={() => setForm({ ...form, deadlineEnabled: !form.deadlineEnabled })}
                        aria-label={form.deadlineEnabled ? "Disable deadline filter" : "Enable deadline filter"}
                        className="shrink-0 min-h-[44px] min-w-[56px] flex items-center justify-center"
                      >
                        {form.deadlineEnabled ? (
                          <ToggleRight className="size-7 text-vez-navy" />
                        ) : (
                          <ToggleLeft className="size-7 text-vez-mute" />
                        )}
                      </button>
                      {form.deadlineEnabled && (
                        <div className="flex items-center gap-2 text-sm text-vez-ink">
                          within
                          <input
                            type="number"
                            min={1}
                            max={365}
                            value={form.deadlineWithinDays}
                            onChange={(e) => setForm({ ...form, deadlineWithinDays: Number(e.target.value) || 1 })}
                            className="h-11 min-h-[44px] w-20 rounded-full border border-vez-line bg-white px-3 text-center text-[16px] sm:text-sm outline-none focus:border-vez-sky"
                            inputMode="numeric"
                          />
                          days
                        </div>
                      )}
                    </div>
                  </div>

                  <div>
                    <label className="mb-2 block text-sm text-vez-mute">Priority</label>
                    <div className="flex flex-wrap gap-2">
                      {(["NORMAL", "HIGH"] as const).map((p) => (
                        <button
                          key={p}
                          onClick={() => setForm({ ...form, priority: p })}
                          className={`min-h-[36px] rounded-full px-3.5 py-1.5 text-xs transition-colors sm:min-h-[38px] ${
                            form.priority === p ? "bg-vez-navy text-white" : "bg-white text-vez-mute hover:text-vez-navy"
                          }`}
                        >
                          {p === "HIGH" ? "⚡ High — always instant" : "Normal — respects digest setting"}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {!hasPrimaryDimension(form) && (
                <p className="text-xs text-vez-mute">
                  Choose at least one category or tag — that&apos;s the basis every alert needs. Everything under
                  Advanced filters is optional, on top of that.
                </p>
              )}

              <div className="flex flex-col gap-2.5 sm:flex-row sm:flex-wrap sm:items-center">
                <button
                  onClick={handleCreate}
                  disabled={creating || !canSubmit}
                  className="flex min-h-[44px] w-full items-center justify-center rounded-full bg-vez-navy px-5 py-2.5 text-sm text-white transition-opacity hover:opacity-90 disabled:opacity-40 sm:w-auto"
                >
                  {creating ? <><Loader2 className="mr-2 size-4 animate-spin" /> Creating…</> : "Create alert"}
                </button>
                <button
                  onClick={() => {
                    setShowCreate(false)
                    setShowAdvanced(false)
                    setForm(emptyForm)
                    setTagQuery("")
                  }}
                  className="flex min-h-[44px] w-full items-center justify-center rounded-full px-5 py-2.5 text-sm text-vez-mute transition-colors hover:bg-white hover:text-vez-navy sm:w-auto"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Empty State — responsive */}
        {alerts.length === 0 && !showCreate && (
          <div className="rounded-[24px] bg-vez-surface p-6 text-center sm:p-12">
            <div className="mx-auto mb-5 flex size-16 items-center justify-center rounded-full bg-vez-sky/40">
              <Zap className="size-7 text-vez-navy" />
            </div>
            <h3 className="mb-2 text-lg text-vez-ink">Set up your first alert</h3>
            <p className="mx-auto mb-6 max-w-sm text-sm leading-relaxed text-vez-mute">
              Start simple with a category or tag, then add keywords, organization, urgency, or a deadline window if
              you want more precision.
            </p>
            <div className="mb-7 flex flex-wrap items-center justify-center gap-3 sm:gap-5 text-xs sm:text-sm text-vez-mute">
              <span className="flex items-center gap-1.5"><FolderOpen className="size-3.5" /> Category</span>
              <span className="flex items-center gap-1.5"><Tag className="size-3.5" /> Tag</span>
              <span className="flex items-center gap-1.5"><Search className="size-3.5" /> Keyword</span>
              <span className="flex items-center gap-1.5"><Building2 className="size-3.5" /> Organization</span>
              <span className="flex items-center gap-1.5"><Gauge className="size-3.5" /> Urgency</span>
              <span className="flex items-center gap-1.5"><CalendarClock className="size-3.5" /> Deadline</span>
            </div>
            <button
              className="inline-flex min-h-[44px] items-center gap-2 rounded-full bg-vez-navy px-6 py-3 text-sm sm:text-base text-white transition-opacity hover:opacity-90"
              onClick={() => setShowCreate(true)}
            >
              <Plus className="size-4" /> Create first alert
            </button>
            {billing && (
              <p className="mx-auto mt-4 max-w-sm text-xs text-vez-mute">
                {planLimits?.maxAlertRules === null ? "Unlimited alerts" : `${planLimits?.maxAlertRules} alerts`} on <span className="font-medium text-vez-ink">{tierName}</span> — <Link href="/pricing" className="underline underline-offset-2 hover:text-vez-navy">see plans</Link>
              </p>
            )}
          </div>
        )}

        {/* Alert List — responsive cards */}
        {alerts.length > 0 && (
          <div className="w-full max-w-full min-w-0 space-y-3 overflow-hidden">
            {alerts.map((alert) => (
              <AlertRow key={alert.id} alert={alert} onToggle={toggleAlert} onDelete={deleteAlert} />
            ))}
          </div>
        )}
      </DashboardLayout>
    </div>
  )
}

function AlertRow({
  alert,
  onToggle,
  onDelete,
}: {
  alert: AlertRule
  onToggle: (id: string) => void
  onDelete: (id: string) => void
}) {
  return (
    <div className="flex w-full max-w-full min-w-0 flex-col gap-3 overflow-hidden rounded-[16px] bg-white p-4 transition-colors hover:bg-vez-sky/10 sm:flex-row sm:items-start sm:gap-4 sm:p-5">
      <div className="flex min-w-0 flex-1 items-start gap-3 sm:gap-4">
        <button
          onClick={() => onToggle(alert.id)}
          className="mt-0.5 flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-full -m-2 p-2 sm:m-0 sm:p-0 sm:min-h-0 sm:min-w-0"
          aria-label={alert.enabled ? "Disable alert" : "Enable alert"}
        >
          {alert.enabled ? (
            <ToggleRight className="size-6 text-vez-navy sm:size-7" />
          ) : (
            <ToggleLeft className="size-6 text-vez-mute sm:size-7" />
          )}
        </button>
        <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-vez-sky/30 text-vez-navy sm:size-10">
          <Bell className="size-3.5 sm:size-4" />
        </div>
        <div className="min-w-0 flex-1 overflow-hidden">
          <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
            <p className="min-w-0 break-words text-sm font-medium text-vez-ink sm:text-base">{alert.name}</p>
            {alert.priority === "HIGH" && (
              <span className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-700 sm:px-2.5">⚡ High priority</span>
            )}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1 sm:gap-1.5">
            {alert.categories.map((c) => (
              <span key={`cat-${c}`} className="shrink-0 rounded-full bg-vez-sky/40 px-2 py-0.5 text-[10px] font-medium text-vez-navy sm:px-2.5 sm:text-xs">
                {categoryLabel(c)}
              </span>
            ))}
            {alert.tags.map((t) => (
              <span key={`tag-${t}`} className="max-w-full break-all rounded-full bg-vez-navy px-2 py-0.5 text-[10px] text-white sm:px-2.5 sm:text-xs">
                #{t}
              </span>
            ))}
            {alert.keywords.map((k) => (
              <span key={`kw-${k}`} className="max-w-full break-all rounded-full bg-vez-surface px-2 py-0.5 text-[10px] text-vez-mute sm:px-2.5 sm:text-xs">
                🔍 {k}
              </span>
            ))}
            {alert.organizations.map((o) => (
              <span key={`org-${o}`} className="max-w-full break-all rounded-full bg-vez-surface px-2 py-0.5 text-[10px] text-vez-mute sm:px-2.5 sm:text-xs">
                🏛️ {o}
              </span>
            ))}
            {alert.minUrgency && (
              <span className="shrink-0 rounded-full bg-vez-surface px-2 py-0.5 text-[10px] text-vez-mute sm:px-2.5 sm:text-xs">
                {URGENCY_BADGE[alert.minUrgency]}
              </span>
            )}
            {alert.deadlineWithinDays != null && (
              <span className="shrink-0 rounded-full bg-vez-surface px-2 py-0.5 text-[10px] text-vez-mute sm:px-2.5 sm:text-xs">
                ⏰ due ≤{alert.deadlineWithinDays}d
              </span>
            )}
            {alert.excludeKeywords.map((k) => (
              <span key={`ex-${k}`} className="max-w-full break-all rounded-full bg-red-50 px-2 py-0.5 text-[10px] text-red-600 sm:px-2.5 sm:text-xs">
                🚫 {k}
              </span>
            ))}
          </div>
        </div>
      </div>
      <div className="flex shrink-0 items-center justify-between gap-2 self-stretch border-t border-vez-line/50 pt-3 sm:self-auto sm:border-0 sm:pt-0">
        <span className="shrink-0 rounded-full bg-vez-sky/30 px-3 py-1 text-xs tabular-nums text-vez-navy">
          {alert.matchCount} matches
        </span>
        <button
          className="flex size-11 min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-full text-vez-mute transition-colors hover:bg-red-50 hover:text-red-600 sm:size-9 sm:min-h-0 sm:min-w-0"
          onClick={() => onDelete(alert.id)}
          aria-label="Delete alert"
        >
          <Trash2 className="size-4" />
        </button>
      </div>
    </div>
  )
}
