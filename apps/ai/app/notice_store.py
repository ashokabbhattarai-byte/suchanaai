"""Qdrant-backed vector store for scraped notices — separate from the 'documents'
collection used by user-uploaded RAG content. Stores one vector per notice (the
concatenation of title + aiSummary), enabling semantic search as a fallback
when PostgreSQL keyword search returns nothing useful."""

import threading
import uuid
from typing import Optional

from qdrant_client.models import (
    Distance,
    FieldCondition,
    Filter,
    MatchValue,
    PayloadSchemaType,
    PointStruct,
    VectorParams,
)

from app import config
from app import embeddings
from app import store as _qdrant
from app.logger import get_logger

logger = get_logger(__name__)

COLLECTION = "notices"
DENSE_VECTOR = "dense"


def _client():
    return _qdrant.get_client()


# The schema check costs two Qdrant round trips and the collection does not
# change under us, so verify once per process rather than on every call.
_collection_ready = False
_collection_lock = threading.Lock()


def ensure_collection() -> None:
    global _collection_ready
    if _collection_ready:
        return
    with _collection_lock:
        if _collection_ready:
            return
        _verify_collection()
        _collection_ready = True


def _invalidate_collection() -> None:
    """Re-check the schema on the next call, after an upsert or query failed."""
    global _collection_ready
    _collection_ready = False


def _verify_collection() -> None:
    client = _client()
    collections = client.get_collections().collections
    names = [c.name for c in collections]

    if COLLECTION in names:
        info = client.get_collection(COLLECTION)
        vectors = info.config.params.vectors
        if isinstance(vectors, dict) and DENSE_VECTOR in vectors:
            if vectors[DENSE_VECTOR].size == config.EMBEDDING_DIM:
                logger.debug("Notices collection '%s' already exists", COLLECTION)
                return
        logger.warning("Recreating notices collection with updated schema")
        try:
            client.delete_collection(COLLECTION)
        except Exception as e:
            if "not found" in str(e).lower() or "doesn't exist" in str(e).lower():
                logger.info("Notices collection already deleted by concurrent worker")
            else:
                raise

    logger.info(
        "Creating Qdrant collection '%s' (dense=%d cosine)",
        COLLECTION,
        config.EMBEDDING_DIM,
    )
    try:
        client.create_collection(
            collection_name=COLLECTION,
            vectors_config={
                DENSE_VECTOR: VectorParams(
                    size=config.EMBEDDING_DIM, distance=Distance.COSINE
                )
            },
        )
    except Exception as e:
        msg = str(e).lower()
        if "already exists" in msg or "already exist" in msg or "exists" in msg and "collection" in msg:
            logger.info("Collection '%s' already created by concurrent worker", COLLECTION)
            return
        raise
    for field_name, field_schema in (
        ("notice_id", PayloadSchemaType.KEYWORD),
        ("category", PayloadSchemaType.KEYWORD),
    ):
        try:
            client.create_payload_index(
                collection_name=COLLECTION,
                field_name=field_name,
                field_schema=field_schema,
            )
        except Exception as e:
            msg = str(e).lower()
            if "already exists" in msg or "already exist" in msg:
                logger.debug("Payload index '%s' already exists for '%s'", field_name, COLLECTION)
            else:
                logger.warning("Failed to create payload index '%s' for '%s': %s", field_name, COLLECTION, e)


# The embedding model truncates around 512 tokens, so only the head of the body
# is worth embedding. The stored excerpt is longer because the LLM reads it as
# context, where more text is still useful.
_EMBED_CONTENT_CHARS = 1200
_EXCERPT_CHARS = 3000


# Points per upsert request. Keeps any single request (and any partial
# failure) small without paying a round trip per notice.
_UPSERT_BATCH = 50


