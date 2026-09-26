#!/usr/bin/env python3
"""fix_extractions.py — Scan catalogue and re-extract messy & broken notices via OCR/poppler.

Scans all notices in PostgreSQL (`scraped_items`), detects unreadable / messy / broken text,
locates extractable PDF/image attachments, runs text extraction (pdftotext / pypdf / Tesseract OCR),
evaluates linguistic quality, and updates PostgreSQL with clean, readable text.

Features:
  - Scans catalogue with offset pagination.
  - Multi-extractor pipeline: native extraction -> quality scoring -> OCR on low quality / scanned pages.
  - Live progress display with tabular status for each processed notice.
  - Comprehensive before/after health breakdown with clean ASCII/Unicode tables.

Usage:
  python scripts/fix_extractions.py --scan-only
  python scripts/fix_extractions.py --scope garbled --limit 50
  python scripts/fix_extractions.py --scope broken
  python scripts/fix_extractions.py --concurrency 3 --dry-run
"""

import argparse
import asyncio
import json
import os
import sys
import tempfile
import time
from pathlib import Path
from urllib.parse import urlparse

import aiohttp
import asyncpg
from dotenv import load_dotenv

# Ensure root and apps/ai / apps/api are in python path
ROOT_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT_DIR / "apps" / "ai"))

load_dotenv(ROOT_DIR / ".env")
load_dotenv(ROOT_DIR / "apps" / "api" / ".env")
load_dotenv(ROOT_DIR / "apps" / "ai" / ".env")

DB_URL = os.environ.get("DATABASE_URL")
if not DB_URL:
    print("❌ Error: DATABASE_URL not found in environment or .env files.")
    sys.exit(1)

# Import extractor routines
try:
    from app.extractor import (
        QUALITY_THRESHOLD,
        _text_quality,
        extract_text,
        is_readable_text,
    )
except ImportError:
    print("⚠️ Warning: Could not import app.extractor directly. Using built-in fallback routines.")
    QUALITY_THRESHOLD = 0.55

    def _text_quality(text: str) -> float:
        if not text or len(text.strip()) < 40:
            return 0.0
        sample = text[:4000]
        non_space = [c for c in sample if not c.isspace()]
        if not non_space:
            return 0.0
        devanagari = sum(1 for c in non_space if "\u0900" <= c <= "\u097f")
        ratio = devanagari / len(non_space)
        if ratio >= 0.15:
            return min(1.0, 0.65 + ratio)
        return 0.5

    def is_readable_text(text: str, threshold: float = QUALITY_THRESHOLD) -> bool:
        return _text_quality(text) >= threshold

    def extract_text(file_path, mime_type, title="", on_progress=None):
        import subprocess
        p = Path(file_path)
        if mime_type == "application/pdf":
            try:
                res = subprocess.run(["pdftotext", "-layout", "-enc", "UTF-8", str(p), "-"], capture_output=True, text=True, timeout=60)
                if res.returncode == 0 and res.stdout.strip():
                    txt = res.stdout.strip()
                    return {"text": txt, "is_ocr": False, "method": "pdftotext", "quality": _text_quality(txt), "page_count": 1}
            except Exception:
                pass
        return {"text": "", "is_ocr": False, "method": "none", "quality": 0.0, "page_count": 0}


EXTRACTABLE_EXTS = (
    ".pdf", ".jpg", ".jpeg", ".png", ".webp", ".tif", ".tiff", ".bmp", ".docx"
)


