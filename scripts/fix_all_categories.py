#!/usr/bin/env python3
"""fix_all_categories.py — High-precision categorization repair for all scraped notices.

Re-evaluates every notice in PostgreSQL (`scraped_items`) using multi-signal heuristics:
  1. Title keywords (Devanagari, Romanized Nepali, English).
  2. URL path segments and category slugs.
  3. Content / AI Summary excerpt keywords.
  4. Preserves and normalizes valid existing categories.

Usage:
  python scripts/fix_all_categories.py --dry-run
  python scripts/fix_all_categories.py
  python scripts/fix_all_categories.py --batch-size 500
"""

import argparse
import asyncio
import os
import sys
from collections import Counter
from pathlib import Path
from urllib.parse import urlparse

import asyncpg
from dotenv import load_dotenv

# Ensure root and apps/api env files are loaded
BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / ".env")
load_dotenv(BASE_DIR / "apps" / "api" / ".env")

DB_URL = os.environ.get("DATABASE_URL")
if not DB_URL:
    print("Error: DATABASE_URL not found in environment")
    sys.exit(1)

# Canonical schema enum values
VALID_CATEGORIES = {
    "NOTICE", "NEWS", "PRESS_RELEASE", "CIRCULAR", "TENDER", "VACANCY", "JOB", "INTERNSHIP", "OTHER"
}

# --- Multi-signal Keyword Rules ---

TENDER_KEYWORDS = (
    "बोलपत्र", "सिलबन्दी दरभाउपत्र", "दरभाउपत्र", "ठेक्का", "लिलाम", "खरिद सम्बन्धी",
    "इ-बिडिङ", "आशयको सूचना", "बोलपत्र स्वीकृत", "प्रस्ताव आह्वान", "बोलपत्र फाराम",
    "कोटेशन", "बोलपत्र रद्द", "दरभाउ पत्र", "सिलबन्दी", "बोलपत्र मूल्याङ्कन", "दरभाउपत्र आह्वान",
    "tender", "sealed quotation", "quotation", "e-bidding", "procurement", "bidding",
    "expression of interest", "eoi", "request for proposal", "rfp", "invitation for bid",
    "ifb", "re-tender", "auction", "bid submission", "bid opening", "bolpatra"
)

VACANCY_KEYWORDS = (
    "पदपूर्ति", "कर्मचारी आवश्यकता", "दरखास्त", "नियुक्ति", "विज्ञापन नं", "विज्ञापन सम्बन्धी",
    "लिखित परीक्षा", "अन्तर्वार्ता", "नतिजा प्रकाशन", "सिफारिस सम्बन्धी", "रिक्त पद",
    "सेवा करार", "खुला प्रतियोगिता", "योग्यताक्रम", "पदस्थापन", "परीक्षा तालिका", "प्रवेशपत्र",
    "करार सेवा", "रोजगार", "उम्मेदवार", "रोष्टर", "प्राविधिक अधिकृत", "सहायक स्तर",
    "vacancy", "vacancies", "recruitment", "career", "careers", "job opening",
    "hiring", "written exam", "interview result", "appointment", "karmachari"
)

PRESS_KEYWORDS = (
    "प्रेस विज्ञप्ति", "प्रेस नोट", "प्रेस-विज्ञप्ति", "पत्रकार सम्मेलन", "प्रेस वक्तव्य",
    "प्रेस रिलिज", "विज्ञप्ति", "प्रेस नोटः", "संयुक्त वक्तव्य", "विज्ञप्ती",
    "press release", "press note", "press statement", "media release", "press-release",
    "pressrelease", "press conference", "joint communique", "official statement"
)

CIRCULAR_KEYWORDS = (
    "परिपत्र", "निर्देशिका", "कार्यविधि", "मापदण्ड", "विनियमावली", "निर्देशन सम्बन्धी",
    "आदेश", "राजपत्र", "ऐन तथा नियम", "मार्गदर्शन", "प्रक्रियागत", "सञ्चालन कार्यविधि",
    "circular", "directive", "directives", "guideline", "guidelines", "paripatra", "manual",
    "regulation", "standard operating", "directives-guidelines"
)

