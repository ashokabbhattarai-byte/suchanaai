"use client"

import React, { useRef, useEffect } from "react"
import gsap from "gsap"
import { ScrollTrigger } from "gsap/ScrollTrigger"
import { Reveal } from "./reveal"
import { AnimatedHeading } from "./animated-heading"
import { Eyebrow } from "./vezigno-ui"

gsap.registerPlugin(ScrollTrigger)

interface Testimonial {
  quote: string
  name: string
  role: string
}

const rowOne: Testimonial[] = [
  {
    quote:
      "I got my PSC exam date the day it was published. Before Suchana AI, I used to check four different websites every morning.",
    name: "Anita Gurung",
    role: "Section Officer aspirant, Pokhara",
  },
  {
    quote:
      "The keyword alerts alone are worth it. Our firm never misses a road construction tender from any division office now.",
    name: "Rajesh Shrestha",
    role: "Civil contractor, Butwal",
  },
  {
    quote:
      "Scanned gazettes used to be unreadable on my phone. The AI summaries let me understand a notice in ten seconds.",
    name: "Sunita Tharu",
    role: "Teacher, Dang",
  },
  {
    quote:
      "Finally, one calm place for every ministry's announcements. The Nepali language support makes it usable for my parents too.",
    name: "Bibek Adhikari",
    role: "Software engineer, Kathmandu",
  },
  {
    quote:
      "The deadline reminders have saved my firm three times already. We never miss a procurement notice anymore.",
    name: "Priya Maharjan",
    role: "Procurement officer, Lalitpur",
  },
]

const rowTwo: Testimonial[] = [
  {
    quote:
      "We use the RAG search to answer policy questions against the actual gazette text. It cites the source document every time.",
    name: "Prof. Kamala Joshi",
    role: "Public policy researcher, TU",
  },
  {
    quote:
      "Living abroad, I still need Lok Sewa updates for my family. One bookmark, one feed, zero missed deadlines.",
    name: "Dipesh Karki",
    role: "Nepali diaspora, Sydney",
  },
  {
    quote:
      "The site loads fast even on our village connection. Summaries mean I don't have to download heavy PDFs anymore.",
    name: "Maya Bishwokarma",
    role: "Community worker, Jumla",
  },
  {
    quote:
      "As a journalist, the organization filters save me hours. Every Nepal Rastra Bank circular lands in my alerts instantly.",
    name: "Sagar Lamichhane",
    role: "Economic journalist, Lalitpur",
  },
  {
    quote:
      "Our legal team uses the gazette search daily. Finding the exact regulation paragraph used to take a whole afternoon.",
    name: "Sambriddha Rai",
    role: "Legal researcher, Biratnagar",
  },
]

function initials(name: string) {
  return name
    .split(" ")
    .map((part) => part[0])
    .slice(0, 2)
    .join("")
}

function TestimonialCard({ t }: { t: Testimonial }) {
  return (
    <figure className="vz-sweep vz-glass group flex w-[280px] sm:w-[340px] shrink-0 flex-col justify-between rounded-xl sm:rounded-[20px] p-4 sm:p-6 md:p-8 md:w-[420px] min-w-0">
      <blockquote className="text-sm sm:text-base leading-[1.6] text-vez-ink break-words">&quot;{t.quote}&quot;</blockquote>
      <figcaption className="mt-4 sm:mt-6 flex items-center gap-3 sm:gap-4 min-w-0">
        <span className="flex size-9 sm:size-11 shrink-0 items-center justify-center rounded-full bg-vez-sky text-xs sm:text-sm font-medium text-vez-navy transition-colors duration-300 group-hover:bg-white">
          {initials(t.name)}
        </span>
        <span className="min-w-0">
          <span className="block text-sm sm:text-base text-vez-ink truncate">{t.name}</span>
          <span className="block text-xs sm:text-sm text-vez-mute transition-colors duration-300 group-hover:text-vez-ink/70 truncate">{t.role}</span>
        </span>
      </figcaption>
    </figure>
  )
}

function MarqueeRow({ items, duration = 40 }: { items: Testimonial[]; duration?: number }) {
  const trackRef = useRef<HTMLDivElement>(null)
  const tweenRef = useRef<gsap.core.Tween | null>(null)
  // Duplicate so xPercent:-50 loops seamlessly back to identical starting position
  const doubled = [...items, ...items]

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return
    const track = trackRef.current
    if (!track) return

    tweenRef.current = gsap.to(track, {
      xPercent: -50,
      duration,
      ease: "none",
      repeat: -1,
    })

    // Marquee reacts to scroll: speeds up with scroll velocity, then eases
    // back to normal speed once scrolling settles.
    let settle: gsap.core.Tween | null = null
    const st = ScrollTrigger.create({
      trigger: track,
      start: "top bottom",
      end: "bottom top",
      onUpdate: (self) => {
        const tween = tweenRef.current
        if (!tween || tween.paused()) return
        const boost = gsap.utils.clamp(1, 3.5, 1 + Math.abs(self.getVelocity()) / 900)
        tween.timeScale(boost)
        settle?.kill()
        settle = gsap.to(tween, { timeScale: 1, duration: 1.2, ease: "power2.out" })
      },
    })

    return () => {
      settle?.kill()
      st.kill()
      tweenRef.current?.kill()
    }
  }, [duration])

  return (
    <div
      className="vz-marquee-mask overflow-hidden"
      onMouseEnter={() => tweenRef.current?.pause()}
      onMouseLeave={() => tweenRef.current?.resume()}
    >
      <div ref={trackRef} className="flex w-max gap-5 pr-5">
        {doubled.map((t, i) => (
          <TestimonialCard key={`${t.name}-${i}`} t={t} />
        ))}
      </div>
    </div>
  )
}

export function VezignoFeedback() {
  return (
    <section id="feedback" className="overflow-hidden bg-vez-surface">
      <div className="py-10 sm:py-16 md:py-20 lg:py-24">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <Reveal>
            <Eyebrow>Feedback</Eyebrow>
          </Reveal>
          <AnimatedHeading
            text="Trusted by citizens across Nepal."
            className="mt-3 sm:mt-4 max-w-[16ch] text-2xl sm:text-3xl lg:text-4xl xl:text-5xl font-normal leading-[1.12] tracking-[-0.04em] text-vez-ink"
          />
        </div>

        <div className="mt-8 sm:mt-12 flex flex-col gap-4 sm:gap-5 lg:mt-16">
          <MarqueeRow items={rowOne} duration={38} />
          <MarqueeRow items={rowTwo} duration={52} />
        </div>
      </div>
    </section>
  )
}
