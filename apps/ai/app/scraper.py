"""Generic notice/news scraper for admin-configured government/public websites.

Built on crawl4ai. An admin adds a source (base URL + one or two listing page
URLs — "Notice" and/or "News"). Because sites differ arbitrarily in markup,
listing extraction is *dynamic* rather than hand-coded per site:

  1. Heuristic detection (free, first try): scan the listing page's DOM for
     the group of sibling elements most likely to be repeating list rows
     (a table's `<tr>`s, a `<ul>`'s `<li>`s, repeated `<article>`/card divs,
     ...) and derive a crawl4ai `JsonCssExtractionStrategy` schema from it.
  2. LLM fallback (only if heuristics fail and GROQ_API_KEY is set): ask an
     LLM to read the cleaned HTML once and propose the same kind of schema.
  3. Caching: whichever schema works is handed back to the caller (the
     NestJS API, backed by Postgres) to store on the `ScrapeSource` row, so
     every subsequent run is pure CSS extraction — no heuristics or LLM
     calls needed unless the site's markup changes and extraction goes to
     zero rows, at which point detection re-runs automatically.

Detail-page content is *not* schema-based: any article page is fetched as
plain markdown/cleaned text via crawl4ai, which generalizes across sites far
better than a per-site body selector would.
"""

import asyncio
import gzip
import random
import json
import re
import zlib
from dataclasses import dataclass
from datetime import datetime
from urllib.parse import parse_qs, unquote, urljoin, urlparse
from xml.etree import ElementTree as ET

import httpx
import nepali_datetime
from bs4 import BeautifulSoup
from crawl4ai import AsyncWebCrawler, CacheMode, CrawlerRunConfig
from crawl4ai.extraction_strategy import JsonCssExtractionStrategy

from app import browser_pool, config, llm
from app.logger import get_logger

logger = get_logger(__name__)

# Listing pages stop yielding new rows past this page number even if the site
# reports another `?page=` link; keeps a single scrape run bounded.
DEFAULT_MAX_PAGES = 3

# Tags/attrs stripped before heuristic analysis or LLM prompting — noise that
# never contains list content.
_STRIP_TAGS = ["script", "style", "noscript", "svg", "nav", "footer", "header"]

# Class/id substrings that mark navigation chrome rather than content rows;
# candidate groups scoring only on these are deprioritized.
_CHROME_HINTS = ("nav", "menu", "footer", "header", "breadcrumb", "pagination", "sidebar", "cookie")
_ROW_HINTS = ("row", "item", "card", "list", "entry", "result", "post", "notice", "news")

_DATE_FORMATS = [
    "%A, %B %d, %Y, %I:%M %p",   # Sunday, June 07, 2026, 09:07 PM
    "%B %d, %Y, %I:%M %p",       # June 02, 2026, 04:27 PM
    "%B %d, %Y",                  # June 02, 2026
    "%d %B %Y",                   # 02 June 2026
    "%d %B, %Y",                  # 02 June, 2026
    "%d-%m-%Y",
    "%d/%m/%Y",
    "%Y-%m-%d",
]
_DATE_LIKE_RE = re.compile(
    r"(\d{1,2}\s+[A-Za-z]+\s+\d{4})"
    r"|([A-Za-z]+\s+\d{1,2},?\s+\d{4})"
    r"|(\d{4}-\d{2}-\d{2})"
    r"|(\d{1,2}[/-]\d{1,2}[/-]\d{4})"
)

# Many Nepali government sites (mofa.gov.np included) serve a CDN-cached
# variant of the same listing page in Bikram Sambat/Devanagari — observed to
# vary by request independent of Accept-Language or JS settings, so both
# calendars must be parseable rather than avoided.
_DEVANAGARI_DIGITS = str.maketrans("०१२३४५६७८९", "0123456789")
_NEPALI_MONTHS = {
    "बैशाख": 1, "बैसाख": 1,
    "जेठ": 2, "जेष्ठ": 2,
    "असार": 3, "आषाढ": 3,
    "श्रावण": 4, "साउन": 4,
    "भदौ": 5, "भाद्र": 5,
    "असोज": 6, "आश्विन": 6,
    "कार्तिक": 7,
    "मंसिर": 8, "मार्गशीर्ष": 8,
    "पुष": 9, "पौष": 9,
    "माघ": 10,
    "फागुन": 11, "फाल्गुन": 11,
    "चैत": 12, "चैत्र": 12,
}
# Government templates disagree on token order ("जेठ २४, २०८३" month-first vs
# "२३ असार, २०८३" day-first); both the month name and the day are captured
# generically here and disambiguated afterwards via the month-name lookup.
_BS_DATE_RE = re.compile(
    r"([ऀ-ॿ]+|[०-९\d]{1,2})\s+([ऀ-ॿ]+|[०-९\d]{1,2}),?\s*([०-९\d]{4})"
    r"(?:,?\s*[ऀ-ॿ]+\s+([०-९\d]{1,2}):([०-९\d]{1,2}))?"
)


def _parse_bs_date(raw: str) -> str | None:
    match = _BS_DATE_RE.search(raw)
    if not match:
        return None
    token_a, token_b, year_str, hour_str, minute_str = match.groups()
    month = _NEPALI_MONTHS.get(token_a)
    day_str = token_b
    if month is None:
        month = _NEPALI_MONTHS.get(token_b)
        day_str = token_a
    if not month:
        return None
    try:
        day = int(day_str.translate(_DEVANAGARI_DIGITS))
        year = int(year_str.translate(_DEVANAGARI_DIGITS))
        ad_date = nepali_datetime.date(year, month, day).to_datetime_date()
    except Exception:
        return None

    if hour_str and minute_str:
        try:
            hour = int(hour_str.translate(_DEVANAGARI_DIGITS))
            minute = int(minute_str.translate(_DEVANAGARI_DIGITS))
            return datetime(ad_date.year, ad_date.month, ad_date.day, hour, minute).isoformat()
        except Exception:
            pass
    return datetime(ad_date.year, ad_date.month, ad_date.day).isoformat()


@dataclass
class AttachmentInfo:
    url: str
    label: str | None = None
    mime_type: str | None = None
    size_bytes: int | None = None


@dataclass
class ScrapedItem:
    category: str
    title: str
    source_url: str
    published_at: str | None
    summary: str | None
    content_text: str | None = None
    content_html: str | None = None
    attachment_url: str | None = None
    source_slug: str | None = None
    attachments: list[AttachmentInfo] | None = None
    ai_summary: str | None = None
    ai_summary_ne: str | None = None
    ai_urgency: str | None = None
    ai_category_confidence: float | None = None
    metadata: dict | None = None


# --- date / text helpers ---


def _parse_published(raw: str | None) -> str | None:
    if not raw:
        return None
    cleaned = re.sub(r"\s+", " ", raw).strip().strip(",")
    for fmt in _DATE_FORMATS:
        try:
            return datetime.strptime(cleaned, fmt).isoformat()
        except ValueError:
            continue
    bs_parsed = _parse_bs_date(cleaned)
    if bs_parsed:
        return bs_parsed
    match = _DATE_LIKE_RE.search(cleaned)
    # Retry on the date-like fragment only when it is genuinely narrower than
    # what just failed to parse. When the whole string is date-shaped but
    # matches no known format, the match is the input itself, and recursing on
    # it never terminates — that blew the stack and aborted the entire scrape
    # for the source (seen on dor.gov.np and immigration.gov.np).
    if match and len(match.group(0)) < len(cleaned):
        return _parse_published(match.group(0))
    return None


def _clean_text(raw: str | None) -> str | None:
    if not raw:
        return None
    text = re.sub(r"\s+", " ", raw).strip()
    return text or None


def _absolute_url(base_url: str, href: str | None) -> str | None:
    if not href:
        return None
    href = href.strip()
    if href.startswith("javascript:") or href.startswith("mailto:") or href == "#":
        return None
    return urljoin(base_url, href)


# --- heuristic schema detection ---


def _element_signature(tag) -> str:
    classes = sorted(c for c in tag.get("class", []) if c)
    return f"{tag.name}." + ".".join(classes) if classes else tag.name


# How many ancestors to inspect when deciding whether a candidate row is really
# navigation chrome. Menus mark themselves on the container (`ul.sf-menu`,
# `div.sidebar`) while the repeating element itself is a bare `<li>`, so a
# signature-only check sees nothing to penalize; three levels is enough to
# reach the list container and its column wrapper without drifting into the
# page-wide `div.container`, which would penalize genuine content too.
_CHROME_ANCESTOR_DEPTH = 3


def _chrome_context(tag) -> str:
    """Class/id text of `tag` plus its nearest ancestors, lowercased.

    Used instead of the element's own signature when testing for
    `_CHROME_HINTS`: a sidebar menu's `<li>` rows carry no classes of their
    own, so scoring them by signature alone let a 25-item nav menu outrank a
    10-row notices table.
    """
    parts: list[str] = []
    node = tag
    for _ in range(_CHROME_ANCESTOR_DEPTH + 1):
        if node is None or not hasattr(node, "get"):
            break
        parts.extend(node.get("class", []) or [])
        node_id = node.get("id")
        if node_id:
            parts.append(node_id)
        node = node.parent
    return " ".join(parts).lower()


def _css_selector_for_signature(tag, signature: str) -> str:
    if tag.name == "tr":
        # Table rows are reliably matched generically; a class-qualified
        # selector is used only when the row itself carries distinguishing
        # classes (plain `tr` is the common case).
        classes = sorted(c for c in tag.get("class", []) if c)
        return "table tbody tr" if not classes else f"tr.{'.'.join(classes)}"
    classes = sorted(c for c in tag.get("class", []) if c)
    return f"{tag.name}.{'.'.join(classes)}" if classes else tag.name


_FILE_EXTENSIONS = (".pdf", ".jpg", ".jpeg", ".png", ".gif", ".doc", ".docx", ".xls", ".xlsx", ".zip")


def _nth_child_selector(el) -> str | None:
    """CSS `tag:nth-child(n)` for a direct child of the base row, or None if
    `el` isn't a direct child (deeper nesting isn't generalized)."""
    parent = el.parent
    if parent is None:
        return None
    siblings = parent.find_all(recursive=False)
    try:
        idx = siblings.index(el) + 1
    except ValueError:
        return None
    return f"{el.name}:nth-child({idx})"


def _pick_detail_anchor(sample, base_url: str):
    """Choose the anchor most likely to link to the article's detail page —
    not an attachment (PDF/image) or an external CDN link."""
    base_netloc = urlparse(base_url).netloc
    best_anchor, best_score = None, float("-inf")
    for anchor in sample.find_all("a", href=True):
        href = anchor["href"].strip()
        if not href or href in ("#", "javascript:void(0)"):
            continue
        score = 0.0
        lower_href = href.lower()
        if any(lower_href.endswith(ext) for ext in _FILE_EXTENSIONS):
            score -= 10
        parsed = urlparse(href)
        if parsed.netloc and parsed.netloc != base_netloc:
            score -= 5
        if re.search(r"\d", href):
            score += 2
        if href.count("/") > 1:
            score += 1
        # Later anchors in the row win ties — "view detail" links commonly
        # render after attachment/thumbnail links in table/card markup.
        score += 0.01
        if score >= best_score:
            best_anchor, best_score = anchor, score
    return best_anchor


def _pick_attachment_anchor(sample, base_url: str, exclude=None):
    """Choose the anchor most likely to be a downloadable attachment (PDF,
    image, office doc, archive) — the inverse criteria of
    `_pick_detail_anchor`. Returns None if no such link exists in the row."""
    base_netloc = urlparse(base_url).netloc
    best_anchor, best_score = None, float("-inf")
    for anchor in sample.find_all("a", href=True):
        if anchor is exclude:
            continue
        href = anchor["href"].strip()
        if not href or href in ("#", "javascript:void(0)"):
            continue
        lower_href = href.lower().split("?")[0]
        if not any(lower_href.endswith(ext) for ext in _FILE_EXTENSIONS):
            continue
        score = 1.0
        parsed = urlparse(href)
        if parsed.netloc and parsed.netloc != base_netloc:
            score += 1  # attachments commonly live on a separate CDN/media host
        if score > best_score:
            best_anchor, best_score = anchor, score
    return best_anchor


def _anchor_selector(anchor) -> str:
    """A selector for this specific anchor, scoped by its parent cell when
    possible — this matters when a row has more than one anchor (e.g. a
    detail link and an attachment link) that would otherwise collide on the
    same generic `"a"` selector."""
    classes = sorted(c for c in anchor.get("class", []) if c)
    if classes:
        return f"a.{'.'.join(classes)}"
    nth = _nth_child_selector(anchor.parent) if anchor.parent and anchor.parent.name != anchor.name else None
    if nth:
        return f"{nth} a"
    return "a"


