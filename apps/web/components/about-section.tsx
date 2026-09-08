"use client"

import React, { useRef, useEffect } from "react"
import { Target, Users, Zap, Shield, Heart, TrendingUp } from "lucide-react"
import gsap from "gsap"

const values = [
  {
    icon: Target,
    title: "Mission-Driven",
    description: "Democratizing access to public information across Nepal through AI-powered technology.",
  },
  {
    icon: Shield,
    title: "Transparency First",
    description: "Building trust through verified sources and open data practices.",
  },
  {
    icon: Heart,
    title: "Citizen-Centric",
    description: "Every feature designed with the needs of Nepali citizens at its core.",
  },
  {
    icon: TrendingUp,
    title: "Innovation",
    description: "Leveraging cutting-edge AI to solve real-world governance challenges.",
  },
]

const stats = [
  { value: "2024", label: "Founded" },
  { value: "50+", label: "Gov Sources" },
  { value: "10K+", label: "Daily Queries" },
  { value: "99.9%", label: "Uptime" },
]

export function AboutSection() {
  const sectionRef = useRef<HTMLElement>(null)
  const headingRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const cardsRef = useRef<(HTMLDivElement | null)[]>([])
  const statsRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!sectionRef.current) return

    const heading = headingRef.current
    const content = contentRef.current
    const cards = cardsRef.current.filter(Boolean) as HTMLDivElement[]
    const statsContainer = statsRef.current

    const reset = () => {
      gsap.killTweensOf([heading, content, ...cards, statsContainer])
      gsap.set(heading, { opacity: 0, y: 40 })
      gsap.set(content, { opacity: 0, y: 30 })
      gsap.set(cards, { opacity: 0, y: 40, scale: 0.95 })
      gsap.set(statsContainer, { opacity: 0, y: 30 })
    }

    const play = () => {
      const tl = gsap.timeline({ defaults: { ease: "power3.out" } })

      // Heading entrance
      tl.to(heading, { opacity: 1, y: 0, duration: 0.4 })

      // Content text
      tl.to(content, { opacity: 1, y: 0, duration: 0.35 }, "-=0.4")

      // Cards stagger in
      tl.to(cards, {
        opacity: 1,
        y: 0,
        scale: 1,
        duration: 0.3,
        stagger: 0.12,
        ease: "back.out(1.5)",
      }, "-=0.3")

      // Stats counter
      tl.to(statsContainer, { opacity: 1, y: 0, duration: 0.3 }, "-=0.4")
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

    observer.observe(sectionRef.current)
    return () => observer.disconnect()
  }, [])

  return (
    <section
      ref={sectionRef}
      id="about"
      className="relative py-8 sm:py-12 md:py-20 lg:py-24 px-4 sm:px-6 md:px-8 lg:px-8 bg-background overflow-hidden"
    >
      {/* Technical grid */}
      <div className="absolute inset-0 pointer-events-none opacity-[0.02]">
        <svg width="100%" height="100%">
          <defs>
            <pattern id="about-grid" width="40" height="40" patternUnits="userSpaceOnUse">
              <path d="M 40 0 L 0 0 0 40" fill="none" stroke="currentColor" strokeWidth="0.5" strokeDasharray="2 2" />
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#about-grid)" />
        </svg>
      </div>

      <div className="relative max-w-7xl mx-auto">
        {/* Tactical header */}
        <div ref={headingRef} className="mb-8 sm:mb-12 border-l-2 border-indigo-500 pl-4 sm:pl-5 relative min-w-0">
          <div className="absolute -left-[2px] top-0 w-4 h-px bg-indigo-500" />
          <div className="absolute -left-[2px] bottom-0 w-4 h-px bg-indigo-500" />

          <div className="flex items-center gap-2 mb-4">
            <span className="relative flex size-2">
              <span className="absolute inline-flex size-full rounded-sm bg-indigo-400 opacity-75 animate-ping" />
              <span className="relative inline-flex size-2 rounded-sm bg-indigo-500" />
            </span>
            <span className="text-[11px] font-mono font-semibold uppercase tracking-[0.2em] text-indigo-400">
              [ABOUT_US // WHO_WE_ARE]
            </span>
          </div>

          <h2 className="text-2xl sm:text-3xl md:text-5xl font-bold text-foreground mb-3 sm:mb-5 leading-tight uppercase tracking-tight break-words">
            Building the future of <span className="text-indigo-400">public information</span>
          </h2>

          <div className="flex gap-4 items-center mt-6">
            <div className="h-0.5 w-16 bg-indigo-500/30 overflow-hidden relative">
              <div className="absolute inset-0 bg-indigo-500 w-full h-full animate-[scanline_2s_linear_infinite]" />
            </div>
          </div>
        </div>

        {/* Content */}
        <div ref={contentRef} className="mb-8 sm:mb-12 max-w-3xl min-w-0">
          <p className="text-muted-foreground text-sm sm:text-base md:text-lg leading-relaxed mb-4 break-words">
            Suchana AI is a mission-driven technology platform addressing Nepal&apos;s fragmented public information ecosystem. We aggregate official government notices from 50+ portals, process them with AI, and make every document instantly searchable in plain language.
          </p>
          <p className="text-muted-foreground text-base md:text-lg leading-relaxed">
            From job vacancies and exam schedules to tenders and policy updates - we ensure no citizen misses critical information that impacts their life, education, or livelihood.
          </p>
        </div>

        {/* Values Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8 sm:mb-12">
          {values.map((value, i) => {
            const Icon = value.icon
            return (
              <div
                key={value.title}
                ref={(el) => { cardsRef.current[i] = el }}
                className="relative bg-card backdrop-blur-xl p-4 sm:p-6 group hover:bg-card transition-all duration-300 min-w-0"
              >
                {/* Tactical border */}
                <div className="absolute inset-0 border border-border pointer-events-none" />
                <div className="absolute top-0 left-0 w-2 h-2 border-t-2 border-l-2 border-indigo-500" />
                <div className="absolute top-0 right-0 w-2 h-2 border-t-2 border-r-2 border-indigo-500" />
                <div className="absolute bottom-0 left-0 w-2 h-2 border-b-2 border-l-2 border-indigo-500" />
                <div className="absolute bottom-0 right-0 w-2 h-2 border-b-2 border-r-2 border-indigo-500" />

                {/* Hover scan */}
                <div className="absolute inset-0 bg-gradient-to-b from-indigo-500/0 via-indigo-500/5 to-indigo-500/0 opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none" />

                <div className="relative">
                  <div className="size-10 bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center mb-4 group-hover:scale-110 transition-transform duration-300">
                    <Icon className="size-5 text-indigo-400" />
                  </div>
                  <h3 className="text-base font-semibold mb-2 uppercase tracking-wide text-foreground">
                    {value.title}
                  </h3>
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    {value.description}
                  </p>
                </div>
              </div>
            )
          })}
        </div>

        {/* Stats */}
        <div
          ref={statsRef}
          className="relative bg-card backdrop-blur-xl p-4 sm:p-8 border border-border"
        >
          <div className="absolute top-0 left-0 w-2 h-2 border-t-2 border-l-2 border-indigo-500" />
          <div className="absolute top-0 right-0 w-2 h-2 border-t-2 border-r-2 border-indigo-500" />
          <div className="absolute bottom-0 left-0 w-2 h-2 border-b-2 border-l-2 border-indigo-500" />
          <div className="absolute bottom-0 right-0 w-2 h-2 border-b-2 border-r-2 border-indigo-500" />

          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 sm:gap-6">
            {stats.map((stat) => (
              <div key={stat.label} className="text-center min-w-0">
                <p className="text-2xl sm:text-3xl md:text-4xl font-black text-indigo-400 mb-1 sm:mb-2 tabular-nums break-words">
                  {stat.value}
                </p>
                <p className="text-[11px] sm:text-xs text-muted-foreground font-mono uppercase tracking-wider break-words">
                  {stat.label}
                </p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}
