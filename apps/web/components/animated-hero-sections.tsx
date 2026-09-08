"use client"

import React, { useEffect, useRef, useState } from "react"
import gsap from "gsap"
import { Observer } from "gsap/Observer"
import { Search, FileText, Bell, Shield, Zap, ArrowDown, Building2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import Link from "next/link"

gsap.registerPlugin(Observer)

const slides = [
  {
    title: "Public Notices",
    subtitle: "Access all government & institutional notices in one centralized platform",
    accent: "from-blue-500 to-indigo-400",
    icon: <Building2 className="size-8" />,
  },
  {
    title: "Smart Search",
    subtitle: "AI-powered search across millions of verified government documents",
    accent: "from-violet-500 to-indigo-400",
    icon: <Search className="size-8" />,
  },
  {
    title: "Real-time Alerts",
    subtitle: "Custom notifications for jobs, exams, tenders & policy updates",
    accent: "from-red-500 to-orange-400",
    icon: <Bell className="size-8" />,
  },
  {
    title: "Verified Sources",
    subtitle: "Every document authenticated from official government channels",
    accent: "from-indigo-500 to-green-400",
    icon: <Shield className="size-8" />,
  },
  {
    title: "Instant Access",
    subtitle: "Lightning-fast document retrieval powered by RAG intelligence",
    accent: "from-rose-500 to-pink-400",
    icon: <Zap className="size-8" />,
  },
]

export function AnimatedHeroSections() {
  const containerRef = useRef<HTMLDivElement>(null)
  const sectionsRef = useRef<HTMLElement[]>([])
  const outerWrappersRef = useRef<HTMLDivElement[]>([])
  const innerWrappersRef = useRef<HTMLDivElement[]>([])
  const headingsRef = useRef<HTMLHeadingElement[]>([])
  const indicatorsRef = useRef<HTMLDivElement[]>([])
  const [activeIndex, setActiveIndex] = useState(0)

  useEffect(() => {
    if (!containerRef.current) return

    const sections = sectionsRef.current
    const outerWrappers = outerWrappersRef.current
    const innerWrappers = innerWrappersRef.current
    const headings = headingsRef.current
    const totalSlides = slides.length

    let currentIndex = -1
    let animating = false

    const wrap = gsap.utils.wrap(0, totalSlides)

    gsap.set(outerWrappers, { yPercent: 100 })
    gsap.set(innerWrappers, { yPercent: -100 })

    function gotoSection(index: number, direction: number) {
      index = wrap(index)
      animating = true

      const fromTop = direction === -1
      const dFactor = fromTop ? -1 : 1

      const tl = gsap.timeline({
        defaults: { duration: 1.25, ease: "power1.inOut" },
        onComplete: () => {
          animating = false
        },
      })

      if (currentIndex >= 0) {
        gsap.set(sections[currentIndex], { zIndex: 0 })
        tl.to(headings[currentIndex], {
          yPercent: -150 * dFactor,
          opacity: 0,
          duration: 0.6,
        })
        tl.set(sections[currentIndex], { autoAlpha: 0 })
      }

      gsap.set(sections[index], { autoAlpha: 1, zIndex: 1 })
      tl.fromTo(
        [outerWrappers[index], innerWrappers[index]],
        { yPercent: (i) => (i ? -100 * dFactor : 100 * dFactor) },
        { yPercent: 0 },
        0
      )
      tl.fromTo(
        headings[index],
        { yPercent: 150 * dFactor, opacity: 0 },
        { yPercent: 0, opacity: 1, duration: 0.8, ease: "power2.out" },
        0.4
      )

      currentIndex = index
      setActiveIndex(index)
    }

    const obs = Observer.create({
      target: containerRef.current,
      type: "wheel,touch,pointer",
      wheelSpeed: -1,
      onDown: () => {
        if (!animating) gotoSection(currentIndex - 1, -1)
      },
      onUp: () => {
        if (!animating) gotoSection(currentIndex + 1, 1)
      },
      tolerance: 10,
      preventDefault: true,
    })

    gotoSection(0, 1)

    return () => {
      obs.kill()
    }
  }, [])

  return (
    <div ref={containerRef} className="relative h-screen w-full overflow-hidden">
      {slides.map((slide, i) => (
        <section
          key={i}
          ref={(el) => { if (el) sectionsRef.current[i] = el }}
          className="absolute inset-0 h-full w-full invisible"
          style={{ willChange: "transform" }}
        >
          <div
            ref={(el) => { if (el) outerWrappersRef.current[i] = el }}
            className="absolute inset-0 h-full w-full overflow-hidden"
          >
            <div
              ref={(el) => { if (el) innerWrappersRef.current[i] = el }}
              className="absolute inset-0 h-full w-full"
            >
              {/* Background for each slide */}
              <div className="absolute inset-0 bg-background">
                {/* Gradient accent */}
                <div className={`absolute inset-0 bg-gradient-to-br ${slide.accent} opacity-[0.04]`} />

                {/* Grid pattern */}
                <div
                  className="absolute inset-0 opacity-25"
                  style={{
                    backgroundImage: `radial-gradient(circle at 25px 25px, hsl(var(--primary) / 0.12) 1.5px, transparent 0)`,
                    backgroundSize: "80px 80px",
                  }}
                />

                {/* Radial glow center - responsive to avoid overflow */}
                <div className={`absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] sm:w-[700px] sm:h-[700px] lg:w-[900px] lg:h-[900px] max-w-[90vw] max-h-[90vw] rounded-full bg-gradient-to-r ${slide.accent} opacity-[0.07] blur-3xl`} />

                {/* Decorative lines */}
                <div className="absolute inset-0 overflow-hidden opacity-10 pointer-events-none">
                  <div className="absolute top-0 left-1/4 w-px h-full bg-gradient-to-b from-transparent via-primary to-transparent" />
                  <div className="absolute top-0 left-3/4 w-px h-full bg-gradient-to-b from-transparent via-primary/60 to-transparent" />
                  <div className="absolute left-0 top-1/3 w-full h-px bg-gradient-to-r from-transparent via-primary to-transparent" />
                  <div className="absolute left-0 top-2/3 w-full h-px bg-gradient-to-r from-transparent via-primary/60 to-transparent" />
                </div>
              </div>

              {/* Slide content */}
              <div className="relative z-10 h-full flex flex-col items-center justify-center px-4 sm:px-6">
                <div
                  ref={(el) => { if (el) headingsRef.current[i] = el as HTMLHeadingElement }}
                  className="text-center max-w-4xl mx-auto w-full"
                >
                  {/* Icon */}
                  <div className={`inline-flex items-center justify-center size-14 sm:size-16 md:size-20 rounded-2xl sm:rounded-3xl bg-gradient-to-br ${slide.accent} text-white mb-6 sm:mb-8 shadow-2xl shadow-current/20`}>
                    {slide.icon}
                  </div>

                  {/* Title */}
                  <h1 className="text-3xl sm:text-5xl md:text-7xl lg:text-[6rem] font-bold text-foreground mb-4 sm:mb-6 leading-[1.05] tracking-tight px-2 sm:px-0">
                    {slide.title}
                  </h1>

                  {/* Subtitle */}
                  <p className="text-base sm:text-lg md:text-xl lg:text-2xl text-muted-foreground max-w-2xl mx-auto leading-relaxed px-4 sm:px-0">
                    {slide.subtitle}
                  </p>

                  {/* CTA */}
                  <div className="mt-10 flex items-center justify-center gap-4">
                    <Link href="/notices">
                      <Button size="lg" className="h-13 px-8 text-base gap-2 shadow-lg shadow-primary/20">
                        Explore Notices <ArrowDown className="size-4 animate-bounce" />
                      </Button>
                    </Link>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>
      ))}

      {/* Slide indicators - right side - hidden on mobile to avoid overlap */}
      <div className="absolute hidden sm:flex right-4 sm:right-8 top-1/2 -translate-y-1/2 z-50 flex-col gap-3">
        {slides.map((_, i) => (
          <div
            key={i}
            ref={(el) => { if (el) indicatorsRef.current[i] = el }}
            className={`rounded-full transition-all duration-500 ${
              activeIndex === i
                ? "w-2 h-6 bg-primary"
                : "size-2 bg-foreground/20"
            }`}
          />
        ))}
      </div>

      {/* Scroll hint - responsive */}
      <div className="absolute bottom-4 sm:bottom-8 left-1/2 -translate-x-1/2 z-50 flex flex-col items-center gap-1 sm:gap-2 text-muted-foreground/60">
        <span className="text-xs font-medium uppercase tracking-widest">Scroll to navigate</span>
        <div className="w-5 h-9 rounded-full border-2 border-muted-foreground/30 flex items-start justify-center p-1.5">
          <div className="w-1 h-2 rounded-full bg-muted-foreground/60 animate-bounce" />
        </div>
      </div>

      {/* Bottom gradient fade into next section */}
      <div className="absolute bottom-0 left-0 right-0 h-24 bg-gradient-to-t from-background to-transparent pointer-events-none z-40" />
    </div>
  )
}