def _pick_title_selector(sample, skip_el) -> str:
    """Choose the row's most title-like text container: the longest text
    among direct children, excluding the detail anchor's own cell, dates,
    and short numeric/ordinal columns."""
    best_el, best_len = None, 0
    for child in sample.find_all(recursive=False):
        if child is skip_el:
            continue
        text = child.get_text(" ", strip=True)
        if not text or text.isdigit() or _DATE_LIKE_RE.fullmatch(text):
            continue
        if len(text) > best_len:
            best_el, best_len = child, len(text)

    if best_el is not None and best_len >= 8:
        nth = _nth_child_selector(best_el)
        if nth:
            return nth
        classes = sorted(c for c in best_el.get("class", []) if c)
        return f"{best_el.name}.{'.'.join(classes)}" if classes else best_el.name

    heading = sample.find(["h1", "h2", "h3", "h4"])
    if heading and heading.get_text(strip=True):
        return heading.name
    return "a"


def _pick_date_selector(sample) -> str | None:
    time_tag = sample.find("time")
    if time_tag:
        return "time"

    for el in sample.find_all(True):
        classes = " ".join(el.get("class", [])).lower()
        if "date" in classes or ("time" in classes and el.name != "time"):
            nth = _nth_child_selector(el)
            if nth:
                return nth
            own_classes = sorted(c for c in el.get("class", []) if c)
            return f"{el.name}.{'.'.join(own_classes)}" if own_classes else el.name

    for child in sample.find_all(recursive=False):
        text = child.get_text(" ", strip=True)
        if text and _DATE_LIKE_RE.search(text):
            return _nth_child_selector(child)

    return None


def _detect_schema_heuristic(html: str, base_url: str) -> dict | None:
    soup = BeautifulSoup(html, "html.parser")
    for tag_name in _STRIP_TAGS:
        for el in soup.find_all(tag_name):
            el.decompose()

    groups: dict[str, list] = {}
    for tag in soup.find_all(True):
        if not tag.find("a", href=True):
            continue
        text = tag.get_text(" ", strip=True)
        if len(text) < 8:
            continue
        sig = _element_signature(tag)
        groups.setdefault(sig, []).append(tag)

    best_sig, best_score = None, 0.0
    for sig, elements in groups.items():
        count = len(elements)
        if count < 3 or count > 300:
            continue
        lower_sig = sig.lower()
        score = float(count)
        if any(h in lower_sig for h in _ROW_HINTS) or lower_sig == "tr":
            score *= 2.0
        # Chrome is judged from the surrounding markup, not just this element's
        # own classes — see `_chrome_context`.
        chrome_context = _chrome_context(elements[0])
        if any(h in lower_sig for h in _CHROME_HINTS) or any(
            h in chrome_context for h in _CHROME_HINTS
        ):
            score *= 0.2
        if score > best_score:
            best_sig, best_score = sig, score

    if not best_sig:
        return None

    sample = groups[best_sig][0]
    base_selector = _css_selector_for_signature(sample, best_sig)

    anchor = _pick_detail_anchor(sample, base_url)
    if anchor is None:
        return None

    detail_selector = _anchor_selector(anchor)
    anchor_cell = anchor.parent if anchor.parent and anchor.parent.name in ("td", "th") else anchor

    fields = [
        {"name": "detail_href", "selector": detail_selector, "type": "attribute", "attribute": "href"},
        {"name": "title", "selector": _pick_title_selector(sample, anchor_cell), "type": "text"},
    ]

    date_selector = _pick_date_selector(sample)
    if date_selector:
        fields.append({"name": "published_raw", "selector": date_selector, "type": "text"})

    attachment_anchor = _pick_attachment_anchor(sample, base_url, exclude=anchor)
    if attachment_anchor is not None:
        fields.append(
            {
                "name": "attachment_href",
                "selector": _anchor_selector(attachment_anchor),
                "type": "attribute",
                "attribute": "href",
            }
        )

    return {"name": "auto_detected", "baseSelector": base_selector, "fields": fields}


# --- LLM-assisted schema fallback ---

_SCHEMA_PROMPT = """You analyze the HTML of a government/public website's notice or news LISTING page and produce a CSS extraction schema as JSON.

Return ONLY a JSON object (no markdown fences, no commentary) with this exact shape:
{"baseSelector": "<css selector matching each repeating row/card>", "fields": [
  {"name": "title", "selector": "<css selector relative to baseSelector>", "type": "text"},
  {"name": "detail_href", "selector": "<css selector relative to baseSelector>", "type": "attribute", "attribute": "href"},
  {"name": "published_raw", "selector": "<css selector relative to baseSelector, omit this field if no date is visible>", "type": "text"},
  {"name": "attachment_href", "selector": "<css selector relative to baseSelector, omit this field entirely if no row links to a downloadable file>", "type": "attribute", "attribute": "href"}
]}

Rules:
- baseSelector must match ONLY the repeating list/table rows that link to individual notice or news articles — never navigation, footer, or sidebar/"recent posts" widget elements duplicated across many pages of the site.
- If the page contains a `<table>` whose header row mentions a title-like column and a date/published column, prefer that table's body rows over any card/grid layout — tables are the primary content on government listing pages, grids are often a secondary "recent" widget.
- detail_href must resolve to an <a> with an href attribute pointing to the article's detail page — never a PDF/image/office-document/archive link.
- attachment_href, if present, must resolve to an <a> whose href points to a downloadable file (.pdf, .doc(x), .xls(x), .ppt(x), .jpg/.jpeg/.png/.gif, .zip) — this is usually a separate "File Type"/download column from detail_href, never the same anchor.
- Selectors are evaluated relative to each baseSelector match (like BeautifulSoup's .select_one on that element)."""


async def _detect_schema_llm(html: str, category: str) -> dict | None:
    """Ask an LLM to propose a listing extraction schema. Routed through
    llm.raw_chat's full provider fallback chain (OpenRouter's several free
    models, then Groq/Gemini/OpenCode/Bedrock) rather than a single
    hardcoded Groq call — a single-provider 429 used to make this fall
    straight through to the free structural-heuristics detector below it,
    silently skipping a step that reliably disambiguates the real listing
    from sidebar "recent posts" widgets."""
    soup = BeautifulSoup(html, "html.parser")
    for tag_name in _STRIP_TAGS:
        for el in soup.find_all(tag_name):
            el.decompose()
    trimmed_html = str(soup)[:30000]

    try:
        content = await llm.raw_chat(
            _SCHEMA_PROMPT,
            f"Category: {category}\n\nHTML:\n{trimmed_html}",
            max_tokens=800,
            temperature=0.0,
        )
        if not content:
            return None
        content = re.sub(r"^```(json)?|```$", "", content.strip(), flags=re.MULTILINE).strip()
        schema = json.loads(content)
        if not schema.get("baseSelector") or not schema.get("fields"):
            return None
        schema["name"] = "llm_detected"
        return schema
    except Exception:
        logger.exception("LLM schema detection failed")
        return None


# --- crawling ---


# crawl4ai renders some failures (notably navigation errors) as a multi-hundred
# -line dump with the surrounding source of its own internals. Stored verbatim
# that lands in the ScrapeRun.issues JSON column and then in the admin UI, where
# it buries the one line that identifies the problem. The first few lines carry
# the actual message; the rest is its stack decoration.
_MAX_ERROR_CHARS = 500


def _clean_error(error: str | None) -> str:
    if not error:
        return "Unknown error"
    text = " ".join(str(error).split())
    if len(text) <= _MAX_ERROR_CHARS:
        return text
    return text[:_MAX_ERROR_CHARS].rstrip() + " … (truncated)"


def _record_failure(
    failures: list[dict] | None, url: str, stage: str, error: str | None
) -> None:
    """Append a structured per-URL failure so callers (NestJS, the admin UI)
    can show exactly which page failed and why, instead of only an aggregate
    run-level error string or a line buried in this service's stdout log."""
    if failures is None:
        return
    failures.append(
        {"url": url, "stage": stage, "error": _clean_error(error), "outcome": "failed"}
    )


# A skip is not an error — the crawler deliberately declined the URL — but it
# is the other half of "why isn't this notice on the site?". Recording it with
# the exact URL and reason is what makes a run auditable: previously these
# were counted only (`rejected += 1`) or logged at debug level, so an admin
# could see that 40 URLs were dropped but never which ones or why.
_SKIP_REASONS = {
    "already_scraped": "Already scraped in an earlier run",
    "not_article_url": "URL did not look like an article/notice page",
    "no_title": "No usable title could be extracted",
    "duplicate_in_run": "Duplicate URL within this run",
}


def _issue_summary(issues: list[dict]) -> str:
    """Trailing summary fragment, e.g. ", 3 failed, 41 skipped"."""
    failed, skipped = _count_outcomes(issues)
    parts = []
    if failed:
        parts.append(f"{failed} failed")
    if skipped:
        parts.append(f"{skipped} skipped")
    return (", " + ", ".join(parts)) if parts else ""


def _count_outcomes(issues: list[dict]) -> tuple[int, int]:
    """(failed, skipped) — the two are reported separately because a skip is a
    deliberate decision, not a problem to chase."""
    failed = sum(1 for i in issues if i.get("outcome", "failed") == "failed")
    return failed, len(issues) - failed


def _record_skip(
    failures: list[dict] | None, url: str, stage: str, reason: str, detail: str | None = None
) -> None:
    if failures is None:
        return
    failures.append(
        {
            "url": url,
            "stage": stage,
            "error": detail or _SKIP_REASONS.get(reason, reason),
            "outcome": "skipped",
            "reason": reason,
        }
    )


# Failures that are worth another attempt: the page was never actually
# reached, so nothing about the site says "no". `ERR_NETWORK_CHANGED` is the
# common one in practice — it means *this machine's* network moved under the
# browser (wifi handoff, VPN toggle, interface change), not that the remote
# site refused us. Without a retry a single flap silently drops that URL from
# the whole run, which is what made scrapes look randomly incomplete.
_TRANSIENT_CRAWL_ERRORS = (
    "err_network_changed",
    "err_internet_disconnected",
    "err_connection_reset",
    "err_connection_closed",
    "err_connection_refused",
    "err_connection_timed_out",
    "err_name_not_resolved",
    "err_timed_out",
    "err_empty_response",
    "err_socket_not_connected",
    "err_address_unreachable",
    "timeout",
    "timed out",
    "502",
    "503",
    "504",
)

_CRAWL_MAX_ATTEMPTS = 3
_CRAWL_BACKOFF_BASE_SECONDS = 2.0


class BrowserUnavailable(RuntimeError):
    """The pooled browser died — the run cannot continue on this handle."""


def _is_transient_crawl_error(message: str | None) -> bool:
    if not message:
        return False
    lowered = message.lower()
    return any(marker in lowered for marker in _TRANSIENT_CRAWL_ERRORS)


async def _arun_with_retry(
    crawler: AsyncWebCrawler, url: str, config: CrawlerRunConfig, what: str
):
    """`crawler.arun` with bounded retries for transient network failures.

    Permanent outcomes (404, a real block, malformed page) are returned on the
    first attempt — retrying those just wastes time and hammers the source.
    Backoff is exponential with jitter so a site that briefly wobbled isn't hit
    by every worker in lockstep.

    crawl4ai signals failure two ways — a falsy `result.success` and a raised
    exception — so both are funnelled through the same decision here.
    """
    last_error: str | None = None
    result = None

    for attempt in range(1, _CRAWL_MAX_ATTEMPTS + 1):
        try:
            result = await crawler.arun(url=url, config=config)
            if result.success:
                if attempt > 1:
                    logger.info("%s succeeded for %s on attempt %d", what, url, attempt)
                return result
            last_error = result.error_message
        except Exception as e:  # noqa: BLE001 — classified immediately below
            # An exception leaves no result object for the caller to inspect.
            last_error = str(e)
            result = None

        # A dead browser fails every remaining URL identically, so stop the run
        # and let the pool relaunch rather than retrying against a dead handle.
        if browser_pool.is_browser_failure(last_error):
            raise BrowserUnavailable(last_error or "browser unavailable")

        if attempt == _CRAWL_MAX_ATTEMPTS or not _is_transient_crawl_error(last_error):
            break

        delay = _CRAWL_BACKOFF_BASE_SECONDS * (2 ** (attempt - 1)) + random.uniform(0, 0.75)
        logger.info(
            "%s hit a transient error for %s (attempt %d/%d), retrying in %.1fs: %.120s",
            what, url, attempt, _CRAWL_MAX_ATTEMPTS, delay, last_error,
        )
        await asyncio.sleep(delay)

    if last_error:
        logger.warning(
            "%s gave up on %s after %d attempt(s): %.160s", what, url, attempt, last_error
        )
    # A failed-but-present result is returned so callers can surface the site's
    # own error_message; None means the call raised and there is nothing to read.
    return result


async def _fetch_raw_html(
    crawler: AsyncWebCrawler, url: str, failures: list[dict] | None = None
) -> str | None:
    result = await _arun_with_retry(
        crawler, url, CrawlerRunConfig(cache_mode=CacheMode.BYPASS), "Raw fetch"
    )
    if result is None:
        logger.warning("Raw fetch failed for %s after retries", url)
        _record_failure(failures, url, "raw_fetch", "Network error after retries")
        return None
    if not result.success:
        logger.warning("Raw fetch failed for %s: %s", url, result.error_message)
        _record_failure(failures, url, "raw_fetch", result.error_message)
        return None
    # A headless browser renders a 404 into perfectly valid HTML, so without
    # this check a mistyped listing URL reached schema detection and was
    # reported as "could not detect a working listing pattern" — sending
    # admins to debug the detector instead of the URL. Which one it is, is
    # exactly the distinction worth surfacing.
    status = getattr(result, "status_code", None)
    if isinstance(status, int) and status >= 400:
        logger.warning("Listing URL %s returned HTTP %d", url, status)
        _record_failure(
            failures, url, "listing_url",
            f"Listing URL returned HTTP {status} — the configured URL is wrong or the page moved",
        )
        return None
    return result.html


