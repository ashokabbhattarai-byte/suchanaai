import os
from pathlib import Path

from dotenv import load_dotenv

# override=True so the .env file is authoritative in dev even if a stale value
# was already present in the process environment (e.g. across uvicorn reloads).
load_dotenv(Path(__file__).resolve().parent.parent / ".env", override=True)


def _env(key: str, default: str = "") -> str:
    return os.environ.get(key, default)


def _env_int(key: str, default: int = 0) -> int:
    val = os.environ.get(key)
    if val is None:
        return default
    try:
        return int(str(val).strip())
    except (ValueError, TypeError, AttributeError):
        return default


def _env_float(key: str, default: float = 0.0) -> float:
    val = os.environ.get(key)
    if val is None:
        return default
    try:
        return float(str(val).strip())
    except (ValueError, TypeError, AttributeError):
        return default


PORT: int = _env_int("PORT", 8000)
ENVIRONMENT: str = _env("ENVIRONMENT", "development")
LOG_LEVEL: str = _env("LOG_LEVEL", "INFO")
# "json" (default) for one JSON record per line; "pretty" for human-readable dev output.
LOG_FORMAT: str = _env("LOG_FORMAT", "json")

EMBEDDING_MODEL: str = _env(
    "EMBEDDING_MODEL",
    "intfloat/multilingual-e5-base",
)
# Output dimension of EMBEDDING_MODEL. Must match the Qdrant collection's
# vector size. Change this if you switch to a model with a different dimension.
EMBEDDING_DIM: int = _env_int("EMBEDDING_DIM", 768)

# Hybrid retrieval: BM25 sparse vectors fused with dense vectors via RRF.
# Set HYBRID_SEARCH=false to fall back to dense-only search.
HYBRID_SEARCH: bool = _env("HYBRID_SEARCH", "true").lower() in ("1", "true", "yes")
SPARSE_MODEL: str = _env("SPARSE_MODEL", "Qdrant/bm25")

QDRANT_URL: str = _env("QDRANT_URL", "http://localhost:6333")
QDRANT_API_KEY: str = _env("QDRANT_API_KEY")
QDRANT_COLLECTION: str = _env("QDRANT_COLLECTION", "documents")

CHUNK_SIZE: int = _env_int("CHUNK_SIZE", 800)
CHUNK_OVERLAP: int = _env_int("CHUNK_OVERLAP", 120)

# Chunks embedded per model.encode() call; keeps memory bounded on large docs.
# 64 is the sweet spot for multilingual-e5-base on a 2-vCPU box: ~2× fewer
# Python loop iterations than 32, better CPU vectorization, still well under
# 500 MB per batch for the worst-case 800-char chunks. Large docs (300+ chunks)
# finish noticeably faster, small docs stay snappy, and progress callbacks still
# fire every ~0.6s so the bar moves smoothly.
EMBEDDING_BATCH_SIZE: int = _env_int("EMBEDDING_BATCH_SIZE", 64)

# Admin-managed override sync (see app/ai_config_sync.py) — polls apps/api's
# encrypted settings store for admin-configured keys/models, mutating the
# module attributes below in place. Leave INTERNAL_SERVICE_SECRET empty to
# disable the sync entirely and run purely off this file's static values.
API_INTERNAL_URL: str = _env("API_INTERNAL_URL", "http://localhost:5005")
INTERNAL_SERVICE_SECRET: str = _env("INTERNAL_SERVICE_SECRET")

# OpenRouter — first in the chain. It meters requests per day rather than
# tokens per day, so a long RAG context costs the same as a one-line question;
# Groq's 200k tokens/day cap is what this workload kept exhausting.
OPENROUTER_API_KEY: str = _env("OPENROUTER_API_KEY")
OPENROUTER_BASE_URL: str = _env("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1/chat/completions")
# PRIMARY: ultra-fast for "very very fast" requirement. liquid/lfm-2.5-2.6b:free
# is 2.6B — smallest free model, <600ms TTFB vs gemma 26B ~800-1500ms vs
# nemotron-lightning ~12924ms (screenshot). Use liquid as primary, gemma as
# powerful fallback for Devanagari-heavy queries. Live-verified 2026-09-08
# against api/v1/models (16 free). minimax/* retired 404, gemma-4-31b 429 pool,
# inkling/* 403 agentic — all excluded.
OPENROUTER_MODEL: str = _env("OPENROUTER_MODEL", "liquid/lfm-2.5-2.6b:free")

