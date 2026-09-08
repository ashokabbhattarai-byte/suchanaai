"use client"

import React from "react"
import { Reveal } from "./reveal"
import { AnimatedHeading } from "./animated-heading"
import { Eyebrow } from "./vezigno-ui"

const solutions = [
  {
    number: "01",
    tag: "Centralized aggregation",
    solves: "Scattered portals",
    title: "One feed. Every source.",
    body: "Suchana AI automatically aggregates notices from all major government portals - Public Service Commission, Ministry of Finance, Judicial Service Commission, and more - into a single, unified, always-updated feed.",
  },
  {
    number: "02",
    tag: "OCR + NLP processing",
    solves: "Unreadable documents",
    title: "AI makes every document searchable.",
    body: "OCR pipelines extract text from scanned PDFs and image-embedded notices. NLP models classify and summarize content automatically, so you can search the full text of any official notice in plain language.",
  },
  {
    number: "03",
    tag: "Smart subscriptions",
    solves: "No alert system",
    title: "Get notified before others.",
    body: "Set keyword, category, or organization alerts. The moment a relevant notice is published - a new exam date, a tender, a job vacancy - you receive an instant notification. No more manual checking.",
  },
  {
    number: "04",
    tag: "Accessible by design",
    solves: "Geographic inequality",
    title: "Built for every bandwidth.",
    body: "A lightweight, fast web application designed for low-bandwidth environments. AI summaries let users understand a notice without opening a heavy PDF, reducing data burden for citizens in rural Nepal.",
  },
]

export function VezignoSolution() {
  return (
    <section id="solution" className="bg-white overflow-hidden">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-10 sm:py-16 md:py-20 lg:py-24">
        <Reveal>
          <Eyebrow>The solution</Eyebrow>
        </Reveal>
        <AnimatedHeading
          text="One platform that answers all four problems."
          className="mt-3 sm:mt-4 max-w-[20ch] text-2xl sm:text-3xl lg:text-4xl xl:text-5xl font-normal leading-[1.12] tracking-[-0.04em] text-vez-ink"
        />

        <div className="mt-8 sm:mt-12 lg:mt-16">
          {solutions.map((s, i) => (
            <Reveal key={s.number} delay={i * 80}>
              <div className="border-t border-vez-line">
                <div className="vz-sweep group -mx-4 sm:-mx-6 grid gap-4 sm:gap-6 rounded-xl sm:rounded-[20px] px-4 sm:px-6 py-6 sm:py-10 md:py-12 lg:-mx-10 lg:grid-cols-[80px_1fr_1.2fr] lg:gap-8 xl:gap-12 lg:px-10 min-w-0">
                  <p className="text-xl sm:text-2xl font-normal leading-[30px] text-vez-mute transition-colors duration-300 group-hover:text-vez-navy">
                    {s.number}
                  </p>

                  <div className="min-w-0">
                    <h3 className="text-xl sm:text-2xl lg:text-3xl xl:text-[36px] font-normal leading-[1.33] text-vez-ink break-words">
                      {s.title}
                    </h3>
                    <div className="mt-3 sm:mt-4 flex flex-wrap gap-2">
                      <span className="rounded-full bg-vez-sky/30 px-3 sm:px-4 py-1 sm:py-1.5 text-xs sm:text-sm text-vez-ink backdrop-blur-sm border border-white/40 transition-all duration-300 group-hover:bg-white/60">
                        {s.tag}
                      </span>
                      <span className="rounded-full bg-white/30 px-3 sm:px-4 py-1 sm:py-1.5 text-xs sm:text-sm text-vez-mute backdrop-blur-sm border border-white/30 transition-all duration-300 group-hover:bg-white/60 group-hover:text-vez-ink/70">
                        Solves: {s.solves}
                      </span>
                    </div>
                  </div>

                  <p className="text-sm sm:text-base leading-6 text-vez-mute transition-colors duration-300 group-hover:text-vez-ink/75 md:text-lg md:leading-7 min-w-0 break-words">
                    {s.body}
                  </p>
                </div>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  )
}
