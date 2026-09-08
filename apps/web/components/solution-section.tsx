"use client"

import React, { useRef, useEffect } from "react"
import { Layers, ScanText, Bell, Wifi } from "lucide-react"


import gsap from "gsap"

const solutions = [
  {
    number: "01",
    icon: Layers,
    problem: "Scattered portals",
    title: "One Feed. Every Source.",
    body: "Suchana AI automatically aggregates notices from all major government portals - Public Service Commission, Ministry of Finance, Judicial Service Commission, and more - into a single, unified, always-updated feed.",
    tag: "Centralized Aggregation",
  },
  {
    number: "02",
    icon: ScanText,
    problem: "Unreadable documents",
    title: "AI Makes Every Document Searchable.",
    body: "OCR pipelines extract text from scanned PDFs and image-embedded notices. NLP models classify and summarize content automatically, so you can search the full text of any official notice in plain language.",
    tag: "OCR + NLP Processing",
  },
  {
    number: "03",
    icon: Bell,
    problem: "No alert system",
    title: "Get Notified Before Others.",
    body: "Set keyword, category, or organization alerts. The moment a relevant notice is published - a new exam date, a tender, a job vacancy - you receive an instant notification. No more manual checking.",
    tag: "Smart Subscriptions",
  },
  {
    number: "04",
    icon: Wifi,
    problem: "Geographic inequality",
    title: "Built for Every Bandwidth.",
    body: "A lightweight, fast web application designed for low-bandwidth environments. AI summaries let users understand a notice without opening a heavy PDF, reducing data burden for citizens in rural Nepal.",
    tag: "Accessible by Design",
  },
]

