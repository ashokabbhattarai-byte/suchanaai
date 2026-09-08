import threading
import time
from typing import Callable, Optional

from app import config
from app.logger import get_logger

logger = get_logger(__name__)

_model: Optional[object] = None
_sparse_model: Optional[object] = None
_sparse_unavailable = False
_model_lock = threading.Lock()

# ── Concurrency guard for embedding ─────────────────────────────────────
# The model is ~1.1 GB resident + per-batch activations. On a 2 vCPU / 4 GB
# box (t3.medium) two concurrent encodes already saturate CPU and RSS; ten
# at once OOMs and is slower overall due to thrashing. A process-wide
# semaphore keeps memory bounded and throughput maximal without any env knob.
# 2 allows overlap of CPU + Qdrant I/O; OCR has its own semaphore (1) so
# worst-case concurrent CPU jobs = 3, still safe for 4 GB and for the
# 1 GB Oracle box where docker mem_limit=2g would otherwise be exceeded.
_EMBED_CONCURRENCY = 2
_embed_semaphore = threading.Semaphore(_EMBED_CONCURRENCY)
# Bounded thread pool for encodes is not needed — the caller's worker thread
# (asyncio.to_thread) already isolates the GIL; the semaphore is the limit.


def _load_model():
    global _model
    if _model is None:
        with _model_lock:
            if _model is None:
                from sentence_transformers import SentenceTransformer

                logger.info("Loading embedding model '%s'...", config.EMBEDDING_MODEL)
                _model = SentenceTransformer(config.EMBEDDING_MODEL)
                # sentence-transformers >=5 renamed get_sentence_embedding_dimension.
                get_dim = getattr(
                    _model, "get_embedding_dimension", None
                ) or _model.get_sentence_embedding_dimension
                dim = get_dim()
                logger.info("Embedding model loaded (dimension=%d)", dim)
                if dim != config.EMBEDDING_DIM:
                    logger.warning(
                        "EMBEDDING_DIM=%d does not match model dimension %d; "
                        "update EMBEDDING_DIM and recreate the Qdrant collection",
                        config.EMBEDDING_DIM,
                        dim,
                    )
                return _model
    return _model


def is_loaded() -> bool:
    return _model is not None


def _apply_prefix(texts: list[str], kind: str) -> list[str]:
    """E5-family models are trained with instruction prefixes; skipping them
    measurably degrades retrieval quality. Other models pass through as-is."""
    if "e5" in config.EMBEDDING_MODEL.lower():
        prefix = "query: " if kind == "query" else "passage: "
        return [prefix + t for t in texts]
    return texts


def get_embeddings(
    texts: list[str],
    kind: str = "passage",
    on_progress: Optional[Callable[[int, int], None]] = None,
) -> list[list[float]]:
    """Embed texts in batches so arbitrarily large documents fit in memory.

    kind: "passage" for indexed content, "query" for search questions.
    on_progress(done, total) is called after each batch, letting callers
    surface live progress for long-running embeds. Each batch is retried
    with exponential back-off so a transient hiccup (e.g. a momentary
    OOM pressure or a model thread interruption) does not abort a
    100-chunk document mid-way — previously the whole ingest would jump
    straight to `failed` and the UI's batch?ids=… progress would stall
    at the last reported percent.

    Concurrency: guarded by a process-wide semaphore (2) so 10 concurrent
    document ingests don't run 10 encodes in parallel and OOM. The semaphore
    is blocking (threading) because this runs inside asyncio.to_thread.
    """
    # Bound total concurrent encodes; queue behind the semaphore instead of
    # failing. Waiting is cheap (one thread parked), OOMing is not.
    # Use timeout to avoid holding an HTTP connection forever if the queue is
    # pathologically long (e.g. 10 large docs each 2 min -> 10 min queue).
    # 600s matches the caller's AI_INDEX_TIMEOUT_MS so we still surface a
    # proper error rather than hanging past the proxy.
    acquired = _embed_semaphore.acquire(timeout=600)
    if not acquired:
        raise RuntimeError("Embedding queue full — server busy, please retry shortly")
    try:
        model = _load_model()
        prefixed = _apply_prefix(texts, kind)
        total = len(prefixed)
        batch_size = config.EMBEDDING_BATCH_SIZE
        results: list[list[float]] = []

        for start in range(0, total, batch_size):
            batch = prefixed[start : start + batch_size]
            t0 = time.perf_counter()
            vectors = None
            last_err: Optional[Exception] = None
            for attempt in range(3):
                try:
                    # show_progress_bar=False avoids tqdm overhead that
                    # otherwise allocates a bar per batch and logs to stderr
                    # at high concurrency; normalize already true.
                    vectors = model.encode(
                        batch,
                        batch_size=batch_size,
                        normalize_embeddings=True,
                        show_progress_bar=False,
                    )
                    break
                except Exception as e:
                    last_err = e
                    if attempt == 2:
                        break
                    backoff = 0.5 * (2**attempt)  # 0.5s, 1.0s
                    logger.warning(
                        "Embedding batch %d-%d/%d failed (attempt %d/3): %s — retrying in %.1fs",
                        start,
                        min(start + batch_size, total),
                        total,
                        attempt + 1,
                        e,
                        backoff,
                    )
                    time.sleep(backoff)
            if vectors is None:
                raise RuntimeError(f"Embedding failed after 3 attempts: {last_err}")
            results.extend(vectors.tolist())
            done = min(start + batch_size, total)
            logger.info(
                "Embedded batch %d-%d/%d (%.0fms)",
                start,
                done,
                total,
                (time.perf_counter() - t0) * 1000,
            )
            if on_progress:
                try:
                    on_progress(done, total)
                except Exception:
                    # Progress callback is best-effort (writes to an in-memory
                    # dict); never let it abort the embedding itself.
                    logger.exception("on_progress callback failed at %d/%d", done, total)

        return results
    finally:
        _embed_semaphore.release()


def get_embedding(text: str, kind: str = "query") -> list[float]:
    results = get_embeddings([text], kind=kind)
    return results[0]


# --- Sparse (BM25) embeddings for hybrid retrieval ---


def _load_sparse_model():
    global _sparse_model, _sparse_unavailable
    if _sparse_model is None and not _sparse_unavailable:
        try:
            from fastembed import SparseTextEmbedding

            logger.info("Loading sparse model '%s'...", config.SPARSE_MODEL)
            _sparse_model = SparseTextEmbedding(model_name=config.SPARSE_MODEL)
            logger.info("Sparse model loaded")
        except Exception:
            _sparse_unavailable = True
            logger.exception(
                "Could not load sparse model '%s'; hybrid search disabled "
                "(install 'fastembed' to enable)",
                config.SPARSE_MODEL,
            )
    return _sparse_model


def sparse_available() -> bool:
    return config.HYBRID_SEARCH and _load_sparse_model() is not None


def get_sparse_embeddings(texts: list[str]) -> list[tuple[list[int], list[float]]]:
    """Return (indices, values) pairs for each text, for Qdrant sparse vectors."""
    model = _load_sparse_model()
    if model is None:
        return []
    output: list[tuple[list[int], list[float]]] = []
    for emb in model.embed(texts, batch_size=config.EMBEDDING_BATCH_SIZE):
        output.append((emb.indices.tolist(), emb.values.tolist()))
    return output


def get_sparse_embedding(text: str) -> Optional[tuple[list[int], list[float]]]:
    model = _load_sparse_model()
    if model is None:
        return None
    results = list(model.query_embed(text))
    if not results:
        return None
    return results[0].indices.tolist(), results[0].values.tolist()
