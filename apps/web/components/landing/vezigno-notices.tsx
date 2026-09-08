"use client"

import React from "react"
import Link from "next/link"
import { mockNotices } from "@/lib/mock-data"
import type { ScrapedItem } from "@/lib/types"
import { Reveal } from "./reveal"
import { CountUp } from "./count-up"
import { AnimatedHeading } from "./animated-heading"
import { Eyebrow, ArrowCta } from "./vezigno-ui"
import { Magnetic, StaggerGrid, TiltCard } from "./motion"

const fallbackStats = [
  { value: "50+", label: "Government sources" },
  { value: "10K+", label: "Daily queries" },
  { value: "24/7", label: "Automated monitoring" },
  { value: "2", label: "Languages supported" },
]

function generateSlug(title: string, id: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") + "-" + id
}

const categoryLabels: Record<string, string> = {
  NOTICE: "Notice",
  NEWS: "News",
  PRESS_RELEASE: "Press Release",
  CIRCULAR: "Circular",
  TENDER: "Tender",
  VACANCY: "Vacancy",
  JOB: "Job",
  INTERNSHIP: "Internship",
  OTHER: "Other",
}

function formatDate(iso: string | null) {
  if (!iso) return ""
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  })
}

export function VezignoNotices({
  latest,
  totalNotices,
  sourceCount,
  categoryCounts,
}: {
  latest?: ScrapedItem[]
  totalNotices?: number | null
  sourceCount?: number | null
  categoryCounts?: Record<string, number> | null
}) {
  // Real feed first; static showcase cards as the no-API fallback
  const featured: ScrapedItem[] =
    latest && latest.length > 0 ? latest.slice(0, 3) : (mockNotices.slice(0, 3) as unknown as ScrapedItem[])

  const stats = [
    { value: `${sourceCount ?? 50}+`, label: "Government sources" },
    { value: `${totalNotices ?? "10K+"}`, label: "Notices indexed" },
    { value: "24/7", label: "Automated monitoring" },
    { value: `${categoryCounts ? Object.keys(categoryCounts).length : 2}`, label: "Categories tracked" },
  ]

  return (
    <section className="bg-white overflow-hidden">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-10 sm:py-16 md:py-20 lg:py-24">
        {/* Stats strip */}
        <Reveal>
          <StaggerGrid amount={0.4} className="grid grid-cols-2 gap-4 sm:gap-6 gap-y-8 sm:gap-y-10 border-b border-vez-line pb-10 sm:pb-16 md:pb-20 lg:grid-cols-4">
            {stats.map((stat, i) => (
              <div
                key={stat.label}
                className={i > 0 ? "lg:border-l lg:border-vez-line lg:pl-6 xl:pl-10 min-w-0" : "min-w-0"}
              >
                <p className="text-3xl sm:text-4xl lg:text-5xl xl:text-[64px] font-normal leading-[1.1] tracking-[-0.04em] text-vez-ink break-words">
                  <CountUp value={stat.value} />
                </p>
                <p className="mt-1.5 sm:mt-2 text-sm sm:text-base text-vez-mute">{stat.label}</p>
              </div>
            ))}
          </StaggerGrid>
        </Reveal>

        {/* Featured notices */}
        <div className="mt-10 sm:mt-16 md:mt-20">
          <div className="flex flex-col gap-4 sm:gap-6 md:flex-row md:items-end md:justify-between">
            <div className="min-w-0">
              <Reveal>
                <Eyebrow>Live feed</Eyebrow>
              </Reveal>
              <AnimatedHeading
                text="Latest from the portals."
                className="mt-3 sm:mt-4 max-w-[18ch] text-2xl sm:text-3xl lg:text-4xl xl:text-5xl font-normal leading-[1.12] tracking-[-0.04em] text-vez-ink"
              />
            </div>
            <Reveal delay={250} className="shrink-0">
              <Magnetic>
                <ArrowCta href="/notices">View all notices</ArrowCta>
              </Magnetic>
            </Reveal>
          </div>

          <StaggerGrid className="mt-8 sm:mt-10 grid gap-4 sm:gap-6 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 lg:mt-12">
            {featured.map((notice) => (
              <TiltCard key={notice.id} className="min-w-0">
                <Link
                  href={`/notices/${generateSlug(notice.title, notice.id)}`}
                  className="vz-sweep vz-glass group flex h-full min-w-0 flex-col rounded-xl sm:rounded-[20px] p-4 sm:p-6 lg:p-8"
                >
                  <div className="flex items-center justify-between gap-3 min-w-0">
                    <span className="rounded-full bg-white/50 px-3 sm:px-4 py-1 sm:py-1.5 text-xs sm:text-sm text-vez-ink backdrop-blur-sm border border-white/50 truncate">
                      {categoryLabels[notice.category] ?? notice.category}
                    </span>
                  </div>

                  <h3 className="mt-4 sm:mt-6 text-xl sm:text-2xl font-normal leading-tight sm:leading-[30px] text-vez-ink line-clamp-3 break-words">
                    {notice.title}
                  </h3>
                  <p className="mt-2 sm:mt-3 line-clamp-3 flex-1 text-sm sm:text-base leading-6 text-vez-mute transition-colors duration-300 group-hover:text-vez-ink/70">
                    {notice.aiSummary ?? notice.summary}
                  </p>

                  <div className="mt-4 sm:mt-6 flex items-center justify-between gap-2 border-t border-vez-line pt-4 sm:pt-5 text-xs sm:text-sm text-vez-mute transition-colors duration-300 group-hover:border-vez-ink/10 group-hover:text-vez-ink/70 min-w-0">
                    <span className="line-clamp-1 min-w-0 truncate">{notice.sourceLabel}</span>
                    <span className="shrink-0 text-xs">
                      {formatDate(notice.publishedAt) || formatDate(notice.scrapedAt)}
                    </span>
                  </div>
                </Link>
              </TiltCard>
            ))}
          </StaggerGrid>
        </div>
      </div>
    </section>
  )
}
