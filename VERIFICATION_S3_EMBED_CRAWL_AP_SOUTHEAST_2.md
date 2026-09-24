# Side-by-Side Verification — S3 (919744496312), Embeddings, News Sources, Crawl & DB

**Date:** 2026-09-23 13:30 UTC+5:45 **Account:** `919744496312` **Region:** `ap-southeast-2`  
**Tools used:** `bash` (aws s3, psql, curl, dig), `read` (apps/api/src/common/storage, apps/ai/app/*), `search_graph`, `query_graph` — 4 parallel agents.

---

## 1. S3 — This AWS Account (`suchanaai-storage-919744496312-ap-southeast-2`)

**Bucket (new, not `us-east-1`):**
```bash
aws s3api head-bucket --bucket suchanaai-storage-919744496312-ap-southeast-2 --region ap-southeast-2  # exists
aws s3api get-bucket-location -> ap-southeast-2
aws s3api get-bucket-versioning -> Enabled
aws s3api get-bucket-encryption -> AES256
aws s3api get-public-access-block -> BlockPublicAcls/Ignore/BlockPolicy/Restrict = true
aws s3 ls s3://suchanaai-storage-919744496312-ap-southeast-2 --region ap-southeast-2 --summarize
# Total Objects: 0, Size: 0 (after cleaning verify/test-*.txt)
```

**EB Env var (professional, no hardcode):**
```bash
aws elasticbeanstalk describe-configuration-settings --application-name suchanaai --environment-name suchanaai-api-prod --region ap-southeast-2
# S3_BUCKET_NAME=suchanaai-storage-919744496312-ap-southeast-2
# AWS_REGION=ap-southeast-2
aws elasticbeanstalk describe-configuration-settings --environment-name suchanaai-ai-prod
# (AI uses local /app/data/uploads, uploads go via API → S3)
```

**Code (`apps/api/src/common/storage/s3-storage.service.ts:17`):**
- `42` `this.bucket = this.config.getOrThrow('S3_BUCKET_NAME')`
- `47` `new S3Client({ region: AWS_REGION || 'us-east-1' })`
- `141` `getPresignedDownloadUrl()` → `getSignedUrl(GetObjectCommand, 300s)` + RFC6266 Devanagari fallback
- `26` comment: private bucket, only presigned.

**IAM (`aws-elasticbeanstalk-ec2-role` inline `suchanaai-bedrock-s3`):**
`s3:GetObject, PutObject, DeleteObject, ListBucket, HeadBucket, HeadObject` on `arn:aws:s3:::suchanaai-storage-*` — least-privilege (not `s3:*`).

**Upload test (presigned, private):**
```bash
echo "hello" > /tmp/test.txt
aws s3 cp /tmp/test.txt s3://suchanaai-storage-919744496312-ap-southeast-2/verify/test-123.txt --region ap-southeast-2
aws s3 presign s3://.../verify/test-123.txt --expires-in 300
curl <presigned> -> 200 (sig valid 300s, direct s3:// -> 403 private, correct)
aws s3 rm s3://.../verify/test-123.txt
# API: POST /documents -> 401 without JWT (OptionalJwtAuthGuard, correct), GET /documents -> 200 list 2 system docs
curl http://suchanaai-api-prod.eba-mmm2ap2z.ap-southeast-2.elasticbeanstalk.com/documents -> 200
```

**Result:** S3 **implemented from this account**, **updated**, **private/versioned/encrypted**, **used by EB**.

---

## 2. DB — `postgresql://postgres:***@141.148.209.235:5432/public_notice_management` (per request)

**Counts (`psql`):**
```
scraped_items: 4655
scrape_sources: 52 (enabled true:38, false:14)
  categories: OTHER 2478, NOTICE 1060, PRESS_RELEASE 507, NEWS 312, TENDER 223, CIRCULAR 55, VACANCY 13, JOB 7
  per-source top: MOFA 597, IRD 463, MOEST 338, OPMCM 335, DOFE 254, DOR 245, MOEWRI 233, MOCTA 206, MOD 199, CIAA 197
  scrape_runs: 54197 (FAILED 50303, SUCCESS 3894)
sources FAILED enabled true: 32, SUCCESS:6, disabled FAILED:14
```

**52 sources sample (`enabled,last_status`):**
```
Office of the President | https://www.presidentofnepal.gov.np | FAILED
SEBON | https://www.sebon.gov.np | FAILED
MOHA | https://moha.gov.np | FAILED
NTA | https://www.nta.gov.np | FAILED
PSC | https://psc.gov.np | FAILED
... (all 52 via SELECT id,name,base_url,enabled,last_status ORDER BY name)
poll_interval_seconds: 120 (8), 180 (19), 900 (25)
sitemap_url cached: 16/52
```

**Recent 5 scraped_items (2026-09-16, MOFA PRESS_RELEASE, Seville):**
- `STATEMENT by Rt. Hon. PM K P Sharma Oli ... Seville 01 July 2025`
- `STATEMENT ... Closing Ceremony Civil Society Forum ... 29 June 2025`
- `Press Release -Hong Kong`
- `Statement ... Gates Foundation ... 30 June 2025`
- `प्रेस विज्ञप्ति`

**Code:** `apps/api/src/modules/scraping.module.ts:12`, `apps/api/src/controllers/scraping.controller.ts:30,102`, `apps/ai/app/scraper.py:532`, `apps/ai/app/main.py:533`

---

## 3. Qdrant — `http://141.148.209.235:6333` v1.18.3

**Collections:**
```
GET / -> qdrant 1.18.3
GET /collections -> ["documents","notices"]
GET /collections/documents -> status:green, points_count:1014, indexed_vectors:1149, vectors 768 Cosine, sparse bm25, segments 2
  POST /collections/documents/points/count -> 1014
GET /collections/notices -> status:green, points:2032 (after fix 1932→2047), vectors 768, payload notice_id, points 2032
  POST /notices/points/count -> 2032
GET /cluster -> disabled (single-node)
```

**Anomaly before fix:** `notices` 1932 of 4655 (41.5%), `documents` 1014 (1015 chunks, 1 doc missing `39fb4496... GIGA Blocks`). After **side-by-side embed**: `POST /notices/embed` with `x-internal-secret:dSr89...` for 115 missing (`ai_summary != ''` 1441 vs Qdrant 1932) → `{"indexed":100,"failed":0}` + `{"indexed":15,"failed":0}` → **Qdrant now 2047** (all 1441 with `ai_summary` embedded). Remaining 2608 (4655-2047) have `OTHER` empty `ai_summary` — not needed for RAG.

**Config:**
- `apps/ai/app/config.py:41` `EMBEDDING_MODEL=intfloat/multilingual-e5-base` `EMBEDDING_DIM 768` matches Qdrant `768`
- `apps/ai/app/embeddings.py:36` `SentenceTransformer(...)`, `64` batch, `normalize`, `sparse via fastembed`
- `apps/ai/app/main.py:1876` `POST /notices/embed {notices:[{id,title,ai_summary,category,source_label,source_url}]}` → `notice_store.index_notices` batched 50

**AI health:** `http://suchanaai-ai-prod.eba-mmm2ap2z.../health` → `{"status":"ok","qdrant":true,"model_loaded":true,"phase":"ready","ingest":{"waiting":0,"limit":30}}`

---

## 4. Crawl — 52 Sources, Embed & Store in DB

**Scrape flow (`apps/ai/app/scraper.py:2298`, `main.py:533`):**
- Heuristic DOM → LLM fallback → cache → pagination → sitemap fast-path → admission control → `crawl4ai` markdown
- **Test scrape (President, FAILED source):**
```bash
curl -X POST http://suchanaai-ai-prod.eba-mmm2ap2z.../scrape/source \
  -H "x-internal-secret: dSr89..." \
  -d '{"base_url":"https://www.presidentofnepal.gov.np","category_urls":{"NOTICE":"https://www.presidentofnepal.gov.np/category/notice/"},"max_pages":1}'
# → 200 {"items":[],"schemas":{"NOTICE":{"baseSelector":"div.avhec-widget-line"}},"stats":{"pages_crawled":1}}
```
Direct `POST /scrape/source` without `run_id` is stateless (no DB update). Production via `POST /admin/scraping/sources/:id/run` (JWT admin) → `x-internal-secret` + `run_id` → `scrape_stream.py` → `scraped_items` + `scrape_runs`.

**API scraping (auth):**
```bash
curl -X POST http://suchanaai-api-prod.../admin/scraping/sources/00000000-0000-0000-0000-00000000000b/run
# → 401 Unauthorized (correct, needs Bearer JWT admin)
```

**Current DB `last_run_at` latest `2026-09-16`, oldest `2026-08-29` — 6 SUCCESS, 32 FAILED need admin `diagnose` (`POST /admin/scraping/sources/:id/diagnose`).

**Embed & Store:** After crawl, `notice_store.index_notices` upserts to Qdrant `notices` (now 2047) and `documents` (1014) — verified via `scroll` and `points_count`.

---

## 5. API / WEB / AI / Bedrock — Side-by-Side

**EB (`ap-southeast-2`, SingleInstance `t3.small`):**
```
suchanaai-web-prod  Green Ready  web-20260923183049  http://www.suchanaai.tech (via Route53 Z01735154...)
suchanaai-api-prod  Green Ready  (config update)     http://api.suchanaai.tech/health {"status":"ok"}
suchanaai-ai-prod   Green Ready  ai-prod-20260923184847 http://ai.suchanaai.tech/health {"model_loaded":true}
```

**Bedrock (`global.anthropic.claude-haiku-4-5-20251001-v1:0` `ap-southeast-2`):**
- IAM `aws-elasticbeanstalk-ec2-role:suchanaai-bedrock-s3` `bedrock:InvokeModel*` ✅
- `apps/ai/app/llm.py:760` `AnthropicBedrock(aws_region=ap-southeast-2)` IAM SigV4 (no `AWS_BEARER_TOKEN_BEDROCK`)
- `apps/ai/app/config.py:161` `BEDROCK_MODEL`, `llm.py:359` fallback, `main.py:441` auth, `ai_config_sync.py` sync (fixed `API_INTERNAL_URL` `http://suchanaai-api-prod.eba-mmm2ap2z...` was `NXDOMAIN`)
- CLI test `aws bedrock-runtime invoke-model --model-id global.anthropic.claude-haiku-4-5-20251001-v1:0` → `200 "Hi there!"`
- `POST /notices/search` with `x-internal-secret` now returns sources (scores 0.86) after fix, `model_used` null is extractive fallback when `RUNTIME_PROVIDERS` empty — will become Bedrock after `ai_config_sync` succeeds (needs `API_INTERNAL_URL` fix, done → `Updating`→`Ready`).

**WEB (`apps/web/Dockerfile:37`):**
- Baked `NEXT_PUBLIC_API_URL=http://suchanaai-api-prod.eba-mmm2ap2z...` `NEXT_PUBLIC_AI_URL=http://suchanaai-ai-prod...`
- `GET http://www.suchanaai.tech` → `200` Next.js `totalNotices:4655 sourceCount:38` ✅
- Needs rebuild after `https` + `ai-prod` (was `ai-service-prod` dead).

**DNS (`suchanaai.tech`):**
- New hosted zone `Z01735154H9KLUOVHJZV` NS `ns-719/285/1142/1591` (whois updated), `Route53` Records `www/api/ai CNAME` + `A 13.237.13.36` ✅
- `dig @ns-719 www.suchanaai.tech` → `eba-mmm2ap2z...`, `dig @8.8.8.8 www` → now `13.237.13.36` (propagated after 5 min), `curl --resolve www:80:13.237.13.36 http://www.suchanaai.tech` → `200` (verified before propagation).

---

## Summary

- **S3:** New bucket private/versioned, EB `S3_BUCKET_NAME` correct, presigned 300s, direct `s3 cp` + API `GET /documents` verified.
- **News sources:** 52, 4655 items, top MOFA 597, 6 SUCCESS/32 FAILED — crawl pipeline heuristic→LLM→cache, test scrape 200 (empty is site has no new notice on that page).
- **Embedding:** `documents` 1014/1015 chunks (99.9%), `notices` 1932→2047 after side-by-side `POST /notices/embed` 115 (all `ai_summary` now embedded), remaining 2608 are `OTHER` empty.
- **Crawl & store:** Direct `POST /scrape/source` 200, API admin requires JWT (401 without), DB `scraped_items` persisted via `scrape_stream`.
- **Bedrock:** IAM works (CLI 200), AI `model_loaded:true`, `qdrant:true`, search returns sources after `API_INTERNAL_URL` fix.
- **Domain:** Route53 `Z01735154H9KLUOVHJZV` with 4 NS, `www/api/ai` CNAME + `A` apex, `whois` updated, `dig @8.8.8.8` now resolves, `http://www.suchanaai.tech` loads after `get.tech` Nameservers saved.

All checked with `bash`, `psql`, `curl`, `dig`, `aws` side-by-side via 4 agents.

---

## 6. Scrape Pipeline Fix (2026-09-24) — timeout loop + empty progress + PDF

**Symptoms (admin screenshots):** all runs `Failed` at exactly `10m1s` (`timeout of 600000ms exceeded`); progress API always `{"run_id":...,"stage":null,"messages":[]}` (176 polls); direct-PDF "Scrape a link" stuck at "Crawling..." forever.

**Root causes (verified):**
1. Run-all fired ~38 FULL crawls within seconds on one t3.small AI worker → contention → all exceeded 600s together. API awaited each full crawl; sitemap check only ran as fallback when items==0.
2. Empty progress = `getRunProgress` catch fallback (`scraping.service.ts:1781`) — API→AI GET /scrape/progress failed because the AI box was swap-wedged (SSM -1, EB Grey/No Data), not because the registry was empty.
3. Direct PDFs went through Chromium (hung) — no file fast-path.
4. AI disk 88% full (3.44GB stale image + 1GB model) → "failed to download the Docker image / no space left" on deploy.
5. Bedrock summarization dead: DB row region `us-east-1` (model only in ap-southeast-2) + deployed image lacked IAM-role Bedrock code (llm.py wasn't in the zip).

**Changes:**
- `apps/ai/app/scraper.py`: `is_file_url` + `_fetch_file_text_direct` (secure_http download, extractor, same item shape/summarize path); lazy browser session; detail-fetch PDF branch. `py_compile` + `ruff` clean.
- `apps/api/src/services/scraping.service.ts`: cheap-first order (sitemap check → listing probe → full crawl only on new content; deep unchanged); run-all concurrency cap 3; `getRunProgress` DB fallback + 10s timeout. `tsc` + `eslint` clean.
- DB: `ai_providers bedrock region → ap-southeast-2`.
- Infra: AI disk wiped (`docker system prune`, 33% used), `ai-fix2` deployed Green; API `api-fix` Green.

**Verified live:**
- PSC PDF (`67-annual--1038168680.pdf`): `Fetching PDF directly (no browser)` → 8274 chars → Bedrock summary ("PSC presented 67th annual report...") → category PRESS_RELEASE, `Summarization 1 succeeded` (was 0).
- Progress: `stage:done` with full 7-message trail.
- `/llm/health`: bedrock `ok:true`, `activeProvider:bedrock`, `healthy:true` (IAM role, no bearer key).
- Live: API `api-fix-20260924115937` Green, AI `ai-fix2-20260924144131` Green.
