#!/usr/bin/env python3
"""update_sources_from_manifest.py - Sync scrape_sources table with suchanaai-source-routes-2026-09-26.json.

Updates:
  - notice_list_url, news_list_url, press_release_list_url with verified URLs
  - max_pages based on minimumObserved / total pages (up to 120+)
  - enabled = true for sources with verified routes
  - full routes metadata in last_diagnosis for downstream reference
"""

import asyncio
import json
import os
import sys
import uuid
from pathlib import Path

# Paths
REPO_ROOT = Path(__file__).resolve().parent.parent
MANIFEST_PATH = REPO_ROOT / "apps" / "ai" / "scripts" / "suchanaai-source-routes-2026-09-26.json"

from dotenv import load_dotenv
load_dotenv(REPO_ROOT / "apps" / "api" / ".env")
load_dotenv(REPO_ROOT / "apps" / "ai" / ".env")

import asyncpg

DEFAULT_DB_URL = "postgresql://postgres:ChangeThisPassword123!@141.148.209.235:5432/public_notice_management"
DB_URL = os.environ.get("DATABASE_URL") or DEFAULT_DB_URL


async def main():
    if not MANIFEST_PATH.exists():
        print(f"Error: Manifest file not found at {MANIFEST_PATH}")
        sys.exit(1)

    with open(MANIFEST_PATH, "r", encoding="utf-8") as f:
        manifest = json.load(f)

    sources = manifest.get("sources", [])
    print(f"Loaded {len(sources)} sources from {MANIFEST_PATH.name}")

    conn = await asyncpg.connect(DB_URL)
    print("Connected to PostgreSQL database.")

    updated_count = 0
    for s in sources:
        sid_str = s.get("id")
        name = s.get("name")
        review_status = s.get("reviewStatus")
        routes = s.get("routes", [])

        if not sid_str:
            continue

        sid = uuid.UUID(sid_str)

        # Primary routes mapping
        notice_url = None
        news_url = None
        press_url = None
        max_pages = 20

        for r in routes:
            kind = (r.get("kind") or "").upper()
            url = r.get("listUrl")
            pc = r.get("pageCount") or {}
            min_p = pc.get("minimumObserved") or pc.get("total") or 20
            if min_p > max_pages:
                max_pages = min_p

            if kind == "NOTICE" and not notice_url:
                notice_url = url
            elif kind == "NEWS" and not news_url:
                news_url = url
            elif kind in ("PRESS_RELEASE", "BULLETIN", "TENDER") and not press_url:
                press_url = url

        # If notice_url is still empty but we have any route, use the first route as notice_url
        if not notice_url and routes:
            notice_url = routes[0].get("listUrl")

        # Enable source if it has at least one valid route
        has_routes = bool(routes and any(r.get("listUrl") for r in routes))
        should_enable = has_routes and review_status in ("archive_located", "active", "needs_manual_review", "would_update")

        diagnosis_payload = json.dumps({
            "reviewStatus": review_status,
            "manifestDate": manifest.get("observedOn", "2026-09-26"),
            "routes": routes,
        })

        # Update DB row
        res = await conn.execute(
            """
            UPDATE scrape_sources
            SET notice_list_url = COALESCE($2::text, notice_list_url),
                news_list_url = COALESCE($3::text, news_list_url),
                press_release_list_url = COALESCE($4::text, press_release_list_url),
                max_pages = GREATEST(max_pages, $5::integer),
                enabled = CASE WHEN $6::boolean THEN true ELSE enabled END,
                last_diagnosis = $7::jsonb,
                updated_at = NOW()
            WHERE id = $1::uuid
            """,
            sid,
            notice_url,
            news_url,
            press_url,
            max_pages,
            should_enable,
            diagnosis_payload,
        )

        if "UPDATE 1" in res:
            updated_count += 1
            print(f"  ✓ Updated [{sid_str}] {name}: {len(routes)} routes (max_pages: {max_pages}, enabled: {should_enable})")
        else:
            print(f"  - No match in DB for [{sid_str}] {name}")

    print(f"\nSuccessfully updated {updated_count} / {len(sources)} sources in PostgreSQL.")
    await conn.close()


if __name__ == "__main__":
    asyncio.run(main())