export function SolutionSection() {
  const sectionRef = useRef<HTMLElement>(null)
  const headingRef = useRef<HTMLDivElement>(null)
  const stepsRef = useRef<(HTMLDivElement | null)[]>([])
  const linesRef = useRef<(HTMLDivElement | null)[]>([])
  const nodesRef = useRef<(HTMLDivElement | null)[]>([])
  const ringsRef = useRef<(HTMLDivElement | null)[]>([])
  const dotsRef = useRef<(HTMLDivElement | null)[]>([])

  useEffect(() => {
    if (!sectionRef.current) return

    const heading = headingRef.current
    const steps = stepsRef.current.filter(Boolean) as HTMLDivElement[]
    const lines = linesRef.current.filter(Boolean) as HTMLDivElement[]
    const nodes = nodesRef.current.filter(Boolean) as HTMLDivElement[]
    const rings = ringsRef.current.filter(Boolean) as HTMLDivElement[]
    const dots = dotsRef.current.filter(Boolean) as HTMLDivElement[]

    const reset = () => {
      gsap.killTweensOf([heading, ...steps, ...nodes, ...lines, ...rings, ...dots])
      gsap.set(heading, { opacity: 0, y: 20 })
      gsap.set(steps, { opacity: 0, x: 20, filter: "blur(6px)" })
      gsap.set(nodes, { scale: 0, opacity: 0 })
      gsap.set(lines, { scaleY: 0, transformOrigin: "top center" })
      gsap.set(rings, { scale: 1, opacity: 0 })
      gsap.set(dots, { opacity: 0, y: 0 })
    }

    const play = () => {
      // Heading snaps in fast
      gsap.to(heading, { opacity: 1, y: 0, duration: 0.3, ease: "power4.out" })

      const tl = gsap.timeline({ delay: 0.1 })

      nodes.forEach((node, i) => {
        const step = steps[i]
        const line = lines[i]
        const ring = rings[i]
        const dot = dots[i]

        // Node pops in with spring
        tl.to(node, { scale: 1, opacity: 1, duration: 0.16, ease: "back.out(4)" })

        // Ripple ring expands outward from node
        if (ring) {
          tl.fromTo(
            ring,
            { scale: 1, opacity: 0.6 },
            { scale: 2.8, opacity: 0, duration: 0.5, ease: "power2.out" },
            "<"
          )
        }

        // Card snaps in from right with blur clear
        tl.to(
          step,
          { opacity: 1, x: 0, filter: "blur(0px)", duration: 0.22, ease: "power4.out" },
          "<0.04"
        )

        // Line fires down + dot races along it
        if (line) {
          tl.to(line, { scaleY: 1, duration: 0.16, ease: "power4.in" }, "+=0.04")
          if (dot) {
            const lineH = line.parentElement?.offsetHeight ?? 80
            tl.fromTo(
              dot,
              { opacity: 1, y: 0 },
              { opacity: 0, y: lineH, duration: 0.16, ease: "power4.in" },
              "<"
            )
          }
        }
      })
    }

    reset()

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            play()
          } else {
            reset()
          }
        })
      },
      { threshold: 0.08 }
    )

    observer.observe(sectionRef.current)
    return () => observer.disconnect()
  }, [])

  return (
    <section ref={sectionRef} className="relative py-8 sm:py-12 md:py-20 lg:py-24 px-4 sm:px-6 md:px-8 lg:px-8 bg-background overflow-hidden">
      {/* Technical grid */}
      <div className="absolute inset-0 pointer-events-none opacity-[0.02]">
        <svg width="100%" height="100%">
          <defs>
            <pattern id="sol-grid" width="40" height="40" patternUnits="userSpaceOnUse">
              <path d="M 40 0 L 0 0 0 40" fill="none" stroke="currentColor" strokeWidth="0.5" strokeDasharray="2 2" />
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#sol-grid)" />
        </svg>
      </div>

      <div className="relative max-w-7xl mx-auto">
        {/* Tactical header */}
        <div ref={headingRef} className="mb-10 sm:mb-14 border-l-2 border-indigo-500 pl-4 sm:pl-5 relative min-w-0">
          <div className="absolute -left-[2px] top-0 w-4 h-px bg-indigo-500" />
          <div className="absolute -left-[2px] bottom-0 w-4 h-px bg-indigo-500" />

          <div className="flex items-center gap-2 mb-4">
            <span className="relative flex size-2">
              <span className="absolute inline-flex size-full rounded-sm bg-indigo-400 opacity-75 animate-ping" />
              <span className="relative inline-flex size-2 rounded-sm bg-indigo-500" />
            </span>
            <span className="text-[11px] font-mono font-semibold uppercase tracking-[0.2em] text-indigo-400">
              [SOLUTION_ARCHITECTURE // SYSTEM_RESPONSE]
            </span>
          </div>

          <h2 className="text-2xl sm:text-3xl md:text-5xl font-bold text-foreground mb-3 sm:mb-5 leading-tight uppercase tracking-tight break-words">
            One platform that fixes{" "}
            <span className="text-indigo-400">all four problems.</span>
          </h2>

          <div className="flex gap-4 items-center mt-6">
            <div className="h-0.5 w-16 bg-indigo-500/30 overflow-hidden relative">
              <div className="absolute inset-0 bg-indigo-500 w-full h-full animate-[scanline_2s_linear_infinite]" />
            </div>
            <p className="text-muted-foreground text-base md:text-lg leading-relaxed max-w-2xl font-normal">
              Suchana AI addresses each failure in Nepal&apos;s public information system with a targeted, AI-powered layer.
            </p>
          </div>
        </div>

        {/* Progress stepper */}
        <div className="relative">
          {solutions.map((s, i) => {
            const Icon = s.icon
            const isLast = i === solutions.length - 1

            return (
              <div key={s.number} className="flex gap-3 sm:gap-5 md:gap-8 min-w-0">
                {/* Timeline column */}
                <div className="flex flex-col items-center shrink-0">
                  {/* Tactical node */}
                  <div
                    ref={(el) => { nodesRef.current[i] = el }}
                    className="relative z-10 size-10 bg-indigo-500/20 border-2 border-indigo-500 flex items-center justify-center shrink-0 shadow-md shadow-indigo-500/30"
                  >
                    <Icon className="size-4 text-indigo-400" />
                    {/* Ripple ring */}
                    <div
                      ref={(el) => { ringsRef.current[i] = el }}
                      className="absolute inset-0 border-2 border-indigo-500 pointer-events-none"
                    />
                  </div>

                  {/* Connector line */}
                  {!isLast && (
                    <div
                      className="relative w-px flex-1 mt-1 mb-1 overflow-hidden"
                      style={{ minHeight: "56px" }}
                    >
                      {/* Base track */}
                      <div className="absolute inset-0 bg-border" />
                      {/* Animated fill */}
                      <div
                        ref={(el) => { linesRef.current[i] = el }}
                        className="absolute inset-0 bg-gradient-to-b from-indigo-500 to-indigo-500/50"
                      />
                      {/* Traveling dot */}
                      <div
                        ref={(el) => { dotsRef.current[i] = el }}
                        className="absolute left-1/2 -translate-x-1/2 size-1.5 bg-indigo-400 top-0 opacity-0"
                      />
                    </div>
                  )}
                </div>

                {/* Tactical card */}
                <div
                  ref={(el) => { stepsRef.current[i] = el }}
                  className={`flex-1 min-w-0 group bg-card backdrop-blur-xl p-4 sm:p-6 md:p-7 hover:bg-card transition-all duration-300 ${!isLast ? "mb-4 sm:mb-6" : ""} relative`}
                >
                  {/* Tactical border */}
                  <div className="absolute inset-0 border border-border pointer-events-none" />
                  <div className="absolute top-0 left-0 w-2 h-2 border-t-2 border-l-2 border-indigo-500" />
                  <div className="absolute top-0 right-0 w-2 h-2 border-t-2 border-r-2 border-indigo-500" />
                  <div className="absolute bottom-0 left-0 w-2 h-2 border-b-2 border-l-2 border-indigo-500" />
                  <div className="absolute bottom-0 right-0 w-2 h-2 border-b-2 border-r-2 border-indigo-500" />

                  {/* Hover scan */}
                  <div className="absolute inset-0 bg-gradient-to-b from-indigo-500/0 via-indigo-500/5 to-indigo-500/0 opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none" />

                  {/* Top row */}
                  <div className="relative flex items-start justify-between mb-4">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[10px] font-mono font-semibold tracking-wider uppercase text-slate-800 bg-slate-100 border border-border px-3 py-1.5">
                        {s.tag}
                      </span>
                      <div className="flex items-center gap-1.5 bg-indigo-500/10 border border-indigo-500/20 px-2.5 py-1">
                        <span className="text-[9px] text-indigo-400 font-mono uppercase tracking-wider">Solves:</span>
                        <span className="text-[9px] font-mono font-semibold text-indigo-400 uppercase">
                          {s.problem}
                        </span>
                      </div>
                    </div>
                    <span className="text-2xl font-black text-foreground/10 leading-none select-none tabular-nums font-mono">
                      {s.number}
                    </span>
                  </div>

                  <h3 className="relative text-lg font-semibold mb-3 leading-snug uppercase tracking-wide text-foreground">{s.title}</h3>
                  <p className="relative text-sm text-muted-foreground leading-relaxed font-normal">{s.body}</p>

                  {/* Bottom accent line */}
                  <div className="h-px mt-5 bg-gradient-to-r from-indigo-500/50 via-transparent to-transparent scale-x-0 origin-left group-hover:scale-x-100 transition-transform duration-500" />
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}
