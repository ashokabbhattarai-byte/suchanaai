"use client"

import { useCallback, useEffect, useState } from "react"
import {
  AlertCircle,
  Check,
  CreditCard,
  Loader2,
  RefreshCw,
  Search,
  Users as UsersIcon,
  X,
} from "lucide-react"
import { AdminLayout } from "@/components/admin/admin-layout"
import { Header } from "@/components/layout/header"
import { toast } from "sonner"
import {
  fetchAdminPlans,
  updateAdminPlan,
  fetchAdminUsage,
  fetchAdminUserUsage,
  grantUserPlan,
  revokeUserPlan,
  formatPlanPrice,
  type AdminPlan,
  type AdminUsageRow,
  type AdminUserUsageDetail,
  type PlanTier,
} from "@/lib/api"

const inputClass =
  "h-9 w-full rounded-[10px] border border-vez-line bg-white px-3 text-sm text-vez-ink outline-none transition-colors focus:border-vez-navy"

/** Limit inputs accept an empty string to mean "unlimited" (null in the API). */
function LimitField({
  label,
  value,
  hint,
  onChange,
}: {
  label: string
  value: number | null
  hint?: string
  onChange: (v: number | null) => void
}) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-vez-mute">{label}</label>
      <input
        type="number"
        min={0}
        value={value === null ? "" : value}
        placeholder="Unlimited"
        onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
        className={inputClass}
      />
      <p className="mt-1 text-[11px] text-vez-mute">{hint ?? "Leave blank for unlimited"}</p>
    </div>
  )
}

