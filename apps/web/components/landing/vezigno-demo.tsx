"use client"

import React from "react"
import { NoticesDashboardMockup } from "@/components/notices-dashboard-mockup"
import type { ScrapedItem } from "@/lib/types"
import { Reveal } from "./reveal"
import { AnimatedHeading } from "./animated-heading"
import { Eyebrow } from "./vezigno-ui"

const steps = [
  { number: "01", label: "Aggregate 50+ portals" },
  { number: "02", label: "OCR + AI summaries" },
  { number: "03", label: "Instant alerts" },
  { number: "04", label: "Plain-language answers" },
]

export function VezignoDemo({ notices }: { notices?: ScrapedItem[] }) {
  const stepLabels = notices
    ? [
        { number: "01", label: "Aggregate all official portals" },
        { number: "02", label: "OCR + AI summaries" },
        { number: "03", label: "Instant alerts" },
        { number: "04", label: "Plain-language answers" },
      ]
    : steps
  return (
    <section id="demo" className="bg-vez-navy overflow-hidden">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-10 sm:py-16 md:py-20 lg:py-24">
        <Reveal>
          <Eyebrow dark>The product</Eyebrow>
        </Reveal>
        <AnimatedHeading
          text="One dashboard for every portal."
          className="mt-3 sm:mt-4 max-w-[18ch] text-2xl sm:text-3xl lg:text-4xl xl:text-5xl font-normal leading-[1.12] tracking-[-0.04em] text-white"
        />

        <Reveal delay={150} className="mt-8 sm:mt-12 lg:mt-16">
          <div className="overflow-hidden rounded-xl sm:rounded-[24px] bg-white/90 backdrop-blur-md border border-white/50 shadow-2xl shadow-black/10 w-full">
            <NoticesDashboardMockup notices={notices} />
          </div>
        </Reveal>

        {/* Step legend */}
        <Reveal delay={250}>
          <div className="mt-6 sm:mt-10 grid grid-cols-1 min-[360px]:grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6">
            {stepLabels.map((step) => (
              <div key={step.number} className="border-t border-white/15 min-w-0">
                <div className="vz-sweep group -mx-2 sm:-mx-3 rounded-[12px] sm:rounded-[14px] bg-white/5 backdrop-blur-sm border border-white/10 px-3 pb-3 pt-4 sm:pt-5 min-w-0">
                  <p className="text-xs sm:text-sm text-vez-sky transition-colors duration-300 group-hover:text-vez-navy">{step.number}</p>
                  <p className="mt-1 text-sm sm:text-base text-white/80 transition-colors duration-300 group-hover:text-vez-ink break-words">{step.label}</p>
                </div>
              </div>
            ))}
          </div>
        </Reveal>
      </div>
    </section>
  )
}
