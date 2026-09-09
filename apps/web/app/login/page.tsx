"use client"

import React, { useState, Suspense } from "react"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { GoogleLogin } from "@react-oauth/google"
import { ArrowLeft, ArrowUpRight } from "lucide-react"
import { useAuth } from "@/lib/auth-context"

function LoginForm() {
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)
  const { loginWithGoogle } = useAuth()
  const router = useRouter()
  const searchParams = useSearchParams()
  const redirect = searchParams.get("redirect")

  const safeRedirect = (() => {
    if (!redirect || !redirect.startsWith("/") || redirect.startsWith("//")) return null
    return redirect
  })()

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
    <div className="flex min-h-screen w-full bg-white font-poppins antialiased">
      {/* Left panel - sign-in */}
      <div className="flex min-h-screen w-full flex-col justify-center px-8 py-12 sm:px-12 lg:w-1/2 lg:px-16">
        <div className="mx-auto flex w-full max-w-md flex-col gap-10">
          {/* Back */}
          <button
            onClick={() => router.back()}
            className="flex w-fit items-center gap-2 text-base text-vez-mute transition-colors hover:text-vez-ink"
          >
            <ArrowLeft className="size-4" />
            Back
          </button>

          {/* Brand */}
          <Link href="/" className="text-2xl font-normal text-vez-ink">
            Suchana<span className="text-vez-navy font-medium">&nbsp;AI</span>
          </Link>

          <div>
            <h1 className="text-[clamp(36px,4vw,48px)] font-normal leading-[1.15] tracking-[-0.04em] text-vez-ink">
              Welcome back.
            </h1>
            <p className="mt-3 text-base leading-6 text-vez-mute">
              Sign in to track notices, set alerts, and search documents.
            </p>
          </div>

          {/* Google sign in */}
          <div className="flex flex-col gap-6">
            <div className="flex w-full justify-center" aria-busy={loading}>
              <GoogleLogin
                onSuccess={(res) => handleGoogleSuccess(res.credential)}
                onError={() => setError("Google sign-in failed. Please try again.")}
                shape="pill"
                size="large"
                text="continue_with"
                width="384"
              />
            </div>

            {/* Error message */}
            {error && (
              <div className="rounded-[12px] bg-[#fdecec] px-4 py-3 text-sm text-[#b3261e]">
                {error}
              </div>
            )}

            <p className="text-center text-sm leading-6 text-vez-mute">
              New here? Sign in with Google - your account is created automatically.
            </p>

            <p className="text-center text-xs text-vez-mute">
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
      </div>

      {/* Right panel - sky-blue brand statement */}
      <div className="hidden min-h-screen w-1/2 flex-col justify-between bg-vez-sky p-14 lg:flex">
        <p className="max-w-[14ch] text-[clamp(40px,3.8vw,64px)] font-normal leading-[1.12] tracking-[-0.04em] text-vez-ink">
          Every public notice. One place.
        </p>

        <div className="flex flex-col gap-8">
          <div className="max-w-md rounded-[24px] bg-white p-10">
            <blockquote>
              <p className="text-2xl font-normal leading-[1.35] text-vez-ink">
                “Transparent governance starts with accessible public notices.”
              </p>
              <footer className="mt-6 text-base text-vez-mute">
                Suchana AI - Nepal&apos;s AI-powered notice platform
              </footer>
            </blockquote>
          </div>

          <Link
            href="/notices"
            className="flex w-fit items-center gap-1.5 rounded-full bg-vez-navy px-6 py-3 text-base text-white transition-all duration-300 hover:-translate-y-0.5 hover:opacity-90"
          >
            Browse notices without signing in
            <ArrowUpRight className="size-4" />
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