def get_extractable_url(item: dict, attachments: list[dict]) -> str | None:
    """Find the best extractable PDF or image URL for a notice."""
    # 1. Check attachments relation first
    for att in attachments:
        url = (att.get("url") or "").strip()
        mime = (att.get("mimeType") or "").lower()
        if not url:
            continue
        clean_url = url.split("?")[0].split("#")[0].lower()
        if clean_url.endswith(EXTRACTABLE_EXTS) or "pdf" in mime or mime.startswith("image/"):
            return url

    # 2. Check legacy attachment_url
    att_url = (item.get("attachment_url") or "").strip()
    if att_url:
        clean = att_url.split("?")[0].split("#")[0].lower()
        if clean.endswith(EXTRACTABLE_EXTS) or "pdf" in clean or "/pdf" in clean:
            return att_url

    # 3. Check source_url (if the listing linked directly to the PDF/document)
    src_url = (item.get("source_url") or "").strip()
    if src_url:
        clean = src_url.split("?")[0].split("#")[0].lower()
        if clean.endswith(EXTRACTABLE_EXTS):
            return src_url

    return None


def classify_quality(text: str | None) -> tuple[str, float]:
    """Classify text quality into CLEAN, MESSY, or BROKEN."""
    if not text or len(text.strip()) < 40:
        return "BROKEN", 0.0
    q = _text_quality(text)
    if q >= QUALITY_THRESHOLD:
        return "CLEAN", round(q, 3)
    if q > 0.0:
        return "MESSY", round(q, 3)
    return "BROKEN", 0.0


async def download_file(session: aiohttp.ClientSession, url: str, timeout_sec: int = 40) -> tuple[bytes | None, str]:
    """Download a file with browser headers, SSL fallback, and content-type detection."""
    headers = {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "Accept": "application/pdf,image/*,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9,ne;q=0.8",
    }
    try:
        async with session.get(url, headers=headers, timeout=aiohttp.ClientTimeout(total=timeout_sec), ssl=False) as resp:
            if resp.status != 200:
                return None, f"HTTP {resp.status}"
            mime = resp.headers.get("Content-Type", "").split(";")[0].strip().lower()
            data = await resp.read()
            if len(data) < 50:
                return None, "File too small / empty"
            if len(data) > 60 * 1024 * 1024:
                return None, f"File too large ({len(data)//(1024*1024)}MB > 60MB)"

            # Infer mime if generic
            if not mime or mime in ("application/octet-stream", "binary/octet-stream", "text/html"):
                path_l = urlparse(url).path.lower()
                if path_l.endswith(".pdf") or data[:4] == b"%PDF":
                    mime = "application/pdf"
                elif path_l.endswith((".jpg", ".jpeg")) or data[:3] == b"\xff\xd8\xff":
                    mime = "image/jpeg"
                elif path_l.endswith(".png") or data[:8] == b"\x89PNG\r\n\x1a\n":
                    mime = "image/png"
                elif path_l.endswith(".webp"):
                    mime = "image/webp"
                elif path_l.endswith(".docx"):
                    mime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

            return data, mime
    except Exception as e:
        return None, str(e)


def format_table(headers: list[str], rows: list[list[str]], alignments: list[str] | None = None) -> str:
    """Format an ASCII table with alignment and clean borders."""
    if not alignments:
        alignments = ["left"] * len(headers)

    col_widths = [len(h) for h in headers]
    for row in rows:
        for i, cell in enumerate(row):
            col_widths[i] = max(col_widths[i], len(str(cell)))

    def build_row(cells, sep="│", pad=" "):
        parts = []
        for i, (cell, width, align) in enumerate(zip(cells, col_widths, alignments)):
            val = str(cell)
            if align == "right":
                parts.append(val.rjust(width))
            elif align == "center":
                parts.append(val.center(width))
            else:
                parts.append(val.ljust(width))
        return f"{sep}{pad}" + f"{pad}{sep}{pad}".join(parts) + f"{pad}{sep}"

    def build_border(left, mid, cross, right, fill="─"):
        parts = [fill * (w + 2) for w in col_widths]
        return f"{left}" + f"{cross}".join(parts) + f"{right}"

    top = build_border("┌", "─", "┬", "┐")
    header_sep = build_border("├", "─", "┼", "┤")
    bottom = build_border("└", "─", "┴", "┘")

    lines = [top, build_row(headers), header_sep]
    for row in rows:
        lines.append(build_row(row))
    lines.append(bottom)
    return "\n".join(lines)


