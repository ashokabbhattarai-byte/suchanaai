from typing import Callable, Optional
import uuid

import numpy as np
from qdrant_client import QdrantClient
from qdrant_client.models import (
    Distance,
    FieldCondition,
    Filter,
    Fusion,
    FusionQuery,
    MatchAny,
    MatchValue,
    Modifier,
    PayloadSchemaType,
    PointStruct,
    Prefetch,
    SparseIndexParams,
    SparseVector,
    SparseVectorParams,
    VectorParams,
)

from app import config
from app import embeddings
from app.logger import get_logger

logger = get_logger(__name__)

DENSE_VECTOR = "dense"
SPARSE_VECTOR = "bm25"

_client: Optional[QdrantClient] = None


def get_client() -> QdrantClient:
    global _client
    if _client is None:
        logger.info("Connecting to Qdrant at %s", config.QDRANT_URL)
        _client = QdrantClient(
            url=config.QDRANT_URL,
            api_key=config.QDRANT_API_KEY or None,
            timeout=60,
        )
    return _client


def is_connected() -> bool:
    """
    Cheap liveness probe for /health. Uses its own short-timeout client,
    independent of the shared client's default (60s, sized for large
    indexing batches) — this installed qdrant-client version doesn't accept
    a per-call `timeout=` override on get_collections(), so a dedicated
    client is the only way to fail fast instead of hanging for a minute when
    Qdrant is unreachable. Callers must still run this via
    asyncio.to_thread(); it's a blocking call.
    """
    probe = None
    try:
        probe = QdrantClient(
            url=config.QDRANT_URL,
            api_key=config.QDRANT_API_KEY or None,
            timeout=3,
        )
        probe.get_collections()
        return True
    except Exception as e:
        logger.warning("Qdrant connectivity check failed: %s", e)
        return False
    finally:
        if probe is not None:
            probe.close()


def _collection_matches(client: QdrantClient) -> bool:
    """Check the existing collection against the current embedding config."""
    info = client.get_collection(config.QDRANT_COLLECTION)
    dense = info.config.params.vectors
    if not isinstance(dense, dict) or DENSE_VECTOR not in dense:
        logger.warning(
            "Collection '%s' uses an unnamed/legacy vector schema",
            config.QDRANT_COLLECTION,
        )
        return False
    if dense[DENSE_VECTOR].size != config.EMBEDDING_DIM:
        logger.warning(
            "Collection '%s' has dense dim=%d but EMBEDDING_DIM=%d",
            config.QDRANT_COLLECTION,
            dense[DENSE_VECTOR].size,
            config.EMBEDDING_DIM,
        )
        return False
    sparse = info.config.params.sparse_vectors or {}
    if config.HYBRID_SEARCH and SPARSE_VECTOR not in sparse:
        logger.warning(
            "Collection '%s' has no '%s' sparse vector required for hybrid search",
            config.QDRANT_COLLECTION,
            SPARSE_VECTOR,
        )
        return False
    return True


def ensure_collection() -> None:
    client = get_client()
    collections = client.get_collections().collections
    names = [c.name for c in collections]

    if config.QDRANT_COLLECTION in names:
        if _collection_matches(client):
            logger.debug(
                "Qdrant collection '%s' already exists", config.QDRANT_COLLECTION
            )
            return
        # Vectors from a different model/schema are unusable with the current
        # config, so the collection must be rebuilt; documents need re-upload.
        logger.warning(
            "Recreating collection '%s' with the current schema — previously "
            "indexed documents must be re-uploaded",
            config.QDRANT_COLLECTION,
        )
        try:
            client.delete_collection(config.QDRANT_COLLECTION)
        except Exception as e:
            # Race: another worker may have already deleted it
            if "not found" in str(e).lower() or "doesn't exist" in str(e).lower():
                logger.info("Collection '%s' already deleted by concurrent worker", config.QDRANT_COLLECTION)
            else:
                raise

    logger.info(
        "Creating Qdrant collection '%s' (dense=%d cosine, sparse=%s)",
        config.QDRANT_COLLECTION,
        config.EMBEDDING_DIM,
        SPARSE_VECTOR if config.HYBRID_SEARCH else "off",
    )
    sparse_config = None
    if config.HYBRID_SEARCH:
        sparse_config = {
            SPARSE_VECTOR: SparseVectorParams(
                index=SparseIndexParams(), modifier=Modifier.IDF
            )
        }
    try:
        client.create_collection(
            collection_name=config.QDRANT_COLLECTION,
            vectors_config={
                DENSE_VECTOR: VectorParams(
                    size=config.EMBEDDING_DIM, distance=Distance.COSINE
                )
            },
            sparse_vectors_config=sparse_config,
        )
    except Exception as e:
        # Race: another worker created it between our check and create.
        # qdrant-client raises UnexpectedResponse / AlreadyExists
        msg = str(e).lower()
        if "already exists" in msg or "already exist" in msg or "exists" in msg and "collection" in msg:
            logger.info("Collection '%s' already created by concurrent worker", config.QDRANT_COLLECTION)
            return
        raise
    # Keyword index so per-document filtering stays fast as the corpus grows.
    try:
        client.create_payload_index(
            collection_name=config.QDRANT_COLLECTION,
            field_name="doc_id",
            field_schema=PayloadSchemaType.KEYWORD,
        )
    except Exception as e:
        msg = str(e).lower()
        if "already exists" in msg or "already exist" in msg:
            logger.debug("Payload index already exists for '%s'", config.QDRANT_COLLECTION)
        else:
            logger.warning("Failed to create payload index for '%s': %s", config.QDRANT_COLLECTION, e)


