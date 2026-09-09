"use client"

import Link from "next/link"
import Image from "next/image"
import logo from "@/public/images/logo.png"
import { useEffect, useState } from "react"
import { usePathname } from "next/navigation"
import { fetchPublicSettings } from "@/lib/api"

const footerLinks = {
  Platform: [
    { label: "Browse Notices", href: "/notices" },
    { label: "Document Search", href: "/documents" },
    { label: "Pricing", href: "/pricing" },
    { label: "About the Project", href: "/about" },
    { label: "Contact Us", href: "/contact" },
  ],
  Resources: [
    { label: "System Status", href: "/contact" },
    { label: "Help & Support", href: "/contact" },
  ],
  Legal: [
    { label: "Privacy Policy", href: "/privacy" },
    { label: "Terms of Service", href: "/terms" },
  ],
}

export function Footer() {
  const pathname = usePathname()
  const [site, setSite] = useState<{ title: string; description: string } | null>(null)

  useEffect(() => {
    let cancelled = false
    fetchPublicSettings()
      .then((d) => {
        if (!cancelled) setSite(d.site)
      })
      .catch(() => {
        // keep the built-in fallback copy when the API is unreachable
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Documents and Notices are full-height app layouts (h-dvh) — never show
  // the global dark footer there. Prevents footer flash/glitch for a sec
  // on hydration before layout's client guard.
  if (pathname?.startsWith("/documents") || pathname?.startsWith("/notices")) return null

  return (
    <footer className="bg-[#06141b] text-white">
      <div className="mx-auto max-w-[1480px] px-4 py-10 sm:px-6 sm:py-12 md:px-8 md:py-14 lg:px-12 pb-[calc(2rem+env(safe-area-inset-bottom))] sm:pb-[calc(3rem+env(safe-area-inset-bottom))]">
        <div className="grid grid-cols-1 gap-8 sm:gap-10 lg:gap-12 sm:grid-cols-2 lg:grid-cols-4">
          {/* Brand */}
          <div className="sm:col-span-2 min-w-0 lg:pr-8">
            <Link href="/" className="inline-block rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50">
              <Image
                src={logo}
                alt={site?.title ?? "Suchana AI"}
                width={200}
                height={200}
                className="h-11 sm:h-12 w-auto max-w-[140px] sm:max-w-none object-contain brightness-0 invert"
              />
            </Link>
            <p className="mt-4 max-w-md text-sm leading-6 text-white/60 break-words">
              {site?.description ??
                "An AI-powered, cloud-based platform aggregating Nepal's public government notices into a single searchable, accessible repository — classified and summarized by machine learning."}
            </p>
            <div className="mt-5 flex flex-wrap items-center gap-2 text-xs text-white/50">
              <span className="rounded-full bg-white/10 px-3 py-1 border border-white/10">Trusted by public sector</span>
              <span className="rounded-full bg-white/10 px-3 py-1 border border-white/10">AI classified</span>
            </div>
          </div>

          {/* Link columns */}
          {Object.entries(footerLinks).map(([group, links]) => (
            <div key={group} className="min-w-0">
              <h4 className="text-xs font-semibold uppercase tracking-[0.14em] text-white/40">{group}</h4>
              <ul className="mt-4 flex flex-col gap-1">
                {links.map((link) => (
                  <li key={link.label}>
                    <Link
                      href={link.href}
                      className="inline-flex min-h-[36px] items-center rounded-md px-1 -mx-1 py-1.5 text-sm text-white/70 transition-colors hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30 sm:min-h-0 sm:py-1"
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-10 flex flex-col gap-4 border-t border-white/10 pt-6 sm:mt-12 sm:pt-8 lg:flex-row lg:items-center lg:justify-between">
          <p className="text-xs leading-5 text-white/50 break-words sm:text-sm">
            &copy; {new Date().getFullYear()} {site?.title ?? "Suchana AI"} — AI-Powered Public Notice Management System for Nepal.
          </p>
          <p className="text-xs leading-5 text-white/50 break-words sm:text-sm text-left lg:text-right">
            B.Sc. (Hons) IT Cloud Engineering — Asia Pacific University
          </p>
        </div>
      </div>
    </footer>
  )
}
