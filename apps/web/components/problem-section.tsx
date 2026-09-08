"use client"

import React, { useRef, useEffect } from "react"
import { Globe, FileX, BellOff, MapPin } from "lucide-react"
import gsap from "gsap"

const problems = [
  {
    icon: Globe,
    title: "System Fragmentation",
    stat: "50+",
    statLabel: "NODES_DISCONNECTED",
    refCode: "INFRA_01",
    body: "Nepal's notices are spread across independent ministry and commission websites - each with its own format, schedule, and URL. Citizens must visit all of them manually.",
    severity: "critical",
  },
  {
    icon: FileX,
    title: "Unstructured Mass",
    stat: "~70%",
    statLabel: "SCAN_ONLY_PDFS",
    refCode: "DATA_ERR_70",
    body: "Most official gazettes arrive as scanned images. Search engines can't index them. Screen readers can't parse them. Every file must be opened and read by hand.",
    severity: "high",
  },
  {
    icon: BellOff,
    title: "No Alerts. No Discovery.",
    stat: "0",
    statLabel: "SYS_ALERTS",
    refCode: "NOTIF_00",
    body: "There is no keyword alert, no category subscription, and no notification in Nepal's public information ecosystem. Repetitive manual checking is the only option.",
    severity: "critical",
  },
  {
    icon: MapPin,
    title: "Information Inequality",
    stat: "2×",
    statLabel: "OP_BURDEN",
    refCode: "ACCESS_2X",
    body: "Urban citizens with broadband check multiple heavy portals easily. Rural citizens bear a disproportionate cost of data and slow load times for the same public information.",
    severity: "high",
  },
]

