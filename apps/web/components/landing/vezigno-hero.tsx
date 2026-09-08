"use client"

import React, { useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { ArrowUpRight, Search } from "lucide-react"
import gsap from "gsap"
import { ScrollTrigger } from "gsap/ScrollTrigger"
import { DemoPlayer } from "./demo/demo-player"
import { Reveal } from "./reveal"
import { Magnetic } from "./motion"

gsap.registerPlugin(ScrollTrigger)

const headlineWords = ["Every", "public", "notice.", "One", "place."]
const fallbackTags = ["Tenders", "PSC Exams", "Vacancies", "Policy Updates", "Gazette"]

const quickTagNames: Record<string, string> = {
  NOTICE: "Notices",
  NEWS: "News",
  PRESS_RELEASE: "Press Releases",
  CIRCULAR: "Circulars",
  TENDER: "Tenders",
  VACANCY: "Vacancies",
  JOB: "Jobs",
  INTERNSHIP: "Internships",
  OTHER: "More",
}

export function VezignoHero({
  sourceCount,
  categories,
}: {
  sourceCount?: number | null
  categories?: Record<string, number> | null
}) {
  const router = useRouter()
  const [query, setQuery] = useState("")
  const sectionRef = useRef<HTMLElement>(null)
  const headlineRef = useRef<HTMLHeadingElement>(null)
  const previewRef = useRef<HTMLDivElement>(null)
  const introRef = useRef<HTMLDivElement>(null)

  // Rank real categories by volume into quick-search chips
  const quickTags =
    categories && Object.keys(categories).length > 0
      ? Object.entries(categories)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([cat]) => quickTagNames[cat] ?? cat)
      : fallbackTags

  // Tickle stats line with the live source count when available
  const sourceCopy =
    sourceCount != null
      ? `Suchana AI aggregates government notices from ${sourceCount} official portals across Nepal - classified, summarized, and made instantly searchable for every citizen.`
      : "Suchana AI aggregates government notices from 50+ official portals across Nepal - classified, summarized, and made instantly searchable for every citizen."

  useEffect(() => {
    const prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    if (prefersReduced) return

    const ctx = gsap.context(() => {
      // Word-by-word headline rise
      const words = headlineRef.current?.querySelectorAll(".vz-word")
      if (words?.length) {
        gsap.fromTo(
          words,
          { yPercent: 110 },
          { yPercent: 0, duration: 0.9, stagger: 0.09, ease: "power4.out", delay: 0.15 }
        )
      }

      // Depth orbs drift at different rates than the page (scrub-linked)
      gsap.to(".vz-orb-a", {
        yPercent: 45,
        xPercent: -10,
        ease: "none",
        scrollTrigger: { trigger: sectionRef.current, start: "top top", end: "bottom top", scrub: 1 },
      })
      gsap.to(".vz-orb-b", {
        yPercent: -35,
        xPercent: 12,
        ease: "none",
        scrollTrigger: { trigger: sectionRef.current, start: "top top", end: "bottom top", scrub: 1.4 },
      })

      // Intro content recedes as you scroll toward the preview card
      if (introRef.current && previewRef.current) {
        gsap.to(introRef.current, {
          yPercent: -8,
          opacity: 0.25,
          ease: "none",
          scrollTrigger: {
            trigger: previewRef.current,
            start: "top 75%",
            end: "top 20%",
            scrub: 0.8,
          },
        })
      }

      // Gentle parallax: mockup drifts with scale and subtle rotation
      if (previewRef.current) {
        gsap.fromTo(
          previewRef.current,
          { y: 32, scale: 1.03, rotateX: 2 },
          {
            y: 0,
            scale: 1,
            rotateX: 0,
            ease: "none",
            scrollTrigger: {
              trigger: previewRef.current,
              start: "top bottom",
              end: "top 30%",
              scrub: 1,
            },
          }
        )
      }
    }, sectionRef)

    return () => ctx.revert()
  }, [])

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault()
    router.push(query.trim() ? `/notices?q=${encodeURIComponent(query.trim())}` : "/notices")
  }

  return (
    <section ref={sectionRef} className="bg-vez-sky vz-noise overflow-hidden">
      <div className="relative mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 pt-[calc(112px+env(safe-area-inset-top))] sm:pt-[calc(9rem+env(safe-area-inset-top))] md:pt-[calc(10rem+env(safe-area-inset-top))] lg:pt-[calc(240px+env(safe-area-inset-top))]">
        {/* Floating depth orbs - CSS float + scroll parallax at differing rates */}
        <div className="vz-orb-a pointer-events-none absolute right-[5%] sm:right-[10%] top-[18%] size-32 sm:size-48 lg:size-72 rounded-full bg-white/15 blur-3xl vz-float-slow" />
        <div className="vz-orb-b pointer-events-none absolute left-[2%] sm:left-[5%] top-[40%] size-24 sm:size-36 lg:size-48 rounded-full bg-vez-navy/5 blur-2xl vz-float" />
        <div ref={introRef}>
        {/* Display statement */}
        <h1
          ref={headlineRef}
          className="max-w-[15ch] text-4xl sm:text-5xl md:text-6xl lg:text-7xl xl:text-[96px] font-normal leading-[1.12] tracking-[-0.04em] text-vez-ink break-words"
        >
          {headlineWords.map((word, i) => (
            <span key={i} className="inline-block overflow-hidden pb-[0.08em] -mb-[0.08em] align-bottom">
              <span className="vz-word inline-block">{word}&nbsp;</span>
            </span>
          ))}
        </h1>

        <Reveal delay={120}>
          <div className="mt-6 sm:mt-8 flex flex-col gap-6 sm:gap-8 lg:mt-12 lg:flex-row lg:items-end lg:justify-between">
            <p className="max-w-xl min-w-0 text-sm sm:text-base leading-6 text-vez-ink md:text-lg md:leading-7">
              {sourceCopy}
            </p>

            <div className="flex flex-wrap items-center gap-3 sm:gap-4 min-w-0">
              <Magnetic>
                <Link
                  href="/notices"
                  className="flex items-center gap-1.5 rounded-full bg-vez-navy px-4 sm:px-6 py-2.5 sm:py-3 text-sm sm:text-base text-white transition-opacity duration-300 hover:opacity-90"
                >
                  Browse notices
                  <ArrowUpRight className="size-4 shrink-0" />
                </Link>
              </Magnetic>
              <Magnetic>
                <Link
                  href="/documents"
                  className="flex items-center gap-1.5 rounded-full bg-white/30 px-4 sm:px-6 py-2.5 sm:py-3 text-sm sm:text-base text-vez-ink backdrop-blur-md border border-white/50 transition-all duration-300 hover:bg-white/60 hover:shadow-md"
                >
                  Explore documents
                </Link>
              </Magnetic>
            </div>
          </div>
        </Reveal>

        {/* Search */}
        <Reveal delay={200}>
          <form onSubmit={handleSearch} className="mt-8 sm:mt-10 max-w-2xl lg:mt-12 min-w-0">
            <div className="vz-glass flex items-center gap-1.5 sm:gap-2 rounded-full p-1.5 sm:p-2 transition-all duration-300 focus-within:scale-[1.01] focus-within:shadow-lg min-w-0">
              <Search className="ml-2 sm:ml-4 size-4 sm:size-5 shrink-0 text-vez-mute" />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search notices, ministries, reference numbers…"
                className="h-10 sm:h-11 w-full min-w-0 bg-transparent text-sm sm:text-base text-vez-ink outline-none placeholder:text-vez-mute placeholder:text-xs sm:placeholder:text-sm"
              />
              <button
                type="submit"
                className="shrink-0 rounded-full bg-vez-navy px-4 sm:px-6 py-2.5 sm:py-3 text-sm sm:text-base text-white transition-opacity hover:opacity-90"
              >
                Search
              </button>
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              {quickTags.map((tag) => (
                <Link
                  key={tag}
                  href={`/notices?q=${encodeURIComponent(tag)}`}
                  className="rounded-full bg-white/30 px-4 py-1.5 text-sm text-vez-ink backdrop-blur-sm border border-white/40 transition-all duration-300 hover:bg-white/60 hover:shadow-sm"
                >
                  {tag}
                </Link>
              ))}
            </div>
          </form>
        </Reveal>

        </div>

        {/* Preview card - rounded top corners, emerges below the fold */}
        <Reveal delay={280} className="mt-10 sm:mt-16 lg:mt-24">
          <div className="overflow-hidden rounded-t-xl sm:rounded-t-[24px] bg-white shadow-2xl shadow-vez-navy/5 w-full" style={{ perspective: "1200px" }}>
            {/* Inner wrapper parallaxes within the clipped card */}
            <div ref={previewRef}>
              <DemoPlayer />
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  )
}
