# Notice/News Scraping Pipeline (crawl4ai → PostgreSQL)

This document describes the scraping pipeline that replaces the previously
planned **Scrapy + Selenium** stack (see `docs/TechStackByModule.md` §D,
row 22) with **[crawl4ai](https://github.com/unclecode/crawl4ai)**, an
open-source, async, Playwright-backed crawler with built-in structured
(CSS/JSON) extraction.

**This is a dynamic, multi-source pipeline.** An admin adds *any*
government/public website from the dashboard — a name, a base URL, one or two
listing page URLs (Notice / News), and (optionally) that site's pagination
scheme. There is no per-site code to write: the extraction pattern (which DOM
elements are list rows, which is the title/link/date) is **detected
automatically** on first run and **cached** for every run after that.
Scrape runs are triggered on demand and report **live status messages**
("Crawling Notice listing, page 2…", "Fetching detail: …") back to the
dashboard while they run, rather than being an opaque spinner.
`mofa.gov.np` (Ministry of Foreign Affairs, Nepal) is the first source
seeded into the system, but it is configured through the same admin UI as
any other source — see [§2](#2-how-dynamic-detection-works) (detection) and
[§6.4](#64-configurable-pagination--live-progress) (pagination & progress).

Services involved:

- **web** (`apps/web`) — Admin → Scraping dashboard: add/edit/disable/delete sources, trigger runs, view logs
- **api** (`apps/api`) — NestJS: owns `ScrapeSource`/`ScrapedItem`/`ScrapeRun` tables, orchestrates detection→cache, dedup/upsert, admin auth
- **ai** (`apps/ai`) — Python ASGI: runs the crawl4ai crawl + schema detection, returns structured JSON
- **PostgreSQL** — system of record for sources, scraped notices/news, and run history (via Prisma)

---

## 1. Why crawl4ai (vs. the originally planned Scrapy/Selenium)

| Concern | Scrapy + Selenium (old plan) | crawl4ai (as-built) |
|---|---|---|
| JS-rendered pages | Selenium only, separate driver/browser management | Native, Playwright-backed (`AsyncWebCrawler`) |
| Structured extraction | Hand-rolled `XPath`/`BeautifulSoup` per site | `JsonCssExtractionStrategy` — declarative CSS→JSON schema |
| Async/concurrency | Scrapy's own reactor (Twisted) | Native `asyncio`, integrates directly with the ASGI service |
| Two-tool glue code | Scrapy for crawling + Selenium for JS + BS4 for parsing | One library end-to-end |
| Maintenance surface | 3 libraries to version together | 1 library |

crawl4ai lives entirely inside `apps/ai` (Python), consistent with the
project's existing rule that **Python owns crawling/AI/ML**, and NestJS
remains the trusted gateway that owns persistence (see
`docs/TechStackByModule.md` §4.2–4.3).

---

## 2. How dynamic detection works

Arbitrary government/public sites have arbitrary markup — a hand-written CSS
schema per site (the original MOFA-only implementation) doesn't scale to "any
site an admin adds." Detection runs in three tiers, cheapest first:

```
1. Cached schema (free)         — reuse ScrapeSource.noticeSchema/newsSchema
                                   from a previous successful run
2. LLM-assisted detection        — only runs when there's no cached schema
   (paid once, then cached)       yet, or the cached schema suddenly returns
                                   zero rows (site markup changed). Uses
                                   Groq (GROQ_API_KEY, already configured for
                                   RAG) to read the page once and propose a
                                   schema. Explicitly instructed to prefer a
                                   real `<table>` of notices over "recent
                                   posts" sidebar widgets that duplicate
                                   across a site's pages.
3. Structural heuristics (free)  — if there's no LLM key configured, or the
   fallback                       LLM's proposed schema also yields zero
                                   rows: group sibling DOM elements by
                                   tag+class, score groups by repetition
                                   count and list-like class names ("row",
                                   "card", "item", "list", …), penalize
                                   nav/footer/pagination-like groups, then
                                   derive title/link/date field selectors
                                   from the winning group's first element.
```

Whichever schema actually produces rows is returned to NestJS, which
persists it on the `ScrapeSource` row (`noticeSchema/newsSchema`, JSON
columns storing a `JsonCssExtractionStrategy`-shaped schema). **Every
subsequent run reuses that cached schema — pure CSS extraction, no LLM calls,
no heuristics** — until the site's markup changes enough that the cached
schema returns zero rows, at which point detection re-runs automatically.

This is the "optimized" part of the design: detection cost (an LLM call, or
a DOM-scan) is paid at most once per source per site redesign, not on every
scheduled run.

**Escape hatch:** heuristics and even LLM detection can guess wrong on
unusual markup (see [§9](#9-known-limitations--future-work)). There is no
manual schema override in the admin UI yet — a source that repeatedly
detects the wrong DOM group needs a code-level fix or a direct
`UPDATE scrape_sources SET notice_schema = '{...}'` with a hand-written
schema. Adding an "Advanced: paste CSS schema JSON" field to the Add/Edit
Source dialog is the natural next step (see Suggestions).

**Detail-page content is not schema-based at all.** Article/detail pages
across arbitrary sites vary too much for a reusable per-site body selector.
Instead, `_crawl_detail_generic()` (`apps/ai/app/scraper.py`) fetches the
page, strips obvious chrome (`script`, `style`, `nav`, `header`, `footer`,
`aside`), and picks the first matching container from a priority list of
common article-body selectors (`article`, `main`, `[role="main"]`,
`.entry-content`, `.details__desc`, …), falling back to the whole
chrome-stripped page. `<h1>` is used for the title and `<time>` for the
published date as a fallback when the listing row didn't carry a date.

---

## 3. Target site anatomy — `mofa.gov.np` (the seeded example source)

| Category | Listing URL | Nav label | DOM shape |
|---|---|---|---|
| `NOTICE` | `/category/information/?page=N` | "Notice" | `<table class="table"><tbody><tr>…` — one row per item |
| `NEWS` | `/category/presscategory/?page=N` | "Press Release" | `<div class="category-1-grid"><div class="grid__card">…` — one card per item |

Both paginate via a `?page=N` query string, generalized in
`_paginated_url()` (works for any site using this common convention; sites
that don't will simply stop after page 1 returns no *new* rows).

> ⚠️ Note the `/category/automatic-publishing-notice/` URL is **not** the
> "Notice" nav item — that path is actually "Proactive Disclosure". The
> correct "Notice" category is `/category/information/`. Confirmed by
> resolving the nav-bar `<a>` tags, not by guessing from the URL slug.

> ⚠️ **Bikram Sambat / Gregorian date variance — not a JS issue.** MOFA's
> listing pages serve published dates in **either** Gregorian English
> (`"Sunday, June 07, 2026, 09:07 PM"`) **or** Bikram Sambat Devanagari
> (`"जेठ २४, २०८३, आइतबार २१:७"`, or day-first as `"२३ असार, २०८३"`) —
> confirmed via response headers (`X-Cache-Language: ne`/`en`, `Vary:
> Accept-Language`) to be a **Varnish CDN cache-variant split**, not something
> controllable via `Accept-Language` headers, Playwright locale settings, or
> disabling JavaScript (all three were tried and made no difference — the
> CDN serves whichever variant happens to be cached, regardless of the
> request). The fix is parsing **both** calendars rather than avoiding one:
> `_parse_bs_date()` in `apps/ai/app/scraper.py` converts Devanagari-numeral
> BS dates to Gregorian via the `nepali_datetime` library, handling both
> "month day, year" and "day month, year" token orders (different MOFA
> templates use different orders for the same data). This matters for any
> Nepali government site aggregated by this pipeline, not just MOFA.

---

## 4. End-to-end flow

```mermaid
flowchart TD
    subgraph WEB[apps/web - Admin Dashboard]
        A[Admin clicks "Run now"<br/>on a source card] --> B[POST /admin/scraping/sources/:id/run<br/>JWT, admin role]
        A2[Admin fills Add-source dialog<br/>name, baseUrl, notice/news URLs] --> B2[POST /admin/scraping/sources]
    end

    subgraph API[apps/api - NestJS]
        B --> C[ScrapingController.runSource<br/>JwtAuthGuard + RolesGuard admin]
        B2 --> C2[ScrapingController.createSource]
        C2 --> D2[(Prisma: INSERT scrape_sources)]
        C --> D[ScrapingService.runSource]
        D --> E[(Prisma: create ScrapeRun<br/>status=RUNNING, sourceId)]
        D --> F[(Prisma: SELECT sourceUrl<br/>FROM scraped_items<br/>WHERE sourceId=:id)]
        D --> G0[Load cached noticeSchema/newsSchema<br/>from scrape_sources row]
        F --> G[POST AI_SERVICE_URL/scrape/source<br/>base_url, category_urls,<br/>cached_schemas, known_urls]
        G0 --> G
    end

    subgraph AI[apps/ai - Python]
        G --> H[_scrape_source handler<br/>main.py]
        H --> I[scraper.scrape_source]
        I --> J["AsyncWebCrawler (crawl4ai)"]
        J --> K{cached schema<br/>yields rows?}
        K -->|yes| L[Pure CSS extraction<br/>JsonCssExtractionStrategy]
        K -->|no / no cache| K2{GROQ_API_KEY set?}
        K2 -->|yes| K3[LLM proposes schema<br/>from cleaned HTML]
        K2 -->|no| K4[Heuristic DOM-group<br/>scan + scoring]
        K3 --> K5{schema yields rows?}
        K4 --> K5
        K5 -->|no| K4b[Fall through to heuristic<br/>if LLM path was tried first]
        K5 -->|yes| L
        L --> M{detail URL already<br/>in known_urls?}
        M -->|no, new URL| N[Crawl detail page generically<br/>strip chrome, pick content container]
        M -->|yes, already stored| O[Skip detail fetch<br/>listing summary only]
        N --> P[Build ScrapedItem list<br/>+ schemas_used]
        O --> P
        P --> Q[Return 200 JSON: items, schemas]
    end

    Q --> R[ScrapingService receives items + schemas]
    R --> S{For each item:<br/>sourceUrl exists in DB?}
    S -->|no| T[(INSERT scraped_items<br/>sourceId, category, title, content, contentHash)]
    S -->|yes, contentHash changed| U[(UPDATE scraped_items)]
    S -->|yes, unchanged| V[Skip]
    T --> W[(UPDATE scrape_runs: SUCCESS<br/>UPDATE scrape_sources:<br/>lastRunAt, lastStatus, cached schemas)]
    U --> W
    V --> W
    W --> X[Response: runId, itemsFound,<br/>itemsNew, itemsUpdated]
    X --> Y[web refetches GET /admin/scraping/sources<br/>+ GET /admin/scraping/runs]
```

---

## 5. Data model (Prisma / PostgreSQL)

Added to `apps/api/prisma/schema.prisma`:

```prisma
enum ScrapedItemCategory {
  NOTICE
  NEWS
}

enum ScrapeRunStatus {
  RUNNING
  SUCCESS
  FAILED
}

enum ScrapePaginationType {
  QUERY_PARAM    // append ?<paginationParam>=<n> (or & if the URL already has a query string)
  PATH_TEMPLATE  // substitute a literal "{page}" token anywhere in the listing URL
  NONE           // single page only, regardless of maxPages
}

// An admin-configured website to scrape for notices/news. CSS extraction
// schemas are auto-detected (LLM first if configured, heuristics otherwise)
// on first run and cached here so subsequent runs are pure, fast CSS parsing.
model ScrapeSource {
  id                String    @id @default(uuid()) @db.Uuid
  name              String
  baseUrl           String    @map("base_url")
  noticeListUrl     String?   @map("notice_list_url")
  newsListUrl       String?   @map("news_list_url")
  noticeSchema      Json?     @map("notice_schema")
  newsSchema        Json?     @map("news_schema")
  // Pagination behavior — sites vary wildly (?page=N, ?start=N, /page/N/, or
  // no pagination at all), so this is admin-configurable per source.
  paginationType    ScrapePaginationType @default(QUERY_PARAM) @map("pagination_type")
  paginationParam   String    @default("page") @map("pagination_param")
  startPage         Int       @default(1) @map("start_page")
  maxPages          Int       @default(3) @map("max_pages")
  enabled           Boolean   @default(true)
  createdAt         DateTime  @default(now()) @map("created_at")
  updatedAt         DateTime  @updatedAt @map("updated_at")
  lastRunAt     DateTime? @map("last_run_at")
  lastStatus    ScrapeRunStatus? @map("last_status")

  items ScrapedItem[]
  runs  ScrapeRun[]

  @@map("scrape_sources")
}

model ScrapedItem {
  id            String              @id @default(uuid()) @db.Uuid
  sourceId      String?             @map("source_id") @db.Uuid
  source        ScrapeSource?       @relation(fields: [sourceId], references: [id], onDelete: Cascade)
  sourceLabel   String              @default("mofa.gov.np") @map("source_label")
  category      ScrapedItemCategory
  title         String
  sourceUrl     String              @unique @map("source_url")   // dedup key
  summary       String?
  contentText   String?             @map("content_text")
  contentHtml   String?             @map("content_html")
  attachmentUrl String?             @map("attachment_url")
  publishedAt   DateTime?           @map("published_at")
  contentHash   String              @map("content_hash")          // sha256(title+content)
  scrapedAt     DateTime            @default(now()) @map("scraped_at")
  updatedAt     DateTime            @updatedAt @map("updated_at")

  @@index([category])
  @@index([publishedAt])
  @@index([sourceId])
  @@map("scraped_items")
}

model ScrapeRun {
  id           String          @id @default(uuid()) @db.Uuid
  sourceId     String?         @map("source_id") @db.Uuid
  source       ScrapeSource?   @relation(fields: [sourceId], references: [id], onDelete: Cascade)
  sourceLabel  String          @default("mofa.gov.np") @map("source_label")
  status       ScrapeRunStatus @default(RUNNING)
  itemsFound   Int             @default(0) @map("items_found")
  itemsNew     Int             @default(0) @map("items_new")
  itemsUpdated Int             @default(0) @map("items_updated")
  error        String?
  startedAt    DateTime        @default(now()) @map("started_at")
  finishedAt   DateTime?       @map("finished_at")

  @@index([sourceId])
  @@map("scrape_runs")
}
```

**Dedup strategy:** `sourceUrl` (the absolute detail-page URL) is the unique
key across *all* sources — a global uniqueness constraint, not scoped per
source, so the same article URL can never be double-stored even if two
sources happened to reference it. `contentHash` (`sha256(title +
content_text)`) detects when a previously-scraped page has been edited, so a
re-run **updates** the row instead of silently skipping it or duplicating it.

`sourceLabel` is a denormalized snapshot of `ScrapeSource.name` at scrape
time, so items/runs still render sensibly if a source is later deleted
(`sourceId` cascades to `NULL`... actually cascades the *delete*, per
`onDelete: Cascade` — deleting a source deletes its items/runs. See
[§9](#9-known-limitations--future-work) for the tradeoff this implies).

> This schema was applied with `prisma db push` rather than
> `prisma migrate dev`, because the existing migration history in this repo
> had already drifted from the live database. Do not run `migrate dev` /
> `migrate reset` against this database — it will attempt to drop and
> recreate the schema. Use `db push` for further schema changes here until
> the migration history is reconciled.

The MOFA source was seeded directly (not through the admin UI, since it
pre-dates this multi-source version) with a fixed id
(`00000000-0000-0000-0000-000000000001`), and the 35 items/1 run already
scraped in the earlier MOFA-only version of this pipeline were backfilled
onto it (`sourceId` was previously `NULL` for those rows).

---

## 6. Python AI service (`apps/ai`)

### 6.1 `app/scraper.py`

Key functions:

- **`_detect_schema_heuristic(html, base_url)`** — groups sibling elements by
  tag+class signature, scores by row count and list-like class hints
  (`row`/`item`/`card`/`list`/`entry`/`result`/`post`/`notice`/`news`),
  penalizes nav/footer/pagination-like groups, then within the winning
  group: picks the best detail-page anchor (excludes file attachments and
  external/CDN links, scores by digit/path-depth heuristics that correlate
  with "this is an article ID link"), the longest non-date non-numeric text
  block for the title, and a `<time>` tag or date-class element (or a
  regex-matched date-like text node) for the published date.
- **`_detect_schema_llm(html, category)`** — sends the chrome-stripped HTML
  (truncated to 30,000 chars) to Groq with a prompt that explicitly asks it
  to prefer a real notice/news `<table>` over recurring "recent posts"
  widgets, and to return a `JsonCssExtractionStrategy`-shaped JSON schema.
  Returns `None` (falls through to heuristics) if no `GROQ_API_KEY` is
  configured, the call fails, or the response isn't valid JSON.
- **`_resolve_schema(crawler, listing_url, category, cached_schema)`** — the
  tiered lookup described in [§2](#2-how-dynamic-detection-works); returns
  `(schema, is_newly_detected)`.
- **`_crawl_detail_generic(crawler, url)`** — schema-free detail-page
  extraction (see [§2](#2-how-dynamic-detection-works)).
- **`_parse_published(raw)`** / **`_parse_bs_date(raw)`** — Gregorian format
  list plus Bikram Sambat parsing via `nepali_datetime` (see
  [§3](#3-target-site-anatomy--mofagovnp-the-seeded-example-source)).
- **`scrape_source(base_url, category_urls, cached_schemas, known_urls,
  max_pages, fetch_detail, pagination, on_progress)`** — the public
  orchestration entry point:
  1. Opens one `AsyncWebCrawler` (headless Chromium via Playwright, JS
     **enabled** — many admin-added sites render listings client-side) for
     the whole run.
  2. For each category present in `category_urls`, resolves a working schema
     (cached → LLM → heuristic) once, then crawls listing pages built by
     `_paginated_url()` according to `pagination` (see
     [§6.4](#64-configurable-pagination--live-progress)), stopping early once
     a page yields no rows not already seen this run.
  3. For each listing row, resolves the absolute detail URL. If it's **not**
     in `known_urls` (not already in Postgres), fetches the detail page for
     full content generically; otherwise keeps the listing-only summary —
     the main cost-control lever, since detail fetches are the expensive
     part of each run.
  4. Calls `on_progress(message)` at each meaningful step (schema resolution,
     each listing page, each detail fetch, completion) if provided — this is
     what powers the admin dashboard's live status feed.
  5. Returns `(items: list[ScrapedItem], schemas_used: dict[str, dict])` —
     the schemas are handed back so the caller can persist them.

### 6.2 Route: `POST /scrape/source`

Added to `apps/ai/app/main.py`'s hand-rolled ASGI router (`_route`),
matching the existing pattern used by `/query`, `/documents`, etc.

**Request:**
```json
{
  "base_url": "https://mofa.gov.np",
  "category_urls": {
    "NOTICE": "https://mofa.gov.np/category/information/",
    "NEWS": "https://mofa.gov.np/category/presscategory/"
  },
  "cached_schemas": { "NOTICE": { "baseSelector": "table.table tbody tr", "fields": [...] } },
  "known_urls": ["https://mofa.gov.np/content/1820/.../", "..."],
  "max_pages": 3,
  "run_id": "a3f1...-uuid-of-the-ScrapeRun-row",
  "pagination": { "type": "QUERY_PARAM", "param": "page", "start_page": 1 }
}
```

`run_id` and `pagination` are both optional — omitting `run_id` skips progress
recording (used by the manual `curl` test in [§10](#10-manual-test-checklist));
omitting `pagination` defaults to `{type: "QUERY_PARAM", param: "page",
start_page: 1}`, matching the original MOFA-only behavior.

**Response:**
```json
{
  "items": [
    {
      "category": "NOTICE",
      "title": "Attention: Application for the position of Ambassador",
      "source_url": "https://mofa.gov.np/content/1820/attention--application-for-the-position-of-ambassador/",
      "published_at": "2026-06-02T16:27:00",
      "summary": "Thank you for your overwhelming response...",
      "content_text": "Thank you for your overwhelming response...",
      "content_html": "<div class=\"details__desc\">...</div>",
      "attachment_url": null
    }
  ],
  "schemas": {
    "NOTICE": { "baseSelector": "table.table tbody tr", "fields": [...], "name": "llm_detected" }
  }
}
```

`schemas` only contains entries for categories where a schema was actually
used (cached-and-still-working, or freshly detected) — the caller persists
these onto the `ScrapeSource` row regardless of whether they changed, since
writing the same JSON back is harmless and simpler than diffing.

Errors from the crawl (network failure, no working schema found) return
`502`/`400` with an `error` message; the NestJS side surfaces this as a
`FAILED` `ScrapeRun` rather than throwing an unhandled 500.

### 6.3 Route: `GET /scrape/progress/{run_id}`

Polled by NestJS (proxied to the admin dashboard) while a run is in flight.

**Response (mid-run):**
```json
{
  "run_id": "a3f1...",
  "stage": "running",
  "messages": [
    { "at": 1783675306.4, "text": "Resolving extraction pattern for Notice…" },
    { "at": 1783675311.0, "text": "Crawling Notice listing, page 1…" },
    { "at": 1783675312.2, "text": "Fetching detail: Attention: Application for the position of Ambassador" }
  ],
  "error": null,
  "started_at": 1783675304.9,
  "updated_at": 1783675312.2
}
```

`stage` is `"running"`, `"done"`, or `"failed"`; `404` if the AI service has
no record of that `run_id` (never started, or evicted — see
[§6.4](#64-configurable-pagination--live-progress)).

### 6.4 Configurable pagination & live progress

**Pagination.** `_paginated_url(listing_url, page_index, config)` in
`scraper.py` builds each listing page's URL from a `PaginationConfig`
(`pagination_type`, `param`, `start_page`), mirroring the admin-configurable
`ScrapeSource` columns:

| Type | Behavior |
|---|---|
| `QUERY_PARAM` (default) | Appends `?<param>=<n>` (or `&` if the URL already has a query string). Covers the common `?page=2`, `?start=20`, etc. |
| `PATH_TEMPLATE` | Substitutes a literal `{page}` token anywhere in the listing URL, e.g. `.../notices/page/{page}/`. If no `{page}` token is present, behaves like a single page rather than silently repeating page 1. |
| `NONE` | Always a single page, regardless of `maxPages`. |

`page_index` is 0-based; the actual page number sent to the site is
`start_page + page_index`, so a site whose first page is `?page=0` (rather
than `1`) is handled by setting `startPage: 0` on the source.

**Pager discovery.** The configured scheme is a starting guess, not the
answer. On page 1 `_discover_pager(html, listing_url)` reads what the listing
says about itself and hands it to `_detect_pagination` as the first candidate
to probe:

- the pager widget's page links — plain `<a href="?paged=2">`, `/page/2`
  paths, **and Livewire buttons** (`wire:click="gotoPage(2, 'page')"` /
  `wire:key="paginator-page-page-2"`), which is what most Laravel-based
  Nepali portals render and which carry no `href` at all;
- the result counter — `Showing 1 to 10 of 23 results` gives the page size
  and the total, hence the true page count (3). Only the *first* window is
  read for page size: "Showing 21 to 23 of 23" is the tail of a 10-per-page
  listing, not a 3-per-page one.

Nothing here is trusted blindly — the discovered scheme still has to prove
itself by returning a page 2 that differs from page 1.

**Deep ("all pages") runs.** `scrape_source(..., deep=True)` is the archive
backfill, triggered by *All pages* on a source card or *Deep scrape all* in
the admin dashboard (`POST .../run` and `.../run-all` with `{ deep: true }`).
It differs from an incremental run in exactly three ways:

| | Incremental | Deep |
|---|---|---|
| Page limit | source's `maxPages` (default 3) | pager's reported last page, capped by `SCRAPE_DEEP_MAX_PAGES` (50) |
| Stop when a page has no *unknown* items | yes — newest-first means everything behind it is known | no — known pages sit between page 1 and the unscraped tail |
| "Page repeats the previous one" test | ≥3 new rows *and* ≥25% of the page | ≥1 new row, so a short final page still counts |

Detail pages are still skipped for URLs already stored, so a deep re-run over
a mostly-scraped archive costs listing loads plus the genuinely new items.
Deep runs get their own time budgets — `DEEP_SCRAPE_TIMEOUT_SECONDS` (3300s)
in the AI service, `DEEP_RUN_TIMEOUT_MS` (3480s) in `ScrapingService`, both
under the default `SCRAPING_STALE_TIMEOUT_SECONDS` (3600) so the scheduler
cannot reclaim a deep run that is still legitimately crawling. Because the
AI service picks its timeout before reading the request body, deep mode is
also sent as an `x-scrape-deep: 1` header.

The scheduler never runs deep — automatic polling stays incremental.

**Live progress.** `apps/ai/app/scrape_progress.py` mirrors the existing
`app/progress.py` (used for document-ingestion progress) but tracks a
rolling **message log** per `run_id` rather than a percent bar — a scrape
run's useful status is "what's happening right now" (which category, which
page, which detail page), not a smooth percentage. Entries are process-local
and evicted after 15 minutes past completion (same TTL/cap pattern as
`progress.py`), which is fine since the authoritative run result lives in
Postgres (`ScrapeRun`).

This only works because `ScrapingService.runSource()` (NestJS) is
**fire-and-forget**: it creates the `ScrapeRun` row, kicks off the AI call
without awaiting it in the request path, and returns `{ runId }`
immediately. The web dashboard then polls `GET
/admin/scraping/runs/:id/progress` (which proxies to `GET
/scrape/progress/{run_id}` on the AI service) every ~1.2s and renders the
message feed live under the source's card, stopping once `stage` is `"done"`
or `"failed"`.

### 6.4b Route discovery & failure diagnosis

Two problems the pipeline used to push onto the admin: *finding* the right
listing URL, and *interpreting* a failure once it had one.

**Route discovery** (`apps/ai/app/route_discovery.py`, `POST /scrape/discover`)
finds a site's notice/news/press-release routes from the site itself, so an
admin can paste a home page instead of browsing for the list. These portals
agree on nothing — `/notices`, `/notice-board`, `/category/suchana`,
`/page/act-regulation`, a "सूचना तथा जानकारी" menu over an opaque URL — so
the route is found rather than guessed:

1. Harvest every same-origin link on the home page with its anchor text and
   whether it sits in the navigation.
2. Score against a bilingual keyword table (English, romanised Nepali,
   Devanagari) applied to the URL path **and** the link text — the text is
   the only signal when the URL is opaque.
3. Down-rank links that address one article rather than a section (a numeric
   id segment, a trailing post id, a headline-length slug). Without this,
   homepage teasers for individual notices tie with the real routes and eat
   the verification budget.
4. Probe a short list of conventional paths the site never linked.
5. **Verify by crawling.** A route counts only when the extractor finds rows
   that link to individual articles — keywords say a page *should* be a
   listing, this says it *is* one.
6. Expand one level into the best unverified candidate, for portals whose
   menu points at a landing page with the real list one click below.

Measured on live home pages: moha.gov.np resolves to `/page/notice`,
`/page/news` and `/page/press-release`; mohp.gov.np to
`/category/pressrelease` and `/category/latest-news` — in every case the
correct routes rank above every article link on the page.

**Failure diagnosis** (`apps/ai/app/scrape_diagnosis.py`, `POST
/scrape/diagnose`) reads a run's structured failures together with the
source's configuration and returns ranked, actionable findings — each with a
`patch` the admin can apply in one click:

| Code | Recognised from | Suggested fix |
|---|---|---|
| `listing_url_dead` | HTTP 404/410/400/401 on a listing URL | The replacement URL found by discovery, as a `noticeListUrl`/… patch |
| `blocked` | 403 / Cloudflare / captcha / 429 | Raise `pollIntervalSeconds` |
| `dns_failure`, `tls_failure` | `ERR_NAME_NOT_RESOLVED`, cert errors | Check/replace the base URL; try `http://` |
| `site_unreachable` | timeouts, 502/503/504 after retries | Re-run; raise the interval if persistent |
| `no_listing_pattern` | `schema_detection` stage failure | Switch to a route discovery found, or fall back to the sitemap |
| `rows_rejected` | rows found, all skipped as `not_article_url` | Base URL and listing URL are on different hosts |
| `rows_untitled` | rows found, all skipped as `no_title` | Re-run to re-detect the pattern |
| `detail_pages_failing` | ≥half the items' detail pages failed | Rate limiting — re-run, or raise the interval |
| `pagination_mismatch` | observed scheme ≠ configured scheme | Save the detected `paginationType`/`paginationParam`/`startPage` |
| `up_to_date`, `empty_no_errors` | no failures, no new items | Says explicitly that nothing is wrong |

`ScrapingService` runs this automatically whenever a run ends FAILED or with
zero items — with route discovery enabled in that case, so "your URL returns
404" can become "…and the notices moved here". Results are stored on
`ScrapeRun.diagnosis` and `ScrapeSource.lastDiagnosis` (cleared on the next
healthy run), and the admin can re-run it on demand via `POST
/admin/scraping/sources/:id/diagnose`.

### 6.4c Streaming persistence — surviving a 504 mid-run

**The problem this fixes.** Every scrape used to be request/response,
end-to-end: the AI service crawled every page, fetched every detail page,
summarized every item — all of it held in memory — and only handed anything
back to apps/api in the single JSON response at the very end. A large
source (MOFA: 400+ items, 20 configured pages) can take many minutes; if
nginx, an ALB, or axios's own timeout cut that connection at minute 9 of a
10-minute crawl, the *entire run's work was discarded*. The source card
showed `Request failed with status code 504` and item count 0 for a run
that had, in truth, successfully scraped and summarized hundreds of items —
none of which ever reached Postgres.

**The fix: push each item the moment it's ready, not at the end.**
`apps/ai/app/scrape_stream.py`'s `RunStreamer` POSTs every item to
apps/api's `POST /internal/scraping/runs/:runId/items` as soon as its own
detail-fetch and summarization finish — not batched, not held for the page
or the run to complete. `ScrapingService.ingestStreamedItems` persists it
through the exact same dedup/attachment/PDF-extraction/alert-matching logic
as before (`persistOneItem`, shared with the batch path), increments the
run's counters (`itemsFound`, `itemsNew`, …) with atomic `{ increment }`
updates, and embeds it into the vector store immediately. By the time any
outer timeout fires, everything finished so far is already durable — a run
that gets cut off after 300 of 400 items keeps those 300.

**Auth & endpoints** — `InternalServiceGuard` (`src/guards/
internal-service.guard.ts`, shared with `InternalAiConfigController`) gates
`InternalScrapingController`:
- `POST /internal/scraping/runs/:runId/items` — body `{ items: [...] }`.
- `POST /internal/scraping/runs/:runId/finish` — closes the run's book:
  status, `finishedAt`, schema caching, diagnosis. Idempotent — a second
  call on an already-`finishedAt` run is a no-op (`{ alreadyFinished: true
  }`), which is what lets both an AI-service-initiated finish and apps/api's
  own catch-block finalize race safely without one stomping the other.

**Who calls `/finish`, and when — the `auto_finish` flag.**
`executeRun`'s listing crawl might still fall back to a sitemap crawl for
the *same* `run_id` if the listing yields 0 items (mohp.gov.np-style 404
category pages with a healthy sitemap). If the AI service closed the run's
book itself after the listing call, the sitemap fallback's items would
stream into an already-finished run with a stale status. So apps/api sends
`auto_finish: false` on every `/scrape/source` and `/scrape/sitemap-crawl`
call it makes, and calls `ScrapingService.finalizeRun` itself exactly once
— after it knows the full picture (whether a fallback ran or not).
`finalizeRun` persists any items the response carries with a full body
(items that failed to stream, or streaming being unavailable entirely —
older AI service, misconfigured `INTERNAL_SERVICE_SECRET`) through
`ingestStreamedItems`, then calls `finishStreamedRun`.

**The response shrinks too.** An item successfully streamed is reduced in
the final HTTP response to `{"source_url": "...", "streamed": true}` (see
`RunStreamer.response_items`) instead of repeating its full body — the
response itself must never be the thing a proxy times out on for a run that
found hundreds of items. `apps/api`'s `RawScrapedItem.streamed` flag is how
`finalizeRun` tells "already in Postgres" apart from "still needs
persisting."

**Backward compatible by construction.** A caller with no `run_id`, or an
AI service instance with `INTERNAL_SERVICE_SECRET` unset, streams nothing
(`RunStreamer.enabled` is `False`) — `on_item` is never wired into
`scraper.scrape_source`/`scrape_sitemap_urls`, so behavior is byte-for-byte
what it was before streaming existed: the full item list travels in the one
response, and `finalizeRun` persists all of it the old way.

### 6.4d LLM provider fallback — OpenRouter's multiple free models

Every LLM call in this service (RAG answers, chat, notice summarization,
schema detection) already fell back across *providers* in admin-configured
order (OpenRouter → Groq → Gemini → OpenCode → Bedrock, `llm.py`'s
`_llm_chat`). What was missing: OpenRouter itself was a single hardcoded
free model (`OPENROUTER_MODEL`, default `minimax/minimax-m3:free`) — once
*that one model's* daily quota was spent, OpenRouter contributed nothing
until reset, and every subsequent call fell all the way through to Groq
(itself a shared 200k-tokens/day pool that a single scrape run reliably
exhausts).

Verified against the live OpenRouter API (`/api/v1/models`, 2026-09-07):
each `:free` model meters against its **own independent daily quota** — a
429 on one says nothing about the others. `llm._openrouter_chat_with_fallback`
exploits exactly that: it tries the admin-configured `OPENROUTER_MODEL`
first, then walks `config.OPENROUTER_FREE_MODELS` (env-overridable,
comma-separated) — six more verified-live free models — before the outer
`_llm_chat` loop moves on to Groq. `_is_openrouter(provider)` matches on the
endpoint host, not the slug, so this applies to any provider row pointed at
`openrouter.ai`, admin-renamed or not.

**Scrape-time summarization now goes through this chain too.**
`scraper.py`'s `_summarize_item` used to be a separate, hand-rolled
Groq-only implementation with its own API-key rotation and 429-backoff loop
— a completely different code path from `llm.py`'s provider fallback, and
the reason a scrape's summarization step could stall for tens of seconds
per item on Groq's free tier even when OpenRouter, Gemini, or Bedrock sat
idle and fully configured. It now delegates to `llm.analyze_notice(title,
content, category_hint)` — the same function behind the on-demand
`/notices/analyze` route — which shares one prompt (`_ANALYZE_PROMPT`,
extended with the `urgency` field the scrape path needs) and gets the full
multi-provider, multi-model fallback for free. `_detect_schema_llm`
(LLM-assisted listing-schema detection) was migrated the same way, through
the new `llm.raw_chat(system_prompt, user_content, max_tokens,
temperature)` — a thin public wrapper around `_llm_chat` for callers
outside `llm.py` that don't fit `generate_answer`/`generate_chat`/
`analyze_notice`'s specific shapes.

### 6.5 Dependencies

Added to `apps/ai/requirements.txt`:

```
crawl4ai>=0.6.0
beautifulsoup4>=4.12.0
nepali-datetime>=1.0.5
```

**One-time setup** after `pip install -r requirements.txt` — crawl4ai needs
its Playwright browser binaries installed:

```bash
cd apps/ai
source .venv/bin/activate
pip install -r requirements.txt
crawl4ai-setup        # downloads headless Chromium for Playwright
crawl4ai-doctor        # sanity-checks the install
```

Without this step, `AsyncWebCrawler` will fail at runtime with a Playwright
"executable doesn't exist" error — this is separate from `pip install`
succeeding.

### 6.6 Sitemap fast-path & direct-URL crawl

Some sources (e.g. `mohp.gov.np`) expose a healthy XML sitemap but have
listing category URLs that 404 — `/category/notice/` returns an SVG-only
error page, which crawl4ai's content heuristics mislabel as
"Blocked by anti-bot protection: Structural: minimal_text". Two mechanisms
keep data flowing for such sources without per-site code:

1. **Sitemap poll (`/scrape/sitemap/detect`, `/scrape/check`)** — one-time
   detection of the winning article sitemap (robots.txt → `/sitemap.xml` →
   best `sitemapindex` child, verified for same-origin article-like `<loc>`s),
   cached on the `ScrapeSource` row; each poll is a cheap GET returning only
   `<loc>` entries not yet in the DB (`new_urls`).
2. **Direct-URL crawl (`/scrape/sitemap-crawl`)** — when the sitemap poll
   reports new URLs, the scheduler (or a manual run's zero-items fallback)
   fetches those exact detail pages via `scraper.scrape_sitemap_urls()`,
   reusing the same generic detail-page pipeline, attachment scanning, and
   concurrent AI summarization as a listing crawl. No listing page, no CSS
   schema, no `JsonCssExtractionStrategy` — the sitemap already enumerated
   the content.

**Route: `POST /scrape/sitemap-crawl`**

```json
{
  "base_url": "https://mohp.gov.np",
  "urls": ["https://mohp.gov.np/content/474/.../", "..."],
  "known_urls": ["..."],
  "run_id": "a3f1...-uuid-of-the-ScrapeRun-row"
}
```

Returns the same `{items, schemas}` shape as `/scrape/source` (schemas is
always empty), so the NestJS side persists through the identical
dedup/attachment/summarize pipeline (`persistItems`).

**API wiring:** `ScrapingService.runSourceFromUrls(id, urls)` +
`executeRunFromUrls()` (used by the scheduler's `pollSitemap` →
`enqueueUrlScrape` path) and `executeRun`'s fallback — a manual "Run now"
whose listing crawl yields 0 items but whose source has a `sitemapUrl`
falls back to crawling the sitemap's new URLs. Both paths share
`persistItems()` with the listing crawl.

---

## 7. NestJS API (`apps/api`)

### 7.1 `ScrapingService` (`src/services/scraping.service.ts`)

- **Source CRUD:** `listSources()` (with item counts via `_count`),
  `getSource(id)`, `createSource(input)` (requires at least one of
  `noticeListUrl`/`newsListUrl`), `updateSource(id, input)` (changing a
  listing URL clears that category's cached schema — the old selectors were
  derived from the old page), `deleteSource(id)` (cascades to its items/runs
  via the FK).
- **`runSource(id, categories?)`** — **fire-and-forget**: creates the
  `ScrapeRun` row (`status=RUNNING`), kicks off `executeRun()` without
  awaiting it, and returns `{ runId }` immediately. This lets the caller
  (the admin dashboard) start polling progress right away instead of
  blocking on the whole crawl.
  1. Guards against overlapping runs **per source** with an in-memory
     `Set<sourceId>` (different sources can run concurrently; the same
     source can't run twice at once). Single-instance assumption — see
     [§9](#9-known-limitations--future-work).
- **`executeRun(runId, source, categories?)`** (private) — the actual work,
  detached from the request/response cycle:
  1. Builds `category_urls` from the source's configured listing URLs,
     `cached_schemas` from `source.noticeSchema`/`newsSchema`, and
     `known_urls` from all `ScrapedItem.sourceUrl`s already stored for this
     `sourceId`.
  2. POSTs to `${AI_SERVICE_URL}/scrape/source` with `max_pages`, `run_id:
     runId`, and a `pagination` object built from the source's
     `paginationType`/`paginationParam`/`startPage` columns (same
     `HttpService` + `ConfigService` pattern as `RagService`/
     `DocumentsService`), 10-minute timeout (raised from 5 to accommodate
     sources configured for more pages/detail fetches).
  3. For each returned item, hashes `title + content_text`, and either
     inserts a new `ScrapedItem`, updates one whose hash changed, or skips
     an unchanged one.
  4. Updates the `ScrapeRun` to `SUCCESS` with counts (or `FAILED` with the
     error message), and updates the `ScrapeSource` row's `lastRunAt`,
     `lastStatus`, and any schemas returned — all in a `finally` block that
     also clears the per-source running lock.
- **`getRunProgress(runId)`** — proxies `GET
  ${AI_SERVICE_URL}/scrape/progress/{runId}` with a short 5s timeout;
  returns an empty `{ messages: [] }` shell instead of throwing if the AI
  service is unreachable, so a flaky poll doesn't break the dashboard.
- `listItems(sourceId?, category?, page, limit)` /
  `listRuns(sourceId?, limit)` — paginated reads for the admin dashboard,
  optionally scoped to one source.

### 7.2 `ScrapingController` (`src/controllers/scraping.controller.ts`)

All routes are under `/admin/scraping` and gated by
`@UseGuards(JwtAuthGuard, RolesGuard)` + `@Roles(Role.admin)` (same pattern
as other admin-only routes in this codebase):

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/admin/scraping/sources` | List all configured sources with item counts |
| `POST` | `/admin/scraping/sources` | Add a new source (`name`, `baseUrl`, `noticeListUrl?`, `newsListUrl?`, `paginationType?`, `paginationParam?`, `startPage?`, `maxPages?`) |
| `PATCH` | `/admin/scraping/sources/:id` | Edit a source, or toggle `enabled` |
| `DELETE` | `/admin/scraping/sources/:id` | Remove a source (cascades to its items/runs) |
| `POST` | `/admin/scraping/sources/:id/run` | Trigger a scrape run — returns `{ runId }` immediately (body: `{ categories?: ["NOTICE","NEWS"] }`) |
| `GET` | `/admin/scraping/runs/:id/progress` | Live status messages for an in-flight (or just-finished) run |
| `GET` | `/admin/scraping/items` | Paginated, filterable list of scraped notices/news (`?sourceId=&category=&search=&dateFrom=&dateTo=&sortBy=&sortOrder=&page=&limit=`) |
| `DELETE` | `/admin/scraping/items/:id` | Remove a single scraped item |
| `GET` | `/admin/scraping/runs` | Recent run history (`?sourceId=&limit=`), for the Logs tab |

### 7.3 `ScrapingModule`

Registers `HttpModule.register({ timeout: 300000 })` and is wired into
`AppModule` alongside the other feature modules. Unchanged by this revision
— note `executeRun`'s own HTTP call to `/scrape/source` overrides this with a
10-minute timeout per-request (see 7.1), since the module-level default is
now mostly a floor for other calls like `getRunProgress`.

---

## 8. Web admin dashboard (`apps/web/app/admin/scraping`)

Rebuilt from a 100%-mock scaffold into a fully live CRUD page:

- **Sources tab:** one card per `ScrapeSource`, each with its enabled/failed
  status badge, categories configured, item count, pagination summary (e.g.
  `?page=N · up to 3 pages`), last-run timestamp, and **Run now** /
  **Enable-Disable** / **Edit** / **Delete** actions, all calling the real
  API.
  - **Add/Edit source dialog:** `name`, `baseUrl`, the two optional listing
    URLs, and a collapsible **Advanced: pagination** section (pagination
    style select — Query parameter / Path template / No pagination — plus
    the query-param name, start page, and max pages per run, shown
    conditionally on the selected style).
  - **Live progress while running:** clicking **Run now** immediately shows
    a small scrolling message panel on that source's card, polling `GET
    /admin/scraping/runs/:id/progress` every 1.2s and rendering the last few
    status lines (e.g. "Crawling Notice listing, page 2…", "Fetching
    detail: …") until the run finishes, at which point the card refreshes
    with the final item count/status.
- **Logs tab:** real run history across all sources from `GET
  /admin/scraping/runs`, refreshable, showing "Scraping…" for runs still in
  progress.

The stat tiles (active sources, total sources, scraped items, errors) are
computed from the live `sources` list rather than hardcoded. The old
mock-only "Config" tab (fake timeout/retry sliders with no backing
implementation) was removed rather than left as dead UI implying
unimplemented settings.

New/changed client helpers in `apps/web/lib/api.ts`:

```ts
fetchScrapeSources()
createScrapeSource(input)     // input now includes paginationType/paginationParam/startPage/maxPages
updateScrapeSource(id, input)
deleteScrapeSource(id)
runScrapeSource(id, categories?)      // returns { runId } immediately
fetchScrapeRunProgress(runId)         // poll while a run is in flight
fetchScrapedItems(filters)            // sourceId/category/search/dateFrom/dateTo/sortBy/sortOrder/page/limit
deleteScrapedItem(id)
fetchScrapeRuns(sourceId?, limit)
```

`ScrapeSource` was added to `apps/web/lib/types.ts`; `ScrapedItem`/`ScrapeRun`
were updated to carry `sourceId`/`sourceLabel` instead of the old flat
`source: string`.

---

## 9. Known limitations & future work

- **No manual schema override yet.** When both LLM detection and heuristics
  pick the wrong repeating-element group (observed on `mofa.gov.np`'s News
  page, whose "recent posts" sidebar widget structurally resembles the real
  grid), there's no admin-facing way to correct it short of a direct
  database update. **Suggested fix:** add an optional "Advanced: paste CSS
  schema JSON" field to the Add/Edit Source dialog that, when present,
  bypasses detection entirely for that category.
- **Heuristic/LLM detection can still misfire on unusual markup.** The
  heuristic scorer is a reasonable generalist (table rows, list items, card
  grids) but is not guaranteed to find the right group on every possible
  site layout; the LLM path is materially more reliable when a `GROQ_API_KEY`
  is configured (which it is, by default, for this project's RAG feature)
  but is still a best-effort read of one page, not a guarantee.
- **Scheduling:** this phase only wires a manual "Run now" trigger per
  source. `.env` already reserves `SCRAPING_INTERVAL_CRON` and
  `SCRAPING_CONCURRENCY` for a future `@nestjs/schedule` cron job that loops
  over enabled sources and calls `runSource()` — not yet implemented.
- **Single-instance run lock:** `ScrapingService`'s overlap guard is an
  in-memory `Set`. If the API ever runs as multiple replicas, this needs to
  move to a DB-backed or Redis-backed lock (e.g. a `RUNNING` row check with a
  stale-run timeout) so two replicas can't scrape the same source
  concurrently.
- **Deleting a source deletes its history.** `onDelete: Cascade` on
  `ScrapedItem`/`ScrapeRun` means removing a misconfigured source also wipes
  everything it ever scraped. A "soft delete" (keep `enabled=false` instead
  of hard-deleting) is probably the safer default admin action; consider
  changing the "Delete" button to a disable-only action and adding a
  separate, more clearly destructive "Purge" action for actual deletion.
- **No alerting/classification yet:** scraped items land in `scraped_items`
  as-is; the "AI-powered" categorization/summarization/alerts-matching
  described in `docs/TechStackByModule.md` (rows 21, 24) is not part of this
  phase.
- **Public Notices UI still uses `mockNotices`:** `apps/web/app/admin/notices`
  was wired to `scraped_items` (with search/category/source/date-range
  filtering and sorting) in a later revision, but the **public-facing**
  `apps/web/app/notices` pages are unchanged. Wiring those to real scraped
  data is a natural next step once more than one source has meaningful
  volume.
- **Pagination config doesn't cover "load more"/infinite-scroll sites.**
  `ScrapePaginationType` handles URL-addressable pagination (`?page=N`,
  `/page/N/`, or none); sites that only reveal more rows via a JS "Load
  more" button or infinite scroll (no distinct URL per page) aren't
  supported yet — that would need `js_code`/`scan_full_page`-style crawl4ai
  interaction scripting, not just a different URL template.
- **Progress messages are ephemeral and single-process.** `scrape_progress`
  state lives in the AI service's memory, keyed by `run_id`; an AI service
  restart mid-run loses the message log (the `ScrapeRun` row's final
  SUCCESS/FAILED status is still recorded correctly by NestJS once/if the
  HTTP call completes or errors). If the AI service ever runs as multiple
  replicas, progress polling would need to be sticky-routed to whichever
  replica is running that scrape, or moved to a shared store (Redis).
- **robots.txt / rate limiting:** crawl4ai does not automatically throttle
  requests to a single host; the current implementation crawls sequentially
  (one page/detail fetch at a time within a single `AsyncWebCrawler`
  session), which is gentle by construction, but there's no explicit
  per-host delay or `robots.txt` check yet. Add `mean_delay`/`max_range` via
  crawl4ai's rate-limiting options before onboarding sources with stricter
  crawl policies, and consider checking `robots.txt` before adding a new
  source (surface a warning in the Add Source dialog, at minimum).
- **`attachment_url` is not extracted generically.** The original
  MOFA-specific schema captured a PDF/image attachment link per row; the
  generic listing schema (auto-detected) does not attempt this, since
  "which link is the attachment vs. the detail link" is exactly what
  `_pick_detail_anchor` already has to disambiguate, and doing it reliably
  for *both* purposes at once was out of scope for this pass.
- **Detail-page content can include minor boilerplate.** The generic content
  extractor picks the best matching container (`article`, `main`,
  `.entry-content`, etc.) but on sites without a tightly-scoped content
  wrapper (MOFA's own template wraps the whole `<main>`, including the
  title, date, and font-size toggle buttons, rather than isolating the body
  in its own container) some non-article text can bleed into
  `content_text`/`content_html`. This does not affect title/date/link
  accuracy, only the fidelity of the stored body text.

---

## 10. Manual test checklist

1. `cd apps/ai && source .venv/bin/activate && pip install -r requirements.txt && crawl4ai-setup`
2. Start the AI service: `pnpm dev:ai` (or `uvicorn app.main:app --reload --port 8000`)
3. `curl -X POST localhost:8000/scrape/source -H 'content-type: application/json' -d '{"base_url":"https://mofa.gov.np","category_urls":{"NOTICE":"https://mofa.gov.np/category/information/"},"cached_schemas":{},"known_urls":[],"max_pages":2,"run_id":"test-1","pagination":{"type":"QUERY_PARAM","param":"page","start_page":1}}'` — confirm JSON `items[]` spans both pages (12 items, not 6) and includes a `schemas.NOTICE` object.
4. While that request is in flight, in another terminal: `curl localhost:8000/scrape/progress/test-1` — confirm a growing `messages[]` list ("Crawling Notice listing, page 1…", "Fetching detail: …", …) and `stage: "running"`; after the request completes, confirm `stage: "done"`.
5. Start the API: `pnpm dev:api`. Confirm `apps/api/prisma/schema.prisma` is applied (`pnpm exec prisma db push` from `apps/api`).
6. Log in to the web app as an admin user, open **Admin → Scraping**. Confirm the seeded "Ministry of Foreign Affairs (MOFA)" source card appears with its real item count.
7. Click **Add source**, expand **Advanced: pagination**, set a pagination style/param/start page/max pages for a second government/public site, save, then click **Run now** on its card — confirm the live message panel appears under the card and updates every ~1.2s, then clears once the run finishes and the card shows the final item count/status.
8. Confirm the Logs tab shows the run with `itemsNew`/`itemsFound`, and shows "Scraping…" for any run still in progress.
9. Re-run the same source — confirm `itemsNew` drops to ~0 (only genuinely new posts) and check AI service logs for `Cached schema for ... yielded no rows` (should **not** appear — the cached schema should keep working) and no new LLM/heuristic detection log lines.
10. Toggle **Disable** on a source and confirm **Run now** becomes unavailable; **Enable** it again and confirm it becomes runnable.
11. Open **Admin → Notices**, filter by the new source and a date range, and confirm only its matching items appear.
12. Delete a source and confirm its card disappears and its items/runs are gone from both the Logs tab and Admin → Notices.

---

## Suggestions for next iterations

Ranked roughly by impact-to-effort:

1. **Manual schema override field** in the Add/Edit Source dialog (see
   [§9](#9-known-limitations--future-work)) — the single highest-leverage
   fix for the "detection picked the wrong widget" failure mode, and turns
   this from "usually works automatically" into "always works, with a
   documented manual fallback."
2. **Scheduling via `@nestjs/schedule`.** Loop over `enabled` sources on a
   cron (`SCRAPING_INTERVAL_CRON`), calling `runSource()` for each with a
   per-source `lastRunAt`-based backoff so a slow/failing source doesn't
   block others. This is the difference between "admin remembers to click
   Run" and an actually autonomous pipeline.
3. **Soft-delete sources** instead of cascading hard-deletes, so disabling a
   bad source doesn't destroy its scrape history.
4. **`robots.txt` check on Add Source**, surfaced as a warning (not a hard
   block) — keeps the admin honest about crawl policy without adding a
   backend dependency.
5. **Per-host rate limiting** (`mean_delay`/`max_range` in crawl4ai's
   `CrawlerRunConfig`) once more than a couple of sources are onboarded, so
   simultaneous admin-triggered runs against different hosts don't
   accidentally hammer any single site.
6. **Wire the public Notices pages to `scraped_items`** — `apps/web/app/admin/notices`
   already made this switch; `apps/web/app/notices` (the public-facing pages)
   are the remaining piece, once there's enough real volume across sources
   to make it worthwhile.
7. **Attachment URL extraction** for the generic listing schema, reusing the
   same "exclude file-extension/external links" logic already in
   `_pick_detail_anchor`, but capturing *both* the detail link and any
   attachment link per row instead of just one.
8. **Cross-instance run locking** (Redis or a DB row lock with a stale-run
   timeout) before this ever runs as more than one API replica — also needed
   for `scrape_progress` (see [§9](#9-known-limitations--future-work)) once
   the AI service itself is scaled beyond one process.
9. **Content-container quality**: extend `_CONTENT_SELECTORS` with more
   patterns as real-world sources reveal gaps, or add a lightweight
   "is this line boilerplate" filter (e.g. drop very short lines matching
   common chrome text like "Share", "Print", "A A A" font-size togglers)
   before storing `content_text`.
10. **"Load more"/infinite-scroll pagination support** — a fourth
    `ScrapePaginationType` (e.g. `JS_INTERACTION`) driving crawl4ai's
    `js_code`/`scan_full_page` options to click a "load more" button or
    scroll until no new rows appear, for sites with no URL-addressable pages.
11. **Progress-message quality**: currently every detail fetch logs its
    title; on a source with `maxPages` set high this can produce a long
    message list. Consider collapsing to periodic "N/M items fetched"
    summaries once a page's row count is known upfront, keeping per-item
    detail only for the most recent few.