# Fallback chain after primary. ACCOUNT-SHARED free tier: 50/day (1000/day after
# $10 purchase, 20 RPM) — chain helps with per-model capacity/404, not daily
# quota (a 429 on one means all 429, then falls to Groq 0.3s). Ordered
# fastest→powerful→large-context: gemma 26B powerful multilingual (Devanagari)
# next after liquid, nano-omni 30B fast reasoning, super 120B powerful MoE,
# lightning 1M large-context backstop (slow, keep last). 5 total incl primary.
OPENROUTER_FREE_MODELS: list[str] = [
    m.strip() for m in _env(
        "OPENROUTER_FREE_MODELS",
        "google/gemma-4-26b-a4b-it:free,"
        "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free,"
        "nvidia/nemotron-3-super-120b-a12b:free,"
        "nvidia/nemotron-3.5-lightning:free",
    ).split(",")
    if m.strip()
]

GROQ_API_KEY: str = _env("GROQ_API_KEY")
GROQ_API_KEYS: list[str] = [k.strip() for k in _env("GROQ_API_KEYS", "").split(",") if k.strip()] or ([GROQ_API_KEY] if GROQ_API_KEY else [])
# llama-3.3-70b-versatile was retired from Groq's catalog (404 model_not_found).
# gpt-oss-120b is the closest replacement in scale/quality.
GROQ_MODEL: str = _env("GROQ_MODEL", "openai/gpt-oss-120b")

GEMINI_API_KEY: str = _env("GEMINI_API_KEY")
# gemini-2.0-flash was retired; Google's own 404 response names the successor.
GEMINI_MODEL: str = _env("GEMINI_MODEL", "gemini-3.6-flash")

# OpenCode Zen — free-tier OpenAI-compatible chat completions gateway. Third
# fallback tier, tried after Gemini and Groq both fail (e.g. Gemini's billing
# is exhausted, or Groq is rate-limited across all rotated keys).
OPENCODE_ZEN_API_KEY: str = _env("OPENCODE_ZEN_API_KEY")
OPENCODE_ZEN_BASE_URL: str = _env("OPENCODE_ZEN_BASE_URL", "https://opencode.ai/zen/v1/chat/completions")
OPENCODE_ZEN_MODEL: str = _env("OPENCODE_ZEN_MODEL", "deepseek-v4-flash-free")

# AWS Bedrock (Claude) — the paid backstop, tried last once every free tier
# above has refused, rate-limited, or run out of credit. Authenticates with a
# Bedrock bearer token (AWS_BEARER_TOKEN_BEDROCK) rather than SigV4 keys, so
# it fits the same single-secret shape as every other provider here.
# `global.` is the cross-region endpoint: best availability, and no regional
# pricing premium.
BEDROCK_API_KEY: str = _env("BEDROCK_API_KEY") or _env("AWS_BEARER_TOKEN_BEDROCK")
BEDROCK_REGION: str = _env("BEDROCK_REGION", "us-east-1")
# Sonnet 4.6 is NOT served by the Bedrock Messages endpoint (it 404s there);
# Sonnet 5 is the current Sonnet on that endpoint. IDs carry an `anthropic.`
# prefix and no `global.`/`us.` inference-profile prefix — those belong to the
# legacy InvokeModel API, not this one.
BEDROCK_MODEL: str = _env("BEDROCK_MODEL", "anthropic.claude-sonnet-5")

# NOTE: nothing reads this. Order comes from the registry's sort_order (or the
# order _env_fallback_providers builds when the sync is down), and disabling is
# the `enabled` flag — not omission from this list. Kept only so an existing
# LLM_PROVIDER_PRIORITY in a deployed env doesn't look like it was dropped.
LLM_PROVIDER_PRIORITY: list[str] = [
    p.strip()
    for p in _env(
        "LLM_PROVIDER_PRIORITY", "openrouter,gemini,groq,opencode,bedrock"
    ).split(",")
    if p.strip()
]

# Retrieval tuning: hits scoring below the threshold are dropped from context.
# E5-family models compress cosine similarity into ~0.7-0.9; observed in
# practice: irrelevant hits ~0.76-0.78, relevant ~0.82+.
RAG_SCORE_THRESHOLD: float = _env_float("RAG_SCORE_THRESHOLD", 0.78)

