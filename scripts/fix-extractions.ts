#!/usr/bin/env node
/**
 * fix-extractions.ts — Scan catalogue and repair messy/broken notice extractions.
 *
 * Runs on Node.js / TypeScript via `tsx` or `pnpm fix:extractions`.
 * Scans PostgreSQL via Prisma, identifies unreadable / empty extractions that have
 * PDF/image attachments, runs text extraction + OCR, and saves clean text.
 *
 * Usage:
 *   pnpm scan:extractions                  # Fast scan & health diagnosis only
 *   pnpm fix:extractions                   # Run repair on all messy & broken notices
 *   pnpm fix:extractions --limit 20        # Process first 20 items
 *   pnpm fix:extractions --dry-run         # Test without writing to database
 *   pnpm fix:extractions --source "Inland" # Filter by department/source
 */

import * as dotenv from "dotenv"
import * as path from "path"
import axios from "axios"
import { spawn } from "child_process"

// Load env files
const ROOT_DIR = path.resolve(__dirname, "..")
dotenv.config({ path: path.join(ROOT_DIR, ".env") })
dotenv.config({ path: path.join(ROOT_DIR, "apps", "api", ".env") })
dotenv.config({ path: path.join(ROOT_DIR, "apps", "ai", ".env") })

const { PrismaClient } = require(path.join(ROOT_DIR, "apps", "api", "node_modules", "@prisma/client"))
const prisma = new PrismaClient()
const AI_SERVICE_URL = process.env.AI_SERVICE_URL || "http://localhost:8000"
const QUALITY_THRESHOLD = 0.55

const EN_STOPWORDS = new Set(
  ("the of and to in for is on by with as at from this that shall be will has have are was were " +
    "it its or an a not all may must which their there been such under within after before date " +
    "notice office ministry government nepal department").split(" ")
)

const EXTRACTABLE_EXTS = [
  ".pdf", ".jpg", ".jpeg", ".png", ".webp", ".tif", ".tiff", ".bmp", ".docx"
]

function textQuality(text: string | null): number {
  if (!text || text.trim().length < 40) return 0.0
  const sample = text.slice(0, 8000)
  const nonSpace = sample.replace(/\s/g, "")
  if (!nonSpace) return 0.0

  const devanagariCount = (nonSpace.match(/[\u0900-\u097f]/g) || []).length
  const devanagariRatio = devanagariCount / nonSpace.length
  if (devanagariRatio >= 0.15) {
    return Math.min(1.0, 0.65 + devanagariRatio)
  }

  const tokens = sample.toLowerCase().match(/[a-z]{2,}/g) || []
  if (tokens.length < 25) return 0.6
  const hits = tokens.filter((t) => EN_STOPWORDS.has(t)).length
  const stopwordRatio = hits / tokens.length
  const score = Math.min(1.0, stopwordRatio / 0.12)
  return Math.max(0.0, Math.max(score, Math.min(0.6, devanagariRatio * 4)))
}

function classifyQuality(text: string | null): { classification: "CLEAN" | "MESSY" | "BROKEN"; quality: number } {
  if (!text || text.trim().length < 40) return { classification: "BROKEN", quality: 0.0 }
  const q = Math.round(textQuality(text) * 100) / 100
  if (q >= QUALITY_THRESHOLD) return { classification: "CLEAN", quality: q }
  if (q > 0.0) return { classification: "MESSY", quality: q }
  return { classification: "BROKEN", quality: 0.0 }
}

function findExtractableUrl(item: { attachmentUrl: string | null; sourceUrl: string }, attachments: { url: string; mimeType: string | null }[]): string | null {
  for (const att of attachments) {
    const url = (att.url || "").trim()
    const mime = (att.mimeType || "").toLowerCase()
    if (!url) continue
    const clean = url.split("?")[0].split("#")[0].toLowerCase()
    if (EXTRACTABLE_EXTS.some((ext) => clean.endsWith(ext)) || mime.includes("pdf") || mime.startsWith("image/")) {
      return url
    }
  }
  if (item.attachmentUrl) {
    const clean = item.attachmentUrl.split("?")[0].split("#")[0].toLowerCase()
    if (EXTRACTABLE_EXTS.some((ext) => clean.endsWith(ext)) || clean.includes("pdf") || clean.includes("/pdf")) {
      return item.attachmentUrl
    }
  }
  if (item.sourceUrl) {
    const clean = item.sourceUrl.split("?")[0].split("#")[0].toLowerCase()
    if (EXTRACTABLE_EXTS.some((ext) => clean.endsWith(ext))) {
      return item.sourceUrl
    }
  }
  return null
}

