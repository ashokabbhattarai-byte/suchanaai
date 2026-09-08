"use client"

import React, { useEffect, useRef, useState } from "react"
import Link from "next/link"
import { Check, Sparkles } from "lucide-react"
import gsap from "gsap"
import { ScrollTrigger } from "gsap/ScrollTrigger"
import { Reveal } from "./reveal"
import { AnimatedHeading } from "./animated-heading"
import { Eyebrow, SwapArrow } from "./vezigno-ui"
import { StaggerGrid } from "./motion"
import { cn } from "@/lib/utils"

gsap.registerPlugin(ScrollTrigger)

type Billing = "monthly" | "annual"

const plans = [
  {
    name: "Free",
    tagline: "For every citizen",
    price: { monthly: 0, annual: 0 },
    cta: { label: "Start free", href: "/login" },
    highlight: false,
    features: [
      "Browse all public notices",
      "Keyword & category search",
      "5 AI document questions / day",
      "Weekly email digest",
    ],
  },
  {
    name: "Pro",
    tagline: "For professionals & researchers",
    price: { monthly: 499, annual: 399 },
    cta: { label: "Go Pro", href: "/login" },
    highlight: true,
    features: [
      "Everything in Free",
      "Unlimited AI document questions",
      "Instant smart alerts (keyword, ministry, category)",
      "Upload & query your own documents",
      "Export answers with cited sources",
      "Priority support",
    ],
  },
  {
    name: "Organization",
    tagline: "For agencies, firms & newsrooms",
    price: null,
    cta: { label: "Talk to us", href: "/contact" },
    highlight: false,
    features: [
      "Everything in Pro",
      "API access & webhooks",
      "Unlimited team seats",
      "Dedicated onboarding",
      "SLA & uptime guarantee",
    ],
  },
]

