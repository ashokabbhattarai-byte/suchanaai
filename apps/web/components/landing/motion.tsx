"use client"

import React, { useEffect, useRef } from "react"
import gsap from "gsap"
import { ScrollTrigger } from "gsap/ScrollTrigger"
import { cn } from "@/lib/utils"

gsap.registerPlugin(ScrollTrigger)

function reducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches
}

/**
 * Magnetic - children gently follow the cursor while hovered and spring back
 * elastically on leave. Wrap CTAs; keeps layout intact (transform only).
 */
export function Magnetic({
  children,
  strength = 0.35,
  className,
}: {
  children: React.ReactNode
  strength?: number
  className?: string
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el || reducedMotion()) return
    // Magnetism assumes a hover-capable pointer.
    if (!window.matchMedia("(hover: hover)").matches) return

    const xTo = gsap.quickTo(el, "x", { duration: 0.4, ease: "power3.out" })
    const yTo = gsap.quickTo(el, "y", { duration: 0.4, ease: "power3.out" })

    const onMove = (e: MouseEvent) => {
      const rect = el.getBoundingClientRect()
      xTo((e.clientX - (rect.left + rect.width / 2)) * strength)
      yTo((e.clientY - (rect.top + rect.height / 2)) * strength)
    }
    const onLeave = () => {
      gsap.to(el, { x: 0, y: 0, duration: 0.9, ease: "elastic.out(1, 0.35)" })
    }

    el.addEventListener("mousemove", onMove)
    el.addEventListener("mouseleave", onLeave)
    return () => {
      el.removeEventListener("mousemove", onMove)
      el.removeEventListener("mouseleave", onLeave)
      gsap.killTweensOf(el)
    }
  }, [strength])

  return (
    <div ref={ref} className={cn("w-fit", className)}>
      {children}
    </div>
  )
}

/**
 * TiltCard - card tilts in 3D toward the pointer and lifts slightly,
 * settling back on leave. Transform-only; perspective lives on the wrapper.
 */
export function TiltCard({
  children,
  max = 7,
  className,
}: {
  children: React.ReactNode
  /** Max tilt in degrees */
  max?: number
  className?: string
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el || reducedMotion()) return
    if (!window.matchMedia("(hover: hover)").matches) return

    const rxTo = gsap.quickTo(el, "rotationX", { duration: 0.5, ease: "power2.out" })
    const ryTo = gsap.quickTo(el, "rotationY", { duration: 0.5, ease: "power2.out" })

    const onMove = (e: MouseEvent) => {
      const rect = el.getBoundingClientRect()
      const px = (e.clientX - rect.left) / rect.width - 0.5
      const py = (e.clientY - rect.top) / rect.height - 0.5
      ryTo(px * max)
      rxTo(-py * max)
    }
    const onEnter = () => gsap.to(el, { y: -6, duration: 0.4, ease: "power2.out" })
    const onLeave = () => {
      gsap.to(el, { rotationX: 0, rotationY: 0, y: 0, duration: 0.7, ease: "power3.out" })
    }

    el.addEventListener("mousemove", onMove)
    el.addEventListener("mouseenter", onEnter)
    el.addEventListener("mouseleave", onLeave)
    return () => {
      el.removeEventListener("mousemove", onMove)
      el.removeEventListener("mouseenter", onEnter)
      el.removeEventListener("mouseleave", onLeave)
      gsap.killTweensOf(el)
    }
  }, [max])

  return (
    <div style={{ perspective: "900px" }} className={className}>
      <div ref={ref} style={{ transformStyle: "preserve-3d", willChange: "transform" }} className="h-full">
        {children}
      </div>
    </div>
  )
}

/**
 * Parallax - element drifts vertically at a different rate than the page,
 * linked to scroll position (scrub). speed is the total yPercent traveled.
 */
export function Parallax({
  children,
  speed = -12,
  className,
}: {
  children: React.ReactNode
  speed?: number
  className?: string
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el || reducedMotion()) return

    const tween = gsap.fromTo(
      el,
      { yPercent: -speed / 2 },
      {
        yPercent: speed / 2,
        ease: "none",
        scrollTrigger: {
          trigger: el,
          start: "top bottom",
          end: "bottom top",
          scrub: 0.8,
        },
      }
    )
    return () => {
      tween.scrollTrigger?.kill()
      tween.kill()
    }
  }, [speed])

  return (
    <div ref={ref} className={className} style={{ willChange: "transform" }}>
      {children}
    </div>
  )
}

/**
 * StaggerGrid - reveals its direct children from the center outward with a
 * rise, slight rotation, and back.out spring when the grid enters the view.
 * Replaces per-card <Reveal> wrappers inside card grids.
 */
export function StaggerGrid({
  children,
  className,
  amount = 0.5,
}: {
  children: React.ReactNode
  className?: string
  /** Total seconds spread across the stagger */
  amount?: number
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const items = Array.from(el.children) as HTMLElement[]
    if (!items.length) return

    if (reducedMotion()) {
      gsap.set(items, { opacity: 1, y: 0, rotation: 0, scale: 1 })
      return
    }

    const tween = gsap.fromTo(
      items,
      { opacity: 0, y: 44, rotation: 1.5, scale: 0.96 },
      {
        opacity: 1,
        y: 0,
        rotation: 0,
        scale: 1,
        duration: 0.9,
        ease: "back.out(1.4)",
        stagger: { amount, from: "center" },
        scrollTrigger: {
          trigger: el,
          start: "top 92%",
          once: true,
        },
      }
    )
    const fallback = window.setTimeout(() => {
      if (items[0] && getComputedStyle(items[0]).opacity === "0") {
        gsap.set(items, { opacity: 1, y: 0, rotation: 0, scale: 1 })
        tween.scrollTrigger?.kill()
      }
    }, 1500)
    return () => {
      window.clearTimeout(fallback)
      tween.scrollTrigger?.kill()
      tween.kill()
    }
  }, [amount])

  // Children start hidden via inline-safe CSS class to avoid pre-hydration flash.
  return (
    <div ref={ref} className={cn("vz-stagger-grid", className)}>
      {children}
    </div>
  )
}

/**
 * PopIcon - icon badge springs in (scale from 0, back.out) when scrolled
 * into view. Wrap the icon container, not the whole card.
 */
export function PopIcon({
  children,
  className,
  delay = 0,
}: {
  children: React.ReactNode
  className?: string
  delay?: number
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (reducedMotion()) {
      gsap.set(el, { opacity: 1, scale: 1 })
      return
    }

    const tween = gsap.fromTo(
      el,
      { opacity: 0, scale: 0, rotation: -12 },
      {
        opacity: 1,
        scale: 1,
        rotation: 0,
        duration: 0.7,
        delay: delay / 1000,
        ease: "back.out(2)",
        scrollTrigger: { trigger: el, start: "top 92%", once: true },
      }
    )
    const fallback = window.setTimeout(() => {
      if (getComputedStyle(el).opacity === "0") {
        gsap.set(el, { opacity: 1, scale: 1, rotation: 0 })
        tween.scrollTrigger?.kill()
      }
    }, 1400 + delay)
    return () => {
      window.clearTimeout(fallback)
      tween.scrollTrigger?.kill()
      tween.kill()
    }
  }, [delay])

  return (
    <div ref={ref} className={cn("vz-pop", className)}>
      {children}
    </div>
  )
}
