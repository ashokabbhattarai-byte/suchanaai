"use client"

import { useCallback, useEffect, useState } from "react"
import { Mail, CheckCircle, XCircle, Loader2, Eye, EyeOff, Save, Send } from "lucide-react"
import {
  fetchEmailChannel,
  updateEmailChannel,
  testEmailChannel,
  EmailChannelConfig,
  EmailChannelUpdate,
} from "@/lib/api"
import { toast } from "sonner"

const fieldClass =
  "h-11 w-full rounded-full border border-vez-line bg-white px-5 text-sm text-vez-ink outline-none transition-colors placeholder:text-vez-mute focus:border-vez-sky"

/** Mirrors the API's SMTP_ALLOWED_PORTS default — submission ports only. */
const PORT_OPTIONS = [
  { value: 587, label: "587 — STARTTLS (recommended)", secure: false },
  { value: 465, label: "465 — implicit TLS", secure: true },
  { value: 2525, label: "2525 — STARTTLS (alt)", secure: false },
  { value: 25, label: "25 — STARTTLS (rarely allowed)", secure: false },
]

type Draft = {
  host: string
  port: number
  secure: boolean
  username: string
  password: string
  fromAddress: string
  fromName: string
}

const draftFrom = (c: EmailChannelConfig): Draft => ({
  host: c.host,
  port: c.port,
  secure: c.secure,
  username: c.username,
  // Always blank: the server never sends the stored password back, and an
  // empty value on save means "keep the one you have".
  password: "",
  fromAddress: c.fromAddress,
  fromName: c.fromName,
})

/**
 * Admin configuration for the SMTP alert channel. The password box starts
 * empty on every load and is only submitted when the admin actually types a
 * new one — the real credential exists on the server and nowhere else.
 */