async def _extract_rows_and_html(
    crawler: AsyncWebCrawler, url: str, schema: dict, failures: list[dict] | None = None
) -> tuple[list[dict], str | None]:
    """Rows plus the page's own HTML — the pager widget lives in the latter."""
    result = await _arun_with_retry(
        crawler,
        url,
        CrawlerRunConfig(
            extraction_strategy=JsonCssExtractionStrategy(schema),
            cache_mode=CacheMode.BYPASS,
        ),
        "Listing crawl",
    )
    if result is None:
        _record_failure(failures, url, "listing", "Network error after retries")
        return [], None
    if not result.success:
        logger.warning("Listing crawl failed for %s: %s", url, result.error_message)
        _record_failure(failures, url, "listing", result.error_message)
        return [], None
    try:
        return json.loads(result.extracted_content or "[]"), result.html
    except json.JSONDecodeError as e:
        logger.warning("Listing extraction returned invalid JSON for %s: %s", url, e)
        _record_failure(failures, url, "listing", f"Extraction returned invalid JSON: {e}")
        return [], result.html


async def _extract_with_schema(
    crawler: AsyncWebCrawler, url: str, schema: dict, failures: list[dict] | None = None
) -> list[dict]:
    rows, _ = await _extract_rows_and_html(crawler, url, schema, failures)
    return rows


async def _resolve_schema(
    crawler: AsyncWebCrawler,
    listing_url: str,
    category: str,
    cached_schema: dict | None,
    failures: list[dict] | None = None,
) -> tuple[dict | None, bool]:
    """Return (schema, is_newly_detected). Tries the cached schema first;
    on zero rows (or no cache), re-detects: LLM first when an API key is
    configured (it reliably disambiguates the real listing from sidebar
    "recent posts" widgets, and the cost is paid once and then cached),
    falling back to free structural heuristics otherwise."""
    if cached_schema:
        rows = await _extract_with_schema(crawler, listing_url, cached_schema, failures)
        if rows:
            return cached_schema, False
        logger.info("Cached schema for %s/%s yielded no rows; re-detecting", listing_url, category)

    html = await _fetch_raw_html(crawler, listing_url, failures)
    if not html:
        return None, False

    if config.GROQ_API_KEY:
        schema = await _detect_schema_llm(html, category)
        if schema:
            rows = await _extract_with_schema(crawler, listing_url, schema, failures)
            if rows:
                return schema, True

    schema = _detect_schema_heuristic(html, listing_url)
    if schema:
        rows = await _extract_with_schema(crawler, listing_url, schema, failures)
        if rows:
            return schema, True

    logger.warning("Could not detect a working schema for %s (%s)", listing_url, category)
    _record_failure(
        failures, listing_url, "schema_detection", "Could not detect a working listing pattern"
    )
    return None, False


# Common article-body containers, checked in order; the first with
# substantial text wins. Falls back to the whole (nav/chrome-stripped) page
# so unfamiliar markup still yields something rather than nothing.
_CONTENT_SELECTORS = [
    "article",
    "main",
    "[role='main']",
    ".details__desc",
    ".entry-content",
    ".post-content",
    ".article-content",
    ".content-detail",
    ".detail-content",
    ".news-detail",
    ".single-content",
]


# Class/id substrings identifying page furniture that sits *inside* the main
# content container on many gov/university sites — cookie banners, mega-menus,
# sidebars, event calendars, "related notices" rails. These are removed before
# the text is taken so they can't be captured as notice body text.
_BOILERPLATE_HINTS = (
    "cookie", "consent", "gdpr", "nav", "menu", "navbar", "breadcrumb",
    "sidebar", "side-bar", "widget", "footer", "header", "masthead",
    "pagination", "pager", "calendar", "datepicker", "search", "social",
    "share", "related", "recent-post", "popular", "subscribe", "newsletter",
    "banner", "advert", "skip-link", "offcanvas", "dropdown", "modal",
)


def _strip_boilerplate(el) -> None:
    """Remove page-furniture descendants (cookie notices, menus, calendars,
    sidebars) from a content element, in place.

    Guards against removing the content itself: a matching element that holds
    most of the container's text is page furniture only by coincidence of
    naming (e.g. a wrapper class containing "search"), so it is left alone.
    """
    try:
        total = len(el.get_text(strip=True))
    except Exception:
        return
    for descendant in el.find_all(True):
        if descendant.decomposed or descendant is el:
            continue
        tokens = " ".join(
            [descendant.get("id") or ""] + list(descendant.get("class") or [])
        ).lower()
        if not tokens or not any(hint in tokens for hint in _BOILERPLATE_HINTS):
            continue
        if total and len(descendant.get_text(strip=True)) > total * 0.6:
            continue  # this *is* the content; its class name just looks like chrome
        descendant.decompose()


# A generic whole-page fallback ("no content selector matched, take <body>")
# reliably produces nav + cookie banner + calendar + footer soup rather than a
# notice. Text longer than this from that fallback is treated as unusable, and
# the notice keeps its (LLM-summarised, attachment-derived) content instead.
_MAX_FALLBACK_CONTENT_CHARS = 6000


def _extract_main_content(soup: BeautifulSoup) -> tuple[object, bool]:
    """Locate the notice body. Returns (element, matched_a_content_selector).

    The flag matters: a real content container is trustworthy, whereas the
    <body> fallback is whole-page soup and needs the length guard applied by
    the caller.
    """
    for selector in _CONTENT_SELECTORS:
        el = soup.select_one(selector)
        if el and len(el.get_text(strip=True)) > 80:
            _strip_boilerplate(el)
            return el, True
    body = soup.body or soup
    _strip_boilerplate(body)
    return body, False


# DOM ids/classes of common inline PDF/flipbook viewer widgets — many gov
# sites embed notices this way rather than as HTML text or a plain download
# link. The viewer's own toolbar chrome ("Zoom In", "Next Page", "Loading PDF
# Worker CORS …") is real visible text in the static HTML, so a naive "grab
# the main content text" pass captures it as if it were the notice body.
_PDF_VIEWER_SELECTORS = (
    "#viewerContainer",   # Mozilla pdf.js
    "#toolbarViewer",
    ".pdfViewer",
    ".textLayer",
    "#PDFViewerApplication",
    "#loadingBar",
    "#flipbookContainer",  # DearFlip
    "._df_book",
    ".df-container",
)

# Flipbook/PDF-viewer widgets often configure their source as a JS variable
# rather than a plain <a href>, e.g. `var pdf = 'https://.../file.pdf';`.
_JS_FILE_URL_RE = re.compile(r"""['"](https?://[^'"]+?\.(?:pdf|docx?|xlsx?|pptx?))['"]""", re.IGNORECASE)


def _is_pdf_viewer_embed(el) -> bool:
    return any(el.select_one(sel) for sel in _PDF_VIEWER_SELECTORS)


def _find_attachment_in_page(soup: BeautifulSoup, base_url: str) -> str | None:
    """Fallback attachment discovery on the detail page itself, for sites
    that link the PDF/image/doc from the article body rather than the
    listing row. Picks the first file-like link found anywhere on the page,
    then falls back to scanning inline <script> tags for a JS-configured
    viewer source URL (e.g. DearFlip-style flipbook embeds)."""
    for anchor in soup.find_all("a", href=True):
        href = anchor["href"].strip()
        if not href:
            continue
        lower_href = href.lower().split("?")[0]
        if any(lower_href.endswith(ext) for ext in _FILE_EXTENSIONS):
            return _absolute_url(base_url, href)

    return None


def _find_attachment_in_scripts(html: str, base_url: str) -> str | None:
    """Scan raw (pre-strip) HTML for a JS-configured viewer source URL, e.g.
    DearFlip-style `var pdf = 'https://.../file.pdf';` embeds. Must run
    against the original HTML — `<script>` tags are removed before the rest
    of detail-page parsing."""
    match = _JS_FILE_URL_RE.search(html)
    return _absolute_url(base_url, match.group(1)) if match else None


async def _crawl_detail_generic(
    crawler: AsyncWebCrawler, url: str, base_url: str, failures: list[dict] | None = None
) -> dict | None:
    """Fetch an article/detail page generically (no per-site schema)."""
    result = await _arun_with_retry(
        crawler, url, CrawlerRunConfig(cache_mode=CacheMode.BYPASS), "Detail crawl"
    )
    if result is None:
        _record_failure(failures, url, "detail", "Network error after retries")
        return None
    if not result.success:
        logger.warning("Detail crawl failed for %s: %s", url, result.error_message)
        _record_failure(failures, url, "detail", result.error_message)
        return None

    soup = BeautifulSoup(result.html or "", "html.parser")
    for tag_name in _STRIP_TAGS + ["aside"]:
        for el in soup.find_all(tag_name):
            el.decompose()

    h1 = soup.find("h1")
    title = _clean_text(h1.get_text(" ", strip=True)) if h1 else None

    time_tag = soup.find("time")
    published_raw = time_tag.get_text(" ", strip=True) if time_tag else None

    content_el, matched_selector = _extract_main_content(soup)
    if _is_pdf_viewer_embed(content_el) or _is_pdf_viewer_embed(soup):
        # The "content" here is a PDF.js viewer widget, not article text —
        # its toolbar/loading-bar chrome would otherwise be scraped verbatim
        # as if it were the notice body. The real content is the PDF itself,
        # captured separately as attachment_url below.
        content_text = None
        content_html = None
    else:
        content_text = _clean_text(content_el.get_text(" ", strip=True))
        content_html = str(content_el)
        # No content container matched, so this text came from a whole-page
        # <body> grab. Past a few thousand characters that is site furniture
        # (mega-menu + cookie notice + calendar + footer), not a notice —
        # storing it pollutes the detail page, the RAG index and LLM prompts
        # alike. Drop it and let the attachment/summary path supply content.
        if not matched_selector and content_text and len(content_text) > _MAX_FALLBACK_CONTENT_CHARS:
            logger.info(
                "Discarding %d chars of whole-page fallback content for %s "
                "(no content selector matched — almost certainly site chrome)",
                len(content_text),
                url,
            )
            content_text = None
            content_html = None

    # Prefer an attachment linked from within the article body; fall back to
    # anywhere else on the (chrome-stripped) page, then a JS-embedded viewer
    # source (script tags are stripped by this point, hence the raw-HTML scan).
    attachment_url = (
        _find_attachment_in_page(content_el, base_url)
        or _find_attachment_in_page(soup, base_url)
        or _find_attachment_in_scripts(result.html or "", base_url)
    )

    all_attachments = _scan_all_attachments(soup, result.html or "", base_url)

    return {
        "title": title,
        "published_raw": published_raw,
        "content_text": content_text,
        "content_html": content_html,
        "attachment_url": attachment_url,
        "attachments": all_attachments,
    }


# --- attachment scanning (full page) ---

_ATTACHMENT_PATH_HINTS = ("/download/", "/uploads/", "/attachment/", "/media/", "/files/")


def _scan_all_attachments(soup: BeautifulSoup, raw_html: str, base_url: str) -> list[dict]:
    """Scan the entire detail page for all file-like links (PDFs, docs, images, etc.)."""
    seen_urls: set[str] = set()
    attachments: list[dict] = []

    for anchor in soup.find_all("a", href=True):
        href = anchor["href"].strip()
        if not href or href in ("#", "javascript:void(0)"):
            continue
        abs_url = _absolute_url(base_url, href)
        if not abs_url or abs_url in seen_urls:
            continue
        lower_href = href.lower().split("?")[0]
        is_file = any(lower_href.endswith(ext) for ext in _FILE_EXTENSIONS)
        has_path_hint = any(hint in href.lower() for hint in _ATTACHMENT_PATH_HINTS)
        if not is_file and not has_path_hint:
            continue
        seen_urls.add(abs_url)
        label = _clean_text(anchor.get_text(" ", strip=True)) or None
        attachments.append({"url": abs_url, "label": label})

    # Also check JS-embedded URLs (PDF viewers)
    for match in _JS_FILE_URL_RE.finditer(raw_html):
        js_url = _absolute_url(base_url, match.group(1))
        if js_url and js_url not in seen_urls:
            seen_urls.add(js_url)
            attachments.append({"url": js_url, "label": None})

    return attachments


# --- slug-based category inference ---

_CATEGORY_SLUG_MAP = {
    "notice": "NOTICE",
    "notices": "NOTICE",
    "suchana": "NOTICE",
    "news": "NEWS",
    "samachar": "NEWS",
    "press-release": "PRESS_RELEASE",
    "press_release": "PRESS_RELEASE",
    "pressrelease": "PRESS_RELEASE",
    "circular": "CIRCULAR",
    "paripatra": "CIRCULAR",
    "tender": "TENDER",
    "bid": "TENDER",
    "boli": "TENDER",
    "vacancy": "VACANCY",
    "job": "JOB",
    "career": "JOB",
    "intern": "INTERNSHIP",
    "internship": "INTERNSHIP",
    "trainee": "INTERNSHIP",
}


