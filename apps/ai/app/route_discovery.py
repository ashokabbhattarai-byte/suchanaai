"""Find a site's real notice / news / press-release listing routes.

Adding a source used to require an admin to browse the site themselves and
paste the right listing URL, and a wrong guess failed as "could not detect a
listing pattern" — indistinguishable from a site the scraper cannot read.
These portals disagree on everything: `/notices`, `/notice-board`,
`/category/suchana`, `/page/act-regulation`, `/np/सूचना`, a "सूचना तथा
जानकारी" dropdown with no URL hint at all.

So the route is *found*, not guessed:

  1. Harvest every same-origin link on the home page, keeping its anchor
     text and whether it sits in the site's navigation.
  2. Score each candidate against a bilingual keyword table (English,
     romanised Nepali, Devanagari), applied to the URL path *and* the link
     text — the text is what carries the signal when the URL is opaque.
  3. Probe a short list of conventional paths the site never linked.
  4. Verify by crawling: a route is only real if the extractor finds
     repeating rows that link to individual articles. That is ground truth,
     and it is what separates `/notices` from `/notices/archive-2019`.
  5. Expand one level into the best unverified candidate — many portals put
     a landing page in the menu and the actual list one click below it.
"""

from dataclasses import dataclass, field
from urllib.parse import urlparse

from bs4 import BeautifulSoup

from app import browser_pool, scraper
from app.logger import get_logger

logger = get_logger(__name__)


# Keyword → category. Matched against URL path segments and link text, in
# English, romanised Nepali and Devanagari, because all three appear — often
# on the same page. Longer keys are checked first so "press-release" wins
# over "release" and "प्रेस विज्ञप्ति" over "विज्ञप्ति".
_ROUTE_KEYWORDS: dict[str, str] = {
    # --- notices ---
    "notice-board": "NOTICE",
    "noticeboard": "NOTICE",
    "public-notice": "NOTICE",
    "notices": "NOTICE",
    "notice": "NOTICE",
    "suchana": "NOTICE",
    "soochana": "NOTICE",
    "announcement": "NOTICE",
    "announcements": "NOTICE",
    "सार्वजनिक सूचना": "NOTICE",
    "सूचना पाटी": "NOTICE",
    "सूचना तथा जानकारी": "NOTICE",
    "सूचना": "NOTICE",
    "सुचना": "NOTICE",
    "जानकारी": "NOTICE",
    "अत्यावश्यक": "NOTICE",
    # --- news ---
    "news-and-events": "NEWS",
    "latest-news": "NEWS",
    "news": "NEWS",
    "samachar": "NEWS",
    "bulletin": "NEWS",
    "ताजा समाचार": "NEWS",
    "समाचार": "NEWS",
    "बुलेटिन": "NEWS",
    "गतिविधि": "NEWS",
    # --- press releases ---
    "press-release": "PRESS_RELEASE",
    "press_release": "PRESS_RELEASE",
    "pressrelease": "PRESS_RELEASE",
    "press-releases": "PRESS_RELEASE",
    "press-note": "PRESS_RELEASE",
    "media-release": "PRESS_RELEASE",
    "press": "PRESS_RELEASE",
    "प्रेस विज्ञप्ति": "PRESS_RELEASE",
    "पत्रकार सम्मेलन": "PRESS_RELEASE",
    "विज्ञप्ति": "PRESS_RELEASE",
    "प्रेस": "PRESS_RELEASE",
}

# Checked longest-first so specific phrases beat their own substrings.
_KEYWORDS_BY_LENGTH = sorted(_ROUTE_KEYWORDS, key=len, reverse=True)

# Pages that are never a notice listing, however they are worded. Without
# these, "Contact us for notices" and `/gallery/news-photos` both score.
_NEGATIVE_HINTS = (
    "login", "signin", "sign-in", "signup", "register", "logout", "password",
    "contact", "about", "about-us", "privacy", "terms", "disclaimer",
    "gallery", "photo", "video", "album", "faq", "help", "search",
    "sitemap", "feed", "rss", "cart", "account", "profile", "webmail",
    "organogram", "staff", "employee", "team", "member", "citizen-charter",
    "tender", "bolpatra", "e-bidding", "vacancy", "karmachari",
    "facebook", "twitter", "youtube", "map",
)