async def run_scan(pool: asyncpg.Pool):
    """Scan all notices in DB and return rich statistics and items."""
    print("🔍 Fetching catalogue from database...")
    from collections import defaultdict
    
    # Fast parallel retrieval: scraped_items + attachments
    items, attachments_rows = await asyncio.gather(
        pool.fetch(
            """
            SELECT 
                id,
                title,
                category,
                source_url,
                attachment_url,
                LEFT(content_text, 4000) as content_preview,
                COALESCE(LENGTH(content_text), 0) as content_len,
                source_label,
                metadata
            FROM scraped_items
            ORDER BY scraped_at DESC
            """
        ),
        pool.fetch(
            """
            SELECT item_id, url, mime_type
            FROM attachments
            WHERE url IS NOT NULL
            """
        )
    )

    attachments_by_item = defaultdict(list)
    for a in attachments_rows:
        attachments_by_item[str(a["item_id"])].append({"url": a["url"], "mimeType": a["mime_type"]})

    total = len(items)
    clean_count = 0
    messy_count = 0
    broken_count = 0
    with_attachment_count = 0
    actionable_messy = 0
    actionable_broken = 0

    catalog = []
    source_stats = {}

    for row in items:
        item_id = str(row["id"])
        attachments_list = attachments_by_item.get(item_id, [])
        content_preview = row["content_preview"] or ""
        content_len = row["content_len"] or 0
        cls, quality = classify_quality(content_preview)

        extractable_url = get_extractable_url(dict(row), attachments_list)
        has_attachment = bool(extractable_url)

        if has_attachment:
            with_attachment_count += 1

        if cls == "CLEAN":
            clean_count += 1
        elif cls == "MESSY":
            messy_count += 1
            if has_attachment:
                actionable_messy += 1
        else:
            broken_count += 1
            if has_attachment:
                actionable_broken += 1

        source = row["source_label"] or "Unknown"
        if source not in source_stats:
            source_stats[source] = {"total": 0, "clean": 0, "messy": 0, "broken": 0, "fixable": 0}
        source_stats[source]["total"] += 1
        source_stats[source][cls.lower()] += 1
        if has_attachment and cls != "CLEAN":
            source_stats[source]["fixable"] += 1

        catalog.append({
            "id": str(row["id"]),
            "title": row["title"] or "(untitled)",
            "category": row["category"] or "NOTICE",
            "source_label": source,
            "source_url": row["source_url"],
            "attachment_url": row["attachment_url"],
            "extractable_url": extractable_url,
            "content_text": content_preview,
            "content_len": content_len,
            "metadata": json.loads(row["metadata"]) if isinstance(row["metadata"], str) else (row["metadata"] or {}),
            "quality_before": quality,
            "class_before": cls,
        })

    return {
        "total": total,
        "clean": clean_count,
        "messy": messy_count,
        "broken": broken_count,
        "with_attachment": with_attachment_count,
        "without_attachment": total - with_attachment_count,
        "actionable_messy": actionable_messy,
        "actionable_broken": actionable_broken,
        "actionable_total": actionable_messy + actionable_broken,
        "catalog": catalog,
        "source_stats": source_stats,
    }


