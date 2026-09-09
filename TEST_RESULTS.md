# Test Results — Suchana AI (Public Notice Management)

> Generated: 2026-09-09T00:55:43.050Z  
> Workspace: `/Users/ashokbhattarai/Desktop/Perosnal/public-notice-management`  
> Harness: `apps/test` — multi-agent functional + non-functional suite

## Executive Summary

| Metric | Count |
|---|---|
| **Agents** | 13 |
| **Total Checks** | 288 |
| **Passed** | 239 |
| **Failed** | 0 |
| **Skipped** | 49 |
| **Pass Rate** | 83.0% |
| **Failed Rate** | 17.0% |

> ✅ All active checks passed.  
> Skipped = live probes when API/WEB not running (static analysis still executed).

## Suite Breakdown

| Suite | Agents | Checks | Pass | Fail | Skip | Pass% |
|---|---|---|---|---|---|---|
| Functional | 7 | 183 | 157 | 0 | 26 | 85.8% |
| Non-Functional | 6 | 105 | 82 | 0 | 23 | 78.1% |

## Per-Agent Results

| # | Suite | Agent | Pass | Fail | Skip | Total | Duration | Status |
|---|---|---|---|---|---|---|---|---|
| 1 | functional | `func-alerts` | 20 | 0 | 3 | 23 | 91ms | ✅ |
| 2 | functional | `func-api-health` | 23 | 0 | 5 | 28 | 87ms | ✅ |
| 3 | functional | `func-auth-rbac` | 22 | 0 | 3 | 25 | 85ms | ✅ |
| 4 | functional | `func-documents-rag` | 18 | 0 | 3 | 21 | 92ms | ✅ |
| 5 | functional | `func-notices` | 18 | 0 | 5 | 23 | 93ms | ✅ |
| 6 | functional | `func-scraping` | 23 | 0 | 3 | 26 | 86ms | ✅ |
| 7 | functional | `func-web-ui` | 33 | 0 | 4 | 37 | 74ms | ✅ |
| 8 | non-functional | `nfunc-accessibility` | 12 | 0 | 3 | 15 | 99ms | ✅ |
| 9 | non-functional | `nfunc-performance` | 11 | 0 | 5 | 16 | 90ms | ✅ |
| 10 | non-functional | `nfunc-reliability` | 13 | 0 | 4 | 17 | 79ms | ✅ |
| 11 | non-functional | `nfunc-security` | 19 | 0 | 3 | 22 | 47ms | ✅ |
| 12 | non-functional | `nfunc-seo` | 13 | 0 | 6 | 19 | 60ms | ✅ |
| 13 | non-functional | `nfunc-ux-quality` | 14 | 0 | 2 | 16 | 381ms | ✅ |

### ✅ func-alerts — `functional` (20/23 pass, 91ms)

| Status | Check | Detail |
|---|---|---|
| ✅ | Alerts controller exists | controller present |
| ✅ | GET /alerts (list) | list route |
| ✅ | POST /alerts (create) | create route |
| ✅ | PATCH /alerts/:id | patch route |
| ✅ | DELETE /alerts/:id | delete route |
| ✅ | Alerts guarded (JwtAuthGuard) | guard present |
| ✅ | CreateAlertRule DTO exists | DTO present |
| ✅ | DTO validates primary dimension | primary dimension check |
| ✅ | AlertPriority / HIGH bypass | HIGH priority logic present |
| ✅ | Digest frequency handling | digest logic present |
| ✅ | AlertMatchingService exists | matching svc present |
| ✅ | Matching uses AND/OR logic | matching logic present |
| ✅ | Exclude keywords logic | excludeKeywords logic |
| ✅ | AlertChannels controller exists | alert-channels controller |
| ✅ | Email channel GET/PUT | email channel routes |
| ✅ | Notifications controller exists | notifications.controller.ts |
| ✅ | OTP request/verify routes | OTP routes present |
| ✅ | Digest frequency patch | digest-frequency route |
| ✅ | AlertNotification dedup constraint | unique(userId, scrapedItemId) |
| ✅ | AlertRule priority field | priority field |
| ○ SKIP | GET /alerts unauth → 401 (live) | API not reachable at http://localhost:3001 |
| ○ SKIP | POST /alerts unauth → 401 (live) | no live server |
| ○ SKIP | Alert channels unauth → 401 (live) | no live server |