# Conventional paths to try when the home page linked nothing convincing.
# Deliberately short: each one costs a browser page load to verify.
_COMMON_PATHS: list[tuple[str, str]] = [
    ("/notices", "NOTICE"),
    ("/notice", "NOTICE"),
    ("/notice-board", "NOTICE"),
    ("/category/notice", "NOTICE"),
    ("/category/suchana", "NOTICE"),
    ("/public-notice", "NOTICE"),
    ("/news", "NEWS"),
    ("/category/news", "NEWS"),
    ("/news-and-events", "NEWS"),
    ("/press-release", "PRESS_RELEASE"),
    ("/category/press-release", "PRESS_RELEASE"),
]

# A verified route needs at least this many rows that link to real articles.
# Two is a coincidence (a "latest notice" teaser box); three is a list.
_MIN_VERIFIED_ROWS = 3

# Bounds on how much crawling one discovery run may do.
_MAX_VERIFY = 10
_MAX_CHILD_EXPANSION = 2


@dataclass
class DiscoveredRoute:
    url: str
    category: str
    label: str | None = None
    score: float = 0.0
    verified: bool = False
    row_count: int = 0
    sample_titles: list[str] = field(default_factory=list)
    evidence: list[str] = field(default_factory=list)

    def as_dict(self) -> dict:
        return {
            "url": self.url,
            "category": self.category,
            "label": self.label,
            "score": round(self.score, 1),
            "verified": self.verified,
            "row_count": self.row_count,
            "sample_titles": self.sample_titles[:3],
            "evidence": self.evidence,
        }


def _normalize(url: str) -> str:
    """Compare URLs without trailing-slash / fragment noise."""
    cleaned = url.split("#")[0]
    return cleaned.rstrip("/") or cleaned


def _match_keyword(text: str) -> tuple[str, str] | None:
    """`(keyword, category)` for the most specific keyword in `text`."""
    lowered = text.lower()
    for keyword in _KEYWORDS_BY_LENGTH:
        if keyword in lowered:
            return keyword, _ROUTE_KEYWORDS[keyword]
    return None


def _looks_like_detail_url(segments: list[str]) -> bool:
    """True when the path addresses one article rather than a section.

    Both score the same on keywords alone — `/page/notice` and
    `/post/notice-inviting-bids-for-the-purchase-of-stationery` each contain
    "notice" — but only the first is a route. A section slug is short and
    generic; an article slug is the headline, and many portals additionally
    put a numeric id in the path (`/content/446/...`).
    """
    if not segments:
        return False
    if any(seg.isdigit() for seg in segments):
        return True
    tokens = segments[-1].replace("_", "-").split("-")
    # A trailing number is a post id, not a section: `/post/press-release-2126`
    # is one release, `/category/press-release` is all of them.
    if len(tokens) > 1 and tokens[-1].isdigit():
        return True
    return len(tokens) > 3


def _score_candidate(url: str, link_text: str, in_nav: bool) -> tuple[str, float, list[str]] | None:
    """`(category, score, evidence)` for one harvested link, or None."""
    try:
        parsed = urlparse(url)
    except Exception:
        return None
    path = (parsed.path or "").lower()
    haystack = f"{path} {parsed.query.lower()}"

    if any(hint in haystack for hint in _NEGATIVE_HINTS):
        return None

    evidence: list[str] = []
    score = 0.0
    category: str | None = None

    # The URL is the stronger signal when it carries a word at all: a whole
    # path segment matching a keyword is a route, not a mention.
    segments = [s for s in path.strip("/").split("/") if s]
    path_hit = _match_keyword(haystack)
    if path_hit:
        keyword, category = path_hit
        exact_segment = any(seg.replace("_", "-") == keyword for seg in segments)
        score += 6.0 if exact_segment else 4.0
        evidence.append(f"URL contains “{keyword}”")

    # ...but a Nepali menu label over an opaque URL (`/page/12`) is the only
    # signal those sites give, so link text counts nearly as much.
    text_hit = _match_keyword(link_text or "")
    if text_hit:
        keyword, text_category = text_hit
        if any(hint in (link_text or "").lower() for hint in _NEGATIVE_HINTS):
            return None
        category = category or text_category
        score += 5.0 if (link_text or "").strip().lower() == keyword else 3.0
        evidence.append(f"Link text “{(link_text or '').strip()[:40]}”")
        # URL and label agreeing on the same category is a strong signal.
        if path_hit and text_category == path_hit[1]:
            score += 2.0
            evidence.append("URL and link text agree")

    if category is None:
        return None

    if in_nav:
        score += 2.0
        evidence.append("In site navigation")

    # A keyword sitting at the end of the path names the section; buried
    # deeper it is usually incidental.
    if segments and any(
        segments[-1].replace("_", "-") == kw or kw in segments[-1].replace("_", "-")
        for kw in _KEYWORDS_BY_LENGTH
    ):
        score += 1.5

    # Individual notices link to themselves from every homepage teaser, so
    # without this they crowd out the actual routes and eat the verification
    # budget — which is the expensive part.
    if _looks_like_detail_url(segments):
        score -= 8.0
        evidence.append("Looks like a single article, not a section")

    # A shallow route is the section itself; a deep one is usually an archive
    # slice or a single item inside it.
    score -= max(0, len(segments) - 2) * 0.75
    return category, score, evidence


