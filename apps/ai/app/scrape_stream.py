"""Push scraped items to apps/api AS THEY ARE FOUND, instead of holding a
whole run in memory until it returns.

Companion to apps/api's InternalScrapingController — same direction and same
auth as ai_config_sync.py (this service calling back into the API with the
shared x-internal-secret), just per-scrape-run instead of on a timer.

Why this exists: a source with a few hundred notices can take many minutes
to crawl (detail fetch + OCR + LLM summary per item), and the old contract
was "return everything in one response at the end". A 504 anywhere along
that — nginx, an ALB, axios's own timeout — discarded the *entire* run, work
already done included. Streaming each item the moment it's ready means the
outer response is no longer where durability lives; by the time any timeout
fires, everything finished so far is already in Postgres and embedded.
"""

import asyncio

import httpx

from app import config
from app.logger import get_logger

logger = get_logger(__name__)

_PUSH_TIMEOUT_SECONDS = 20.0
_FINISH_TIMEOUT_SECONDS = 30.0
_MAX_ATTEMPTS = 3
_BACKOFF_BASE_SECONDS = 1.5


def _headers() -> dict:
    return {"x-internal-secret": config.INTERNAL_SERVICE_SECRET} if config.INTERNAL_SERVICE_SECRET else {}


def _item_to_dict(item) -> dict:
    """Wire shape for one item — the exact fields apps/api's persistOneItem
    reads, shared between the streaming push and the legacy full-body
    response so the two can never drift apart."""
    return {
        "category": item.category,
        "title": item.title,
        "source_url": item.source_url,
        "published_at": item.published_at,
        "summary": item.summary,
        "content_text": item.content_text,
        "content_html": item.content_html,
        "attachment_url": item.attachment_url,
        "source_slug": item.source_slug,
        "attachments": [
            {"url": a.url, "label": a.label, "mime_type": a.mime_type, "size_bytes": a.size_bytes}
            for a in (item.attachments or [])
        ],
        "ai_summary": item.ai_summary,
        "ai_summary_ne": item.ai_summary_ne,
        "ai_urgency": item.ai_urgency,
        "ai_category_confidence": item.ai_category_confidence,
        "metadata": item.metadata,
    }


class RunStreamer:
    """One instance per scrape run. Tracks which items made it to Postgres
    so the final HTTP response (still returned for backward compatibility —
    see scraper.scrape_source's docstring) can omit their heavy fields
    instead of re-sending content the API already has. A response that only
    carries what streaming *couldn't* deliver is small even for a run that
    found hundreds of items, so the response itself is never what a proxy
    times out on."""

    def __init__(self, run_id: str | None):
        self.run_id = run_id
        self.streamed_urls: set[str] = set()
        self.push_failures = 0

    @property
    def enabled(self) -> bool:
        return bool(self.run_id and config.INTERNAL_SERVICE_SECRET)

    async def push(self, item) -> None:
        """Best-effort: a failure here never raises into the crawl loop.
        Every item also lives in the function's own return list regardless,
        so a push failure just falls back to the old end-of-run delivery."""
        if not self.enabled:
            return
        url = f"{config.API_INTERNAL_URL.rstrip('/')}/internal/scraping/runs/{self.run_id}/items"
        payload = {"items": [_item_to_dict(item)]}

        for attempt in range(_MAX_ATTEMPTS):
            try:
                async with httpx.AsyncClient(timeout=_PUSH_TIMEOUT_SECONDS) as client:
                    response = await client.post(url, json=payload, headers=_headers())
                if response.status_code == 200:
                    self.streamed_urls.add(item.source_url)
                    return
                logger.warning(
                    "Item push to %s returned %d (attempt %d/%d): %.200s",
                    url, response.status_code, attempt + 1, _MAX_ATTEMPTS, response.text,
                )
            except httpx.HTTPError as e:
                logger.warning(
                    "Item push to %s failed (attempt %d/%d): %s", url, attempt + 1, _MAX_ATTEMPTS, e,
                )
            if attempt < _MAX_ATTEMPTS - 1:
                await asyncio.sleep(_BACKOFF_BASE_SECONDS * (attempt + 1))

        self.push_failures += 1
        logger.error(
            "Giving up streaming %s for run %s after %d attempt(s) — it will only "
            "reach Postgres via the end-of-run response, if that response arrives.",
            item.source_url, self.run_id, _MAX_ATTEMPTS,
        )

    def response_items(self, items: list) -> list[dict]:
        """Full items list for the legacy response, minus what already made
        it into Postgres via streaming — those are reduced to an identifying
        stub. A caller with no run_id (checks, dev without INTERNAL_SERVICE_SECRET)
        never streamed anything, so it gets the exact old behavior."""
        out = []
        for item in items:
            if item.source_url in self.streamed_urls:
                out.append({"source_url": item.source_url, "streamed": True})
            else:
                out.append(_item_to_dict(item))
        return out

    async def finish(
        self,
        schemas: dict,
        failed_urls: list[dict],
        stats: dict | None = None,
        error: str | None = None,
    ) -> None:
        """Called exactly once per run, success or failure, so the run's
        status/schemas/diagnosis are finalized even if the HTTP round-trip
        that triggered the run never gets a response back to apps/api."""
        if not self.enabled:
            return
        url = f"{config.API_INTERNAL_URL.rstrip('/')}/internal/scraping/runs/{self.run_id}/finish"
        payload = {
            "schemas": schemas,
            "failedUrls": failed_urls,
            "stats": stats or {},
            **({"error": error} if error else {}),
        }
        for attempt in range(_MAX_ATTEMPTS):
            try:
                async with httpx.AsyncClient(timeout=_FINISH_TIMEOUT_SECONDS) as client:
                    response = await client.post(url, json=payload, headers=_headers())
                if response.status_code == 200:
                    return
                logger.warning(
                    "Run finish for %s returned %d (attempt %d/%d): %.200s",
                    self.run_id, response.status_code, attempt + 1, _MAX_ATTEMPTS, response.text,
                )
            except httpx.HTTPError as e:
                logger.warning(
                    "Run finish for %s failed (attempt %d/%d): %s", self.run_id, attempt + 1, _MAX_ATTEMPTS, e,
                )
            if attempt < _MAX_ATTEMPTS - 1:
                await asyncio.sleep(_BACKOFF_BASE_SECONDS * (attempt + 1))
        logger.error(
            "Could not finalize run %s after %d attempt(s) — apps/api's own axios "
            "timeout on the triggering request is now the only thing that will "
            "eventually mark it FAILED.",
            self.run_id, _MAX_ATTEMPTS,
        )
