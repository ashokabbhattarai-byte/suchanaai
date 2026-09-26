"""test_sync_db_first.py - Automated verification tests for DB-first pipeline and Cloudflare AI provider.
"""

import asyncio
import datetime
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch
import uuid

REPO_ROOT = Path(__file__).resolve().parent.parent
AI_APP_DIR = REPO_ROOT / "apps" / "ai"
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))
if str(AI_APP_DIR) not in sys.path:
    sys.path.insert(0, str(AI_APP_DIR))

from dotenv import load_dotenv
load_dotenv(AI_APP_DIR / ".env")
load_dotenv(REPO_ROOT / "apps" / "api" / ".env")

import asyncpg
from app import config
from app.ai_providers import (
    AIProvider,
    CloudflareAIProvider,
    GeminiAIProvider,
    GroqAIProvider,
    NoticeSummarizer,
    clean_and_parse_analysis,
)
from scripts.sync_all_news import DB_URL, SyncPipeline, compute_content_hash


class TestDBFirstAndAIProviders(unittest.IsolatedAsyncioTestCase):
    def test_clean_and_parse_analysis(self):
        # 1. Clean markdown json fences
        raw = """```json
        {
            "summary": "This is a government notice regarding road construction.",
            "summary_ne": "यो सडक निर्माण सम्बन्धी सरकारी सूचना हो।",
            "urgency": "MEDIUM",
            "key_facts": ["Road closure on Sunday", "Budget 50M NPR"],
            "tags": ["Road", "DOR"],
            "category": "NOTICE",
            "category_confidence": 0.95
        }
        ```"""
        parsed = clean_and_parse_analysis(raw)
        self.assertIsNotNone(parsed)
        self.assertEqual(parsed["summary"], "This is a government notice regarding road construction.")
        self.assertEqual(parsed["category"], "NOTICE")
        self.assertEqual(parsed["urgency"], "MEDIUM")
        self.assertEqual(len(parsed["key_facts"]), 2)

    def test_cloudflare_provider_config(self):
        # Verify default model and configurable model without code change
        cf = CloudflareAIProvider(
            account_id="test_acc",
            api_token="test_tok",
            model="@cf/ibm-granite/granite-4.0-h-micro",
            enabled=True,
        )
        self.assertEqual(cf.model, "@cf/ibm-granite/granite-4.0-h-micro")
        self.assertTrue(cf.is_available)

        # Configurable model (e.g. GLM-4.7-Flash)
        cf_glm = CloudflareAIProvider(
            account_id="test_acc",
            api_token="test_tok",
            model="@cf/zai-org/glm-4.7-flash",
            enabled=True,
        )
        self.assertEqual(cf_glm.model, "@cf/zai-org/glm-4.7-flash")

    @patch("httpx.AsyncClient.post")
    async def test_cloudflare_circuit_breaker_on_401(self, mock_post):
        mock_resp = MagicMock()
        mock_resp.status_code = 401
        mock_resp.text = '{"errors":[{"code":10000,"message":"Authentication error"}]}'
        mock_post.return_value = mock_resp

        cf = CloudflareAIProvider(account_id="fake_acc", api_token="bad_tok", enabled=True)
        self.assertTrue(cf.is_available)

        text, err = await cf.chat([{"role": "user", "content": "hi"}])
        self.assertIsNone(text)
        # Verify circuit breaker flipped
        self.assertFalse(cf.is_available)
        self.assertIn("Unauthorized/Forbidden", cf.disabled_reason)

    @patch("httpx.AsyncClient.post")
    async def test_cloudflare_successful_response(self, mock_post):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {
            "result": {
                "response": '{"summary": "Test notice summary", "category": "NOTICE", "urgency": "LOW"}'
            },
            "success": True,
            "errors": [],
            "messages": [],
        }
        mock_post.return_value = mock_resp

        cf = CloudflareAIProvider(account_id="fake_acc", api_token="good_tok", enabled=True)
        analysis, err = await cf.summarize_notice("Title", "Content")
        self.assertIsNotNone(analysis)
        self.assertEqual(analysis["summary"], "Test notice summary")
        self.assertIsNone(err)

    async def test_sequential_fallback_order(self):
        class MockFailingProvider(AIProvider):
            def __init__(self, name):
                self.name = name
                self.model = f"{name}-model"
                self.is_available = True
            async def chat(self, messages, max_tokens=1500, temperature=0.2):
                return None, f"{self.name} simulated failure"

        class MockWinningProvider(AIProvider):
            def __init__(self, name):
                self.name = name
                self.model = f"{name}-model"
                self.is_available = True
            async def chat(self, messages, max_tokens=1500, temperature=0.2):
                return '{"summary": "Winner summary", "category": "NEWS"}', None

        # 1 fails (Cloudflare), 2 fails (Gemini), 3 succeeds (Groq)
        summarizer = NoticeSummarizer([
            MockFailingProvider("cloudflare"),
            MockFailingProvider("gemini"),
            MockWinningProvider("groq"),
        ])
        analysis, prov, model, err = await summarizer.summarize("Title", "Content")
        self.assertIsNotNone(analysis)
        self.assertEqual(prov, "groq")
        self.assertEqual(analysis["summary"], "Winner summary")

    async def test_db_first_persistence_when_ai_fails(self):
        """CRITICAL INVARIANT TEST:
        Ensures a notice is safely persisted into PostgreSQL even when ALL AI providers fail.
        Also tests that asyncpg AmbiguousParameterError ($14) is completely gone.
        """
        conn = await asyncpg.connect(DB_URL)
        source_row = await conn.fetchrow("SELECT id, name FROM scrape_sources LIMIT 1")
        await conn.close()
        test_source = dict(source_row) if source_row else {
            "id": uuid.UUID("00000000-0000-0000-0000-00000000001c"),
            "name": "Office of the Auditor General",
        }
        test_source_url = f"https://test.gov.np/notice-{uuid.uuid4().hex[:12]}"
        test_title = "Important Road Closure Notice Test"
        test_content = "This road will be closed on Saturday for maintenance work."

        # Mock scraped item
        item = MagicMock()
        item.title = test_title
        item.source_url = test_source_url
        item.content_text = test_content
        item.content_html = f"<p>{test_content}</p>"
        item.published_at = datetime.datetime.now()
        item.category = "NOTICE"
        item.source_slug = "road-closure"
        item.summary = None
        item.attachment_url = None
        item.attachments = []

        args = MagicMock()
        args.dry_run = False
        args.skip_summarize = False
        args.skip_embed = True
        pipeline = SyncPipeline(args)
        pipeline.db_pool = MagicMock()

        # Connect pool
        pool = await asyncpg.create_pool(DB_URL, min_size=1, max_size=2)
        pipeline.db_pool = pool

        # Force ALL AI providers to fail completely
        class AlwaysFailProvider(AIProvider):
            def __init__(self, name):
                self.name = name
                self.model = f"{name}-model"
                self.is_available = True
            async def chat(self, messages, max_tokens=1500, temperature=0.2):
                return None, "Simulated 500 error from AI provider"

        pipeline.summarizer = NoticeSummarizer([
            AlwaysFailProvider("cloudflare"),
            AlwaysFailProvider("gemini"),
            AlwaysFailProvider("groq"),
        ])

        try:
            # 1. DB FIRST: persist raw notice
            outcome, item_id, dt_pub, content_hash = await pipeline.persist_raw_notice(test_source, item)
            self.assertEqual(outcome, "new")
            self.assertIsNotNone(item_id)

            # Check that raw notice exists in DB with summary_status='pending'
            row = await pool.fetchrow("SELECT id, title, summary_status, embedding_status FROM scraped_items WHERE id = $1::uuid", item_id)
            self.assertIsNotNone(row)
            self.assertEqual(row["title"], test_title)
            self.assertEqual(row["summary_status"], "pending")

            # 2. Attempt enrichment (which will fail due to AlwaysFailProvider)
            summarized_ok, embedded_ok = await pipeline.enrich_notice(
                item_id=item_id,
                title=test_title,
                content_text=test_content,
                category="NOTICE",
                source_label=test_source["name"],
                source_url=test_source_url,
                dt_published=dt_pub,
            )

            self.assertFalse(summarized_ok)

            # 3. VERIFY NOTICE IS STILL SAFELY IN DB with summary_status='retry' and next_summary_retry_at set
            row_after = await pool.fetchrow(
                "SELECT id, title, summary_status, summary_attempts, next_summary_retry_at FROM scraped_items WHERE id = $1::uuid",
                item_id,
            )
            self.assertIsNotNone(row_after, "Notice MUST NEVER be deleted when AI fails!")
            self.assertEqual(row_after["summary_status"], "retry")
            self.assertEqual(row_after["summary_attempts"], 1)
            self.assertIsNotNone(row_after["next_summary_retry_at"])

            print(f"\n  [PASS] Notice safely persisted in DB despite total AI failure. ID: {item_id}")

        finally:
            # Cleanup test record
            await pool.execute("DELETE FROM scraped_items WHERE source_url = $1::text", test_source_url)
            await pool.close()


if __name__ == "__main__":
    unittest.main()
