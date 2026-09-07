"""Turn a failed or empty scrape run into something an admin can act on.

A run used to report `{stage: "schema_detection", error: "Could not detect a
working listing pattern"}` and stop there. That names the symptom and hides
every useful distinction behind it: a mistyped URL, a site that moved its
notices page, a Cloudflare challenge, a list rendered by JavaScript and a
genuinely unreadable layout all arrive as the same sentence, and the admin
has no way to tell which — or what to change.

This module reads the run's structured failures together with the source's
configuration and produces ranked diagnoses. Each one says what happened,
why, and what to change — and where the fix is a settings change, it carries
the exact patch so the UI can offer to apply it.
"""

import re
from dataclasses import dataclass, field
from urllib.parse import urlparse

from app.logger import get_logger

logger = get_logger(__name__)


@dataclass
class Diagnosis:
    code: str
    severity: str  # "error" | "warning" | "info"
    title: str
    detail: str
    fix: str
    # Partial ScrapeSource update the admin can apply in one click. Empty when
    # the fix is not a settings change (site down, JS-rendered list, ...).
    patch: dict = field(default_factory=dict)
    # Named remedies the UI can offer as buttons.
    actions: list[str] = field(default_factory=list)
    urls: list[str] = field(default_factory=list)

    def as_dict(self) -> dict:
        return {
            "code": self.code,
            "severity": self.severity,
            "title": self.title,
            "detail": self.detail,
            "fix": self.fix,
            "patch": self.patch,
            "actions": self.actions,
            "urls": self.urls[:5],
        }


# Which source field holds the listing URL for each category — the patch a
# "your notices URL moved" diagnosis has to write.
_CATEGORY_FIELD = {
    "NOTICE": "noticeListUrl",
    "NEWS": "newsListUrl",
    "PRESS_RELEASE": "pressReleaseListUrl",
}

_HTTP_STATUS_RE = re.compile(r"HTTP (\d{3})")

_BLOCKED_MARKERS = (
    "403", "forbidden", "access denied", "cloudflare", "captcha",
    "just a moment", "attention required", "bot detect", "rate limit", "429",
)
_DNS_MARKERS = ("err_name_not_resolved", "nxdomain", "getaddrinfo", "dns")
_TLS_MARKERS = (
    "err_cert", "ssl", "certificate", "handshake", "err_ssl_protocol_error",
)
_UNREACHABLE_MARKERS = (
    "err_connection_refused", "err_connection_timed_out", "err_address_unreachable",
    "err_connection_reset", "err_empty_response", "timed out", "timeout",
    "502", "503", "504",
)


def _failed(issues: list[dict]) -> list[dict]:
    return [i for i in issues if (i.get("outcome") or "failed") == "failed"]


def _skipped(issues: list[dict], reason: str) -> list[dict]:
    return [i for i in issues if i.get("outcome") == "skipped" and i.get("reason") == reason]


def _by_stage(issues: list[dict], *stages: str) -> list[dict]:
    return [i for i in issues if i.get("stage") in stages]


def _any_marker(issues: list[dict], markers: tuple[str, ...]) -> list[dict]:
    hits = []
    for issue in issues:
        text = (issue.get("error") or "").lower()
        if any(marker in text for marker in markers):
            hits.append(issue)
    return hits


def _category_for_url(url: str, category_urls: dict) -> str | None:
    target = (url or "").rstrip("/")
    for category, listing_url in (category_urls or {}).items():
        if listing_url and listing_url.rstrip("/") == target:
            return category
    return None