# Same idea for the notice chatbot, kept separate because its questions are
# often cross-lingual (English question, Nepali notice), which scores a little
# lower than same-language matches even when the notice is exactly right.
NOTICE_SCORE_THRESHOLD: float = _env_float("NOTICE_SCORE_THRESHOLD", 0.78)
# Hits more than this far below the best hit are dropped even if they clear the
# floor: once one notice clearly answers the question, the long tail behind it
# is what makes an answer drift off-topic.
NOTICE_SCORE_MARGIN: float = _env_float("NOTICE_SCORE_MARGIN", 0.06)

# ── Sampling temperature, per task ────────────────────────────────────────
# These are fallback defaults only: the admin panel's values arrive via
# ai_config_sync and overwrite them in place at runtime. Split by task because
# one global number cannot serve both a factual answer and a greeting.
#
# Extraction-style calls (classify_intent, notice analysis JSON, the scraper's
# schema detection) stay pinned at 0.0 in code and are intentionally not
# admin-tunable — sampling there yields malformed JSON and mis-categorised
# notices, which is a correctness bug, not a style preference.
TEMPERATURE_ANSWERS: float = _env_float("TEMPERATURE_ANSWERS", 0.4)
TEMPERATURE_SUMMARIES: float = _env_float("TEMPERATURE_SUMMARIES", 0.2)
TEMPERATURE_CONVERSATION: float = _env_float("TEMPERATURE_CONVERSATION", 0.9)

TESSERACT_LANG: str = _env("TESSERACT_LANG", "nep+eng")

# Process-wide cap on concurrent OCR jobs (Tesseract + page rendering), shared
# across every caller — document uploads AND scraping's per-notice PDF
# extraction. Each OCR job is already close to 100% CPU on its own; without
# this, concurrent scrape sources (each triggering their own OCR calls
# independently) stack multiple full-CPU Tesseract processes at once, which
# is what pegs/heats a dev machine and can look like a crash. Conservative
# default since the AI service usually runs on a small 2 vCPU box in prod.
OCR_MAX_CONCURRENCY: int = _env_int("OCR_MAX_CONCURRENCY", 1)

# Fallback default for max concurrent LLM summarization calls during a scrape
# run. The live value is the admin `scraping.summarizeConcurrency` setting,
# sent per-run by the API; this only applies when the API passes no value.
SUMMARIZE_CONCURRENCY: int = _env_int("SUMMARIZE_CONCURRENCY", 2)

# Hard ceiling on listing pages walked by a deep ("scrape every page") run.
# Deep runs deliberately ignore the source's own max_pages, so this is the
# only thing standing between a mis-detected pager and an unbounded crawl.
SCRAPE_DEEP_MAX_PAGES: int = _env_int("SCRAPE_DEEP_MAX_PAGES", 50)

# Process-wide cap on concurrent headless-browser crawl sessions. Every scrape
# used to launch its own Chromium; with the scheduler polling ~30 sources the
# constant launch/teardown churn exhausted the host's process table and every
# run died with "[Errno 11] Resource temporarily unavailable". Sessions now
# share one pooled browser and queue behind this semaphore.
SCRAPE_BROWSER_CONCURRENCY: int = _env_int("SCRAPE_BROWSER_CONCURRENCY", 2)

# Recycle the pooled browser after this many sessions so a slow Chromium leak
# can't grow unbounded in a long-lived process.
SCRAPE_BROWSER_MAX_SESSIONS: int = _env_int("SCRAPE_BROWSER_MAX_SESSIONS", 200)

UPLOAD_DIR: str = _env("UPLOAD_DIR", "./data/uploads")

# The live production domains are always allowed so a missing/stale
# CORS_ORIGINS in the deployed env can't break the browser app.
_PRODUCTION_ORIGINS = ["https://suchanaai.tech", "https://www.suchanaai.tech"]

CORS_ORIGINS: list[str] = list(
    dict.fromkeys(
        [
            o.strip()
            for o in _env(
                "CORS_ORIGINS", "http://localhost:3535,http://localhost:5005"
            ).split(",")
            if o.strip()
        ]
        + _PRODUCTION_ORIGINS
    )
)


def ensure_upload_dir() -> Path:
    path = Path(UPLOAD_DIR)
    path.mkdir(parents=True, exist_ok=True)
    return path