def index_document(
    doc_id: str,
    chunks: list[dict],
    dense_embeddings: list[list[float]],
    metadata: dict,
    on_progress: Optional[Callable[[int, int], None]] = None,
) -> int:
    """
    Index a document's chunks directly into the main collection.

    Point IDs are deterministic (uuid5 of doc_id:chunk_index), so upserting
    is naturally idempotent: a retry or re-embed just overwrites the same
    points rather than duplicating them, and a failure partway through only
    ever leaves *this* document's own points partially updated — it can't
    corrupt any other document. That already gives re-embedding the safety
    that matters in practice, without the temp-collection copy this used to
    do (write to a scratch collection, verify, then upsert everything into
    the main collection a second time) — which doubled Qdrant I/O for no
    benefit the deterministic IDs weren't already providing.
    """
    client = get_client()
    ensure_collection()

    sparse_embeddings: list = []
    if embeddings.sparse_available():
        logger.info("Computing BM25 sparse vectors for %d chunks", len(chunks))
        sparse_embeddings = embeddings.get_sparse_embeddings(
            [c["content"] for c in chunks]
        )

    points: list[PointStruct] = []
    for i, (chunk, dense) in enumerate(zip(chunks, dense_embeddings)):
        point_id = str(uuid.uuid5(uuid.NAMESPACE_DNS, f"{doc_id}:{i}"))
        payload = {
            "doc_id": doc_id,
            "chunk_index": i,
            "content": chunk["content"],
            "char_start": chunk["char_start"],
            "char_end": chunk["char_end"],
            **metadata,
        }
        # Per-chunk locators, written last so a document-level metadata key
        # of the same name cannot shadow them. The chunker computes these
        # for exactly this purpose but they used to stop here: only the
        # document-level `metadata` was indexed, so every citation could
        # name the file and nothing more — no page, no section — and
        # rag._merge_adjacent_chunks' page ranges were always [None, None].
        for key in ("page_num", "section_path", "header_level"):
            value = chunk.get(key)
            if value not in (None, ""):
                payload[key] = value
        vector: dict = {DENSE_VECTOR: dense}
        if sparse_embeddings:
            indices, values = sparse_embeddings[i]
            vector[SPARSE_VECTOR] = SparseVector(indices=indices, values=values)
        points.append(PointStruct(id=point_id, vector=vector, payload=payload))

    batch_size = 100
    total = len(points)
    import time as _time

    for start in range(0, total, batch_size):
        batch = points[start : start + batch_size]
        last_err = None
        for attempt in range(3):
            try:
                client.upsert(collection_name=config.QDRANT_COLLECTION, points=batch)
                last_err = None
                break
            except Exception as e:
                last_err = e
                if attempt == 2:
                    break
                backoff = 0.6 * (2**attempt)
                logger.warning(
                    "Qdrant upsert %d-%d/%d failed (attempt %d/3): %s — retrying in %.1fs",
                    start,
                    min(start + batch_size, total),
                    total,
                    attempt + 1,
                    e,
                    backoff,
                )
                _time.sleep(backoff)
        if last_err is not None:
            raise RuntimeError(f"Qdrant upsert failed after 3 attempts: {last_err}") from last_err
        done = min(start + batch_size, total)
        logger.info("Upserted points %d-%d/%d for doc_id=%s", start, done, total, doc_id)
        if on_progress:
            try:
                on_progress(done, total)
            except Exception:
                logger.exception("on_progress callback failed at %d/%d", done, total)

    logger.info("Indexed %d chunks for doc_id=%s", total, doc_id)
    return total


