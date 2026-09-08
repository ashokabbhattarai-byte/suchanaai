import asyncio
import hashlib
import hmac
import json
import re
import time
from pathlib import Path
from typing import Optional
from urllib.parse import unquote, urlparse

from app import ai_config_sync
from app import browser_pool
from app import chunker
from app import config
from app import embeddings
from app import extractor
from app import llm
from app import notice_rag
from app import notice_store
from app import progress
from app import rag
from app import route_discovery
from app import scraper
from app import scrape_diagnosis
from app import scrape_progress
from app import scrape_stream
from app import secure_http
from app import store
from app.metrics import metrics  # the registry instance, not the module
from app.logger import get_logger, get_request_id, set_request_id, setup_logging

logger = get_logger(__name__)

# Hard ceiling on how long any single request may run. The NestJS caller
# already times out its AI-proxy calls at 30-90s per endpoint (see
# rag.service.ts / notices.service.ts) — this stays comfortably above the
# longest of those so a slow-but-alive request still finishes there first,
# while still guaranteeing this process always replies instead of hanging a
# connection (and the worker) forever on a stuck downstream call.
REQUEST_TIMEOUT_SECONDS = 100

# ...but the scrape endpoints are not request/response calls in that sense:
# one `/scrape/source` crawls up to `max_pages` listing pages, then fetches
# and LLM-summarizes every new item behind them. That is minutes of work by
# design, and NestJS budgets 600s for it (scraping.service.ts). Holding those
# routes to the generic 100s ceiling meant every source with real content was
# killed mid-run and reported as "Request failed with status code 504" — only
# sources that happened to find nothing ever "succeeded". These budgets stay
# just under the caller's so the timeout still surfaces here, with this
# service's own error message, rather than as an opaque socket hang-up.
ROUTE_TIMEOUT_SECONDS = {
    "/scrape/source": 570,
    "/scrape/sitemap/detect": 120,
    "/scrape/check": 120,
    "/scrape/listing/check": 120,
    # Discovery verifies each candidate route by crawling it, so its budget
    # scales with how many candidates it is allowed to check.
    "/scrape/discover": 480,
    "/scrape/diagnose": 540,
}

# A deep ("every page") crawl walks a whole archive rather than the newest 3
# pages, so it needs a budget in the tens of minutes, not the single-digit
# ones. Signalled by a header because the timeout is applied before the body
# is read. Stays just under the API's own deep-run axios timeout.
DEEP_SCRAPE_TIMEOUT_SECONDS = 3300


def _timeout_for(path: str, scope: dict | None = None) -> int:
    if path == "/scrape/source" and scope is not None:
        if _get_header(scope, b"x-scrape-deep") == b"1":
            return DEEP_SCRAPE_TIMEOUT_SECONDS
    return ROUTE_TIMEOUT_SECONDS.get(path, REQUEST_TIMEOUT_SECONDS)


async def app(scope, receive, send):
    if scope["type"] == "lifespan":
        await _handle_lifespan(scope, receive, send)
        return

    if scope["type"] != "http":
        return

    method = scope["method"]
    path = scope["path"]

    # Correlate this request with the caller's trace (x-request-id header, if
    # present — the NestJS API forwards it via its AI service client).
    raw_request_id = _get_header(scope, b"x-request-id")
    set_request_id(raw_request_id.decode("utf-8", errors="replace") if raw_request_id else None)

    if method == "OPTIONS":
        await _cors_preflight(send, scope)
        return

    # SSE streams are long-lived by design (they hold the connection open
    # until the tracked job finishes) — a blanket request timeout would kill
    # them mid-stream, so only bound the request/response endpoints below.
    is_sse = path.endswith("/progress/stream")

    timeout_seconds = _timeout_for(path, scope)

    start = time.perf_counter()
    try:
        route_call = _route(method, path, scope, receive, send)
        response = await route_call if is_sse else await asyncio.wait_for(
            route_call, timeout=timeout_seconds
        )
    except asyncio.TimeoutError:
        logger.error("Request timed out on %s %s after %ss", method, path, timeout_seconds)
        response = (504, {"error": f"Request timed out after {timeout_seconds}s"})
    except ValueError as e:
        # Bounded body / validation errors that should not be 500
        if "too large" in str(e).lower():
            logger.warning("Request too large on %s %s: %s", method, path, e)
            response = (413, {"error": str(e)})
        else:
            logger.warning("Bad request on %s %s: %s", method, path, e)
            response = (400, {"error": str(e)})
    except Exception as e:
        logger.exception("Unhandled error on %s %s", method, path)
        response = (500, {"error": "Internal server error", "detail": str(e)})

    # SSE routes (_document_progress_sse) stream their own ASGI response
    # directly over `send` and return None — there's no separate status/body
    # left to send afterward.
    if response is None:
        return

    status, body = response
    # Every endpoint builds its own error body ad hoc — stamp the request id
    # on the way out instead of touching every handler, so any 4xx/5xx from
    # this service can be correlated with the matching NestJS/web log lines.
    if status >= 400 and isinstance(body, dict) and "request_id" not in body:
        body = {**body, "request_id": get_request_id() or "-"}
    elapsed_ms = (time.perf_counter() - start) * 1000
    logger.info(
        "%s %s -> %d (%.0fms)",
        method,
        path,
        status,
        elapsed_ms,
        extra={"meta": {"status": status, "duration_ms": round(elapsed_ms, 1)}},
    )
    await _send_json(send, body, status, scope)


# Warmup state, surfaced by /health. The embedding model is downloaded and
# loaded off the event loop *after* the port is bound, so operators can tell
# "still warming" apart from "broken" instead of getting connection refused.
_warmup_state: dict = {"phase": "pending", "error": None}


async def _run_startup_validation() -> None:
    """Run critical startup validations. Raises RuntimeError on critical failures."""
    logger.info("Running startup validations...")

    # 0. Validate internal secret in production (fail-closed auth)
    if not config.INTERNAL_SERVICE_SECRET and config.ENVIRONMENT == "production":
        msg = "INTERNAL_SERVICE_SECRET is empty in production — all internal endpoints will reject requests (fail-closed)"
        logger.critical(msg)
        _warmup_state["error"] = msg
        _warmup_state["phase"] = "degraded"

    # 1. Validate embedding model dimension matches config
    try:
        # First call downloads ~1 GB from HuggingFace and is fully blocking;
        # keep it off the event loop so the server keeps serving /health.
        model = await asyncio.to_thread(embeddings._load_model)
        get_dim = getattr(model, "get_embedding_dimension", None) or model.get_sentence_embedding_dimension
        actual_dim = get_dim()
        if actual_dim != config.EMBEDDING_DIM:
            raise RuntimeError(
                f"EMBEDDING_DIM={config.EMBEDDING_DIM} does not match model dimension {actual_dim}. "
                f"Update EMBEDDING_DIM in .env and recreate the Qdrant collection."
            )
        logger.info("Embedding model validated: %s (dim=%d)", config.EMBEDDING_MODEL, actual_dim)
    except RuntimeError:
        raise
    except Exception as e:
        raise RuntimeError(f"Failed to load embedding model: {e}") from e

    # 2. Validate BM25 sparse model availability (if HYBRID_SEARCH enabled)
    if config.HYBRID_SEARCH:
        try:
            sparse_model = await asyncio.to_thread(embeddings._load_sparse_model)
            if sparse_model is None:
                logger.warning("HYBRID_SEARCH=true but sparse model unavailable; falling back to dense-only")
            else:
                logger.info("BM25 sparse model loaded: %s", config.SPARSE_MODEL)
        except Exception as e:
            logger.warning("Sparse model load failed (hybrid search disabled): %s", e)

    # 3. Validate Qdrant collection schema matches config
    try:
        await asyncio.to_thread(_validate_qdrant_collection_schema)
        logger.info("Qdrant collection schema validated")
    except RuntimeError:
        raise
    except Exception as e:
        raise RuntimeError(f"Qdrant schema validation failed: {e}") from e

    # 4. Validate LLM model availability (best-effort)
    try:
        if config.GROQ_API_KEYS or config.GROQ_API_KEY:
            logger.info("Groq API keys configured: %d key(s)", len(config.GROQ_API_KEYS) or 1)
        if config.GEMINI_API_KEY:
            logger.info("Gemini API key configured")
        if not (config.GROQ_API_KEYS or config.GROQ_API_KEY or config.GEMINI_API_KEY):
            logger.warning("No LLM API keys configured — summarization/analysis will use extractive fallback")
    except Exception as e:
        logger.warning("LLM config check failed: %s", e)

    logger.info("All startup validations passed")


