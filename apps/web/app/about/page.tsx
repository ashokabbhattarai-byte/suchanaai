"use client"

import { Header } from "@/components/layout/header"
import { Footer } from "@/components/layout/footer"
import { Shield, Globe, Zap, Users, Database, Lock } from "lucide-react"

export default function AboutPage() {
  const features = [
    { icon: Shield, title: "Verified & authentic", description: "All notices are sourced directly from official government channels and verified before publication." },
    { icon: Globe, title: "Multilingual support", description: "Available in English and Nepali, with plans to support additional local languages." },
    { icon: Zap, title: "Real-time updates", description: "Automated scraping ensures the latest notices are available within minutes of publication." },
    { icon: Users, title: "500+ institutions", description: "Aggregating notices from ministries, commissions, departments, and local bodies across Nepal." },
    { icon: Database, title: "AI-powered search", description: "RAG-powered document intelligence for natural language queries across all government documents." },
    { icon: Lock, title: "Secure & reliable", description: "Enterprise-grade security with 99.9% uptime and data integrity guarantees." },
  ]

  const steps = [
    { title: "Browse or search", text: "Use the search bar or category filters to find relevant notices." },
    { title: "Create an account", text: "Sign up to save notices, set up alerts, and access personalized features." },
    { title: "Set up alerts", text: "Configure keyword, category, or organization-based alerts to get notified instantly." },
    { title: "Use document search", text: "Ask questions about government policies using our AI-powered document search." },
  ]

  return (
    <div className="min-h-screen w-full max-w-full overflow-x-hidden bg-white font-poppins">
      <Header />

      {/* Hero */}
      <section className="bg-vez-sky overflow-hidden">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-12 sm:py-20 md:py-28">
          <p className="text-sm sm:text-base text-vez-ink/70">About Suchana AI</p>
          <h1 className="mt-3 sm:mt-4 max-w-[16ch] text-3xl sm:text-4xl md:text-5xl lg:text-6xl xl:text-[80px] font-normal leading-[1.12] tracking-[-0.04em] text-vez-ink break-words">
            Nepal&apos;s public notice repository.
          </h1>
          <p className="mt-4 sm:mt-6 max-w-[52ch] text-sm sm:text-base leading-6 text-vez-ink/80 md:text-lg break-words">
            A centralized platform making government communication transparent, accessible,
            and searchable for all citizens of Nepal.
          </p>
        </div>
      </section>

      {/* Mission */}
      <section className="bg-white overflow-hidden">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-10 sm:py-16 md:py-20">
          <div className="grid gap-6 sm:gap-10 grid-cols-1 lg:grid-cols-[0.8fr_1.2fr]">
            <h2 className="text-2xl sm:text-3xl lg:text-4xl xl:text-5xl font-normal leading-[1.15] tracking-[-0.03em] text-vez-ink break-words">
              Our mission.
            </h2>
            <div className="space-y-4 sm:space-y-5 text-sm sm:text-base leading-6 sm:leading-7 text-vez-mute min-w-0">
              <p className="break-words">
                Suchana AI was created to bridge the gap between government institutions and citizens.
                In a country where important notices are scattered across hundreds of websites, notice boards,
                and newspapers, finding relevant information has always been a challenge.
              </p>
              <p className="break-words">
                Our platform aggregates, verifies, and organizes public notices from across all levels of
                government - making it possible for citizens to search, filter, and receive alerts for
                notices that matter to them.
              </p>
              <p className="break-words">
                Whether you&apos;re a job seeker looking for vacancy announcements, a contractor tracking
                tenders, or a student preparing for competitive exams, Suchana AI ensures you never miss
                an important update.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="bg-vez-surface overflow-hidden">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-10 sm:py-16 md:py-20">
          <h2 className="max-w-[18ch] text-2xl sm:text-3xl lg:text-4xl xl:text-5xl font-normal leading-[1.15] tracking-[-0.03em] text-vez-ink break-words">
            Built for trust, speed, and reach.
          </h2>
          <div className="mt-8 sm:mt-12 grid grid-cols-1 gap-4 sm:gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {features.map((feature) => {
              const Icon = feature.icon
              return (
                <div
                  key={feature.title}
                  className="rounded-xl sm:rounded-[20px] bg-white p-4 sm:p-6 lg:p-8 transition-transform duration-300 hover:-translate-y-1 min-w-0"
                >
                  <div className="flex size-10 sm:size-12 items-center justify-center rounded-full bg-vez-sky/40 shrink-0">
                    <Icon className="size-4 sm:size-5 text-vez-navy" />
                  </div>
                  <h3 className="mt-4 sm:mt-5 text-base sm:text-lg text-vez-ink break-words">{feature.title}</h3>
                  <p className="mt-1.5 sm:mt-2 text-sm sm:text-base leading-6 text-vez-mute break-words">{feature.description}</p>
                </div>
              )
            })}
          </div>
        </div>
      </section>

      {/* How to use */}
      <section className="bg-white overflow-hidden">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-10 sm:py-16 md:py-20">
          <h2 className="max-w-[16ch] text-2xl sm:text-3xl lg:text-4xl xl:text-5xl font-normal leading-[1.15] tracking-[-0.03em] text-vez-ink break-words">
            How to use.
          </h2>
          <div className="mt-8 sm:mt-12 grid grid-cols-1 gap-4 sm:gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {steps.map((step, i) => (
              <div key={step.title} className="border-t border-vez-line pt-4 sm:pt-6 min-w-0">
                <p className="text-xs sm:text-sm text-vez-mute">0{i + 1}</p>
                <h3 className="mt-1.5 sm:mt-2 text-base sm:text-lg text-vez-ink break-words">{step.title}</h3>
                <p className="mt-1.5 sm:mt-2 text-sm sm:text-base leading-6 text-vez-mute break-words">{step.text}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Contact strip */}
      <section className="bg-vez-surface overflow-hidden">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-10 sm:py-16 text-center">
          <h3 className="text-xl sm:text-2xl font-normal tracking-[-0.02em] text-vez-ink">Contact</h3>
          <p className="mt-2 sm:mt-3 text-sm sm:text-base text-vez-mute break-words">
            For inquiries, contact us at{" "}
            <a href="mailto:info@suchana.ai" className="text-vez-navy hover:underline break-all">info@suchana.ai</a>
          </p>
        </div>
      </section>

      <Footer />
    </div>
  )
}
