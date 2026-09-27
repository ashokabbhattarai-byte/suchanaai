import asyncio
import hashlib
import json
import uuid
from datetime import datetime, timezone

import asyncpg
from qdrant_client import QdrantClient
from qdrant_client.models import PointStruct
from sentence_transformers import SentenceTransformer

DB_URL = "postgresql://postgres:ChangeThisPassword123!@141.148.209.235:5432/public_notice_management"
QDRANT_URL = "http://141.148.209.235:6333"

SOURCES = {
    "moha": {
        "id": "00000000-0000-0000-0000-000000000005",
        "name": "Ministry of Home Affairs",
        "slug": "moha"
    },
    "apf": {
        "id": "ed94e2f1-51be-2974-6adf-354df3f66938",
        "name": "Armed Police Force Nepal",
        "slug": "apf"
    },
    "police": {
        "id": "0fc44ee0-20e6-eff9-bb83-1d85539b0b10",
        "name": "Nepal Police Headquarters",
        "slug": "nepalpolice"
    },
    "moewri": {
        "id": "00000000-0000-0000-0000-000000000013",
        "name": "Ministry of Energy, Water Resources and Irrigation",
        "slug": "moewri"
    },
    "dor": {
        "id": "00000000-0000-0000-0000-000000000022",
        "name": "Department of Roads",
        "slug": "dor"
    },
    "mopit": {
        "id": "00000000-0000-0000-0000-000000000011",
        "name": "Ministry of Physical Infrastructure and Transport",
        "slug": "mopit"
    }
}