export function AdminEmailCard() {
  const [config, setConfig] = useState<EmailChannelConfig | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [showPassword, setShowPassword] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [toggling, setToggling] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    fetchEmailChannel()
      .then((c) => {
        setConfig(c)
        setDraft(draftFrom(c))
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load email settings"))
  }, [])

  useEffect(load, [load])

  const apply = async (body: EmailChannelUpdate) => {
    const next = await updateEmailChannel(body)
    setConfig(next)
    setDraft(draftFrom(next))
    return next
  }

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((d) => (d ? { ...d, [key]: value } : d))

  const handleSave = async () => {
    if (!draft) return
    setSaving(true)
    setError(null)
    try {
      await apply({
        host: draft.host.trim(),
        port: draft.port,
        secure: draft.secure,
        username: draft.username.trim(),
        // Only sent when non-empty — see draftFrom().
        ...(draft.password ? { password: draft.password } : {}),
        fromAddress: draft.fromAddress.trim(),
        fromName: draft.fromName.trim() || "Suchana AI",
      })
      setShowPassword(false)
      toast.success("Email channel saved")
    } catch (e) {
      const message = e instanceof Error ? e.message : "Could not save"
      setError(message)
      toast.error(message)
    } finally {
      setSaving(false)
    }
  }

  const handleToggle = async () => {
    if (!config) return
    setToggling(true)
    setError(null)
    try {
      const next = await apply({ enabled: !config.enabled })
      toast.success(next.enabled ? "Email alerts enabled" : "Email alerts disabled")
    } catch (e) {
      const message = e instanceof Error ? e.message : "Could not change status"
      setError(message)
      toast.error(message)
    } finally {
      setToggling(false)
    }
  }

  const handleTest = async () => {
    setTesting(true)
    setError(null)
    try {
      const result = await testEmailChannel()
      toast.success(`Test message sent to ${result.sentTo}`)
      load()
    } catch (e) {
      const message = e instanceof Error ? e.message : "Test failed"
      setError(message)
      toast.error(message)
      load()
    } finally {
      setTesting(false)
    }
  }

  if (!config || !draft) {
    return (
      <div className="flex items-center gap-2 rounded-[20px] bg-white p-6 text-sm text-vez-mute md:p-8">
        <Loader2 className="size-4 animate-spin" /> Loading email channel…
      </div>
    )
  }

  return (
    <div className="rounded-[20px] bg-white p-4 sm:p-6 md:p-8 w-full overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-4">
          <div
            className={`flex size-11 items-center justify-center rounded-full ${
              config.enabled ? "bg-vez-navy text-white" : "bg-vez-surface text-vez-mute"
            }`}
          >
            <Mail className="size-5" />
          </div>
          <div>
            <h2 className="text-lg text-vez-ink">Email (SMTP)</h2>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              {config.configured ? (
                config.lastTestOk === false ? (
                  <span className="flex items-center gap-1 rounded-full bg-red-50 px-3 py-1 text-xs text-red-600">
                    <XCircle className="size-3" /> Last test failed
                  </span>
                ) : (
                  <span className="flex items-center gap-1 rounded-full bg-vez-sky/30 px-3 py-1 text-xs text-vez-navy">
                    <CheckCircle className="size-3" /> Configured
                  </span>
                )
              ) : (
                <span className="rounded-full border border-vez-line px-3 py-1 text-xs text-vez-mute">
                  Not configured
                </span>
              )}
              {config.lastTestedAt && (
                <span className="text-[10px] text-vez-mute">
                  Last tested:{" "}
                  {new Date(config.lastTestedAt).toLocaleString("en-US", {
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
              )}
            </div>
          </div>
        </div>
        <button
          onClick={handleToggle}
          disabled={toggling}
          className={`rounded-full px-4 py-2 text-xs transition-colors disabled:opacity-50 ${
            config.enabled
              ? "bg-vez-navy text-white hover:opacity-90"
              : "border border-vez-line text-vez-mute hover:bg-vez-surface hover:text-vez-navy"
          }`}
        >
          {toggling ? <Loader2 className="size-3.5 animate-spin" /> : config.enabled ? "Enabled" : "Disabled"}
        </button>
      </div>

      <p className="mt-4 text-xs text-vez-mute">
        Credentials are encrypted before they are stored and are never sent back to this page. TLS is enforced on every
        connection, and a test message can only be delivered to your own admin account address.
      </p>

      {error && <div className="mt-4 rounded-[14px] bg-red-50 px-4 py-2 text-xs text-red-600">{error}</div>}

      <div className="mt-6 grid grid-cols-1 md:grid-cols-2 gap-4 sm:gap-6">
        <div>
          <label className="mb-2 block text-sm text-vez-mute">SMTP host</label>
          <input
            className={fieldClass}
            value={draft.host}
            placeholder="smtp.gmail.com"
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => set("host", e.target.value)}
          />
        </div>

        <div>
          <label className="mb-2 block text-sm text-vez-mute">Port &amp; encryption</label>
          <select
            className={fieldClass}
            value={draft.port}
            onChange={(e) => {
              const option = PORT_OPTIONS.find((o) => o.value === Number(e.target.value))!
              set("port", option.value)
              // Implicit TLS vs STARTTLS is a property of the port, so it is
              // derived rather than left as a separate footgun of a checkbox.
              set("secure", option.secure)
            }}
          >
            {PORT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="mb-2 block text-sm text-vez-mute">Username</label>
          <input
            className={fieldClass}
            value={draft.username}
            placeholder="notices@suchanaai.tech"
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => set("username", e.target.value)}
          />
        </div>

        <div>
          <label className="mb-2 block text-sm text-vez-mute">
            Password {config.passwordConfigured && <span className="text-[10px]">(stored — leave blank to keep)</span>}
          </label>
          <div className="relative">
            <input
              className={`${fieldClass} pr-12`}
              type={showPassword ? "text" : "password"}
              value={draft.password}
              placeholder={config.passwordConfigured ? (config.passwordPreview ?? "••••••••") : "App password"}
              autoComplete="new-password"
              onChange={(e) => set("password", e.target.value)}
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              aria-label={showPassword ? "Hide password" : "Show password"}
              className="absolute right-4 top-1/2 -translate-y-1/2 text-vez-mute transition-colors hover:text-vez-ink"
            >
              {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
          </div>
        </div>

        <div>
          <label className="mb-2 block text-sm text-vez-mute">From address</label>
          <input
            className={fieldClass}
            value={draft.fromAddress}
            placeholder="noreply@suchanaai.tech"
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => set("fromAddress", e.target.value)}
          />
        </div>

        <div>
          <label className="mb-2 block text-sm text-vez-mute">From name</label>
          <input
            className={fieldClass}
            value={draft.fromName}
            placeholder="Suchana AI"
            onChange={(e) => set("fromName", e.target.value)}
          />
        </div>
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-2.5">
        <button
          className="flex items-center gap-1.5 rounded-full bg-vez-navy px-4 py-2 text-xs text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          onClick={handleSave}
          disabled={saving}
        >
          {saving ? (
            <>
              <Loader2 className="size-3.5 animate-spin" /> Saving…
            </>
          ) : (
            <>
              <Save className="size-3.5" /> Save
            </>
          )}
        </button>
        <button
          className="flex items-center gap-1.5 rounded-full border border-vez-line px-4 py-2 text-xs text-vez-ink transition-colors hover:bg-vez-surface disabled:opacity-50"
          onClick={handleTest}
          disabled={testing || !config.configured}
          title={config.configured ? undefined : "Save working credentials first"}
        >
          {testing ? (
            <>
              <Loader2 className="size-3.5 animate-spin" /> Sending…
            </>
          ) : (
            <>
              <Send className="size-3.5" /> Send test to my email
            </>
          )}
        </button>
      </div>
    </div>
  )
}