def diagnose(
    failures: list[dict] | None = None,
    *,
    category_urls: dict | None = None,
    base_url: str = "",
    items_found: int = 0,
    items_new: int = 0,
    has_sitemap: bool = False,
    pagination: dict | None = None,
    detected_pagination: dict | None = None,
    discovered_routes: dict | None = None,
) -> list[dict]:
    """Rank what went wrong and what to change about it.

    `discovered_routes` is the output of route_discovery.discover_routes when
    the caller ran it — a dead listing URL is only actionable if we can say
    which URL replaced it.
    """
    issues = failures or []
    category_urls = category_urls or {}
    found = _failed(issues)
    out: list[Diagnosis] = []

    best_routes = (discovered_routes or {}).get("best") or {}
    route_notes = (discovered_routes or {}).get("notes") or []

    # --- 1. Listing URL is dead ---------------------------------------------
    dead: dict[str, list[str]] = {}
    for issue in _by_stage(found, "listing_url", "raw_fetch", "listing"):
        match = _HTTP_STATUS_RE.search(issue.get("error") or "")
        if match and match.group(1) in ("404", "410", "400", "401"):
            dead.setdefault(match.group(1), []).append(issue.get("url", ""))
    if dead:
        urls = [u for group in dead.values() for u in group if u]
        statuses = ", ".join(sorted(dead))
        replacements = {}
        for url in urls:
            category = _category_for_url(url, category_urls)
            if category and best_routes.get(category):
                replacements[_CATEGORY_FIELD[category]] = best_routes[category]
        if replacements:
            fix = (
                "The site moved this section. A working replacement was found: "
                + ", ".join(replacements.values())
                + ". Apply it to update this source."
            )
        else:
            fix = (
                "Open the URL in a browser. If the section moved, update the "
                "listing URL on this source — or run URL auto-detection to "
                "find where it went."
            )
        out.append(
            Diagnosis(
                code="listing_url_dead",
                severity="error",
                title=f"Listing URL returns HTTP {statuses}",
                detail=(
                    "The configured listing page no longer exists, so there was "
                    "nothing to crawl. This is a wrong or outdated URL, not a "
                    "scraper problem."
                ),
                fix=fix,
                patch=replacements,
                actions=["discover_routes"] if not replacements else ["apply_patch"],
                urls=urls,
            )
        )

    # --- 2. Blocked by the site ---------------------------------------------
    blocked = _any_marker(found, _BLOCKED_MARKERS)
    if blocked:
        out.append(
            Diagnosis(
                code="blocked",
                severity="error",
                title="The site is blocking automated requests",
                detail=(
                    "Responses look like a bot check or rate limit (403 / "
                    "Cloudflare / captcha) rather than a missing page. The URL "
                    "is probably fine — the requests are being refused."
                ),
                fix=(
                    "Increase this source's poll interval so it is crawled less "
                    "often, and re-run later. If it persists, the site needs an "
                    "allowlist entry for the server's IP."
                ),
                patch={"pollIntervalSeconds": 3600},
                actions=["apply_patch"],
                urls=[i.get("url", "") for i in blocked],
            )
        )

    # --- 3. Network-level problems ------------------------------------------
    dns = _any_marker(found, _DNS_MARKERS)
    if dns:
        host = urlparse(base_url).netloc or base_url
        out.append(
            Diagnosis(
                code="dns_failure",
                severity="error",
                title="The domain could not be resolved",
                detail=f"DNS lookups for {host} failed, so no page was ever reached.",
                fix=(
                    "Check the base URL for a typo, and whether the domain is "
                    "still live. Government portals occasionally move between "
                    "domains (…gov.np → …p.gov.np)."
                ),
                actions=["edit_source"],
                urls=[i.get("url", "") for i in dns],
            )
        )
    tls = _any_marker(found, _TLS_MARKERS)
    if tls:
        out.append(
            Diagnosis(
                code="tls_failure",
                severity="error",
                title="The site's HTTPS certificate was rejected",
                detail=(
                    "The TLS handshake failed — an expired or misconfigured "
                    "certificate on the site's side, which is common on "
                    "smaller government portals."
                ),
                fix=(
                    "Verify the site loads in a browser without a certificate "
                    "warning. If it only serves plain HTTP, change the base and "
                    "listing URLs to http://."
                ),
                actions=["edit_source"],
                urls=[i.get("url", "") for i in tls],
            )
        )
    unreachable = _any_marker(found, _UNREACHABLE_MARKERS)
    if unreachable and not (dns or tls or blocked):
        out.append(
            Diagnosis(
                code="site_unreachable",
                severity="warning",
                title="The site was unreachable or too slow",
                detail=(
                    f"{len(unreachable)} request(s) timed out or were refused "
                    "after retries. This is usually the site being down or "
                    "overloaded, not a configuration problem."
                ),
                fix="Re-run later. If it keeps happening, raise the poll interval.",
                actions=["retry"],
                urls=[i.get("url", "") for i in unreachable],
            )
        )

    # --- 4. Page loads, but no list can be read -----------------------------
    schema_failures = _by_stage(found, "schema_detection")
    if schema_failures and not dead:
        alternatives = [
            url for category, url in best_routes.items()
            if url and url.rstrip("/") != (category_urls.get(category) or "").rstrip("/")
        ]
        if alternatives:
            fix = (
                "A different page on this site does list notices: "
                + ", ".join(alternatives)
                + ". Switch the listing URL to it."
            )
            patch = {
                _CATEGORY_FIELD[c]: u for c, u in best_routes.items() if c in _CATEGORY_FIELD
            }
        else:
            fix = (
                "Check that the URL is the list itself and not a landing page. "
                "If the list only appears after the page loads (a JavaScript "
                "table or an embedded viewer), use this site's sitemap instead."
            )
            patch = {}
        out.append(
            Diagnosis(
                code="no_listing_pattern",
                severity="error",
                title="The page loaded but no repeating list of notices was found",
                detail=(
                    "The extractor could not find rows that repeat — the page "
                    "is a landing page, an embedded document viewer, or it "
                    "builds its list in the browser after loading."
                ),
                fix=fix,
                patch=patch,
                actions=["discover_routes"] + (["detect_sitemap"] if not has_sitemap else []),
                urls=[i.get("url", "") for i in schema_failures],
            )
        )

    # --- 5. Rows found, but none of them are notices ------------------------
    not_article = _skipped(issues, "not_article_url")
    if items_found == 0 and len(not_article) >= 3 and not schema_failures:
        out.append(
            Diagnosis(
                code="rows_rejected",
                severity="warning",
                title=f"{len(not_article)} row(s) found, but none looked like notices",
                detail=(
                    "The list was read successfully; every link in it was then "
                    "rejected as not being an individual notice — they point "
                    "off-site, at category pages, or at the listing itself."
                ),
                fix=(
                    "Check the base URL matches the domain the notices live on. "
                    "A source whose base URL and listing URL are on different "
                    "hosts rejects every row it finds."
                ),
                actions=["edit_source"],
                urls=[i.get("url", "") for i in not_article[:5]],
            )
        )

    untitled = _skipped(issues, "no_title")
    if len(untitled) >= 3 and items_found == 0:
        out.append(
            Diagnosis(
                code="rows_untitled",
                severity="warning",
                title=f"{len(untitled)} row(s) had no readable title",
                detail=(
                    "Rows were found but none carried a usable title, so they "
                    "were discarded rather than stored as “(untitled)”. The "
                    "detected pattern is probably matching the wrong element."
                ),
                fix=(
                    "Re-running clears the cached extraction pattern and "
                    "re-detects it. If it repeats, point the source at a "
                    "cleaner list page for the same section."
                ),
                actions=["retry", "discover_routes"],
                urls=[i.get("url", "") for i in untitled[:5]],
            )
        )

    # --- 6. Detail pages failing en masse -----------------------------------
    detail_failures = _by_stage(found, "detail")
    if detail_failures and items_found and len(detail_failures) >= max(3, items_found // 2):
        out.append(
            Diagnosis(
                code="detail_pages_failing",
                severity="warning",
                title=f"{len(detail_failures)} notice page(s) could not be opened",
                detail=(
                    "The list was read fine, but the individual notice pages "
                    "behind it failed. Those notices are stored with a title "
                    "and link only — no body text, so they cannot be searched "
                    "or summarised."
                ),
                fix=(
                    "Usually the site rate-limiting a burst of requests. "
                    "Re-run to pick them up; if it persists, raise the poll "
                    "interval so runs are smaller and further apart."
                ),
                actions=["retry"],
                urls=[i.get("url", "") for i in detail_failures[:5]],
            )
        )

    # --- 7. Pagination configured wrongly -----------------------------------
    if detected_pagination and pagination:
        same = (
            detected_pagination.get("type") == pagination.get("type")
            and detected_pagination.get("param") == pagination.get("param")
        )
        if not same and detected_pagination.get("type"):
            out.append(
                Diagnosis(
                    code="pagination_mismatch",
                    severity="info",
                    title="This source's pagination setting does not match the site",
                    detail=(
                        f"Configured as {pagination.get('type')}/"
                        f"{pagination.get('param')}, but the site paginates with "
                        f"{detected_pagination.get('type')}/{detected_pagination.get('param')}. "
                        "Every run currently has to re-discover this."
                    ),
                    fix="Save the detected scheme so future runs skip the probe.",
                    patch={
                        "paginationType": detected_pagination.get("type"),
                        "paginationParam": detected_pagination.get("param"),
                        **(
                            {"startPage": detected_pagination["start_page"]}
                            if detected_pagination.get("start_page") is not None
                            else {}
                        ),
                    },
                    actions=["apply_patch"],
                )
            )

    # --- 8. Nothing wrong, nothing new --------------------------------------
    if not out and items_found and not items_new:
        out.append(
            Diagnosis(
                code="up_to_date",
                severity="info",
                title="Nothing new — this source is up to date",
                detail=(
                    f"{items_found} item(s) were seen and all of them were "
                    "already stored. This is a healthy run, not a failure."
                ),
                fix="No action needed.",
            )
        )
    if not out and not items_found and not issues:
        out.append(
            Diagnosis(
                code="empty_no_errors",
                severity="warning",
                title="The run found nothing and reported no errors",
                detail=(
                    "No rows and no failures usually means the listing page is "
                    "genuinely empty, or its content is rendered after load."
                ),
                fix=(
                    "Open the listing URL and confirm it shows notices. If it "
                    "does, the list is built in the browser — try the sitemap "
                    "path for this source instead."
                ),
                actions=(["detect_sitemap"] if not has_sitemap else []) + ["discover_routes"],
            )
        )

    for note in route_notes:
        out.append(
            Diagnosis(
                code="discovery_note",
                severity="info",
                title="URL auto-detection note",
                detail=note,
                fix="",
            )
        )

    severity_rank = {"error": 0, "warning": 1, "info": 2}
    out.sort(key=lambda d: severity_rank.get(d.severity, 3))
    logger.info(
        "Diagnosed run for %s: %s", base_url, [d.code for d in out]
    )
    return [d.as_dict() for d in out]
