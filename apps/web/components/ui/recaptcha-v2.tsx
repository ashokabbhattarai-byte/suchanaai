"use client"

import React, { useCallback, useEffect, useId, useRef, useState } from "react"

type GlobalGrecaptcha = {
  render: (container: string | HTMLElement, params: Record<string, unknown>) => number
  reset: (widgetId?: number) => void
  getResponse: (widgetId?: number) => string
  ready: (cb: () => void) => void
}

declare global {
  interface Window {
    grecaptcha?: GlobalGrecaptcha
    __recaptchaLoaded?: boolean
    __recaptchaLoading?: Promise<void>
  }
}

let scriptLoadPromise: Promise<void> | null = null

function loadRecaptchaScript(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve()
  if (window.grecaptcha?.render) return Promise.resolve()
  if (scriptLoadPromise) return scriptLoadPromise
  if (window.__recaptchaLoading) return window.__recaptchaLoading

  scriptLoadPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector('script[src*="www.google.com/recaptcha/api.js"]') as HTMLScriptElement | null
    if (existing) {
      if (window.grecaptcha?.render) {
        resolve()
        return
      }
      existing.addEventListener("load", () => resolve())
      existing.addEventListener("error", () => reject(new Error("Failed to load reCAPTCHA")))
      return
    }

    const script = document.createElement("script")
    script.src = "https://www.google.com/recaptcha/api.js?render=explicit"
    script.async = true
    script.defer = true
    script.onload = () => resolve()
    script.onerror = () => reject(new Error("Failed to load reCAPTCHA script"))
    document.head.appendChild(script)
  })

  window.__recaptchaLoading = scriptLoadPromise
  return scriptLoadPromise
}

export interface RecaptchaV2Props {
  siteKey: string
  onVerify: (token: string) => void
  onExpire?: () => void
  onError?: () => void
  theme?: "light" | "dark"
  size?: "normal" | "compact"
  className?: string
}

/**
 * Google reCAPTCHA v2 checkbox. Loads the API script once and renders an
 * explicit widget. The parent receives the token via `onVerify` and should
 * send it as `recaptchaToken` to `POST /contact`. Exposes `reset()` via
 * `window.grecaptcha.reset(widgetId)`.
 *
 * When `siteKey` is falsy the component renders nothing (dev mode without
 * keys — the backend skips verification when RECAPTCHA_SECRET_KEY is empty).
 */
export function RecaptchaV2({ siteKey, onVerify, onExpire, onError, theme = "light", size = "normal", className }: RecaptchaV2Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const widgetIdRef = useRef<number | null>(null)
  const onVerifyRef = useRef(onVerify)
  const onExpireRef = useRef(onExpire)
  const onErrorRef = useRef(onError)
  const [failed, setFailed] = useState(false)
  const id = useId()

  onVerifyRef.current = onVerify
  onExpireRef.current = onExpire
  onErrorRef.current = onError

  const renderWidget = useCallback(() => {
    if (!containerRef.current || !window.grecaptcha?.render || !siteKey) return
    // Avoid double-render (React StrictMode mounts twice)
    if (widgetIdRef.current !== null) {
      try {
        window.grecaptcha.reset(widgetIdRef.current)
      } catch {}
      return
    }
    const containerId = `recaptcha-${id.replace(/:/g, "")}`
    containerRef.current.id = containerId
    try {
      const wid = window.grecaptcha.render(containerId, {
        sitekey: siteKey,
        theme,
        size,
        callback: (token: string) => onVerifyRef.current(token),
        "expired-callback": () => onExpireRef.current?.(),
        "error-callback": () => onErrorRef.current?.(),
      })
      widgetIdRef.current = wid as number
    } catch (err) {
      console.error("[recaptcha] render failed", err)
      setFailed(true)
    }
  }, [siteKey, theme, size, id])

  useEffect(() => {
    if (!siteKey) return
    let cancelled = false
    loadRecaptchaScript()
      .then(() => {
        if (cancelled) return
        // grecaptcha.ready ensures the API is fully initialized
        if (window.grecaptcha?.ready) {
          window.grecaptcha.ready(() => {
            if (!cancelled) renderWidget()
          })
        } else {
          renderWidget()
        }
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })

    return () => {
      cancelled = true
    }
  }, [siteKey, renderWidget])

  if (!siteKey) return null

  if (failed) {
    return (
      <div className={`rounded-xl sm:rounded-[12px] border border-amber-200 bg-amber-50 px-4 py-3 text-sm sm:text-base font-poppins tracking-tight ${className ?? ""}`}>
        Couldn&apos;t load reCAPTCHA. Please refresh the page and try again.
      </div>
    )
  }

  return <div ref={containerRef} className={`max-w-full overflow-hidden ${className ?? ""}`} aria-label="reCAPTCHA verification" />
}

/** Imperative helper for parents that need to reset after a successful submit. */
export function resetRecaptcha(widgetId?: number) {
  try {
    window.grecaptcha?.reset(widgetId)
  } catch {}
}

/** Read the current token (empty if not checked or expired). Prefers widget-scoped getResponse. */
export function getRecaptchaToken(widgetId?: number): string {
  try {
    return window.grecaptcha?.getResponse(widgetId) ?? ""
  } catch {
    return ""
  }
}
