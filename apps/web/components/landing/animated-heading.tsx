"use client"

import React, { useEffect, useRef } from "react"
import gsap from "gsap"
import { ScrollTrigger } from "gsap/ScrollTrigger"

gsap.registerPlugin(ScrollTrigger)

interface AnimatedHeadingProps {
  text: string
  className?: string
  as?: "h1" | "h2" | "h3"
}

/**
 * Section heading whose words rise out of clipped lines on scroll -
 * same motion language as the hero headline. Initial state lives in
 * CSS (.vz-word-line / .vz-word) to avoid a pre-hydration flash.
 */
export function AnimatedHeading({ text, className, as = "h2" }: AnimatedHeadingProps) {
  const ref = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const words = el.querySelectorAll(".vz-word") as NodeListOf<HTMLElement>
    if (!words.length) return
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      gsap.set(words, { yPercent: 0 })
      return
    }

    const tween = gsap.fromTo(
      words,
      { yPercent: 110 },
      {
        yPercent: 0,
        duration: 0.9,
        stagger: 0.06,
        ease: "power4.out",
        scrollTrigger: {
          trigger: el,
          start: "top 95%",
          once: true,
        },
      }
    )

    // Fallback: force visible if words still hidden after 1.2s (mobile early viewport)
    const fallback = window.setTimeout(() => {
      const first = words[0]
      if (first && getComputedStyle(first).transform !== "none") {
        const m = new DOMMatrix(getComputedStyle(first).transform)
        // if translateY is still large, force
        if (m.m42 > 10) gsap.set(words, { yPercent: 0 })
      } else if (first) {
        // check opacity via parent line
        gsap.set(words, { yPercent: 0 })
      }
    }, 1200)

    return () => {
      window.clearTimeout(fallback)
      tween.scrollTrigger?.kill()
      tween.kill()
    }
  }, [text])

  const Tag = as as React.ElementType

  return (
    <Tag ref={ref} className={className} aria-label={text}>
      {text.split(" ").map((word, i) => (
        <span key={i} className="vz-word-line" aria-hidden="true">
          <span className="vz-word">{word}&nbsp;</span>
        </span>
      ))}
    </Tag>
  )
}