def _validate_qdrant_collection_schema() -> None:
    """Validate that the Qdrant collection schema matches current config.

    Synchronous: the qdrant-client calls below block, so callers run this via
    asyncio.to_thread rather than on the event loop.
    """
    from app import store

    client = store.get_client()
    try:
        collections = client.get_collections().collections
        names = [c.name for c in collections]

        if config.QDRANT_COLLECTION not in names:
            logger.info("Qdrant collection '%s' does not exist yet; will be created on first indexing", config.QDRANT_COLLECTION)
            return

        info = client.get_collection(config.QDRANT_COLLECTION)
        dense = info.config.params.vectors
        if not isinstance(dense, dict) or store.DENSE_VECTOR not in dense:
            raise RuntimeError(
                f"Collection '{config.QDRANT_COLLECTION}' uses an unnamed/legacy vector schema"
            )
        if dense[store.DENSE_VECTOR].size != config.EMBEDDING_DIM:
            raise RuntimeError(
                f"Collection '{config.QDRANT_COLLECTION}' has dense dim={dense[store.DENSE_VECTOR].size} "
                f"but EMBEDDING_DIM={config.EMBEDDING_DIM}. "
                f"Recreate the collection or update EMBEDDING_DIM."
            )

        sparse = info.config.params.sparse_vectors or {}
        if config.HYBRID_SEARCH and store.SPARSE_VECTOR not in sparse:
            logger.warning(
                "Collection '%s' has no '%s' sparse vector required for hybrid search",
                config.QDRANT_COLLECTION,
                store.SPARSE_VECTOR,
            )
            # Not a hard failure — hybrid search will fall back to dense-only

        logger.debug("Qdrant collection '%s' schema OK", config.QDRANT_COLLECTION)

    except RuntimeError:
        raise
    except Exception as e:
        raise RuntimeError(f"Qdrant collection validation failed: {e}") from e


async def _warmup() -> None:
    """Run startup validation in the background, after the port is listening."""
    _warmup_state["phase"] = "warming"
    t0 = time.perf_counter()
    try:
        await _run_startup_validation()
        # Preserve INTERNAL_SERVICE_SECRET empty warning in production even if other checks pass
        if _warmup_state.get("error") and "INTERNAL_SERVICE_SECRET" in str(_warmup_state["error"]):
            _warmup_state["phase"] = "degraded"
            logger.critical("Startup validation: %s", _warmup_state["error"])
        else:
            _warmup_state["phase"] = "ready"
            _warmup_state["error"] = None
        logger.info("Warmup complete (%.1fs)", time.perf_counter() - t0)
    except RuntimeError as e:
        _warmup_state["phase"] = "degraded"
        _warmup_state["error"] = str(e)
        logger.critical("Startup validation failed: %s", e)
        # Don't crash — the health endpoint reports degraded instead,
        # but log prominently so operators see it.
        logger.error("SERVICE DEGRADED: %s", e)
    except Exception as e:  # never let the background task die silently
        _warmup_state["phase"] = "degraded"
        _warmup_state["error"] = str(e)
        logger.exception("Warmup crashed: %s", e)


async def _handle_lifespan(scope, receive, send):
    warmup_task: Optional[asyncio.Task] = None
    ai_config_task: Optional[asyncio.Task] = None
    while True:
        message = await receive()
        if message["type"] == "lifespan.startup":
            setup_logging()
            logger.info(
                "Starting pnm-ai (env=%s, qdrant=%s, collection=%s)",
                config.ENVIRONMENT,
                config.QDRANT_URL,
                config.QDRANT_COLLECTION,
            )
            config.ensure_upload_dir()

            # Validation (notably the ~1 GB embedding-model download) runs in
            # the background: uvicorn only binds the socket once we ack the
            # startup message, so doing it here means minutes of "connection
            # refused" on a cold model cache.
            warmup_task = asyncio.create_task(_warmup())

            # Picks up admin-configured LLM keys/models from apps/api on a
            # timer (see ai_config_sync.py); a no-op loop if the shared
            # secret isn't configured, so this is always safe to start.
            ai_config_task = asyncio.create_task(ai_config_sync.sync_loop())

            await send({"type": "lifespan.startup.complete"})
        elif message["type"] == "lifespan.shutdown":
            logger.info("Shutting down pnm-ai")
            if warmup_task and not warmup_task.done():
                warmup_task.cancel()
            if ai_config_task and not ai_config_task.done():
                ai_config_task.cancel()
            await browser_pool.shutdown()
            await send({"type": "lifespan.shutdown.complete"})
            return


# Reachable without the shared secret. `/` and `/health` are what the load
# balancer polls, and neither reveals anything or spends an LLM call.
_PUBLIC_PATHS = frozenset({"/", "/health"})


def _is_authorised(scope: dict) -> bool:
    """Every endpoint that can spend LLM quota or read the corpus requires the
    shared secret.

    This service used to answer anyone: port 80 was open to 0.0.0.0/0 and no
    endpoint checked a credential, so a stranger could drain the daily token
    budget through /notices/search. The secret is already shared with apps/api
    for the config-sync call in the other direction.
    """
    expected = config.INTERNAL_SERVICE_SECRET
    if not expected:
        # Fail closed in production, open only in dev
        return config.ENVIRONMENT != "production"
    for name, value in scope.get("headers", []):
        if name == b"x-internal-secret":
            return hmac.compare_digest(value.decode("utf-8", "replace"), expected)
    return False


async def _route(method: str, path: str, scope: dict, receive, send) -> tuple[int, dict] | None:
    if method == "GET" and path == "/":
        return 200, {"service": "pnm-ai", "status": "running", "version": "1.0.0"}

    if method == "GET" and path == "/health":
        return await _health()

    if path not in _PUBLIC_PATHS and not _is_authorised(scope):
        return 401, {"error": "Unauthorized — this service requires the internal service secret."}

    if method == "POST" and path == "/llm/providers/refresh":
        # Pull the provider registry immediately instead of waiting out the
        # background interval. apps/api calls this after any provider edit so
        # a newly saved key is live for real LLM calls, not just for the next
        # health probe.
        applied = await ai_config_sync.refresh_once()
        return 200, {
            "refreshed": applied,
            # Without a reason a failed sync is invisible: the service quietly
            # keeps using env-var providers while the admin panel lists the
            # database ones, and the two disagree with nothing to explain it.
            "error": None if applied else ai_config_sync.last_sync_error(),
            "providers": len(llm.all_providers()),
        }

    if path == "/llm/health" and method in ("GET", "POST"):
        # Live provider probe for the admin "AI & Models" panel. Makes a real
        # (tiny) call, so it is deliberately NOT part of /health, which load
        # balancers poll frequently. POST {"slug": "..."} probes exactly one
        # provider — the per-card "Test" button.
        slug = None
        if method == "POST":
            body = await _read_body(receive)
            try:
                slug = (json.loads(body) if body else {}).get("slug")
            except json.JSONDecodeError:
                return 400, {"error": "Invalid JSON body"}
        # Pull the registry before probing. The background sync only runs
        # every few minutes, so without this an admin who saves a key and
        # immediately hits "Test" is probing the previous snapshot and gets
        # "No API key configured" for a key that is definitely stored.
        # Best-effort: a failed pull leaves the cached registry in place.
        await ai_config_sync.refresh_once()
        return 200, await llm.health_snapshot(slug)

    if method == "POST" and path == "/documents":
        return await _upload_document(scope, receive)

    doc_status_match = re.match(r"^/documents/([^/]+)/status$", path)
    if method == "GET" and doc_status_match:
        doc_id = doc_status_match.group(1)
        return await _document_status(doc_id)

    doc_progress_match = re.match(r"^/documents/([^/]+)/progress$", path)
    if method == "GET" and doc_progress_match:
        doc_id = doc_progress_match.group(1)
        return _document_progress(doc_id)

    doc_progress_sse_match = re.match(r"^/documents/([^/]+)/progress/stream$", path)
    if method == "GET" and doc_progress_sse_match:
        return await _document_progress_sse(scope, send)

    if method == "GET" and path == "/progress":
        return _progress_batch(scope)

    doc_delete_match = re.match(r"^/documents/([^/]+)$", path)
    if method == "DELETE" and doc_delete_match:
        doc_id = doc_delete_match.group(1)
        return await _delete_document(doc_id)

    if method == "POST" and path == "/query":
        return await _query(receive)

    if method == "POST" and path == "/scrape/source":
        return await _scrape_source(receive)

    if method == "POST" and path == "/scrape/sitemap/detect":
        return await _scrape_sitemap_detect(receive)

    if method == "POST" and path == "/scrape/check":
        return await _scrape_check(receive)

    if method == "POST" and path == "/scrape/listing/check":
        return await _scrape_listing_check(receive)

    if method == "POST" and path == "/scrape/sitemap-crawl":
        return await _scrape_sitemap_crawl(receive)

    if method == "POST" and path == "/scrape/discover":
        return await _scrape_discover(receive)

    if method == "POST" and path == "/scrape/diagnose":
        return await _scrape_diagnose(receive)

    scrape_progress_match = re.match(r"^/scrape/progress/([^/]+)$", path)
    if method == "GET" and scrape_progress_match:
        return _scrape_progress(scrape_progress_match.group(1))

    if method == "POST" and path == "/notices/analyze":
        return await _notices_analyze(receive)

    if method == "POST" and path == "/notices/extract-pdf":
        return await _notices_extract_pdf(receive)

    if method == "POST" and path == "/notices/ask":
        return await _notices_ask(receive)

    if method == "POST" and path == "/notices/search":
        return await _notices_search(receive)

    if method == "POST" and path == "/notices/embed":
        return await _notices_embed(receive)
    if method == "POST" and path == "/notices/delete":
        return await _notices_delete(receive)

    return 404, {"error": "Not found"}


