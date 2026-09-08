"use client"

import React, { useEffect, useRef, useState } from "react"
import { Mail, Phone, MapPin, CheckCircle2, AlertCircle, Loader2 } from "lucide-react"
import { Reveal } from "./reveal"
import { AnimatedHeading } from "./animated-heading"
import { Eyebrow } from "./vezigno-ui"
import { submitContact, isApiError, isNetworkError } from "@/lib/api"
import { useAuth } from "@/lib/auth-context"
import { toast } from "sonner"
import { RecaptchaV2, resetRecaptcha } from "@/components/ui/recaptcha-v2"

const contactInfo = [
  { icon: Mail, label: "Email", value: "support@suchana.ai", href: "mailto:support@suchana.ai" },
  { icon: Phone, label: "Phone", value: "+977 9800000000", href: "tel:+9779800000000" },
  { icon: MapPin, label: "Location", value: "Kathmandu, Nepal", href: "#" },
]

const inputClass =
  "w-full rounded-[12px] border border-vez-line bg-vez-surface/60 px-4 py-3 text-base text-vez-ink outline-none transition-all placeholder:text-vez-mute/60 focus:border-vez-navy focus:bg-white focus:ring-2 focus:ring-vez-sky/30"

const inputErrorClass =
  "w-full rounded-[12px] border border-red-300 bg-red-50/60 px-4 py-3 text-base text-vez-ink outline-none transition-all placeholder:text-vez-mute/60 focus:border-red-400 focus:bg-white focus:ring-2 focus:ring-red-200"

