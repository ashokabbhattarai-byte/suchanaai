"""Qdrant-backed vector store for scraped notices — separate from the 'documents'
collection used by user-uploaded RAG content. Stores one vector per notice (the
concatenation of title + aiSummary), enabling semantic search as a fallback
when PostgreSQL keyword search returns nothing useful."""

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


def ensure_collection() -> None:
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
        client.delete_collection(COLLECTION)

    logger.info(
        "Creating Qdrant collection '%s' (dense=%d cosine)",
        COLLECTION,
        config.EMBEDDING_DIM,
    )
    client.create_collection(
        collection_name=COLLECTION,
        vectors_config={
            DENSE_VECTOR: VectorParams(
                size=config.EMBEDDING_DIM, distance=Distance.COSINE
            )
        },
    )
    client.create_payload_index(
        collection_name=COLLECTION,
        field_name="notice_id",
        field_schema=PayloadSchemaType.KEYWORD,
    )
    client.create_payload_index(
        collection_name=COLLECTION,
        field_name="category",
        field_schema=PayloadSchemaType.KEYWORD,
    )


# The embedding model truncates around 512 tokens, so only the head of the body
# is worth embedding. The stored excerpt is longer because the LLM reads it as
# context, where more text is still useful.
_EMBED_CONTENT_CHARS = 1200
_EXCERPT_CHARS = 3000


def index_notice(
    notice_id: str,
    title: str,
    ai_summary: str,
    category: str = "",
    source_label: str = "",
    source_url: str = "",
    published_at: Optional[str] = None,
    content: str = "",
) -> bool:
    """Embed and upsert a single notice into the notices collection.
    Returns True on success, False on failure."""
    # Four out of five notices have no AI summary, so a title-only vector was
    # all most of the corpus could be matched on — and the answer context had
    # nothing but a title to work from. The body carries the actual facts.
    body = (content or "").strip()
    excerpt = body[:_EXCERPT_CHARS]
    text = "\n".join(p for p in (title, ai_summary, body[:_EMBED_CONTENT_CHARS]) if p)
    try:
        vector = embeddings.get_embedding(text, kind="passage")
    except Exception as e:
        logger.error("Failed to embed notice %s: %s", notice_id, e)
        return False

    point_id = str(uuid.uuid5(uuid.NAMESPACE_DNS, f"notice:{notice_id}"))
    payload = {
        "notice_id": notice_id,
        "title": title,
        "ai_summary": ai_summary,
        "content_excerpt": excerpt,
        "category": category,
        "source_label": source_label,
        "source_url": source_url,
    }
    if published_at:
        payload["published_at"] = published_at

    client = _client()
    try:
        ensure_collection()
        client.upsert(
            collection_name=COLLECTION,
            points=[PointStruct(id=point_id, vector={DENSE_VECTOR: vector}, payload=payload)],
        )
        logger.debug("Indexed notice %s into '%s'", notice_id, COLLECTION)
        return True
    except Exception as e:
        logger.error("Failed to index notice %s: %s", notice_id, e)
        return False


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


def delete_notice(notice_id: str) -> bool:
    client = _client()
    try:
        point_id = str(uuid.uuid5(uuid.NAMESPACE_DNS, f"notice:{notice_id}"))
        client.delete(
            collection_name=COLLECTION,
            points_selector=[point_id],
        )
        return True
    except Exception:
        return False