def _harvest_links(html: str, base_url: str) -> list[tuple[str, str, bool]]:
    """`(absolute_url, link_text, in_nav)` for same-origin links on a page."""
    try:
        soup = BeautifulSoup(html, "html.parser")
    except Exception:
        return []

    nav_links: set[int] = set()
    for nav in soup.find_all(["nav", "header"]) + soup.find_all(
        attrs={"class": lambda c: bool(c) and any(
            hint in " ".join(c if isinstance(c, list) else [c]).lower()
            for hint in ("nav", "menu", "topbar", "main-menu")
        )}
    ):
        for anchor in nav.find_all("a", href=True):
            nav_links.add(id(anchor))

    out: list[tuple[str, str, bool]] = []
    seen: set[str] = set()
    for anchor in soup.find_all("a", href=True):
        href = (anchor.get("href") or "").strip()
        if not href or href.startswith(("#", "javascript:", "mailto:", "tel:")):
            continue
        absolute = scraper._absolute_url(base_url, href)
        if not absolute or not scraper._is_same_origin(absolute, base_url):
            continue
        if absolute.lower().endswith(scraper._FILE_EXTENSIONS):
            continue
        key = _normalize(absolute)
        if key in seen or key == _normalize(base_url):
            continue
        seen.add(key)
        text = " ".join(anchor.get_text(" ", strip=True).split())[:120]
        out.append((absolute, text, id(anchor) in nav_links))
    return out


async def _verify_route(crawler, url: str, base_url: str) -> tuple[int, list[str]]:
    """Crawl one candidate: how many rows link to individual articles.

    This is the only claim that matters — keywords say a page *should* be a
    listing, this says it *is* one. Returns (row_count, sample_titles).
    """
    schema, _ = await scraper._resolve_schema(crawler, url, "NOTICE", None, None)
    if not schema:
        return 0, []
    rows = await scraper._extract_with_schema(crawler, url, schema, None)

    listing_urls = {url}
    titles: list[str] = []
    article_rows = 0
    for row in rows:
        detail = scraper._absolute_url(base_url, row.get("detail_href"))
        if not detail or not scraper._is_probable_article_url(detail, base_url, listing_urls):
            continue
        article_rows += 1
        title = scraper._clean_text(row.get("title")) or scraper._clean_text(row.get("title_attr"))
        if scraper._looks_like_title(title):
            titles.append(title)
    return article_rows, titles


