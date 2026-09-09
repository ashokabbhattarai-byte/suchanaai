"use client"

import React from "react"
import Link from "next/link"
import Image from "next/image"
import logo from "@/public/images/logo.png"
import { Github } from "lucide-react"

const footerLinks = {
  Platform: [
    { label: "Browse Notices", href: "/notices" },
    { label: "Document Search", href: "/documents" },
    { label: "Set Up Alerts", href: "/login" },
    { label: "Pricing", href: "/#pricing" },
    { label: "About the Project", href: "/about" },
    { label: "Contact Us", href: "/contact" },
  ],
  Resources: [
    { label: "API Documentation", href: "/about" },
    { label: "Developer Guide", href: "/about" },
    { label: "Open Data Access", href: "/notices" },
    { label: "System Status", href: "/contact" },
  ],
  Legal: [
    { label: "Privacy Policy", href: "/privacy" },
    { label: "Terms of Service", href: "/terms" },
    { label: "Data Retention Policy", href: "/privacy" },
    { label: "Accessibility", href: "/privacy" },
  ],
}

export function VezignoFooter() {
  return (
    <footer className="border-t border-gray-100 bg-white text-vez-ink dark:border-white/10 dark:bg-vez-navy dark:text-white">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-10 sm:py-12 lg:py-14 pb-[calc(2rem+env(safe-area-inset-bottom))] sm:pb-[calc(3rem+env(safe-area-inset-bottom))]">
        <div className="grid grid-cols-1 gap-8 sm:gap-10 lg:gap-12 sm:grid-cols-2 lg:grid-cols-5">
          {/* Brand */}
          <div className="sm:col-span-2 min-w-0 lg:pr-6">
            <Link href="/" className="inline-block rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-vez-navy focus-visible:ring-offset-2 dark:focus-visible:ring-white/50">
              <Image
                src={logo}
                alt="Suchana AI"
                width={200}
                height={200}
                className="h-10 sm:h-12 lg:h-14 w-auto max-w-[140px] sm:max-w-none object-contain dark:brightness-0 dark:invert"
                priority={false}
              />
            </Link>
            <p className="mt-4 max-w-sm text-sm leading-6 text-gray-600 dark:text-white/60 break-words">
              An AI-powered, cloud-based platform aggregating Nepal&apos;s public
              government notices into a single searchable, accessible repository —
              classified and summarized by machine learning.
            </p>
            <div className="mt-5 flex flex-wrap items-center gap-3">
              <a
                href="https://github.com/ashokabhattarai-byte/suchanaai"
                target="_blank"
                rel="noopener noreferrer"
                aria-label="GitHub repository"
                className="flex size-11 min-h-[44px] min-w-[44px] items-center justify-center rounded-full border border-gray-200 bg-gray-50 text-gray-600 transition-colors hover:bg-gray-100 hover:text-vez-navy dark:border-white/10 dark:bg-white/10 dark:text-white/70 dark:hover:bg-white/15 dark:hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-vez-navy/20 dark:focus-visible:ring-white/30"
              >
                <Github className="size-4" />
              </a>
              <span className="rounded-full border border-gray-200 bg-gray-50 px-3.5 py-1.5 text-xs font-medium text-gray-600 dark:border-white/10 dark:bg-white/10 dark:text-white/60">
                v1.0.0-beta
              </span>
            </div>
          </div>

          {/* Link columns - responsive, 44px min touch on mobile via py */}
          {Object.entries(footerLinks).map(([group, links]) => (
            <div key={group} className="min-w-0">
              <h4 className="text-xs font-semibold uppercase tracking-[0.14em] text-gray-900 dark:text-white/40">{group}</h4>
              <ul className="mt-4 flex flex-col gap-1">
                {links.map((link) => (
                  <li key={link.label}>
                    <Link
                      href={link.href}
                      className="inline-flex min-h-[36px] items-center rounded-md px-1 -mx-1 py-1.5 text-sm text-gray-600 transition-colors hover:text-vez-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-vez-navy/20 dark:text-white/70 dark:hover:text-white dark:focus-visible:ring-white/30 sm:min-h-0 sm:py-1"
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-10 flex flex-col gap-4 border-t border-gray-100 pt-6 dark:border-white/10 sm:mt-12 sm:pt-8 lg:flex-row lg:items-center lg:justify-between">
          <p className="text-xs leading-5 text-gray-500 dark:text-white/50 break-words sm:text-sm">
            &copy; 2025 Suchana AI — AI-Powered Public Notice Management System for Nepal.
          </p>
          <p className="text-xs leading-5 text-gray-500 dark:text-white/50 break-words sm:text-sm">
            B.Sc. (Hons) IT Cloud Engineering — Asia Pacific University
          </p>
        </div>
      </div>
    </footer>
  )
}