def _infer_category_from_slug(url: str) -> tuple[str | None, str | None]:
    """Parse URL path segments to infer a category. Returns (category, raw_slug)."""
    try:
        path = urlparse(url).path.lower().strip("/")
    except Exception:
        return None, None
    segments = [s for s in path.split("/") if s and not s.isdigit()]
    for segment in segments:
        clean = segment.replace("_", "-")
        if clean in _CATEGORY_SLUG_MAP:
            return _CATEGORY_SLUG_MAP[clean], segment
        # Check if segment contains a category keyword
        for key, cat in _CATEGORY_SLUG_MAP.items():
            if key in clean and len(clean) < 30:
                return cat, segment
    return None, None


# ---------------------------------------------------------------------------
# Item admission control
#
# This site aggregates ONE kind of thing: notices, news and press releases
# published by government bodies. Everything a listing page also contains —
# navigation, "read more" links, category/tag indexes, logins, social buttons —
# used to be stored as "(untitled) / Other" rows with no date. The gates below
# decide what earns a row.
# ---------------------------------------------------------------------------

# Path segments that are never an individual notice.
_NON_ARTICLE_PATH_SEGMENTS = {
    "category", "categories", "tag", "tags", "author", "search", "login",
    "signin", "signup", "register", "logout", "contact", "about", "about-us",
    "privacy", "terms", "sitemap", "feed", "rss", "gallery", "photo", "photos",
    "video", "videos", "faq", "help", "cart", "checkout", "account", "profile",
    "page", "pages", "wp-admin", "wp-login", "admin", "user", "users",
    "organization", "staff", "team", "downloads-page",
    # Institutional landing/section pages. University and ministry listings
    # mix these into the same markup as real notice rows, so without this a
    # generic schema happily scrapes "Fee Structure" or "Departments" as if
    # each were a published notice.
    "department", "departments", "faculty", "faculties", "school", "schools",
    "programs", "programmes", "courses", "curriculum", "syllabus",
    "admission", "admissions", "fee-structure", "fees", "scholarship",
    "scholarships", "library", "alumni", "research", "publication",
    "publications", "event", "events", "calendar", "directory",
    "leadership", "governance", "history", "vision", "mission",
    "facilities", "campus", "campuses", "collaboration", "collaborations",
    "career", "careers", "vacancy-career", "index", "home",
    "collaborative-programs", "news-app",
}

# Link text that marks a navigation affordance rather than a document title.
_NON_TITLE_PHRASES = {
    "read more", "readmore", "view more", "view all", "see more", "see all",
    "more", "details", "detail", "view detail", "view details", "click here",
    "download", "downloads", "open", "next", "previous", "prev", "first",
    "last", "home", "back", "continue", "learn more", "show more",
    "थप", "थप पढ्नुहोस्", "विस्तृत", "हेर्नुहोस्", "डाउनलोड", "अगाडि", "पछाडि",
    "सबै हेर्नुहोस्", "थप जानकारी",
}

_MIN_TITLE_CHARS = 8

# Hosts we never follow — a government listing page linking to Facebook does
# not make that Facebook post a public notice.
_OFFSITE_HOST_HINTS = (
    "facebook.", "twitter.", "x.com", "instagram.", "youtube.", "youtu.be",
    "linkedin.", "tiktok.", "whatsapp.", "telegram.", "google.com/maps",
)


def _looks_like_title(text: str | None) -> bool:
    """True when the string reads like a document title rather than a control."""
    if not text:
        return False
    cleaned = " ".join(text.split()).strip(" .:-–—|")
    if len(cleaned) < _MIN_TITLE_CHARS:
        return False
    if cleaned.lower() in _NON_TITLE_PHRASES:
        return False
    # Bare dates, numbers or reference codes are not titles.
    if not re.search(r"[A-Za-zऀ-ॿ]", cleaned):
        return False
    letters = len(re.findall(r"[A-Za-zऀ-ॿ]", cleaned))
    if letters < 5:
        return False
    return True


def _is_probable_article_url(url: str, base_url: str, listing_urls: set[str]) -> bool:
    """True when the URL plausibly points at one notice/news/press release."""
    try:
        parsed = urlparse(url)
        base = urlparse(base_url)
    except Exception:
        return False

    if parsed.scheme not in ("http", "https"):
        return False
    if any(hint in (parsed.netloc or "").lower() for hint in _OFFSITE_HOST_HINTS):
        return False

    # Stay on the source's own site: a government portal's own domain is the
    # authority we aggregate. Sibling subdomains count (bfr.nrb.org.np belongs
    # to www.nrb.org.np), so compare with the "www." prefix removed.
    def registrable(netloc: str) -> str:
        host = (netloc or "").lower().split(":")[0]
        return host[4:] if host.startswith("www.") else host

    host, base_host = registrable(parsed.netloc), registrable(base.netloc)
    if host and base_host and not (
        host == base_host
        or host.endswith("." + base_host)
        or base_host.endswith("." + host)
    ):
        return False

    normalized = url.split("#")[0].rstrip("/")
    if not normalized or normalized in {u.split("#")[0].rstrip("/") for u in listing_urls}:
        return False
    if normalized.rstrip("/") == base_url.rstrip("/"):
        return False

    path = (parsed.path or "").lower()
    segments = [s for s in path.strip("/").split("/") if s]
    if not segments and not parsed.query:
        return False  # the site root

    # A direct document link is a legitimate notice on many portals.
    if path.endswith(_FILE_EXTENSIONS):
        return True

    if any(seg in _NON_ARTICLE_PATH_SEGMENTS for seg in segments):
        return False

    # A CMS page addressed only by an opaque id (`/?page_id=4811`) carries no
    # slug to judge, and on the portals we aggregate these are static section
    # pages rather than notices. Real notices are either slugged or served
    # from a content path, both of which have segments.
    if not segments and parsed.query:
        return False

    # Query strings that select/filter a *set* of items describe a listing
    # view, not one document — e.g. `/news-app?search_category=2&search_school=10`.
    # A real notice is identified, not filtered.
    if parsed.query:
        query_keys = {
            k.split("=")[0].lower() for k in parsed.query.split("&") if k
        }
        if any(
            key.startswith(("search", "filter"))
            or key in {"category", "cat", "tag", "type", "sort", "order", "q", "s", "keyword"}
            for key in query_keys
        ):
            return False

    return True


def _title_from_attachment(url: str | None) -> str | None:
    """Humanised filename, used when a portal links a PDF with no link text."""
    if not url:
        return None
    name = unquote(urlparse(url).path.rsplit("/", 1)[-1])
    name = re.sub(r"\.[A-Za-z0-9]{2,5}$", "", name)
    name = re.sub(r"[_\-+]+", " ", name)
    name = re.sub(r"\s{2,}", " ", name).strip()

    # Drop a trailing upload-id like "paripatra1_kjf9zr" → letters AND digits
    # mixed in one short token. Real words ("statement") are kept.
    words = name.split()
    if words and len(words[-1]) <= 8 and re.search(r"\d", words[-1]) and re.search(r"[a-z]", words[-1], re.I):
        words = words[:-1]
    name = " ".join(words)

    # One bare token ("paripatra1") is a filename, not a title — better to fall
    # through to the detail page's heading than to store noise.
    if len(words) < 2:
        return None
    return name if _looks_like_title(name) else None


def _sitemap_section(urls: list[str]) -> str:
    """The most common leading path segment across sitemap URLs (e.g.
    /content/), used as a category-inference fallback when individual URLs
    carry no category slug. Returns "" when URLs disagree or are empty."""
    from collections import Counter

    counters: dict[int, Counter] = {}
    for url in urls:
        try:
            segments = [s for s in urlparse(url).path.lower().split("/") if s]
        except Exception:
            continue
        if not segments:
            continue
        depth = 1 if len(segments) == 1 else 2
        counters.setdefault(depth, Counter()).update(["/".join(segments[:depth])])
    for depth in sorted(counters, reverse=True):
        section, _ = counters[depth].most_common(1)[0]
        return f"https://x/{section}/"
    return ""


# --- metadata extraction ---

_REF_NUMBER_RE = re.compile(
    r"(?:notice|ref|reference|letter|file|ch\.?|no\.?|sankhya)[:\s#]*"
    r"([\w\-/().]+\d[\w\-/().]*)",
    re.IGNORECASE,
)
_DEADLINE_RE = re.compile(
    r"(?:deadline|last\s*date|due\s*date|expires?|valid\s*(?:until|till|up\s*to))[:\s]*"
    r"([^\n,;]{8,40})",
    re.IGNORECASE,
)


def _extract_metadata(title: str, content: str | None) -> dict | None:
    """Extract structured metadata (reference number, deadline) when confident."""
    if not content:
        return None
    text = f"{title}\n{content[:3000]}"
    meta: dict = {}

    ref_match = _REF_NUMBER_RE.search(text)
    if ref_match:
        ref = ref_match.group(1).strip().rstrip(".")
        if 3 <= len(ref) <= 50:
            meta["referenceNumber"] = ref

    deadline_match = _DEADLINE_RE.search(text)
    if deadline_match:
        raw_deadline = deadline_match.group(1).strip()
        parsed = _parse_published(raw_deadline)
        if parsed:
            meta["deadline"] = parsed

    return meta if meta else None


# --- concurrent AI summarization ---
#
# Summarization/classification prompting and provider fallback both live in
# app/llm.py now (_ANALYZE_PROMPT, analyze_notice) — shared with the
# on-demand /notices/analyze route rather than duplicated here. See
# _summarize_item below.


async def _summarize_item(title: str, content: str, category_hint: str | None) -> dict | None:
    """Summarize + classify one scraped item. Delegates to llm.analyze_notice,
    which runs the request through the full provider fallback chain —
    OpenRouter's several free models (each with its own independent daily
    quota), then Groq, Gemini, OpenCode, Bedrock, in the admin's configured
    order — instead of this function's previous hand-rolled, Groq-only
    implementation with its own key-rotation loop.

    That old implementation is why a source's whole run could stall on
    Groq's free-tier rate limit even when every other configured provider
    was healthy and idle: Groq was the ONLY thing this function knew how to
    call. A scrape run now degrades the same way every other LLM call in
    this service already does — by falling through its provider chain, not
    by retrying one exhausted provider for up to ~30s per item."""
    result = await llm.analyze_notice(title, content, category_hint)
    if result is None:
        logger.warning("Summarization failed for: %s", title[:60])
    return result


@dataclass
class PaginationConfig:
    """How to build a listing page's URL for page N. Sites disagree wildly
    on this, so it's admin-configurable per source rather than assumed."""
    pagination_type: str = "QUERY_PARAM"  # QUERY_PARAM | PATH_TEMPLATE | NONE
    param: str = "page"
    start_page: int = 1


def _paginated_url(listing_url: str, page_index: int, config: PaginationConfig) -> str:
    """`page_index` is 0-based (0 = first page fetched)."""
    page_number = config.start_page + page_index

    if config.pagination_type == "NONE":
        return listing_url if page_index == 0 else ""

    if config.pagination_type == "PATH_TEMPLATE":
        if "{page}" in listing_url:
            return listing_url.replace("{page}", str(page_number))
        # No placeholder configured — behave like a single page rather than
        # silently repeating page 1's URL for every "page".
        return listing_url if page_index == 0 else ""

    # QUERY_PARAM (default)
    if page_index == 0 and config.start_page == 1:
        return listing_url
    separator = "&" if urlparse(listing_url).query else "?"
    return f"{listing_url}{separator}{config.param}={page_number}"


# Pagination schemes tried, in order, when the configured one turns out to be
# a no-op for a site. `?page=` is the project-wide default and is right for
# most of these sources, but WordPress installs use `?paged=` (or /page/N) and
# a few use `?p=`. A site that simply ignores an unknown query parameter
# happily serves page 1 forever, so an unvalidated guess doesn't fail loudly —
# it silently re-ingests the same rows `max_pages` times.
_PAGINATION_FALLBACKS = [
    PaginationConfig(pagination_type="QUERY_PARAM", param="page"),
    PaginationConfig(pagination_type="QUERY_PARAM", param="paged"),
    PaginationConfig(pagination_type="QUERY_PARAM", param="p"),
    PaginationConfig(pagination_type="PATH_TEMPLATE", param="page"),
]


def _row_fingerprints(rows: list[dict]) -> set[str]:
    """Identity of a page of listing rows, for "is this the same page?" tests.

    Keyed on detail_href where present (stable and unique per item) and on the
    title otherwise, so a page that merely re-renders in a different order
    still compares equal.
    """
    out = set()
    for row in rows:
        key = (row.get("detail_href") or "").strip() or (row.get("title") or "").strip()
        if key:
            out.add(key)
    return out


def _pages_overlap(first: set[str], second: set[str]) -> float:
    """Fraction of `second` already seen in `first` (1.0 == identical page)."""
    if not second:
        return 1.0
    return len(first & second) / len(second)