async def discover_routes(
    base_url: str,
    max_verify: int = _MAX_VERIFY,
    on_progress=None,
) -> dict:
    """Find this site's listing routes, best-first, per category.

    Returns {base_url, routes: [...], best: {CATEGORY: url}, checked, notes}.
    `best` is directly usable as a source's noticeListUrl/newsListUrl/
    pressReleaseListUrl.
    """
    report = on_progress or (lambda _msg: None)
    notes: list[str] = []
    candidates: dict[str, DiscoveredRoute] = {}

    def offer(url: str, category: str, score: float, label: str | None, evidence: list[str]):
        key = _normalize(url)
        existing = candidates.get(key)
        if existing is None or score > existing.score:
            candidates[key] = DiscoveredRoute(
                url=url, category=category, label=label, score=score, evidence=evidence
            )

    async with browser_pool.crawler_session() as crawler:
        report("Reading the home page…")
        html = await scraper._fetch_raw_html(crawler, base_url, None)
        if not html:
            notes.append(
                "The home page could not be loaded, so only conventional paths were tried."
            )
        else:
            links = _harvest_links(html, base_url)
            report(f"Found {len(links)} internal link(s); scoring them…")
            for url, text, in_nav in links:
                scored = _score_candidate(url, text, in_nav)
                if scored:
                    category, score, evidence = scored
                    offer(url, category, score, text or None, evidence)

        # Conventional paths, only where nothing better was already found for
        # that category — these each cost a page load to check.
        for path, category in _COMMON_PATHS:
            best_for_category = max(
                (c.score for c in candidates.values() if c.category == category), default=0.0
            )
            if best_for_category >= 6.0:
                continue
            guess = base_url.rstrip("/") + path
            if _normalize(guess) not in candidates:
                offer(guess, category, 2.0, None, ["Conventional path for this kind of site"])

        ranked = sorted(candidates.values(), key=lambda c: -c.score)
        report(f"Verifying the {min(len(ranked), max_verify)} most likely route(s)…")

        checked = 0
        for route in ranked[:max_verify]:
            report(f"Checking {route.url}")
            rows, titles = await _verify_route(crawler, route.url, base_url)
            checked += 1
            route.row_count = rows
            route.sample_titles = titles
            if rows >= _MIN_VERIFIED_ROWS:
                route.verified = True
                route.score += min(rows, 15)
                route.evidence.append(f"Lists {rows} individual article link(s)")
            elif rows:
                route.evidence.append(f"Only {rows} article link(s) — probably a teaser box")

        # Menu landing pages: high keyword score, no rows of their own, but
        # the real list one click below. Worth one level for the best few.
        unverified = [r for r in ranked[:max_verify] if not r.verified and r.score >= 5.0]
        for parent in unverified[:_MAX_CHILD_EXPANSION]:
            report(f"Looking one level below {parent.url}")
            child_html = await scraper._fetch_raw_html(crawler, parent.url, None)
            if not child_html:
                continue
            children = []
            for url, text, _ in _harvest_links(child_html, parent.url):
                if _normalize(url) in candidates:
                    continue
                scored = _score_candidate(url, text, False)
                if scored and scored[0] == parent.category:
                    children.append((url, text, scored[1]))
            children.sort(key=lambda c: -c[2])
            for url, text, score in children[:2]:
                rows, titles = await _verify_route(crawler, url, base_url)
                checked += 1
                if rows >= _MIN_VERIFIED_ROWS:
                    child = DiscoveredRoute(
                        url=url,
                        category=parent.category,
                        label=text or None,
                        score=score + min(rows, 15),
                        verified=True,
                        row_count=rows,
                        sample_titles=titles,
                        evidence=[
                            f"Linked from {parent.url}",
                            f"Lists {rows} individual article link(s)",
                        ],
                    )
                    candidates[_normalize(url)] = child
                    break

    final = sorted(candidates.values(), key=lambda c: (not c.verified, -c.score))
    # Only report routes that either proved themselves or scored well enough
    # to be worth an admin's attention — the rest is noise.
    reportable = [r for r in final if r.verified or r.score >= 5.0]

    best: dict[str, str] = {}
    for route in reportable:
        if route.verified and route.category not in best:
            best[route.category] = route.url

    if not best:
        notes.append(
            "No page on this site listed individual notices. It may render its "
            "list with JavaScript after load, sit behind a different domain, or "
            "publish only through a sitemap — try sitemap detection."
        )

    report(
        f"Discovery complete — {len(best)} confirmed route(s) "
        f"from {checked} page(s) checked"
    )
    logger.info(
        "Route discovery for %s: confirmed=%s checked=%d candidates=%d",
        base_url, list(best), checked, len(candidates),
    )
    return {
        "base_url": base_url,
        "routes": [r.as_dict() for r in reportable[:12]],
        "best": best,
        "checked": checked,
        "notes": notes,
    }
