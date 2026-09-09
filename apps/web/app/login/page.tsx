"use client"

import React, { useState, useEffect, useRef, Suspense } from "react"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { GoogleLogin } from "@react-oauth/google"
import { ArrowLeft, ArrowUpRight } from "lucide-react"
import { useAuth } from "@/lib/auth-context"

function LoginForm() {
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)
  const [googleWidth, setGoogleWidth] = useState("320")
  const containerRef = useRef<HTMLDivElement>(null)
  const { loginWithGoogle } = useAuth()
  const router = useRouter()
  const searchParams = useSearchParams()
  const redirect = searchParams.get("redirect")

  const safeRedirect = (() => {
    if (!redirect || !redirect.startsWith("/") || redirect.startsWith("//")) return null
    return redirect
  })()

  // Responsive Google button width: prevents overflow on 320-375px devices
  // where fixed 384px would cause horizontal scroll
  useEffect(() => {
    const updateWidth = () => {
      if (containerRef.current) {
        const w = containerRef.current.clientWidth
        // Clamp between 280 and 384, use available container width
        const next = Math.min(384, Math.max(280, w))
        setGoogleWidth(String(next))
      } else {
        const vw = window.innerWidth
        // px-4 (16) each side =32 + safe area buffer
        const next = Math.min(384, Math.max(280, vw - 32))
        setGoogleWidth(String(next))
      }
    }
    updateWidth()
    window.addEventListener("resize", updateWidth)
    return () => window.removeEventListener("resize", updateWidth)
  }, [])

  const handleGoogleSuccess = async (credential?: string) => {
    setError("")
    setLoading(true)
    const u = credential ? await loginWithGoogle(credential) : null
    if (u) {
      if (safeRedirect) router.replace(safeRedirect)
      else router.push(u.role === "admin" ? "/admin" : "/dashboard")
    } else {
      setError("Google sign-in failed. Please try again.")
    }
    setLoading(false)
  }

  return (
    <div className="flex min-h-[100dvh] w-full bg-white font-poppins antialiased overflow-x-hidden">
      {/* Left panel - sign-in */}
      <div className="flex min-h-[100dvh] w-full flex-col justify-center px-4 py-8 sm:px-8 sm:py-12 lg:w-1/2 lg:px-16 lg:py-12 pt-[calc(1.5rem+env(safe-area-inset-top))] pb-[calc(1.5rem+env(safe-area-inset-bottom))] overflow-x-hidden">
        <div ref={containerRef} className="mx-auto flex w-full max-w-md flex-col gap-6 sm:gap-10 min-w-0">
          {/* Back */}
          <button
            onClick={() => router.back()}
            className="flex w-fit items-center gap-2 rounded-full px-1 py-1 text-sm sm:text-base text-vez-mute transition-colors hover:text-vez-ink min-h-[44px]"
          >
            <ArrowLeft className="size-4 shrink-0" />
            Back
          </button>

          {/* Brand */}
          <Link href="/" className="text-xl sm:text-2xl font-normal text-vez-ink break-words">
            Suchana<span className="text-vez-navy font-medium">&nbsp;AI</span>
          </Link>

          <div className="min-w-0">
            <h1 className="text-[clamp(32px,8vw,48px)] font-normal leading-[1.15] tracking-[-0.04em] text-vez-ink break-words">
              Welcome back.
            </h1>
            <p className="mt-3 text-sm sm:text-base leading-6 text-vez-mute break-words">
              Sign in to track notices, set alerts, and search documents.
            </p>
          </div>

          {/* Google sign in */}
          <div className="flex flex-col gap-4 sm:gap-6 min-w-0">
            <div className="flex w-full justify-center min-w-0 overflow-hidden" aria-busy={loading}>
              <GoogleLogin
                key={googleWidth}
                onSuccess={(res) => handleGoogleSuccess(res.credential)}
                onError={() => setError("Google sign-in failed. Please try again.")}
                shape="pill"
                size="large"
                text="continue_with"
                width={googleWidth}
              />
            </div>

            {/* Error message */}
            {error && (
              <div className="rounded-[12px] bg-[#fdecec] px-4 py-3 text-sm text-[#b3261e] break-words">
                {error}
              </div>
            )}

            <p className="text-center text-xs sm:text-sm leading-6 text-vez-mute px-2">
              New here? Sign in with Google - your account is created automatically.
            </p>

            <p className="text-center text-[11px] sm:text-xs leading-5 text-vez-mute px-2 break-words">
              By signing in, you agree to our{" "}
              <Link href="/terms" className="underline underline-offset-2 hover:text-vez-ink">
                Terms and Conditions
              </Link>{" "}
              and{" "}
              <Link href="/privacy" className="underline underline-offset-2 hover:text-vez-ink">
                Privacy Policy
              </Link>
              .
            </p>
          </div>
        </div>

        {/* Mobile-only brand statement - mirrors right panel sky content, hidden on lg */}
        <div className="mx-auto mt-8 w-full max-w-md lg:hidden min-w-0">
          <div className="rounded-[20px] bg-vez-sky p-6 sm:p-8 overflow-hidden">
            <p className="max-w-[14ch] text-[28px] sm:text-3xl font-normal leading-[1.12] tracking-[-0.04em] text-vez-ink break-words">
              Every public notice. One place.
            </p>
            <div className="mt-6 max-w-md rounded-[16px] sm:rounded-[24px] bg-white p-6 sm:p-8">
              <blockquote>
                <p className="text-lg sm:text-2xl font-normal leading-[1.35] text-vez-ink break-words">
                  “Transparent governance starts with accessible public notices.”
                </p>
                <footer className="mt-4 sm:mt-6 text-sm sm:text-base text-vez-mute">
                  Suchana AI - Nepal&apos;s AI-powered notice platform
                </footer>
              </blockquote>
            </div>
            <Link
              href="/notices"
              className="mt-6 flex w-fit items-center gap-1.5 rounded-full bg-vez-navy px-5 sm:px-6 py-2.5 sm:py-3 text-sm sm:text-base text-white transition-all duration-300 hover:-translate-y-0.5 hover:opacity-90 min-h-[44px]"
            >
              Browse notices without signing in
              <ArrowUpRight className="size-4 shrink-0" />
            </Link>
          </div>
        </div>
      </div>

      {/* Right panel - sky-blue brand statement - desktop only */}
      <div className="hidden min-h-[100dvh] w-1/2 flex-col justify-between bg-vez-sky p-8 xl:p-14 lg:flex overflow-hidden">
        <p className="max-w-[14ch] text-[clamp(36px,3.8vw,64px)] font-normal leading-[1.12] tracking-[-0.04em] text-vez-ink break-words">
          Every public notice. One place.
        </p>

        <div className="flex flex-col gap-8 min-w-0">
          <div className="max-w-md rounded-[24px] bg-white p-8 xl:p-10">
            <blockquote>
              <p className="text-xl xl:text-2xl font-normal leading-[1.35] text-vez-ink">
                “Transparent governance starts with accessible public notices.”
              </p>
              <footer className="mt-6 text-sm xl:text-base text-vez-mute">
                Suchana AI - Nepal&apos;s AI-powered notice platform
              </footer>
            </blockquote>
          </div>

          <Link
            href="/notices"
            className="flex w-fit items-center gap-1.5 rounded-full bg-vez-navy px-6 py-3 text-base text-white transition-all duration-300 hover:-translate-y-0.5 hover:opacity-90 min-h-[44px]"
          >
            Browse notices without signing in
            <ArrowUpRight className="size-4 shrink-0" />
          </Link>
        </div>
      </div>
    </div>
  )
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  )
}
