"use client"

import { Header } from "@/components/layout/header"
import { Footer } from "@/components/layout/footer"
import { VezignoContact } from "@/components/landing/vezigno-contact"

export default function ContactPage() {
  return (
    <div className="min-h-screen w-full max-w-full overflow-x-hidden bg-white font-poppins">
      <Header />

      {/* Hero */}
      <section className="bg-vez-sky overflow-hidden">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-12 sm:py-20 md:py-28">
          <p className="text-sm sm:text-base text-vez-ink/70">Contact Suchana AI</p>
          <h1 className="mt-3 sm:mt-4 max-w-[16ch] text-3xl sm:text-4xl md:text-5xl lg:text-6xl xl:text-[80px] font-normal leading-[1.12] tracking-[-0.04em] text-vez-ink break-words">
            We&apos;d love to hear from you.
          </h1>
          <p className="mt-4 sm:mt-6 max-w-[52ch] text-sm sm:text-base leading-6 text-vez-ink/80 md:text-lg break-words">
            Questions, feedback, partnership ideas, or an Organization plan enquiry -
            send us a message and we&apos;ll get back within one business day.
          </p>
        </div>
      </section>

      <VezignoContact />

      <Footer />
    </div>
  )
}