export function VezignoContact() {
  const { user } = useAuth()
  const hpRef = useRef<HTMLInputElement>(null)
  const mountedAt = useRef<string>("")
  const recaptchaSiteKey = (process.env.NEXT_PUBLIC_RECAPTCHA_SITE_KEY ?? "").trim()

  const [form, setForm] = useState({ name: "", email: "", subject: "", message: "" })
  const [honeypot, setHoneypot] = useState("")
  const [recaptchaToken, setRecaptchaToken] = useState<string>("")
  const [recaptchaError, setRecaptchaError] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(false)
  const [success, setSuccess] = useState<string | null>(null)

  // Prefill when signed in
  useEffect(() => {
    if (user) {
      setForm((prev) => ({
        ...prev,
        name: prev.name || user.username || user.name || "",
        email: prev.email || user.email || "",
      }))
    }
  }, [user])

  useEffect(() => {
    mountedAt.current = String(Date.now())
  }, [])

  function validate(): boolean {
    const next: Record<string, string> = {}
    const n = form.name.trim()
    const e = form.email.trim()
    const s = form.subject.trim()
    const m = form.message.trim()
    if (n.length < 2) next.name = "Name must be at least 2 characters"
    else if (n.length > 100) next.name = "Name too long (max 100)"
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) next.email = "Enter a valid email address"
    else if (e.length > 255) next.email = "Email too long"
    if (s.length < 5) next.subject = "Subject must be at least 5 characters"
    else if (s.length > 200) next.subject = "Subject too long (max 200)"
    if (m.length < 10) next.message = "Message must be at least 10 characters"
    else if (m.length > 5000) next.message = "Message too long (max 5000)"
    setErrors(next)
    return Object.keys(next).length === 0
  }

  const onChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target
    setForm((prev) => ({ ...prev, [name]: value }))
    if (errors[name]) setErrors((prev) => ({ ...prev, [name]: "" }))
    if (success) setSuccess(null)
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (honeypot.trim().length > 0) {
      // Silently succeed for bots
      setSuccess("Thanks — we'll get back within one business day.")
      return
    }
    if (!validate()) return
    if (recaptchaSiteKey && !recaptchaToken) {
      setRecaptchaError("Please complete the reCAPTCHA verification.")
      toast.error("Please complete the reCAPTCHA")
      return
    }
    setLoading(true)
    setSuccess(null)
    setRecaptchaError(null)
    try {
      const res = await submitContact({
        name: form.name.trim(),
        email: form.email.trim(),
        subject: form.subject.trim(),
        message: form.message.trim(),
        website: honeypot,
        hpTimestamp: mountedAt.current,
        recaptchaToken: recaptchaToken || undefined,
      })
      setSuccess(res.message ?? "Message sent successfully! We'll get back to you soon.")
      toast.success("Message sent — we'll reply within one business day")
      setForm({ name: user?.username ?? user?.name ?? form.name, email: user?.email ?? form.email, subject: "", message: "" })
      setErrors({})
      setHoneypot("")
      setRecaptchaToken("")
      setRecaptchaError(null)
      resetRecaptcha()
      if (hpRef.current) hpRef.current.value = ""
    } catch (err) {
      if (isNetworkError(err)) {
        toast.error("Network error — check your connection and try again")
        setErrors({ _form: "Couldn't reach the server. Check your connection." })
      } else if (isApiError(err)) {
        const status = err.status
        if (status === 429 || err.message.toLowerCase().includes("too many")) {
          toast.error(err.message)
          setErrors({ _form: err.message })
        } else if (status === 400) {
          setErrors({ _form: err.message })
          toast.error(err.message)
        } else {
          toast.error(err.message || "Something went wrong")
          setErrors({ _form: err.message || "Something went wrong. Please try again." })
        }
      } else if (err instanceof Error) {
        toast.error(err.message)
        setErrors({ _form: err.message })
      } else {
        toast.error("Something went wrong")
        setErrors({ _form: "Something went wrong. Please try again." })
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <section id="contact" className="bg-white overflow-hidden">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-10 sm:py-16 md:py-20 lg:py-24">
        <Reveal>
          <Eyebrow>Contact</Eyebrow>
        </Reveal>
        <AnimatedHeading
          text="Questions, feedback, or partnerships - write to us."
          className="mt-3 sm:mt-4 max-w-[18ch] text-2xl sm:text-3xl lg:text-4xl xl:text-5xl font-normal leading-[1.12] tracking-[-0.04em] text-vez-ink"
        />

        <div className="mt-8 sm:mt-12 grid gap-4 sm:gap-6 lg:mt-16 lg:grid-cols-[1.2fr_0.8fr]">
          {/* Form card */}
          <Reveal className="min-w-0">
            <form onSubmit={onSubmit} noValidate className="vz-glass rounded-xl sm:rounded-[24px] p-4 sm:p-6 md:p-8 lg:p-10 min-w-0">
              {/* Honeypot — visually hidden, not display:none so naive bots still fill it */}
              <div className="absolute -left-[9999px] h-0 w-0 overflow-hidden" aria-hidden="true">
                <label htmlFor="website_hp">Website</label>
                <input
                  ref={hpRef}
                  id="website_hp"
                  name="website"
                  type="text"
                  tabIndex={-1}
                  autoComplete="off"
                  value={honeypot}
                  onChange={(e) => setHoneypot(e.target.value)}
                />
              </div>

              <div className="grid gap-4 sm:gap-5 grid-cols-1 sm:grid-cols-2">
                <div className="min-w-0">
                  <label htmlFor="contact-name" className="mb-1.5 sm:mb-2 block text-xs sm:text-sm text-vez-mute">
                    Name <span className="text-red-500">*</span>
                  </label>
                  <input
                    id="contact-name"
                    type="text"
                    name="name"
                    value={form.name}
                    onChange={onChange}
                    placeholder="Your full name"
                    required
                    maxLength={100}
                    aria-invalid={!!errors.name}
                    aria-describedby={errors.name ? "contact-name-error" : undefined}
                    className={errors.name ? inputErrorClass : inputClass}
                  />
                  {errors.name && (
                    <p id="contact-name-error" className="mt-1.5 text-xs text-red-600">
                      {errors.name}
                    </p>
                  )}
                </div>
                <div className="min-w-0">
                  <label htmlFor="contact-email" className="mb-1.5 sm:mb-2 block text-xs sm:text-sm text-vez-mute">
                    Email <span className="text-red-500">*</span>
                  </label>
                  <input
                    id="contact-email"
                    type="email"
                    name="email"
                    value={form.email}
                    onChange={onChange}
                    placeholder="your@email.com"
                    required
                    maxLength={255}
                    aria-invalid={!!errors.email}
                    aria-describedby={errors.email ? "contact-email-error" : undefined}
                    className={errors.email ? inputErrorClass : inputClass}
                  />
                  {errors.email && (
                    <p id="contact-email-error" className="mt-1.5 text-xs text-red-600">
                      {errors.email}
                    </p>
                  )}
                </div>
              </div>

              <div className="mt-4 sm:mt-5 min-w-0">
                <label htmlFor="contact-subject" className="mb-1.5 sm:mb-2 block text-xs sm:text-sm text-vez-mute">
                  Subject <span className="text-red-500">*</span>
                </label>
                <input
                  id="contact-subject"
                  type="text"
                  name="subject"
                  value={form.subject}
                  onChange={onChange}
                  placeholder="How can we help?"
                  required
                  maxLength={200}
                  aria-invalid={!!errors.subject}
                  aria-describedby={errors.subject ? "contact-subject-error" : undefined}
                  className={errors.subject ? inputErrorClass : inputClass}
                />
                {errors.subject && (
                  <p id="contact-subject-error" className="mt-1.5 text-xs text-red-600">
                    {errors.subject}
                  </p>
                )}
              </div>

              <div className="mt-4 sm:mt-5 min-w-0">
                <div className="mb-1.5 sm:mb-2 flex items-center justify-between gap-2 min-w-0">
                  <label htmlFor="contact-message" className="block text-xs sm:text-sm text-vez-mute">
                    Message <span className="text-red-500">*</span>
                  </label>
                  <span className="text-xs text-vez-mute tabular-nums shrink-0">{form.message.length}/5000</span>
                </div>
                <textarea
                  id="contact-message"
                  name="message"
                  value={form.message}
                  onChange={onChange}
                  placeholder="Tell us more about your inquiry…"
                  required
                  rows={6}
                  maxLength={5000}
                  aria-invalid={!!errors.message}
                  aria-describedby={errors.message ? "contact-message-error" : undefined}
                  className={`${errors.message ? inputErrorClass : inputClass} resize-none`}
                />
                {errors.message && (
                  <p id="contact-message-error" className="mt-1.5 text-xs text-red-600">
                    {errors.message}
                  </p>
                )}
              </div>

              {/* reCAPTCHA v2 checkbox */}
              {recaptchaSiteKey ? (
                <div className="mt-5">
                  <RecaptchaV2
                    siteKey={recaptchaSiteKey}
                    onVerify={(token) => {
                      setRecaptchaToken(token)
                      setRecaptchaError(null)
                    }}
                    onExpire={() => {
                      setRecaptchaToken("")
                      setRecaptchaError("reCAPTCHA expired — please verify again.")
                    }}
                    onError={() => {
                      setRecaptchaToken("")
                      setRecaptchaError("reCAPTCHA failed to load — please refresh.")
                    }}
                  />
                  {recaptchaError && (
                    <p className="mt-2 text-xs text-red-600 flex items-center gap-1">
                      <AlertCircle className="size-3.5" />
                      {recaptchaError}
                    </p>
                  )}
                  <p className="mt-1.5 text-xs text-vez-mute">Protected by reCAPTCHA — Privacy &amp; Terms apply.</p>
                </div>
              ) : (
                <p className="mt-5 text-xs text-amber-700 border border-amber-200 bg-amber-50 rounded-[12px] px-3 py-2">
                  reCAPTCHA not configured (set <code>NEXT_PUBLIC_RECAPTCHA_SITE_KEY</code> to enable it).
                </p>
              )}

              {/* Form-level error */}
              {errors._form && (
                <div className="mt-5 flex items-center gap-2 rounded-[12px] bg-red-50 px-4 py-3 text-sm text-red-700 border border-red-200">
                  <AlertCircle className="size-4 shrink-0" />
                  {errors._form}
                </div>
              )}

              {success && (
                <div className="mt-5 flex items-center gap-2 rounded-[12px] bg-vez-sky/30 px-4 py-3 text-sm text-vez-ink border border-vez-sky/40">
                  <CheckCircle2 className="size-4 shrink-0" />
                  {success}
                </div>
              )}

              <button
                type="submit"
                disabled={loading}
                className="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-full bg-vez-navy px-6 py-3.5 text-base text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto sm:min-w-[180px]"
              >
                {loading ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    Sending…
                  </>
                ) : (
                  "Send message"
                )}
              </button>
              <p className="mt-3 text-xs text-vez-mute">We&apos;ll get back within one business day. Max 5 messages per hour.</p>
            </form>
          </Reveal>

          {/* Info cards */}
          <div className="flex flex-col gap-4 sm:gap-6 min-w-0">
            {contactInfo.map((item, i) => {
              const Icon = item.icon
              return (
                <Reveal key={item.label} delay={i * 80}>
                  <a
                    href={item.href}
                    className="vz-sweep vz-glass group flex items-center gap-4 sm:gap-5 rounded-xl sm:rounded-[20px] p-4 sm:p-6 min-w-0"
                  >
                    <div className="flex size-10 sm:size-12 shrink-0 items-center justify-center rounded-full bg-white">
                      <Icon className="size-4 sm:size-5 text-vez-navy" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-xs sm:text-sm text-vez-mute transition-colors duration-300 group-hover:text-vez-ink/60">{item.label}</p>
                      <p className="text-sm sm:text-base text-vez-ink break-all sm:break-normal">{item.value}</p>
                    </div>
                  </a>
                </Reveal>
              )
            })}

            <Reveal delay={240}>
              <div className="vz-glass rounded-xl sm:rounded-[20px] p-4 sm:p-6 min-w-0">
                <p className="text-xs sm:text-sm text-vez-mute">Business hours</p>
                <div className="mt-2 sm:mt-3 flex flex-col min-[360px]:flex-row min-[360px]:justify-between gap-1 min-[360px]:gap-0 text-sm sm:text-base">
                  <span className="text-vez-mute">Sunday – Friday</span>
                  <span className="text-vez-ink">10:00 AM – 6:00 PM</span>
                </div>
                <div className="mt-1 sm:mt-2 flex flex-col min-[360px]:flex-row min-[360px]:justify-between gap-1 min-[360px]:gap-0 text-sm sm:text-base">
                  <span className="text-vez-mute">Saturday</span>
                  <span className="text-vez-ink">Closed</span>
                </div>
              </div>
            </Reveal>
          </div>
        </div>
      </div>
    </section>
  )
}