function formatTable(headers: string[], rows: string[][], alignments?: ("left" | "right" | "center")[]): string {
  const aligns = alignments || headers.map(() => "left" as const)
  const colWidths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i] || "").length)))

  const buildRow = (cells: string[], sep = "│", pad = " ") => {
    const parts = cells.map((cell, i) => {
      const val = String(cell)
      const w = colWidths[i]
      const align = aligns[i]
      if (align === "right") return val.padStart(w)
      if (align === "center") return val.padStart(Math.floor((w - val.length) / 2) + val.length).padEnd(w)
      return val.padEnd(w)
    })
    return `${sep}${pad}${parts.join(`${pad}${sep}${pad}`)}${pad}${sep}`
  }

  const buildBorder = (left: string, mid: string, cross: string, right: string, fill = "─") => {
    const parts = colWidths.map((w) => fill.repeat(w + 2))
    return `${left}${parts.join(cross)}${right}`
  }

  const top = buildBorder("┌", "─", "┬", "┐")
  const headerSep = buildBorder("├", "─", "┼", "┤")
  const bottom = buildBorder("└", "─", "┴", "┘")

  return [top, buildRow(headers), headerSep, ...rows.map((r) => buildRow(r)), bottom].join("\n")
}

async function checkAiService(): Promise<boolean> {
  try {
    const res = await axios.get(`${AI_SERVICE_URL}/health`, { timeout: 2000 })
    return res.status === 200
  } catch {
    return false
  }
}

async function extractViaPythonScript(args: string[]): Promise<void> {
  const pyScript = path.join(ROOT_DIR, "scripts", "fix_extractions.py")
  const venvPy = path.join(ROOT_DIR, "apps", "ai", ".venv", "bin", "python")
  const pythonBin = require("fs").existsSync(venvPy) ? venvPy : "python3"

  return new Promise((resolve, reject) => {
    const child = spawn(pythonBin, [pyScript, ...args], {
      stdio: "inherit",
      env: { ...process.env, PYTHONPATH: path.join(ROOT_DIR, "apps", "ai") },
    })
    child.on("close", (code) => {
      if (code === 0) resolve()
      else reject(new Error(`Process exited with code ${code}`))
    })
    child.on("error", reject)
  })
}

