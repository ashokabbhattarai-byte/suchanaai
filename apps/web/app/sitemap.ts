import type { MetadataRoute } from "next"
import { generateSlug } from "@/lib/utils"

// Matches layout.tsx's metadataBase so canonical URLs and sitemap agree.
const siteUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://suchanaai.tech"
const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:5005"

// Google caps one sitemap at 50k URLs; newest notices are what matter.
const MAX_NOTICES = 5000

// Re-generated hourly — notices arrive continuously, but a crawler does not
// need to see them sooner than that.
export const revalidate = 3600

interface SitemapNotice {
  id: string
  title: string
  updatedAt: string | null
  publishedAt: string | null
}

/** Static routes worth indexing. Auth and admin areas are excluded. */
const staticRoutes: MetadataRoute.Sitemap = [
  { url: siteUrl, changeFrequency: "daily", priority: 1 },
  { url: `${siteUrl}/notices`, changeFrequency: "hourly", priority: 0.9 },
  { url: `${siteUrl}/about`, changeFrequency: "monthly", priority: 0.5 },
  { url: `${siteUrl}/pricing`, changeFrequency: "monthly", priority: 0.5 },
  { url: `${siteUrl}/contact`, changeFrequency: "yearly", priority: 0.3 },
  { url: `${siteUrl}/privacy`, changeFrequency: "yearly", priority: 0.3 },
  { url: `${siteUrl}/terms`, changeFrequency: "yearly", priority: 0.3 },
]

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  let notices: SitemapNotice[] = []
  try {
    const res = await fetch(`${apiUrl}/notices/meta/sitemap?limit=${MAX_NOTICES}`, {
      next: { revalidate },
    })
    if (res.ok) notices = await res.json()
  } catch {
    // A sitemap of just the static routes is still valid; failing the build
    // (or the route) because the API is briefly down is not worth it.
  }

  return [
    ...staticRoutes,
    ...notices.map(n => ({
      url: `${siteUrl}/notices/${generateSlug(n.title, n.id)}`,
      lastModified: new Date(n.updatedAt ?? n.publishedAt ?? Date.now()),
      changeFrequency: "weekly" as const,
      priority: 0.7,
    })),
  ]
}
