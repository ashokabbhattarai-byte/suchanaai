import asyncio
import os
import time
import uuid
from dotenv import load_dotenv
import asyncpg
from qdrant_client import QdrantClient
from qdrant_client.models import PointStruct, VectorParams, Distance
from sentence_transformers import SentenceTransformer

load_dotenv("apps/api/.env")
DB_URL = os.environ.get("DATABASE_URL")
QDRANT_URL = "http://141.148.209.235:6333"

async def sync_qdrant():
    print("Connecting to PostgreSQL...")
    conn = await asyncpg.connect(DB_URL)
    
    rows = await conn.fetch(
        """
        SELECT id, title, category, source_label, source_url, ai_summary, effective_published_at, published_at
        FROM scraped_items
        WHERE ai_summary IS NOT NULL AND ai_summary != ''
        ORDER BY effective_published_at DESC
        """
    )
    print(f"Fetched {len(rows)} notices with AI summaries from database.")
    
    qdrant = QdrantClient(url=QDRANT_URL, timeout=120)
    
    print("Loading embedding model (intfloat/multilingual-e5-base)...")
    embedder = SentenceTransformer("intfloat/multilingual-e5-base")
    
    batch_size = 32
    total = len(rows)
    for i in range(0, total, batch_size):
        batch = rows[i : i + batch_size]
        texts = [f"passage: {r['title']} - {r['ai_summary']}" for r in batch]
        vectors = embedder.encode(texts, show_progress_bar=False).tolist()
        
        points = []
        for r, vec in zip(batch, vectors):
            pid = str(uuid.uuid5(uuid.NAMESPACE_DNS, f"notice:{r['id']}"))
            pub_dt = r["effective_published_at"] or r["published_at"]
            pub_str = pub_dt.isoformat() if pub_dt else None
            points.append(
                PointStruct(
                    id=pid,
                    vector={"dense": vec},
                    payload={
                        "notice_id": str(r["id"]),
                        "title": r["title"] or "",
                        "ai_summary": r["ai_summary"] or "",
                        "category": r["category"] or "",
                        "source_label": r["source_label"] or "",
                        "source_url": r["source_url"] or "",
                        "published_at": pub_str
                    }
                )
            )
            
        retries = 3
        while retries > 0:
            try:
                qdrant.upsert(collection_name="notices", points=points)
                break
            except Exception as e:
                retries -= 1
                print(f"Upsert failed ({e}), retrying in 2s...")
                time.sleep(2)
                
        print(f"Indexed {min(i + batch_size, total)}/{total} notices...")
        time.sleep(0.05)
        
    await conn.close()
    print("Qdrant collection 'notices' successfully synchronized!")

if __name__ == "__main__":
    asyncio.run(sync_qdrant())
