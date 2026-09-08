"use client"

import React, { useRef, useEffect } from "react"

import { type LucideIcon } from "lucide-react"
import gsap from "gsap"

interface Feature {
  icon: LucideIcon
  title: string
  description: string
}

export function FeaturesSection({ features }: { features: Feature[] }) {
  const sectionRef = useRef<HTMLElement>(null)
  const headingRef = useRef<HTMLDivElement>(null)
  const cardsRef = useRef<HTMLDivElement>(null)
  const glowOrbs = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!sectionRef.current || !cardsRef.current) return

    const heading = headingRef.current
    const cards = cardsRef.current?.querySelectorAll(".feature-card")
    const icons = cardsRef.current?.querySelectorAll(".feature-icon")
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

      // Cards stagger in
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

    // Animate background orbs
    if (glowOrbs.current) {
      const orbs = glowOrbs.current.querySelectorAll(".glow-orb")
      gsap.to(orbs, {
        y: "random(-20, 20)",
        x: "random(-15, 15)",
        duration: "random(3, 5)",
        repeat: -1,
        yoyo: true,
        ease: "sine.inOut",
        stagger: { each: 0.5, from: "random" },
      })
    }

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
      // 3D tilt on hover
      const cards = cardsRef.current?.querySelectorAll(".feature-card")
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

          // Move glow inside card
          const glow = el.querySelector(".card-glow") as HTMLElement
          if (glow) {
            gsap.to(glow, {
              x: x - rect.width / 2,
              y: y - rect.height / 2,
              opacity: 1,
              duration: 0.3,
            })
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
          if (glow) {
            gsap.to(glow, { opacity: 0, duration: 0.3 })
          }
        }

        el.addEventListener("mousemove", handleMouseMove)
        el.addEventListener("mouseleave", handleMouseLeave)
      })
    }, sectionRef)

    return () => ctx.revert()
  }, [])

  return (
    <section ref={sectionRef} className="py-8 sm:py-12 md:py-20 lg:py-24 px-4 sm:px-6 md:px-8 lg:px-8 relative overflow-hidden bg-background">
      <div ref={glowOrbs} className="absolute inset-0 pointer-events-none" />

      {/* Technical grid */}
      <div className="absolute inset-0 pointer-events-none opacity-[0.02]">
        <svg width="100%" height="100%">
          <defs>
            <pattern id="feature-grid" width="40" height="40" patternUnits="userSpaceOnUse">
              <path d="M 40 0 L 0 0 0 40" fill="none" stroke="currentColor" strokeWidth="0.5" strokeDasharray="2 2" />
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#feature-grid)" />
        </svg>
      </div>

      <div className="max-w-7xl mx-auto relative">
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
              [CORE_CAPABILITIES // PLATFORM_OVERVIEW]
            </span>
          </div>

          <h2 className="text-2xl sm:text-3xl md:text-5xl font-bold text-foreground mb-3 sm:mb-5 leading-tight uppercase tracking-tight break-words">
            Everything you need for <span className="text-indigo-400">public notices</span>
          </h2>

          <div className="flex gap-4 items-center mt-6">
            <div className="h-0.5 w-16 bg-indigo-500/30 overflow-hidden relative">
              <div className="absolute inset-0 bg-indigo-500 w-full h-full animate-[scanline_2s_linear_infinite]" />
            </div>
            <p className="text-muted-foreground text-base md:text-lg leading-relaxed max-w-2xl font-normal">
              A comprehensive platform designed for transparency, efficiency, and accessibility in government communication.
            </p>
          </div>
        </div>

        {/* Tactical feature cards */}
        <div ref={cardsRef} className="grid grid-cols-1 sm:grid-cols-2 gap-4" style={{ perspective: "1000px" }}>
          {features.map((feature, i) => {
            const Icon = feature.icon
            return (
              <div
                key={i}
                className="feature-card relative group bg-card backdrop-blur-xl p-4 sm:p-6 flex flex-col sm:flex-row gap-4 sm:gap-5 cursor-pointer overflow-hidden transition-all duration-300 hover:bg-card min-w-0"
                style={{ transformStyle: "preserve-3d" }}
              >
                {/* Tactical border */}
                <div className="absolute inset-0 border border-border pointer-events-none" />
                <div className="absolute top-0 left-0 w-2 h-2 border-t-2 border-l-2 border-indigo-500" />
                <div className="absolute top-0 right-0 w-2 h-2 border-t-2 border-r-2 border-indigo-500" />
                <div className="absolute bottom-0 left-0 w-2 h-2 border-b-2 border-l-2 border-indigo-500" />
                <div className="absolute bottom-0 right-0 w-2 h-2 border-b-2 border-r-2 border-indigo-500" />

                {/* Module label */}
                <div className="absolute top-2 right-2 text-[9px] font-mono text-muted-foreground/60 uppercase tracking-wider">
                  MOD_{String(i + 1).padStart(2, '0')}
                </div>

                {/* Hover scan */}
                <div className="card-glow absolute w-40 h-40 rounded-full bg-indigo-500/5 blur-2xl pointer-events-none opacity-0" />
                <div className="absolute inset-0 bg-gradient-to-b from-indigo-500/0 via-indigo-500/5 to-indigo-500/0 opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none" />

                {/* Icon */}
                <div className="feature-icon size-12 flex items-center justify-center shrink-0 relative bg-indigo-500/10 border border-indigo-500/20">
                  <Icon className="size-6 text-indigo-400 relative z-10" />
                  <div className="absolute inset-0 bg-indigo-500/20 animate-ping opacity-0 group-hover:opacity-100" style={{ animationDuration: "2s" }} />
                </div>

                {/* Content */}
                <div className="relative z-10 flex-1">
                  <h3 className="font-semibold text-base uppercase tracking-wide mb-2 text-foreground">{feature.title}</h3>
                  <p className="text-sm text-muted-foreground leading-relaxed font-normal">{feature.description}</p>
                  <div className="animated-line h-px mt-4 bg-gradient-to-r from-indigo-500/50 via-transparent to-transparent origin-left" style={{ transform: "scaleX(0)" }} />
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}