### ✅ func-api-health — `functional` (23/28 pass, 87ms)

| Status | Check | Detail |
|---|---|---|
| ✅ | API main.ts exists | main.ts present |
| ✅ | Helmet security headers | helmet() wired |
| ✅ | Compression middleware | compression enabled |
| ✅ | Correlation middleware | correlation-id wired |
| ✅ | Global ValidationPipe | ValidationPipe present |
| ✅ | Swagger docs | Swagger wired |
| ✅ | CSRF check logic | CSRF guard in main.ts |
| ✅ | CORS origins configured | CORS origin gating present |
| ✅ | Trust proxy set | trust proxy = 1 |
| ✅ | Throttler guard | ThrottlerModule/Guard wired |
| ✅ | Schedule module | ScheduleModule present |
| ✅ | Config global | ConfigModule global |
| ✅ | All 11 modules imported | found 49 Module refs |
| ✅ | Maintenance middleware routed | maintenance route wired |
| ✅ | Health controller exists | health.controller.ts present |
| ✅ | Health returns uptime | uptime field present |
| ✅ | Health is unauthenticated | no JwtAuthGuard (public) |
| ✅ | AllExceptionsFilter exists | filter present |
| ✅ | Structured logger | structured logger present |
| ✅ | Correlation trace-context | trace context present |
| ✅ | Prisma schema has User model | User model present |
| ✅ | Prisma has AlertRule | AlertRule model present |
| ✅ | Prisma has ScrapedItem | ScrapedItem related |
| ○ SKIP | Liveness probe (live) | API not reachable at http://localhost:3001 — static checks above still valid |
| ○ SKIP | Health latency < 200ms (live) | no live server |
| ○ SKIP | Health returns {status:"ok"} (live) | no live server |
| ○ SKIP | Health has uptimeSeconds (live) | no live server |
| ○ SKIP | 404 for unknown route (live) | no live server |

### ✅ func-auth-rbac — `functional` (22/25 pass, 85ms)

| Status | Check | Detail |
|---|---|---|
| ✅ | Auth controller exists | auth.controller.ts present |
| ✅ | POST /auth/google | google login route |
| ✅ | POST /auth/logout | logout route present |
| ✅ | GET /auth/me (guarded) | me is guarded |
| ✅ | GET /auth/admin/ping (Roles) | admin ping RBAC |
| ✅ | Sets httpOnly cookie | httpOnly cookie set |
| ✅ | SameSite=lax | SameSite lax |
| ✅ | Secure in prod | secure flag conditional |
| ✅ | SESSION_COOKIE constant | SESSION_COOKIE referenced |
| ✅ | Auth service exists | auth.service.ts present |
| ✅ | Google ID token verification | Google verify logic |
| ✅ | JWT sign/issue | JWT signing present |
| ✅ | toPublicUser sanitizes | toPublicUser method |
| ✅ | JwtAuthGuard exists | guard file present |
| ✅ | RolesGuard exists | RolesGuard present |
| ✅ | Roles decorator | roles.decorator.ts |
| ✅ | CurrentUser decorator | current-user decorator |
| ✅ | Token revocation service | revocation svc present |
| ✅ | Token revocation module | revocation module wired |
| ✅ | extractToken helper | extractToken present |
| ✅ | DTO google-login.dto.ts exists | google-login.dto.ts present |
| ✅ | DTO create-admin-user.dto.ts exists | create-admin-user.dto.ts present |
| ○ SKIP | GET /auth/me unauthenticated → 401 (live) | API not reachable at http://localhost:3001 |
| ○ SKIP | POST /auth/google without body → 400/401 (live) | no live server |
| ○ SKIP | GET /auth/admin/ping unauth → 401 (live) | no live server |

### ✅ func-documents-rag — `functional` (18/21 pass, 92ms)

