#!/usr/bin/env python3
"""sync_all_news.py - End-to-end scraper, DB-first ingestion, AI summarizer, and vector embedder.

Architecture:
  Scrape → normalize/dedupe → DB FIRST → asynchronous/best-effort AI enrichment → Qdrant embedding

Core Invariant:
  A successfully scraped notice MUST NEVER be lost, skipped, or prevented from being stored
  because an LLM provider is unavailable, rate-limited, or throwing errors.
  The raw notice is safely persisted to PostgreSQL before any enrichment is attempted.

AI Summarization Providers (Sequential fallback, no hedged racing):
  1. Cloudflare Workers AI (Default: @cf/ibm-granite/granite-4.0-h-micro, configurable)
  2. Google Gemini (Flash-Lite)
  3. Groq (Sequential single-key)
  * OpenCode Go is deliberately excluded from synchronization.

Usage:
  # Run all enabled sources (deep crawl, up to 20 pages per source):
  python scripts/sync_all_news.py --deep

  # Run a single source by name or ID:
  python scripts/sync_all_news.py --source "moha" --deep
  python scripts/sync_all_news.py --source "Nepal Rastra Bank" --max-pages 5

  # Run with custom concurrency and page limits:
  python scripts/sync_all_news.py --deep --max-pages 10 --concurrency 2

  # Dry run (crawl and preview without writing to DB or Qdrant):
  python scripts/sync_all_news.py --source "mofa" --max-pages 1 --dry-run

  # Process pending or retry queue (background / worker mode):
  python scripts/sync_all_news.py --process-queue

  # Backfill missing AI summaries and Qdrant vectors:
  python scripts/sync_all_news.py --backfill-missing
"""

import argparse
import asyncio
import datetime
import hashlib
import json
import os
import signal
import sys
import time
import uuid
from pathlib import Path
from typing import Optional, Tuple

# Ensure project root and apps/ai are on python path
REPO_ROOT = Path(__file__).resolve().parent.parent
AI_APP_DIR = REPO_ROOT / "apps" / "ai"
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))
if str(AI_APP_DIR) not in sys.path:
    sys.path.insert(0, str(AI_APP_DIR))

# Load environment variables
from dotenv import load_dotenv

# Try apps/ai/.env then apps/api/.env
load_dotenv(AI_APP_DIR / ".env")
load_dotenv(REPO_ROOT / "apps" / "api" / ".env")

import asyncpg
from app import browser_pool, config, embeddings, notice_store, scraper
from app.ai_providers import NoticeSummarizer
from app.logger import get_logger

logger = get_logger("sync_all_news")

# Database connection URL
DEFAULT_DB_URL = "postgresql://postgres:ChangeThisPassword123!@141.148.209.235:5432/public_notice_management"
DB_URL = os.environ.get("DATABASE_URL") or DEFAULT_DB_URL

# Colors for terminal output
CYAN = "\033[96m"
GREEN = "\033[92m"
YELLOW = "\033[93m"
RED = "\033[91m"
MAGENTA = "\033[95m"
BOLD = "\033[1m"
DIM = "\033[2m"
RESET = "\033[0m"

# Valid Category enum values in PostgreSQL
VALID_CATEGORIES = {
    "NOTICE", "NEWS", "PRESS_RELEASE", "CIRCULAR", "TENDER",
    "VACANCY", "JOB", "INTERNSHIP", "OTHER",
}

# Exponential retry backoff in seconds:
# Attempt 1: immediate (handled during ingestion)
# Attempt 2: +2 min (120s)
# Attempt 3: +10 min (600s)
# Attempt 4: +30 min (1800s)
# Attempt 5: +2 hours (7200s)
# Attempt 6: +6 hours (21600s)
# Attempt >= 6: mark failed
RETRY_DELAYS = {
    1: 120,
    2: 600,
    3: 1800,
    4: 7200,
    5: 21600,
}


def get_retry_delay_seconds(attempts: int) -> int:
    return RETRY_DELAYS.get(attempts, 21600)


def compute_content_hash(title: str, content: str | None) -> str:
    return hashlib.sha256(f"{title}|{content or ''}".encode("utf-8")).hexdigest()


