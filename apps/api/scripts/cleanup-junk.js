// One-off admin cleanup: remove catalogue rows that are not real notices and
// drop their vectors. Mirrors ScrapingService.isStorableItem exactly.
// Usage: node scripts/cleanup-junk.js [--delete]
const { PrismaClient } = require('@prisma/client')

const prisma = new PrismaClient()
const AI_URL = process.env.AI_SERVICE_URL || 'http://localhost:8000'
const doDelete = process.argv.includes('--delete')

function isStorable(title, sourceUrl) {
  if (!sourceUrl) return false
  const t = (title ?? '').replace(/\s+/g, ' ').trim()
  if (t.length < 8) return false
  if (/^\(?untitled\)?$/i.test(t)) return false
  const letters = t.match(/[A-Za-zऄ-ॿ]/g)?.length ?? 0
  return letters >= 5
}

async function main() {
  const candidates = await prisma.scrapedItem.findMany({
    where: { OR: [{ title: { contains: 'untitled' } }, { title: '' }] },
    select: { id: true, title: true, sourceUrl: true, sourceLabel: true, aiSummary: true },
    take: 20000,
  })
  const junk = candidates.filter((r) => !isStorable(r.title, r.sourceUrl))
  const embedded = junk.filter((r) => r.aiSummary !== null)

  console.log(`candidates matched by pre-filter: ${candidates.length}`)
  console.log(`confirmed junk (fails isStorableItem): ${junk.length}`)
  console.log(`  ...of which are embedded in the vector store: ${embedded.length}`)
  console.log('sample:')
  for (const r of junk.slice(0, 5)) console.log(`  - "${r.title}" (${r.sourceLabel})`)

  if (!doDelete) {
    console.log('\nDRY RUN — nothing deleted. Re-run with --delete to remove.')
    return
  }

  const ids = junk.map((r) => r.id)
  const res = await prisma.scrapedItem.deleteMany({ where: { id: { in: ids } } })
  console.log(`\ndeleted ${res.count} row(s) from the database`)

  for (let i = 0; i < ids.length; i += 200) {
    const batch = ids.slice(i, i + 200)
    const r = await fetch(`${AI_URL}/notices/delete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: batch }),
    })
    console.log(`  vector delete batch ${i / 200 + 1}: ${r.status} ${JSON.stringify(await r.json())}`)
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())