async def _health() -> tuple[int, dict]:
    qdrant_ok = False
    try:
        # is_connected() is a blocking network call — off the event loop, so
        # a slow/unreachable Qdrant degrades this one health check instead of
        # freezing every other request this single-worker process is serving
        # (progress polls, queries, other uploads) for the same duration.
        qdrant_ok = await asyncio.to_thread(store.is_connected)
    except Exception:
        logger.exception("Health check: Qdrant probe raised")

    phase = _warmup_state["phase"]
    body = {
        "status": "ok" if phase == "ready" else phase,
        "qdrant": qdrant_ok,
        "model_loaded": embeddings.is_loaded(),
    }
    if _warmup_state["error"]:
        body["error"] = _warmup_state["error"]
    return 200, body


async def _upload_document(scope: dict, receive) -> tuple[int, dict]:
    content_type = _get_header(scope, b"content-type")
    if not content_type or b"multipart/form-data" not in content_type:
        return 400, {"error": "Content-Type must be multipart/form-data"}

    boundary = _extract_boundary(content_type)
    if not boundary:
        return 400, {"error": "Missing multipart boundary"}

    try:
        body = await _read_body(receive)
    except ValueError as e:
        if "too large" in str(e).lower():
            return 413, {"error": str(e)}
        return 400, {"error": str(e)}
    parts = _parse_multipart(body, boundary)

    file_part = parts.get("file")
    if not file_part:
        return 400, {"error": "No file uploaded. Field name must be 'file'"}

    # --- File validation ---
    file_data = file_part["data"]
    filename = file_part.get("filename", "unknown")
    mime_type = file_part.get("content_type", "application/octet-stream")

    # Size limit: 100 MB
    MAX_FILE_SIZE = 100 * 1024 * 1024
    if len(file_data) > MAX_FILE_SIZE:
        return 400, {"error": f"File too large: {len(file_data)} bytes (max {MAX_FILE_SIZE})"}

    # MIME allowlist
    ALLOWED_MIME_TYPES = {
        "application/pdf",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/msword",
        "text/plain",
        "text/markdown",
        "text/csv",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "application/vnd.ms-excel",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "application/vnd.ms-powerpoint",
        "image/png",
        "image/jpeg",
        "image/tiff",
        "image/webp",
    }
    if mime_type not in ALLOWED_MIME_TYPES:
        return 400, {"error": f"Unsupported file type: {mime_type}"}

    # Magic bytes validation (basic)
    if not _validate_magic_bytes(file_data, mime_type):
        return 400, {"error": "File content does not match declared MIME type"}

    # --- Deduplication: SHA-256 hash (stable doc_id from content hash) ---
    file_hash = hashlib.sha256(file_data).hexdigest()
    doc_id = file_hash[:32]  # Stable 128-bit ID from content hash

    # Allow API to override doc_id (for deduplication on API side)
    doc_id_part = parts.get("document_id")
    if doc_id_part and doc_id_part["data"].strip():
        doc_id = doc_id_part["data"].decode("utf-8").strip()
        if not re.fullmatch(r"[A-Za-z0-9_-]{8,64}", doc_id):
            return 400, {"error": "Invalid document_id: must be 8-64 alphanumeric, hyphen, underscore"}

    metadata_raw = parts.get("metadata")
    metadata: dict = {}
    if metadata_raw:
        try:
            metadata = json.loads(metadata_raw["data"].decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            pass

    filename = file_part.get("filename", "unknown")
    title_part = parts.get("title")
    if title_part and title_part["data"].strip():
        metadata["title"] = title_part["data"].decode("utf-8").strip()

    upload_dir = config.ensure_upload_dir()
    ext = Path(filename).suffix
    save_path = upload_dir / f"{doc_id}{ext}"
    try:
        save_path.resolve().relative_to(upload_dir.resolve())
    except ValueError:
        return 400, {"error": "Invalid document_id"}
    await asyncio.to_thread(save_path.write_bytes, file_data)

    logger.info(
        "Upload received: doc_id=%s, filename=%s, size=%d bytes, hash=%s",
        doc_id,
        filename,
        len(file_data),
        file_hash[:16],
    )

    metadata["file_hash"] = file_hash

    progress.start(doc_id, filename)

    # The pipeline (OCR, embedding) is CPU-bound and synchronous. Run it in a
    # worker thread so the event loop stays free to serve progress polls and
    # queries while a large document is being processed.
    try:
        return await asyncio.to_thread(
            _ingest_document, doc_id, save_path, filename, mime_type, metadata
        )
    except Exception as e:
        progress.fail(doc_id, str(e))
        raise


def _ingest_document(
    doc_id: str,
    save_path: Path,
    filename: str,
    mime_type: str,
    metadata: dict,
) -> tuple[int, dict]:
    progress.update(doc_id, "extracting", f"Extracting text from {filename}...")
    try:
        start = time.perf_counter()
        result = extractor.extract_text(str(save_path), mime_type)
        metrics.histogram("extraction_latency").observe(time.perf_counter() - start)
        metrics.counter("extractions_total").inc()
    except Exception as e:
        save_path.unlink(missing_ok=True)
        progress.fail(doc_id, f"Text extraction failed: {e}")
        logger.exception("Text extraction failed for doc_id=%s", doc_id)
        return 422, {"error": f"Text extraction failed: {str(e)}"}

    text = result["text"]
    if not text.strip():
        save_path.unlink(missing_ok=True)
        progress.fail(doc_id, "No text could be extracted")
        logger.warning("No text extracted for doc_id=%s (%s)", doc_id, filename)
        return 422, {"error": "No text could be extracted from the document"}

    progress.update(doc_id, "chunking", f"Chunking {len(text):,} characters...")
    chunk_start = time.perf_counter()
    chunks = chunker.chunk_text(text, config.CHUNK_SIZE, config.CHUNK_OVERLAP)
    metrics.histogram("chunking_latency").observe(time.perf_counter() - chunk_start)
    metrics.counter("chunking_total").inc()
    if chunks:
        total_chars = sum(len(c["content"]) for c in chunks)
        metrics.record_chunk_stats(len(chunks), total_chars)
    if not chunks:
        save_path.unlink(missing_ok=True)
        progress.fail(doc_id, "Document produced no indexable chunks")
        logger.warning("Chunking produced no chunks for doc_id=%s", doc_id)
        return 422, {"error": "Document produced no indexable chunks"}

    chunk_texts = [c["content"] for c in chunks]
    total = len(chunk_texts)
    progress.update(doc_id, "embedding", f"Embedding {total} chunks...", 0, total)

    try:
        emb_start = time.perf_counter()
        chunk_embeddings = embeddings.get_embeddings(
            chunk_texts,
            on_progress=lambda done, n: progress.update(
                doc_id, "embedding", f"Embedding chunk {done}/{n}", done, n
            ),
        )
        metrics.histogram("embedding_latency").observe(time.perf_counter() - emb_start)
        metrics.counter("embeddings_total").inc(total)
    except Exception as e:
        save_path.unlink(missing_ok=True)
        progress.fail(doc_id, f"Embedding failed: {e}")
        logger.exception("Embedding failed for doc_id=%s", doc_id)
        return 500, {"error": f"Failed to embed document: {str(e)}"}

    doc_metadata = {
        "original_filename": filename,
        "mime_type": mime_type,
        **metadata,
    }

    progress.update(doc_id, "indexing", "Writing vectors to Qdrant...", 0, total)
    try:
        idx_start = time.perf_counter()
        chunk_count = store.index_document(
            doc_id,
            chunks,
            chunk_embeddings,
            doc_metadata,
            on_progress=lambda done, n: progress.update(
                doc_id, "indexing", f"Indexing chunk {done}/{n}", done, n
            ),
        )
        metrics.histogram("indexing_latency").observe(time.perf_counter() - idx_start)
        metrics.counter("indexed_chunks_total").inc(chunk_count)
    except Exception as e:
        save_path.unlink(missing_ok=True)
        progress.fail(doc_id, f"Indexing failed: {e}")
        logger.exception("Qdrant transactional indexing failed for doc_id=%s", doc_id)
        return 503, {"error": f"Failed to index document: {str(e)}"}

    progress.finish(doc_id, chunk_count)

    # apps/api's S3 bucket is now the durable copy of this file — this local
    # copy only ever existed so extract_text()/embeddings could read it, and
    # was previously left on disk forever on every successful ingest (an
    # unbounded local-disk leak, distinct from the failure paths above which
    # already cleaned up). Delete it now that indexing succeeded.
    save_path.unlink(missing_ok=True)

    return 201, {
        "doc_id": doc_id,
        "text_length": len(text),
        "chunk_count": chunk_count,
        "is_ocr": result["is_ocr"],
        "page_count": result["page_count"],
        "filename": filename,
    }


def _progress_batch(scope: dict) -> tuple[int, dict]:
    """GET /progress?ids=a,b,c — progress for many documents in one call."""
    query_string = scope.get("query_string", b"").decode("utf-8", errors="replace")
    ids: list[str] = []
    for pair in query_string.split("&"):
        if pair.startswith("ids="):
            ids = [i for i in unquote(pair[4:]).split(",") if i]
            break
    if not ids:
        return 400, {"error": "Query parameter 'ids' is required"}
    return 200, {"progress": progress.get_many(ids[:50])}


def _document_progress(doc_id: str) -> tuple[int, dict]:
    entry = progress.get(doc_id)
    if entry is None:
        return 404, {"error": "No progress information for this document"}
    return 200, entry


async def _document_progress_sse(scope, send) -> None:
    """GET /documents/{id}/progress/stream — Server-Sent Events for live progress."""
    # Extract doc_id from path
    path = scope["path"]
    doc_id = path.split("/")[-2]  # /documents/{id}/progress/stream
    
    await send({
        "type": "http.response.start",
        "status": 200,
        "headers": [
            (b"content-type", b"text/event-stream"),
            (b"cache-control", b"no-cache"),
            (b"connection", b"keep-alive"),
            (b"x-accel-buffering", b"no"),
        ],
    })

    try:
        while True:
            entry = progress.get(doc_id)
            if entry is None:
                await send({
                    "type": "http.response.body",
                    "body": b"event: error\ndata: {\"error\": \"Not found\"}\n\n",
                })
                break
            
            data = json.dumps(entry)
            await send({
                "type": "http.response.body",
                "body": f"data: {data}\n\n".encode(),
            })
            
            if entry["stage"] in ("done", "failed"):
                await send({
                    "type": "http.response.body",
                    "body": b"event: done\ndata: {}\n\n",
                })
                break
            
            await asyncio.sleep(1)  # Poll every second
    except asyncio.CancelledError:
        pass


async def _document_status(doc_id: str) -> tuple[int, dict]:
    try:
        # Blocking Qdrant call — off the event loop for the same reason as
        # the health check above (this is also what the API polls to
        # reconcile a document's status after giving up waiting on a slow
        # ingest, so it must stay responsive even while Qdrant is degraded).
        chunk_count = await asyncio.to_thread(store.get_document_chunks, doc_id)
        return 200, {
            "doc_id": doc_id,
            "chunk_count": chunk_count,
            "indexed": chunk_count > 0,
        }
    except Exception as e:
        logger.exception("Status check failed for doc_id=%s", doc_id)
        return 503, {"error": f"Could not check document status: {str(e)}"}


async def _delete_document(doc_id: str) -> tuple[int, dict]:
    try:
        await asyncio.to_thread(store.delete_document, doc_id)
        # Defensive, not the common case: the success path in
        # _ingest_document already deletes its own local copy, but this
        # catches anything left behind by an older ingest, a race with an
        # in-flight embed, or a prior failure path that didn't clean up.
        upload_dir = config.ensure_upload_dir()
        for path in upload_dir.glob(f"{doc_id}.*"):
            path.unlink(missing_ok=True)
        return 200, {"doc_id": doc_id, "deleted": True}
    except Exception as e:
        logger.exception("Delete failed for doc_id=%s", doc_id)
        return 503, {"error": f"Failed to delete document: {str(e)}"}


async def _query(receive) -> tuple[int, dict]:
    try:
        body = await _read_body(receive)
    except ValueError as e:
        if "too large" in str(e).lower():
            return 413, {"error": str(e)}
        return 400, {"error": str(e)}
    try:
        data = json.loads(body) if body else {}
    except json.JSONDecodeError:
        return 400, {"error": "Invalid JSON body"}

    question = data.get("question", "").strip()
    if not question:
        return 400, {"error": "Field 'question' is required"}
    if len(question) > 2000:
        return 400, {"error": "Field 'question' too long (max 2000 chars)"}

    doc_id = data.get("doc_id")
    doc_ids = data.get("doc_ids")  # list of allowed doc_ids for scoped queries
    if doc_ids is not None and (not isinstance(doc_ids, list) or len(doc_ids) > 100):
        return 400, {"error": "Field 'doc_ids' must be a list of at most 100 ids"}
    try:
        top_k = int(data.get("top_k", 5))
    except (ValueError, TypeError):
        return 400, {"error": "Field 'top_k' must be an integer"}
    top_k = max(1, min(top_k, 20))
    language = data.get("language", "en")

    try:
        result = await rag.query(
            question=question,
            doc_id=doc_id,
            doc_ids=doc_ids,
            top_k=top_k,
            language=language,
        )
        return 200, result
    except Exception as e:
        logger.exception("RAG query failed")
        return 500, {"error": f"Query failed: {str(e)}"}


async def _scrape_source(receive) -> tuple[int, dict]:
    """POST /scrape/source — generic notice/news scrape for an admin-added
    website. Body: {base_url, category_urls: {"NOTICE"?: url, "NEWS"?: url},
    cached_schemas?: {"NOTICE"?: schema, "NEWS"?: schema}, known_urls?: [...],
    max_pages?: int, run_id?: str, pagination?: {type, param, start_page},
    deep?: bool, auto_finish?: bool}. `deep` walks every page the listing's
    pager reports rather than the newest `max_pages` (see
    scraper.scrape_source). `auto_finish` (default true) controls whether
    this call finalizes the run itself via POST .../runs/{run_id}/finish —
    apps/api sends false when it may still fall back to a sitemap crawl
    afterward for the same run_id, so it alone decides when the run's book
    is closed instead of two independent finish calls racing each other.
    Returns {items: [...], schemas: {category: schema}} — `schemas` is
    whichever schema (cached or freshly detected) was actually used, for the
    caller to persist for the next run. When `run_id` is given, live status
    messages are recorded and pollable via GET /scrape/progress/{run_id}."""
    try:
        body = await _read_body(receive)
    except ValueError as e:
        if "too large" in str(e).lower():
            return 413, {"error": str(e)}
        return 400, {"error": str(e)}
    try:
        data = json.loads(body) if body else {}
    except json.JSONDecodeError:
        return 400, {"error": "Invalid JSON body"}

    base_url = data.get("base_url", "").strip()
    if not base_url:
        return 400, {"error": "Field 'base_url' is required"}

    category_urls = data.get("category_urls") or {}
    if not category_urls:
        return 400, {"error": "Field 'category_urls' must map at least one category to a URL"}

    # SSRF protection
    for url_to_check in [base_url] + [str(v) for v in category_urls.values() if isinstance(v, str) and v.strip()]:
        ok, err = secure_http._validate_url(url_to_check)
        if not ok:
            return 400, {"error": f"Blocked URL: {err}"}
        host = urlparse(url_to_check).hostname
        if host:
            blocked, reason = await secure_http._host_resolves_to_blocked(host)
            if blocked:
                return 400, {"error": f"Blocked URL: {reason}"}

    cached_schemas = data.get("cached_schemas") or {}
    known_urls = set(data.get("known_urls") or [])
    max_pages = int(data.get("max_pages", scraper.DEFAULT_MAX_PAGES))
    deep = bool(data.get("deep"))
    run_id = data.get("run_id")
    auto_finish = bool(data.get("auto_finish", True))
    # Per-run cap on concurrent LLM summarizations, sent by the API from the
    # admin `scraping.summarizeConcurrency` setting. Absent → scraper default.
    summarize_concurrency = int(data.get("summarize_concurrency") or 0)

    pagination_data = data.get("pagination") or {}
    pagination = scraper.PaginationConfig(
        pagination_type=pagination_data.get("type", "QUERY_PARAM"),
        param=pagination_data.get("param", "page"),
        start_page=int(pagination_data.get("start_page", 1)),
    )

    on_progress = None
    if run_id:
        scrape_progress.start(run_id)
        on_progress = lambda msg: scrape_progress.log(run_id, msg)  # noqa: E731

    # Every item this run finds is pushed to apps/api the moment it's ready
    # (see scrape_stream.RunStreamer) — the response built below is a
    # backward-compatible echo, not the only way the data gets persisted.
    streamer = scrape_stream.RunStreamer(run_id)

    try:
        items, schemas_used, failed_urls, stats = await scraper.scrape_source(
            base_url=base_url,
            category_urls=category_urls,
            cached_schemas=cached_schemas,
            known_urls=known_urls,
            max_pages=max_pages,
            summarize_concurrency=summarize_concurrency or None,
            pagination=pagination,
            deep=deep,
            on_progress=on_progress,
            on_item=streamer.push if streamer.enabled else None,
        )
        if run_id:
            scrape_progress.finish(run_id, f"Done — {len(items)} item(s) found")
        if auto_finish:
            await streamer.finish(schemas_used, failed_urls, stats)
        if streamer.push_failures:
            logger.warning(
                "Run %s: %d item(s) fell back to the end-of-run response after streaming failed",
                run_id, streamer.push_failures,
            )
        return 200, {
            "items": streamer.response_items(items),
            "schemas": schemas_used,
            "failed_urls": failed_urls,
            "stats": stats,
        }
    except Exception as e:
        logger.exception("Scrape failed for base_url=%s", base_url)
        if run_id:
            scrape_progress.fail(run_id, str(e))
        # finish() even on a hard failure: whatever streamed successfully
        # before the crawl blew up is real, persisted data — the run should
        # be reported as a partial/failed run with that itemsFound count,
        # not silently reconciled away because the crawl itself never
        # reached its own return statement.
        if auto_finish:
            await streamer.finish({}, [], {}, error=f"Scrape failed: {str(e)}")
        return 502, {"error": f"Scrape failed: {str(e)}"}


async def _scrape_discover(receive) -> tuple[int, dict]:
    """POST /scrape/discover — body: {base_url, run_id?, max_verify?}.

    Finds this site's real notice/news/press-release listing routes instead
    of making the admin browse for them, and proves each one by crawling it.
    Returns {base_url, routes: [...], best: {CATEGORY: url}, checked, notes}.
    """
    try:
        body = await _read_body(receive)
    except ValueError as e:
        if "too large" in str(e).lower():
            return 413, {"error": str(e)}
        return 400, {"error": str(e)}
    try:
        data = json.loads(body) if body else {}
    except json.JSONDecodeError:
        return 400, {"error": "Invalid JSON body"}

    base_url = (data.get("base_url") or "").strip()
    if not base_url:
        return 400, {"error": "Field 'base_url' is required"}

    # SSRF protection
    ok, err = secure_http._validate_url(base_url)
    if not ok:
        return 400, {"error": f"Blocked URL: {err}"}
    host = urlparse(base_url).hostname
    if host:
        blocked, reason = await secure_http._host_resolves_to_blocked(host)
        if blocked:
            return 400, {"error": f"Blocked URL: {reason}"}

    run_id = data.get("run_id")
    on_progress = None
    if run_id:
        scrape_progress.start(run_id)
        on_progress = lambda msg: scrape_progress.log(run_id, msg)  # noqa: E731

    try:
        result = await route_discovery.discover_routes(
            base_url,
            max_verify=int(data.get("max_verify") or 10),
            on_progress=on_progress,
        )
        if run_id:
            scrape_progress.finish(run_id, f"Found {len(result.get('best') or {})} route(s)")
        return 200, result
    except Exception as e:
        logger.exception("Route discovery failed for %s", base_url)
        if run_id:
            scrape_progress.fail(run_id, str(e))
        return 502, {"error": f"Route discovery failed: {str(e)}"}


async def _scrape_diagnose(receive) -> tuple[int, dict]:
    """POST /scrape/diagnose — explain a failed or empty run, with fixes.

    Body: {base_url, failed_urls?, category_urls?, items_found?, items_new?,
    has_sitemap?, pagination?, stats?, discover?}. With `discover: true` the
    site's routes are re-detected first, so a "your listing URL is dead"
    finding can name the URL that replaced it.
    Returns {diagnoses: [...], discovered: {...} | null}.
    """
    body = await _read_body(receive)
    try:
        data = json.loads(body) if body else {}
    except json.JSONDecodeError:
        return 400, {"error": "Invalid JSON body"}

    base_url = (data.get("base_url") or "").strip()
    if not base_url:
        return 400, {"error": "Field 'base_url' is required"}

    discovered = None
    if data.get("discover"):
        try:
            discovered = await route_discovery.discover_routes(base_url, max_verify=8)
        except Exception:
            # A diagnosis without replacement URLs is still worth returning.
            logger.exception("Discovery during diagnosis failed for %s", base_url)

    # The pagination the crawl actually observed, from any category that saw
    # more than one page.
    stats = data.get("stats") or {}
    detected_pagination = None
    for category_stats in (stats.get("categories") or {}).values():
        if isinstance(category_stats, dict) and category_stats.get("detected_pagination"):
            detected_pagination = category_stats["detected_pagination"]
            break

    diagnoses = scrape_diagnosis.diagnose(
        data.get("failed_urls") or [],
        category_urls=data.get("category_urls") or {},
        base_url=base_url,
        items_found=int(data.get("items_found") or 0),
        items_new=int(data.get("items_new") or 0),
        has_sitemap=bool(data.get("has_sitemap")),
        pagination=data.get("pagination"),
        detected_pagination=detected_pagination,
        discovered_routes=discovered,
    )
    return 200, {
        "diagnoses": diagnoses,
        "discovered": discovered,
        "checked_at": _now_iso(),
    }


def _scrape_progress(run_id: str) -> tuple[int, dict]:
    entry = scrape_progress.get(run_id)
    if entry is None:
        return 404, {"error": "No progress information for this run"}
    return 200, entry


def _now_iso() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat()


async def _scrape_sitemap_detect(receive) -> tuple[int, dict]:
    """POST /scrape/sitemap/detect — body: {base_url}. One-time sitemap
    detection (robots.txt -> /sitemap.xml -> best child sitemap). Returns
    {base_url, sitemap_url, checked_at} — sitemap_url is null when no usable
    article sitemap exists (the caller caches both verdicts forever)."""
    try:
        body = await _read_body(receive)
    except ValueError as e:
        if "too large" in str(e).lower():
            return 413, {"error": str(e)}
        return 400, {"error": str(e)}
    try:
        data = json.loads(body) if body else {}
    except json.JSONDecodeError:
        return 400, {"error": "Invalid JSON body"}

    base_url = (data.get("base_url") or "").strip()
    if not base_url:
        return 400, {"error": "Field 'base_url' is required"}

    # SSRF protection
    ok, err = secure_http._validate_url(base_url)
    if not ok:
        return 400, {"error": f"Blocked URL: {err}"}
    host = urlparse(base_url).hostname
    if host:
        blocked, reason = await secure_http._host_resolves_to_blocked(host)
        if blocked:
            return 400, {"error": f"Blocked URL: {reason}"}

    try:
        sitemap_url = await scraper.detect_sitemap(base_url)
    except Exception as e:
        logger.exception("Sitemap detection failed for %s", base_url)
        return 502, {"error": f"Sitemap detection failed: {str(e)}"}

    return 200, {
        "base_url": base_url,
        "sitemap_url": sitemap_url,
        "checked_at": _now_iso(),
    }


async def _scrape_listing_check(receive) -> tuple[int, dict]:
    """POST /scrape/listing/check — the sitemap fast-path's equivalent for
    sources that have no usable sitemap.

    Body: {base_url, category_urls, cached_schemas?, known_urls?, pagination?}.
    Fetches only page 1 of each listing and returns the detail URLs not
    already known — no detail pages, no OCR, no LLM. Cheap enough to run on
    a short interval, so an HTML-only source pays for a full crawl only when
    something new actually appears.
    Returns {new_urls, total_seen, checked_at}.
    """
    try:
        body = await _read_body(receive)
    except ValueError as e:
        if "too large" in str(e).lower():
            return 413, {"error": str(e)}
        return 400, {"error": str(e)}
    try:
        data = json.loads(body) if body else {}
    except json.JSONDecodeError:
        return 400, {"error": "Invalid JSON body"}

    base_url = (data.get("base_url") or "").strip()
    if not base_url:
        return 400, {"error": "Field 'base_url' is required"}

    category_urls = data.get("category_urls") or {}
    if not category_urls:
        return 400, {"error": "Field 'category_urls' must map at least one category to a URL"}

    # SSRF protection
    for url_to_check in [base_url] + [str(v) for v in category_urls.values() if isinstance(v, str) and v.strip()]:
        ok, err = secure_http._validate_url(url_to_check)
        if not ok:
            return 400, {"error": f"Blocked URL: {err}"}
        host = urlparse(url_to_check).hostname
        if host:
            blocked, reason = await secure_http._host_resolves_to_blocked(host)
            if blocked:
                return 400, {"error": f"Blocked URL: {reason}"}

    pagination_data = data.get("pagination") or {}
    pagination = scraper.PaginationConfig(
        pagination_type=pagination_data.get("type", "QUERY_PARAM"),
        param=pagination_data.get("param", "page"),
        start_page=int(pagination_data.get("start_page", 1)),
    )

    try:
        new_urls, total_seen = await scraper.check_listing(
            base_url=base_url,
            category_urls=category_urls,
            cached_schemas=data.get("cached_schemas") or {},
            known_urls=data.get("known_urls") or [],
            pagination=pagination,
        )
    except Exception as e:
        logger.exception("Listing check failed for %s", base_url)
        return 502, {"error": f"Listing check failed: {str(e)}"}

    return 200, {
        "new_urls": new_urls,
        "total_seen": total_seen,
        "checked_at": _now_iso(),
    }


async def _scrape_check(receive) -> tuple[int, dict]:
    """POST /scrape/check — body: {sitemap_url, known_urls?: [...]} (or
    {base_url} to re-detect first). The cheap fast-path: one-to-a-few GETs
    that return only the sitemap's <loc> entries not already known.
    Returns {sitemap_url, checked_at, new_urls, total_locs}."""
    try:
        body = await _read_body(receive)
    except ValueError as e:
        if "too large" in str(e).lower():
            return 413, {"error": str(e)}
        return 400, {"error": str(e)}
    try:
        data = json.loads(body) if body else {}
    except json.JSONDecodeError:
        return 400, {"error": "Invalid JSON body"}

    sitemap_url = (data.get("sitemap_url") or "").strip()
    known_urls = data.get("known_urls") or []

    if not sitemap_url:
        base_url = (data.get("base_url") or "").strip()
        if not base_url:
            return 400, {
                "error": "Field 'sitemap_url' is required (or 'base_url' to detect first)",
            }
        # SSRF protection for base_url fallback
        ok, err = secure_http._validate_url(base_url)
        if not ok:
            return 400, {"error": f"Blocked URL: {err}"}
        host = urlparse(base_url).hostname
        if host:
            blocked, reason = await secure_http._host_resolves_to_blocked(host)
            if blocked:
                return 400, {"error": f"Blocked URL: {reason}"}
        try:
            sitemap_url = await scraper.detect_sitemap(base_url)
        except Exception as e:
            logger.exception("Sitemap detection failed for %s", base_url)
            return 502, {"error": f"Sitemap detection failed: {str(e)}"}
        if not sitemap_url:
            return 200, {
                "sitemap_url": None,
                "checked_at": _now_iso(),
                "new_urls": [],
                "total_locs": 0,
            }

    # SSRF protection for sitemap_url
    ok, err = secure_http._validate_url(sitemap_url)
    if not ok:
        return 400, {"error": f"Blocked URL: {err}"}
    host = urlparse(sitemap_url).hostname
    if host:
        blocked, reason = await secure_http._host_resolves_to_blocked(host)
        if blocked:
            return 400, {"error": f"Blocked URL: {reason}"}

    try:
        new_urls, total_locs = await scraper.check_sitemap(
            sitemap_url, known_urls, since=data.get("since")
        )
    except Exception as e:
        logger.exception("Sitemap check failed for %s", sitemap_url)
        return 502, {"error": f"Sitemap check failed: {str(e)}"}

    return 200, {
        "sitemap_url": sitemap_url,
        "checked_at": _now_iso(),
        "new_urls": new_urls,
        "total_locs": total_locs,
    }


async def _scrape_sitemap_crawl(receive) -> tuple[int, dict]:
    """POST /scrape/sitemap-crawl — body: {base_url, urls: [...],
    known_urls?: [...], run_id?, auto_finish?}. Fetches each sitemap URL
    directly as a detail page — the sitemap fast-path's own full crawl. No
    listing page, no CSS-extraction schema. Returns the same item shape as
    /scrape/source ({items, schemas}) so the API reuses its full persistence
    pipeline unchanged. `auto_finish` (default true) — see
    _scrape_source's docstring; apps/api sends false when this call is the
    listing→sitemap fallback branch of the same run."""
    try:
        body = await _read_body(receive)
    except ValueError as e:
        if "too large" in str(e).lower():
            return 413, {"error": str(e)}
        return 400, {"error": str(e)}
    try:
        data = json.loads(body) if body else {}
    except json.JSONDecodeError:
        return 400, {"error": "Invalid JSON body"}

    base_url = (data.get("base_url") or "").strip()
    urls = data.get("urls") or []
    if not base_url:
        return 400, {"error": "Field 'base_url' is required"}
    if not urls:
        return 400, {"error": "Field 'urls' must contain at least one URL"}

    # SSRF protection
    for url_to_check in [base_url] + [str(u) for u in urls if isinstance(u, str) and u.strip()]:
        ok, err = secure_http._validate_url(url_to_check)
        if not ok:
            return 400, {"error": f"Blocked URL: {err}"}
        host = urlparse(url_to_check).hostname
        if host:
            blocked, reason = await secure_http._host_resolves_to_blocked(host)
            if blocked:
                return 400, {"error": f"Blocked URL: {reason}"}

    known_urls = set(data.get("known_urls") or [])
    run_id = data.get("run_id")
    auto_finish = bool(data.get("auto_finish", True))
    # Per-run cap on concurrent LLM summarizations, sent by the API from the
    # admin `scraping.summarizeConcurrency` setting. Absent → scraper default.
    summarize_concurrency = int(data.get("summarize_concurrency") or 0)

    on_progress = None
    if run_id:
        scrape_progress.start(run_id)
        on_progress = lambda msg: scrape_progress.log(run_id, msg)  # noqa: E731

    streamer = scrape_stream.RunStreamer(run_id)

    try:
        items, _, failed_urls = await scraper.scrape_sitemap_urls(
            base_url=base_url,
            urls=urls,
            known_urls=known_urls,
            summarize_concurrency=summarize_concurrency or None,
            on_progress=on_progress,
            on_item=streamer.push if streamer.enabled else None,
        )
        if run_id:
            scrape_progress.finish(run_id, f"Done — {len(items)} item(s) found")
        if auto_finish:
            await streamer.finish({}, failed_urls)
        return 200, {
            "items": streamer.response_items(items),
            "schemas": {},
            "failed_urls": failed_urls,
        }
    except Exception as e:
        logger.exception("Sitemap crawl failed for base_url=%s", base_url)
        if run_id:
            scrape_progress.fail(run_id, str(e))
        if auto_finish:
            await streamer.finish({}, [], error=f"Sitemap crawl failed: {str(e)}")
        return 502, {"error": f"Sitemap crawl failed: {str(e)}"}


async def _notices_analyze(receive) -> tuple[int, dict]:
    """POST /notices/analyze — body: {title, content}. Returns
    {summary, key_facts, tags} or {analyzed: false} if no content/LLM."""
    body = await _read_body(receive)
    try:
        data = json.loads(body) if body else {}
    except json.JSONDecodeError:
        return 400, {"error": "Invalid JSON body"}

    title = (data.get("title") or "").strip()
    content = (data.get("content") or "").strip()
    if not content:
        return 200, {"analyzed": False}

    try:
        result = await llm.analyze_notice(title, content)
    except Exception as e:
        logger.exception("Notice analysis failed")
        return 502, {"error": f"Analysis failed: {str(e)}"}

    if result is None:
        return 200, {"analyzed": False}
    return 200, {"analyzed": True, **result}


# Scanned attachments served as an image (photo of a notice board, a
# screenshotted circular) rather than a PDF — extension is the same
# signal the NestJS API uses to decide whether an attachment is OCR-able.
_IMAGE_EXTENSIONS = (".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tif", ".tiff")

_IMAGE_MIME_EXTENSION = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/bmp": ".bmp",
    "image/tiff": ".tiff",
}


