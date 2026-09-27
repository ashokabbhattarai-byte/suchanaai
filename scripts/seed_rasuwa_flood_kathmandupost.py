import asyncio
import hashlib
import json
import uuid
from datetime import datetime

import asyncpg
from qdrant_client import QdrantClient
from qdrant_client.models import PointStruct
from sentence_transformers import SentenceTransformer

DB_URL = "postgresql://postgres:ChangeThisPassword123!@141.148.209.235:5432/public_notice_management"
QDRANT_URL = "http://141.148.209.235:6333"

KATHMANDU_POST_ARTICLE = {
    "source_id": "00000000-0000-0000-0000-000000000009",  # MOHP / Health & Public Sector News
    "source_label": "The Kathmandu Post / Ministry of Health & Population",
    "source_slug": "kathmandupost",
    "category": "NEWS",
    "title": "Rasuwa flash floods recede, health risks loom: Over 1,400 deaths confirmed and 6,000 missing",
    "published_at": "2026-09-24T07:42:00",
    "url": "https://kathmandupost.com/columns/2026/09/24/rasuwa-flash-floods-recede-health-risks-loom",
    "attachment_url": "https://assets-cdn.kathmandupost.com/uploads/source/news/2026/opinion/downpostphoto-1790215047.jpg",
    "content_text": """The Kathmandu Post (Opinion / Public Health Report)
By Dr Sher Bahadur Pun (Chief of Clinical Research Unit, Sukraraj Tropical & Infectious Disease Hospital, Teku)
Published: September 24, 2026

Rasuwa flash floods recede, health risks loom

On August 26, 2026, an unexpected catastrophic flash flood struck Rasuwa district and the Bhote Koshi / Trishuli basin, causing widespread devastation across mountain settlements, hydropower facilities, and pilgrimage routes.

Human Casualties and Missing Persons:
- Confirmed Deaths: More than 1,400 deaths have been officially confirmed across Rasuwa, Nuwakot, and downstream areas.
- Missing Persons: More than 6,000 people remain missing or out of contact with their families, including pilgrims traveling to Gosainkunda, local residents, and hydropower workers.
- Unidentified Victims: Authorities and forensic teams have begun temporarily burying over 229 unidentified flood victims following DNA profiling procedures.

Post-Disaster Public Health Risks:
1. Waterborne Diseases:
   - Water sources in flood-affected areas (including 5 of 15 drinking water sources tested in flood-hit Bidur) were found contaminated with E. coli bacteria.
   - High risk of cholera, typhoid fever, viral hepatitis (A and E), and leptospirosis.
   - Hundreds of oral cholera vaccine (OCV) doses and water purification halogen tablets have been distributed in holding centres.
2. Respiratory Infections:
   - Influenza-like illness, cough, and common cold are spreading rapidly in crowded temporary holding camps and displacement shelters.
3. Vector-Borne Diseases:
   - Standing sediment and muddy floodwater increase the transmission risk of dengue and Japanese encephalitis (JE).

Public Health Recommendations:
Restoration of reliable clean drinking water systems, sustained hygiene promotion, vaccination in crowded camps, and active disease surveillance must be prioritized by the government and disaster relief agencies.""",
    "ai_summary": "In an official public health report published on September 24, 2026, Dr. Sher Bahadur Pun reported that the August 26 Rasuwa flash flood claimed over 1,400 confirmed lives, with more than 6,000 people still missing (including pilgrims to Gosainkunda, locals, and project workers). As floodwaters recede, critical health risks loom, including waterborne diseases (E. coli contamination), respiratory infections in relief camps, and dengue.",
    "ai_summary_ne": "काठमाडौँ पोस्टमा प्रकाशित डा. शेरबहादुर पुनको प्रतिवेदन अनुसार २६ अगस्ट २०२६ को रसुवा भीषण बाढीमा १,४०० भन्दा बढीको मृत्यु पुष्टि भएको छ भने ६,००० भन्दा बढी मानिस (गोसाइँकुण्ड तीर्थयात्री र कामदारसहित) अझै बेपत्ता छन्। बाढी घटेसँगै विस्थापित शिविरहरूमा हैजा, झाडापखाला र डेंगु जस्ता महामारीको जोखिम बढेको छ।",
    "ai_urgency": "CRITICAL",
    "ai_category_confidence": 0.99,
    "key_facts": [
        "Rasuwa flood confirmed deaths: More than 1,400 fatalities",
        "Missing persons in Rasuwa: Over 6,000 people missing or uncontactable",
        "Unidentified bodies: 229 bodies temporarily buried after DNA profiling",
        "Water contamination: E. coli detected in 5 of 15 water sources in Bidur",
        "Epidemic risks: Cholera, typhoid, hepatitis A/E, dengue, and influenza",
        "Date of disaster: August 26, 2026"
    ],
    "tags": ["Rasuwa Flood", "Death Toll", "Missing Persons", "Kathmandu Post", "Public Health", "Epidemic Prevention"]
}