NEWS_KEYWORDS = (
    "समाचार", "ताजा समाचार", "बुलेटिन", "गतिविधि", "कार्यक्रम सम्बन्धी", "वार्षिक प्रतिवेदन",
    "समीक्षा गोष्ठी", "उद्घाटन", "समारोह",
    "news", "bulletin", "newsletter", "events", "activities", "monthly bulletin",
    "quarterly bulletin", "annual report"
)

NOTICE_KEYWORDS = (
    "सूचना", "सुचना", "सार्वजनिक सूचना", "अत्यावश्यक", "जानकारी", "विवरण", "छपाई भएका",
    "सवारी चालक अनुमतिपत्र", "सवारी", "स्मार्ट कार्ड", "लाइसेन्स", "निर्णय", "सूचना पाटी",
    "तालिम", "छात्रवृत्ति", "नतिजा", "अनुमोदन", "प्रतिवेदन", "प्रकाशन", "सवारी साधन",
    "notice", "suchana", "announcement", "license", "driving license", "information",
    "public notice", "decision", "result", "scholarship", "training", "schedule",
    "details-of-printed-licenses", "printed-license"
)


def extract_url_slug(url: str | None) -> str:
    if not url:
        return ""
    try:
        path = urlparse(url).path.strip("/")
        segments = [s for s in path.split("/") if s and not s.isdigit()]
        return segments[-1].lower() if segments else ""
    except Exception:
        return ""


def classify_record(title: str | None, content: str | None, url: str | None, current_category: str | None) -> str:
    title_l = (title or "").lower()
    url_l = (url or "").lower()
    slug = extract_url_slug(url)
    text_excerpt = ((content or "")[:1200] + " " + (title or "")).lower()

    # 1. Tender
    if any(kw in title_l for kw in TENDER_KEYWORDS) or (slug and any(kw in slug for kw in ("tender", "bid", "quotation", "procurement", "bolpatra"))):
        return "TENDER"

    # 2. Vacancy / Job
    if any(kw in title_l for kw in VACANCY_KEYWORDS) or (slug and any(kw in slug for kw in ("vacancy", "recruitment", "career", "job", "padpurti"))):
        is_vacancy = any(w in title_l or w in slug for w in ("vacancy", "दरखास्त", "विज्ञापन", "परीक्षा", "उम्मेदवार", "पदपूर्ति"))
        return "VACANCY" if is_vacancy else "JOB"

    # 3. Press Release
    if any(kw in title_l for kw in PRESS_KEYWORDS) or (slug and any(kw in slug for kw in ("press-release", "pressrelease", "press_release", "press-note", "media-release"))):
        return "PRESS_RELEASE"

    # 4. Circular
    if any(kw in title_l for kw in CIRCULAR_KEYWORDS) or (slug and any(kw in slug for kw in ("circular", "directive", "guideline", "paripatra", "manual"))):
        return "CIRCULAR"

    # 5. News / Bulletin
    if any(kw in title_l for kw in NEWS_KEYWORDS) or (slug and any(kw in slug for kw in ("news", "bulletin", "newsletter", "samachar", "events"))):
        return "NEWS"

    # 6. Notice / Licenses
    if any(kw in title_l for kw in NOTICE_KEYWORDS) or (slug and any(kw in slug for kw in ("notice", "suchana", "announcement", "license", "details-of-printed-licenses"))):
        return "NOTICE"

    # 7. Check if current category is already specific and valid
    if current_category in ("TENDER", "VACANCY", "JOB", "PRESS_RELEASE", "CIRCULAR", "NEWS", "NOTICE"):
        return current_category

    # 8. Deeper check on combined text excerpt
    if any(kw in text_excerpt for kw in TENDER_KEYWORDS[:8]):
        return "TENDER"
    if any(kw in text_excerpt for kw in VACANCY_KEYWORDS[:8]):
        return "VACANCY"
    if any(kw in text_excerpt for kw in PRESS_KEYWORDS[:5]):
        return "PRESS_RELEASE"
    if any(kw in text_excerpt for kw in CIRCULAR_KEYWORDS[:5]):
        return "CIRCULAR"
    if any(kw in text_excerpt for kw in NEWS_KEYWORDS[:4]):
        return "NEWS"

    # Government documents default to NOTICE
    return "NOTICE"


