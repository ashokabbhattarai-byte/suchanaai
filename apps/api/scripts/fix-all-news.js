// Bring the whole notice catalogue up to date, in dependency order.
//
//   1. cleanup   drop rows that were never real notices, and their vectors
//   2. summaries fill missing AI summaries  (LLM-bound — see the note below)
//   3. embed     re-embed everything into Qdrant (no LLM, just the local model)
//   4. scrape    run every enabled source so new notices land
//
// Order matters: cleaning first avoids spending LLM calls on junk, and
// embedding last means the vectors reflect the summaries just written.
//
// IMPORTANT — step 2 is the slow one. Every missing summary is one LLM call,
// and the free tiers are small (OpenRouter: 50 requests/day; Groq: 200k
// tokens/day, roughly 100 summaries). With ~1000 notices missing a summary
// this takes days, not minutes, so it is capped per run and is resumable —
// re-running only picks up what is still missing.
//
// Notices with no summary are NOT broken: since the body is embedded and used
// as answer context, they are searchable and answerable without one. Summaries
// improve card display and alert matching, so this is quality, not repair.
//
// Usage:
//   node scripts/fix-all-news.js                       # dry run, shows scope
//   node scripts/fix-all-news.js --all --apply         # every step
//   node scripts/fix-all-news.js --summaries --apply --limit 40
//   node scripts/fix-all-news.js --embed --scrape --apply
const { PrismaClient } = require('@prisma/client')

const prisma = new PrismaClient()
const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const num = (f, d) => {
  const i = argv.indexOf(f)
  return i !== -1 && argv[i + 1] ? Number(argv[i + 1]) : d
}

const apply = has('--apply')
const all = has('--all')
const steps = {
  cleanup: all || has('--cleanup'),
  summaries: all || has('--summaries'),
  embed: all || has('--embed'),
  scrape: all || has('--scrape'),
}
// Default cap sits just under a free tier's daily budget so one run doesn't
// burn the whole allowance and leave the chatbot with none.
const LIMIT = num('--limit', 40)
const CONCURRENCY = num('--concurrency', 2)
const AI_URL = process.env.AI_SERVICE_URL || 'http://localhost:8000'
const CONTENT_CHARS = 4000

const isStorable = (title, sourceUrl) => {
  if (!sourceUrl) return false
  const t = (title ?? '').replace(/\s+/g, ' ').trim()
  if (t.length < 8) return false
  if (/^\(?untitled\)?$/i.test(t)) return false
  return (t.match(/[A-Za-zऄ-ॿ]/g)?.length ?? 0) >= 5
}

