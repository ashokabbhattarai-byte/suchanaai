"use client"

import React, { useEffect, useRef } from "react"
import { Bell, CheckCircle, ArrowRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import Link from "next/link"
import gsap from "gsap"
import { ScrollTrigger } from "gsap/ScrollTrigger"
import { DrawSVGPlugin } from "gsap/DrawSVGPlugin"

gsap.registerPlugin(ScrollTrigger, DrawSVGPlugin)

export function AlertCTASection() {
  const sectionRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const bellRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    if (!sectionRef.current || !contentRef.current || !svgRef.current) return

    const ctx = gsap.context(() => {
      // Draw SVG paths on scroll
      const paths = svgRef.current!.querySelectorAll(".draw")
      gsap.set(paths, { drawSVG: "0%" })

      gsap.to(paths, {
        drawSVG: "100%",
        ease: "none",
        stagger: 0.1,
        scrollTrigger: {
          trigger: sectionRef.current,
          start: "top 80%",
          end: "center center",
          scrub: 1,
        },
      })

      // Set initial state via GSAP
      gsap.set(contentRef.current, { opacity: 0, y: 60 })

      // Content reveal on scroll
      gsap.to(contentRef.current, {
        opacity: 1,
        y: 0,
        duration: 0.9,
        ease: "power3.out",
        scrollTrigger: {
          trigger: contentRef.current,
          start: "top 80%",
          toggleActions: "play none none none",
        },
      })

      // Bell entrance with ScrollTrigger
      if (bellRef.current) {
        gsap.fromTo(
          bellRef.current,
          { scale: 0, rotation: -15 },
          {
            scale: 1,
            rotation: 0,
            duration: 0.8,
            ease: "back.out(2)",
            scrollTrigger: {
              trigger: bellRef.current,
              start: "top 80%",
              toggleActions: "play none none none",
            },
          }
        )

        // Continuous bell swing after reveal
        gsap.to(bellRef.current, {
          rotation: 8,
          yoyo: true,
          repeat: -1,
          duration: 1.2,
          ease: "sine.inOut",
          delay: 1.5,
        })
      }

      // Pills stagger on scroll
      const pills = contentRef.current!.querySelectorAll(".alert-pill")
      gsap.fromTo(
        Array.from(pills),
        { opacity: 0, y: 25, scale: 0.85 },
        {
          opacity: 1,
          y: 0,
          scale: 1,
          duration: 0.6,
          stagger: 0.12,
          ease: "back.out(1.5)",
          scrollTrigger: {
            trigger: pills[0],
            start: "top 85%",
            toggleActions: "play none none none",
          },
        }
      )

      // Buttons entrance
      const buttons = contentRef.current!.querySelectorAll(".cta-btn")
      gsap.fromTo(
        Array.from(buttons),
        { opacity: 0, y: 20 },
        {
          opacity: 1,
          y: 0,
          duration: 0.5,
          stagger: 0.15,
          ease: "power3.out",
          scrollTrigger: {
            trigger: buttons[0],
            start: "top 90%",
            toggleActions: "play none none none",
          },
        }
      )

      // Animated glow pulse on the SVG decorative circles
      const glowCircles = svgRef.current!.querySelectorAll(".glow-dot")
      gsap.fromTo(
        Array.from(glowCircles),
        { opacity: 0, scale: 0 },
        {
          opacity: 1,
          scale: 1,
          duration: 0.4,
          stagger: 0.2,
          ease: "power2.out",
          scrollTrigger: {
            trigger: sectionRef.current,
            start: "top 60%",
            toggleActions: "play none none none",
          },
        }
      )

      // Pulsing glow on dots
      gsap.to(Array.from(glowCircles), {
        opacity: 0.4,
        scale: 1.3,
        yoyo: true,
        repeat: -1,
        duration: 2,
        stagger: 0.4,
        ease: "sine.inOut",
        delay: 1.5,
      })
    }, sectionRef)

    return () => ctx.revert()
  }, [])

  return (
    <section ref={sectionRef} className="relative py-8 sm:py-12 md:py-20 lg:py-24 px-4 sm:px-6 md:px-8 lg:px-8 overflow-hidden bg-background">

      {/* SVG decorative circuit lines - drawn on scroll, full-width */}
      <svg
        ref={svgRef}
        className="absolute inset-0 w-full h-full pointer-events-none"
        viewBox="0 0 1400 500"
        preserveAspectRatio="none"
        fill="none"
      >
        <path
          className="draw"
          d="M 0 80 h 400 q 10 0 10 10 v 60 q 0 10 10 10 h 280"
          stroke="url(#cta-line-grad-1)"
          strokeWidth="1"
          strokeLinecap="round"
        />
        <path
          className="draw"
          d="M 1400 120 h -380 q -10 0 -10 10 v 40 q 0 10 -10 10 h -200"
          stroke="url(#cta-line-grad-2)"
          strokeWidth="1"
          strokeLinecap="round"
        />
        <path
          className="draw"
          d="M 0 400 h 250 q 10 0 10 -10 v -50 q 0 -10 10 -10 h 160"
          stroke="url(#cta-line-grad-3)"
          strokeWidth="0.8"
          strokeLinecap="round"
        />
        <path
          className="draw"
          d="M 1400 380 h -300 q -10 0 -10 -10 v -30 q 0 -10 -10 -10 h -200"
          stroke="url(#cta-line-grad-4)"
          strokeWidth="0.8"
          strokeLinecap="round"
        />

        {/* Endpoint dots */}
        <circle className="glow-dot" cx="700" cy="160" r="3" fill="hsl(var(--muted-foreground))" opacity="0" />
        <circle className="glow-dot" cx="690" cy="180" r="3" fill="hsl(var(--muted-foreground))" opacity="0" />
        <circle className="glow-dot" cx="430" cy="330" r="2.5" fill="hsl(var(--muted-foreground))" opacity="0" />
        <circle className="glow-dot" cx="680" cy="330" r="2.5" fill="hsl(var(--muted-foreground))" opacity="0" />
        <circle className="glow-dot" cx="260" cy="80" r="2" fill="hsl(var(--muted-foreground))" opacity="0" />
        <circle className="glow-dot" cx="1140" cy="420" r="2" fill="hsl(var(--muted-foreground))" opacity="0" />

        <defs>
          <linearGradient id="cta-line-grad-1" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="transparent" />
            <stop offset="30%" stopColor="hsl(var(--border))" stopOpacity="0.6" />
            <stop offset="70%" stopColor="hsl(var(--border))" stopOpacity="0.8" />
            <stop offset="100%" stopColor="transparent" />
          </linearGradient>
          <linearGradient id="cta-line-grad-2" x1="1" y1="0" x2="0" y2="0">
            <stop offset="0%" stopColor="transparent" />
            <stop offset="30%" stopColor="hsl(var(--border))" stopOpacity="0.5" />
            <stop offset="70%" stopColor="hsl(var(--border))" stopOpacity="0.7" />
            <stop offset="100%" stopColor="transparent" />
          </linearGradient>
          <linearGradient id="cta-line-grad-3" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="transparent" />
            <stop offset="50%" stopColor="hsl(var(--border))" stopOpacity="0.4" />
            <stop offset="100%" stopColor="transparent" />
          </linearGradient>
          <linearGradient id="cta-line-grad-4" x1="1" y1="0" x2="0" y2="0">
            <stop offset="0%" stopColor="transparent" />
            <stop offset="50%" stopColor="hsl(var(--border))" stopOpacity="0.4" />
            <stop offset="100%" stopColor="transparent" />
          </linearGradient>
        </defs>
      </svg>


      {/* Content */}
      <div ref={contentRef} className="relative z-10 max-w-3xl mx-auto text-center px-2 sm:px-0 min-w-0">
        {/* Tactical bell icon */}
        <div ref={bellRef} className="size-16 sm:size-20 bg-indigo-500/10 border-2 border-indigo-500 flex items-center justify-center mx-auto mb-6 sm:mb-8 backdrop-blur-xl relative">
          {/* Corner brackets */}
          <div className="absolute top-0 left-0 w-3 h-3 border-t-2 border-l-2 border-indigo-400" />
          <div className="absolute top-0 right-0 w-3 h-3 border-t-2 border-r-2 border-indigo-400" />
          <div className="absolute bottom-0 left-0 w-3 h-3 border-b-2 border-l-2 border-indigo-400" />
          <div className="absolute bottom-0 right-0 w-3 h-3 border-b-2 border-r-2 border-indigo-400" />

          <Bell className="size-9 text-indigo-400" />

          {/* Pulse indicator */}
          <div className="absolute -top-1 -right-1">
            <span className="relative flex size-3">
              <span className="absolute inline-flex size-full rounded-full bg-indigo-400 opacity-75 animate-ping" />
              <span className="relative inline-flex size-3 rounded-full bg-indigo-500" />
            </span>
          </div>
        </div>

        {/* System label */}
        <div className="flex items-center justify-center gap-2 mb-6">
          <span className="relative flex size-2">
            <span className="absolute inline-flex size-full rounded-sm bg-indigo-400 opacity-75 animate-ping" />
            <span className="relative inline-flex size-2 rounded-sm bg-indigo-500" />
          </span>
          <span className="text-[11px] font-mono font-semibold uppercase tracking-[0.2em] text-indigo-400">
            [ALERT_SYSTEM // REAL_TIME_NOTIFICATIONS]
          </span>
        </div>

        <h2 ref={headingRef} className="text-2xl sm:text-3xl md:text-4xl lg:text-5xl font-bold text-foreground mb-3 sm:mb-5 leading-tight uppercase tracking-tight break-words">
          Never Miss an Important <span className="text-indigo-400">Notice</span>
        </h2>

        {/* Scan line */}
        <div className="flex justify-center mb-6">
          <div className="h-0.5 w-20 bg-indigo-500/30 overflow-hidden relative">
            <div className="absolute inset-0 bg-indigo-500 w-full h-full animate-[scanline_2s_linear_infinite]" />
          </div>
        </div>

        <p className="text-muted-foreground text-sm sm:text-base md:text-lg max-w-2xl mx-auto mb-8 sm:mb-10 leading-relaxed font-normal px-2 sm:px-0">
          Get instant alerts for job vacancies, exam dates, tenders, and government updates - directly to your phone or email.
        </p>

        {/* Tactical category badges */}
        <div className="flex flex-wrap items-center justify-center gap-2 sm:gap-3 mb-8 sm:mb-12 px-2">
          <span className="alert-pill flex items-center gap-1.5 sm:gap-2 bg-card backdrop-blur-xl border border-border px-3 sm:px-4 py-1.5 sm:py-2 text-[11px] sm:text-xs font-mono font-medium text-foreground/80 transition-colors hover:border-indigo-500/40 hover:text-indigo-500 uppercase tracking-wide relative">
            <div className="absolute top-0 left-0 w-1 h-1 bg-indigo-500" />
            <CheckCircle className="size-3 sm:size-3.5 text-indigo-400 shrink-0" /> Job Alerts
          </span>
          <span className="alert-pill flex items-center gap-1.5 sm:gap-2 bg-card backdrop-blur-xl border border-border px-3 sm:px-4 py-1.5 sm:py-2 text-[11px] sm:text-xs font-mono font-medium text-foreground/80 transition-colors hover:border-indigo-500/40 hover:text-indigo-500 uppercase tracking-wide relative">
            <div className="absolute top-0 left-0 w-1 h-1 bg-indigo-500" />
            <CheckCircle className="size-3 sm:size-3.5 text-indigo-400 shrink-0" /> Exam Dates
          </span>
          <span className="alert-pill flex items-center gap-1.5 sm:gap-2 bg-card backdrop-blur-xl border border-border px-3 sm:px-4 py-1.5 sm:py-2 text-[11px] sm:text-xs font-mono font-medium text-foreground/80 transition-colors hover:border-indigo-500/40 hover:text-indigo-500 uppercase tracking-wide relative">
            <div className="absolute top-0 left-0 w-1 h-1 bg-indigo-500" />
            <CheckCircle className="size-3 sm:size-3.5 text-indigo-400 shrink-0" /> Tender Notices
          </span>
          <span className="alert-pill flex items-center gap-1.5 sm:gap-2 bg-card backdrop-blur-xl border border-border px-3 sm:px-4 py-1.5 sm:py-2 text-[11px] sm:text-xs font-mono font-medium text-foreground/80 transition-colors hover:border-indigo-500/40 hover:text-indigo-500 uppercase tracking-wide relative">
            <div className="absolute top-0 left-0 w-1 h-1 bg-indigo-500" />
            <CheckCircle className="size-3 sm:size-3.5 text-indigo-400 shrink-0" /> Policy Updates
          </span>
        </div>

        {/* Tactical buttons */}
        <div className="flex flex-col sm:flex-row items-center justify-center gap-3 sm:gap-4 w-full sm:w-auto px-4 sm:px-0">
          <Link href="/login" className="w-full sm:w-auto">
            <Button size="lg" className="cta-btn w-full sm:w-auto gap-2 h-11 sm:h-12 px-6 sm:px-8 text-xs font-semibold shadow-lg shadow-indigo-500/25 hover:shadow-indigo-500/40 transition-all uppercase tracking-wide bg-indigo-600 hover:bg-indigo-500 border border-indigo-500/30 relative group">
              <Bell className="size-4 group-hover:rotate-12 transition-transform shrink-0" /> Set Up Your First Alert
              <ArrowRight className="size-4 group-hover:translate-x-1 transition-transform shrink-0" />
            </Button>
          </Link>
          <Link href="/notices" className="w-full sm:w-auto">
            <Button size="lg" variant="outline" className="cta-btn w-full sm:w-auto h-11 sm:h-12 px-6 sm:px-8 text-xs font-semibold border-border hover:bg-accent hover:border-indigo-500/40 transition-all uppercase tracking-wide bg-transparent">
              Browse Notices
            </Button>
          </Link>
        </div>
      </div>
    </section>
  )
}
