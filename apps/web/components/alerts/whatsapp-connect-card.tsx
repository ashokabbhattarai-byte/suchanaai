"use client"

import { useEffect, useState, type ElementType } from "react"
import { MessageCircle, ShieldCheck, ToggleLeft, ToggleRight, Loader2, X, Zap, Sunrise, CalendarDays } from "lucide-react"
import { WhatsappStatus, DigestFrequency } from "@/lib/types"
import {
  fetchWhatsappStatus,
  requestWhatsappOtp,
  verifyWhatsappOtp,
  toggleWhatsappAlerts,
  disconnectWhatsapp,
  setWhatsappDigestFrequency,
} from "@/lib/api"

const DIGEST_OPTIONS: { id: DigestFrequency; label: string; desc: string; icon: ElementType }[] = [
  { id: "INSTANT", label: "Instant", desc: "One message per match", icon: Zap },
  { id: "DAILY", label: "Daily digest", desc: "One batched message per day", icon: Sunrise },
  { id: "WEEKLY", label: "Weekly digest", desc: "One batched message per week", icon: CalendarDays },
]

const inputClass =
  "h-11 w-full rounded-full border border-vez-line bg-white px-5 text-sm text-vez-ink outline-none transition-colors placeholder:text-vez-mute focus:border-vez-sky"

type Step = "loading" | "phone" | "otp" | "connected"

/**
 * WhatsApp channel connect/verify/toggle card for the dashboard alerts page.
 * Talks to the shared Evolution API instance via the API's
 * /notifications/whatsapp/* endpoints (never directly).
 */