export function VezignoPricing() {
  const [billing, setBilling] = useState<Billing>("monthly")
  const sectionRef = useRef<HTMLElement>(null)
  const firstRender = useRef(true)

  // Check items cascade in per card once the card enters the viewport.
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return
    const ctx = gsap.context(() => {
      gsap.utils.toArray<HTMLElement>(".vz-plan-features").forEach((list) => {
        gsap.fromTo(
          list.children,
          { opacity: 0, x: -14 },
          {
            opacity: 1,
            x: 0,
            duration: 0.5,
            stagger: 0.07,
            ease: "power2.out",
            scrollTrigger: { trigger: list, start: "top 88%", once: true },
          }
        )
      })
    }, sectionRef)
    return () => ctx.revert()
  }, [])

  // Prices flip in when the billing period changes (not on first paint).
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false
      return
    }
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return
    const prices = sectionRef.current?.querySelectorAll(".vz-price")
    if (prices?.length) {
      gsap.fromTo(
        prices,
        { y: 14, opacity: 0 },
        { y: 0, opacity: 1, duration: 0.45, stagger: 0.06, ease: "back.out(1.6)" }
      )
    }
  }, [billing])

  return (
    <section id="pricing" ref={sectionRef} className="bg-white overflow-hidden">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-10 sm:py-16 md:py-20 lg:py-24">
        <div className="flex flex-col gap-4 sm:gap-6 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0">
            <Reveal>
              <Eyebrow>Pricing</Eyebrow>
            </Reveal>
            <AnimatedHeading
              text="Simple plans for every citizen."
              className="mt-3 sm:mt-4 max-w-[18ch] text-2xl sm:text-3xl lg:text-4xl xl:text-5xl font-normal leading-[1.12] tracking-[-0.04em] text-vez-ink"
            />
          </div>
          <Reveal delay={200} className="min-w-0">
            <p className="max-w-sm text-sm sm:text-base leading-6 text-vez-mute">
              Public notices stay free forever. Upgrade when you need unlimited AI
              answers, instant alerts, and team workflows.
            </p>
          </Reveal>
        </div>

        {/* Billing toggle */}
        <Reveal delay={100} className="mt-8 sm:mt-10 flex justify-center px-4">
          <div className="flex items-center gap-1 rounded-full border border-vez-line bg-vez-surface p-1">
            {(["monthly", "annual"] as Billing[]).map((b) => (
              <button
                key={b}
                onClick={() => setBilling(b)}
                className={cn(
                  "rounded-full px-4 sm:px-5 py-2 text-xs sm:text-sm capitalize transition-all",
                  billing === b
                    ? "bg-vez-navy text-white shadow-sm"
                    : "text-vez-mute hover:text-vez-ink"
                )}
              >
                {b}
                {b === "annual" && (
                  <span className={cn("ml-1 sm:ml-1.5 text-[10px] sm:text-xs", billing === b ? "text-white/70" : "text-vez-navy")}>
                    −20%
                  </span>
                )}
              </button>
            ))}
          </div>
        </Reveal>

        {/* Plan cards — 1 col on phone (375), 3 col from md to avoid 2+1 awkward at 768-1023, consistent gap */}
        <StaggerGrid amount={0.5} className="mt-8 sm:mt-10 grid w-full min-w-0 gap-4 sm:gap-5 lg:gap-6 grid-cols-1 md:grid-cols-3">
          {plans.map((plan) => (
            <div key={plan.name} className="flex min-w-0">
              <article
                className={cn(
                  "flex w-full min-w-0 flex-col rounded-2xl sm:rounded-3xl p-5 sm:p-7 lg:p-8 min-h-[360px] sm:min-h-[440px]",
                  plan.highlight
                    ? "relative bg-vez-navy text-white shadow-xl lg:-my-3"
                    : "border border-vez-line bg-vez-surface text-vez-ink"
                )}
              >
                {plan.highlight && (
                  <span className="absolute -top-3.5 left-1/2 flex -translate-x-1/2 items-center gap-1.5 whitespace-nowrap rounded-full bg-vez-sky px-4 py-1.5 text-xs font-medium uppercase tracking-[0.12em] text-vez-ink">
                    <Sparkles className="size-3.5" /> Most popular
                  </span>
                )}

                <h3 className="text-lg sm:text-xl font-medium break-words">{plan.name}</h3>
                <p className={cn("mt-1 text-xs sm:text-sm", plan.highlight ? "text-white/60" : "text-vez-mute")}>
                  {plan.tagline}
                </p>

                <div className="vz-price mt-5 sm:mt-6 flex flex-wrap items-baseline gap-1.5 sm:gap-2 min-w-0">
                  {plan.price ? (
                    <>
                      <span className="text-3xl sm:text-4xl lg:text-[44px] font-normal tracking-[-0.03em] break-words">
                        {plan.price[billing] === 0 ? "NPR 0" : `NPR ${plan.price[billing]}`}
                      </span>
                      <span className={cn("text-xs sm:text-sm", plan.highlight ? "text-white/60" : "text-vez-mute")}>
                        {plan.price[billing] === 0 ? "forever" : "/month"}
                      </span>
                    </>
                  ) : (
                    <span className="text-3xl sm:text-4xl lg:text-[44px] font-normal tracking-[-0.03em]">Custom</span>
                  )}
                </div>
                {plan.highlight && billing === "annual" && (
                  <p className="mt-1 text-xs text-white/60">billed annually · 2 months free</p>
                )}

                <ul className="vz-plan-features mt-7 flex flex-col gap-3">
                  {plan.features.map((f) => (
                    <li key={f} className="flex items-start gap-2.5 text-[15px] leading-snug">
                      <Check
                        className={cn(
                          "mt-0.5 size-4 shrink-0",
                          plan.highlight ? "text-vez-sky" : "text-vez-navy"
                        )}
                      />
                      <span className={plan.highlight ? "text-white/85" : "text-vez-ink/85"}>{f}</span>
                    </li>
                  ))}
                </ul>

                <Link
                  href={plan.cta.href}
                  className={cn(
                    "group mt-6 sm:mt-8 flex items-center justify-center gap-2 rounded-full px-4 sm:px-6 py-2.5 sm:py-3 text-sm sm:text-base transition-all duration-300 min-w-0",
                    plan.highlight
                      ? "bg-white text-vez-ink hover:bg-vez-sky"
                      : "bg-vez-navy text-white hover:opacity-90"
                  )}
                >
                  <span className="truncate">{plan.cta.label}</span>
                  <SwapArrow />
                </Link>
              </article>
            </div>
          ))}
        </StaggerGrid>

        <Reveal delay={200}>
          <p className="mt-10 text-center text-sm text-vez-mute">
            Prices in Nepalese Rupees. Cancel anytime - no hidden fees, no lock-in.
          </p>
        </Reveal>
      </div>
    </section>
  )
}