export function ProblemSection() {
  const sectionRef = useRef<HTMLElement>(null)
  const headingRef = useRef<HTMLDivElement>(null)
  const cardsRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!sectionRef.current || !cardsRef.current) return

    const heading = headingRef.current
    const cards = cardsRef.current?.querySelectorAll(".problem-card")
    const icons = cardsRef.current?.querySelectorAll(".problem-icon")
    const lines = cardsRef.current?.querySelectorAll(".animated-line")

    const reset = () => {
      gsap.killTweensOf([heading?.children, cards, icons, lines])
      if (heading) {
        gsap.set(heading.children, { opacity: 0, y: 30, filter: "blur(8px)" })
      }
      gsap.set(cards ?? [], { opacity: 0, y: 60, rotateX: 15, scale: 0.9 })
      gsap.set(icons ?? [], { scale: 0, rotation: -180 })
      gsap.set(lines ?? [], { scaleX: 0 })
    }

    const play = () => {
      // Heading animation
      if (heading) {
        gsap.to(heading.children, {
          opacity: 1,
          y: 0,
          filter: "blur(0px)",
          duration: 0.4,
          stagger: 0.08,
          ease: "power3.out",
        })
      }

      // Cards animation
      gsap.to(cards ?? [], {
        opacity: 1,
        y: 0,
        rotateX: 0,
        scale: 1,
        duration: 0.5,
        stagger: 0.06,
        ease: "back.out(1.2)",
      })

      // Icons
      gsap.to(icons ?? [], {
        scale: 1,
        rotation: 0,
        duration: 0.4,
        stagger: 0.12,
        delay: 0.15,
        ease: "back.out(2)",
      })

      // Lines
      gsap.to(lines ?? [], {
        scaleX: 1,
        duration: 0.4,
        stagger: 0.12,
        delay: 0.25,
        ease: "power2.out",
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
      { threshold: 0.15 }
    )

    observer.observe(sectionRef.current!)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!sectionRef.current || !cardsRef.current) return

    const ctx = gsap.context(() => {

      // 3D tilt on hover (matches features section)
      const cards = cardsRef.current?.querySelectorAll(".problem-card")
      cards?.forEach((card) => {
        const el = card as HTMLElement

        const handleMouseMove = (e: MouseEvent) => {
          const rect = el.getBoundingClientRect()
          const x = e.clientX - rect.left
          const y = e.clientY - rect.top
          const centerX = rect.width / 2
          const centerY = rect.height / 2
          const rotateX = ((y - centerY) / centerY) * -8
          const rotateY = ((x - centerX) / centerX) * 8

          gsap.to(el, {
            rotateX,
            rotateY,
            scale: 1.02,
            boxShadow: "0 25px 50px -12px rgba(0, 50, 100, 0.15)",
            duration: 0.3,
            ease: "power2.out",
          })

          const glow = el.querySelector(".card-glow") as HTMLElement
          if (glow) {
            gsap.to(glow, { x: x - rect.width / 2, y: y - rect.height / 2, opacity: 1, duration: 0.3 })
          }
        }

        const handleMouseLeave = () => {
          gsap.to(el, {
            rotateX: 0,
            rotateY: 0,
            scale: 1,
            boxShadow: "0 4px 6px -1px rgba(0, 50, 100, 0.05)",
            duration: 0.5,
            ease: "elastic.out(1, 0.5)",
          })

          const glow = el.querySelector(".card-glow") as HTMLElement
          if (glow) gsap.to(glow, { opacity: 0, duration: 0.3 })
        }

        el.addEventListener("mousemove", handleMouseMove)
        el.addEventListener("mouseleave", handleMouseLeave)
      })
    }, sectionRef)

    return () => ctx.revert()
  }, [])

  return (
    <section ref={sectionRef} className="py-8 sm:py-12 md:py-20 lg:py-24 px-4 sm:px-6 md:px-8 lg:px-8 relative overflow-hidden bg-background">
      {/* Technical grid overlay */}
      <div className="absolute inset-0 pointer-events-none opacity-[0.02]">
        <svg width="100%" height="100%">
          <defs>
            <pattern id="tactical-grid" width="40" height="40" patternUnits="userSpaceOnUse">
              <path d="M 40 0 L 0 0 0 40" fill="none" stroke="currentColor" strokeWidth="0.5" strokeDasharray="2 2" />
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#tactical-grid)" />
        </svg>
      </div>

      {/* Horizontal scan lines */}
      <div className="absolute inset-0 pointer-events-none overflow-hidden">
        <div className="absolute top-1/3 left-0 w-full h-px bg-gradient-to-r from-transparent via-indigo-500/20 to-transparent" />
        <div className="absolute top-2/3 left-0 w-full h-px bg-gradient-to-r from-transparent via-destructive/20 to-transparent" />
      </div>

      <div className="max-w-7xl mx-auto relative">
        {/* Tactical Header */}
        <div ref={headingRef} className="mb-8 sm:mb-12 border-l-2 border-indigo-500 pl-4 sm:pl-5 relative min-w-0">
          {/* Corner brackets */}
          <div className="absolute -left-[2px] top-0 w-4 h-px bg-indigo-500" />
          <div className="absolute -left-[2px] bottom-0 w-4 h-px bg-indigo-500" />

          {/* System directive label */}
          <div className="flex items-center gap-2 mb-4">
            <span className="relative flex size-2">
              <span className="absolute inline-flex size-full rounded-sm bg-indigo-400 opacity-75 animate-ping" />
              <span className="relative inline-flex size-2 rounded-sm bg-indigo-500" />
            </span>
            <span className="text-[11px] font-mono font-semibold uppercase tracking-[0.2em] text-indigo-400">
              [SYSTEM_DIRECTIVE // WHY_WE_BUILT_THIS]
            </span>
          </div>

          <h2 className="text-2xl sm:text-3xl md:text-5xl lg:text-6xl font-bold text-foreground mb-3 sm:mb-5 leading-[1.1] uppercase tracking-tight break-words">
            Nepal&apos;s public information<br />
            <span className="text-destructive">system is broken.</span>
          </h2>

          {/* Scan line indicator */}
          <div className="flex gap-4 items-center mt-6">
            <div className="h-1 w-12 bg-indigo-500/30 overflow-hidden relative rounded-full">
              <div className="absolute inset-0 bg-indigo-500 w-full h-full animate-[scanline_2s_linear_infinite]" />
            </div>
            <p className="text-muted-foreground text-base md:text-lg leading-relaxed max-w-2xl font-normal">
              Nepal&apos;s public information infrastructure operates in silos. Critical data is dispersed across disconnected ministries, rendering comprehensive analysis impossible without AI intervention.
            </p>
          </div>
        </div>

        {/* Tactical Metrics Grid */}
        <div
          ref={cardsRef}
          className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4"
          style={{ perspective: "1000px" }}
        >
          {problems.map((p, i) => {
            const Icon = p.icon
            const isCritical = p.severity === "critical"

            return (
              <div
                key={i}
                className="problem-card relative group bg-card backdrop-blur-xl overflow-hidden transition-all duration-300 hover:bg-card min-w-0"
                style={{ transformStyle: "preserve-3d" }}
              >
                {/* Tactical border with corner brackets */}
                <div className="absolute inset-0 border border-border pointer-events-none" />
                <div className="absolute top-0 left-0 w-2 h-2 border-t-2 border-l-2 border-indigo-500" />
                <div className="absolute top-0 right-0 w-2 h-2 border-t-2 border-r-2 border-indigo-500" />
                <div className="absolute bottom-0 left-0 w-2 h-2 border-b-2 border-l-2 border-indigo-500" />
                <div className="absolute bottom-0 right-0 w-2 h-2 border-b-2 border-r-2 border-indigo-500" />

                {/* Reference code label */}
                <div className="absolute top-2 right-2 text-[10px] font-mono text-muted-foreground/60 tracking-wider">
                  REF: {p.refCode}
                </div>

                {/* Status indicator */}
                <div className="absolute top-2 left-2">
                  <span className={`relative flex size-1.5 ${isCritical ? 'animate-pulse' : ''}`}>
                    {isCritical && (
                      <span className="absolute inline-flex size-full rounded-full bg-red-300 opacity-75 animate-ping" />
                    )}
                    <span className={`relative inline-flex size-1.5 rounded-full ${isCritical ? 'bg-destructive' : 'bg-yellow-500'}`} />
                  </span>
                </div>

                {/* Hover scan effect */}
                <div className="absolute inset-0 bg-gradient-to-b from-indigo-500/0 via-indigo-500/5 to-indigo-500/0 opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none" />

                <div className="relative p-4 sm:p-5 md:p-6 min-w-0">
                  {/* Icon + Title */}
                  <div className="flex items-center gap-3 mb-4">
                    <div className="problem-icon size-8 flex items-center justify-center shrink-0 relative">
                      <Icon className={`size-5 ${isCritical ? 'text-destructive' : 'text-indigo-400'} relative z-10`} />
                    </div>
                    <h3 className="font-semibold text-sm uppercase tracking-wider text-foreground">
                      {p.title}
                    </h3>
                  </div>

                  {/* Large stat display */}
                  <div className="mb-4">
                    <div className={`font-black text-4xl md:text-5xl tabular-nums leading-none ${isCritical ? 'text-destructive' : 'text-indigo-400'} mb-2`}>
                      {p.stat}
                    </div>
                    <div className="text-[11px] font-mono uppercase tracking-[0.15em] text-muted-foreground/60">
                      {p.statLabel}
                    </div>
                  </div>

                  {/* Description */}
                  <p className="text-sm text-muted-foreground leading-relaxed mb-4">
                    {p.body}
                  </p>

                  {/* Micro visualization */}
                  {i === 0 && (
                    <div className="mt-4 flex gap-0.5 h-1.5 w-full relative overflow-hidden">
                      <div className="absolute inset-0 bg-destructive/10 w-full h-full animate-[scanline_2s_linear_infinite]" />
                      <div className="h-full bg-destructive/80 w-1/5 relative z-10" />
                      <div className="h-full bg-destructive/60 w-1/5 relative z-10" />
                      <div className="h-full bg-destructive/40 w-1/5 relative z-10" />
                      <div className="h-full bg-destructive/20 w-1/5 relative z-10" />
                      <div className="h-full bg-destructive/10 w-1/5 relative z-10" />
                    </div>
                  )}

                  {i === 1 && (
                    <div className="mt-4 relative h-6 w-full bg-slate-800/40 overflow-hidden border border-border">
                      <div className="absolute inset-y-0 left-0 bg-indigo-500/30 w-[70%] border-r border-indigo-500">
                        <div className="absolute inset-0 w-full h-full bg-gradient-to-r from-transparent via-indigo-400/20 to-transparent animate-[scanline_2s_linear_infinite]" />
                      </div>
                      <div className="absolute right-1 top-1/2 -translate-y-1/2 text-[9px] font-mono text-foreground font-semibold">
                        30% USABLE
                      </div>
                    </div>
                  )}

                  {/* Animated bottom line */}
                  <div
                    className={`animated-line h-px mt-4 bg-gradient-to-r ${isCritical ? 'from-destructive/50' : 'from-indigo-500/50'} via-transparent to-transparent origin-left`}
                    style={{ transform: "scaleX(0)" }}
                  />
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}
