"use client"

import React, { useEffect, useRef, useState } from "react"
import { Mail, Phone, MapPin, Send, CheckCircle2, AlertCircle, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import gsap from "gsap"
import { ScrollTrigger } from "gsap/ScrollTrigger"
import { submitContact, isApiError, isNetworkError } from "@/lib/api"
import { useAuth } from "@/lib/auth-context"
import { toast } from "sonner"
import { RecaptchaV2, resetRecaptcha } from "@/components/ui/recaptcha-v2"

gsap.registerPlugin(ScrollTrigger)

export function ContactSection() {
  const sectionRef = useRef<HTMLDivElement>(null)
  const formRef = useRef<HTMLFormElement>(null)
  const cardsRef = useRef<HTMLDivElement>(null)
  const headingRef = useRef<HTMLDivElement>(null)
  const mountedAt = useRef<string>("")
  const recaptchaSiteKey = (process.env.NEXT_PUBLIC_RECAPTCHA_SITE_KEY ?? "").trim()

  const { user } = useAuth()

  const [formState, setFormState] = useState({
    name: "",
    email: "",
    subject: "",
    message: "",
  })
  const [honeypot, setHoneypot] = useState("")
  const [recaptchaToken, setRecaptchaToken] = useState<string>("")
  const [recaptchaError, setRecaptchaError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [status, setStatus] = useState<"idle" | "success" | "error">("idle")
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    mountedAt.current = String(Date.now())
  }, [])

  useEffect(() => {
    if (user) {
      setFormState((prev) => ({
        ...prev,
        name: prev.name || user.username || user.name || "",
        email: prev.email || user.email || "",
      }))
    }
  }, [user])

  useEffect(() => {
    if (!sectionRef.current) return

    const heading = headingRef.current
    const form = formRef.current
    const cards = cardsRef.current?.querySelectorAll(".contact-card")

    const reset = () => {
      gsap.killTweensOf([heading, form, cards])
      gsap.set(heading, { opacity: 0, y: 40 })
      gsap.set(form, { opacity: 0, x: -40 })
      gsap.set(cards ?? [], { opacity: 0, y: 30, scale: 0.9 })
    }

    const play = () => {
      gsap.to(heading, { opacity: 1, y: 0, duration: 0.4, ease: "power3.out" })
      gsap.to(form, { opacity: 1, x: 0, duration: 0.4, ease: "power3.out", delay: 0.2 })
      gsap.to(Array.from(cards ?? []), {
        opacity: 1,
        y: 0,
        scale: 1,
        duration: 0.3,
        stagger: 0.15,
        ease: "back.out(1.5)",
        delay: 0.3,
      })
    }

    reset()
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) play()
          else reset()
        })
      },
      { threshold: 0.15 },
    )
    observer.observe(sectionRef.current)
    return () => observer.disconnect()
  }, [])

  function validate(): boolean {
    const next: Record<string, string> = {}
    const n = formState.name.trim()
    const e = formState.email.trim()
    const s = formState.subject.trim()
    const m = formState.message.trim()
    if (n.length < 2) next.name = "Name must be at least 2 characters"
    else if (n.length > 100) next.name = "Name too long"
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) next.email = "Enter a valid email"
    else if (e.length > 255) next.email = "Email too long"
    if (s.length < 5) next.subject = "Subject must be at least 5 characters"
    else if (s.length > 200) next.subject = "Subject too long"
    if (m.length < 10) next.message = "Message must be at least 10 characters"
    else if (m.length > 5000) next.message = "Message too long"
    setFieldErrors(next)
    return Object.keys(next).length === 0
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (honeypot.trim().length > 0) {
      setStatus("success")
      toast.success("Message sent — we'll reply within one business day")
      setTimeout(() => setStatus("idle"), 3000)
      return
    }
    if (!validate()) return
    if (recaptchaSiteKey && !recaptchaToken) {
      setRecaptchaError("Please complete the reCAPTCHA verification.")
      toast.error("Please complete the reCAPTCHA")
      return
    }
    setLoading(true)
    setFormError(null)
    setRecaptchaError(null)
    setStatus("idle")
    try {
      await submitContact({
        name: formState.name.trim(),
        email: formState.email.trim(),
        subject: formState.subject.trim(),
        message: formState.message.trim(),
        website: honeypot,
        hpTimestamp: mountedAt.current,
        recaptchaToken: recaptchaToken || undefined,
      })
      setStatus("success")
      toast.success("Message sent — we'll reply within one business day")
      setFormState({
        name: user?.username ?? user?.name ?? formState.name,
        email: user?.email ?? formState.email,
        subject: "",
        message: "",
      })
      setFieldErrors({})
      setHoneypot("")
      setRecaptchaToken("")
      setRecaptchaError(null)
      resetRecaptcha()
      setTimeout(() => setStatus("idle"), 4000)
    } catch (err) {
      setStatus("error")
      if (isNetworkError(err)) {
        setFormError("Couldn't reach the server. Check your connection.")
        toast.error("Network error — check your connection")
      } else if (isApiError(err)) {
        setFormError(err.message)
        toast.error(err.message)
      } else if (err instanceof Error) {
        setFormError(err.message)
        toast.error(err.message)
      } else {
        setFormError("Something went wrong. Please try again.")
        toast.error("Something went wrong")
      }
      setTimeout(() => setStatus("idle"), 4000)
    } finally {
      setLoading(false)
    }
  }

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    setFormState({ ...formState, [e.target.name]: e.target.value })
    if (fieldErrors[e.target.name]) {
      setFieldErrors((prev) => ({ ...prev, [e.target.name]: "" }))
    }
    if (formError) setFormError(null)
    if (status !== "idle") setStatus("idle")
  }

  const contactInfo = [
    { icon: Mail, label: "Email", value: "support@suchana.ai", href: "mailto:support@suchana.ai" },
    { icon: Phone, label: "Phone", value: "+977 9800000000", href: "tel:+9779800000000" },
    { icon: MapPin, label: "Location", value: "Kathmandu, Nepal", href: "#" },
  ]

  return (
    <section
      ref={sectionRef}
      id="contact"
      className="relative py-8 sm:py-12 md:py-20 lg:py-24 px-4 sm:px-6 md:px-8 lg:px-8 overflow-hidden bg-background"
    >
      <div className="absolute inset-0 pointer-events-none opacity-[0.02]">
        <svg width="100%" height="100%">
          <defs>
            <pattern id="contact-grid" width="40" height="40" patternUnits="userSpaceOnUse">
              <path d="M 40 0 L 0 0 0 40" fill="none" stroke="currentColor" strokeWidth="0.5" strokeDasharray="2 2" />
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#contact-grid)" />
        </svg>
      </div>

      <div className="relative z-10 max-w-7xl mx-auto">
        <div ref={headingRef} className="mb-8 sm:mb-12 border-l-2 border-indigo-500 pl-4 sm:pl-5 relative max-w-3xl min-w-0">
          <div className="absolute -left-[2px] top-0 w-4 h-px bg-indigo-500" />
          <div className="absolute -left-[2px] bottom-0 w-4 h-px bg-indigo-500" />
          <div className="flex items-center gap-2 mb-4">
            <span className="relative flex size-2">
              <span className="absolute inline-flex size-full rounded-sm bg-indigo-400 opacity-75 animate-ping" />
              <span className="relative inline-flex size-2 rounded-sm bg-indigo-500" />
            </span>
            <span className="text-[11px] font-mono font-semibold uppercase tracking-[0.2em] text-indigo-400">
              [CONTACT_INTERFACE // GET_IN_TOUCH]
            </span>
          </div>
          <h2 className="text-2xl sm:text-3xl md:text-5xl font-bold text-foreground mb-3 sm:mb-5 leading-tight uppercase tracking-tight break-words">
            Let&apos;s Build <span className="text-indigo-400">Together</span>
          </h2>
          <div className="flex gap-4 items-center mt-6">
            <div className="h-0.5 w-16 bg-indigo-500/30 overflow-hidden relative">
              <div className="absolute inset-0 bg-indigo-500 w-full h-full animate-[scanline_2s_linear_infinite]" />
            </div>
            <p className="text-muted-foreground text-base md:text-lg leading-relaxed max-w-2xl font-normal">
              Have questions, feedback, or partnership inquiries? We&apos;d love to hear from you.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-[1fr_0.9fr] gap-6 sm:gap-8">
          <form
            ref={formRef}
            onSubmit={handleSubmit}
            noValidate
            className="relative bg-card backdrop-blur-xl p-4 sm:p-6 md:p-8 border border-border min-w-0"
          >
            <div className="absolute top-0 left-0 w-2 h-2 border-t-2 border-l-2 border-indigo-500" />
            <div className="absolute top-0 right-0 w-2 h-2 border-t-2 border-r-2 border-indigo-500" />
            <div className="absolute bottom-0 left-0 w-2 h-2 border-b-2 border-l-2 border-indigo-500" />
            <div className="absolute bottom-0 right-0 w-2 h-2 border-b-2 border-r-2 border-indigo-500" />

            {/* Honeypot */}
            <div className="absolute -left-[9999px] h-0 w-0 overflow-hidden" aria-hidden="true">
              <label htmlFor="website_hp_2">Website</label>
              <input id="website_hp_2" name="website" type="text" tabIndex={-1} autoComplete="off" value={honeypot} onChange={(e) => setHoneypot(e.target.value)} />
            </div>

            <div className="space-y-5">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="min-w-0">
                  <label className="block text-xs font-mono font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                    Name <span className="text-red-500">*</span>
                  </label>
                  <Input
                    type="text"
                    name="name"
                    value={formState.name}
                    onChange={handleChange}
                    placeholder="Your full name"
                    required
                    maxLength={100}
                    aria-invalid={!!fieldErrors.name}
                    className={`h-11 bg-background/60 border-border focus-visible:ring-indigo-500/40 ${fieldErrors.name ? "border-red-400" : ""}`}
                  />
                  {fieldErrors.name && <p className="mt-1 text-xs text-red-600">{fieldErrors.name}</p>}
                </div>
                <div className="min-w-0">
                  <label className="block text-xs font-mono font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                    Email <span className="text-red-500">*</span>
                  </label>
                  <Input
                    type="email"
                    name="email"
                    value={formState.email}
                    onChange={handleChange}
                    placeholder="your@email.com"
                    required
                    maxLength={255}
                    aria-invalid={!!fieldErrors.email}
                    className={`h-11 bg-background/60 border-border focus-visible:ring-indigo-500/40 ${fieldErrors.email ? "border-red-400" : ""}`}
                  />
                  {fieldErrors.email && <p className="mt-1 text-xs text-red-600">{fieldErrors.email}</p>}
                </div>
              </div>

              <div>
                <label className="block text-xs font-mono font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                  Subject <span className="text-red-500">*</span>
                </label>
                <Input
                  type="text"
                  name="subject"
                  value={formState.subject}
                  onChange={handleChange}
                  placeholder="How can we help?"
                  required
                  maxLength={200}
                  aria-invalid={!!fieldErrors.subject}
                  className={`h-11 bg-background/60 border-border focus-visible:ring-indigo-500/40 ${fieldErrors.subject ? "border-red-400" : ""}`}
                />
                {fieldErrors.subject && <p className="mt-1 text-xs text-red-600">{fieldErrors.subject}</p>}
              </div>

              <div>
                <div className="mb-2 flex items-center justify-between">
                  <label className="block text-xs font-mono font-semibold uppercase tracking-wider text-muted-foreground">
                    Message <span className="text-red-500">*</span>
                  </label>
                  <span className="text-xs text-muted-foreground tabular-nums">{formState.message.length}/5000</span>
                </div>
                <textarea
                  name="message"
                  value={formState.message}
                  onChange={handleChange}
                  placeholder="Tell us more about your inquiry..."
                  required
                  rows={6}
                  maxLength={5000}
                  aria-invalid={!!fieldErrors.message}
                  className={`w-full px-4 py-3 bg-background/60 border rounded-lg text-sm text-foreground placeholder:text-muted-foreground/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-indigo-500/40 transition-all resize-none ${fieldErrors.message ? "border-red-400" : "border-border"}`}
                />
                {fieldErrors.message && <p className="mt-1 text-xs text-red-600">{fieldErrors.message}</p>}
              </div>

              {formError && (
                <div className="flex items-center gap-2 p-3 bg-destructive/10 border border-destructive/30 text-destructive text-sm font-medium">
                  <AlertCircle className="size-4 shrink-0" />
                  <span>{formError}</span>
                </div>
              )}

              {status === "success" && (
                <div className="flex items-center gap-2 p-3 bg-indigo-500/10 border border-indigo-500/30 text-indigo-400 text-sm font-medium">
                  <CheckCircle2 className="size-4" />
                  <span>Message sent successfully! We&apos;ll get back to you soon.</span>
                </div>
              )}

              {recaptchaSiteKey ? (
                <div>
                  <RecaptchaV2
                    siteKey={recaptchaSiteKey}
                    theme="light"
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
                  {recaptchaError && <p className="mt-1.5 text-xs text-red-600 flex items-center gap-1"><AlertCircle className="size-3.5" />{recaptchaError}</p>}
                </div>
              ) : (
                <p className="text-xs text-amber-700 border border-amber-200 bg-amber-50 rounded-lg px-3 py-2">
                  reCAPTCHA not configured (set <code>NEXT_PUBLIC_RECAPTCHA_SITE_KEY</code> to enable it).
                </p>
              )}

              {status === "error" && !formError && (
                <div className="flex items-center gap-2 p-3 bg-destructive/10 border border-destructive/30 text-destructive text-sm font-medium">
                  <AlertCircle className="size-4" />
                  <span>Something went wrong. Please try again.</span>
                </div>
              )}

              <Button
                type="submit"
                size="lg"
                disabled={loading}
                className="w-full h-12 gap-2 text-sm font-semibold uppercase tracking-wide bg-indigo-600 hover:bg-indigo-500 border border-indigo-500/30 shadow-lg shadow-indigo-500/20 disabled:opacity-60"
              >
                {loading ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
                {loading ? "Sending…" : "Send Message"}
              </Button>
              <p className="text-center text-xs text-muted-foreground">We&apos;ll get back within one business day · Max 5 messages/hour</p>
            </div>
          </form>

          <div ref={cardsRef} className="space-y-4">
            {contactInfo.map((item) => {
              const Icon = item.icon
              return (
                <a
                  key={item.label}
                  href={item.href}
                  className="contact-card block relative bg-card backdrop-blur-xl p-6 border border-border group hover:bg-card transition-all duration-300"
                >
                  <div className="absolute top-0 left-0 w-1.5 h-1.5 border-t border-l border-indigo-500" />
                  <div className="absolute top-0 right-0 w-1.5 h-1.5 border-t border-r border-indigo-500" />
                  <div className="absolute bottom-0 left-0 w-1.5 h-1.5 border-b border-l border-indigo-500" />
                  <div className="absolute bottom-0 right-0 w-1.5 h-1.5 border-b border-r border-indigo-500" />
                  <div className="absolute inset-0 bg-gradient-to-b from-indigo-500/0 via-indigo-500/5 to-indigo-500/0 opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none" />
                  <div className="relative flex items-center gap-4">
                    <div className="size-12 bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center shrink-0 group-hover:scale-110 transition-transform duration-300">
                      <Icon className="size-5 text-indigo-400" />
                    </div>
                    <div className="flex-1">
                      <p className="text-[10px] font-mono font-semibold uppercase tracking-wider text-muted-foreground mb-1">{item.label}</p>
                      <p className="text-base font-medium text-foreground group-hover:text-indigo-400 transition-colors">{item.value}</p>
                    </div>
                  </div>
                </a>
              )
            })}
            <div className="contact-card relative bg-card backdrop-blur-xl p-6 border border-border">
              <div className="absolute top-0 left-0 w-1.5 h-1.5 border-t border-l border-indigo-500" />
              <div className="absolute top-0 right-0 w-1.5 h-1.5 border-t border-r border-indigo-500" />
              <div className="absolute bottom-0 left-0 w-1.5 h-1.5 border-b border-l border-indigo-500" />
              <div className="absolute bottom-0 right-0 w-1.5 h-1.5 border-b border-r border-indigo-500" />
              <p className="text-[10px] font-mono font-semibold uppercase tracking-wider text-muted-foreground mb-3">Business Hours</p>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Sunday - Friday</span>
                  <span className="text-foreground font-medium">10:00 AM - 6:00 PM</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Saturday</span>
                  <span className="text-destructive">Closed</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
