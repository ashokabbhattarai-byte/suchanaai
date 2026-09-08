"use client"

import React, { useEffect, useRef } from "react"
import { Search, TrendingUp, FileText, Bell, Sparkles, ArrowRight, BookOpen, Shield, Zap, Eye, Clock, Newspaper, ChevronRight, CheckCircle, Building2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import { CpuArchitecture } from "@/components/ui/cpu-architecture"
import { Header } from "@/components/layout/header"
import { Footer } from "@/components/layout/footer"
import { mockNotices } from "@/lib/mock-data"
import Link from "next/link"
import gsap from "gsap"
import { FeaturesSection } from "@/components/features-section"
import { AlertCTASection } from "@/components/alert-cta-section"
import { AnimatedHeroSections } from "@/components/animated-hero-sections"

export default function DemoPage() {
  const newsDashboardRef = useRef<HTMLDivElement>(null)
  const newsItemsRef = useRef<HTMLDivElement>(null)
  const metricsRef = useRef<HTMLDivElement>(null)

  const features = [
    { icon: Search, title: "Smart Search", description: "AI-powered search across all government notices with natural language queries." },
    { icon: Shield, title: "Verified Sources", description: "Every notice authenticated and verified from official government channels." },
    { icon: Zap, title: "Real-time Alerts", description: "Custom notifications for keywords, categories, and organizations you follow." },
    { icon: BookOpen, title: "Document Intelligence", description: "RAG-powered Q&A system for querying government policies and documents." },
  ]

  const metrics = [
    { value: "2.5M+", label: "Documents" },
    { value: "500+", label: "Institutions" },
    { value: "99.9%", label: "Verified" },
  ]

  const recentNotices = mockNotices.slice(0, 5)

  useEffect(() => {
    if (!newsDashboardRef.current || !newsItemsRef.current) return

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            const items = newsItemsRef.current?.children
            if (!items) return

            gsap.fromTo(
              newsDashboardRef.current,
              { opacity: 0, y: 40 },
              { opacity: 1, y: 0, duration: 0.8, ease: "power3.out" }
            )

            gsap.fromTo(
              Array.from(items),
              { opacity: 0, x: -30, scale: 0.98 },
              {
                opacity: 1,
                x: 0,
                scale: 1,
                duration: 0.6,
                stagger: 0.12,
                ease: "power2.out",
                delay: 0.3,
              }
            )

            observer.disconnect()
          }
        })
      },
      { threshold: 0.2 }
    )

    observer.observe(newsDashboardRef.current)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!metricsRef.current) return
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            const children = metricsRef.current?.children
            if (children) {
              gsap.fromTo(
                Array.from(children),
                { opacity: 0, y: 40, scale: 0.9 },
                {
                  opacity: 1,
                  y: 0,
                  scale: 1,
                  duration: 0.7,
                  stagger: 0.15,
                  ease: "back.out(1.4)",
                }
              )
            }
            observer.disconnect()
          }
        })
      },
      { threshold: 0.3 }
    )
    observer.observe(metricsRef.current)
    return () => observer.disconnect()
  }, [])

  return (
    <div className="min-h-screen w-full bg-background relative">
      {/* Fixed Header */}
      <div className="fixed top-0 left-0 right-0 z-[100]">
        <Header />
      </div>

      {/* Animated Hero Sections - full screen, GSAP Observer */}
      <AnimatedHeroSections />

      {/* Rest of page content - scrolls normally after hero */}
      <div className="relative z-10">
        {/* Metrics */}
        <section className="py-20 px-4">
          <div
            ref={metricsRef}
            className="grid grid-cols-3 gap-3 sm:gap-4 max-w-3xl mx-auto px-4 sm:px-0"
          >
            {metrics.map((metric, index) => (
              <div
                key={index}
                className="relative bg-card/60 backdrop-blur-xl rounded-xl p-5 shadow-lg border border-border/50 overflow-hidden group cursor-pointer opacity-0"
              >
                <div className="absolute inset-0 bg-primary/5 opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
                <div className="relative text-center">
                  <div className="text-3xl md:text-4xl font-bold text-foreground text-primary mb-1 group-hover:scale-105 transition-transform duration-300">
                    {metric.value}
                  </div>
                  <div className="text-sm font-medium text-muted-foreground">
                    {metric.label}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* News Dashboard Section */}
        <section className="py-24 px-4">
          <div ref={newsDashboardRef} className="max-w-5xl mx-auto opacity-0">
            <Card className="overflow-hidden border-border/60 shadow-xl bg-card/80 backdrop-blur-xl">
              <div className="flex items-center justify-between px-6 py-5 border-b border-border bg-card">
                <div className="flex items-center gap-3">
                  <div className="size-10 rounded-lg bg-primary flex items-center justify-center">
                    <Newspaper className="size-5 text-primary-foreground" />
                  </div>
                  <div>
                    <h2 className="text-lg font-bold">Latest Notices</h2>
                    <p className="text-xs text-muted-foreground">Live updates from government sources</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="gap-1 text-xs">
                    <span className="size-2 rounded-full bg-green-500 animate-pulse" />
                    Live
                  </Badge>
                  <Badge variant="secondary" className="text-xs">{mockNotices.length} total</Badge>
                </div>
              </div>

              <div ref={newsItemsRef} className="divide-y divide-border">
                {recentNotices.map((notice, i) => (
                  <Link key={notice.id} href="/notices" className="block">
                    <div className="group flex items-center gap-4 px-6 py-4 hover:bg-accent/40 transition-all duration-200 cursor-pointer">
                      <div className="size-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0 group-hover:bg-primary/20 transition-colors">
                        <span className="text-xs font-bold text-primary">{String(i + 1).padStart(2, "0")}</span>
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <Badge
                            variant={notice.priority === "high" ? "default" : "secondary"}
                            className="text-[10px] px-1.5 py-0"
                          >
                            {notice.category}
                          </Badge>
                          {notice.priority === "high" && (
                            <Badge variant="destructive" className="text-[10px] px-1.5 py-0">Urgent</Badge>
                          )}
                          <span className="text-[10px] text-muted-foreground">{notice.organization}</span>
                        </div>
                        <h3 className="text-sm font-medium truncate group-hover:text-primary transition-colors">
                          {notice.title}
                        </h3>
                        <p className="text-xs text-muted-foreground truncate mt-0.5">{notice.description}</p>
                      </div>
                      <div className="hidden sm:flex flex-col items-end gap-1 shrink-0">
                        <span className="flex items-center gap-1 text-xs text-muted-foreground">
                          <Eye className="size-3" />
                          {notice.views.toLocaleString()}
                        </span>
                        <span className="flex items-center gap-1 text-xs text-muted-foreground">
                          <Clock className="size-3" />
                          {new Date(notice.publishedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                        </span>
                      </div>
                      <ChevronRight className="size-4 text-muted-foreground group-hover:text-primary group-hover:translate-x-1 transition-all shrink-0" />
                    </div>
                  </Link>
                ))}
              </div>

              <div className="px-6 py-4 border-t border-border bg-muted/20">
                <Link href="/notices">
                  <Button className="w-full gap-2 h-11">
                    <Newspaper className="size-4" />
                    View All Notices
                    <ArrowRight className="size-4" />
                  </Button>
                </Link>
              </div>
            </Card>
          </div>
        </section>

        {/* Features Section */}
        <FeaturesSection features={features} />

        {/* AI Intelligence Section */}
        <section className="py-24 px-4 relative overflow-hidden">
          <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(59,130,246,0.06),transparent_70%)]" />
          <div className="max-w-5xl mx-auto">
            <div className="rounded-3xl bg-gradient-to-b from-accent/40 to-accent/10 border border-border/60 p-10 md:p-14 relative overflow-hidden shadow-2xl shadow-primary/5">
              <div className="absolute -top-24 -right-24 size-64 rounded-full bg-primary/8 blur-3xl" />
              <div className="absolute -bottom-20 -left-20 size-48 rounded-full bg-blue-500/6 blur-3xl" />
              <div className="absolute inset-0 opacity-80">
                <CpuArchitecture />
              </div>
              <div className="relative z-10 text-center py-10 md:py-14">
                <div className="inline-flex items-center gap-2 bg-primary/10 border border-primary/20 rounded-full px-4 py-1.5 mb-6">
                  <Sparkles className="size-3.5 text-primary" />
                  <span className="text-xs font-medium text-primary">AI-Powered Engine</span>
                </div>
                <h3 className="text-3xl md:text-4xl lg:text-5xl font-bold text-foreground mb-5 bg-gradient-to-r from-foreground via-foreground to-foreground/70 bg-clip-text text-transparent">
                  Powered by AI Intelligence
                </h3>
                <p className="text-muted-foreground text-base md:text-lg max-w-2xl mx-auto mb-8 leading-relaxed">
                  Our RAG-powered document intelligence system processes millions of government documents for instant, accurate answers.
                </p>
                <div className="flex flex-wrap items-center justify-center gap-3 mb-8">
                  <span className="flex items-center gap-1.5 bg-accent/60 border border-border/50 rounded-full px-3.5 py-1.5 text-xs font-medium text-muted-foreground">
                    <Zap className="size-3 text-yellow-500" /> Instant Answers
                  </span>
                  <span className="flex items-center gap-1.5 bg-accent/60 border border-border/50 rounded-full px-3.5 py-1.5 text-xs font-medium text-muted-foreground">
                    <Shield className="size-3 text-indigo-500" /> Verified Sources
                  </span>
                  <span className="flex items-center gap-1.5 bg-accent/60 border border-border/50 rounded-full px-3.5 py-1.5 text-xs font-medium text-muted-foreground">
                    <FileText className="size-3 text-blue-500" /> 2.5M+ Documents
                  </span>
                </div>
                <Link href="/documents">
                  <Button size="lg" className="gap-2 h-12 px-8 text-base shadow-lg shadow-primary/20">
                    Try Document Search <ArrowRight className="size-4" />
                  </Button>
                </Link>
              </div>
            </div>
          </div>
        </section>

        {/* Alert CTA Section */}
        <AlertCTASection />

        <Footer />
      </div>
    </div>
  )
}
