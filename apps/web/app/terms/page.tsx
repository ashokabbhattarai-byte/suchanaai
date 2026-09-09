import Link from "next/link"
import { ArrowLeft } from "lucide-react"

export const metadata = {
  title: "Terms and Conditions — Suchana AI",
  description:
    "Terms and Conditions for using Suchana AI — Nepal's AI-powered public notice platform.",
}

export default function TermsPage() {
  return (
    <div className="min-h-screen bg-white font-poppins antialiased">
      <div className="mx-auto max-w-3xl px-6 py-16 sm:px-12">
        <Link
          href="/"
          className="mb-10 flex w-fit items-center gap-2 text-base text-vez-mute transition-colors hover:text-vez-ink"
        >
          <ArrowLeft className="size-4" />
          Back
        </Link>

        <h1 className="text-[clamp(32px,4vw,44px)] font-normal leading-[1.15] tracking-[-0.04em] text-vez-ink">
          Terms and Conditions
        </h1>
        <p className="mt-3 text-sm text-vez-mute">Last updated: September 9, 2026</p>

        <div className="mt-10 flex flex-col gap-8 text-base leading-7 text-vez-ink/80">
          <section>
            <h2 className="mb-3 text-lg font-medium text-vez-ink">1. Agreement to Terms</h2>
            <p>
              These Terms and Conditions (&quot;Terms&quot;) govern your access to and use of
              Suchana AI (&quot;we&quot;, &quot;our&quot;, &quot;us&quot;, &quot;Platform&quot;),
              available at suchanaai.tech, including our website, alert service, document
              search and AI-assisted summaries. By creating an account, signing in with Google,
              or otherwise using the Platform, you agree to be bound by these Terms and our{" "}
              <Link href="/privacy" className="text-vez-navy underline underline-offset-2">
                Privacy Policy
              </Link>
              . If you do not agree, do not use the Platform.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-lg font-medium text-vez-ink">2. Description of Service</h2>
            <p>
              Suchana AI aggregates public government notices published by ministries,
              departments and public bodies in Nepal. We crawl official sources, classify
              notices, generate AI summaries/translations, and let you search, save and receive
              alerts. The Platform is an independent aggregator — we are{" "}
              <strong>not affiliated with, endorsed by, or acting on behalf of</strong> any
              government entity.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-lg font-medium text-vez-ink">3. Accounts and Authentication</h2>
            <ul className="list-disc space-y-2 pl-5">
              <li>
                Sign-in is via Google OAuth. You must provide accurate information and keep
                your Google account secure.
              </li>
              <li>You are responsible for all activity under your account.</li>
              <li>
                We may suspend or terminate accounts that violate these Terms or are inactive
                for an extended period.
              </li>
              <li>
                Admin accounts have additional responsibilities; misuse of admin tooling
                (scraping controls, user management) is grounds for immediate termination.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="mb-3 text-lg font-medium text-vez-ink">4. Acceptable Use</h2>
            <p className="mb-2">You agree not to:</p>
            <ul className="list-disc space-y-2 pl-5">
              <li>
                Use the Platform for any unlawful purpose or in violation of Nepalese law.
              </li>
              <li>
                Attempt to scrape, crawl, or exceed rate limits beyond the public interfaces we
                provide (our own notice ingestion is rate-limited and respects source robots).
              </li>
              <li>
                Probe, scan, or test the vulnerability of the Platform, or circumvent
                authentication, paywalls, or alert quotas.
              </li>
              <li>
                Upload malware, spam, or content that infringes intellectual property, privacy,
                or other rights.
              </li>
              <li>Impersonate any person or entity or misrepresent affiliation.</li>
            </ul>
          </section>

          <section>
            <h2 className="mb-3 text-lg font-medium text-vez-ink">5. Intellectual Property</h2>
            <p>
              Original government notices remain the property of their respective publishers and
              are reproduced for public information. Our aggregation, categorisation,
              AI summaries, translations, search index and UI are owned by Suchana AI. You are
              granted a non-exclusive, non-transferable licence to access and use the Platform
              for personal, non-commercial purposes. You may quote or share notice excerpts with
              attribution and a link to the source.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-lg font-medium text-vez-ink">
              6. AI-Generated Content Disclaimer
            </h2>
            <p>
              Summaries, classifications, translations and answers generated via our AI / RAG
              features are provided on a best-effort basis and may be incomplete, outdated, or
              inaccurate. They are{" "}
              <strong>not legal, financial, or professional advice</strong>. Always verify
              critical information (deadlines, eligibility, fees) against the original notice
              PDF or the issuing authority&apos;s website before acting on it.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-lg font-medium text-vez-ink">7. Third-Party Sources and Links</h2>
            <p>
              Notices are sourced from third-party government websites. We do not control those
              sites and do not guarantee availability, accuracy, or timeliness. Links to
              external sites are provided for reference only and do not imply endorsement.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-lg font-medium text-vez-ink">8. User Content</h2>
            <p>
              You retain rights to content you create (saved notices, alert rules, search
              queries). You grant us a licence to store and process it to provide the service
              (e.g., to run your alerts). You are solely responsible for your alert criteria
              and for ensuring your use complies with applicable law.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-lg font-medium text-vez-ink">9. Plans, Billing and Payments</h2>
            <ul className="list-disc space-y-2 pl-5">
              <li>
                Certain features (e.g., higher alert limits, advanced document search) may
                require a paid plan.
              </li>
              <li>Payments are processed securely by Stripe. We do not store card details.</li>
              <li>
                Fees are billed in advance and are non-refundable except where required by law
                or as stated at purchase. You may cancel at any time; access continues until the
                end of the billing period.
              </li>
              <li>We may change pricing with at least 30 days&apos; notice.</li>
            </ul>
          </section>

          <section>
            <h2 className="mb-3 text-lg font-medium text-vez-ink">10. Privacy</h2>
            <p>
              Your use of the Platform is also governed by our Privacy Policy, which explains
              what data we collect (Google profile, usage analytics, saved preferences), how we
              use it, and your rights. Please review it at{" "}
              <Link href="/privacy" className="text-vez-navy underline underline-offset-2">
                /privacy
              </Link>
              .
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-lg font-medium text-vez-ink">11. Disclaimer of Warranties</h2>
            <p>
              The Platform is provided &quot;as is&quot; and &quot;as available&quot; without
              warranties of any kind, express or implied, including merchantability, fitness for
              a particular purpose, and non-infringement. We do not warrant that the service
              will be uninterrupted, error-free, or that all notices will be captured.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-lg font-medium text-vez-ink">12. Limitation of Liability</h2>
            <p>
              To the maximum extent permitted by law, Suchana AI and its contributors shall not
              be liable for any indirect, incidental, consequential, or punitive damages, or
              loss of profits, data, or opportunities arising from your use of the Platform or
              reliance on any notice or AI summary, even if advised of the possibility. Our
              total liability for any claim shall not exceed the amount you paid us in the 12
              months preceding the claim, or NPR 5,000 if you have not made any payment.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-lg font-medium text-vez-ink">13. Indemnification</h2>
            <p>
              You agree to indemnify and hold harmless Suchana AI, its operators and
              contributors from any claims, damages, or expenses arising from your violation of
              these Terms or misuse of the Platform.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-lg font-medium text-vez-ink">14. Suspension and Termination</h2>
            <p>
              We may suspend or terminate your access immediately if you violate these Terms,
              abuse the service, or if required by law. You may delete your account at any time
              via Settings or by contacting us. Upon termination, your right to use the Platform
              ceases; provisions that by nature should survive (IP, disclaimers, liability
              limits) will survive.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-lg font-medium text-vez-ink">15. Governing Law</h2>
            <p>
              These Terms are governed by the laws of Nepal. Any dispute arising from or
              relating to the Platform shall be subject to the jurisdiction of the courts of
              Kathmandu, Nepal. If you are a consumer, you may also benefit from mandatory
              protections in your country of residence.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-lg font-medium text-vez-ink">16. Changes to These Terms</h2>
            <p>
              We may update these Terms from time to time to reflect product, legal, or
              regulatory changes. We will post the revised version on this page with an updated
              &quot;Last updated&quot; date and, for material changes, provide notice in-app or
              by email. Continued use after the effective date constitutes acceptance.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-lg font-medium text-vez-ink">17. Contact</h2>
            <p>
              Questions about these Terms? Contact us at{" "}
              <a
                href="mailto:ashok.ab.bhattaraii@gmail.com"
                className="text-vez-navy underline underline-offset-2"
              >
                ashok.ab.bhattaraii@gmail.com
              </a>{" "}
              or via our{" "}
              <Link href="/contact" className="text-vez-navy underline underline-offset-2">
                contact page
              </Link>
              .
            </p>
          </section>

          <div className="rounded-[16px] bg-vez-surface px-5 py-4 text-sm text-vez-mute">
            <p>
              This document was last reviewed on September 9, 2026. For the Privacy Policy, see{" "}
              <Link href="/privacy" className="text-vez-navy underline underline-offset-2">
                Privacy Policy
              </Link>
              .
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
