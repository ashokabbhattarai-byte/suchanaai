"use client"

import React, { useState, useEffect, useRef, useCallback } from "react"
import Link from "next/link"
import type { ScrapedItem } from "@/lib/types"

const fallbackHeadlines = [
  { text: "PSC Section Officer Exam 2082 - Application deadline: Shrawan 15, 2082", id: "n1", title: "Nepal Public Service Commission - Section Officer Exam 2082" },
  { text: "Ministry of Education: 2,500 permanent teacher positions announced across all 7 provinces", id: "n2", title: "Ministry of Education - Teacher Recruitment Drive 2082" },
  { text: "Road Division Office - Highway Construction Tender for Province 5 (45km section)", id: "n3", title: "Road Division Office - Highway Construction Tender" },
  { text: "Nepal Rastra Bank: New monetary policy circular published - effective immediately", id: "n5", title: "Nepal Rastra Bank - Monetary Policy Circular" },
  { text: "Judicial Service Commission - Section Officer written exam results published", id: "n6", title: "Judicial Service Commission - Section Officer Results" },
  { text: "Ministry of Finance: Budget allocation notice for FY 2082/83 released", id: "n7", title: "Ministry of Finance - Budget Allocation Notice" },
]

function generateSlug(title: string, id: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") + "-" + id
}

/** Prefer the AI summary as the headline, falling back to the raw title. */
function headlineFor(notice: ScrapedItem): string {
  return notice.aiSummary ?? notice.title
}

export function NewsTicker({ headlines }: { headlines?: ScrapedItem[] }) {
  const items =
    headlines && headlines.length > 0
      ? headlines
          .map((n) => ({
            text: headlineFor(n),
            id: n.id,
            title: n.title,
          }))
          .slice(0, 6)
      : fallbackHeadlines

  const [current, setCurrent] = useState(0)
  const [animating, setAnimating] = useState(false)
  const [hidden, setHidden] = useState(false)
  const lastScrollY = useRef(0)
  const timerRef = useRef<NodeJS.Timeout | null>(null)

  // Cycle headlines
  useEffect(() => {
    timerRef.current = setInterval(() => {
      setAnimating(true)
      setTimeout(() => {
        setCurrent((prev) => (prev + 1) % items.length)
        setAnimating(false)
      }, 350)
    }, 5000)
    return () => { if (timerRef.current) clearInterval(timerRef.current) }
  }, [items.length])

  // Hide on scroll down, show on scroll up
  const handleScroll = useCallback(() => {
    const y = window.scrollY
    setHidden(y > 120 && y > lastScrollY.current)
    lastScrollY.current = y
  }, [])

  useEffect(() => {
    window.addEventListener("scroll", handleScroll, { passive: true })
    return () => window.removeEventListener("scroll", handleScroll)
  }, [handleScroll])

  return (
    <div
      className={`fixed left-0 right-0 z-40 transition-all duration-300 top-[calc(4rem+env(safe-area-inset-top))] sm:top-[calc(5rem+env(safe-area-inset-top))] ${
        hidden ? "-translate-y-full opacity-0 pointer-events-none" : "translate-y-0 opacity-100"
      }`}
    >
      {/* Container matches header max-w-7xl + px for perfect alignment; ticker sits below header with gap, never overlapping headline */}
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 pt-1 sm:pt-1.5">
        <div className="flex items-center gap-1 sm:gap-2 lg:gap-3 rounded-full bg-white/65 sm:bg-white/40 backdrop-blur-xl border border-white/60 px-2 sm:px-3 lg:px-4 py-1 sm:py-1.5 shadow-[0_2px_12px_rgba(0,0,0,0.06)] min-w-0 max-w-full">
          <span className="flex shrink-0 items-center gap-1 sm:gap-1.5 rounded-full bg-vez-navy/8 px-1.5 sm:px-2 lg:px-2.5 py-0.5 sm:py-1">
            <span className="size-1.5 shrink-0 rounded-full bg-vez-navy animate-pulse" />
            <span className="text-[9px] min-[375px]:text-[10px] sm:text-[11px] font-medium tracking-wider uppercase text-vez-navy/70 leading-none">Live</span>
          </span>
          <span className="hidden sm:block h-3.5 w-px shrink-0 bg-vez-ink/10" />
          <div className="min-w-0 flex-1 overflow-hidden">
            <Link
              href={`/notices/${generateSlug(items[current].title, items[current].id)}`}
              className="block truncate text-[11px] min-[375px]:text-[11px] sm:text-[12px] lg:text-[13px] leading-[1.35] sm:leading-normal text-vez-ink/80 transition-colors hover:text-vez-navy"
              title={items[current].text}
            >
              <span
                className={`inline-block transition-all duration-300 ease-out truncate max-w-full align-middle ${
                  animating
                    ? "opacity-0 -translate-y-1.5 blur-[2px]"
                    : "opacity-100 translate-y-0 blur-0"
                }`}
              >
                {items[current].text}
              </span>
            </Link>
          </div>
          <Link
            href="/notices"
            className="flex shrink-0 items-center justify-center rounded-full bg-vez-navy px-3 sm:px-3 lg:px-3.5 py-1 sm:py-1 text-[10px] min-[375px]:text-[11px] font-medium leading-none text-white sm:bg-vez-navy/8 sm:text-vez-navy/70 transition-colors hover:bg-vez-navy hover:text-white min-h-[28px] sm:min-h-0 min-w-[44px] sm:min-w-0"
          >
            <span className="sm:hidden">View</span>
            <span className="hidden sm:inline whitespace-nowrap">All notices</span>
          </Link>
        </div>
      </div>
    </div>
  )
}
