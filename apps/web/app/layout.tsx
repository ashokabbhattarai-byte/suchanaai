import type { Metadata, Viewport } from "next"
import { Inter, Poppins } from "next/font/google"
import "./globals.css"
import { ThemeProvider } from "@/components/theme-provider"
import { Toaster } from "@/components/ui/sonner"
import { Providers } from "./providers"

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#101d23" },
  ],
}

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" })
const poppins = Poppins({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-poppins" })

/**
 * Absolute URLs are required for OG/Twitter images — a relative path renders
 * as a broken preview on every social and chat client. Falls back to the
 * production domain so a missing env var can't silently break link previews.
 */
const siteUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://suchanaai.tech"

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: "Suchana AI - Nepal's AI-Powered Public Notice Platform",
  description:
    "Suchana AI aggregates public notices across Nepal's government portals into one searchable platform. AI-powered OCR, NLP classification, and RAG document intelligence - built for every Nepali citizen.",
  keywords: [
    "Nepal government notices",
    "public notice management",
    "PSC notices",
    "Nepal tenders",
    "job vacancies Nepal",
    "AI document search",
    "RAG Nepal",
    "e-governance Nepal",
  ],
  openGraph: {
    title: "Suchana AI - Nepal's AI-Powered Public Notice Platform",
    description:
      "One centralized repository for every government notice across Nepal - searched, classified, and summarized by AI.",
    type: "website",
    siteName: "Suchana AI",
    url: siteUrl,
    images: [
      { url: "/og/og-image.png", width: 1200, height: 630, alt: "Suchana AI - Nepal's public notice platform" },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Suchana AI - Nepal's AI-Powered Public Notice Platform",
    description:
      "One centralized repository for every government notice across Nepal - searched, classified, and summarized by AI.",
    images: ["/og/og-image.png"],
  },
  // app/favicon.ico, app/icon.png and app/apple-icon.png are picked up by the
  // App Router automatically; these entries pin the sizes browsers should
  // prefer (32px for the tab, 512px for install prompts) and add the
  // manifest, all generated from public/images/logo.png by
  // scripts/generate-brand-assets.py.
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/icon.png", type: "image/png", sizes: "512x512" },
    ],
    apple: [{ url: "/apple-icon.png", sizes: "180x180", type: "image/png" }],
  },
  manifest: "/site.webmanifest",
  applicationName: "Suchana AI",
  appleWebApp: { capable: true, title: "Suchana AI", statusBarStyle: "default" },
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" suppressHydrationWarning className="overflow-x-hidden">
      <body className={`${inter.variable} ${poppins.variable} font-sans font-poppins antialiased overflow-x-hidden w-full max-w-[100vw] text-[16px] sm:text-[16px] leading-[1.5] tracking-tight [text-size-adjust:100%]`}>
        <ThemeProvider attribute="class" defaultTheme="dark" enableSystem disableTransitionOnChange>
          <Providers>
            <div className="min-w-0 w-full max-w-[100vw] overflow-x-clip">
              {children}
            </div>
          </Providers>
          <Toaster position="top-right" richColors closeButton />
        </ThemeProvider>
      </body>
    </html>
  )
}
