import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

/**
 * Merge Tailwind classes with responsive & design-system awareness.
 * Uses clsx + tailwind-merge to deduplicate conflicting utilities,
 * correctly handling responsive prefixes (sm:, md:, lg:, xl:) and
 * breakpoint-specific overrides (sm:640, md:768, lg:1024, xl:1280).
 *
 * Spacing scale: gap-3 sm:gap-4 lg:gap-6, p-4 sm:p-6 lg:p-8
 * Typography: font-poppins, tracking-tight, leading-tight/relaxed
 * Cards: rounded-xl sm:rounded-2xl border border-vez-line shadow-sm
 * Touch targets: min-h-[44px] min-w-[44px] on mobile
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// Notice detail URLs: readable title slug + the uuid the route reads back
// via slug.slice(-36). Canonical here because sitemap.xml and every link
// must agree — a drifted copy silently publishes 404s to search engines.
// Devanagari is kept: stripping it left every Nepali notice at a bare
// "-<uuid>" URL, which is most of this corpus.
export function generateSlug(title: string, id: string): string {
  const slug = (title ?? "")
    .toLowerCase()
    // Full Devanagari block including U+0900-U+0903 combining marks, without
    // which "संविधान" splits into "स-विधान".
    // eslint-disable-next-line no-misleading-character-class
    .replace(/[^a-z0-9ऀ-ॿ]+/g, "-")
    .replace(/(^-|-$)/g, "")
  return slug ? `${slug}-${id}` : id
}
