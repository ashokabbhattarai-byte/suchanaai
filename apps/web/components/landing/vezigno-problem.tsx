"use client"

import React from "react"
import { Reveal } from "./reveal"
import { CountUp } from "./count-up"
import { StaggerGrid, TiltCard } from "./motion"
import { AnimatedHeading } from "./animated-heading"
import { Eyebrow } from "./vezigno-ui"

const problems = [
  {
    stat: "50+",
    title: "Scattered portals",
    body: "Nepal's notices are spread across independent ministry and commission websites - each with its own format, schedule, and URL. Citizens must visit all of them manually.",
    wide: true,
  },
  {
    stat: "~70%",
    title: "Scan-only PDFs",
    body: "Most official gazettes arrive as scanned images. Search engines can't index them. Screen readers can't parse them.",
    wide: false,
  },
  {
    stat: "0",
    title: "Alert systems",
    body: "No keyword alerts, no category subscriptions, no notifications anywhere in Nepal's public information ecosystem.",
    wide: false,
  },
  {
    stat: "2×",
    title: "Access burden",
    body: "Urban citizens with broadband check multiple heavy portals easily. Rural citizens bear a disproportionate cost of data and slow load times for the same public information.",
    wide: true,
  },
]

export function VezignoProblem() {
  return (
    <section id="problem" className="bg-vez-surface vz-noise overflow-hidden">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-10 sm:py-16 md:py-20 lg:py-24">
        <Reveal>
          <Eyebrow>The problem</Eyebrow>
        </Reveal>
        <AnimatedHeading
          text="Public information in Nepal is scattered, scanned, and silent."
          className="mt-3 sm:mt-4 max-w-[20ch] text-2xl sm:text-3xl lg:text-4xl xl:text-5xl font-normal leading-[1.12] tracking-[-0.04em] text-vez-ink"
        />

        {/* Asymmetric bento - wide/narrow alternating */}
        <StaggerGrid amount={0.45} className="mt-8 sm:mt-12 grid gap-4 sm:gap-5 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 lg:mt-16">
          {problems.map((p, i) => (
            <TiltCard
              key={p.title}
              max={4}
              className={`${p.wide ? "lg:col-span-2" : ""} min-w-0`}
            >
              <div className="vz-sweep vz-glass group flex h-full flex-col justify-between rounded-xl sm:rounded-[20px] p-4 sm:p-6 md:p-8 lg:p-10 min-w-0">
                <div className="flex items-start justify-between gap-4 sm:gap-6 min-w-0">
                  <p className="text-4xl sm:text-5xl lg:text-6xl xl:text-[80px] font-normal leading-[1.05] tracking-[-0.04em] text-vez-ink break-words">
                    <CountUp value={p.stat} />
                  </p>
                  <span className="mt-1 sm:mt-2 shrink-0 text-xs sm:text-sm text-vez-mute transition-colors duration-300 group-hover:text-vez-ink/60">
                    0{i + 1}
                  </span>
                </div>
                <div className="mt-6 sm:mt-10 min-w-0">
                  <h3 className="text-xl sm:text-2xl font-normal leading-tight sm:leading-[30px] text-vez-ink break-words">
                    {p.title}
                  </h3>
                  <p className="mt-2 sm:mt-3 max-w-[52ch] text-sm sm:text-base leading-6 text-vez-mute transition-colors duration-300 group-hover:text-vez-ink/70">
                    {p.body}
                  </p>
                </div>
              </div>
            </TiltCard>
          ))}
        </StaggerGrid>
      </div>
    </section>
  )
}