function PlanEditor({ plan, onSaved }: { plan: AdminPlan; onSaved: () => void }) {
  const [draft, setDraft] = useState<AdminPlan>(plan)
  const [saving, setSaving] = useState(false)
  const [note, setNote] = useState<{ tone: "ok" | "error"; text: string } | null>(null)

  useEffect(() => setDraft(plan), [plan])

  const set = <K extends keyof AdminPlan>(key: K, value: AdminPlan[K]) =>
    setDraft((prev) => ({ ...prev, [key]: value }))

  const save = async () => {
    setSaving(true)
    setNote(null)
    try {
      await updateAdminPlan(draft.tier, {
        name: draft.name,
        tagline: draft.tagline,
        description: draft.description,
        priceMonthlyCents: draft.priceMonthlyCents,
        currency: draft.currency,
        stripePriceId: draft.stripePriceId,
        stripeProductId: draft.stripeProductId,
        maxDocuments: draft.maxDocuments,
        maxAiQuestionsPerMonth: draft.maxAiQuestionsPerMonth,
        maxAlertRules: draft.maxAlertRules,
        maxWhatsappPerMonth: draft.maxWhatsappPerMonth,
        maxUploadMb: draft.maxUploadMb,
        allowInstantAlerts: draft.allowInstantAlerts,
        isPublic: draft.isPublic,
        features: draft.features ?? [],
      })
      setNote({ tone: "ok", text: "Saved — live immediately for every user." })
      onSaved()
    } catch (err) {
      setNote({ tone: "error", text: err instanceof Error ? err.message : "Save failed" })
    } finally {
      setSaving(false)
    }
  }

  const isFree = draft.tier === "FREE"

  return (
    <div className="rounded-[20px] border border-vez-line bg-white p-4 sm:p-6 w-full overflow-hidden">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span className="rounded-full bg-vez-navy px-2.5 py-1 text-[11px] font-medium text-white">
            {draft.tier}
          </span>
          <h3 className="text-base text-vez-ink">{draft.name}</h3>
        </div>
        <label className="flex items-center gap-2 text-xs text-vez-mute">
          <input
            type="checkbox"
            checked={draft.isPublic}
            onChange={(e) => set("isPublic", e.target.checked)}
          />
          Show on the pricing page
        </label>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 sm:gap-6">
        <div>
          <label className="mb-1 block text-xs font-medium text-vez-mute">Name</label>
          <input value={draft.name} onChange={(e) => set("name", e.target.value)} className={inputClass} />
        </div>
        <div className="md:col-span-2">
          <label className="mb-1 block text-xs font-medium text-vez-mute">Tagline</label>
          <input
            value={draft.tagline ?? ""}
            onChange={(e) => set("tagline", e.target.value)}
            className={inputClass}
          />
        </div>
      </div>

      <div className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-4 sm:gap-6">
        <div>
          <label className="mb-1 block text-xs font-medium text-vez-mute">
            Price (cents / month)
          </label>
          <input
            type="number"
            min={0}
            disabled={isFree}
            value={draft.priceMonthlyCents}
            onChange={(e) => set("priceMonthlyCents", Number(e.target.value))}
            className={`${inputClass} disabled:bg-vez-surface disabled:text-vez-mute`}
          />
          <p className="mt-1 text-[11px] text-vez-mute">
            {isFree ? "The Free tier cannot be priced" : formatPlanPrice(draft.priceMonthlyCents, draft.currency)}
          </p>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-vez-mute">Currency</label>
          <input
            value={draft.currency}
            maxLength={3}
            onChange={(e) => set("currency", e.target.value.toLowerCase())}
            className={inputClass}
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-vez-mute">Stripe price ID</label>
          <input
            value={draft.stripePriceId ?? ""}
            placeholder={isFree ? "Not applicable" : "price_..."}
            disabled={isFree}
            onChange={(e) => set("stripePriceId", e.target.value || null)}
            className={`${inputClass} font-mono text-xs disabled:bg-vez-surface`}
          />
          <p className="mt-1 text-[11px] text-vez-mute">
            {isFree
              ? "—"
              : draft.stripePriceId
                ? "Checkout enabled"
                : "Without this, upgrades to this plan are blocked"}
          </p>
        </div>
      </div>

      <div className="mt-5 border-t border-vez-line pt-5">
        <p className="mb-3 text-xs font-medium text-vez-ink">Limits enforced by the API</p>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-6">
          <LimitField
            label="Documents"
            value={draft.maxDocuments}
            onChange={(v) => set("maxDocuments", v)}
          />
          <LimitField
            label="AI questions / month"
            value={draft.maxAiQuestionsPerMonth}
            onChange={(v) => set("maxAiQuestionsPerMonth", v)}
          />
          <LimitField
            label="Alert rules"
            value={draft.maxAlertRules}
            onChange={(v) => set("maxAlertRules", v)}
          />
          <LimitField
            label="WhatsApp alerts / month"
            value={draft.maxWhatsappPerMonth}
            hint="0 disables WhatsApp delivery entirely"
            onChange={(v) => set("maxWhatsappPerMonth", v)}
          />
          <div>
            <label className="mb-1 block text-xs font-medium text-vez-mute">Max upload (MB)</label>
            <input
              type="number"
              min={1}
              value={draft.maxUploadMb}
              onChange={(e) => set("maxUploadMb", Number(e.target.value))}
              className={inputClass}
            />
            <p className="mt-1 text-[11px] text-vez-mute">Per-file ceiling</p>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-vez-mute">Alert delivery</label>
            <label className="flex h-9 items-center gap-2 text-sm text-vez-ink">
              <input
                type="checkbox"
                checked={draft.allowInstantAlerts}
                onChange={(e) => set("allowInstantAlerts", e.target.checked)}
              />
              Allow instant alerts
            </label>
            <p className="mt-1 text-[11px] text-vez-mute">Otherwise held to a digest</p>
          </div>
        </div>
      </div>

      <div className="mt-5 border-t border-vez-line pt-5">
        <label className="mb-1 block text-xs font-medium text-vez-mute">
          Pricing-page bullets (one per line)
        </label>
        <textarea
          rows={5}
          value={(draft.features ?? []).join("\n")}
          onChange={(e) => set("features", e.target.value.split("\n").filter((l) => l.trim()))}
          className="w-full rounded-[10px] border border-vez-line bg-white px-3 py-2 text-sm text-vez-ink outline-none transition-colors focus:border-vez-navy"
        />
      </div>

      <div className="mt-4 flex items-center gap-3">
        <button
          onClick={save}
          disabled={saving}
          className="flex items-center gap-2 rounded-full bg-vez-navy px-5 py-2.5 text-sm text-white transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {saving ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
          Save {draft.tier}
        </button>
        {note && (
          <p className={`text-xs ${note.tone === "error" ? "text-red-600" : "text-vez-mute"}`}>
            {note.text}
          </p>
        )}
      </div>
    </div>
  )
}

