"use client"

import React, { useEffect, useRef } from "react"
import gsap from "gsap"
import { ScrollTrigger } from "gsap/ScrollTrigger"
import { cn } from "@/lib/utils"

gsap.registerPlugin(ScrollTrigger)

interface RevealProps {
  children: React.ReactNode
  className?: string
  /** Stagger delay in ms */
  delay?: number
  as?: "div" | "section" | "article" | "li"
}

/**
 * Premium scroll reveal: blur-and-rise driven by GSAP ScrollTrigger.
 * Initial hidden state lives in CSS (.vz-reveal) to avoid a flash before hydration.
 */
export function Reveal({ children, className, delay = 0, as = "div" }: RevealProps) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      gsap.set(el, { opacity: 1, y: 0, filter: "blur(0px)" })
      el.classList.add("is-visible")
      return
    }

    const tween = gsap.to(el, {
      opacity: 1,
      y: 0,
      filter: "blur(0px)",
      duration: 1,
      delay: delay / 1000,
      ease: "power3.out",
      scrollTrigger: {
        trigger: el,
        start: "top 95%",
        once: true,
      },
    })

    // Fallback: if ScrollTrigger never fires (mobile viewport already past, JS error, etc), force visible after 1.4s
    const fallback = window.setTimeout(() => {
      if (el && getComputedStyle(el).opacity === "0") {
        gsap.set(el, { opacity: 1, y: 0, filter: "blur(0px)" })
        el.classList.add("is-visible")
        tween.scrollTrigger?.kill()
      }
    }, 1400 + delay)

    return () => {
      window.clearTimeout(fallback)
      tween.scrollTrigger?.kill()
      tween.kill()
    }
  }, [delay])

  const Tag = as as React.ElementType

  return (
    <Tag ref={ref} className={cn("vz-reveal", className)}>
      {children}
    </Tag>
  )
}
