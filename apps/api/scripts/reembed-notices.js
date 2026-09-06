// Re-embed every notice into the vector store, now that the body is indexed
// alongside the AI summary.
//
// Two things made the corpus much less answerable than it looked:
//   1. embedNewNotices only embedded notices that had an aiSummary, leaving
//      about half the catalogue out of the vector store entirely;
//   2. the vector and its payload were built from title + summary only, so a
//      notice with no summary was a title and nothing else.
// This backfills both. Safe to re-run — upserts are keyed by notice id.
//
// Usage:
//   node scripts/reembed-notices.js            # dry run — reports scope only
//   node scripts/reembed-notices.js --apply    # embed
//   node scripts/reembed-notices.js --apply --batch 100
const { PrismaClient } = require('@prisma/client')

const prisma = new PrismaClient()
const apply = process.argv.includes('--apply')
const batchArg = process.argv.indexOf('--batch')
const BATCH = batchArg !== -1 ? Number(process.argv[batchArg + 1]) : 50
const AI_URL = process.env.AI_SERVICE_URL || 'http://localhost:8000'
const SECRET = process.env.INTERNAL_SERVICE_SECRET || ''
const CONTENT_CHARS = 4000

async function main() {
  const where = {
    OR: [{ aiSummary: { not: null } }, { contentText: { not: null } }],
  }
  const total = await prisma.scrapedItem.count({ where })
  const skipped = (await prisma.scrapedItem.count()) - total

  console.log(`AI service        : ${AI_URL}`)
  console.log(`embeddable notices: ${total}`)
  console.log(`skipped (no text) : ${skipped}`)
  console.log(`mode              : ${apply ? 'APPLY' : 'dry run'}\n`)

  if (!apply) {
    console.log('Dry run — nothing sent. Re-run with --apply to embed.')
    return
  }

  let done = 0
  let indexed = 0
  let failed = 0

  for (let skip = 0; skip < total; skip += BATCH) {
    const rows = await prisma.scrapedItem.findMany({
      where,
      select: {
        id: true,
        title: true,
        aiSummary: true,
        contentText: true,
        category: true,
        sourceLabel: true,
        sourceUrl: true,
        publishedAt: true,
      },
      orderBy: { id: 'asc' },
      skip,
      take: BATCH,
    })
    if (!rows.length) break

    const notices = rows.map((n) => ({
      id: n.id,
      title: n.title,
      ai_summary: n.aiSummary || '',
      content: (n.contentText || '').slice(0, CONTENT_CHARS),
      category: n.category,
      source_label: n.sourceLabel,
      source_url: n.sourceUrl,
      published_at: n.publishedAt?.toISOString() || null,
    }))

    try {
      const res = await fetch(`${AI_URL}/notices/embed`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(SECRET ? { 'x-internal-secret': SECRET } : {}),
        },
        body: JSON.stringify({ notices }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
      const body = await res.json()
      indexed += body.indexed ?? 0
      failed += body.failed ?? 0
    } catch (err) {
      failed += notices.length
      console.error(`  batch at ${skip} FAILED: ${err.message}`)
    }

    done += rows.length
    console.log(`  ${done}/${total} sent (indexed ${indexed}, failed ${failed})`)
  }

  console.log(`\ndone — indexed ${indexed}, failed ${failed}`)
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