async def main():
    parser = argparse.ArgumentParser(description="Fix categories of all scraped notices in database.")
    parser.add_argument("--dry-run", action="store_true", help="Preview classification changes without writing to DB")
    parser.add_argument("--batch-size", type=int, default=500, help="Batch update size (default: 500)")
    args = parser.parse_args()

    print("Connecting to PostgreSQL database...")
    conn = await asyncpg.connect(DB_URL)
    print("Connected successfully.")

    try:
        print("Fetching all scraped items...")
        rows = await conn.fetch(
            "SELECT id, title, source_url, category, LEFT(content_text, 1200) as content_preview FROM scraped_items"
        )
        total_items = len(rows)
        print(f"Loaded {total_items} notices for evaluation.\n")

        before_counts = Counter()
        after_counts = Counter()
        transitions = Counter()
        updates_to_make = []

        for r in rows:
            item_id = r["id"]
            title = r["title"]
            url = r["source_url"]
            curr_cat = r["category"] or "OTHER"
            content = r["content_preview"]

            new_cat = classify_record(title, content, url, curr_cat)

            before_counts[curr_cat] += 1
            after_counts[new_cat] += 1

            if new_cat != curr_cat:
                transitions[f"{curr_cat} -> {new_cat}"] += 1
                updates_to_make.append((new_cat, item_id))

        print("=" * 65)
        print("CATEGORY DISTRIBUTION COMPARISON")
        print("=" * 65)
        all_cats = sorted(set(list(before_counts.keys()) + list(after_counts.keys())))
        print(f"{'Category':<18} {'Before':<10} {'After':<10} {'Change':<10}")
        print("-" * 55)
        for cat in all_cats:
            b = before_counts[cat]
            a = after_counts[cat]
            diff = a - b
            diff_str = f"+{diff}" if diff > 0 else f"{diff}"
            print(f"{cat:<18} {b:<10} {a:<10} {diff_str:<10}")

        print("\n" + "=" * 65)
        print("TOP CATEGORY RECLASSIFICATIONS")
        print("=" * 65)
        for trans, count in transitions.most_common(15):
            print(f"  {trans:<32}: {count} item(s)")

        total_changed = len(updates_to_make)
        print("\n" + "=" * 65)
        print(f"SUMMARY: {total_changed} out of {total_items} items ({(total_changed/max(1, total_items))*100:.1f}%) will be reclassified.")
        print("=" * 65)

        if args.dry_run:
            print("\n[DRY RUN] No database writes were performed. Run without --dry-run to apply.")
            return

        if not updates_to_make:
            print("\nAll categories are already correctly assigned. Nothing to update.")
            return

        print(f"\nApplying {total_changed} category updates to PostgreSQL in batches of {args.batch_size}...")
        for i in range(0, total_changed, args.batch_size):
            chunk = updates_to_make[i : i + args.batch_size]
            # Execute batch update using executemany with explicit cast
            await conn.executemany(
                """
                UPDATE scraped_items
                SET category = $1::"ScrapedItemCategory",
                    updated_at = NOW()
                WHERE id = $2::uuid
                """,
                chunk,
            )
            print(f"  ✓ Updated {min(i + args.batch_size, total_changed)} / {total_changed} items...")

        print(f"\n✓ Successfully updated {total_changed} notices in PostgreSQL database.")

    finally:
        await conn.close()
        print("Database connection closed.")


if __name__ == "__main__":
    asyncio.run(main())
