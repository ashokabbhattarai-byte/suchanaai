"use client"

import { useEffect, useState } from "react"
import { Mail, ToggleLeft, ToggleRight, Loader2, X } from "lucide-react"
import { EmailAlertStatus } from "@/lib/types"
import { fetchAlertChannels, toggleEmailAlerts } from "@/lib/api"

/**
 * Email alert channel card. There is no verification step — alerts go to the
 * account email — so this is just an on/off switch, plus an honest note when
 * the admin hasn't configured SMTP for the app yet.
 */
export function EmailAlertsCard() {
  const [status, setStatus] = useState<EmailAlertStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetchAlertChannels()
      .then((c) => setStatus(c.email))
      .catch(() => setError("Could not load the email alert setting"))
  }, [])

  const handleToggle = async () => {
    if (!status) return
    const next = !status.alertsEnabled
    setBusy(true)
    setError(null)
    setStatus({ ...status, alertsEnabled: next }) // optimistic
    try {
      setStatus(await toggleEmailAlerts(next))
    } catch (e) {
      setStatus((prev) => (prev ? { ...prev, alertsEnabled: !next } : prev))
      setError(e instanceof Error ? e.message : "Could not update the email alert setting")
    } finally {
      setBusy(false)
    }
  }

  if (!status) {
    return (
      <div className="mb-6 flex items-center justify-center rounded-[20px] bg-vez-surface p-8">
        <Loader2 className="size-5 animate-spin text-vez-mute" />
      </div>
    )
  }

  return (
    <div className="mb-6 w-full overflow-hidden rounded-[20px] bg-vez-surface p-4 sm:p-6 md:p-8">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex size-11 shrink-0 items-center justify-center rounded-full bg-vez-sky/50 text-vez-navy">
          <Mail className="size-5" />
        </div>
        <div className="min-w-0">
          <h2 className="text-lg text-vez-ink">Email alerts</h2>
          <p className="break-words text-sm text-vez-mute">
            Matches are sent to <span className="text-vez-ink">{status.address}</span>.
          </p>
        </div>
        <button
          onClick={handleToggle}
          disabled={busy}
          className="ml-auto flex min-h-[44px] items-center gap-2 text-sm text-vez-ink disabled:opacity-50"
          aria-label={status.alertsEnabled ? "Turn off email alerts" : "Turn on email alerts"}
        >
          {status.alertsEnabled ? (
            <ToggleRight className="size-7 text-vez-navy" />
          ) : (
            <ToggleLeft className="size-7 text-vez-mute" />
          )}
          {status.alertsEnabled ? "On" : "Off"}
        </button>
      </div>

      {error && (
        <div className="mt-4 flex items-center justify-between rounded-full bg-red-50 px-4 py-2 text-xs text-red-600">
          <span>{error}</span>
          <button onClick={() => setError(null)} aria-label="Dismiss error">
            <X className="size-3.5" />
          </button>
        </div>
      )}

      {status.alertsEnabled && !status.channelAvailable && (
        <p className="mt-4 rounded-[14px] bg-amber-50 px-4 py-3 text-xs leading-relaxed text-amber-800">
          Email delivery isn&apos;t switched on for this site yet, so matches will wait in your in-app
          feed (the bell) until an administrator configures it.
        </p>
      )}
    </div>
  )
}