# A page-2 probe counts as "pagination works" when it brings this many genuinely
# new rows, both absolutely and as a share of the page. A share alone is too
# strict: when schema detection settles on a coarse baseSelector the row set
# includes sidebar/nav elements repeated on every page, so a working scheme can
# still show ~60% overlap (observed on nrb.org.np). What is never ambiguous is
# whether page 2 contributed items page 1 did not.
_PAGINATION_MIN_NEW_ROWS = 3
_PAGINATION_MIN_NEW_RATIO = 0.25


def _page_adds_new(first: set[str], second: set[str]) -> bool:
    if not second:
        return False
    new = second - first
    return len(new) >= _PAGINATION_MIN_NEW_ROWS and (
        len(new) / len(second) >= _PAGINATION_MIN_NEW_RATIO
    )


def _page_adds_any_new(first: set[str], second: set[str]) -> bool:
    """Deep-crawl variant: one unseen row is enough to keep walking.

    The thresholds above exist to stop a run early when a site ignores the
    page parameter and re-serves page 1 — but they also discard a genuine
    final page holding fewer rows than the threshold (page 3 of 23 results
    at 10/page has exactly 3). A deep crawl is explicitly asked to be
    complete, so it only stops on a page that is wholly a repeat."""
    return bool(second) and bool(second - first)


def _path_template_url(listing_url: str, page_number: int) -> str:
    return listing_url.rstrip("/") + f"/page/{page_number}"


# --- pager discovery ---
#
# Guessing a pagination scheme and probing page 2 tells us *a* way forward; it
# never tells us how far the listing goes. The page itself does: almost every
# one of these portals renders a "1 2 3 ›" widget and a "Showing 1 to 10 of 23
# results" counter (moha.gov.np/page/act-regulation is the canonical example).
# Reading both turns "walk pages until one repeats" into "walk exactly the 3
# pages this listing has", which is what a deep crawl needs to be complete
# without being unbounded.

# Class/id substrings marking the pager container.
_PAGER_HINTS = ("pagination", "pager", "page-numbers", "paging", "page-nav", "pagenav")

# Query parameters that carry a 1-based page *number*. Deliberately excludes
# offset/start-style params: those count rows, not pages, and feeding a page
# number into one silently re-serves page 1.
_PAGE_PARAMS = ("page", "paged", "p", "pg", "pageno", "page_no", "pagenumber", "page_number")

_PATH_PAGE_RE = re.compile(r"/page/(\d+)/?$", re.IGNORECASE)

# Livewire pagers: `wire:click="gotoPage(2, 'page')"` and the matching
# `wire:key="paginator-page-page-2"` on the active item.
_WIRE_GOTO_PAGE_RE = re.compile(r"gotoPage\(\s*(\d+)\s*,\s*['\"]([^'\"]+)['\"]")
_WIRE_PAGINATOR_KEY_RE = re.compile(r"^paginator-page-(.+)-(\d+)$")

# "Showing 1 to 10 of 23 results" / "Showing 1-10 of 23 entries" and the
# bare "of 23 results" some themes render instead.
_SHOWING_RE = re.compile(
    r"showing\s+([\d,]+)\s*(?:to|-|–|—)\s*([\d,]+)\s+of\s+([\d,]+)", re.IGNORECASE
)
_TOTAL_RE = re.compile(r"of\s+([\d,]+)\s+(?:results?|entries|items|records)", re.IGNORECASE)

# A pager link claiming more pages than this is markup we misread (a year
# filter, a phone number in an href), not a page count.
_MAX_CREDIBLE_PAGES = 5000


@dataclass
class PagerInfo:
    """What the listing page says about its own pagination."""
    config: PaginationConfig | None = None
    last_page: int | None = None
    total_results: int | None = None
    per_page: int | None = None


def _int_or_none(raw: str | None) -> int | None:
    if not raw:
        return None
    try:
        return int(raw.replace(",", ""))
    except ValueError:
        return None


def _page_number_from_href(href: str, listing_url: str) -> tuple[str, str, int] | None:
    """`(pagination_type, param, page_number)` for one pager link, or None."""
    absolute = _absolute_url(listing_url, href)
    if not absolute or not _is_same_origin(absolute, listing_url):
        return None
    parsed = urlparse(absolute)

    for key, values in parse_qs(parsed.query).items():
        if key.lower() in _PAGE_PARAMS and values:
            number = _int_or_none(values[0])
            if number is not None and 0 <= number <= _MAX_CREDIBLE_PAGES:
                return ("QUERY_PARAM", key, number)

    path_match = _PATH_PAGE_RE.search(parsed.path)
    if path_match:
        number = _int_or_none(path_match.group(1))
        # The listing's own path must be the pager link's prefix, otherwise
        # this is some other paginated section linked from the sidebar.
        prefix = parsed.path[: path_match.start()].rstrip("/")
        if number is not None and 0 <= number <= _MAX_CREDIBLE_PAGES:
            if prefix and urlparse(listing_url).path.rstrip("/").endswith(prefix):
                return ("PATH_TEMPLATE", "page", number)
    return None


def _pager_containers(soup: BeautifulSoup) -> list:
    """Elements whose class/id/aria-label marks them as a pagination widget."""

    def is_pager(attr_value) -> bool:
        if not attr_value:
            return False
        text = " ".join(attr_value) if isinstance(attr_value, list) else str(attr_value)
        return any(hint in text.lower() for hint in _PAGER_HINTS)

    return soup.find_all(
        lambda tag: is_pager(tag.get("class"))
        or is_pager(tag.get("id"))
        or is_pager(tag.get("aria-label"))
    )


def _pager_page_refs(soup: BeautifulSoup, listing_url: str) -> list[tuple[str, str, int]]:
    """Every `(pagination_type, param, page_number)` the pager widget declares.

    Covers three markups, because these portals use all three:
      * plain `<a href="?page=2">` links;
      * Livewire buttons — `wire:click="gotoPage(2, 'page')"` with no href at
        all, which is what moha.gov.np and most Laravel gov portals render
        (the query parameter still works server-side, the pager just doesn't
        link it);
      * unstyled pagers with no recognisable container, where the only signal
        is an anchor whose visible text is a bare page number.
    """
    refs: list[tuple[str, str, int]] = []
    containers = _pager_containers(soup)

    for container in containers:
        for anchor in container.find_all("a", href=True):
            found = _page_number_from_href(anchor["href"], listing_url)
            if found:
                refs.append(found)

        for el in container.find_all(attrs={"wire:click": True}):
            match = _WIRE_GOTO_PAGE_RE.search(el["wire:click"])
            if match:
                number = _int_or_none(match.group(1))
                if number is not None and 0 <= number <= _MAX_CREDIBLE_PAGES:
                    refs.append(("QUERY_PARAM", match.group(2), number))

        # Livewire also stamps `wire:key="paginator-page-<param>-<n>"` on the
        # active page's <li>, which has no button to read the param off.
        for el in container.find_all(attrs={"wire:key": True}):
            match = _WIRE_PAGINATOR_KEY_RE.match(el["wire:key"])
            if match:
                number = _int_or_none(match.group(2))
                if number is not None and 0 <= number <= _MAX_CREDIBLE_PAGES:
                    refs.append(("QUERY_PARAM", match.group(1), number))

    if refs or containers:
        return refs

    for anchor in soup.find_all("a", href=True):
        if anchor.get_text(strip=True).isdigit():
            found = _page_number_from_href(anchor["href"], listing_url)
            if found:
                refs.append(found)
    return refs