async function stepCleanup() {
  const candidates = await prisma.scrapedItem.findMany({
    where: { OR: [{ title: { contains: 'untitled' } }, { title: '' }] },
    select: { id: true, title: true, sourceUrl: true },
    take: 20000,
  })
  const junk = candidates.filter((r) => !isStorable(r.title, r.sourceUrl))
  console.log(`  junk rows: ${junk.length}`)
  if (!junk.length || !apply) return

  const ids = junk.map((j) => j.id)
  // Drop vectors first: deleting the row first would orphan them, and there
  // would no longer be an id to look them up by.
  try {
    await fetch(`${AI_URL}/notices/delete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ notice_ids: ids }),
    })
  } catch (e) {
    console.log(`  (vector delete failed, continuing: ${e.message})`)
  }
  const { count } = await prisma.scrapedItem.deleteMany({ where: { id: { in: ids } } })
  console.log(`  deleted ${count}`)
}

async function stepSummaries() {
  const where = {
    OR: [{ aiSummary: null }, { aiSummary: '' }],
    AND: [{ contentText: { not: null } }, { contentText: { not: '' } }],
  }
  const missing = await prisma.scrapedItem.count({ where })
  console.log(`  missing summaries: ${missing} (this run will attempt ${Math.min(missing, LIMIT)})`)
  if (!apply || !missing) return

  const items = await prisma.scrapedItem.findMany({
    where,
    select: { id: true, title: true, contentText: true },
    orderBy: { publishedAt: 'desc' },
    take: LIMIT,
  })

  let ok = 0
  let failed = 0
  let rateLimited = false

  const worker = async (queue) => {
    while (queue.length) {
      if (rateLimited) return
      const item = queue.shift()
      try {
        const res = await fetch(`${AI_URL}/notices/analyze`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            title: item.title,
            content: (item.contentText || '').slice(0, 8000),
          }),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = await res.json()
        if (!data.analyzed) {
          // Every provider refused. Pushing on would burn the rest of the
          // queue against the same exhausted quota, so stop and let the next
          // run resume once the window resets.
          rateLimited = true
          console.log('  provider chain refused — stopping early, re-run later to resume')
          return
        }
        await prisma.scrapedItem.update({
          where: { id: item.id },
          data: {
            aiSummary: data.summary,
            keyFacts: data.key_facts ?? [],
            tags: data.tags ?? [],
            aiAnalyzedAt: new Date(),
          },
        })
        ok++
        if (ok % 10 === 0) console.log(`    ${ok} summarised…`)
      } catch (e) {
        failed++
        if (failed <= 3) console.log(`    failed ${item.id}: ${e.message}`)
      }
    }
  }

  const queue = [...items]
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker(queue)))
  console.log(`  summarised ${ok}, failed ${failed}, remaining ${missing - ok}`)
}

async function stepEmbed() {
  const where = { OR: [{ aiSummary: { not: null } }, { contentText: { not: null } }] }
  const total = await prisma.scrapedItem.count({ where })
  console.log(`  embeddable: ${total}`)
  if (!apply) return

  let done = 0
  let indexed = 0
  let failed = 0
  // See reembed-notices.js: 20 per call exceeds nginx's 60s proxy timeout.
  const BATCH = 10

  for (let skip = 0; skip < total; skip += BATCH) {
    const rows = await prisma.scrapedItem.findMany({
      where,
      select: {
        id: true, title: true, aiSummary: true, contentText: true,
        category: true, sourceLabel: true, sourceUrl: true, publishedAt: true,
      },
      orderBy: { id: 'asc' },
      skip,
      take: BATCH,
    })
    if (!rows.length) break

    try {
      const res = await fetch(`${AI_URL}/notices/embed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          notices: rows.map((n) => ({
            id: n.id,
            title: n.title,
            ai_summary: n.aiSummary || '',
            content: (n.contentText || '').slice(0, CONTENT_CHARS),
            category: n.category,
            source_label: n.sourceLabel,
            source_url: n.sourceUrl,
            published_at: n.publishedAt?.toISOString() || null,
          })),
        }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const body = await res.json()
      indexed += body.indexed ?? 0
      failed += body.failed ?? 0
    } catch (e) {
      failed += rows.length
      console.log(`    batch at ${skip} failed: ${e.message}`)
    }
    done += rows.length
    console.log(`    ${done}/${total} (indexed ${indexed}, failed ${failed})`)
  }
}

async function stepScrape() {
  const sources = await prisma.scrapeSource.findMany({
    where: { enabled: true },
    select: { id: true, name: true },
  })
  console.log(`  enabled sources: ${sources.length}`)
  if (!apply) return
  console.log(
    '  NOTE: run scraping from the admin panel (Web scraping → Run all) or\n' +
    '        POST /admin/scraping/sources/run-all — it needs an admin JWT and\n' +
    '        the scheduler tracks progress per run, which this script cannot.',
  )
}

async function main() {
  const chosen = Object.entries(steps).filter(([, on]) => on).map(([k]) => k)
  if (!chosen.length) {
    console.log('Nothing selected. Use --all, or any of --cleanup --summaries --embed --scrape.')
    return
  }
  console.log(`AI service : ${AI_URL}`)
  console.log(`steps      : ${chosen.join(', ')}`)
  console.log(`mode       : ${apply ? 'APPLY' : 'dry run'}\n`)

  if (steps.cleanup) { console.log('[1/4] cleanup'); await stepCleanup() }
  if (steps.summaries) { console.log('[2/4] summaries'); await stepSummaries() }
  if (steps.embed) { console.log('[3/4] embed'); await stepEmbed() }
  if (steps.scrape) { console.log('[4/4] scrape'); await stepScrape() }

  if (!apply) console.log('\nDry run — nothing changed. Add --apply.')
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