def search(
    query_embedding: list[float],
    query_text: str = "",
    top_k: int = 5,
    filter_doc_id: Optional[str] = None,
    filter_doc_ids: Optional[list[str]] = None,
) -> dict:
    """Hybrid (dense + BM25, RRF-fused) search, falling back to dense-only.

    Returned scores are always cosine similarity against the dense vector so
    downstream thresholds and UI relevance display stay comparable.
    """
    client = get_client()

    query_filter = None
    if filter_doc_id:
        query_filter = Filter(
            must=[FieldCondition(key="doc_id", match=MatchValue(value=filter_doc_id))]
        )
    elif filter_doc_ids:
        query_filter = Filter(
            must=[FieldCondition(key="doc_id", match=MatchAny(any=filter_doc_ids))]
        )

    sparse_query = None
    if query_text and embeddings.sparse_available():
        sparse_query = embeddings.get_sparse_embedding(query_text)

    if sparse_query:
        indices, values = sparse_query
        results = client.query_points(
            collection_name=config.QDRANT_COLLECTION,
            prefetch=[
                Prefetch(
                    query=query_embedding,
                    using=DENSE_VECTOR,
                    filter=query_filter,
                    limit=top_k * 2,
                ),
                Prefetch(
                    query=SparseVector(indices=indices, values=values),
                    using=SPARSE_VECTOR,
                    filter=query_filter,
                    limit=top_k * 2,
                ),
            ],
            query=FusionQuery(fusion=Fusion.RRF),
            limit=top_k,
            with_vectors=[DENSE_VECTOR],
        )
        mode = "hybrid-rrf"
    else:
        results = client.query_points(
            collection_name=config.QDRANT_COLLECTION,
            query=query_embedding,
            using=DENSE_VECTOR,
            query_filter=query_filter,
            limit=top_k,
            with_vectors=[DENSE_VECTOR],
        )
        mode = "dense"

    logger.info(
        "Search (%s) returned %d hits (top_k=%d, doc_id=%s)",
        mode,
        len(results.points),
        top_k,
        filter_doc_id,
    )

    q_vec = np.array(query_embedding)
    output: list[dict] = []
    for point in results.points:
        # RRF fusion scores are rank-based; recompute cosine from the stored
        # dense vector (both sides L2-normalized) for a comparable score.
        dense_vec = point.vector.get(DENSE_VECTOR) if point.vector else None
        score = float(np.dot(np.array(dense_vec), q_vec)) if dense_vec else point.score
        output.append(
            {
                "content": point.payload.get("content", ""),
                "score": score,
                "doc_id": point.payload.get("doc_id", ""),
                "chunk_index": point.payload.get("chunk_index", 0),
                # rag._merge_adjacent_chunks() reads these as top-level keys
                # to track merged citation ranges — they used to be dropped
                # here (excluded from metadata but never re-added), which
                # crashed every query that merged 2+ chunks with a bare
                # KeyError.
                "char_start": point.payload.get("char_start"),
                "char_end": point.payload.get("char_end"),
                "metadata": {
                    k: v
                    for k, v in point.payload.items()
                    if k not in ("content", "doc_id", "chunk_index", "char_start", "char_end")
                },
            }
        )

    # Cosine re-scoring can reorder RRF output; keep strongest-first.
    output.sort(key=lambda r: r["score"], reverse=True)
    return {"results": output, "mode": mode}


def delete_document(doc_id: str) -> bool:
    client = get_client()
    client.delete(
        collection_name=config.QDRANT_COLLECTION,
        points_selector=Filter(
            must=[FieldCondition(key="doc_id", match=MatchValue(value=doc_id))]
        ),
    )
    logger.info("Deleted all chunks for doc_id=%s", doc_id)
    return True


def get_document_chunks(doc_id: str) -> int:
    client = get_client()
    result = client.count(
        collection_name=config.QDRANT_COLLECTION,
        count_filter=Filter(
            must=[FieldCondition(key="doc_id", match=MatchValue(value=doc_id))]
        ),
    )
    return result.count
