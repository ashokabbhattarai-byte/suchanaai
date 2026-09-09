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

export function VezignoFooter() {
  return (
    <footer className="overflow-hidden bg-vez-navy">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 pt-10 sm:pt-16 md:pt-20">
        <div className="grid grid-cols-1 gap-8 sm:gap-12 sm:grid-cols-2 lg:grid-cols-5">
          {/* Brand */}
          <div className="sm:col-span-2 min-w-0">
            <Link href="/" className="inline-block">
              <Image
                src={logo}
                alt="Suchana AI"
                width={200}
                height={200}
                className="h-12 sm:h-16 w-auto brightness-0 invert max-w-full"
              />
            </Link>
            <p className="mt-4 sm:mt-5 max-w-xs text-sm sm:text-base leading-6 text-white/60 break-words">
              An AI-powered, cloud-based platform aggregating Nepal&apos;s public
              government notices into a single searchable, accessible repository -
              classified and summarized by machine learning.
            </p>
            <div className="mt-4 sm:mt-6 flex flex-wrap items-center gap-3">
              <a
                href="https://github.com"
                target="_blank"
                rel="noopener noreferrer"
                className="flex size-9 sm:size-10 items-center justify-center rounded-full bg-white/10 text-white/70 transition-all duration-300 hover:scale-110 hover:bg-vez-sky hover:text-vez-navy"
              >
                <Github className="size-4" />
              </a>
              <span className="rounded-full bg-white/10 px-3 sm:px-4 py-1 sm:py-1.5 text-xs sm:text-sm text-white/60">
                v1.0.0-beta
              </span>
            </div>
          </div>

          {/* Link columns */}
          {Object.entries(footerLinks).map(([group, links]) => (
            <div key={group}>
              <h4 className="text-sm uppercase tracking-[0.16em] text-white/40">{group}</h4>
              <ul className="mt-5 flex flex-col gap-3">
                {links.map((link) => (
                  <li key={link.label}>
                    <Link
                      href={link.href}
                      className="vz-link text-base text-white/70 transition-colors hover:text-vez-sky"
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-10 sm:mt-14 flex flex-col items-center justify-between gap-3 border-t border-white/10 pt-6 sm:pt-8 md:flex-row text-center md:text-left">
          <p className="text-xs sm:text-sm text-white/50 break-words">
            &copy; 2025 Suchana AI - AI-Powered Public Notice Management System for Nepal.
          </p>
          <p className="text-xs sm:text-sm text-white/50">
            B.Sc. (Hons) IT Cloud Engineering - Asia Pacific University
          </p>
        </div>

        {/* Watermark wordmark */}
        <p
          aria-hidden="true"
          className="pointer-events-none mt-8 sm:mt-10 select-none whitespace-nowrap text-center text-5xl sm:text-7xl md:text-8xl lg:text-[120px] xl:text-[190px] font-normal leading-[0.78] tracking-[-0.05em] text-white/[0.06] break-words"
        >
          Suchana AI
        </p>
      </div>
    </footer>
  )
}