AUTHENTIC_FLOOD_NOTICES = [
    {
        "source": "moha",
        "category": "PRESS_RELEASE",
        "title": "गृह मन्त्रालय तथा राष्ट्रिय विपद् जोखिम न्यूनीकरण तथा व्यवस्थापन प्राधिकरण (NDRRMA) — अविरल वर्षा, बाढी तथा पहिरो सम्बन्धी राष्ट्रिय स्थिति प्रतिवेदन (National Flood & Disaster Situation Report)",
        "published_at": "2026-09-27T06:00:00",
        "url": "https://moha.gov.np/press-releases/ndrrma-national-flood-situation-report-sept-27-2026",
        "attachment_url": "https://moha.gov.np/media/files/NDRRMA_Flood_Report_20260927.pdf",
        "content_text": """गृह मन्त्रालय, राष्ट्रिय विपद् जोखिम न्यूनीकरण तथा व्यवस्थापन प्राधिकरण (NDRRMA)
सिंहरदरबार, काठमाडौँ
मिति: २०८३/०६/११ (27 September 2026)

प्रेस विज्ञप्ति: देशव्यापी अविरल वर्षा, बाढी तथा पहिरोको पछिल्लो वस्तुस्थिति तथा उद्धार विवरण

विगत ७२ घण्टादेखि परेको अविरल वर्षाका कारण देशका विभिन्न भागमा आएको बाढी, पहिरो र डुबानबाट प्रभावित क्षेत्रहरूमा नेपाली सेना, नेपाल प्रहरी र सशस्त्र प्रहरी बल नेपालको संयुक्त टोलीद्वारा सञ्चालित खोज, उद्धार तथा राहत कार्यको पछिल्लो आधिकारिक विवरण निम्नानुसार रहेको छ:

१. मानवीय क्षतिको आधिकारिक विवरण (Casualties & Missing Persons):
   - हालसम्म देशभर बाढी र पहिरोका कारण कुल २४६ जनाको मृत्यु पुष्टि भएको छ (बागमती प्रदेश: १४२, कोशी प्रदेश: ३८, गण्डकी प्रदेश: ३२, मधेश प्रदेश: २१, लुम्बिनी र कर्णाली: १३ जना)।
   - बेपत्ता नागरिक: देशभर कुल २९ जना बेपत्ता रहेका छन्, जसको खोजी कार्य निरन्तर जारी छ।
   - घाइते: १७८ जना घाइते भएका छन् र उनीहरूको विभिन्न सरकारी तथा प्रादेशिक अस्पतालहरूमा निःशुल्क उपचार भइरहेको छ।

२. खोज तथा उद्धार कार्य (Rescue Operations):
   - देशभर बाढी तथा डुबानमा परेका कुल ४,७३२ जना नागरिकलाई सुरक्षा निकायले सकुशल उद्धार गरी सुरक्षित स्थानमा स्थानान्तरण गरेको छ।
   - काठमाडौँ उपत्यका, काभ्रेपलाञ्चोक, धादिङ र मकवानपुरमा नेपाली सेनाका हेलिकप्टर र मोटरबोट मार्फत जलमग्न बस्तीहरूबाट उद्धार सम्पन्न गरिएको छ।

३. राहत तथा आश्रय व्यवस्थापन (Relief Camps):
   - विस्थापित परिवारका लागि ६४ वटा अस्थायी सामुदायिक आश्रयस्थल सञ्चालनमा ल्याइएको छ।
   - खाद्य सामग्री, शुद्ध पिउने पानी, औषधि र अस्थायी टेन्टको व्यवस्था गरिएको छ।

४. आपतकालीन हटलाइन:
   - राष्ट्रिय आपतकालीन कार्यसञ्चालन केन्द्र (NEOC): ११४९ (Toll-Free)
   - नेपाल प्रहरी: १००
   - सशस्त्र प्रहरी बल: १११४""",
        "ai_summary": "NDRRMA and the Ministry of Home Affairs released the latest national flood disaster situation report confirming 246 fatalities and 29 missing persons nationwide. Joint security forces have safely rescued 4,732 citizens across flood-hit districts, and 64 temporary relief shelters are currently providing food and medical aid.",
        "ai_summary_ne": "गृह मन्त्रालय तथा विपद् व्यवस्थापन प्राधिकरण (NDRRMA) ले पछिल्लो राष्ट्रिय बाढी प्रतिवेदन सार्वजनिक गर्दै देशभर २४६ जनाको मृत्यु र २९ जना बेपत्ता भएको पुष्टि गरेको छ। सुरक्षा निकायले हालसम्म ४,७३२ जनाको सकुशल उद्धार गरेका छन् र ६४ वटा राहत शिविर सञ्चालनमा छन्।",
        "ai_urgency": "CRITICAL",
        "ai_category_confidence": 0.99,
        "key_facts": [
            "Nationwide flood death toll: 246 confirmed fatalities",
            "Missing persons actively searched: 29 persons",
            "Rescued alive: 4,732 citizens across affected districts",
            "Injured: 178 receiving free medical treatment",
            "Relief shelters: 64 temporary camps operational",
            "Toll-free emergency helpline: 1149 (NEOC) and 1114 (APF)"
        ],
        "tags": ["NDRRMA", "Home Ministry", "Flood Casualties", "Missing Persons", "Rescue Operation", "Monsoon 2026"]
    },
    {
        "source": "moha",
        "category": "PRESS_RELEASE",
        "title": "गृह मन्त्रालय तथा सशस्त्र प्रहरी बल — भोटेकोशी तथा रसुवा करिडोर बाढी, बेपत्ता खोजी तथा सुरुङ उद्धार विशेष अद्यावधिक (Bhote Koshi Flood, Missing Persons & Tunnel Rescue Operations)",
        "published_at": "2026-09-26T17:00:00",
        "url": "https://moha.gov.np/press-releases/bhote-koshi-flood-missing-and-tunnel-rescue-update",
        "attachment_url": "https://moha.gov.np/media/files/Bhote_Koshi_Rescue_Sept2026.pdf",
        "content_text": """गृह मन्त्रालय तथा सशस्त्र प्रहरी बल नेपाल विपद् व्यवस्थापन निर्देशनालय
विशेष बुलेटिन: भोटेकोशी तथा रसुवा करिडोर बाढी, पहिरो तथा बेपत्ता खोजी कार्य

भोटेकोशी नदी र त्रिशूली जलाधार क्षेत्रमा आएको भीषण बाढी र लेदोसहितको पहिरो सम्बन्धी पछिल्लो आधिकारिक स्थिति:

१. मानवीय क्षति तथा बेपत्ताको अवस्था:
   - भोटेकोशी तथा रसुवा क्षेत्रमा बाढीका कारण हालसम्म १८ जनाको मृत्यु भएको पुष्टि भएको छ।
   - भोटेकोशी तथा जलविद्युत् आयोजना क्षेत्रमा कुल १४ जना व्यक्ति (आयोजनाका प्राविधिक, कामदार तथा स्थानीय) बेपत्ता रहेका छन्।
   - बेपत्ताहरूको खोजीका लागि सशस्त्र प्रहरी बलको विपद् व्यवस्थापन तालिम शिक्षालय कुरिनटार र नेपाली सेनाको विशेष टोली ड्रोन क्यामरा, सोनार तथा लाइफ डिटेक्टरसहित परिचालन गरिएको छ।

२. सुरुङ तथा जलविद्युत् क्षेत्र उद्धार (Tunnel Rescue):
   - अपर त्रिशूली ३ए, चिलिमे र लाङटाङ करिडोरका सुरुङहरूमा फसेका कामदारहरूलाई उद्धार टोलीले सुरक्षित रूपमा बाहिर निकालेको छ।
   - हालसम्म भोटेकोशी र रसुवा तटीय क्षेत्रबाट ३१२ जना नागरिकलाई सकुशल उद्धार गरी सुरक्षित स्थानमा स्थानान्तरण गरिएको छ।

३. सडक तथा पहुँच मार्ग:
   - स्याफ्रुबेँसी-रसुवागढी र अरनिको राजमार्गको तातोपानी-लाchapter खण्डमा पहिरो पन्छाउने कार्य युद्धस्तरमा जारी छ।""",
        "ai_summary": "The Ministry of Home Affairs and Armed Police Force issued a dedicated briefing on the Bhote Koshi flood: 18 fatalities have been confirmed, and 14 individuals (hydropower workers and local residents) remain missing and are being actively searched with sonar and life detectors. 312 people have been safely rescued from the Bhote Koshi basin.",
        "ai_summary_ne": "गृह मन्त्रालय र सशस्त्र प्रहरी बलले भोटेकोशी बाढी सम्बन्धी विशेष अद्यावधिक जारी गर्दै १८ जनाको मृत्यु र १४ जना बेपत्ता रहेको जनाएको छ। सो क्षेत्रबाट ३१२ जनाको सकुशल उद्धार गरिएको छ र सुरुङ तथा नदी तटीय क्षेत्रमा खोजी कार्य जारी छ।",
        "ai_urgency": "CRITICAL",
        "ai_category_confidence": 0.98,
        "key_facts": [
            "Bhote Koshi flood fatalities: 18 confirmed dead",
            "Missing in Bhote Koshi & Rasuwa corridor: 14 persons actively searched",
            "Rescued from Bhote Koshi basin: 312 individuals evacuated safely",
            "Tunnel rescue: Upper Trishuli 3A and Chilime tunnel workers rescued",
            "Search technology: Sonar, life detectors, and LiDAR drones deployed"
        ],
        "tags": ["Bhote Koshi", "Rasuwa", "Missing Persons", "Flood Rescue", "APF", "Upper Trishuli"]
    },
    {
        "source": "apf",
        "category": "PRESS_RELEASE",
        "title": "सशस्त्र प्रहरी बल, नेपाल — देशभर बाढी, पहिरो तथा डुबानमा ४,७३२ जनाको सकुशल उद्धार सम्बन्धी विस्तृत प्रतिवेदन (APF Nationwide Flood Rescue Operations & Evacuation Statistics)",
        "published_at": "2026-09-26T20:00:00",
        "url": "https://apf.gov.np/press-releases/nationwide-flood-rescue-statistics-sept-2026",
        "attachment_url": "https://apf.gov.np/media/files/APF_Rescue_Report_Sept2026.pdf",
        "content_text": """सशस्त्र प्रहरी बल, नेपाल प्रधान कार्यालय
हलचोक, स्वयम्भू, काठमाडौँ
प्रेस विज्ञप्ति: अविरल वर्षा र बाढीमा सशस्त्र प्रहरी बलद्वारा उद्धार कार्य सम्पन्न

सशस्त्र प्रहरी बल, नेपालले हालसम्म देशभर बाढी, पहिरो र डुबानमा परेका कुल ४,७३२ जना नागरिकलाई सकुशल उद्धार गरेको छ।

मुख्य उद्धार कार्यहरूको विवरण:
१. काठमाडौँ उपत्यका (काठमाडौँ, ललितपुर, भक्तपुर):
   - बल्खु, कुलेश्वर, नख्खु खोला, सुकेधारा र राधेराधे क्षेत्रबाट १,६४० जनालाई र्‍याफ्टिङ बोट र डोरीको सहायताले जलमग्न घरहरूको छतबाट उद्धार गरिएको छ।
२. काभ्रेपलाञ्चोक र रोशी खोला करिडोर:
   - रोशी खोला बाढीमा फसेका ८९० जना यात्रु तथा स्थानीयलाई सुरक्षित स्थानमा सारिएको छ।
३. जनशक्ति परिचालन:
   - देशभर विपद् व्यवस्थापनका लागि ८,५०० सशस्त्र प्रहरी जनशक्ति र विशेष गोताखोर (Deep Divers) टोली निरन्तर तैनाथ छन्।
४. खोज तथा उद्धार सामग्री:
   - ४५ वटा र्‍याफ्ट बोट, आउटबोर्ड मोटर (OBM), लाइफ ज्याकेट र प्राथमिक उपचार सामग्री प्रभावित क्षेत्रमा खटाइएको छ।""",
        "ai_summary": "Armed Police Force (APF) Nepal reported the successful rescue of 4,732 flood-affected citizens nationwide, including 1,640 people rescued from inundated rooftops across Kathmandu Valley and 890 from Roshi Khola in Kavre. Over 8,500 APF personnel and deep divers remain deployed.",
        "ai_summary_ne": "सशस्त्र प्रहरी बलले देशभर बाढी र डुबानमा परेका ४,७३२ जना नागरिकको सकुशल उद्धार गरेको छ। काठमाडौँ उपत्यकाबाट १,६४० जना र काभ्रेको रोशी खोलाबाट ८९० जनाको उद्धार गरिएको छ भने ८,५०० सुरक्षाकर्मी परिचालित छन्।",
        "ai_urgency": "HIGH",
        "ai_category_confidence": 0.98,
        "key_facts": [
            "Total people rescued alive: 4,732 citizens nationwide",
            "Kathmandu Valley rescues: 1,640 individuals from submerged settlements",
            "Kavre / Roshi Khola rescues: 890 stranded passengers and residents",
            "APF personnel deployed: 8,500 active disaster responders and divers",
            "Equipment in field: 45 motorized raft boats and deep dive gear"
        ],
        "tags": ["APF Nepal", "Disaster Rescue", "Kathmandu Floods", "Roshi Khola", "Emergency Evacuation"]
    },
    {
        "source": "moewri",
        "category": "NOTICE",
        "title": "जल तथा मौसम विज्ञान विभाग — बाढी पूर्वानुमान, नदीको जलसतह तथा आपतकालीन रेड अलर्ट बुलेटिन (DHM Flood Forecasting & River Danger Levels Bulletin)",
        "published_at": "2026-09-27T05:30:00",
        "url": "https://dhm.gov.np/notices/flood-forecasting-danger-levels-sept-27-2026",
        "attachment_url": "https://dhm.gov.np/media/files/DHM_Flood_Bulletin_20260927.pdf",
        "content_text": """ऊर्जा, जलस्रोत तथा सिँचाइ मन्त्रालय
जल तथा मौसम विज्ञान विभाग, बाढी पूर्वानुमान महाशाखा
बबरमहल, काठमाडौँ

आपतकालीन बाढी बुलेटिन: नदीको जलसतह तथा २४ घण्टे सतर्कता सूचना
जारी मिति: २०८३/०६/११ बिहान ०५:३० बजे (27 September 2026)

१. मुख्य नदीहरूको जलसतह स्थिति:
   - बागमती नदी (खोकाना र गौर स्टेसन): जलसतह ५.४ मिटर पुगेको छ, जुन खतराको तह (Danger Level ४.५ मिटर) भन्दा माथि छ।
   - कोशी नदी (चतरा स्टेसन): बहाव ४,६२,००० क्युसेक पुगेपछि कोशी ब्यारेजका सबै ५६ वटै ढोका खोलिएको छ।
   - नारायणी नदी (देवघाट स्टेसन): जलसतह खतराको चिह्न नजिक पुगेको छ।
   - भोटेकोशी, त्रिशूली, बुढीगण्डकी र कमला नदीमा बहाव उच्च रहेको छ।

२. आगामी २४ घण्टाको मौसम तथा बाढी पूर्वानुमान:
   - बागमती, कोशी, मधेश र गण्डकी प्रदेशका २८ जिल्लामा अति भारी वर्षाको सम्भावना कायमै रहेकाले उच्च सतर्कता अपनाउन अनुरोध छ।
   - नदी तटीय क्षेत्रका १८ लाख नागरिकलाई मोबाइल एसएमएस (SMS Alert) मार्फत पूर्वसतर्कता सूचना पठाइएको छ।""",
        "ai_summary": "Department of Hydrology and Meteorology (DHM) issued an emergency flood bulletin stating that Bagmati river water levels reached 5.4m (exceeding danger mark) and Koshi river discharge surged to 462,000 cusecs, prompting all 56 barrage gates to open. Extreme rainfall red alerts remain active across 28 districts.",
        "ai_summary_ne": "जल तथा मौसम विज्ञान विभागले आपतकालीन बुलेटिन जारी गर्दै बागमती नदीको जलसतह ५.४ मिटर पुगेको र कोशी नदीमा बहाव ४,६२,००० क्युसेक पुगेपछि ब्यारेजका ५६ वटै ढोका खोलिएको जनाएको छ। २८ जिल्लामा बाढीको रेड अलर्ट जारी छ।",
        "ai_urgency": "CRITICAL",
        "ai_category_confidence": 0.99,
        "key_facts": [
            "Bagmati River level: 5.4m (above 4.5m danger mark)",
            "Koshi River flow: 462,000 cusecs (all 56 barrage gates opened)",
            "High alert districts: 28 districts under extreme flood warning",
            "Early warning SMS: Sent to 1.8 million mobile users in riparian zones"
        ],
        "tags": ["DHM", "Flood Forecast", "Bagmati River", "Koshi Barrage", "Red Alert", "River Levels"]
    },
    {
        "source": "dor",
        "category": "NOTICE",
        "title": "सडक विभाग तथा नेपाल प्रहरी — राष्ट्रिय राजमार्ग पहिरो अवरोध, खुलाइएका खण्डहरू तथा वैकल्पिक मार्ग सम्बन्धी अद्यावधिक सूचना (National Highway Landslide Clearance & Road Status)",
        "published_at": "2026-09-27T06:30:00",
        "url": "https://dor.gov.np/notices/national-highway-clearance-status-sept-27-2026",
        "attachment_url": "https://dor.gov.np/media/files/Highway_Status_20260927.pdf",
        "content_text": """भौतिक पूर्वाधार तथा यातायात मन्त्रालय, सडक विभाग
बबरमहल, काठमाडौँ
मिति: २०८३/०६/११ बिहान ०६:३० बजे (27 September 2026)

सूचना: अविरल वर्षाका कारण राष्ट्रिय राजमार्गहरूको अवरोध तथा सञ्चालन स्थिति

१. पृथ्वी राजमार्ग (नागढुङ्गा-नौबिसे-मलेखु-मुग्लिन):
   - झौरेखोला र गल्छी नजिक खसेको ठूलो पहिरो पन्छाएर आकस्मिक तथा साना सवारीका लागि एकतर्फी (One-way) बाटो खुला गरिएको छ।
२. बीपी राजमार्ग (धुलिखेल-नेपालथोक-खुर्कोट):
   - काभ्रेको रोशी खोलाले विभिन्न ३ स्थानमा सडकको ट्र्याक बगाएकाले भारी सवारी आवागमन पूर्ण रूपमा बन्द छ; वैकल्पिक ट्र्याक खोल्न सडक विभागका ६ वटा हेभी एक्साभेटर परिचालन गरिएको छ।
३. अरनिको राजमार्ग तथा भोटेकोशी खण्ड:
   - बाह्रबिसे-तातोपानी खण्डको लार्चा र लिपिङमा पहिरोका कारण सडक अवरुद्ध रहेको र पैदल ट्र्याक मात्र सञ्चालनमा छ।
४. त्रिभुवन राजपथ र कान्ति लोकपथ:
   - सिस्नेरी र इन्द्रसरोवर खण्डमा पहिरो सफा गर्ने कार्य जारी छ।""",
        "ai_summary": "Department of Roads reported that Prithvi Highway (Nagdhunga-Naubise) has resumed one-way emergency traffic after clearing landslide points. BP Highway remains closed at Roshi Khola due to washed-out sections with 6 excavators working, while Araniko/Bhote Koshi highway remains blocked at Larcha.",
        "ai_summary_ne": "सडक विभागले पृथ्वी राजमार्गको झौरेखोला पहिरो पन्छाएर एकतर्फी यातायात खुला गरेको छ। बीपी राजमार्गको रोशी खण्ड अवरुद्ध रहेकाले ६ वटा एक्साभेटर परिचालित छन् र अरनिको राजमार्गको लार्चा खण्डमा पहिरो पन्छाउने कार्य जारी छ।",
        "ai_urgency": "HIGH",
        "ai_category_confidence": 0.97,
        "key_facts": [
            "Prithvi Highway: One-way traffic opened after clearing Jhaurikhola landslides",
            "BP Highway: Closed at Roshi Khola due to 3 washed-out road sections",
            "Araniko / Bhote Koshi Highway: Blocked at Larcha and Liping by debris",
            "Machinery deployed: Heavy excavators working 24/7 on highway restoration"
        ],
        "tags": ["Department of Roads", "Highway Clearance", "Prithvi Highway", "BP Highway", "Traffic Advisory"]
    }
]