async def _notices_extract_pdf(receive) -> tuple[int, dict]:
    """POST /notices/extract-pdf — body: {url: string, title?: string}.
    Despite the name (kept stable — scraping.service.ts and notices.service.ts
    both call this route), downloads either a PDF or a scanned image
    attachment — picked by the URL's extension — with SSRF protection,
    extracts text via OCR if needed, then runs AI analysis. Returns
    {content_text, is_ocr, summary, summary_ne, key_facts, tags}."""
    import tempfile

    body = await _read_body(receive)
    try:
        data = json.loads(body) if body else {}
    except json.JSONDecodeError:
        return 400, {"error": "Invalid JSON body"}

    url = (data.get("url") or "").strip()
    title = (data.get("title") or "").strip()
    if not url:
        return 400, {"error": "Field 'url' is required"}

    is_image = url.split("?")[0].split("#")[0].lower().endswith(_IMAGE_EXTENSIONS)

    if is_image:
        try:
            file_bytes, mime = await secure_http.secure_download_image(
                url, connect_timeout=5.0, read_timeout=30.0, max_size_bytes=20 * 1024 * 1024,
            )
        except ValueError as e:
            logger.warning("Secure image download failed for %s: %s", url, e)
            return 400, {"error": str(e)}
        except Exception as e:
            logger.warning("Image download failed for %s: %s", url, e)
            return 502, {"error": f"Could not download image: {str(e)}"}

        suffix = _IMAGE_MIME_EXTENSION.get(mime, ".jpg")
        mime_for_extractor = mime
    else:
        # Secure PDF download with SSRF protection
        try:
            file_bytes = await secure_http.secure_download_pdf(
                url,
                connect_timeout=5.0,
                read_timeout=30.0,
                max_size_bytes=50 * 1024 * 1024,  # 50 MB
            )
        except ValueError as e:
            logger.warning("Secure PDF download failed for %s: %s", url, e)
            return 400, {"error": str(e)}
        except Exception as e:
            logger.warning("PDF download failed for %s: %s", url, e)
            return 502, {"error": f"Could not download PDF: {str(e)}"}

        suffix = ".pdf"
        mime_for_extractor = "application/pdf"

    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(file_bytes)
        tmp_path = tmp.name

    try:
        result = await asyncio.to_thread(
            extractor.extract_text, tmp_path, mime_for_extractor
        )
    except Exception as e:
        Path(tmp_path).unlink(missing_ok=True)
        logger.exception("%s extraction failed for %s", "Image" if is_image else "PDF", url)
        return 422, {"error": f"Extraction failed: {str(e)}"}
    finally:
        Path(tmp_path).unlink(missing_ok=True)

    text = result.get("text", "").strip()
    if not text:
        return 200, {"content_text": "", "is_ocr": result.get("is_ocr", False), "analyzed": False}

    analysis = None
    try:
        # Analyzed on the prose alone — tables appended below are structural,
        # not something a summary/key-facts pass benefits from reading.
        analysis = await llm.analyze_notice(title or "Untitled", text)
    except Exception as e:
        logger.warning("Analysis after PDF extraction failed: %s", e)

    tables = result.get("tables") or []
    if tables:
        # Appended rather than spliced inline — see _extract_tables' docstring
        # for why reproducing a table's original position isn't reliable.
        text = text + "\n\n" + "\n\n".join(tables)

    qr_codes = result.get("qr_codes") or []

    response = {
        "content_text": text,
        "is_ocr": result.get("is_ocr", False),
        "page_count": result.get("page_count", 0),
        # How the text was obtained and how plausible it looks, so the API can
        # log it and the admin UI can show whether a re-extraction helped.
        "quality": result.get("quality"),
        "method": result.get("method"),
        "analyzed": analysis is not None,
        "qr_codes": qr_codes,
    }
    if analysis:
        response.update(analysis)
    logger.info(
        "PDF extraction response: %d chars, %d table(s), %d QR code(s)",
        len(text), len(tables), len(qr_codes),
    )
    return 200, response


