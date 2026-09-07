// Apply (or dump the inputs for) the listing-URL re-detection run in
// apps/ai/scripts/redetect_source_routes.py.
//
// Two-step maintenance flow, since the AI service (Python, crawl4ai) and the
// DB writer (this app's Prisma client) live in different runtimes:
//   1. node scripts/apply-route-redetect.js --dump > sources.json
//      .venv/bin/python scripts/redetect_source_routes.py sources.json   (in apps/ai)
//   2. node scripts/apply-route-redetect.js --apply
//
// A corrected listing URL invalidates that category's cached extraction
// schema — the same rule ScrapingService.updateSource applies on a manual
// edit, since the old CSS selectors were derived from the old page.
const { PrismaClient } = require('@prisma/client')
const fs = require('fs')
const path = require('path')

const prisma = new PrismaClient()
const REPORT_PATH = path.join(__dirname, '..', '..', 'ai', 'scripts', 'redetect_source_routes_report.json')

const SCHEMA_FIELD_BY_LIST_FIELD = {
  noticeListUrl: 'noticeSchema',
  newsListUrl: 'newsSchema',
  pressReleaseListUrl: 'pressReleaseSchema',
}

async function dump() {
  const sources = await prisma.scrapeSource.findMany({
    where: { isAdHoc: false },
    select: {
      id: true, name: true, baseUrl: true,
      noticeListUrl: true, newsListUrl: true, pressReleaseListUrl: true,
      isAdHoc: true, enabled: true,
    },
    orderBy: { createdAt: 'asc' },
  })
  process.stdout.write(JSON.stringify(sources, null, 2))
}

async function apply() {
  if (!fs.existsSync(REPORT_PATH)) {
    console.error(`No report found at ${REPORT_PATH} — run the Python discovery script first.`)
    process.exitCode = 1
    return
  }
  const report = JSON.parse(fs.readFileSync(REPORT_PATH, 'utf8'))
  const toApply = report.filter((r) => r.status === 'would_update')

  console.log(`${toApply.length} source(s) to update, ${report.length - toApply.length} unchanged/skipped\n`)

  let applied = 0
  for (const entry of toApply) {
    const data = { ...entry.changes }
    for (const field of Object.keys(entry.changes)) {
      data[SCHEMA_FIELD_BY_LIST_FIELD[field]] = null
    }
    try {
      await prisma.scrapeSource.update({ where: { id: entry.id }, data })
      console.log(`✓ ${entry.name}: ${Object.entries(entry.changes).map(([k, v]) => `${k} -> ${v}`).join(', ')}`)
      applied++
    } catch (err) {
      console.error(`✗ ${entry.name}: ${err.message}`)
    }
  }
  console.log(`\nApplied ${applied}/${toApply.length} update(s).`)
}

async function main() {
  if (process.argv.includes('--dump')) return dump()
  if (process.argv.includes('--apply')) return apply()
  console.log('Usage: node apply-route-redetect.js --dump | --apply')
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