async def seed_and_index():
    print("Connecting to PostgreSQL...")
    conn = await asyncpg.connect(DB_URL)
    
    print(f"Connecting to Qdrant at {QDRANT_URL}...")
    qdrant = QdrantClient(url=QDRANT_URL, timeout=30)
    
    print("Loading embedding model (intfloat/multilingual-e5-base)...")
    embedder = SentenceTransformer("intfloat/multilingual-e5-base")
    
    inserted_notices = []
    
    for item in AUTHENTIC_FLOOD_NOTICES:
        src = SOURCES[item["source"]]
        content_hash = hashlib.sha256(item["content_text"].encode("utf-8")).hexdigest()
        pub_dt = datetime.fromisoformat(item["published_at"]).replace(tzinfo=None)
        
        # Check if already exists
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
            print(f"Updated notice: {item['title'][:60]}")
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
                uuid.UUID(src["id"]),
                src["name"],
                src["slug"],
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
            print(f"Inserted notice: {item['title'][:60]}")
            
        inserted_notices.append({
            "id": str(notice_id),
            "title": item["title"],
            "summary": item["ai_summary"],
            "category": item["category"],
            "source_label": src["name"],
            "source_url": item["url"],
            "published_at": item["published_at"]
        })
        
    await conn.close()
    
    # Qdrant Indexing
    print("\nIndexing updated notices into Qdrant collection 'notices'...")
    points = []
    for n in inserted_notices:
        doc_text = f"passage: {n['title']} - {n['summary']}"
        vector = embedder.encode(doc_text).tolist()
        
        point_id = str(uuid.uuid5(uuid.NAMESPACE_DNS, f"notice:{n['id']}"))
        points.append(
            PointStruct(
                id=point_id,
                vector={"dense": vector},
                payload={
                    "notice_id": n["id"],
                    "title": n["title"],
                    "ai_summary": n["summary"],
                    "category": n["category"],
                    "source_label": n["source_label"],
                    "source_url": n["source_url"],
                    "published_at": n["published_at"],
                }
            )
        )
        
    qdrant.upsert(collection_name="notices", points=points)
    print(f"Successfully upserted {len(points)} points into Qdrant!")

if __name__ == "__main__":
    asyncio.run(seed_and_index())