def _build_notice_context(data: dict) -> str:
    """Assemble everything known about one notice into a single prompt block.

    The extracted body text is the least reliable part — scanned notices and
    legacy-font Nepali PDFs often extract as garbage — so the summary, key
    facts, metadata and attachment list come first and the raw text last.
    """
    sections: list[str] = []

    facts = []
    if data.get("source_label"):
        facts.append(f"Issuing source: {data['source_label']}")
    if data.get("category"):
        facts.append(f"Category: {data['category']}")
    if data.get("published_at"):
        facts.append(f"Published: {data['published_at']}")
    if data.get("source_url"):
        facts.append(f"Notice page: {data['source_url']}")
    if facts:
        sections.append("NOTICE FACTS:\n" + "\n".join(f"- {f}" for f in facts))

    metadata = data.get("metadata")
    if isinstance(metadata, dict) and metadata:
        rows = [f"- {k}: {v}" for k, v in metadata.items() if v not in (None, "", [], {})]
        if rows:
            sections.append("STRUCTURED METADATA:\n" + "\n".join(rows))

    attachments = data.get("attachments")
    if isinstance(attachments, list) and attachments:
        rows = []
        for att in attachments:
            if not isinstance(att, dict):
                continue
            bits = [att.get("name") or att.get("url") or "file"]
            if att.get("mime_type"):
                bits.append(str(att["mime_type"]))
            if att.get("size_bytes"):
                bits.append(f"{round(int(att['size_bytes']) / 1024)} KB")
            rows.append(f"- {' · '.join(bits)} ({att.get('url', '')})")
        if rows:
            sections.append(
                f"ATTACHED FILES ({len(rows)}) — these are attached to this notice "
                "and downloadable from the notice page:\n" + "\n".join(rows)
            )
    else:
        sections.append("ATTACHED FILES: none.")

    summary = (data.get("summary") or "").strip()
    if summary:
        sections.append(f"AI SUMMARY:\n{summary}")
    summary_ne = (data.get("summary_ne") or "").strip()
    if summary_ne:
        sections.append(f"AI SUMMARY (Nepali):\n{summary_ne}")

    key_facts = data.get("key_facts")
    if isinstance(key_facts, list) and key_facts:
        sections.append(
            "KEY POINTS:\n" + "\n".join(f"- {f}" for f in key_facts if str(f).strip())
        )

    content = (data.get("content") or "").strip()
    if content:
        # A legacy-font PDF (Preeti and friends) can extract as confident-
        # looking symbol noise that no structural check distinguishes from
        # real text — passing that straight into the prompt (or into the
        # extractive fallback if every LLM call fails) means the "answer"
        # ends up being that noise, or the prompt scaffolding around it,
        # echoed back verbatim. If it doesn't look like real text, leave it
        # out entirely — the summary/key-facts sections above are already
        # LLM-cleaned and don't have this problem.
        if extractor.is_readable_text(content):
            sections.append(f"NOTICE TEXT (extracted, may be imperfect):\n{content[:6000]}")
        else:
            logger.info("Excluding unreadable notice text from Q&A context (garbled extraction)")

    return "\n\n".join(sections)