class SyncPipeline:
    def __init__(self, args: argparse.Namespace):
        self.args = args
        self.db_pool: Optional[asyncpg.Pool] = None
        self.summarizer = NoticeSummarizer()
        self.interrupted = False
        self.stats = {
            "sources_processed": 0,
            "sources_failed": 0,
            "notices_found": 0,
            "notices_raw_persisted": 0,
            "notices_raw_updated": 0,
            "notices_skipped": 0,
            "notices_persist_failed": 0,
            "notices_summarized": 0,
            "notices_summary_retry": 0,
            "notices_summary_failed": 0,
            "notices_embedded": 0,
            "notices_embedding_retry": 0,
            "notices_embedding_failed": 0,
        }

    async def init(self):
        """Initializes database pool and verifies Qdrant collection."""
        print(f"{BOLD}{CYAN}=== Initializing Public Notice Sync Pipeline (DB-FIRST) ==={RESET}")
        print(f"  {BOLD}PostgreSQL:{RESET} {DB_URL.split('@')[-1] if '@' in DB_URL else DB_URL}")
        print(f"  {BOLD}Qdrant:{RESET}     {config.QDRANT_URL} (Collection: notices)")
        print(f"  {BOLD}Embeddings:{RESET} {config.EMBEDDING_MODEL} ({config.EMBEDDING_DIM}d)")
        print(f"  {BOLD}AI Providers in fallback order:{RESET}")
        for idx, p in enumerate(self.summarizer.providers, 1):
            avail_str = f"{GREEN}Available{RESET}" if p.is_available else f"{RED}Disabled ({p.disabled_reason}){RESET}"
            print(f"    {idx}. {p.name.upper()} ({p.model}) → {avail_str}")
        print(f"  {BOLD}Dry Run:{RESET}    {'YES (No DB or Qdrant writes)' if self.args.dry_run else 'NO (Live writes)'}")
        print(f"  {BOLD}Deep Crawl:{RESET} {self.args.deep} (Max Pages: {self.args.max_pages})")
        print()

        self.db_pool = await asyncpg.create_pool(DB_URL, min_size=1, max_size=5)

        if not self.args.dry_run and not self.args.skip_embed:
            # Ensure Qdrant collection exists
            print(f"  {DIM}Verifying Qdrant 'notices' collection...{RESET}")
            try:
                notice_store.ensure_collection()
                print(f"  {GREEN}✓ Qdrant collection ready.{RESET}")
            except Exception as e:
                logger.warning("Could not verify Qdrant collection: %s", e)
                print(f"  {YELLOW}⚠ Qdrant warning: {e}. Raw notices will still be saved to DB.{RESET}")

        print(f"  {GREEN}✓ Database pool connected.{RESET}\n")

    async def close(self):
        """Closes database pool cleanly."""
        if self.db_pool:
            await self.db_pool.close()

    async def get_sources(self) -> list[dict]:
        """Fetches scrape sources based on CLI filters."""
        async with self.db_pool.acquire() as conn:
            if self.args.source:
                filter_val = f"%{self.args.source}%"
                rows = await conn.fetch(
                    """
                    SELECT id, name, base_url, notice_list_url, news_list_url,
                           press_release_list_url, max_pages, pagination_type,
                           pagination_param, start_page, notice_schema,
                           news_schema, press_release_schema, enabled
                    FROM scrape_sources
                    WHERE (name ILIKE $1 OR id::text ILIKE $1 OR base_url ILIKE $1)
                    ORDER BY name ASC
                    """,
                    filter_val,
                )
            else:
                rows = await conn.fetch(
                    """
                    SELECT id, name, base_url, notice_list_url, news_list_url,
                           press_release_list_url, max_pages, pagination_type,
                           pagination_param, start_page, notice_schema,
                           news_schema, press_release_schema, enabled
                    FROM scrape_sources
                    WHERE enabled = true
                    ORDER BY last_run_at ASC NULLS FIRST, name ASC
                    """
                )

            sources = [dict(r) for r in rows]
            if self.args.limit_sources and self.args.limit_sources > 0:
                sources = sources[: self.args.limit_sources]
            return sources

    async def get_known_urls_for_source(self, source_id: str) -> set[str]:
        """Returns set of already scraped URLs for this source."""
        async with self.db_pool.acquire() as conn:
            rows = await conn.fetch(
                "SELECT source_url FROM scraped_items WHERE source_id = $1::uuid",
                uuid.UUID(str(source_id)),
            )
            return {r["source_url"] for r in rows if r["source_url"]}

    async def create_scrape_run(self, source: dict) -> Optional[uuid.UUID]:
        """Creates a scrape_run record with RUNNING status."""
        if self.args.dry_run:
            return None
        run_id = uuid.uuid4()
        async with self.db_pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO scrape_runs (id, source_id, source_label, status, started_at)
                VALUES ($1::uuid, $2::uuid, $3::text, 'RUNNING'::"ScrapeRunStatus", NOW())
                """,
                run_id,
                source["id"],
                source["name"],
            )
        return run_id

    async def finish_scrape_run(
        self,
        run_id: Optional[uuid.UUID],
        source: dict,
        status: str,
        error: Optional[str] = None,
        counts: Optional[dict] = None,
    ):
        """Updates scrape_run and scrape_source status on completion."""
        if self.args.dry_run or not run_id:
            return

        c = counts or {}
        async with self.db_pool.acquire() as conn:
            await conn.execute(
                """
                UPDATE scrape_runs
                SET status = $2::"ScrapeRunStatus",
                    finished_at = NOW(),
                    error = $3::text,
                    items_found = $4,
                    items_new = $5,
                    items_updated = $6,
                    items_skipped = $7,
                    items_summarized = $8,
                    items_summary_failed = $9
                WHERE id = $1::uuid
                """,
                run_id,
                status,
                error,
                c.get("found", 0),
                c.get("new", 0),
                c.get("updated", 0),
                c.get("skipped", 0),
                c.get("summarized", 0),
                c.get("summary_failed", 0),
            )

            await conn.execute(
                """
                UPDATE scrape_sources
                SET last_run_at = NOW(),
                    last_status = $2::"ScrapeRunStatus",
                    last_error = $3::text
                WHERE id = $1::uuid
                """,
                source["id"],
                status,
                error,
            )

    async def persist_raw_notice(
        self, source: dict, item
    ) -> Tuple[str, Optional[uuid.UUID], Optional[datetime.datetime], str]:
        """DB FIRST: Persists raw scraped notice immediately into PostgreSQL.

        Returns:
            (outcome, item_id, dt_published, content_hash)
            outcome: 'new' | 'updated' | 'skipped'
        """
        title = (item.title or "").strip()
        source_url = item.source_url
        content_text = item.content_text or ""
        content_html = item.content_html or ""
        published_at = item.published_at

        category = item.category.upper() if item.category else "NOTICE"
        if category not in VALID_CATEGORIES:
            category = "OTHER"

        content_hash = compute_content_hash(title, content_text)

        # Parse published_at date safely
        dt_published = None
        if published_at:
            if isinstance(published_at, datetime.datetime):
                dt_published = published_at
            elif isinstance(published_at, str):
                try:
                    dt_published = datetime.datetime.fromisoformat(published_at.replace("Z", "+00:00"))
                except Exception:
                    pass

        if self.args.dry_run:
            return "new", uuid.uuid4(), dt_published, content_hash

        async with self.db_pool.acquire() as conn:
            existing = await conn.fetchrow(
                """
                SELECT id, content_hash, summary_status, embedding_status
                FROM scraped_items
                WHERE source_url = $1::text
                """,
                source_url,
            )

            if existing:
                item_id = existing["id"]
                existing_hash = existing["content_hash"]
                existing_summary_status = existing["summary_status"]
                existing_embedding_status = existing["embedding_status"]

                # If content hash is unchanged and already completed enrichment, skip
                if (
                    existing_hash == content_hash
                    and existing_summary_status == "completed"
                    and existing_embedding_status == "completed"
                ):
                    return "skipped", item_id, dt_published, content_hash

                # If content changed, update raw notice and mark for re-enrichment
                if existing_hash != content_hash:
                    await conn.execute(
                        """
                        UPDATE scraped_items
                        SET title = $2::text,
                            category = $3::"ScrapedItemCategory",
                            source_slug = $4::text,
                            summary = $5::text,
                            content_text = $6::text,
                            content_html = $7::text,
                            attachment_url = $8::text,
                            published_at = COALESCE($9::timestamp, published_at),
                            content_hash = $10::text,
                            summary_status = 'pending',
                            summary_attempts = 0,
                            summary_error = NULL,
                            next_summary_retry_at = NULL,
                            embedding_status = 'pending',
                            embedding_attempts = 0,
                            embedding_error = NULL,
                            next_embedding_retry_at = NULL,
                            updated_at = NOW()
                        WHERE id = $1::uuid
                        """,
                        item_id,
                        title,
                        category,
                        getattr(item, "source_slug", None),
                        getattr(item, "summary", None) or (content_text[:400] if content_text else title),
                        content_text,
                        content_html,
                        getattr(item, "attachment_url", None),
                        dt_published,
                        content_hash,
                    )
                    outcome = "updated"
                else:
                    outcome = "updated"
            else:
                # Completely new notice -> INSERT RAW FIRST
                item_id = uuid.uuid4()
                await conn.execute(
                    """
                    INSERT INTO scraped_items (
                        id, source_id, source_label, category, source_slug,
                        title, source_url, summary, content_text, content_html,
                        attachment_url, published_at, content_hash, views,
                        summary_status, summary_attempts,
                        embedding_status, embedding_attempts,
                        scraped_at, updated_at
                    ) VALUES (
                        $1::uuid, $2::uuid, $3::text, $4::"ScrapedItemCategory", $5::text,
                        $6::text, $7::text, $8::text, $9::text, $10::text,
                        $11::text, $12::timestamp, $13::text, 0,
                        'pending', 0,
                        'pending', 0,
                        NOW(), NOW()
                    )
                    ON CONFLICT (source_url) DO UPDATE
                    SET title = EXCLUDED.title,
                        content_text = EXCLUDED.content_text,
                        content_html = EXCLUDED.content_html,
                        content_hash = EXCLUDED.content_hash,
                        updated_at = NOW()
                    """,
                    item_id,
                    source["id"],
                    source["name"],
                    category,
                    getattr(item, "source_slug", None),
                    title,
                    source_url,
                    getattr(item, "summary", None) or (content_text[:400] if content_text else title),
                    content_text,
                    content_html,
                    getattr(item, "attachment_url", None),
                    dt_published,
                    content_hash,
                )
                outcome = "new"

            # Insert attachments if present
            if getattr(item, "attachments", None):
                for att in item.attachments:
                    att_url = att.url if hasattr(att, "url") else att.get("url")
                    att_label = att.label if hasattr(att, "label") else att.get("label")
                    if att_url:
                        await conn.execute(
                            """
                            INSERT INTO attachments (id, item_id, url, label, created_at)
                            VALUES ($1::uuid, $2::uuid, $3::text, $4::text, NOW())
                            ON CONFLICT DO NOTHING
                            """,
                            uuid.uuid4(),
                            item_id,
                            att_url,
                            att_label,
                        )

            return outcome, item_id, dt_published, content_hash

    async def enrich_notice(
        self,
        item_id: uuid.UUID,
        title: str,
        content_text: str,
        category: str,
        source_label: str,
        source_url: str,
        dt_published: Optional[datetime.datetime],
    ) -> Tuple[bool, bool]:
        """Asynchronous / Best-effort AI enrichment + vector indexing.

        This method NEVER raises an exception that could fail the scrape run.
        On failure, the notice is safely preserved in DB and scheduled for retry.

        Returns:
            (summarized_ok, embedded_ok)
        """
        if self.args.dry_run:
            return True, True

        summarized_ok = False
        embedded_ok = False

        # Check current status and attempts
        async with self.db_pool.acquire() as conn:
            curr = await conn.fetchrow(
                """
                SELECT summary_status, summary_attempts, embedding_status, embedding_attempts, ai_summary
                FROM scraped_items
                WHERE id = $1::uuid
                """,
                item_id,
            )
            if not curr:
                return False, False

            summary_status = curr["summary_status"]
            summary_attempts = curr["summary_attempts"] or 0
            embedding_status = curr["embedding_status"]
            embedding_attempts = curr["embedding_attempts"] or 0
            existing_ai_summary = curr["ai_summary"]

        # ── 1. AI Summarization ──────────────────────────────────────────
        ai_summary = existing_ai_summary
        if summary_status != "completed" and content_text and not self.args.skip_summarize:
            try:
                analysis, provider_name, model_name, err = await self.summarizer.summarize(
                    title=title, content=content_text, category_hint=category
                )

                if analysis and analysis.get("summary"):
                    ai_summary = analysis.get("summary")
                    ai_summary_ne = analysis.get("summary_ne")
                    ai_urgency = analysis.get("urgency", "LOW")
                    ai_category_confidence = analysis.get("category_confidence", 0.8)
                    resolved_category = analysis.get("category") or category
                    if resolved_category not in VALID_CATEGORIES:
                        resolved_category = category
                    key_facts = analysis.get("key_facts", [])
                    tags = analysis.get("tags", [])

                    async with self.db_pool.acquire() as conn:
                        await conn.execute(
                            """
                            UPDATE scraped_items
                            SET ai_summary = $2::text,
                                ai_summary_ne = $3::text,
                                ai_urgency = $4::text,
                                ai_category_confidence = $5::float8,
                                key_facts = $6::jsonb,
                                tags = $7::jsonb,
                                category = COALESCE($8::"ScrapedItemCategory", category),
                                summary_status = 'completed',
                                summary_attempts = summary_attempts + 1,
                                summary_provider = $9::text,
                                summary_model = $10::text,
                                summary_error = NULL,
                                summary_updated_at = NOW(),
                                next_summary_retry_at = NULL,
                                ai_analyzed_at = NOW(),
                                updated_at = NOW()
                            WHERE id = $1::uuid
                            """,
                            item_id,
                            ai_summary,
                            ai_summary_ne,
                            ai_urgency,
                            ai_category_confidence,
                            json.dumps(key_facts) if key_facts else None,
                            json.dumps(tags) if tags else None,
                            resolved_category,
                            provider_name,
                            model_name,
                        )
                    summarized_ok = True
                else:
                    # Summarization failed: schedule retry with exponential backoff
                    new_attempts = summary_attempts + 1
                    delay_secs = get_retry_delay_seconds(new_attempts)
                    final_failure = new_attempts >= 6
                    err_msg = str(err or "Failed to generate valid summary")[:400]

                    async with self.db_pool.acquire() as conn:
                        await conn.execute(
                            f"""
                            UPDATE scraped_items
                            SET summary_status = $2::text,
                                summary_attempts = summary_attempts + 1,
                                summary_error = $3::text,
                                summary_updated_at = NOW(),
                                next_summary_retry_at = {'NULL' if final_failure else f"NOW() + INTERVAL '{delay_secs} seconds'"},
                                updated_at = NOW()
                            WHERE id = $1::uuid
                            """,
                            item_id,
                            "failed" if final_failure else "retry",
                            err_msg,
                        )
                    logger.warning("Summary enrichment failed for %s (%s). Retry in %ds", item_id, err_msg, delay_secs)
            except Exception as e:
                logger.exception("Unexpected exception in AI summarization for %s: %s", item_id, e)
        elif summary_status == "completed":
            summarized_ok = True

        # ── 2. Vector Embedding (Qdrant) ─────────────────────────────────
        if embedding_status != "completed" and not self.args.skip_embed:
            try:
                qdrant_payload = {
                    "id": str(item_id),
                    "title": title,
                    "ai_summary": ai_summary or "",
                    "content": content_text[:3000],
                    "category": category,
                    "source_label": source_label,
                    "source_url": source_url,
                    "published_at": dt_published.isoformat() if dt_published else None,
                }
                indexed, failed = notice_store.index_notices([qdrant_payload])
                if indexed > 0:
                    async with self.db_pool.acquire() as conn:
                        await conn.execute(
                            """
                            UPDATE scraped_items
                            SET embedding_status = 'completed',
                                embedding_attempts = embedding_attempts + 1,
                                embedding_error = NULL,
                                embedding_updated_at = NOW(),
                                next_embedding_retry_at = NULL,
                                updated_at = NOW()
                            WHERE id = $1::uuid
                            """,
                            item_id,
                        )
                    embedded_ok = True
                else:
                    new_emb_attempts = embedding_attempts + 1
                    delay_secs = get_retry_delay_seconds(new_emb_attempts)
                    final_emb_failure = new_emb_attempts >= 6
                    err_text = f"Qdrant returned 0 indexed points: {failed}"

                    async with self.db_pool.acquire() as conn:
                        await conn.execute(
                            f"""
                            UPDATE scraped_items
                            SET embedding_status = $2::text,
                                embedding_attempts = embedding_attempts + 1,
                                embedding_error = $3::text,
                                embedding_updated_at = NOW(),
                                next_embedding_retry_at = {'NULL' if final_emb_failure else f"NOW() + INTERVAL '{delay_secs} seconds'"},
                                updated_at = NOW()
                            WHERE id = $1::uuid
                            """,
                            item_id,
                            "failed" if final_emb_failure else "retry",
                            err_text[:400],
                        )
            except Exception as e:
                logger.warning("Qdrant indexing failed for %s: %s", item_id, e)
                new_emb_attempts = embedding_attempts + 1
                delay_secs = get_retry_delay_seconds(new_emb_attempts)
                final_emb_failure = new_emb_attempts >= 6
                async with self.db_pool.acquire() as conn:
                    await conn.execute(
                        f"""
                        UPDATE scraped_items
                        SET embedding_status = $2::text,
                            embedding_attempts = embedding_attempts + 1,
                            embedding_error = $3::text,
                            embedding_updated_at = NOW(),
                            next_embedding_retry_at = {'NULL' if final_emb_failure else f"NOW() + INTERVAL '{delay_secs} seconds'"},
                            updated_at = NOW()
                        WHERE id = $1::uuid
                        """,
                        item_id,
                        "failed" if final_emb_failure else "retry",
                        str(e)[:400],
                    )
        elif embedding_status == "completed":
            embedded_ok = True

        return summarized_ok, embedded_ok

    async def sync_source(self, source: dict, source_idx: int, total_sources: int):
        """Scrapes, stores DB FIRST, and enriches 1 source across listing pages."""
        source_id = source["id"]
        source_name = source["name"]
        print(f"\n{BOLD}{MAGENTA}======================================================================{RESET}")
        print(f"{BOLD}{MAGENTA}[{source_idx}/{total_sources}] SOURCE: {source_name}{RESET}")
        print(f"  {BOLD}Base URL:{RESET} {source.get('base_url') or source.get('baseUrl')}")
        print(f"{BOLD}{MAGENTA}======================================================================{RESET}")

        base_url = source.get("base_url") or source.get("baseUrl")
        category_urls = {}
        if source.get("notice_list_url"):
            category_urls["NOTICE"] = source["notice_list_url"]
        if source.get("news_list_url"):
            category_urls["NEWS"] = source["news_list_url"]
        if source.get("press_release_list_url"):
            category_urls["PRESS_RELEASE"] = source["press_release_list_url"]

        # Check and auto-discover missing category URLs
        missing_categories = [cat for cat in ["NOTICE", "NEWS", "PRESS_RELEASE"] if cat not in category_urls]
        if base_url and (not category_urls or (missing_categories and not getattr(self.args, "no_discover", False))):
            print(f"  {CYAN}▸ Checking routes (Missing: {', '.join(missing_categories) if missing_categories else 'ALL'})...{RESET}")
            from app import route_discovery
            try:
                discovered = await route_discovery.discover_routes(
                    base_url=base_url,
                    on_progress=lambda m: print(f"    {DIM}{m}{RESET}"),
                )
                best = discovered.get("best") or {}
                for cat in ["NOTICE", "NEWS", "PRESS_RELEASE"]:
                    if cat not in category_urls and best.get(cat):
                        category_urls[cat] = best[cat]
                        print(f"    {GREEN}✓ Auto-discovered {cat}: {best[cat]}{RESET}")
                        col = "notice_list_url" if cat == "NOTICE" else ("news_list_url" if cat == "NEWS" else "press_release_list_url")
                        if not self.args.dry_run:
                            async with self.db_pool.acquire() as conn:
                                await conn.execute(f"UPDATE scrape_sources SET {col} = $1 WHERE id = $2::uuid", best[cat], source_id)
            except Exception as e:
                logger.warning("Route auto-discovery failed for %s: %s", base_url, e)

        if not category_urls:
            print(f"  {YELLOW}⚠ Source has no listing URLs configured and discovery found none. Skipping.{RESET}")
            return

        run_id = await self.create_scrape_run(source)
        known_urls = await self.get_known_urls_for_source(source_id)
        print(f"  {DIM}Known URLs already in DB: {len(known_urls)}{RESET}")

        def _to_dict(schema):
            if not schema:
                return None
            if isinstance(schema, str):
                try:
                    return json.loads(schema)
                except Exception:
                    return None
            return schema if isinstance(schema, dict) else None

        cached_schemas = {}
        for cat, key in [
            ("NOTICE", "notice_schema"),
            ("NEWS", "news_schema"),
            ("PRESS_RELEASE", "press_release_schema"),
        ]:
            s = _to_dict(source.get(key))
            if s and isinstance(s, dict) and "baseSelector" in s:
                cached_schemas[cat] = s

        pagination = scraper.PaginationConfig(
            pagination_type=source.get("pagination_type") or "QUERY_PARAM",
            param=source.get("pagination_param") or "page",
            start_page=int(source.get("start_page") or 1),
        )

        max_pages = self.args.max_pages if self.args.max_pages else int(source.get("max_pages") or 20)
        deep = self.args.deep
        if self.args.max_pages:
            config.SCRAPE_DEEP_MAX_PAGES = self.args.max_pages

        counts = {
            "found": 0,
            "new": 0,
            "updated": 0,
            "skipped": 0,
            "summarized": 0,
            "summary_failed": 0,
        }

        notice_counter = 0

        async def on_notice_scraped(item):
            """Invoked immediately as each notice detail crawl finishes.

            DB FIRST:
              1. Persists raw notice immediately into PostgreSQL.
              2. Best-effort AI enrichment + vector indexing.
            """
            nonlocal notice_counter
            notice_counter += 1
            counts["found"] += 1
            self.stats["notices_found"] += 1

            t0 = time.time()
            title = (item.title or "").strip()
            source_url = item.source_url
            content_text = item.content_text or ""
            category = item.category.upper() if item.category else "NOTICE"
            if category not in VALID_CATEGORIES:
                category = "OTHER"

            # 1. DB FIRST PERSISTENCE
            try:
                outcome, item_id, dt_published, content_hash = await self.persist_raw_notice(source, item)
            except Exception as e:
                logger.exception("FATAL: Failed to persist raw notice %s into DB: %s", source_url, e)
                self.stats["notices_persist_failed"] += 1
                print(f"    {RED}✗ [Notice {notice_counter}] Failed to persist to DB:{RESET} {title[:50]} ({e})")
                return

            if outcome == "new":
                counts["new"] += 1
                self.stats["notices_raw_persisted"] += 1
            elif outcome == "updated":
                counts["updated"] += 1
                self.stats["notices_raw_updated"] += 1
            else:
                counts["skipped"] += 1
                self.stats["notices_skipped"] += 1
                print(
                    f"    {DIM}[Notice {notice_counter}] {title[:55]}... "
                    f"{YELLOW}[Already up to date - skipped]{RESET}"
                )
                return

            # Raw notice is safely persisted to PostgreSQL.
            # 2. BEST-EFFORT ENRICHMENT (never fails the notice)
            summarized_ok, embedded_ok = await self.enrich_notice(
                item_id=item_id,
                title=title,
                content_text=content_text,
                category=category,
                source_label=source["name"],
                source_url=source_url,
                dt_published=dt_published,
            )

            if summarized_ok:
                counts["summarized"] += 1
                self.stats["notices_summarized"] += 1
            else:
                counts["summary_failed"] += 1
                self.stats["notices_summary_retry"] += 1

            if embedded_ok:
                self.stats["notices_embedded"] += 1
            else:
                self.stats["notices_embedding_retry"] += 1

            elapsed = time.time() - t0
            summary_badge = f"{GREEN}Summary ✓{RESET}" if summarized_ok else f"{YELLOW}Summary Queued{RESET}"
            qdrant_badge = f"{GREEN}Qdrant ✓{RESET}" if embedded_ok else f"{YELLOW}Qdrant Queued{RESET}"

            print(
                f"    {GREEN}✓ [Notice {notice_counter}]{RESET} "
                f"{BOLD}{title[:45]}...{RESET} "
                f"({outcome.upper()}) | [DB Persisted ✓] | {summary_badge} | {qdrant_badge} ({elapsed:.1f}s)"
            )

        def on_crawler_progress(msg: str):
            print(f"  {CYAN}▸ {msg}{RESET}")

        try:
            # We pass summarize=False to scrape_source so detail crawl passes raw item
            # immediately to on_item, executing DB-FIRST ingestion without LLM bottlenecking.
            items, schemas_used, failures, crawl_stats = await scraper.scrape_source(
                base_url=source["base_url"],
                category_urls=category_urls,
                cached_schemas=cached_schemas,
                known_urls=known_urls,
                max_pages=max_pages,
                fetch_detail=True,
                summarize_concurrency=self.args.concurrency,
                pagination=pagination,
                deep=deep,
                summarize=False,
                on_progress=on_crawler_progress,
                on_item=on_notice_scraped,
            )

            # Persist newly detected schemas to DB for subsequent runs
            if schemas_used and not self.args.dry_run:
                async with self.db_pool.acquire() as conn:
                    if "NOTICE" in schemas_used:
                        await conn.execute(
                            "UPDATE scrape_sources SET notice_schema = $1::jsonb WHERE id = $2::uuid",
                            json.dumps(schemas_used["NOTICE"]),
                            source_id,
                        )
                    if "NEWS" in schemas_used:
                        await conn.execute(
                            "UPDATE scrape_sources SET news_schema = $1::jsonb WHERE id = $2::uuid",
                            json.dumps(schemas_used["NEWS"]),
                            source_id,
                        )
                    if "PRESS_RELEASE" in schemas_used:
                        await conn.execute(
                            "UPDATE scrape_sources SET press_release_schema = $1::jsonb WHERE id = $2::uuid",
                            json.dumps(schemas_used["PRESS_RELEASE"]),
                            source_id,
                        )

            await self.finish_scrape_run(run_id, source, "SUCCESS", counts=counts)
            self.stats["sources_processed"] += 1

            print(
                f"\n  {GREEN}{BOLD}✓ Source Completed:{RESET} {source_name}\n"
                f"    Items Found: {counts['found']} | DB Saved: {counts['new'] + counts['updated']} | "
                f"Skipped: {counts['skipped']} | Summarized: {counts['summarized']}"
            )

        except Exception as e:
            err_msg = str(e)
            logger.exception("Scrape failed for %s: %s", source_name, err_msg)
            print(f"\n  {RED}{BOLD}✗ Source Failed:{RESET} {source_name} ({err_msg})")
            await self.finish_scrape_run(run_id, source, "FAILED", error=err_msg, counts=counts)
            self.stats["sources_failed"] += 1

    async def process_enrichment_queue(self):
        """Processes notices requiring summary or embedding retry using SKIP LOCKED."""
        print(f"\n{BOLD}{CYAN}=== Processing PostgreSQL Enrichment & Retry Queue (SKIP LOCKED) ==={RESET}")
        limit = self.args.limit or 100
        batch_size = 25

        total_processed = 0
        while not self.interrupted and total_processed < limit:
            batch_size = min(25, limit - total_processed)
            async with self.db_pool.acquire() as conn:
                rows = await conn.fetch(
                    """
                    SELECT id, title, content_text, category, source_label, source_url, published_at,
                           summary_status, summary_attempts, embedding_status, embedding_attempts
                    FROM scraped_items
                    WHERE (
                        (summary_status IN ('pending', 'retry') AND (next_summary_retry_at IS NULL OR next_summary_retry_at <= NOW()))
                        OR
                        (embedding_status IN ('pending', 'retry') AND (next_embedding_retry_at IS NULL OR next_embedding_retry_at <= NOW()))
                    )
                    AND content_text IS NOT NULL AND length(content_text) > 20
                    ORDER BY scraped_at DESC
                    LIMIT $1
                    FOR UPDATE SKIP LOCKED
                    """,
                    batch_size,
                )

            if not rows:
                print(f"  {GREEN}No more pending/retry items ready in queue.{RESET}")
                break

            print(f"  Found {len(rows)} items to process in current batch...")
            for idx, row in enumerate(rows, 1):
                if self.interrupted:
                    break

                notice_id = row["id"]
                title = row["title"]
                content = row["content_text"]
                category = str(row["category"])
                source_label = row["source_label"]
                source_url = row["source_url"]
                published_at = row["published_at"]

                print(f"  [{idx}/{len(rows)}] Enriching: {title[:50]}...")
                summarized_ok, embedded_ok = await self.enrich_notice(
                    item_id=notice_id,
                    title=title,
                    content_text=content,
                    category=category,
                    source_label=source_label,
                    source_url=source_url,
                    dt_published=published_at,
                )
                status_summary = f"{GREEN}Summary ✓{RESET}" if summarized_ok else f"{YELLOW}Retry Scheduled{RESET}"
                status_embed = f"{GREEN}Embedding ✓{RESET}" if embedded_ok else f"{YELLOW}Retry Scheduled{RESET}"
                print(f"    Outcome: {status_summary} | {status_embed}")
                total_processed += 1
                if total_processed >= limit:
                    break

        print(f"  Queue worker finished. Processed {total_processed} items.")

    async def run(self):
        """Main execution loop."""
        await self.init()

        if self.args.backfill_missing or self.args.process_queue:
            await self.process_enrichment_queue()
            await self.close()
            self.print_final_report()
            return

        sources = await self.get_sources()
        print(f"{BOLD}Found {len(sources)} source(s) to process.{RESET}")
        if not sources:
            print("No matching sources found. Check your filters or ensure sources are enabled in DB.")
            await self.close()
            return

        for idx, source in enumerate(sources, 1):
            if self.interrupted:
                print(f"\n{YELLOW}Interrupted by user. Exiting gracefully...{RESET}")
                break
            await self.sync_source(source, idx, len(sources))

        await self.close()
        self.print_final_report()

    def print_final_report(self):
        """Prints summary statistics."""
        print(f"\n{BOLD}{CYAN}======================================================================{RESET}")
        print(f"{BOLD}{CYAN}                 SYNC & INGESTION PIPELINE REPORT                     {RESET}")
        print(f"{BOLD}{CYAN}======================================================================{RESET}")
        print(f"  Sources Processed Successfully: {GREEN}{self.stats['sources_processed']}{RESET}")
        print(f"  Sources Failed:                 {RED}{self.stats['sources_failed']}{RESET}")
        print(f"  Total Notices Scraped:          {BOLD}{self.stats['notices_found']}{RESET}")
        print(f"  Raw Notices Stored (New):       {GREEN}{self.stats['notices_raw_persisted']}{RESET}")
        print(f"  Raw Notices Updated:            {CYAN}{self.stats['notices_raw_updated']}{RESET}")
        print(f"  Notices Skipped (Up to date):   {YELLOW}{self.stats['notices_skipped']}{RESET}")
        print(f"  Failures Storing Raw Notices:   {GREEN if self.stats['notices_persist_failed'] == 0 else RED}{self.stats['notices_persist_failed']}{RESET} (Invariant: MUST be 0)")
        print(f"  AI Summaries Generated:         {MAGENTA}{self.stats['notices_summarized']}{RESET}")
        print(f"  AI Summaries Queued / Retry:    {YELLOW}{self.stats['notices_summary_retry']}{RESET}")
        print(f"  AI Summaries Permanently Failed:{RED}{self.stats['notices_summary_failed']}{RESET}")
        print(f"  Qdrant Vectors Embedded:        {GREEN}{self.stats['notices_embedded']}{RESET}")
        print(f"  Qdrant Vectors Queued / Retry:  {YELLOW}{self.stats['notices_embedding_retry']}{RESET}")
        print(f"{BOLD}{CYAN}======================================================================{RESET}\n")


def parse_args():
    parser = argparse.ArgumentParser(
        description="Public Notice Management: Scrape, DB-First Store, Summarize, and Embed Pipeline"
    )
    parser.add_argument(
        "--source",
        type=str,
        default=None,
        help="Target a specific source by name or ID (substring match)",
    )
    parser.add_argument(
        "--deep",
        action="store_true",
        default=True,
        help="Deep crawl: walk almost all pages discovered by the pager (default: True)",
    )
    parser.add_argument(
        "--no-deep",
        dest="deep",
        action="store_false",
        help="Incremental mode: stop on first page of known items",
    )
    parser.add_argument(
        "--max-pages",
        type=int,
        default=20,
        help="Maximum pages to crawl per category listing (default: 20)",
    )
    parser.add_argument(
        "--concurrency",
        type=int,
        default=2,
        help="Max concurrent requests (default: 2)",
    )
    parser.add_argument(
        "--limit-sources",
        type=int,
        default=None,
        help="Limit number of sources to process in this run",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Limit number of notices for backfill/queue mode",
    )
    parser.add_argument(
        "--no-discover",
        action="store_true",
        default=False,
        help="Disable auto-discovery of missing listing URLs",
    )
    parser.add_argument(
        "--skip-summarize",
        action="store_true",
        default=False,
        help="Skip AI summarization (only scrape, store raw, and embed)",
    )
    parser.add_argument(
        "--skip-embed",
        action="store_true",
        default=False,
        help="Skip vector embedding (only scrape, store raw, and summarize)",
    )
    parser.add_argument(
        "--backfill-missing",
        action="store_true",
        default=False,
        help="Process queue: backfill AI summaries and Qdrant vectors for existing database notices",
    )
    parser.add_argument(
        "--process-queue",
        action="store_true",
        default=False,
        help="Run enrichment worker to process pending and retry notices in database",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        default=False,
        help="Simulate run without writing to PostgreSQL or Qdrant",
    )
    return parser.parse_args()


def main():
    args = parse_args()
    pipeline = SyncPipeline(args)

    def sig_handler(sig, frame):
        print(f"\n{YELLOW}Received shutdown signal. Stopping after current task...{RESET}")
        pipeline.interrupted = True

    signal.signal(signal.SIGINT, sig_handler)
    signal.signal(signal.SIGTERM, sig_handler)

    try:
        asyncio.run(pipeline.run())
    except KeyboardInterrupt:
        print(f"\n{YELLOW}Shutdown complete.{RESET}")


if __name__ == "__main__":
    main()