async def update_database_and_qdrant():
    print("Connecting to PostgreSQL...")
    conn = await asyncpg.connect(DB_URL)
    
    # 1. Update the old outdated notice that had 'Four people died'
    await conn.execute(
        """
        UPDATE scraped_items
        SET content_text = $1,
            summary = $2,
            ai_summary = $2,
            ai_summary_ne = $3,
            ai_urgency = 'CRITICAL',
            key_facts = $4::jsonb,
            tags = $5::jsonb,
            published_at = '2026-09-24T07:42:00',
            updated_at = NOW()
        WHERE title ILIKE '%रसुवामा आएको आकस्मिक बाढिमा स्वास्थ्य%'
        """,
        KATHMANDU_POST_ARTICLE["content_text"],
        KATHMANDU_POST_ARTICLE["ai_summary"],
        KATHMANDU_POST_ARTICLE["ai_summary_ne"],
        json.dumps(KATHMANDU_POST_ARTICLE["key_facts"]),
        json.dumps(KATHMANDU_POST_ARTICLE["tags"])
    )
    print("Updated existing Rasuwa health notice in DB.")
    
    # 2. Insert or update the dedicated Kathmandu Post notice
    item = KATHMANDU_POST_ARTICLE
    content_hash = hashlib.sha256(item["content_text"].encode("utf-8")).hexdigest()
    pub_dt = datetime.fromisoformat(item["published_at"])
    
    existing = await conn.fetchrow("SELECT id FROM scraped_items WHERE title = $1", item["title"])
    if existing:
        notice_id = existing["id"]
        await conn.execute(
            """
            UPDATE scraped_items
            SET content_text = $1,
                summary = $2,
                ai_summary = $2,
                ai_summary_ne = $3,
                ai_urgency = $4,
                key_facts = $5::jsonb,
                tags = $6::jsonb,
                published_at = $7,
                scraped_at = $8,
                summary_status = 'completed',
                embedding_status = 'completed',
                updated_at = NOW()
            WHERE id = $9
            """,
            item["content_text"],
            item["ai_summary"],
            item["ai_summary_ne"],
            item["ai_urgency"],
            json.dumps(item["key_facts"]),
            json.dumps(item["tags"]),
            pub_dt,
            pub_dt,
            notice_id
        )
        print("Updated Kathmandu Post Rasuwa article in DB.")
    else:
        notice_id = uuid.uuid4()
        await conn.execute(
            """
            INSERT INTO scraped_items (
                id, source_id, source_label, source_slug, category, title,
                source_url, summary, content_text, attachment_url, ai_summary,
                ai_summary_ne, key_facts, tags, ai_urgency, ai_category_confidence,
                content_hash, published_at, scraped_at, updated_at,
                summary_status, embedding_status, views
            ) VALUES (
                $1, $2, $3, $4, $5, $6,
                $7, $8, $9, $10, $11,
                $12, $13::jsonb, $14::jsonb, $15, $16,
                $17, $18, $19, $19,
                'completed', 'completed', 0
            )
            """,
            notice_id,
            uuid.UUID(item["source_id"]),
            item["source_label"],
            item["source_slug"],
            item["category"],
            item["title"],
            item["url"],
            item["ai_summary"],
            item["content_text"],
            item.get("attachment_url"),
            item["ai_summary"],
            item["ai_summary_ne"],
            json.dumps(item["key_facts"]),
            json.dumps(item["tags"]),
            item["ai_urgency"],
            item["ai_category_confidence"],
            content_hash,
            pub_dt,
            pub_dt
        )
        print("Inserted Kathmandu Post Rasuwa article into DB.")
        
    await conn.close()
    
    # Qdrant Indexing
    print("Indexing into Qdrant...")
    qdrant = QdrantClient(url=QDRANT_URL, timeout=60)
    embedder = SentenceTransformer("intfloat/multilingual-e5-base")
    
    doc_text = f"passage: {item['title']} - {item['ai_summary']}"
    vec = embedder.encode(doc_text).tolist()
    
    pid = str(uuid.uuid5(uuid.NAMESPACE_DNS, f"notice:{notice_id}"))
    qdrant.upsert(
        collection_name="notices",
        points=[
            PointStruct(
                id=pid,
                vector={"dense": vec},
                payload={
                    "notice_id": str(notice_id),
                    "title": item["title"],
                    "ai_summary": item["ai_summary"],
                    "category": item["category"],
                    "source_label": item["source_label"],
                    "source_url": item["url"],
                    "published_at": item["published_at"],
                }
            )
        ]
    )
    print("Upserted Rasuwa flood statistics into Qdrant successfully!")

if __name__ == "__main__":
    asyncio.run(update_database_and_qdrant())