async def _notices_ask(receive) -> tuple[int, dict]:
    """POST /notices/ask — body: {title, content, question} plus optional
    summary, summary_ne, key_facts, metadata, attachments, category,
    source_label, source_url, published_at. Returns {answer}."""
    body = await _read_body(receive)
    try:
        data = json.loads(body) if body else {}
    except json.JSONDecodeError:
        return 400, {"error": "Invalid JSON body"}

    title = (data.get("title") or "").strip()
    question = (data.get("question") or "").strip()
    if not question:
        return 400, {"error": "Field 'question' is required"}

    # "Hello" / "thanks" deserve a reply, not "the content doesn't contain the
    # answer to your question". Checked before the context is assembled so it
    # costs no retrieval.
    if llm.is_small_talk(question):
        hint = f'the notice "{title}"' if title else "a public notice"
        return 200, {"answer": await llm.generate_chat(question, context_hint=hint)}

    has_anything = any(
        [
            (data.get("content") or "").strip(),
            (data.get("summary") or "").strip(),
            data.get("key_facts"),
            data.get("attachments"),
            data.get("metadata"),
        ]
    )
    if not has_anything:
        return 200, {"answer": "This notice has no captured content to answer questions about."}

    context = _build_notice_context(data)

    try:
        answer = await llm.answer_notice_question(title, context, question)
        return 200, {"answer": answer}
    except Exception as e:
        logger.exception("Notice Q&A failed")
        return 502, {"error": f"Failed to answer: {str(e)}"}