def index_notices(items: list[dict]) -> tuple[int, int]:
    """Embed and upsert notices in bulk. Returns (indexed, failed).

    Bulk on purpose: one encode pass and one upsert per 50 notices, instead of
    an encode plus two schema round trips plus an upsert per notice. Blocking —
    callers must run it via asyncio.to_thread.
    """
    valid: list[tuple[str, dict]] = []
    failed = 0
    for n in items:
        notice_id = str(n.get("id") or "")
        if not notice_id or not (n.get("title") or ""):
            failed += 1
            continue
        valid.append((notice_id, n))

    if not valid:
        return 0, failed

    # Four out of five notices have no AI summary, so a title-only vector was
    # all most of the corpus could be matched on — and the answer context had
    # nothing but a title to work from. The body carries the actual facts.
    texts = [
        "\n".join(
            p
            for p in (
                n.get("title") or "",
                n.get("ai_summary") or "",
                (n.get("content") or "").strip()[:_EMBED_CONTENT_CHARS],
            )
            if p
        )
        for _, n in valid
    ]

    try:
        vectors = embeddings.get_embeddings(texts, kind="passage")
    except Exception as e:
        logger.error("Failed to embed %d notices: %s", len(texts), e)
        return 0, failed + len(valid)

    points = []
    for (notice_id, n), vector in zip(valid, vectors):
        payload = {
            "notice_id": notice_id,
            "title": n.get("title") or "",
            "ai_summary": n.get("ai_summary") or "",
            "content_excerpt": (n.get("content") or "").strip()[:_EXCERPT_CHARS],
            "category": n.get("category") or "",
            "source_label": n.get("source_label") or "",
            "source_url": n.get("source_url") or "",
        }
        if n.get("published_at"):
            payload["published_at"] = n["published_at"]
        points.append(
            PointStruct(
                id=str(uuid.uuid5(uuid.NAMESPACE_DNS, f"notice:{notice_id}")),
                vector={DENSE_VECTOR: vector},
                payload=payload,
            )
        )

    client = _client()
    indexed = 0
    for start in range(0, len(points), _UPSERT_BATCH):
        chunk = points[start : start + _UPSERT_BATCH]
        try:
            ensure_collection()
            client.upsert(collection_name=COLLECTION, points=chunk)
            indexed += len(chunk)
        except Exception as e:
            # The collection may have been dropped or recreated under us.
            _invalidate_collection()
            logger.error(
                "Failed to upsert notices %d-%d of %d: %s",
                start,
                start + len(chunk),
                len(points),
                e,
            )
            failed += len(chunk)

    logger.info("Indexed %d/%d notices into '%s'", indexed, len(items), COLLECTION)
    return indexed, failed


def search(
    query_text: str,
    top_k: int = 10,
    category: Optional[str] = None,
) -> list[dict]:
    """Semantic search over notices. Returns list of dicts with notice metadata + score."""
    try:
        query_vec = embeddings.get_embedding(query_text, kind="query")
    except Exception as e:
        logger.error("Failed to embed query: %s", e)
        return []

    query_filter = None
    if category:
        query_filter = Filter(
            must=[FieldCondition(key="category", match=MatchValue(value=category))]
        )

    client = _client()
    try:
        ensure_collection()
        results = client.query_points(
            collection_name=COLLECTION,
            query=query_vec,
            using=DENSE_VECTOR,
            query_filter=query_filter,
            limit=top_k,
            with_vectors=False,
        )
    except Exception as e:
        _invalidate_collection()
        logger.error("Notices search failed: %s", e)
        return []

    output = []
    for point in results.points:
        output.append({
            "notice_id": point.payload.get("notice_id", ""),
            "title": point.payload.get("title", ""),
            "ai_summary": point.payload.get("ai_summary", ""),
            "content_excerpt": point.payload.get("content_excerpt", ""),
            "category": point.payload.get("category", ""),
            "source_label": point.payload.get("source_label", ""),
            "source_url": point.payload.get("source_url", ""),
            "published_at": point.payload.get("published_at"),
            "score": point.score,
        })

    return output


def delete_notices(ids: list[str]) -> tuple[int, int]:
    """Drop notices from the vector store in one request. Returns (deleted, failed).
    Blocking — callers must run it via asyncio.to_thread."""
    if not ids:
        return 0, 0
    point_ids = [str(uuid.uuid5(uuid.NAMESPACE_DNS, f"notice:{i}")) for i in ids]
    client = _client()
    try:
        client.delete(collection_name=COLLECTION, points_selector=point_ids)
        return len(point_ids), 0
    except Exception as e:
        logger.error("Failed to delete %d notices: %s", len(point_ids), e)
        return 0, len(point_ids)
