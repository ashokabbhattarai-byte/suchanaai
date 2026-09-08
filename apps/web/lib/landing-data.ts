// Server-only loader for the landing page. Fetches the public notice feed,
// category counts and source roster once per request (cached on the edge via
// Next.js fetch revalidation) and flattens them into serializable props for
// the client sections. Returns null on failure so sections can fall back to
// their static defaults instead of breaking the page.
import type { ScrapedItem, PublicNoticeSource } from "./types"

export interface LandingData {
  latest: ScrapedItem[]
  totalNotices: number
  categoryCounts: Record<string, number>
  sources: PublicNoticeSource[]
  sourceCount: number
}

// `||` not `??` — see the identical comment in lib/api.ts.
const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:5005"

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`Request failed: ${res.status}`)
  return res.json() as Promise<T>
}

export async function getLandingData(limit = 6): Promise<LandingData | null> {
  try {
    const results = await Promise.allSettled([
      fetch(`${API_URL}/notices?page=1&limit=${limit}&sortBy=publishedAt&sortOrder=desc`, {
        next: { revalidate: 60 },
      }),
      fetch(`${API_URL}/notices/meta/category-counts`, { next: { revalidate: 60 } }),
      fetch(`${API_URL}/notices/meta/sources`, { next: { revalidate: 60 } }),
    ])

    const [noticesRes, countsRes, sourcesRes] = results

    let notices: { data: ScrapedItem[]; meta: { total: number } } | null = null
    let categoryCounts: Record<string, number> = {}
    let sources: PublicNoticeSource[] = []

    if (noticesRes.status === "fulfilled" && noticesRes.value.ok) {
      try {
        notices = await json<{ data: ScrapedItem[]; meta: { total: number } }>(noticesRes.value)
      } catch {
        // leave notices as null — partial success still renders other sections
      }
    }
    if (countsRes.status === "fulfilled" && countsRes.value.ok) {
      try {
        categoryCounts = await json<Record<string, number>>(countsRes.value)
      } catch {}
    }
    if (sourcesRes.status === "fulfilled" && sourcesRes.value.ok) {
      try {
        sources = await json<PublicNoticeSource[]>(sourcesRes.value)
      } catch {}
    }

    // If all three failed (backend unreachable), let caller fall back to static defaults
    if (!notices && Object.keys(categoryCounts).length === 0 && sources.length === 0) {
      return null
    }

    return {
      latest: notices?.data ?? [],
      totalNotices: notices?.meta.total ?? 0,
      categoryCounts,
      sources,
      sourceCount: sources.length,
    }
  } catch {
    // API unreachable (dev before backend boot, deployment hiccup) - sections
    // keep their static defaults, the landing page still renders.
    return null
  }
}