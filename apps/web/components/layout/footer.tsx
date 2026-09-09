"use client"

import Link from "next/link"
import Image from "next/image"
import logo from "@/public/images/logo.png"
import { useEffect, useState } from "react"
import { usePathname } from "next/navigation"
import { Github } from "lucide-react"
import { fetchPublicSettings } from "@/lib/api"

const footerLinks = {
  Platform: [
    { label: "Browse Notices", href: "/notices" },
    { label: "Document Search", href: "/documents" },
    { label: "Set Up Alerts", href: "/login" },
    { label: "About the Project", href: "/about" },
  ],
  Resources: [
    { label: "API Documentation", href: "#" },
    { label: "Developer Guide", href: "#" },
    { label: "Open Data Access", href: "#" },
    { label: "System Status", href: "#" },
  ],
  Legal: [
    { label: "Privacy Policy", href: "/privacy" },
    { label: "Terms of Service", href: "/terms" },
    { label: "Data Retention Policy", href: "/privacy" },
    { label: "Accessibility", href: "/privacy" },
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
    <footer className="bg-vez-navy">
      <div className="mx-auto max-w-[1480px] px-6 py-16 md:px-8 md:py-20 lg:px-12">
        <div className="grid grid-cols-1 gap-12 sm:grid-cols-2 lg:grid-cols-5">
          {/* Brand */}
          <div className="sm:col-span-2">
            <Link href="/" className="inline-block">
              <Image
                src={logo}
                alt={site?.title ?? "Suchana AI"}
                width={200}
                height={200}
                className="h-16 w-auto brightness-0 invert"
              />
            </Link>
            <p className="mt-5 max-w-xs text-base leading-6 text-white/60">
              {site?.description ??
                "An AI-powered, cloud-based platform aggregating Nepal's public government notices into a single searchable, accessible repository - classified and summarized by machine learning."}
            </p>
            <div className="mt-6 flex items-center gap-3">
              <a
                href="https://github.com"
                target="_blank"
                rel="noopener noreferrer"
                className="flex size-10 items-center justify-center rounded-full bg-white/10 text-white/70 transition-colors hover:bg-white/20 hover:text-white"
              >
                <Github className="size-4" />
              </a>
              <span className="rounded-full bg-white/10 px-4 py-1.5 text-sm text-white/60">
                v1.0.0-beta
              </span>
            </div>
          </div>

          {/* Link columns */}
          {Object.entries(footerLinks).map(([group, links]) => (
            <div key={group}>
              <h4 className="text-sm text-white/40">{group}</h4>
              <ul className="mt-5 flex flex-col gap-3">
                {links.map((link) => (
                  <li key={link.label}>
                    <Link
                      href={link.href}
                      className="text-base text-white/70 transition-colors hover:text-vez-sky"
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-14 flex flex-col items-center justify-between gap-3 border-t border-white/10 pt-8 md:flex-row">
          <p className="text-sm text-white/50">
            &copy; 2026 {site?.title ?? "Suchana AI"} - AI-Powered Public Notice Management System
            for Nepal.
          </p>
          <p className="text-sm text-white/50">
            B.Sc. (Hons) IT Cloud Engineering - Asia Pacific University
          </p>
        </div>
      </div>
    </footer>
  )
}
