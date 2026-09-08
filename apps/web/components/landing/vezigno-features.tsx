"use client"

import React from "react"
import { Search, Shield, Zap, BookOpen } from "lucide-react"
import { Reveal } from "./reveal"
import { AnimatedHeading } from "./animated-heading"
import { Eyebrow, SwapArrow } from "./vezigno-ui"
import { PopIcon, StaggerGrid, TiltCard } from "./motion"

const features = [
  {
    icon: Search,
    title: "Unified search",
    body: "Query every government notice - vacancies, tenders, exam dates, policy updates - from a single interface with natural language support.",
  },
  {
    icon: Shield,
    title: "Verified sources only",
    body: "All notices are sourced directly from official government portals via Scrapy and Selenium pipelines. No third-party aggregators.",
  },
  {
    icon: Zap,
    title: "Instant smart alerts",
    body: "Subscribe to keywords, categories, or specific ministries. Receive notifications the moment a matching notice is published.",
  },
  {
    icon: BookOpen,
    title: "RAG document intelligence",
    body: "Ask questions in plain language against indexed government documents. Powered by LangChain, ChromaDB, and HuggingFace NLP models.",
  },
]

export function VezignoFeatures() {
  return (
    <section id="features" className="bg-vez-surface vz-noise overflow-hidden">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-10 sm:py-16 md:py-20 lg:py-24">
        <div className="flex flex-col gap-4 sm:gap-6 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0">
            <Reveal>
              <Eyebrow>Features</Eyebrow>
            </Reveal>
            <AnimatedHeading
              text="Everything a citizen needs, in one calm interface."
              className="mt-3 sm:mt-4 max-w-[20ch] text-2xl sm:text-3xl lg:text-4xl xl:text-5xl font-normal leading-[1.12] tracking-[-0.04em] text-vez-ink"
            />
          </div>
          <Reveal delay={200} className="min-w-0">
            <p className="max-w-sm text-sm sm:text-base leading-6 text-vez-mute">
              Four capabilities, one pipeline - from scraping the source portal to
              answering your question in plain language.
            </p>
          </Reveal>
        </div>

        <StaggerGrid amount={0.55} className="mt-8 sm:mt-12 grid gap-4 sm:gap-5 grid-cols-1 sm:grid-cols-2 lg:mt-16 lg:grid-cols-4">
          {features.map((f, i) => {
            const Icon = f.icon
            return (
              <TiltCard key={f.title} className="min-w-0">
                <div className="vz-sweep vz-glass group flex h-full min-w-0 flex-col rounded-xl sm:rounded-[20px] p-4 sm:p-6 lg:p-8">
                  <div className="flex items-center justify-between gap-3">
                    <PopIcon delay={i * 120 + 250} className="flex size-10 sm:size-12 items-center justify-center rounded-full bg-vez-sky/40 transition-colors duration-300 group-hover:bg-white shrink-0">
                      <Icon className="size-4 sm:size-5 text-vez-navy" />
                    </PopIcon>
                    <span className="text-xs sm:text-sm text-vez-mute transition-colors duration-300 group-hover:text-vez-ink/60 shrink-0">
                      0{i + 1}
                    </span>
                  </div>
                  <h3 className="mt-4 sm:mt-6 text-xl sm:text-2xl font-normal leading-tight sm:leading-[30px] text-vez-ink break-words">
                    {f.title}
                  </h3>
                  <p className="mt-2 sm:mt-3 flex-1 text-sm sm:text-base leading-6 text-vez-mute transition-colors duration-300 group-hover:text-vez-ink/70">
                    {f.body}
                  </p>
                  <div className="mt-6 sm:mt-8 flex items-center justify-between border-t border-vez-line pt-4 sm:pt-5 transition-colors duration-300 group-hover:border-vez-ink/10">
                    <span className="text-xs sm:text-sm text-vez-mute transition-colors duration-300 group-hover:text-vez-ink">
                      Learn more
                    </span>
                    <SwapArrow className="text-vez-mute transition-colors duration-300 group-hover:text-vez-navy" />
                  </div>
                </div>
              </TiltCard>
            )
          })}
        </StaggerGrid>
      </div>
    </section>
  )
}