function UserUsageDrawer({ userId, onClose }: { userId: string; onClose: () => void }) {
  const [detail, setDetail] = useState<AdminUserUsageDetail | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    fetchAdminUserUsage(userId)
      .then((d) => !cancelled && setDetail(d))
      .catch(() => undefined)
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [userId])

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={onClose}>
      <div
        className="h-full w-full max-w-lg overflow-y-auto bg-white p-4 sm:p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
          <h3 className="text-base sm:text-lg text-vez-ink">Usage detail</h3>
          <button onClick={onClose} className="rounded-full p-1.5 text-vez-mute hover:bg-vez-surface shrink-0">
            <X className="size-4" />
          </button>
        </div>

        {loading ? (
          <div className="flex justify-center py-16 text-vez-mute">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : !detail ? (
          <p className="text-sm text-vez-mute">Could not load this user.</p>
        ) : (
          <>
            <div className="rounded-[14px] bg-vez-surface/60 p-4">
              <p className="text-sm text-vez-ink">
                {detail.plan.name}
                <span className="ml-2 text-xs text-vez-mute">{detail.status}</span>
              </p>
              <div className="mt-3 grid grid-cols-2 gap-3 text-xs text-vez-mute">
                <p>
                  AI questions:{" "}
                  <span className="text-vez-ink">
                    {detail.usage.aiQuestions.used}/{detail.usage.aiQuestions.limit ?? "∞"}
                  </span>
                </p>
                <p>
                  Documents:{" "}
                  <span className="text-vez-ink">
                    {detail.usage.documents.used}/{detail.usage.documents.limit ?? "∞"}
                  </span>
                </p>
                <p>
                  Alert rules:{" "}
                  <span className="text-vez-ink">
                    {detail.usage.alertRules.used}/{detail.usage.alertRules.limit ?? "∞"}
                  </span>
                </p>
                <p>
                  WhatsApp:{" "}
                  <span className="text-vez-ink">
                    {detail.usage.whatsappNotifications.used}/
                    {detail.usage.whatsappNotifications.limit ?? "∞"}
                  </span>
                </p>
              </div>
            </div>

            <p className="mb-2 mt-6 text-xs font-medium text-vez-ink">Recent metered activity</p>
            {detail.events.length === 0 ? (
              <p className="text-xs text-vez-mute">No activity recorded yet.</p>
            ) : (
              <div className="space-y-1.5">
                {detail.events.map((e) => (
                  <div
                    key={e.id}
                    className="flex items-center justify-between border-b border-vez-line/50 py-2 text-xs last:border-0"
                  >
                    <span className="text-vez-ink">{e.metric.replace(/_/g, " ").toLowerCase()}</span>
                    <span className="tabular-nums text-vez-mute">
                      {new Date(e.createdAt).toLocaleString()}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function AdminPlansPageContent() {
  const [plans, setPlans] = useState<AdminPlan[]>([])
  const [rows, setRows] = useState<AdminUsageRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState("")
  const [drawerUserId, setDrawerUserId] = useState<string | null>(null)
  const [busyUser, setBusyUser] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const [planData, usageData] = await Promise.all([fetchAdminPlans(), fetchAdminUsage(200)])
      setPlans(planData)
      setRows(usageData.data)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load billing data")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const changePlan = async (userId: string, tier: PlanTier) => {
    setBusyUser(userId)
    try {
      if (tier === "FREE") {
        // Free is the absence of a subscription, so this revokes the grant.
        await revokeUserPlan(userId).catch(() => grantUserPlan(userId, "FREE", "Admin set to Free"))
      } else {
        await grantUserPlan(userId, tier, "Granted from admin console")
      }
      toast.success(`Plan changed to ${tier}`)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not change the plan")
    } finally {
      setBusyUser(null)
    }
  }

  const filtered = rows.filter((r) => {
    const q = search.toLowerCase()
    return !q || r.name.toLowerCase().includes(q) || r.email.toLowerCase().includes(q)
  })

  return (
    <>
      <div className="mb-8">
        <h1 className="text-[clamp(28px,3vw,40px)] font-normal leading-tight tracking-[-0.03em] text-vez-ink">
          Plans &amp; usage.
        </h1>
        <p className="mt-2 text-sm text-vez-mute">
          Define what each tier includes, and see exactly what every member is consuming this month.
        </p>
      </div>

      {error && (
        <div className="mb-6 flex items-center gap-2 rounded-[14px] bg-red-50 px-4 py-3 text-sm text-red-600">
          <AlertCircle className="size-4 shrink-0" /> {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-20 text-vez-mute">
          <Loader2 className="size-5 animate-spin" />
        </div>
      ) : (
        <>
          <div className="mb-4 flex items-center gap-2">
            <CreditCard className="size-4 text-vez-navy" />
            <h2 className="text-base text-vez-ink">Plan definitions</h2>
          </div>
          <div className="space-y-4">
            {plans.map((plan) => (
              <PlanEditor key={plan.tier} plan={plan} onSaved={load} />
            ))}
          </div>

          <div className="mb-4 mt-10 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <UsersIcon className="size-4 text-vez-navy" />
              <h2 className="text-sm sm:text-base text-vez-ink">
                Member usage <span className="text-sm text-vez-mute">({rows.length})</span>
              </h2>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative w-full sm:w-64">
                <Search className="absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-vez-mute" />
                <input
                  placeholder="Search name or email…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className={`${inputClass} w-full sm:w-64 pl-9`}
                />
              </div>
              <button
                onClick={() => void load()}
                className="flex items-center gap-1.5 rounded-full border border-vez-line px-4 py-2 text-xs text-vez-ink hover:bg-vez-surface"
              >
                <RefreshCw className="size-3" /> Refresh
              </button>
            </div>
          </div>

          <div className="hidden md:block overflow-x-auto rounded-[20px] border border-vez-line bg-white">
            <table className="w-full min-w-[640px] text-left text-xs">
              <thead>
                <tr className="border-b border-vez-line text-vez-mute">
                  <th className="px-4 py-3 font-medium">Member</th>
                  <th className="px-4 py-3 font-medium">Plan</th>
                  <th className="px-4 py-3 font-medium">AI</th>
                  <th className="px-4 py-3 font-medium">Docs</th>
                  <th className="px-4 py-3 font-medium">Alerts</th>
                  <th className="px-4 py-3 font-medium">WhatsApp</th>
                  <th className="px-4 py-3 font-medium">Change plan</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((row) => (
                  <tr key={row.id} className="border-b border-vez-line/50 last:border-0 hover:bg-vez-surface/40">
                    <td className="px-4 py-3">
                      <button
                        onClick={() => setDrawerUserId(row.id)}
                        className="text-left text-vez-ink underline-offset-2 hover:underline"
                      >
                        {row.name}
                      </button>
                      <p className="text-[11px] text-vez-mute">{row.email}</p>
                    </td>
                    <td className="px-4 py-3">
                      <span className="rounded-full bg-vez-sky/25 px-2 py-0.5 text-[10px] font-medium text-vez-navy">
                        {row.tier}
                      </span>
                      {row.grantedByAdmin && (
                        <span className="ml-1 text-[10px] text-vez-mute">granted</span>
                      )}
                    </td>
                    <td className="px-4 py-3 tabular-nums text-vez-ink">{row.usage.aiQuestions}</td>
                    <td className="px-4 py-3 tabular-nums text-vez-ink">{row.usage.documents}</td>
                    <td className="px-4 py-3 tabular-nums text-vez-ink">{row.usage.alertRules}</td>
                    <td className="px-4 py-3 tabular-nums text-vez-ink">
                      {row.usage.whatsappNotifications}
                    </td>
                    <td className="px-4 py-3">
                      <select
                        value={row.tier}
                        disabled={busyUser === row.id}
                        onChange={(e) => void changePlan(row.id, e.target.value as PlanTier)}
                        className="h-8 rounded-[8px] border border-vez-line bg-white px-2 text-xs text-vez-ink outline-none focus:border-vez-navy disabled:opacity-50"
                      >
                        <option value="FREE">Free</option>
                        <option value="PRO">Pro</option>
                        <option value="MAX">Max</option>
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* Mobile card list */}
          <div className="grid gap-3 md:hidden">
            {filtered.map((row) => (
              <div key={row.id} className="rounded-2xl border border-vez-line/50 bg-white p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <button onClick={() => setDrawerUserId(row.id)} className="text-sm font-medium text-vez-ink underline-offset-2 hover:underline">{row.name}</button>
                    <p className="truncate text-xs text-vez-mute">{row.email}</p>
                  </div>
                  <span className="shrink-0 rounded-full bg-vez-sky/25 px-2.5 py-0.5 text-xs text-vez-navy">{row.tier}</span>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                  <span className="rounded-full bg-vez-surface px-2.5 py-1 text-vez-mute">AI: <span className="text-vez-ink">{row.usage.aiQuestions}</span></span>
                  <span className="rounded-full bg-vez-surface px-2.5 py-1 text-vez-mute">Docs: <span className="text-vez-ink">{row.usage.documents}</span></span>
                  <span className="rounded-full bg-vez-surface px-2.5 py-1 text-vez-mute">Alerts: <span className="text-vez-ink">{row.usage.alertRules}</span></span>
                  <span className="rounded-full bg-vez-surface px-2.5 py-1 text-vez-mute">WA: <span className="text-vez-ink">{row.usage.whatsappNotifications}</span></span>
                </div>
                <select value={row.tier} disabled={busyUser === row.id} onChange={(e) => void changePlan(row.id, e.target.value as PlanTier)} className="mt-3 h-9 w-full rounded-full border border-vez-line bg-white px-3 text-sm text-vez-ink">
                  <option value="FREE">Free</option>
                  <option value="PRO">Pro</option>
                  <option value="MAX">Max</option>
                </select>
              </div>
            ))}
          </div>
        </>
      )}

      {drawerUserId && (
        <UserUsageDrawer userId={drawerUserId} onClose={() => setDrawerUserId(null)} />
      )}
    </>
  )
}

export default function AdminPlansPage() {
  return (
    <div className="min-h-screen bg-white font-poppins">
      <Header />
      <AdminLayout>
        <AdminPlansPageContent />
      </AdminLayout>
    </div>
  )
}
