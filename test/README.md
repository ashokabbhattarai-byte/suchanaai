# Suchana AI — Multi-Agent Test Harness

**Location:** `apps/test/` — 13 parallel agents, functional + non-functional

## Quick Start

```bash
cd apps/test
node runner.mjs                  # all 13 agents in parallel (486ms wall time)
node runner.mjs --suite=functional   # 7 functional agents only
node runner.mjs --suite=nfunc        # 6 non-functional agents only
API_BASE=http://localhost:3001 WEB_BASE=http://localhost:3535 node runner.mjs  # with live servers
```

## Agents

| # | File | Suite | What it tests |
|---|------|-------|---------------|
|1| `functional/agent-func-api-health.mjs` | functional | Health, Helmet, CORS, compression, Swagger, Prisma |
|2| `functional/agent-func-auth-rbac.mjs` | functional | Google JWT, RBAC, guards, cookies, CSRF, revocation |
|3| `functional/agent-func-notices.mjs` | functional | Notices CRUD, search, ask, meta, S3, web pages |
|4| `functional/agent-func-alerts.mjs` | functional | Alerts rules, matching, WhatsApp, digest, dedup |
|5| `functional/agent-func-scraping.mjs` | functional | Sources, runs, items, scheduler, discovery, S3 |
|6| `functional/agent-func-documents-rag.mjs` | functional | Docs upload, RAG, embeddings, quotas, billing |
|7| `functional/agent-func-web-ui.mjs` | functional | Middleware, layouts, admin/dashboard routes, SEO |
|8| `non-functional/agent-nfunc-performance.mjs` | non-functional | Latency, compression, caching, concurrency |
|9| `non-functional/agent-nfunc-security.mjs` | non-functional | Helmet, CORS, JWT, CSRF, throttler, secrets |
|10| `non-functional/agent-nfunc-accessibility.mjs` | non-functional | ARIA, alt, Radix, focus, landmarks, lang |
|11| `non-functional/agent-nfunc-seo.mjs` | non-functional | Metadata, OG, sitemap, robots, structured data |
|12| `non-functional/agent-nfunc-reliability.mjs` | non-functional | Filters, logger, retries, timeouts, error boundaries |
|13| `non-functional/agent-nfunc-ux-quality.mjs` | non-functional | Design tokens, responsive, skeletons, toasts |

Each agent writes `reports/<suite>__<agent>.json`; `runner.mjs` aggregates into `TEST_RESULTS.md`.

## Latest Result (2026-09-09)

```
Agents: 13  Checks: 288  Pass: 239  Fail: 0  Skip: 49  PassRate: 83% (100% of executed)
Duration: 486ms wall (parallel child_process burst)
```

- **49 SKIPs** = live HTTP probes (API `http://localhost:3001`, WEB `http://localhost:3535` not running). Static code analysis still executed.
- Report: [`TEST_RESULTS.md`](./TEST_RESULTS.md) + [`../../TEST_RESULTS.md`](../../TEST_RESULTS.md)
- Per-agent JSON: `reports/*.json`

## Architecture

```
runner.mjs —> spawn 13× node child_process (Promise.all, no throttle)
            |—> each agent: static file checks + live fetch probes (graceful SKIP)
            └—> utils/report.mjs aggregates → TEST_RESULTS.md
```

Node ≥18 (native fetch), no external deps, zero install.
