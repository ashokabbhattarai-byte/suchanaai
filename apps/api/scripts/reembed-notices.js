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
//   node scripts/reembed-notices.js                      # dry run — scope only
//   node scripts/reembed-notices.js --apply              # embed, throttled
//   node scripts/reembed-notices.js --apply --skip 390   # resume where it stopped
//   node scripts/reembed-notices.js --apply --sleep 0    # full speed (offline only)
const { PrismaClient } = require('@prisma/client')

const prisma = new PrismaClient()
const apply = process.argv.includes('--apply')
const batchArg = process.argv.indexOf('--batch')
// 10 measured at ~24s on the t3.medium AI instance; 20 took 60.8s and hit
// nginx's 60s proxy timeout with a 504, losing the whole batch.
const BATCH = batchArg !== -1 ? Number(process.argv[batchArg + 1]) : 10
const AI_URL = process.env.AI_SERVICE_URL || 'http://localhost:8000'
const SECRET = process.env.INTERNAL_SERVICE_SECRET || ''
const CONTENT_CHARS = 4000

// Pause between batches. The AI service is one t3.medium running uvicorn with
// --workers 1, and embedding is CPU-bound, so back-to-back batches block the
// same event loop that answers chat: /health went 0.1s -> 14.5s and a chat
// query 4s -> 48s, which reads to a user as "the chatbot stopped working".
// Sleeping ~the length of a batch keeps the service usable while this runs.
const sleepArg = process.argv.indexOf('--sleep')
const SLEEP_MS = (sleepArg !== -1 ? Number(process.argv[sleepArg + 1]) : 25) * 1000
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Skip work already done, so a re-run after an interruption resumes instead of
// re-embedding from the top.
const resumeArg = process.argv.indexOf('--skip')
const SKIP = resumeArg !== -1 ? Number(process.argv[resumeArg + 1]) : 0

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

  let done = SKIP
  let indexed = 0
  let failed = 0
  if (SKIP) console.log(`resuming after ${SKIP} already-embedded notices\n`)

  for (let skip = SKIP; skip < total; skip += BATCH) {
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
    if (SLEEP_MS > 0 && done < total) await sleep(SLEEP_MS)
  }

  console.log(`\ndone — indexed ${indexed}, failed ${failed}`)
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