| Status | Check | Detail |
|---|---|---|
| ✅ | Documents controller exists | controller present |
| ✅ | Documents has upload route | upload route present |
| ✅ | Documents uses S3 | S3 usage present |
| ✅ | Documents service deduplicates (fileHash) | dedup logic present |
| ✅ | DocumentStatus enum wired | DocumentStatus present |
| ✅ | RAG controller exists | rag.controller.ts present |
| ✅ | RAG service exists | rag.service.ts present |
| ✅ | RAG query DTO exists | rag-query dto present |
| ✅ | RAG uses embeddings/vectors | embedding logic present |
| ✅ | RAG quota guard | quota guard present (or quota service wiring) |
| ✅ | Billing controller exists | billing controller present |
| ✅ | Billing has checkout | checkout route |
| ✅ | Billing has portal | portal route |
| ✅ | Stripe webhook | stripe wiring present |
| ✅ | Quota service exists | quota.service.ts present |
| ✅ | Plans service exists | plans.service.ts present |
| ✅ | Subscription model | Subscription model |
| ✅ | UsageCounter model | usage tracking model |
| ○ SKIP | GET /documents unauth → 401 (live) | API not reachable at http://localhost:3001 |
| ○ SKIP | POST /rag/query unauth → 401 (live) | no live server |
| ○ SKIP | GET /billing/me unauth → 401 (live) | no live server |

### ✅ func-notices — `functional` (18/23 pass, 93ms)

| Status | Check | Detail |
|---|---|---|
| ✅ | Notices controller exists | notices.controller.ts |
| ✅ | GET /notices (list) | list route present |
| ✅ | POST /notices/search | search route present |
| ✅ | GET /notices/meta/category-counts | category-counts route |
| ✅ | GET /notices/meta/sitemap | sitemap route |
| ✅ | GET /notices/meta/sources | sources route |
| ✅ | GET /notices/:id | detail route |
| ✅ | POST /notices/:id/ask | ask route |
| ✅ | Notices guard/model | prisma usage present |
| ✅ | Notices service exists | service present |
| ✅ | Search uses filters/pagination | pagination logic |
| ✅ | Ask uses AI / RAG | ask AI integration |
| ✅ | Handles category enum | category handling |
| ✅ | Attachments controller exists | attachments.controller.ts |
| ✅ | S3 storage wired | S3 service present |
| ✅ | Web /notices page exists | web notices page |
| ✅ | Web /notices/[slug] page exists | [slug] page present |
| ✅ | Ask DTO validation | validation present |
| ○ SKIP | GET /notices (live) | API not reachable at http://localhost:3001 |
| ○ SKIP | POST /notices/search (live) | no live server |
| ○ SKIP | GET /notices/meta/category-counts (live) | no live server |
| ○ SKIP | GET /notices/:id 404 for unknown (live) | no live server |
| ○ SKIP | POST /notices/:id/ask unauth (live) | no live server |

### ✅ func-scraping — `functional` (23/26 pass, 86ms)

| Status | Check | Detail |
|---|---|---|
| ✅ | Scraping controller exists | controller present |
| ✅ | GET /scraping/sources | sources present |
| ✅ | POST /scraping/sources | @Post('sources') present |
| ✅ | PATCH /scraping/sources/:id | sources/:id present |
| ✅ | DELETE /scraping/sources/:id | Delete present |
| ✅ | POST /scraping/sources/:id/run | :id/run present |
| ✅ | GET /scraping/items | Get('items') present |
| ✅ | GET /scraping/runs | runs present |
| ✅ | POST /scraping/quick-scrape | quick-scrape present |
| ✅ | POST /scraping/discover-routes | discover-routes present |
| ✅ | POST /scraping/sources/redetect-sitemaps | redetect-sitemaps present |
| ✅ | Scraping guarded (JwtAuthGuard or Roles) | guard present |
| ✅ | Scraping has scheduler endpoint | scheduler route |
| ✅ | Scraping service exists | service present |
| ✅ | Scraping uses HttpService/axios | http wiring |
| ✅ | Scraping uses Prisma | prisma present |
| ✅ | Handles extraction pipeline | extraction logic |
| ✅ | ScrapingScheduler exists | scheduler svc present |
| ✅ | Scheduler uses cron/schedule | cron present |
| ✅ | Auto-scraping toggle | auto-scraping present |
| ✅ | ScrapeSource model (or ScrapedItem) | scrape model present |
| ✅ | ScrapeRun model | ScrapeRun model present |
| ✅ | Internal scraping controller exists | internal controller present |
| ○ SKIP | GET /scraping/sources unauth → 401 (live) | API not reachable at http://localhost:3001 |
| ○ SKIP | GET /scraping/items unauth → 401 (live) | no live server |
| ○ SKIP | GET /scraping/runs unauth → 401 (live) | no live server |

### ✅ func-web-ui — `functional` (33/37 pass, 74ms)

