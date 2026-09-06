// One-off: summarize + embed notices that have content but no AI summary.
// Mirrors ScrapingService.backfillSummaries so results match the endpoint.
// Usage: node scripts/backfill-summaries.js [limit] [concurrency]
const { PrismaClient } = require('@prisma/client')

const prisma = new PrismaClient()
const AI_URL = process.env.AI_SERVICE_URL || 'http://localhost:8000'
const limit = Number(process.argv[2] || 500)
const concurrency = Number(process.argv[3] || 3)

async function analyze(item) {
  const res = await fetch(`${AI_URL}/notices/analyze`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: item.title, content: (item.contentText || '').slice(0, 8000) }),
  })
  if (!res.ok) return false
  const data = await res.json()
  if (!data.analyzed) return false
  await prisma.scrapedItem.update({
    where: { id: item.id },
    data: {
      aiSummary: data.summary,
      keyFacts: data.key_facts ?? [],
      tags: data.tags ?? [],
      aiAnalyzedAt: new Date(),
    },
  })
  return true
}

async function main() {
  const pending = await prisma.scrapedItem.findMany({
    where: { aiSummary: null, contentText: { not: null } },
    select: { id: true, title: true, contentText: true },
    orderBy: { publishedAt: 'desc' },
    take: limit,
  })
  console.log(`pending: ${pending.length} (concurrency ${concurrency})`)

  let cursor = 0
  let done = 0
  const summarized = []
  const worker = async () => {
    while (cursor < pending.length) {
      const item = pending[cursor++]
      try {
        if (await analyze(item)) summarized.push(item.id)
      } catch (e) {
        console.log(`  fail ${item.id}: ${e.message}`)
      }
      if (++done % 25 === 0) console.log(`  ${done}/${pending.length} processed, ${summarized.length} summarized`)
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))
  console.log(`summarized ${summarized.length}/${pending.length}`)

  for (let i = 0; i < summarized.length; i += 200) {
    const batch = summarized.slice(i, i + 200)
    const rows = await prisma.scrapedItem.findMany({
      where: { id: { in: batch } },
      select: { id: true, title: true, aiSummary: true, category: true, sourceLabel: true, sourceUrl: true, publishedAt: true },
    })
    const res = await fetch(`${AI_URL}/notices/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        notices: rows.map((n) => ({
          id: n.id,
          title: n.title,
          ai_summary: n.aiSummary || '',
          category: n.category,
          source_label: n.sourceLabel,
          source_url: n.sourceUrl,
          published_at: n.publishedAt?.toISOString() || null,
        })),
      }),
    })
    console.log(`  embed batch ${i / 200 + 1}: ${JSON.stringify(await res.json())}`)
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())
