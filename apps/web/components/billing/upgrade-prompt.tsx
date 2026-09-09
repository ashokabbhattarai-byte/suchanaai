"use client"

import Link from "next/link"
import { AlertCircle, ArrowRight, LogIn, Sparkles } from "lucide-react"
import type { QuotaDenial } from "@/lib/api"

/** Copy per quota kind — what ran out, and what upgrading actually buys. */
const KIND_COPY: Record<QuotaDenial["kind"], { title: string; hint: string }> = {
  ai_questions: {
    title: "You've used this month's AI questions",
    hint: "Pro includes 500 questions a month; Max is unlimited.",
  },
  documents: {
    title: "Document limit reached",
    hint: "Delete a document to free a slot, or upgrade for more.",
  },
  alert_rules: {
    title: "Alert rule limit reached",
    hint: "Pro includes 25 rules; Max is unlimited.",
  },
  whatsapp_notifications: {
    title: "Monthly WhatsApp alerts used up",
    hint: "Upgrade to keep receiving instant alerts this month.",
  },
  upload_size: {
    title: "File is too large for your plan",
    hint: "Pro accepts 25 MB uploads, Max 100 MB.",
  },
  instant_alerts: {
    title: "Instant alerts are a paid feature",
    hint: "Free plans receive a daily digest instead.",
  },
  anonymous_ai_questions: {
    title: "You've used your free questions for today",
    hint: "Signing in is free and comes with a much larger monthly allowance.",
  },
}

/**
 * The signed-out limit is not a plan limit — the visitor has no plan, and no
 * amount of money fixes it. Sending them to /pricing would be a dead end, so
 * this kind gets a sign-in CTA instead.
 */
const SIGN_IN_KINDS = new Set<QuotaDenial["kind"]>(["anonymous_ai_questions"])

/**
 * Shown wherever a 402 surfaces. Deliberately explains the *specific* limit
 * that was hit rather than a generic "upgrade" nag — the user should be able
 * to tell whether deleting something fixes it.
 */
export function UpgradePrompt({
  quota,
  onDismiss,
  compact = false,
}: {
  quota: QuotaDenial
  onDismiss?: () => void
  compact?: boolean
}) {
  const copy = KIND_COPY[quota.kind] ?? {
    title: "Plan limit reached",
    hint: "Upgrade for a bigger allowance.",
  }
  const signIn = SIGN_IN_KINDS.has(quota.kind)

  return (
    <div
      role="alert"
      className={`rounded-[14px] border border-amber-200 bg-amber-50 ${compact ? "px-3 py-2.5" : "px-4 py-3.5"}`}
    >
      <div className="flex items-start gap-2.5">
        <AlertCircle className="mt-0.5 size-4 shrink-0 text-amber-600" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-amber-900">{copy.title}</p>
          <p className="mt-0.5 text-xs leading-relaxed text-amber-800">
            {quota.message}
            {quota.limit !== null && quota.kind !== "upload_size" && (
              <span className="ml-1 tabular-nums opacity-80">
                ({quota.used}/{quota.limit} used)
              </span>
            )}
          </p>
          {!compact && <p className="mt-1 text-xs text-amber-700">{copy.hint}</p>}

          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <Link
              href={signIn ? "/login" : "/pricing"}
              className="inline-flex items-center gap-1.5 rounded-full bg-amber-900 px-3.5 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90"
            >
              {signIn ? <LogIn className="size-3" /> : <Sparkles className="size-3" />}
              {signIn ? "Sign in — free" : "View plans"}
              <ArrowRight className="size-3" />
            </Link>
            {signIn && (
              <Link
                href="/signup"
                className="rounded-full px-3 py-1.5 text-xs text-amber-800 transition-colors hover:bg-amber-100"
              >
                Create account
              </Link>
            )}
            {onDismiss && (
              <button
                onClick={onDismiss}
                className="rounded-full px-3 py-1.5 text-xs text-amber-800 transition-colors hover:bg-amber-100"
              >
                Dismiss
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

/** Horizontal usage meter used in the billing panel and admin views. */
export function UsageMeterBar({
  label,
  used,
  limit,
  unit,
}: {
  label: string
  used: number
  limit: number | null
  unit?: string
}) {
  const unlimited = limit === null
  const pct = unlimited ? 0 : Math.min(100, Math.round((used / Math.max(1, limit)) * 100))
  const exhausted = !unlimited && used >= limit

  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="text-sm text-vez-ink">{label}</span>
        <span className={`text-xs tabular-nums ${exhausted ? "text-red-600" : "text-vez-mute"}`}>
          {used.toLocaleString()}
          {unlimited ? (
            <span className="text-vez-mute"> / unlimited</span>
          ) : (
            <> / {limit.toLocaleString()}</>
          )}
          {unit ? ` ${unit}` : ""}
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-vez-line/60">
        <div
          className={`h-full rounded-full transition-all ${
            exhausted ? "bg-red-500" : pct > 80 ? "bg-amber-500" : "bg-vez-navy"
          }`}
          style={{ width: unlimited ? "100%" : `${Math.max(2, pct)}%`, opacity: unlimited ? 0.25 : 1 }}
        />
      </div>
    </div>
  )
}