async def _notices_search(receive) -> tuple[int, dict]:
    """POST /notices/search — hybrid notice search for the floating chatbot.
    Body: {question, pg_results?: [...], category?: str, language?: str, top_k?: int}.
    pg_results are pre-fetched PostgreSQL keyword matches from the NestJS API."""
    body = await _read_body(receive)
    try:
        data = json.loads(body) if body else {}
    except json.JSONDecodeError:
        return 400, {"error": "Invalid JSON body"}

    question = (data.get("question") or "").strip()
    if not question:
        return 400, {"error": "Field 'question' is required"}

    pg_results = data.get("pg_results")
    category = data.get("category")
    language = data.get("language", "en")
    top_k = int(data.get("top_k", 5))

    try:
        result = await notice_rag.search_and_answer(
            question=question,
            pg_results=pg_results,
            category=category,
            language=language,
            top_k=top_k,
            recency_intent=bool(data.get("recency_intent")),
            skip_clarification=bool(data.get("skip_clarification")),
        )
        return 200, result
    except Exception as e:
        logger.exception("Notice search failed")
        return 500, {"error": f"Search failed: {str(e)}"}


async def _notices_embed(receive) -> tuple[int, dict]:
    """POST /notices/embed — index one or more notices into the vector store.
    Body: {notices: [{id, title, ai_summary, category, source_label, source_url, published_at?}]}."""
    body = await _read_body(receive)
    try:
        data = json.loads(body) if body else {}
    except json.JSONDecodeError:
        return 400, {"error": "Invalid JSON body"}

    notices = data.get("notices", [])
    if not notices:
        return 400, {"error": "Field 'notices' (array) is required"}

    indexed = 0
    failed = 0
    for n in notices:
        notice_id = n.get("id", "")
        title = n.get("title", "")
        ai_summary = n.get("ai_summary", "")
        if not notice_id or not title:
            failed += 1
            continue
        ok = notice_store.index_notice(
            notice_id=notice_id,
            title=title,
            ai_summary=ai_summary or "",
            category=n.get("category", ""),
            source_label=n.get("source_label", ""),
            source_url=n.get("source_url", ""),
            published_at=n.get("published_at"),
            content=n.get("content", "") or "",
        )
        if ok:
            indexed += 1
        else:
            failed += 1

    return 200, {"indexed": indexed, "failed": failed, "total": len(notices)}


