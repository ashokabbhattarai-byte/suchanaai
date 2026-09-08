"use client"

import { useCallback, useEffect, useState } from "react"
import { Phone, CheckCircle, XCircle, Loader2, QrCode, LogOut } from "lucide-react"
import { fetchAdminWhatsappStatus, fetchAdminWhatsappQr, logoutAdminWhatsapp, AdminWhatsappStatus } from "@/lib/api"
import { toast } from "sonner"
import { useConfirm } from "@/components/ui/confirm-dialog"

const STATUS_POLL_MS = 5000

/**
 * Admin-only control panel for the single shared Evolution API sender
 * instance — separate from each user's own opt-in number
 * (WhatsappConnectCard). Lets an admin see whether the sender is connected,
 * pull a fresh QR to link a different number, and force-logout the current
 * session so a new one can be linked.
 */
export function AdminWhatsappCard() {
  const confirm = useConfirm()
  const [status, setStatus] = useState<AdminWhatsappStatus | null>(null)
  const [qr, setQr] = useState<{ base64: string | null; pairingCode: string | null } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refreshStatus = useCallback(() => {
    fetchAdminWhatsappStatus()
      .then(setStatus)
      .catch((e) => setError(e.message))
  }, [])

  useEffect(() => {
    refreshStatus()
    const interval = setInterval(refreshStatus, STATUS_POLL_MS)
    return () => clearInterval(interval)
  }, [refreshStatus])

  // Once connected, drop any QR we were showing — it's no longer relevant.
  useEffect(() => {
    if (status?.state === "open") setQr(null)
  }, [status?.state])

  const handleGetQr = async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await fetchAdminWhatsappQr()
      if (!result.available) {
        setError("Evolution API is not reachable — check EVOLUTION_API_URL/EVOLUTION_API_KEY")
      } else {
        setQr({ base64: result.base64, pairingCode: result.pairingCode })
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not fetch a QR code")
    } finally {
      setBusy(false)
    }
  }

  const handleLogout = async () => {
    if (
      !(await confirm({
        title: "Disconnect the shared WhatsApp sender number?",
        description: "All users' alerts will stop delivering until a new number is linked.",
        confirmLabel: "Disconnect",
        danger: true,
      }))
    )
      return
    setBusy(true)
    setError(null)
    try {
      await logoutAdminWhatsapp()
      setQr(null)
      toast.success("WhatsApp sender disconnected")
      refreshStatus()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not disconnect")
    } finally {
      setBusy(false)
    }
  }

  const connected = status?.state === "open"

  return (
    <div className="rounded-[20px] bg-white p-6 md:p-8">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div className={`flex size-11 items-center justify-center rounded-full ${connected ? "bg-vez-navy text-white" : "bg-vez-surface text-vez-mute"}`}>
            <Phone className="size-5" />
          </div>
          <div>
            <h2 className="text-lg text-vez-ink">WhatsApp (shared sender)</h2>
            <div className="mt-1.5 flex items-center gap-2">
              {connected ? (
                <span className="flex items-center gap-1 rounded-full bg-vez-sky/30 px-3 py-1 text-xs text-vez-navy">
                  <CheckCircle className="size-3" /> Connected
                </span>
              ) : status ? (
                <span className="flex items-center gap-1 rounded-full bg-red-50 px-3 py-1 text-xs text-red-600">
                  <XCircle className="size-3" /> {status.state === "connecting" ? "Connecting…" : status.configured ? "Not connected" : "Not configured"}
                </span>
              ) : (
                <Loader2 className="size-3.5 animate-spin text-vez-mute" />
              )}
            </div>
          </div>
        </div>
        {connected && (
          <button
            onClick={handleLogout}
            disabled={busy}
            className="flex items-center gap-1.5 rounded-full border border-vez-line px-4 py-2 text-xs text-vez-ink transition-colors hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
          >
            <LogOut className="size-3.5" /> Disconnect
          </button>
        )}
      </div>

      <p className="mt-4 text-xs text-vez-mute">
        This is the single WhatsApp number that sends every user&apos;s alerts. Each user separately verifies their own
        number to receive alerts — this panel only controls the sender itself.
      </p>

      {error && (
        <div className="mt-4 rounded-full bg-red-50 px-4 py-2 text-xs text-red-600">{error}</div>
      )}

      {!connected && status?.configured && (
        <div className="mt-6">
          {!qr ? (
            <button
              onClick={handleGetQr}
              disabled={busy}
              className="flex items-center gap-1.5 rounded-full bg-vez-navy px-5 py-2.5 text-sm text-white transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              {busy ? <Loader2 className="size-4 animate-spin" /> : <QrCode className="size-4" />}
              Get QR code
            </button>
          ) : (
            <div className="flex flex-col items-start gap-3">
              {qr.base64 && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={qr.base64} alt="WhatsApp QR code" className="size-56 rounded-[16px] border border-vez-line" />
              )}
              {qr.pairingCode && <p className="text-sm text-vez-ink">Pairing code: {qr.pairingCode}</p>}
              <p className="text-xs text-vez-mute">
                Scan with WhatsApp → Settings → Linked Devices → Link a Device. Expires in ~60 seconds.
              </p>
              <button
                onClick={handleGetQr}
                disabled={busy}
                className="rounded-full border border-vez-line px-4 py-2 text-xs text-vez-ink transition-colors hover:bg-vez-surface"
              >
                Refresh QR
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
