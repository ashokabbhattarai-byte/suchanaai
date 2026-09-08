"use client"

import React from "react"
import { Reveal } from "./reveal"
import { CountUp } from "./count-up"
import { AnimatedHeading } from "./animated-heading"
import { Eyebrow } from "./vezigno-ui"

const values = [
  {
    title: "Mission-driven",
    body: "Democratizing access to public information across Nepal through AI-powered technology.",
  },
  {
    title: "Transparency first",
    body: "Building trust through verified sources and open data practices.",
  },
  {
    title: "Citizen-centric",
    body: "Every feature designed with the needs of Nepali citizens at its core.",
  },
  {
    title: "Innovation",
    body: "Leveraging cutting-edge AI to solve real-world governance challenges.",
  },
]

const stats = [
  { value: "2024", label: "Founded" },
  { value: "50+", label: "Gov sources" },
  { value: "10K+", label: "Daily queries" },
  { value: "99.9%", label: "Uptime" },
]

export function VezignoAbout() {
  return (
    <section id="about" className="bg-white overflow-hidden">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-10 sm:py-16 md:py-20 lg:py-24">
        <div className="grid gap-8 sm:gap-12 lg:grid-cols-2 lg:gap-20">
          <div className="min-w-0">
            <Reveal>
              <Eyebrow>About us</Eyebrow>
            </Reveal>
            <AnimatedHeading
              text="Building the future of public information."
              className="mt-3 sm:mt-4 max-w-[16ch] text-2xl sm:text-3xl lg:text-4xl xl:text-5xl font-normal leading-[1.12] tracking-[-0.04em] text-vez-ink"
            />
            <Reveal delay={150}>
            <p className="mt-6 sm:mt-8 text-sm sm:text-base leading-6 text-vez-mute md:text-lg md:leading-7">
              Suchana AI is a mission-driven technology platform addressing Nepal&apos;s
              fragmented public information ecosystem. We aggregate official government
              notices from 50+ portals, process them with AI, and make every document
              instantly searchable in plain language.
            </p>
            <p className="mt-3 sm:mt-4 text-sm sm:text-base leading-6 text-vez-mute md:text-lg md:leading-7">
              From job vacancies and exam schedules to tenders and policy updates - we
              ensure no citizen misses critical information that impacts their life,
              education, or livelihood.
            </p>
            </Reveal>
          </div>

          <div className="flex flex-col justify-end min-w-0">
            {values.map((v, i) => (
              <Reveal key={v.title} delay={i * 80}>
                <div className="border-t border-vez-line">
                  <div className="vz-sweep group -mx-3 sm:-mx-5 rounded-[12px] sm:rounded-[16px] px-3 sm:px-5 py-4 sm:py-6 min-w-0">
                    <div className="flex items-baseline gap-3 sm:gap-4 min-w-0">
                      <span className="size-2 sm:size-2.5 shrink-0 translate-y-[-2px] rounded-full bg-vez-sky transition-colors duration-300 group-hover:bg-vez-navy" />
                      <div className="min-w-0">
                        <h3 className="text-xl sm:text-2xl font-normal leading-tight sm:leading-[30px] text-vez-ink break-words">
                          {v.title}
                        </h3>
                        <p className="mt-1.5 sm:mt-2 text-sm sm:text-base leading-6 text-vez-mute transition-colors duration-300 group-hover:text-vez-ink/70">{v.body}</p>
                      </div>
                    </div>
                  </div>
                </div>
              </Reveal>
            ))}
          </div>
        </div>

        {/* Stats band */}
        <Reveal className="mt-10 sm:mt-16 lg:mt-20">
          <div className="grid grid-cols-2 gap-4 sm:gap-y-10 rounded-xl sm:rounded-[24px] bg-vez-sky/40 p-4 sm:p-8 md:p-10 lg:p-12 backdrop-blur-md border border-white/40 lg:grid-cols-4 gap-y-6 sm:gap-y-10">
            {stats.map((stat) => (
              <div key={stat.label} className="min-w-0 text-center sm:text-left">
                <p className="text-3xl sm:text-4xl lg:text-5xl xl:text-[64px] font-normal leading-[1.1] tracking-[-0.04em] text-vez-navy break-words">
                  <CountUp value={stat.value} />
                </p>
                <p className="mt-1 sm:mt-2 text-sm sm:text-base text-vez-ink">{stat.label}</p>
              </div>
            ))}
          </div>
        </Reveal>
      </div>
    </section>
  )
}
