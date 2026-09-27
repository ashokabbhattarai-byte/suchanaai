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

MOFA_NOTICE = {
    "source_id": "00000000-0000-0000-0000-000000000001",
    "source_label": "Ministry of Foreign Affairs (MOFA)",
    "source_slug": "mofa",
    "category": "PRESS_RELEASE",
    "title": "Daily Situation Update on Bhote Koshi River Floods on 26 August 2026 (Updated at 14:00 hrs NPT on 09 September 2026)",
    "published_at": "2026-09-09T14:00:00",
    "url": "https://mofa.gov.np/content/1882/daily-update-september-09/",
    "attachment_url": "https://mofa.gov.np/media/files/Bhote_Koshi_Daily_Update_09Sept2026.pdf",
    "content_text": """Ministry of Foreign Affairs, Singhadurbar, Kathmandu
Daily Situation Update on Bhote Koshi River Floods on 26 August 2026
(Updated at 14:00 hrs NPT on 09 September 2026)

The Government continues search and rescue operations today on the fifteenth day of the severe Bhote Koshi River Floods on 26 August 2026 that resulted in huge loss of lives, widespread displacement and extensive damage to houses, buildings, roads, bridges, hydropower facilities and other critical infrastructure in Rasuwa, Nuwakot, Dhading and other districts along the course of the river in Nepal.

Close coordination continues both domestically and with our neighbours and international partners for effective search, rescue and relief operations. The Rt. Hon. Prime Minister Mr Balendra Shah and the Hon. Foreign Minister Mr Shisir Khanal have received telephone calls from their respective counterparts and other dignitaries from around the world. They have expressed sympathies and solidarity as well as support to Nepal and Nepali people at this difficult time.

Search and Rescue:
The Government continues to mobilise all available means and resources at its disposal for search, rescue and relief operations. The National Disaster Risk Reduction and Management Authority (NDRRMA), the Nepali Army, Nepal Police, and Armed Police Force are fully mobilised alongside disaster-management authorities, provincial and local bodies and other relevant agencies.

Tunnel Rescue Teams:
Tunnel rescue teams from India, China and the Republic of Korea continue to work in coordination with the Nepali Army. Search and Rescue (SAR) team from the United Arab Emirates, the Special Malaysian Disaster Assistance and Rescue Team (SMART) and the Disaster Assistance and Response Team (DART) from Australia have also been supporting the operations. Rescue support equipment, drones, load carriers and materials received from neighbours and friendly countries are being used for these operations, while hopes of finding survivors remain and the reported number of people missing inside the tunnels remains unverified.
Parallel search and rescue operations continue at the affected hydropower projects, including Mailung Khola Hydropower Project, Upper Trishuli 1, Upper Trishuli 3A, Upper Trishuli 3B, Chilime, Rasuwagadhi and Langtang, among others.

Latest Official Casualty & Rescue Figures:
- Rescued: 13,646 people have been rescued so far, including over 300 foreigners. Three people have been rescued alive from the tunnels so far (2 Nepali nationals from Upper Trishuli 3A tunnel on 04 September 2026 and 1 Chinese national from Upper Trishuli 1 tunnel on 05 September 2026).
- Missing: Around 5,100 people still remain missing, including approximately 600 foreigners from 35 countries.
- Bodies recovered: 1,367 bodies have been recovered from the flood-affected areas.

Efforts to Restore Connectivity:
The authorities are actively working on restoring road, electricity and telecommunication connectivity to the affected areas and on ensuring timely delivery of relief materials to the affected people. Along the Galchhi–Trishuli road section, the Acrow Bridge installation over the Tadi River at Devighat has been completed in 15 bays, while installation of the remaining four bays is progressing rapidly. Similarly, the Nepali Army has initiated the construction of an approximately 250-meter suspension bridge connecting Trishuli Bazaar from the lower section of the Dhunge Buddha Temple.

Contributions and Disaster Fund:
Contributions for the search, rescue and relief efforts can be made through the link https://pmdrf.nchl.com.np/ to the Prime Minister’s Disaster Relief Fund (PMDRF).

DNA Identification Process:
Authorities concerned have temporarily buried recovered bodies, following necessary forensic procedures, to facilitate subsequent identification. Immediate family members of those missing are requested to contact Nepal Police Hospital, Maharajgunj, Kathmandu, or nearest District Police Office in Nepal, or email DNA profiles to dnacodis@nepalpolice.gov.np. Forensic teams from India, China, Japan, Singapore and the Republic of Korea have joined Nepal Police.

Nepali Nationals on China Side:
As of yesterday, a total of 736 Nepali nationals have returned to Nepal through the Tatopani border point, while 32 Nepali nationals are expected to return to Nepal today.

Emergency Control Room (ECR):
Emergency Hotline / WhatsApp: +977-9744441227, +977-9744441228 (6 am to 10 pm NST); Email: emergency@mofa.gov.np.

Ministry of Foreign Affairs
Singhadurbar, Kathmandu
09 September 2026""",
    "ai_summary": "On September 9, 2026, the Ministry of Foreign Affairs (MOFA) issued an official situation update on the 26 August Bhote Koshi floods: 13,646 people have been rescued (including 3 people rescued alive from hydropower tunnels), around 5,100 people remain missing (including 600 foreigners from 35 countries), and 1,367 bodies have been recovered. International tunnel rescue teams from India, China, Korea, UAE, Malaysia, and Australia are assisting on the ground.",
    "ai_summary_ne": "परराष्ट्र मन्त्रालयले भोटेकोशी बाढी (२६ अगस्ट २०२६) सम्बन्धी आधिकारिक स्थिति प्रतिवेदन जारी गर्दै हालसम्म १३,६४६ जनाको उद्धार गरिएको (जसमा सुरुङबाट ३ जना जीवित उद्धार), करिब ५,१०० जना बेपत्ता (६०० विदेशी नागरिकसहित) र १,३६७ शव फेला परेको पुष्टि गरेको छ। भारत, चीन, कोरिया, युएई, मलेसिया र अस्ट्रेलियाका उद्धार टोलीहरू परिचालित छन्।",
    "ai_urgency": "CRITICAL",
    "ai_category_confidence": 0.99,
    "key_facts": [
        "People rescued: 13,646 citizens rescued (including 300+ foreigners)",
        "Rescued alive from tunnels: 3 persons (2 Nepali in Upper Trishuli 3A, 1 Chinese in Upper Trishuli 1)",
        "Missing persons: Around 5,100 people (including ~600 foreigners from 35 countries)",
        "Bodies recovered: 1,367 fatalities confirmed",
        "International tunnel teams: India, China, South Korea, UAE, Malaysia (SMART), Australia (DART)",
        "Emergency Control Room helpline: +977-9744441227 / emergency@mofa.gov.np",
        "Disaster Relief Fund: https://pmdrf.nchl.com.np/"
    ],
    "tags": ["Bhote Koshi Floods", "MOFA", "Casualty Statistics", "Tunnel Rescue", "Missing Persons", "PMDRF"]
}

async def main():
    print("Connecting to PostgreSQL...")
    conn = await asyncpg.connect(DB_URL)
    
    item = MOFA_NOTICE
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
        print("Updated MOFA notice in DB.")
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
        print("Inserted MOFA notice into DB.")
        
    await conn.close()
    
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
    print("Upserted point into Qdrant successfully!")

if __name__ == "__main__":
    asyncio.run(main())