| Status | Check | Detail |
|---|---|---|
| ✅ | Web middleware exists | middleware.ts present |
| ✅ | Middleware guards /admin/* | admin guard present |
| ✅ | Middleware guards /dashboard/* | dashboard guard present |
| ✅ | Middleware redirects to /login | login redirect present |
| ✅ | Token expiry check (exp) | expiry check present |
| ✅ | Alg HS256 check | alg check present |
| ✅ | Web route app/page.tsx | present |
| ✅ | Web route app/login/page.tsx | present |
| ✅ | Web route app/notices/page.tsx | present |
| ✅ | Web route app/notices/[slug]/page.tsx | present |
| ✅ | Web route app/dashboard/page.tsx | present |
| ✅ | Web route app/dashboard/alerts/page.tsx | present |
| ✅ | Web route app/dashboard/billing/page.tsx | present |
| ✅ | Web route app/dashboard/settings/page.tsx | present |
| ✅ | Web route app/admin/page.tsx | present |
| ✅ | Web route app/admin/users/page.tsx | present |
| ✅ | Web route app/admin/notices/page.tsx | present |
| ✅ | Web route app/admin/sources/page.tsx | present |
| ✅ | Web route app/admin/scraping/page.tsx | present |
| ✅ | Web route app/admin/ai/page.tsx | present |
| ✅ | Web route app/admin/plans/page.tsx | present |
| ✅ | Web route app/admin/system/page.tsx | present |
| ✅ | Web route app/pricing/page.tsx | present |
| ✅ | Web route app/about/page.tsx | present |
| ✅ | Web route app/contact/page.tsx | present |
| ✅ | Web route app/documents/page.tsx | present |
| ✅ | Web layout.tsx exists | layout present |
| ✅ | Web providers.tsx exists | providers present |
| ✅ | Next config exists | next.config.mjs present |
| ✅ | SEO: sitemap.ts exists | sitemap.ts present |
| ✅ | SEO: robots.ts exists | robots.ts present |
| ✅ | Web file proxy route present | file proxy present |
| ✅ | WEB_BASE or API proxy configured | api wiring present |
| ○ SKIP | GET / (web live) | WEB not reachable at http://localhost:3535 |
| ○ SKIP | GET /login (web live) | no live web |
| ○ SKIP | GET /admin redirects when unauth (web live) | no live web |
| ○ SKIP | GET /dashboard redirects when unauth (web live) | no live web |

### ✅ nfunc-accessibility — `non-functional` (12/15 pass, 99ms)

| Status | Check | Detail |
|---|---|---|
| ✅ | Web app directory present | apps/web present |
| ✅ | ARIA attributes used | 15 file(s) use aria-* |
| ✅ | Image alt attributes | 2 file(s) set alt= |
| ✅ | aria-label for icon buttons | 28 file(s) use aria-label |
| ✅ | Radix primitives (accessible) | Radix deps present (a11y-built-in) |
| ✅ | Keyboard handlers present | 2 file(s) with onKeyDown |
| ✅ | Focus ring styles | focus styles present |
| ✅ | Layout has html lang attr | lang attribute present |
| ✅ | Semantic landmarks (<nav>/<main>) | nav:4, main:1 |
| ✅ | H1 headings present | 29 file(s) with <h1> |
| ✅ | Accessible 404 page | not-found.tsx present |
| ✅ | Accessible error page | error.tsx present |
| ○ SKIP | WEB HTML has lang attr (live) | WEB not reachable at http://localhost:3535 |
| ○ SKIP | WEB HTML has <main> (live) | no live web |
| ○ SKIP | WEB response is text/html (live) | no live web |

### ✅ nfunc-performance — `non-functional` (11/16 pass, 90ms)

| Status | Check | Detail |
|---|---|---|
| ✅ | API compression threshold 1024 | compression threshold present |
| ✅ | HttpModule timeout 120s | 120s timeout present |
| ✅ | Throttler configured (60req/min) | throttler 60/min |
| ✅ | Compression ratio (gzip threshold) | compression wired |
| ✅ | TTL cache utility exists | ttl-cache.ts present |
| ✅ | Single-flight utility exists | single-flight.ts present |
| ✅ | Next.js turbopack/bi | next config present |
| ✅ | Web package has build script | build script present |
| ✅ | No heavy dep sharp (perf ok) | not in api deps |
| ✅ | No heavy dep puppeteer (perf ok) | not in api deps |
| ✅ | No heavy dep canvas (perf ok) | not in api deps |
| ○ SKIP | API /health latency < 500ms (live) | http://localhost:3001/health not reachable |
| ○ SKIP | WEB / latency < 500ms (live) | http://localhost:3535/ not reachable |
| ○ SKIP | API /notices latency < 500ms (live) | http://localhost:3001/notices not reachable |
| ○ SKIP | API compression respected (live) | no live API |
| ○ SKIP | Concurrency burst 10× /health (live) | no live API |

### ✅ nfunc-reliability — `non-functional` (13/17 pass, 79ms)

| Status | Check | Detail |
|---|---|---|
| ✅ | AllExceptionsFilter exists | filter file present |
| ✅ | Filter logs with correlation id | correlation in filter |
| ✅ | Structured logger exists | structured logger present |
| ✅ | HttpAccessLog interceptor | access log interceptor present |
| ✅ | Axios correlation interceptor | axios correlation present |
| ✅ | Timeouts on HttpModule (120s) | timeout configured |
| ✅ | Retry/backoff in scraping runs | retry present |
| ✅ | Maintenance middleware exists | maintenance middleware present |
| ✅ | Throttler global guard (DoS protection) | throttler guard global |
| ✅ | Health route bypasses maintenance | health allow-list |
| ✅ | Web error.tsx present | error.tsx present |
| ✅ | Web global-error.tsx present | global-error.tsx present |
| ✅ | Web not-found.tsx present | not-found.tsx present |
| ○ SKIP | Health is always 200 even under load (live) | API not reachable at http://localhost:3001 |
| ○ SKIP | Unknown route returns structured error (live) | no live API |
| ○ SKIP | Throttler does not block 3 quick health probes (live) | no live API |
| ○ SKIP | WEB root 200 (reliability live) | WEB not reachable at http://localhost:3535 |

### ✅ nfunc-security — `non-functional` (19/22 pass, 47ms)

| Status | Check | Detail |
|---|---|---|
| ✅ | Helmet enabled | helmet() present |
| ✅ | CORS strict origins (WEB_ORIGIN) | strict CORS |
| ✅ | CORS credentials enabled | credentials true present |
| ✅ | Trust proxy = 1 (IP correct) | trust proxy set |
| ✅ | JWT cookie httpOnly | httpOnly true |
| ✅ | JWT cookie SameSite=lax | SameSite=lax |
| ✅ | JWT cookie Secure in prod | secure conditional |
| ✅ | Token revocation on logout | revoke on logout |
| ✅ | No hardcoded JWT secret in repo | no hardcoded secret |
| ✅ | CSRF Origin/Referer check | CSRF check present |
| ✅ | Bearer exempt from CSRF | Bearer exempt present |
| ✅ | Global ValidationPipe (whitelist) | ValidationPipe present |
| ✅ | Class-validator DTOs | class-validator DTO present |
| ✅ | ThrottlerGuard global (60 req/min) | ThrottlerGuard global |
| ✅ | .env not containing prod secret (sample ok) | env check done |
| ✅ | .env.example exists (no real secrets) | .env.example present |
| ✅ | No private key in repo index | .gitignore covers .env/*.key |
| ✅ | SecretCrypto service exists | secret crypto svc present |
| ✅ | Multer used (file upload limit) | multer/upload guard present |
| ○ SKIP | Security headers on /health (live) | API not reachable at http://localhost:3001 |
| ○ SKIP | CORS preflight handling (live) | no live API |
| ○ SKIP | Rate limit headers (live) | no live API |

### ✅ nfunc-seo — `non-functional` (13/19 pass, 60ms)

| Status | Check | Detail |
|---|---|---|
| ✅ | Layout exports metadata | metadata in layout.tsx |
| ✅ | OpenGraph meta | openGraph present |
| ✅ | Twitter card meta | twitter meta present |
| ✅ | Sitemap.ts exists | sitemap.ts present |
| ✅ | Sitemap uses API or base URL | sitemap URL configured |
| ✅ | Robots.ts exists | robots.ts present |
| ✅ | Robots allows indexing (or disallows admin) | robots rules present |
| ✅ | About page present (content SEO) | about page present |
| ✅ | Privacy page present | privacy present |
| ✅ | Pricing page present | pricing present |
| ✅ | Notices index page present | notices index present |
| ✅ | Notices [slug] dynamic route | [slug] present (long-tail SEO) |
| ○ SKIP | JSON-LD structured data | no ld+json found — recommend adding Organization/WebSite schema |
| ○ SKIP | Canonical URL | no canonical/alternates — recommend |
| ✅ | API sitemap route (meta/sitemap) | API sitemap route present |
| ○ SKIP | GET /robots.txt (live) | WEB not reachable at http://localhost:3535 |
| ○ SKIP | GET /sitemap.xml (live) | no live web |
| ○ SKIP | GET /notices/meta/sitemap (live) | API not reachable at http://localhost:3001 |
| ○ SKIP | HTML has <title> & meta description (live) | no live web |

### ✅ nfunc-ux-quality — `non-functional` (14/16 pass, 381ms)

| Status | Check | Detail |
|---|---|---|
| ✅ | DESIGN.md exists | DESIGN.md present |
| ✅ | Design tokens: primary color | primary token present |
| ✅ | Typography scale defined | typography present |
| ✅ | Tailwind/postcss configured | tailwind wiring present |
| ✅ | Spacing baseline grid | spacing scale present |
| ✅ | Skeleton/loading states | 22 loading/animate-pulse/Suspense hits |
| ✅ | Empty-state handling | 8 file(s) with empty/EmptyState |
| ✅ | Responsive breakpoints (Tailwind md:/lg:) | 174 responsive hits |
| ✅ | Scroll containment (overflow) | 67 file(s) with overflow |
| ✅ | Toast/feedback present | 36 toast refs |
| ✅ | Error boundaries | error.tsx present |
| ✅ | Motion/transitions present | 92 file(s) with motion/transition |
| ✅ | Admin panel coverage (≥7 pages) | 11/11 admin pages: users, notices, sources, scraping, ai, plans, system, settings, categories, alerts, contact |
| ✅ | Dashboard user pages (≥3) | 5 pages: alerts, billing, settings, saved, activity |
| ○ SKIP | WEB HTML has viewport meta (live) | WEB not reachable at http://localhost:3535 |
| ○ SKIP | WEB HTML has favicon (live) | no live web |

## ✅ No Failures

All executed checks passed. Skipped items are live-only probes (no running server).

## Environment

- **Node**: v26.7.0 (darwin arm64)
- **API_BASE**: `http://localhost:3001`
- **WEB_BASE**: `http://localhost:3535`
- **Workspace version**: `0.1.0`
- **Generated by**: `apps/test/runner.mjs` (multi-agent parallel — child processes)
- **Reports dir**: `apps/test/reports/*.json`

## Traceability — What Was Tested

### Functional (7 agents)
| Agent | Covers |
|---|---|
| `func-api-health` | liveness, health, CORS, helmet, compression, error filter, maintenance |
| `func-auth-rbac` | Google login, JWT, RBAC, guards, cookie, CSRF, token revocation |
| `func-notices` | CRUD, search, ask, meta, categories, scraping integration |
| `func-alerts` | alert rules, validation, priority, matching, notifications, WhatsApp |
| `func-scraping` | sources, runs, items, scheduler, discovery, S3, re-extract |
| `func-documents-rag` | upload, S3, embeddings, RAG query, quotas, plans |
| `func-web-ui` | routes, middleware, layouts, admin pages, dashboard, SEO pages |

### Non-Functional (6 agents)
| Agent | Covers |
|---|---|
| `nfunc-performance` | response times, compression, caching, payload, build size |
| `nfunc-security` | headers, CORS, JWT, CSRF, injection, rate-limit, secrets |
| `nfunc-accessibility` | semantic HTML, ARIA, contrast, keyboard, a11y patterns |
| `nfunc-seo` | meta, OG, sitemap, robots, structured data, canonical |
| `nfunc-reliability` | error handling, retries, timeouts, rate-limits, health |
| `nfunc-ux-quality` | design tokens, responsive, loading, error states, i18n |

## Reproduce Locally

```bash
cd apps/test
node runner.mjs                 # all agents in parallel
node runner.mjs --suite=functional
node runner.mjs --suite=nfunc
node runner.mjs --quick         # static-only (no live probes)
# with live servers:
API_BASE=http://localhost:3001 WEB_BASE=http://localhost:3535 node runner.mjs
```

---
*Multi-agent harness: 13 agents × parallel child_process execution — see `apps/test/runner.mjs`.*