async def process_notice(
    sem: asyncio.Semaphore,
    session: aiohttp.ClientSession,
    pool: asyncpg.Pool,
    item: dict,
    dry_run: bool = False,
    timeout: int = 45,
) -> dict:
    """Download attachment, extract text, score quality, and update DB."""
    async with sem:
        notice_id = item["id"]
        title = item["title"]
        url = item["extractable_url"]
        q_before = item["quality_before"]
        cls_before = item["class_before"]

        if not url:
            return {
                "id": notice_id,
                "title": title,
                "status": "SKIPPED",
                "reason": "No extractable attachment",
                "chars": len(item["content_text"] or ""),
                "quality_before": q_before,
                "quality_after": q_before,
                "method": "none",
                "is_ocr": False,
            }

        # Download file
        data, mime_or_err = await download_file(session, url, timeout_sec=timeout)
        if not data:
            return {
                "id": notice_id,
                "title": title,
                "status": "DOWNLOAD_FAILED",
                "reason": mime_or_err,
                "chars": 0,
                "quality_before": q_before,
                "quality_after": q_before,
                "method": "none",
                "is_ocr": False,
            }

        mime_type = mime_or_err

        # Save to temporary file for extractor
        suffix = (
            ".pdf" if mime_type == "application/pdf"
            else ".png" if mime_type == "image/png"
            else ".jpg" if mime_type == "image/jpeg"
            else ".webp" if mime_type == "image/webp"
            else ".docx" if "document" in mime_type
            else ".bin"
        )

        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
            tmp.write(data)
            tmp_path = tmp.name

        try:
            # Run extraction in worker thread
            res = await asyncio.to_thread(extract_text, tmp_path, mime_type, title)
            extracted_text = (res.get("text") or "").strip()
            method = res.get("method") or "unknown"
            is_ocr = bool(res.get("is_ocr"))
            page_count = res.get("page_count") or 1
            tables = res.get("tables") or []
            qr_codes = res.get("qr_codes") or []

            cls_after, q_after = classify_quality(extracted_text)
            chars_after = len(extracted_text)

            # Determine if extraction succeeded / improved
            improved = (
                (cls_after == "CLEAN" and cls_before != "CLEAN") or
                (q_after >= q_before and chars_after > len(item["content_text"] or "")) or
                (chars_after >= 60 and q_after >= 0.50)
            )

            if chars_after == 0:
                status = "EMPTY"
            elif cls_after == "CLEAN":
                status = "CLEAN"
            elif improved:
                status = "IMPROVED"
            else:
                status = "LOW_QUALITY"

            # Update DB if not dry run and text is usable
            if not dry_run and chars_after >= 40 and q_after >= 0.45:
                meta = dict(item["metadata"])
                meta["extraction"] = {
                    "method": method,
                    "is_ocr": is_ocr,
                    "chars": chars_after,
                    "quality": q_after,
                    "page_count": page_count,
                    "reextracted_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                }
                if qr_codes:
                    meta["qrCodes"] = qr_codes
                if tables:
                    meta["tables"] = tables

                await pool.execute(
                    """
                    UPDATE scraped_items
                    SET content_text = $1,
                        metadata = $2::jsonb,
                        ai_analyzed_at = NOW()
                    WHERE id = $3::uuid
                    """,
                    extracted_text,
                    json.dumps(meta),
                    item["id"],
                )

            return {
                "id": notice_id,
                "title": title,
                "status": status,
                "quality_before": q_before,
                "quality_after": q_after,
                "chars": chars_after,
                "method": method,
                "is_ocr": is_ocr,
                "page_count": page_count,
                "reason": "OK" if chars_after > 0 else "No text extracted",
            }

        except Exception as e:
            return {
                "id": notice_id,
                "title": title,
                "status": "ERROR",
                "reason": str(e),
                "chars": 0,
                "quality_before": q_before,
                "quality_after": q_before,
                "method": "none",
                "is_ocr": False,
            }
        finally:
            try:
                os.unlink(tmp_path)
            except Exception:
                pass


async def main():
    parser = argparse.ArgumentParser(description="Fix and re-extract messy & broken notices via OCR/poppler.")
    parser.add_argument("--scan-only", action="store_true", help="Only scan catalogue and display health diagnosis without modifying.")
    parser.add_argument("--scope", choices=["garbled", "broken", "messy", "unreadable", "all"], default="garbled",
                        help="Which notices to re-extract (default: garbled = messy + broken with attachments).")
    parser.add_argument("--source", type=str, default=None, help="Filter notices by source name (substring match).")
    parser.add_argument("--limit", type=int, default=None, help="Maximum number of notices to process.")
    parser.add_argument("--concurrency", type=int, default=2, help="Number of concurrent extractions (default: 2).")
    parser.add_argument("--dry-run", action="store_true", help="Perform extraction without writing updates to PostgreSQL.")
    parser.add_argument("--timeout", type=int, default=45, help="HTTP download timeout in seconds (default: 45).")
    args = parser.parse_args()

    print("🔌 Connecting to PostgreSQL...")
    pool = await asyncpg.create_pool(DB_URL, min_size=2, max_size=10)

    try:
        scan = await run_scan(pool)

        # ── Health Diagnostic Table ──
        total = scan["total"]
        health_rows = [
            ["Total Notices in Catalogue", f"{total:,}", "100.0%"],
            ["Clean Extractions (Readable >= 0.55)", f"{scan['clean']:,}", f"{(scan['clean']/total*100):.1f}%"],
            ["Messy Extractions (Garbled 0 < q < 0.55)", f"{scan['messy']:,}", f"{(scan['messy']/total*100):.1f}%"],
            ["Broken Extractions (Empty / q = 0.0)", f"{scan['broken']:,}", f"{(scan['broken']/total*100):.1f}%"],
            ["Notices With Extractable PDF/Image", f"{scan['with_attachment']:,}", f"{(scan['with_attachment']/total*100):.1f}%"],
            ["Actionable Messy (Has Attachment)", f"{scan['actionable_messy']:,}", f"{(scan['actionable_messy']/total*100):.1f}%"],
            ["Actionable Broken (Has Attachment)", f"{scan['actionable_broken']:,}", f"{(scan['actionable_broken']/total*100):.1f}%"],
            ["🎯 Actionable Repair Queue", f"{scan['actionable_total']:,}", f"{(scan['actionable_total']/total*100):.1f}%"],
        ]

        print("\n" + "=" * 65)
        print("  📊 SUCHANA AI — CATALOGUE EXTRACTION HEALTH SCAN")
        print("=" * 65)
        print(format_table(["Catalogue Metric", "Count", "Share"], health_rows, alignments=["left", "right", "right"]))

        # Top sources with fixable items
        top_sources = sorted(
            [(s, data) for s, data in scan["source_stats"].items() if data["fixable"] > 0],
            key=lambda x: x[1]["fixable"],
            reverse=True,
        )[:8]

        if top_sources:
            print("\n📌 Top Sources With Messy/Broken Attachments:")
            source_rows = [
                [s[:35], f"{d['total']:,}", f"{d['clean']:,}", f"{d['messy']:,}", f"{d['broken']:,}", f"⭐ {d['fixable']:,}"]
                for s, d in top_sources
            ]
            print(format_table(["Source Portal", "Total", "Clean", "Messy", "Broken", "Fixable"], source_rows, alignments=["left", "right", "right", "right", "right", "right"]))

        if args.scan_only:
            print("\n✅ Scan complete (--scan-only specified). Exiting without changes.")
            return

        # Filter queue based on scope and source
        catalog = scan["catalog"]
        if args.source:
            s_lower = args.source.lower()
            catalog = [it for it in catalog if s_lower in it["source_label"].lower()]
            print(f"\n🎯 Filtered to source matching '{args.source}': {len(catalog)} notices.")

        if args.scope == "broken":
            queue = [it for it in catalog if it["class_before"] == "BROKEN" and it["extractable_url"]]
        elif args.scope == "messy":
            queue = [it for it in catalog if it["class_before"] == "MESSY" and it["extractable_url"]]
        elif args.scope == "unreadable":
            queue = [it for it in catalog if not is_readable_text(it["content_text"] or "") and it["extractable_url"]]
        elif args.scope == "all":
            queue = [it for it in catalog if it["extractable_url"]]
        else:  # garbled (default)
            queue = [it for it in catalog if it["class_before"] != "CLEAN" and it["extractable_url"]]

        if args.limit:
            queue = queue[:args.limit]

        if not queue:
            print("\n🎉 No notices matched the requested scope. All extractions are clean!")
            return

        print(f"\n🚀 Starting extraction queue ({len(queue)} items, scope='{args.scope}', concurrency={args.concurrency}, dry_run={args.dry_run})...\n")

        sem = asyncio.Semaphore(args.concurrency)
        stats = {
            "processed": 0,
            "clean_now": 0,
            "improved": 0,
            "ocr_used": 0,
            "empty": 0,
            "failed": 0,
            "chars_recovered": 0,
        }

        # Execution table header
        print(f"{'#':<4} {'ID (Short)':<10} {'Quality':<12} {'Chars':<8} {'Method':<14} {'Status':<12} {'Title':<35}")
        print("-" * 105)

        start_time = time.time()
        connector = aiohttp.TCPConnector(limit=args.concurrency * 2, ssl=False)
        async with aiohttp.ClientSession(connector=connector) as session:
            tasks = [
                process_notice(sem, session, pool, item, dry_run=args.dry_run, timeout=args.timeout)
                for item in queue
            ]

            for i, fut in enumerate(asyncio.as_completed(tasks), 1):
                res = await fut
                stats["processed"] += 1
                q_b = res["quality_before"]
                q_a = res["quality_after"]
                st = res["status"]
                chars = res["chars"]
                method = res["method"]
                is_ocr = res["is_ocr"]
                title_preview = (res["title"] or "")[:33]

                if is_ocr:
                    stats["ocr_used"] += 1
                if st in ("CLEAN", "IMPROVED"):
                    if st == "CLEAN":
                        stats["clean_now"] += 1
                    else:
                        stats["improved"] += 1
                    stats["chars_recovered"] += chars
                elif st in ("EMPTY", "LOW_QUALITY"):
                    stats["empty"] += 1
                else:
                    stats["failed"] += 1

                q_str = f"{q_b:.2f} -> {q_a:.2f}"
                ch_str = f"+{chars:,}" if chars > 0 else "0"
                short_id = res["id"][:8]

                status_tag = (
                    "✅ CLEAN" if st == "CLEAN"
                    else "✨ IMPROVED" if st == "IMPROVED"
                    else "⚠️ EMPTY" if st == "EMPTY"
                    else "❌ FAILED" if "FAIL" in st or st == "ERROR"
                    else f"🟡 {st}"
                )

                print(f"{i:<4} {short_id:<10} {q_str:<12} {ch_str:<8} {method[:13]:<14} {status_tag:<12} {title_preview:<35}")

        elapsed = time.time() - start_time
        print("-" * 105)

        # ── Final Summary Table ──
        summary_rows = [
            ["Total Queued & Processed", f"{stats['processed']:,}"],
            ["Successfully Cleaned (q >= 0.55)", f"{stats['clean_now']:,}"],
            ["Improved Extractions", f"{stats['improved']:,}"],
            ["OCR Triggered (Tesseract)", f"{stats['ocr_used']:,}"],
            ["Total Characters Recovered", f"{stats['chars_recovered']:,}"],
            ["Empty / Scanned Without Text", f"{stats['empty']:,}"],
            ["Download / Network Failures", f"{stats['failed']:,}"],
            ["Elapsed Time", f"{elapsed:.1f}s ({elapsed/max(1,stats['processed']):.2f}s/item)"],
            ["Database Write Mode", "DRY-RUN (No DB updates)" if args.dry_run else "LIVE (Database updated)"],
        ]

        print("\n" + "=" * 65)
        print("  🎉 EXTRACTION REPAIR RUN COMPLETE")
        print("=" * 65)
        print(format_table(["Result Metric", "Value"], summary_rows, alignments=["left", "right"]))

    finally:
        await pool.close()
        print("\n🔒 Database pool closed.")


if __name__ == "__main__":
    asyncio.run(main())