export function WhatsappConnectCard() {
  const [step, setStep] = useState<Step>("loading")
  const [status, setStatus] = useState<WhatsappStatus | null>(null)
  const [phone, setPhone] = useState("")
  const [code, setCode] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetchWhatsappStatus()
      .then((s) => {
        setStatus(s)
        setStep(s.connected ? "connected" : "phone")
      })
      .catch(() => setStep("phone"))
  }, [])

  const handleSendCode = async () => {
    if (!phone.trim()) return
    setBusy(true)
    setError(null)
    try {
      await requestWhatsappOtp(phone.trim())
      setStep("otp")
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not send a code — check the number and try again")
    } finally {
      setBusy(false)
    }
  }

  const handleVerify = async () => {
    if (code.trim().length !== 6) return
    setBusy(true)
    setError(null)
    try {
      const s = await verifyWhatsappOtp(code.trim())
      setStatus(s)
      setStep("connected")
      setCode("")
    } catch (e) {
      setError(e instanceof Error ? e.message : "Incorrect or expired code")
    } finally {
      setBusy(false)
    }
  }

  const handleToggle = async () => {
    if (!status) return
    setBusy(true)
    setError(null)
    const next = !status.alertsEnabled
    setStatus({ ...status, alertsEnabled: next }) // optimistic
    try {
      const s = await toggleWhatsappAlerts(next)
      setStatus(s)
    } catch (e) {
      setStatus((prev) => (prev ? { ...prev, alertsEnabled: !next } : prev))
      setError(e instanceof Error ? e.message : "Could not update alert setting")
    } finally {
      setBusy(false)
    }
  }

  const handleSetDigest = async (frequency: DigestFrequency) => {
    if (!status || status.digestFrequency === frequency) return
    setBusy(true)
    setError(null)
    const previous = status
    setStatus({ ...status, digestFrequency: frequency }) // optimistic
    try {
      const s = await setWhatsappDigestFrequency(frequency)
      setStatus(s)
    } catch (e) {
      setStatus(previous)
      setError(e instanceof Error ? e.message : "Could not update delivery frequency")
    } finally {
      setBusy(false)
    }
  }

  const handleDisconnect = async () => {
    setBusy(true)
    setError(null)
    try {
      const s = await disconnectWhatsapp()
      setStatus(s)
      setStep("phone")
      setPhone("")
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not disconnect")
    } finally {
      setBusy(false)
    }
  }

  if (step === "loading") {
    return (
      <div className="mb-6 flex items-center justify-center rounded-[20px] bg-vez-surface p-8">
        <Loader2 className="size-5 animate-spin text-vez-mute" />
      </div>
    )
  }

  return (
    <div className="mb-6 rounded-[20px] bg-vez-surface p-4 sm:p-6 md:p-8 w-full overflow-hidden">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex size-11 shrink-0 items-center justify-center rounded-full bg-green-100 text-green-700">
          <MessageCircle className="size-5" />
        </div>
        <div>
          <h2 className="text-lg text-vez-ink">WhatsApp alerts</h2>
          <p className="text-sm text-vez-mute">
            {step === "connected"
              ? "Get your matching alerts delivered straight to WhatsApp."
              : "Verify a WhatsApp number to receive your alert matches instantly."}
          </p>
        </div>
      </div>

      {error && (
        <div className="mt-4 flex items-center justify-between rounded-full bg-red-50 px-4 py-2 text-xs text-red-600">
          <span>{error}</span>
          <button onClick={() => setError(null)} aria-label="Dismiss error">
            <X className="size-3.5" />
          </button>
        </div>
      )}

      {step === "phone" && (
        <div className="mt-5 flex flex-col gap-3 sm:flex-row">
          <input
            placeholder="+9779812345678"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            className={inputClass}
          />
          <button
            onClick={handleSendCode}
            disabled={busy || !phone.trim()}
            className="flex shrink-0 items-center justify-center gap-2 rounded-full bg-vez-navy px-5 py-2.5 text-sm text-white transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            {busy && <Loader2 className="size-4 animate-spin" />}
            Send code
          </button>
        </div>
      )}

      {step === "otp" && (
        <div className="mt-5">
          <p className="mb-3 text-xs text-vez-mute">
            We sent a 6-digit code to {phone} on WhatsApp. It expires in 10 minutes.
          </p>
          <div className="flex flex-col gap-3 sm:flex-row">
            <input
              placeholder="123456"
              inputMode="numeric"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/[^0-9]/g, ""))}
              className={inputClass}
            />
            <button
              onClick={handleVerify}
              disabled={busy || code.length !== 6}
              className="flex shrink-0 items-center justify-center gap-2 rounded-full bg-vez-navy px-5 py-2.5 text-sm text-white transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              {busy && <Loader2 className="size-4 animate-spin" />}
              Verify
            </button>
            <button
              onClick={() => setStep("phone")}
              className="shrink-0 rounded-full px-5 py-2.5 text-sm text-vez-mute transition-colors hover:bg-white hover:text-vez-navy"
            >
              Change number
            </button>
          </div>
        </div>
      )}

      {step === "connected" && status && (
        <div className="mt-5">
          <div className="flex flex-wrap items-center gap-4">
            <span className="flex items-center gap-1.5 rounded-full bg-white px-3 py-1.5 text-xs text-vez-ink">
              <ShieldCheck className="size-3.5 text-green-600" />
              {status.phoneNumberMasked}
            </span>
            <button onClick={handleToggle} disabled={busy} className="flex items-center gap-2 text-sm text-vez-ink">
              {status.alertsEnabled ? (
                <ToggleRight className="size-7 text-vez-navy" />
              ) : (
                <ToggleLeft className="size-7 text-vez-mute" />
              )}
              {status.alertsEnabled ? "Alerts on" : "Alerts off"}
            </button>
            <button
              onClick={handleDisconnect}
              disabled={busy}
              className="ml-auto rounded-full px-4 py-2 text-xs text-vez-mute transition-colors hover:bg-red-50 hover:text-red-600"
            >
              Disconnect
            </button>
          </div>

          <div className="mt-5 border-t border-vez-line/60 pt-5">
            <p className="mb-2.5 text-sm text-vez-ink">Delivery frequency</p>
            <p className="mb-3 text-xs text-vez-mute">
              Digest modes batch matches into one WhatsApp message. Rules marked{" "}
              <span className="text-vez-ink">High priority</span> always send instantly regardless of this setting.
            </p>
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
              {DIGEST_OPTIONS.map((opt) => {
                const Icon = opt.icon
                const active = status.digestFrequency === opt.id
                return (
                  <button
                    key={opt.id}
                    onClick={() => handleSetDigest(opt.id)}
                    disabled={busy}
                    className={`rounded-[14px] p-3.5 text-left transition-colors ${
                      active ? "bg-vez-navy text-white" : "bg-white text-vez-mute hover:text-vez-navy"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <Icon className="size-4" />
                      <span className="text-sm">{opt.label}</span>
                    </div>
                    <p className={`mt-1 text-[11px] ${active ? "text-white/70" : "text-vez-mute"}`}>{opt.desc}</p>
                  </button>
                )
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