async def _notices_delete(receive) -> tuple[int, dict]:
    """POST /notices/delete — drop notices from the vector store.
    Body: {ids: [notice_id, ...]}. Without this, a notice deleted in the API
    kept its vector and went on being cited as a source."""
    body = await _read_body(receive)
    try:
        data = json.loads(body) if body else {}
    except json.JSONDecodeError:
        return 400, {"error": "Invalid JSON body"}

    ids = [str(i) for i in (data.get("ids") or []) if i]
    if not ids:
        return 400, {"error": "Field 'ids' (array) is required"}

    deleted = 0
    failed = 0
    for notice_id in ids:
        if notice_store.delete_notice(notice_id):
            deleted += 1
        else:
            failed += 1

    return 200, {"deleted": deleted, "failed": failed, "total": len(ids)}


# --- HTTP helpers ---


async def _read_body(receive) -> bytes:
    body = b""
    MAX_BODY = 110 * 1024 * 1024
    while True:
        message = await receive()
        chunk = message.get("body", b"")
        if chunk:
            body += chunk
            if len(body) > MAX_BODY:
                raise ValueError(f"Request body too large: {len(body)} > {MAX_BODY}")
        if not message.get("more_body", False):
            break
    return body


def _get_header(scope: dict, name: bytes) -> Optional[bytes]:
    for header_name, header_value in scope.get("headers", []):
        if header_name.lower() == name.lower():
            return header_value
    return None


def _validate_magic_bytes(data: bytes, declared_mime: str) -> bool:
    """Basic magic bytes validation for common document types."""
    if len(data) < 8:
        return False

    # PDF: %PDF
    if declared_mime == "application/pdf":
        return data[:4] == b"%PDF"

    # DOCX/ZIP-based: PK\x03\x04
    if declared_mime in {
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    }:
        return data[:4] == b"PK\x03\x04"

    # Legacy DOC: D0 CF 11 E0
    if declared_mime == "application/msword":
        return data[:8] == b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"

    # Images
    if declared_mime == "image/png":
        return data[:8] == b"\x89PNG\r\n\x1a\n"
    if declared_mime == "image/jpeg":
        return data[:3] == b"\xff\xd8\xff"
    if declared_mime == "image/tiff":
        return data[:4] in (b"II\x2a\x00", b"MM\x00\x2a")
    if declared_mime == "image/webp":
        return data[:4] == b"RIFF" and data[8:12] == b"WEBP"

    # Text types - no magic bytes, allow
    if declared_mime.startswith("text/"):
        return True

    # Default allow for unlisted types (CSV, etc.)
    return True


def _extract_boundary(content_type: bytes) -> Optional[bytes]:
    parts = content_type.split(b";")
    for part in parts:
        part = part.strip()
        if part.startswith(b"boundary="):
            boundary = part[9:]
            if boundary.startswith(b'"') and boundary.endswith(b'"'):
                boundary = boundary[1:-1]
            return boundary
    return None


def _parse_multipart(body: bytes, boundary: bytes) -> dict:
    parts: dict = {}
    delimiter = b"--" + boundary

    sections = body.split(delimiter)

    for section in sections:
        if not section or section.strip() == b"--" or section == b"\r\n":
            continue
        if section.startswith(b"--"):
            continue

        if b"\r\n\r\n" in section:
            header_part, data = section.split(b"\r\n\r\n", 1)
        elif b"\n\n" in section:
            header_part, data = section.split(b"\n\n", 1)
        else:
            continue

        if data.endswith(b"\r\n"):
            data = data[:-2]
        elif data.endswith(b"\n"):
            data = data[:-1]

        headers_str = header_part.decode("utf-8", errors="replace")
        field_name = None
        filename = None
        content_type = "application/octet-stream"

        for line in headers_str.split("\r\n"):
            if not line.strip():
                continue
            line_lower = line.lower()
            if "content-disposition" in line_lower:
                name_match = re.search(r'name="([^"]*)"', line)
                if name_match:
                    field_name = name_match.group(1)
                fname_match = re.search(r'filename="([^"]*)"', line)
                if fname_match:
                    filename = fname_match.group(1)
            elif "content-type" in line_lower:
                content_type = line.split(":", 1)[1].strip()

        if field_name:
            parts[field_name] = {
                "data": data,
                "filename": filename,
                "content_type": content_type,
            }

    return parts


def _get_cors_headers(scope: dict) -> list[list[bytes]]:
    origin = _get_header(scope, b"origin")
    if not origin:
        # No Origin header (curl, server-to-server): nothing to restrict.
        return []

    origin_str = origin.decode("utf-8", errors="replace")
    if origin_str in config.CORS_ORIGINS:
        return [
            [b"access-control-allow-origin", origin],
            [b"vary", b"origin"],
            [b"access-control-allow-methods", b"GET, POST, DELETE, OPTIONS"],
            [b"access-control-allow-headers", b"content-type, authorization"],
            [b"access-control-max-age", b"86400"],
        ]
    if "*" in config.CORS_ORIGINS:
        return [
            [b"access-control-allow-origin", b"*"],
            [b"access-control-allow-methods", b"GET, POST, DELETE, OPTIONS"],
            [b"access-control-allow-headers", b"content-type, authorization"],
            [b"access-control-max-age", b"86400"],
        ]

    # Origin not allowlisted: emit no CORS headers so the browser blocks it.
    return []


async def _cors_preflight(send, scope: dict):
    cors_headers = _get_cors_headers(scope)
    await send({
        "type": "http.response.start",
        "status": 204,
        "headers": cors_headers,
    })
    await send({"type": "http.response.body", "body": b""})


async def _send_json(send, data: dict, status: int = 200, scope: dict = None):
    body = json.dumps(data, ensure_ascii=False).encode("utf-8")
    cors_headers = _get_cors_headers(scope) if scope else [
        [b"access-control-allow-origin", b"*"],
    ]
    headers = [
        [b"content-type", b"application/json; charset=utf-8"],
        [b"content-length", str(len(body)).encode()],
    ] + cors_headers

    await send({
        "type": "http.response.start",
        "status": status,
        "headers": headers,
    })
    await send({"type": "http.response.body", "body": body})