def _discover_pager(html: str | None, listing_url: str) -> PagerInfo:
    """Read the listing's own pager widget and result counter.

    Returns whatever could be established — a scheme with no page count, a
    count with no scheme, or an empty PagerInfo. Nothing here is trusted
    blindly: the caller still verifies the scheme by fetching page 2.
    """
    if not html:
        return PagerInfo()

    try:
        soup = BeautifulSoup(html, "html.parser")
    except Exception:
        return PagerInfo()

    # Highest page number seen per scheme, and how many links voted for it.
    schemes: dict[tuple[str, str], list[int]] = {}
    for kind, param, number in _pager_page_refs(soup, listing_url):
        schemes.setdefault((kind, param), []).append(number)

    config: PaginationConfig | None = None
    last_page: int | None = None
    if schemes:
        # Most-linked scheme wins; ties break toward the larger page range.
        (kind, param), numbers = max(
            schemes.items(), key=lambda kv: (len(kv[1]), max(kv[1]))
        )
        # A pager that only ever links page 1 is not pagination.
        if max(numbers) > min(numbers) or max(numbers) > 1:
            start_page = 0 if min(numbers) == 0 else 1
            config = PaginationConfig(pagination_type=kind, param=param, start_page=start_page)
            last_page = max(numbers)

    text = soup.get_text(" ", strip=True)
    total_results = None
    per_page = None
    showing = _SHOWING_RE.search(text)
    if showing:
        first, last, total = (_int_or_none(showing.group(i)) for i in (1, 2, 3))
        total_results = total
        # Only the first window is guaranteed to be a *full* page. "Showing 21
        # to 23 of 23" is the last three rows of a 10-per-page listing, not a
        # 3-per-page one, and treating it as the latter turns 3 pages into 8.
        if first == 1 and last is not None and last >= first:
            per_page = last
        total_match = _TOTAL_RE.search(text)
        if total_match:
            total_results = _int_or_none(total_match.group(1))

    # The counter is authoritative where the widget truncates ("1 2 3 … 47"
    # renders only a few numbers on some themes).
    if total_results and per_page:
        counted_pages = -(-total_results // per_page)  # ceil
        if counted_pages <= _MAX_CREDIBLE_PAGES:
            last_page = max(last_page or 0, counted_pages) or None

    if config or last_page or total_results:
        logger.info(
            "Pager for %s: scheme=%s last_page=%s total_results=%s",
            listing_url,
            f"{config.pagination_type}/{config.param}" if config else "none",
            last_page,
            total_results,
        )
    return PagerInfo(
        config=config, last_page=last_page, total_results=total_results, per_page=per_page
    )


async def _detect_pagination(
    crawler: AsyncWebCrawler,
    listing_url: str,
    schema: dict,
    page1: set[str],
    configured: PaginationConfig,
    discovered: PaginationConfig | None = None,
    accept_any_new: bool = False,
) -> tuple[PaginationConfig | None, list[dict]]:
    """Find a pagination scheme whose page 2 actually differs from page 1.

    Returns `(config, page_2_rows)`, or `(None, [])` if the listing is
    genuinely a single page — a real answer, not a failure: many of these
    sources show every notice on one page. The winning probe's rows are
    handed back so the caller can use them directly instead of re-fetching
    page 2, which otherwise costs an extra headless-browser load per
    category on every single run.

    `discovered` is the scheme read off the page's own pager widget and is
    tried first — it is the site's own answer, not a guess. `accept_any_new`
    relaxes the "page 2 must add several rows" bar to "page 2 must add a
    row", which a deep crawl needs so a short final page still counts.
    """
    tried: set[tuple[str, str]] = set()
    candidates = [c for c in (discovered, configured) if c] + [
        c for c in _PAGINATION_FALLBACKS
        if (c.pagination_type, c.param) != (configured.pagination_type, configured.param)
    ]
    adds_new = _page_adds_any_new if accept_any_new else _page_adds_new

    for cand in candidates:
        key = (cand.pagination_type, cand.param)
        if cand.pagination_type == "NONE" or key in tried:
            continue
        tried.add(key)

        if cand.pagination_type == "PATH_TEMPLATE":
            url = _path_template_url(listing_url, cand.start_page + 1)
        else:
            url = _paginated_url(listing_url, 1, cand)
        if not url:
            continue

        rows = await _extract_with_schema(crawler, url, schema, None)
        if len(rows) < 2:
            continue
        if adds_new(page1, _row_fingerprints(rows)):
            logger.info(
                "Pagination for %s resolved to %s/%s",
                listing_url, cand.pagination_type, cand.param,
            )
            return cand, rows

    logger.info("No working pagination scheme for %s — treating as single page", listing_url)
    return None, []


_SUMMARIZE_CONCURRENCY = config.SUMMARIZE_CONCURRENCY


# --- sitemap fast-path ---
#
# Sites that expose a real XML sitemap can be polled with a single cheap GET
# (no crawl4ai/Playwright) instead of a full listing crawl every cycle. The
# winning sitemap URL is detected once and cached by the API (mirroring how
# noticeSchema/newsSchema cache CSS extraction patterns), so every check after
# the first is pure HTTP.

# A usable sitemap must expose at least this many per-article URLs. This is
# the guard against "fake" 2-URL sitemaps (observed on ku.edu.np) — a real
# articles sitemap has dozens or hundreds of entries.
_MIN_SITEMAP_LOCS = 10

# ...and at least this fraction of same-origin entries must look like article
# detail pages (numeric id segments or content/notice/news/... path hints).
# KU's sitemap.xml passes the count check but is ~93% subdomain landing
# pages, which would trigger a full crawl on every poll — a fast-path that
# never saves anything isn't a fast-path.
_MIN_SITEMAP_ARTICLE_RATIO = 0.5

# Substrings that mark a sitemap as article-bearing vs taxonomy/navigation.
# When a <sitemapindex> (or several robots.txt Sitemap: directives) lists
# multiple children, the highest-scoring article sitemap wins.
_SITEMAP_PREFERRED_HINTS = ("news", "post", "content", "article", "notice", "press")
_SITEMAP_SKIPPED_HINTS = (
    "page",
    "category",
    "tag",
    "gallery",
    "image",
    "media",
    "author",
    "archive",
    "product",
    "video",
    "attachment",
)

# Bounds on one detection/check session — keeps an adversarial giant
# sitemapindex from triggering unbounded fan-out.
_MAX_SITEMAP_CANDIDATES = 15
_MAX_SITEMAP_INDEX_FETCHES = 20

_SITEMAP_USER_AGENT = "PublicNoticeManagementBot/1.0 (+sitemap checker)"
# Split rather than one scalar: a single `timeout=20.0` applies 20s to the
# *connect* phase too, so probing a host that simply doesn't answer burned
# 20s on /robots.txt and another 20s on /sitemap.xml — a 40s request for a
# site that was never reachable. A host that hasn't completed a TCP handshake
# in 5s is down; reads stay generous because sitemaps can be large and are
# often generated on demand.
_SITEMAP_TIMEOUT = httpx.Timeout(20.0, connect=5.0, pool=5.0)

# Numeric-id or content-ish path segments mark a URL as an article detail
# page rather than a landing/section page (used by the article-ratio check).
_ARTICLE_PATH_HINTS = ("content", "article", "post", "news", "notice", "press", "detail", "item")
_ARTICLE_ID_RE = re.compile(r"\d{3,}")


def _local_name(tag: str) -> str:
    """Strip an XML namespace from an element tag ('{ns}loc' -> 'loc')."""
    if "}" in tag:
        return tag.rsplit("}", 1)[1]
    return tag


def _normalized_host(url: str) -> str:
    """Lowercased host with a leading 'www.' stripped, so www/non-www
    variants compare equal."""
    host = (urlparse(url).netloc or "").lower()
    if host.startswith("www."):
        host = host[4:]
    return host


def _is_same_origin(url: str, base_url: str) -> bool:
    """True when `url` is on the same site as `base_url` (exact host, or a
    subdomain of it after stripping a leading www.). Rejects KU-style fake
    sitemaps whose <loc>s are entirely other institutions' subdomains."""
    host = _normalized_host(url)
    base = _normalized_host(base_url)
    if not host or not base:
        return False
    return host == base or host.endswith(f".{base}")


def _article_like_ratio(urls: list[str]) -> float:
    """Fraction of URLs whose path looks like an article detail page (has a
    numeric id run or a content-ish segment) rather than a section/landing
    page. Real articles sitemaps score ~1.0; landing-page dumps score ~0.05."""
    if not urls:
        return 0.0
    article_like = 0
    for url in urls:
        path = urlparse(url).path.lower()
        if _ARTICLE_ID_RE.search(path) or any(hint in path for hint in _ARTICLE_PATH_HINTS):
            article_like += 1
    return article_like / len(urls)


def _iter_sitemap_locs(root) -> list[tuple[str, str | None]]:
    """Collect (loc, lastmod) for direct children of <url>/<sitemap>.

    Extension namespace locs (image:, video:) are ignored — media, not pages.
    lastmod is optional and returned raw; callers parse leniently.
    """
    entries: list[tuple[str, str | None]] = []
    for parent in root:
        if not ET.iselement(parent) or _local_name(parent.tag) not in ("url", "sitemap"):
            continue
        loc = None
        lastmod = None
        for child in parent:
            name = _local_name(child.tag)
            if name == "loc" and child.text:
                loc = child.text.strip()
            elif name == "lastmod" and child.text:
                lastmod = child.text.strip()
        if loc:
            entries.append((loc, lastmod))
    return entries


def _parse_lastmod(raw: str | None) -> datetime | None:
    """W3C datetime from <lastmod>; None if absent or unparseable."""
    if not raw:
        return None
    text = raw.strip()
    try:
        # Accept both "2026-08-01" and full ISO-8601 with offset / trailing Z.
        return datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None


class _HostUnreachable(Exception):
    """The host never completed a connection — as opposed to answering with an
    error. Lets detect_sitemap skip further probes against a dead host instead
    of paying the timeout again for each one."""


class _SitemapUnchanged(Exception):
    """Server answered 304 — our cached copy is current, nothing to re-parse."""


# ETag / Last-Modified per sitemap URL, so a poll that changes nothing costs
# a 304 instead of re-downloading the whole file. Bounded: government
# portals have a handful of sitemaps each, and a cold cache just means one
# normal fetch.
_SITEMAP_VALIDATORS: dict[str, dict[str, str]] = {}
_MAX_VALIDATOR_ENTRIES = 512

# Last-seen kind ('urlset' | 'sitemapindex') per URL. A 304 is only safe to
# act on for a leaf urlset: an index can return 304 while a child sitemap's
# contents changed underneath it, and skipping it would miss new notices.
_SITEMAP_KIND: dict[str, str] = {}


def _remember_validators(url: str, response: httpx.Response) -> None:
    """Cache this response's ETag / Last-Modified for the next conditional GET."""
    validators = {}
    if etag := response.headers.get("etag"):
        validators["If-None-Match"] = etag
    if last_modified := response.headers.get("last-modified"):
        validators["If-Modified-Since"] = last_modified
    if not validators:
        _SITEMAP_VALIDATORS.pop(url, None)
        return
    if len(_SITEMAP_VALIDATORS) >= _MAX_VALIDATOR_ENTRIES and url not in _SITEMAP_VALIDATORS:
        _SITEMAP_VALIDATORS.pop(next(iter(_SITEMAP_VALIDATORS)), None)
    _SITEMAP_VALIDATORS[url] = validators


def _decode_sitemap_body(response: httpx.Response) -> str | None:
    """Text of a sitemap response, un-gzipping .xml.gz payloads.

    httpx transparently handles Content-Encoding, but a `.xml.gz` file is
    gzip *content* served as an octet-stream — it arrives still compressed,
    and feeding those bytes to the XML parser raises ParseError. That read
    as "no sitemap here", so gzipped government sitemaps were cached as
    absent and their sources fell back to full crawls forever.
    """
    raw = response.content
    if raw[:2] == b"\x1f\x8b":  # gzip magic number
        try:
            raw = gzip.decompress(raw)
        except (OSError, EOFError, zlib.error) as e:
            logger.warning("Sitemap %s looked gzipped but would not decompress (%s)", response.url, type(e).__name__)
            return None
        return raw.decode("utf-8", errors="replace")
    return response.text


async def _fetch_text(url: str, headers: dict | None = None) -> str | None:
    """One polite GET. Plain httpx — no Playwright, no crawl4ai.

    Raises _HostUnreachable when the host itself never answered; returns None
    for every other failure (HTTP error, malformed response), which callers
    treat as "no sitemap here" rather than "site is down".
    """
    try:
        async with httpx.AsyncClient(
            timeout=_SITEMAP_TIMEOUT, follow_redirects=True
        ) as client:
            response = await client.get(
                url,
                headers={
                    "User-Agent": _SITEMAP_USER_AGENT,
                    "Accept": "*/*",
                    **(headers or {}),
                },
            )
        # 304 means our cached copy is still current — nothing changed.
        if response.status_code == 304:
            raise _SitemapUnchanged(url)
        if response.status_code != 200:
            logger.info("Sitemap fetch %s -> HTTP %d", url, response.status_code)
            return None
        _remember_validators(url, response)
        return _decode_sitemap_body(response)
    except (_HostUnreachable, _SitemapUnchanged):
        # Control-flow signals for the caller — must not be swallowed by the
        # catch-all below.
        raise
    except (httpx.ConnectError, httpx.ConnectTimeout) as e:
        # Routine for a site that is down, firewalled, or blocking our UA —
        # a one-line warning, not the ~60-line httpx traceback this used to
        # dump into the logs on every unreachable government portal.
        logger.warning("Sitemap fetch could not reach %s (%s)", url, type(e).__name__)
        raise _HostUnreachable(url) from e
    except httpx.HTTPError as e:
        logger.warning("Sitemap fetch failed for %s (%s)", url, type(e).__name__)
        return None
    except Exception:
        # Genuinely unexpected — keep the traceback for this one.
        logger.warning("Sitemap fetch failed for %s", url, exc_info=True)
        return None


async def _fetch_sitemap(
    url: str, conditional: bool = False
) -> tuple[str, list[tuple[str, str | None]]] | None:
    """Fetch + parse one sitemap file. Returns (kind, entries) where kind is
    'urlset' (leaf article URLs) or 'sitemapindex' (child sitemap URLs), or
    None on any failure (HTTP error, non-XML, empty).

    With conditional=True, sends cached ETag/Last-Modified and raises
    _SitemapUnchanged on a 304. Only requested for URLs last seen as a leaf
    urlset — see _SITEMAP_KIND.
    """
    headers = _SITEMAP_VALIDATORS.get(url) if conditional else None
    try:
        text = await _fetch_text(url, headers)
    except _HostUnreachable:
        # Contained here so this function keeps its "None on any failure"
        # contract — its four call sites all branch on None. Only
        # detect_sitemap's first probe cares about the distinction.
        return None
    if not text:
        return None
    try:
        root = ET.fromstring(text)
    except ET.ParseError:
        logger.info("Sitemap %s is not valid XML", url)
        return None
    kind = _local_name(root.tag)
    _SITEMAP_KIND[url] = kind
    return kind, _iter_sitemap_locs(root)


def _score_sitemap_child(url: str) -> int:
    path = urlparse(url).path.lower()
    score = 0
    for hint in _SITEMAP_PREFERRED_HINTS:
        if hint in path:
            score += 3
    for hint in _SITEMAP_SKIPPED_HINTS:
        if hint in path:
            score -= 5
    return score


async def detect_sitemap(base_url: str) -> str | None:
    """Detect the article-bearing XML sitemap for a site, or None if nothing
    usable exists. Detection order mirrors the tiered schema detection: check
    robots.txt for a Sitemap: directive, else probe /sitemap.xml directly;
    follow a <sitemapindex> to the child most likely to hold articles (name
    matches news/post/content, skip page/category/tag/gallery); verify it
    returns genuinely per-article <loc> entries (guards against 2-URL fakes).
    The caller caches the winner (or null) so this runs once, not per tick."""
    base = base_url.rstrip("/")

    candidates: list[str] = []
    try:
        robots = await _fetch_text(f"{base}/robots.txt")
    except _HostUnreachable:
        # The host didn't answer at all, so probing /sitemap.xml would only
        # buy a second identical timeout. Bail out on the first signal.
        logger.info("Host unreachable, skipping sitemap detection for %s", base)
        return None

    if robots:
        for line in robots.splitlines():
            stripped = line.strip()
            if stripped.lower().startswith("sitemap:"):
                declared = stripped.split(":", 1)[1].strip()
                if declared:
                    candidates.append(urljoin(f"{base}/", declared))

    if not candidates:
        root_sitemap = f"{base}/sitemap.xml"
        fetched = await _fetch_sitemap(root_sitemap)
        if fetched is not None:
            candidates.append(root_sitemap)
    if not candidates:
        logger.info("No sitemap advertised in robots.txt nor at /sitemap.xml for %s", base)
        return None

    # Flatten <sitemapindex> candidates into their leaf children, then rank
    # every leaf by how article-like its filename is.
    leaves: list[str] = []
    for candidate in candidates[:_MAX_SITEMAP_CANDIDATES]:
        fetched = await _fetch_sitemap(candidate)
        if fetched is None:
            continue
        kind, entries = fetched
        if kind == "sitemapindex":
            for child, _lastmod in entries:
                leaves.append(urljoin(f"{base}/", child))
        else:
            leaves.append(candidate)

    ranked = sorted(set(leaves), key=_score_sitemap_child, reverse=True)

    # Verify the best leaves in order: a leaf is only "usable" if it actually
    # returns >= _MIN_SITEMAP_LOCS same-origin per-article <loc> entries.
    for url in ranked[:_MAX_SITEMAP_INDEX_FETCHES]:
        fetched = await _fetch_sitemap(url)
        if fetched is None:
            continue
        kind, entries = fetched
        if kind == "sitemapindex":
            continue  # defensive; already flattened above
        # Only URLs on the same site count — KU's sitemap.xml famously lists
        # other universities' subdomains rather than its own articles — and
        # they must be article pages, not landing-page dumps.
        same_origin = [loc for loc, _ in entries if _is_same_origin(loc, base)]
        if len(same_origin) >= _MIN_SITEMAP_LOCS and (
            _article_like_ratio(same_origin) >= _MIN_SITEMAP_ARTICLE_RATIO
        ):
            logger.info(
                "Sitemap detected for %s: %s (%d same-origin URLs)",
                base,
                url,
                len(same_origin),
            )
            return url

    logger.info("Sitemap detection for %s found no usable article sitemap", base)
    return None


async def check_sitemap(
    sitemap_url: str,
    known_urls: set[str] | list[str],
    since: str | None = None,
) -> tuple[list[str], int]:
    """Cheap fast-path poll: fetch the sitemap (flattening an index if the
    cached URL still points at one) and return only the <loc> entries not
    already in known_urls, plus the total number of <loc>s seen. One-to-a-few
    GETs, no rendering — safe to run every 1–3 minutes.

    `since` is the source's last successful run (ISO 8601); child sitemaps
    whose <lastmod> predates it are skipped without being fetched."""
    known = {u for u in (known_urls or []) if u}
    cutoff = _parse_lastmod(since)
    base = sitemap_url
    all_locs: list[str] = []
    seen_files: set[str] = set()
    queue: list[str] = [sitemap_url]
    fetches = 0
    unchanged = 0
    stale_skipped = 0

    while queue and fetches < _MAX_SITEMAP_INDEX_FETCHES:
        current = queue.pop(0)
        if current in seen_files:
            continue
        seen_files.add(current)

        # A 304 is only trustworthy for a leaf urlset. An index can answer 304
        # while a child's contents changed underneath it, so re-fetch indexes.
        use_conditional = _SITEMAP_KIND.get(current) == "urlset"
        try:
            fetched = await _fetch_sitemap(current, conditional=use_conditional)
        except _SitemapUnchanged:
            unchanged += 1
            continue
        if fetched is None:
            continue
        kind, entries = fetched
        fetches += 1

        if kind == "sitemapindex":
            for child, lastmod in entries:
                child_url = urljoin(current, child)
                # Skip whole child sitemaps untouched since our last run.
                child_mod = _parse_lastmod(lastmod)
                if cutoff and child_mod and child_mod < cutoff:
                    stale_skipped += 1
                    continue
                queue.append(child_url)
        else:
            for loc, lastmod in entries:
                absolute = urljoin(current, loc)
                # Same-origin guard mirrors detection: URLs on other hosts
                # (other ministries' subdomains) can never be this source's
                # items, so they shouldn't trigger wasted full crawls.
                if not _is_same_origin(absolute, base):
                    continue
                all_locs.append(absolute)

    # Preserve first-seen order while dropping duplicates.
    unique_locs = list(dict.fromkeys(all_locs))
    new_urls = [u for u in unique_locs if u not in known]
    if unchanged or stale_skipped:
        logger.info(
            "Sitemap check %s: %d file(s) unchanged (304), %d child sitemap(s) older than cutoff",
            sitemap_url,
            unchanged,
            stale_skipped,
        )
    return new_urls, len(unique_locs)


def _summarize_semaphore(summarize_concurrency: int | None) -> asyncio.Semaphore:
    """Build a per-run semaphore for concurrent LLM summarization.

    The concurrency cap comes from the API per-run (`summarize_concurrency`,
    driven by the admin `scraping.summarizeConcurrency` setting); a missing or
    non-positive value falls back to the env-driven default. A fresh semaphore
    per run means admin changes apply on the next run with no restart, and
    runs never share/leak a global cap across concurrent scrapes.
    """
    concurrency = summarize_concurrency or _SUMMARIZE_CONCURRENCY
    return asyncio.Semaphore(max(1, concurrency))


async def _summarize_with_semaphore(
    item: ScrapedItem,
    category_hint: str,
    report,
    semaphore: asyncio.Semaphore,
) -> bool:
    """Run summarization + classification for an item under a concurrency-limiting
    semaphore. Returns True if summarization succeeded, False otherwise.
    Always persists the final chosen category + confidence, plus LLM tags/facts."""
    if not item.content_text:
        return False
    async with semaphore:
        report(f"Summarizing: {item.title[:60]}")
        result = await _summarize_item(item.title, item.content_text, category_hint)
        if not result:
            return False

        # Always persist LLM summary/urgency
        item.ai_summary = result.get("summary")
        item.ai_summary_ne = result.get("summary_ne")
        item.ai_urgency = result.get("urgency", "LOW")

        # Always persist LLM classification artifacts
        llm_category = result.get("category")
        llm_confidence = float(result.get("category_confidence", 0.0))
        if llm_category:
            item.tags = result.get("tags") or []
            item.key_facts = result.get("key_facts") or []

        # --- Final category decision ---
        # item.category currently holds: listing category (if no slug override)
        # or slug-overridden category (confidence 0.8). We now have LLM's
        # independent classification. Decide:
        #   1. LLM high confidence (> 0.6) → trust LLM
        #   2. Slug override present (confidence 0.8) → trust slug
        #   3. Fallback → listing category with modest confidence
        slug_conf = item.ai_category_confidence if item.ai_category_confidence is not None else 0.0

        if llm_category and llm_confidence > 0.6:
            # LLM wins with high confidence
            item.category = llm_category
            item.ai_category_confidence = llm_confidence
        elif slug_conf >= 0.8:
            # Slug override is strong; keep it
            item.ai_category_confidence = slug_conf
        else:
            # Fallback: listing category with modest confidence
            item.ai_category_confidence = max(slug_conf, 0.4)

        return True


async def _summarize_then_stream(
    item: ScrapedItem,
    category_hint: str,
    report,
    semaphore: asyncio.Semaphore,
    on_item,
) -> bool:
    """Wraps _summarize_with_semaphore so the item is pushed to the caller
    (apps/api's streaming ingestion endpoint) the moment ITS OWN work is
    done — not after every other item in the run has also finished.

    This is the difference between a run that survives a 504 with partial
    progress and one that loses everything: previously all summarize tasks
    for a page (or a whole run) were awaited together via asyncio.gather, so
    even an item summarized in the first second of a 20-minute run sat in
    memory, unpersisted, until the very last one finished too."""
    try:
        return await _summarize_with_semaphore(item, category_hint, report, semaphore)
    finally:
        if on_item is not None:
            await on_item(item)


async def scrape_source(
    base_url: str,
    category_urls: dict[str, str],
    cached_schemas: dict[str, dict | None] | None = None,
    known_urls: set[str] | None = None,
    max_pages: int = DEFAULT_MAX_PAGES,
    fetch_detail: bool = True,
    summarize_concurrency: int | None = None,
    pagination: PaginationConfig | None = None,
    deep: bool = False,
    on_progress=None,
    on_item=None,
) -> tuple[list[ScrapedItem], dict[str, dict], list[dict], dict]:
    """Scrape an admin-configured source's notice/news listings with concurrent
    AI summarization. `summarize_concurrency` caps in-flight LLM calls (from
    the admin `scraping.summarizeConcurrency` setting); None → env default.
    Returns (items, schemas_used, failures, stats). `failures` is a structured
    list of every page/URL that failed (stage: schema_detection/listing/detail,
    with crawl4ai's own error message), even when the run otherwise succeeds
    with a partial item set, so the caller can show *why* and *where*.
    `stats` is what the run learned about the site — the pagination scheme it
    actually observed, pages walked, totals the pager reported — which is what
    lets the caller diagnose a bad configuration instead of just reporting it.

    `deep=True` is the "scrape every page" archive crawl: the listing's own
    pager decides how far to walk (up to config.SCRAPE_DEEP_MAX_PAGES), the
    source's `max_pages` is ignored, and the incremental early-stops are
    disabled — a page of already-known items is expected in the middle of an
    archive and must not end the walk.

    `on_item`, when given, is awaited with each new item (never a known-URL
    repeat) as soon as ITS OWN detail-fetch and summarization finish — not
    batched, not held for the end of the page or the run. The returned
    `items` list is still populated in full for backward compatibility (a
    caller with no `on_item` gets the exact behavior of before), but a
    caller that does supply one already has every item durably persisted by
    the time this function returns, whether it returns normally or the
    caller's own request times out first."""
    cached_schemas = cached_schemas or {}
    known_urls = known_urls or set()
    pagination = pagination or PaginationConfig()
    report = on_progress or (lambda _msg: None)
    items: list[ScrapedItem] = []
    schemas_used: dict[str, dict] = {}
    failures: list[dict] = []
    stats: dict = {"deep": deep, "categories": {}}
    seen_urls: set[str] = set()
    summarize_tasks: list[asyncio.Task] = []
    semaphore = _summarize_semaphore(summarize_concurrency)

    # Listing pages themselves are never items — a "Notices" link inside the
    # notices page is pagination/self-reference, not a notice.
    listing_urls = {u for u in category_urls.values() if u}

    async with browser_pool.crawler_session() as crawler:
        for category, listing_url in category_urls.items():
            if not listing_url:
                continue

            report(f"Resolving extraction pattern for {category.title()}…")
            schema, is_new = await _resolve_schema(
                crawler, listing_url, category, cached_schemas.get(category), failures
            )
            if not schema:
                report(f"Could not detect a listing pattern for {category.title()}; skipping")
                continue
            schemas_used[category] = schema
            report(
                f"{'Detected' if is_new else 'Reused cached'} extraction pattern for {category.title()}"
            )

            # Deep runs ignore the source's max_pages — the listing's own
            # pager, read from page 1 below, sets the real limit. Until then
            # the hard ceiling stands in for it.
            if pagination.pagination_type == "NONE":
                page_limit = 1
            elif deep:
                page_limit = config.SCRAPE_DEEP_MAX_PAGES
            else:
                page_limit = max_pages
            adds_new = _page_adds_any_new if deep else _page_adds_new
            # Resolved lazily from page 1's rows (see `_detect_pagination`);
            # `page_pagination` stays None until then.
            page_pagination: PaginationConfig | None = None
            previous_fingerprints: set[str] = set()
            # Page 2's rows, already fetched by pagination detection.
            prefetched_rows: list[dict] | None = None

            # What this category's crawl actually observed, for the caller's
            # diagnosis of a mis-configured source.
            category_stats: dict = {"listing_url": listing_url, "pages_crawled": 0}
            stats["categories"][category] = category_stats

            page_index = 0
            while page_index < page_limit:
                if page_index == 0:
                    url = listing_url
                elif page_pagination is None:
                    break  # single-page listing — nothing after page 1
                elif page_pagination.pagination_type == "PATH_TEMPLATE":
                    url = _path_template_url(listing_url, page_pagination.start_page + page_index)
                else:
                    url = _paginated_url(listing_url, page_index, page_pagination)
                if not url:
                    break

                page_html: str | None = None
                if prefetched_rows is not None:
                    rows, prefetched_rows = prefetched_rows, None
                    report(f"Crawling {category.title()} listing, page {page_index + 1}…")
                else:
                    report(
                        f"Crawling {category.title()} listing, page {page_index + 1}"
                        + (f" of {page_limit}" if deep and page_index else "")
                        + "…"
                    )
                    rows, page_html = await _extract_rows_and_html(crawler, url, schema, failures)
                if not rows:
                    break

                # Counted here, not at the bottom of the loop: every path out
                # of the body below is a `break`, and a page that was crawled
                # still counts even when its rows end the walk.
                category_stats["pages_crawled"] = page_index + 1
                fingerprints = _row_fingerprints(rows)
                if page_index == 0:
                    previous_fingerprints = fingerprints
                    # The page's own "1 2 3 ›" widget and "Showing 1 to 10 of
                    # 23 results" counter — the site's answer to both "how do
                    # I ask for page N" and "how many pages are there".
                    pager = _discover_pager(page_html, listing_url)
                    category_stats.update(
                        {
                            "reported_pages": pager.last_page,
                            "reported_results": pager.total_results,
                            "per_page": pager.per_page,
                        }
                    )
                    if deep and pager.last_page:
                        page_limit = min(config.SCRAPE_DEEP_MAX_PAGES, pager.last_page)
                        report(
                            f"{category.title()} listing reports {pager.last_page} page(s)"
                            + (f" / {pager.total_results} result(s)" if pager.total_results else "")
                            + (
                                f" — capped at {page_limit}"
                                if pager.last_page > page_limit
                                else ""
                            )
                        )
                    if page_limit > 1:
                        page_pagination, prefetched_rows = await _detect_pagination(
                            crawler, listing_url, schema, fingerprints, pagination,
                            discovered=pager.config, accept_any_new=deep,
                        )
                        prefetched_rows = prefetched_rows or None
                        if page_pagination is not None:
                            category_stats["detected_pagination"] = {
                                "type": page_pagination.pagination_type,
                                "param": page_pagination.param,
                                "start_page": page_pagination.start_page,
                            }
                        if page_pagination is None:
                            category_stats["single_page"] = True
                            report(f"{category.title()} listing is a single page")
                        elif (page_pagination.pagination_type, page_pagination.param) != (
                            pagination.pagination_type, pagination.param
                        ):
                            report(
                                f"Pagination for {category.title()} is "
                                f"{page_pagination.pagination_type}/{page_pagination.param}, "
                                f"not the configured {pagination.pagination_type}/{pagination.param}"
                            )
                else:
                    # A page that just repeats what we already have means the
                    # site ignored the page parameter (or we ran off the end).
                    # Continuing would re-walk page 1 up to `page_limit` times,
                    # burning detail crawls and LLM calls on known items.
                    if not adds_new(previous_fingerprints, fingerprints):
                        report(
                            f"{category.title()} page {page_index + 1} repeats the previous page; "
                            "stopping pagination"
                        )
                        break
                    previous_fingerprints |= fingerprints

                new_rows_on_page = 0
                unknown_rows_on_page = 0
                rejected_on_page = 0
                for row in rows:
                    source_url = _absolute_url(base_url, row.get("detail_href"))
                    if not source_url or source_url in seen_urls:
                        continue

                    # Admission control: only individual notices/news/press
                    # releases from this government site become items.
                    if not _is_probable_article_url(source_url, base_url, listing_urls):
                        rejected_on_page += 1
                        continue

                    seen_urls.add(source_url)
                    new_rows_on_page += 1
                    if source_url not in known_urls:
                        unknown_rows_on_page += 1

                    title = _clean_text(row.get("title"))
                    if not _looks_like_title(title):
                        # Listing markup often has the real title in a sibling
                        # attribute or only on the detail page.
                        title = (
                            _clean_text(row.get("title_attr"))
                            or _title_from_attachment(
                                _absolute_url(base_url, row.get("attachment_href"))
                            )
                            or title
                        )
                    published_at = _parse_published(row.get("published_raw"))
                    attachment_url = _absolute_url(base_url, row.get("attachment_href"))

                    # Slug-based category inference
                    slug_category, source_slug = _infer_category_from_slug(source_url)
                    resolved_category = category
                    category_confidence = None
                    if slug_category and slug_category != category:
                        resolved_category = slug_category
                        category_confidence = 0.8

                    content_text = None
                    content_html = None
                    detail_attachments = []
                    # Fetch the detail page when we need content OR still lack a
                    # usable title — the detail page's <h1> is the last and most
                    # reliable source of one.
                    if fetch_detail and (source_url not in known_urls or not _looks_like_title(title)):
                        report(f"Fetching detail: {(title or source_url)[:60]}")
                        detail = await _crawl_detail_generic(crawler, source_url, base_url, failures)
                        if detail:
                            content_text = detail.get("content_text")
                            content_html = detail.get("content_html")
                            if not published_at:
                                published_at = _parse_published(detail.get("published_raw"))
                            if not _looks_like_title(title) and _looks_like_title(detail.get("title")):
                                title = _clean_text(detail["title"])
                            if not attachment_url and detail.get("attachment_url"):
                                attachment_url = detail["attachment_url"]
                            detail_attachments = detail.get("attachments") or []

                    # Build attachment list
                    attachments: list[AttachmentInfo] = []
                    seen_att_urls: set[str] = set()
                    if attachment_url:
                        attachments.append(AttachmentInfo(url=attachment_url))
                        seen_att_urls.add(attachment_url)
                    for att in detail_attachments:
                        if att["url"] not in seen_att_urls:
                            attachments.append(AttachmentInfo(url=att["url"], label=att.get("label")))
                            seen_att_urls.add(att["url"])

                    # Last chance: a document filename beats no title at all.
                    # Many portals link the PDF directly from the listing, so
                    # the document may be the row's own URL.
                    if not _looks_like_title(title):
                        title = (
                            _title_from_attachment(attachment_url)
                            or _title_from_attachment(
                                source_url if source_url.lower().endswith(_FILE_EXTENSIONS) else None
                            )
                            or title
                        )

                    # Final gate. A row with no recoverable title is markup we
                    # misread, not a notice — storing it produced the pages of
                    # "(untitled) / Other / —" the admin table was full of.
                    if not _looks_like_title(title):
                        logger.debug("Skipping untitled row: %s", source_url)
                        _record_skip(failures, source_url, "listing", "no_title")
                        rejected_on_page += 1
                        new_rows_on_page -= 1
                        if source_url not in known_urls:
                            unknown_rows_on_page -= 1
                        continue

                    # Extract metadata
                    meta = _extract_metadata(title, content_text)

                    item = ScrapedItem(
                        category=resolved_category,
                        title=title,
                        source_url=source_url,
                        published_at=published_at,
                        summary=(content_text or title)[:500],
                        content_text=content_text,
                        content_html=content_html,
                        attachment_url=attachment_url,
                        source_slug=source_slug,
                        attachments=attachments if attachments else None,
                        ai_category_confidence=category_confidence,
                        metadata=meta,
                    )
                    items.append(item)

                    # A known URL was already persisted in an earlier run —
                    # streaming it again is a guaranteed no-op round trip to
                    # apps/api for every "already scraped" row on the page.
                    # Only genuinely new items are worth pushing.
                    is_new = source_url not in known_urls
                    if content_text and is_new:
                        # Fire concurrent summarization task (non-blocking);
                        # the item streams itself once summarization finishes.
                        task = asyncio.create_task(
                            _summarize_then_stream(item, category, report, semaphore, on_item)
                        )
                        summarize_tasks.append(task)
                    elif is_new and on_item is not None:
                        # No content to summarize (e.g. detail fetch failed) —
                        # nothing further will change on this item, so it can
                        # stream right away instead of waiting on the batch.
                        # Tracked in summarize_tasks (despite the name — it's
                        # really "background tasks to await before returning")
                        # so the function can't return before this push lands.
                        summarize_tasks.append(asyncio.create_task(on_item(item)))

                already_known_on_page = new_rows_on_page - unknown_rows_on_page
                report(
                    f"{category.title()} page {page_index + 1}: {new_rows_on_page} row(s) — "
                    f"{unknown_rows_on_page} new, {already_known_on_page} already scraped"
                    + (f", {rejected_on_page} rejected (not a notice)" if rejected_on_page else "")
                )

                if new_rows_on_page == 0:
                    break

                # An incremental run stops as soon as a page holds nothing it
                # hasn't already stored: newest-first listings mean everything
                # behind it is known too. A deep run is asked for the whole
                # archive, where already-known pages are exactly what sits
                # between page 1 and the unscraped tail.
                if not deep and known_urls and unknown_rows_on_page == 0:
                    report(
                        f"All {category.title()} items on page {page_index + 1} are already "
                        "scraped — stopping pagination early"
                    )
                    break

                page_index += 1

    # Wait for all pending summarization tasks to complete
    if summarize_tasks:
        report(f"Waiting for {len(summarize_tasks)} summarization task(s) to complete…")
        results = await asyncio.gather(*summarize_tasks, return_exceptions=True)
        succeeded = sum(1 for r in results if r is True)
        failed = len(results) - succeeded
        report(f"Summarization complete: {succeeded} succeeded, {failed} failed/skipped")

    report(
        f"{'Deep scrape' if deep else 'Scrape'} complete — {len(items)} item(s) total"
        + _issue_summary(failures)
    )
    logger.info(
        "Scrape produced %d item(s) for base_url=%s categories=%s (%d failure(s))",
        len(items),
        base_url,
        list(category_urls.keys()),
        len(failures),
    )
    stats["items"] = len(items)
    return items, schemas_used, failures, stats


async def check_listing(
    base_url: str,
    category_urls: dict[str, str],
    cached_schemas: dict[str, dict | None] | None = None,
    known_urls: set[str] | list[str] | None = None,
    pagination: PaginationConfig | None = None,
) -> tuple[list[str], int]:
    """Cheap "is there anything new?" probe for sources with no sitemap.

    Fetches only page 1 of each configured listing and extracts the detail
    URLs — no detail pages, no OCR, no LLM (scrape_source only does those
    when fetch_detail=True). That makes it comparable in cost to a sitemap
    check, so HTML-only sources can be polled on a short interval and pay
    for a full crawl only when genuinely new URLs appear.

    Returns (new_urls, total_seen).
    """
    known = set(known_urls or ())
    items, _, _, _ = await scrape_source(
        base_url=base_url,
        category_urls=category_urls,
        cached_schemas=cached_schemas,
        known_urls=known,
        max_pages=1,
        fetch_detail=False,
        pagination=pagination,
    )
    seen = [i.source_url for i in items if i.source_url]
    new_urls = [u for u in dict.fromkeys(seen) if u not in known]
    return new_urls, len(set(seen))


async def scrape_sitemap_urls(
    base_url: str,
    urls: list[str],
    known_urls: set[str] | None = None,
    summarize_concurrency: int | None = None,
    on_progress=None,
    on_item=None,
) -> tuple[list[ScrapedItem], dict[str, dict], list[dict]]:
    """Scrape an explicit list of article URLs directly — the sitemap
    fast-path's own full crawl. The sitemap already tells us exactly which
    detail pages exist, so there is no listing page to parse and no
    CSS-extraction schema needed: each URL is fetched through the same
    generic detail-page pipeline (`_crawl_detail_generic`) used by the
    listing crawl, then summarized concurrently.

    This is the fallback that keeps data flowing for sites whose category
    listing URLs 404 or are otherwise unusable (mohp.gov.np serves only an
    SVG error page at /category/* — not anti-bot, just 404), yet expose a
    healthy articles sitemap. Returns (items, schemas_used, failures) with an
    empty schemas dict for API compatibility.

    `on_item`, when given, is awaited with each item as soon as it is fully
    resolved (see scrape_source's docstring — same streaming contract).
    Every item built here is already new by construction (known URLs are
    filtered out above), so unlike scrape_source there is no further check.
    """
    known_urls = known_urls or set()
    report = on_progress or (lambda _msg: None)
    items: list[ScrapedItem] = []
    failures: list[dict] = []
    summarize_tasks: list[asyncio.Task] = []
    seen_urls: set[str] = set()
    rejected = 0
    semaphore = _summarize_semaphore(summarize_concurrency)

    # Sitemap URLs often share a "section" path segment (e.g. /content/, or a
    # category slug like /notice/) that our slug map keys off — infer it once
    # from the first URL so a per-item fallback is rarely needed.
    default_category, default_slug = _infer_category_from_slug(_sitemap_section(urls))

    async with browser_pool.crawler_session() as crawler:
        for index, source_url in enumerate(urls):
            if not source_url or source_url in seen_urls:
                continue
            if source_url in known_urls:
                report(f"Skipping already-scraped: {source_url[:80]}")
                _record_skip(failures, source_url, "sitemap", "already_scraped")
                continue
            # Same admission control as the listing crawl: a sitemap lists
            # every page a site has, including contact and category pages.
            if not _is_probable_article_url(source_url, base_url, set()):
                rejected += 1
                _record_skip(failures, source_url, "sitemap", "not_article_url")
                continue
            seen_urls.add(source_url)

            title = None
            published_at = None
            attachment_url = None
            content_text = None
            content_html = None
            attachments: list[AttachmentInfo] = []
            meta = None

            report(f"Fetching detail ({index + 1}/{len(urls)}): {source_url[:90]}")
            detail = await _crawl_detail_generic(crawler, source_url, base_url, failures)
            if detail:
                if _looks_like_title(detail.get("title")):
                    title = _clean_text(detail["title"])
                published_at = _parse_published(detail.get("published_raw"))
                content_text = detail.get("content_text")
                content_html = detail.get("content_html")
                attachment_url = detail.get("attachment_url")
                seen_att_urls: set[str] = set()
                if attachment_url:
                    attachments.append(AttachmentInfo(url=attachment_url))
                    seen_att_urls.add(attachment_url)
                for att in detail.get("attachments") or []:
                    if att["url"] not in seen_att_urls:
                        attachments.append(AttachmentInfo(url=att["url"], label=att.get("label")))
                        seen_att_urls.add(att["url"])
                meta = _extract_metadata(title or "", content_text)
                if meta:
                    meta["sitemapUrl"] = source_url

            if not _looks_like_title(title):
                title = _title_from_attachment(attachment_url)
            if not _looks_like_title(title):
                logger.debug("Skipping untitled sitemap URL: %s", source_url)
                rejected += 1
                _record_skip(failures, source_url, "sitemap", "no_title")
                continue

            slug_category, source_slug = _infer_category_from_slug(source_url)
            resolved_category = slug_category or default_category or "OTHER"
            source_slug = source_slug or default_slug

            item = ScrapedItem(
                category=resolved_category,
                title=title,
                source_url=source_url,
                published_at=published_at,
                summary=(content_text or title)[:500],
                content_text=content_text,
                content_html=content_html,
                attachment_url=attachment_url,
                source_slug=source_slug,
                attachments=attachments if attachments else None,
                ai_category_confidence=0.8 if slug_category else None,
                metadata=meta,
            )
            items.append(item)

            if content_text:
                task = asyncio.create_task(
                    _summarize_then_stream(item, resolved_category, report, semaphore, on_item)
                )
                summarize_tasks.append(task)
            elif on_item is not None:
                summarize_tasks.append(asyncio.create_task(on_item(item)))

    if summarize_tasks:
        report(f"Waiting for {len(summarize_tasks)} summarization task(s) to complete…")
        results = await asyncio.gather(*summarize_tasks, return_exceptions=True)
        succeeded = sum(1 for r in results if r is True)
        failed = len(results) - succeeded
        report(f"Summarization complete: {succeeded} succeeded, {failed} failed/skipped")

    report(
        f"Sitemap scrape complete — {len(items)} item(s) total"
        + (f", {rejected} URL(s) rejected (not a notice)" if rejected else "")
        + _issue_summary(failures)
    )
    logger.info(
        "Sitemap scrape produced %d item(s) from %d URL(s) for base_url=%s (%d failure(s))",
        len(items),
        len(urls),
        base_url,
        len(failures),
    )
    return items, {}, failures
