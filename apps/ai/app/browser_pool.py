"""Shared headless-browser pool for the scraper.

One Chromium instance is launched lazily and reused by every crawl. Callers
take a session through `crawler_session()`, which queues them behind a
process-wide semaphore so only a bounded number of crawls touch the browser at
once. A session that dies with a launch/driver error marks the pool dirty, so
the next caller gets a freshly launched browser instead of a dead handle.
"""

import asyncio
from contextlib import asynccontextmanager

from crawl4ai import AsyncWebCrawler, BrowserConfig

from app import config
from app.logger import get_logger

logger = get_logger(__name__)

# Errors that mean the browser process itself is gone or could not be spawned.
# These are pool-level failures, not site failures — the fix is to relaunch.
_BROWSER_DEAD_MARKERS = (
    "resource temporarily unavailable",
    "errno 11",
    "browsertype.launch",
    "connection closed while reading from the driver",
    "target page, context or browser has been closed",
    "browser has been closed",
    "browser.close",
)


def is_browser_failure(message: str | None) -> bool:
    """True when an error means the pooled browser died rather than the site."""
    if not message:
        return False
    lowered = message.lower()
    return any(marker in lowered for marker in _BROWSER_DEAD_MARKERS)


class _BrowserPool:
    def __init__(self) -> None:
        self._crawler: AsyncWebCrawler | None = None
        self._lock = asyncio.Lock()
        self._semaphore: asyncio.Semaphore | None = None
        self._sessions_served = 0

    def _get_semaphore(self) -> asyncio.Semaphore:
        # Built lazily so it binds to the running loop, not import time.
        if self._semaphore is None:
            self._semaphore = asyncio.Semaphore(
                max(1, config.SCRAPE_BROWSER_CONCURRENCY)
            )
        return self._semaphore

    def _get_priority_semaphore(self) -> asyncio.Semaphore | None:
        # Kept for future bounded priority; currently priority bypasses the
        # main semaphore entirely (see session(priority=True)).
        return None

    async def _ensure_started(self) -> AsyncWebCrawler:
        async with self._lock:
            if self._crawler is not None:
                return self._crawler
            crawler = AsyncWebCrawler(config=BrowserConfig(headless=True, verbose=False))
            await crawler.start()
            self._crawler = crawler
            self._sessions_served = 0
            logger.info(
                "Launched pooled browser (concurrency=%d, recycle_after=%d)",
                config.SCRAPE_BROWSER_CONCURRENCY,
                config.SCRAPE_BROWSER_MAX_SESSIONS,
            )
            return crawler

    async def close(self, *, reason: str = "shutdown") -> None:
        async with self._lock:
            crawler, self._crawler = self._crawler, None
        if crawler is None:
            return
        try:
            await crawler.close()
        except Exception as e:  # noqa: BLE001 — a dead browser cannot be closed cleanly
            logger.warning("Pooled browser close failed (%s): %.160s", reason, e)
        else:
            logger.info("Closed pooled browser (%s)", reason)

    async def recycle_if_exhausted(self) -> None:
        """Relaunch once the session budget is spent, between sessions only."""
        if self._sessions_served < max(1, config.SCRAPE_BROWSER_MAX_SESSIONS):
            return
        await self.close(reason="session budget reached")

    @asynccontextmanager
    async def session(self, priority: bool = False):
        """Yield the shared crawler, bounded by the concurrency semaphore.

        When ``priority`` is True (single-URL quick-scrape / scrape-a-link),
        the call bypasses the main semaphore so it does not queue behind the
        scheduler's 4 concurrent listing crawls that otherwise fill the pool
        and leave the UI stuck on "Crawling..." with no progress. It still
        shares the same pooled browser instance; bypass only affects queuing.
        """
        if priority:
            # Bypass the queue — single URL fetches are short and interactive.
            logger.info(
                "Priority browser session bypassing semaphore (concurrency=%d)",
                config.SCRAPE_BROWSER_CONCURRENCY,
            )
            crawler = await self._ensure_started()
            self._sessions_served += 1
            try:
                yield crawler
            except Exception as e:  # noqa: BLE001 — classified, then re-raised
                if is_browser_failure(str(e)):
                    logger.warning("Pooled browser died mid-session: %.160s", e)
                    await self.close(reason="browser failure")
                raise
            else:
                await self.recycle_if_exhausted()
            return

        async with self._get_semaphore():
            crawler = await self._ensure_started()
            self._sessions_served += 1
            try:
                yield crawler
            except Exception as e:  # noqa: BLE001 — classified, then re-raised
                if is_browser_failure(str(e)):
                    logger.warning("Pooled browser died mid-session: %.160s", e)
                    await self.close(reason="browser failure")
                raise
            else:
                await self.recycle_if_exhausted()


_pool = _BrowserPool()

session = _pool.session


async def restart() -> None:
    """Drop the current browser so the next session launches a fresh one."""
    await _pool.close(reason="restart requested")


async def shutdown() -> None:
    await _pool.close()


@asynccontextmanager
async def crawler_session(priority: bool = False):
    """Compatibility wrapper. ``priority=True`` bypasses the queue for
    single-URL quick-scrape (scrape-a-link) so it does not wait behind
    long listing crawls."""
    async with _pool.session(priority=priority) as crawler:
        yield crawler


# Alias for callers that prefer an explicit name.
@asynccontextmanager
async def priority_crawler_session():
    async with _pool.session(priority=True) as crawler:
        yield crawler