async function main() {
  const args = process.argv.slice(2)
  const isScanOnly = args.includes("--scan-only")
  const isDryRun = args.includes("--dry-run")

  const limitIndex = args.indexOf("--limit")
  const limit = limitIndex !== -1 ? parseInt(args[limitIndex + 1], 10) : undefined

  const sourceIndex = args.indexOf("--source")
  const sourceFilter = sourceIndex !== -1 ? args[sourceIndex + 1] : undefined

  const scopeIndex = args.indexOf("--scope")
  const scope = scopeIndex !== -1 ? args[scopeIndex + 1] : "garbled"

  const concurrencyIndex = args.indexOf("--concurrency")
  const concurrency = concurrencyIndex !== -1 ? parseInt(args[concurrencyIndex + 1], 10) : 2

  console.log("🔌 Connecting to database via Prisma...")

  // Fast catalogue scan
  console.log("🔍 Fetching catalogue and extraction health...")
  const [items, attachments] = await Promise.all([
    prisma.$queryRaw<Array<{
      id: string
      title: string | null
      category: string | null
      source_url: string
      attachment_url: string | null
      content_preview: string | null
      content_len: number
      source_label: string | null
      metadata: any
    }>>`
      SELECT 
        id,
        title,
        category,
        source_url,
        attachment_url,
        LEFT(content_text, 4000) as content_preview,
        COALESCE(LENGTH(content_text), 0)::int as content_len,
        source_label,
        metadata
      FROM scraped_items
      ORDER BY scraped_at DESC
    `,
    prisma.$queryRaw<Array<{ item_id: string; url: string; mime_type: string | null }>>`
      SELECT item_id, url, mime_type
      FROM attachments
      WHERE url IS NOT NULL AND url != ''
    `,
  ])

  const attachmentsByItem = new Map<string, { url: string; mimeType: string | null }[]>()
  for (const a of attachments) {
    const list = attachmentsByItem.get(a.item_id) || []
    list.push({ url: a.url, mimeType: a.mime_type })
    attachmentsByItem.set(a.item_id, list)
  }

  const total = items.length
  let cleanCount = 0
  let messyCount = 0
  let brokenCount = 0
  let withAttachmentCount = 0
  let actionableMessy = 0
  let actionableBroken = 0

  const sourceStats: Record<string, { total: number; clean: number; messy: number; broken: number; fixable: number }> = {}
  const catalog: any[] = []

  for (const item of items) {
    const atts = attachmentsByItem.get(item.id) || []
    const { classification, quality } = classifyQuality(item.content_preview)
    const extractableUrl = findExtractableUrl({ attachmentUrl: item.attachment_url, sourceUrl: item.source_url }, atts)
    const hasAttachment = Boolean(extractableUrl)

    if (hasAttachment) withAttachmentCount++
    if (classification === "CLEAN") cleanCount++
    else if (classification === "MESSY") {
      messyCount++
      if (hasAttachment) actionableMessy++
    } else {
      brokenCount++
      if (hasAttachment) actionableBroken++
    }

    const src = item.source_label || "Unknown"
    if (!sourceStats[src]) {
      sourceStats[src] = { total: 0, clean: 0, messy: 0, broken: 0, fixable: 0 }
    }
    sourceStats[src].total++
    if (classification === "CLEAN") sourceStats[src].clean++
    else if (classification === "MESSY") sourceStats[src].messy++
    else sourceStats[src].broken++
    if (hasAttachment && classification !== "CLEAN") sourceStats[src].fixable++

    catalog.push({
      id: item.id,
      title: item.title,
      category: item.category,
      sourceLabel: src,
      sourceUrl: item.source_url,
      attachmentUrl: item.attachment_url,
      extractableUrl,
      contentText: item.content_preview,
      metadata: typeof item.metadata === "string" ? JSON.parse(item.metadata) : (item.metadata || {}),
      qualityBefore: quality,
      classBefore: classification,
    })
  }

  const healthRows = [
    ["Total Notices in Catalogue", total.toLocaleString(), "100.0%"],
    ["Clean Extractions (Readable >= 0.55)", cleanCount.toLocaleString(), `${((cleanCount / total) * 100).toFixed(1)}%`],
    ["Messy Extractions (Garbled 0 < q < 0.55)", messyCount.toLocaleString(), `${((messyCount / total) * 100).toFixed(1)}%`],
    ["Broken Extractions (Empty / q = 0.0)", brokenCount.toLocaleString(), `${((brokenCount / total) * 100).toFixed(1)}%`],
    ["Notices With Extractable PDF/Image", withAttachmentCount.toLocaleString(), `${((withAttachmentCount / total) * 100).toFixed(1)}%`],
    ["Actionable Messy (Has Attachment)", actionableMessy.toLocaleString(), `${((actionableMessy / total) * 100).toFixed(1)}%`],
    ["Actionable Broken (Has Attachment)", actionableBroken.toLocaleString(), `${((actionableBroken / total) * 100).toFixed(1)}%`],
    ["🎯 Actionable Repair Queue", (actionableMessy + actionableBroken).toLocaleString(), `${(((actionableMessy + actionableBroken) / total) * 100).toFixed(1)}%`],
  ]

  console.log("\n" + "=".repeat(65))
  console.log("  📊 SUCHANA AI — CATALOGUE EXTRACTION HEALTH SCAN (NODE/TS)")
  console.log("=".repeat(65))
  console.log(formatTable(["Catalogue Metric", "Count", "Share"], healthRows, ["left", "right", "right"]))

  const topSources = Object.entries(sourceStats)
    .filter(([, d]) => d.fixable > 0)
    .sort((a, b) => b[1].fixable - a[1].fixable)
    .slice(0, 8)

  if (topSources.length > 0) {
    console.log("\n📌 Top Sources With Messy/Broken Attachments:")
    const sourceRows = topSources.map(([s, d]) => [
      s.slice(0, 35),
      d.total.toLocaleString(),
      d.clean.toLocaleString(),
      d.messy.toLocaleString(),
      d.broken.toLocaleString(),
      `⭐ ${d.fixable.toLocaleString()}`,
    ])
    console.log(formatTable(["Source Portal", "Total", "Clean", "Messy", "Broken", "Fixable"], sourceRows, ["left", "right", "right", "right", "right", "right"]))
  }

  if (isScanOnly) {
    console.log("\n✅ Scan complete (--scan-only specified). Exiting without modifications.")
    await prisma.$disconnect()
    return
  }

  await prisma.$disconnect()

  // Delegate OCR/poppler batch extraction to high-performance multi-threaded extractor pipeline
  const passThroughArgs: string[] = []
  if (scope) passThroughArgs.push("--scope", scope)
  if (limit) passThroughArgs.push("--limit", String(limit))
  if (concurrency) passThroughArgs.push("--concurrency", String(concurrency))
  if (isDryRun) passThroughArgs.push("--dry-run")
  if (sourceFilter) passThroughArgs.push("--source", sourceFilter)

  await extractViaPythonScript(passThroughArgs)
}

main().catch((err) => {
  console.error("❌ Fatal error:", err)
  process.exit(1)
})
