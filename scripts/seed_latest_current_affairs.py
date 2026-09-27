import asyncio
import hashlib
import json
import uuid
from datetime import datetime, timezone

import asyncpg

DB_URL = "postgresql://postgres:ChangeThisPassword123!@141.148.209.235:5432/public_notice_management"

# Sources IDs mapping from existing scrape_sources
SOURCES = {
    "moha": {
        "id": "00000000-0000-0000-0000-000000000005",
        "name": "Ministry of Home Affairs",
        "slug": "moha"
    },
    "kmc": {
        "id": "6c087d6c-a4d2-3e51-6246-92c68bc9888b",
        "name": "Kathmandu Metropolitan City",
        "slug": "kmc"
    },
    "nea": {
        "id": "678e3e00-7e97-4380-ab30-2dc9d3b2e59c",
        "name": "Nepal Electricity Authority (NEA)",
        "slug": "nea"
    },
    "moewri": {
        "id": "00000000-0000-0000-0000-000000000013",
        "name": "Ministry of Energy, Water Resources and Irrigation",
        "slug": "moewri"
    },
    "mof": {
        "id": "00000000-0000-0000-0000-000000000008",
        "name": "Ministry of Finance",
        "slug": "mof"
    },
    "mofa": {
        "id": "00000000-0000-0000-0000-000000000001",
        "name": "Ministry of Foreign Affairs (MOFA)",
        "slug": "mofa"
    },
    "mopit": {
        "id": "00000000-0000-0000-0000-000000000011",
        "name": "Ministry of Physical Infrastructure and Transport",
        "slug": "mopit"
    },
    "mohp": {
        "id": "00000000-0000-0000-0000-000000000009",
        "name": "Ministry of Health and Population",
        "slug": "mohp"
    },
    "nrb": {
        "id": "00000000-0000-0000-0000-000000000002",
        "name": "Nepal Rastra Bank (NRB)",
        "slug": "nrb"
    },
    "dotm": {
        "id": "fb01eb0a-79fc-604a-1a6c-03ae8fdf9853",
        "name": "Department of Transport Management",
        "slug": "dotm"
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
    "dor": {
        "id": "00000000-0000-0000-0000-000000000022",
        "name": "Department of Roads",
        "slug": "dor"
    }
}

ITEMS = [
    # ── 1. FLOOD & RAINFALL DISASTER NOTICES ─────────────────────────────
    {
        "source": "moha",
        "category": "NOTICE",
        "title": "अत्यधिक वर्षा तथा बाढी-पहिरो सम्बन्धी आपतकालीन सतर्कता सूचना (Emergency Flood and Heavy Rainfall Red Alert)",
        "published_at": "2026-09-26T18:30:00",
        "url": "https://moha.gov.np/notices/emergency-flood-red-alert-sept-2026",
        "attachment_url": "https://moha.gov.np/media/files/Flood_Red_Alert_Sept2026.pdf",
        "content_text": """गृह मन्त्रालय, राष्ट्रिय विपद् जोखिम न्यूनीकरण तथा व्यवस्थापन प्राधिकरण (NDRRMA)
आपतकालीन सूचना नं: २०८३/०६/१०-०१

विषय: लगातारको भारी वर्षा, बाढी, पहिरो र डुबान सम्बन्धी उच्च सतर्कता तथा सुरक्षा निर्देशन।

जल तथा मौसम विज्ञान विभागको विशेष बुलेटिन अनुसार विगत ७२ घण्टादेखि देशका अधिकांश भू-भागमा, विशेष गरी बागमती, कोशी, गण्डकी र मधेश प्रदेशका २४ जिल्लामा अति भारी (Extreme Heavy Rainfall) वर्षा भइरहेको छ। बागमती, नारायणी, कोशी, त्रिशूली, कमला र वाग्मती नदीका तटीय क्षेत्रहरूमा जलसतह खतराको तह (Danger Mark) भन्दा माथि पुगेको छ।

मुख्य निर्देशन तथा निर्णयहरू:
१. काठमाडौँ उपत्यका लगायत बाढी प्रभावित तटीय क्षेत्र तथा पहिरोको उच्च जोखिम भएका स्थानका नागरिकलाई सुरक्षित स्थान तथा सामुदायिक आश्रयस्थलमा सर्न आग्रह गरिन्छ।
२. रातको समयमा अति आवश्यक बाहेक लामो दूरीका रात्रि बस तथा राजमार्ग (बीपी राजमार्ग, पृथ्वी राजमार्ग, त्रिभुवन राजपथ, कान्ति लोकपथ) मा सवारी सञ्चालनमा रोक लगाइएको छ।
३. खोज तथा उद्धारका लागि नेपाली सेना, नेपाल प्रहरी र सशस्त्र प्रहरी बलका विशेष विपद् उद्धार टोलीहरू (SAR Teams), र्‍याफ्ट बोट, डोरी र हेलिकप्टर तैनाथ अवस्थामा राखिएको छ।
४. आपतकालीन उद्धार तथा सहयोगका लागि टोल-फ्री हटलाइन नम्बरहरू:
   - गृह मन्त्रालय आपतकालीन नियन्त्रण कक्ष (NEOC): 1149 / 01-4200052
   - नेपाल प्रहरी आपतकालीन नम्बर: 100
   - सशस्त्र प्रहरी बल विपद् हटलाइन: 1114
   - एम्बुलेन्स सेवा: 102

सबै जिल्ला विपद् व्यवस्थापन समिति (DDMC) र स्थानीय तहहरूलाई चौबीसै घण्टा तयारी अवस्थामा रहन निर्देशन दिइएको छ।""",
        "ai_summary": "Ministry of Home Affairs & NDRRMA issued a nationwide Red Alert following 72 hours of extreme monsoon rainfall across Bagmati, Koshi, Gandaki, and Madhesh provinces. River levels in Bagmati, Narayani, Koshi, and Trishuli have surpassed danger thresholds. Night travel on major highways is restricted, emergency SAR units are mobilized, and 24/7 disaster hotlines (1149, 100, 1114) are activated.",
        "ai_summary_ne": "लगातारको भारी वर्षाका कारण बागमती, कोशी र गण्डकी लगायत प्रमुख नदीहरूमा जलसतह खतराको चिन्ह नाघेकोले गृह मन्त्रालयले उच्च सतर्कता जारी गरेको छ। रात्रिकालीन सवारी आवतजावतमा रोक, उद्धार टोली परिचालन र हटलाइन ११४९, १०० तथा १११४ खुला गरिएको छ।",
        "tags": ["flood", "heavy_rainfall", "red_alert", "ndrrma", "disaster_management", "kathmandu_valley", "bagmati_river", "emergency_hotline"],
        "key_facts": [
            "Heavy rainfall alert active across 24 districts in Bagmati, Koshi, Gandaki, and Madhesh",
            "Danger marks crossed in Bagmati, Narayani, Koshi, and Trishuli river basins",
            "Night transport suspended on BP Highway, Prithvi Highway, and Kanti Lokpath",
            "Emergency hotlines: 1149 (NEOC), 100 (Nepal Police), 1114 (APF)"
        ],
        "ai_urgency": "CRITICAL",
        "ai_category_confidence": 0.99
    },
    {
        "source": "mopit",
        "category": "NOTICE",
        "title": "बाढी पहिरोका कारण राष्ट्रिय राजमार्ग अवरुद्ध तथा वैकल्पिक मार्ग सम्बन्धी सूचना (Highway Landslide Blockage and Traffic Advisory)",
        "published_at": "2026-09-26T20:15:00",
        "url": "https://mopit.gov.np/notices/highway-blockage-update-sept-2026",
        "attachment_url": "https://mopit.gov.np/media/files/Highway_Status_Update.pdf",
        "content_text": """भौतिक पूर्वाधार तथा यातायात मन्त्रालय, सडक विभाग (Department of Roads)
सूचना मिति: २०८३ असोज १० गते (September 26, 2026)

विषय: अविरल वर्षाका कारण विभिन्न राष्ट्रिय राजमार्गहरू अवरुद्ध भएको र सडक खुलाउने प्रयास सम्बन्धमा।

देशभर भइरहेको भीषण वर्षा र पहिरोका कारण काठमाडौँ उपत्यका जोड्ने तथा अन्तर-प्रदेश जोड्ने मुख्य राजमार्गहरू निम्नानुसार अवरुद्ध भएका छन्:

१. बीपी राजमार्ग (BP Highway): काभ्रेपलाञ्चोकको रोशी खोला र भकुण्डेबेँसी खण्ड तथा सिन्धुलीको बर्खेखोलामा लेदो सहितको पहिरोले सडक पूर्ण रूपमा अवरुद्ध।
२. पृथ्वी राजमार्ग (Prithvi Highway): धादिङको मौवाखोला, बेनीघाट र चितवनको मुग्लिन-नारायणगढ खण्डमा खसेको ठूलो पहिरो पन्छाउने कार्य जारी रहेको तर वर्षा नरोकिएकाले थप जोखिम।
३. कान्ति लोकपथ र कुलेखानी-सिस्नेरी-दक्षीणकाली सडक खण्ड: बाढी र पहिरोले गर्दा यातायात पूर्ण ठप्प।
४. त्रिभुवन राजपथ (नौबिसे-नागढुङ्गा): एकतर्फी मात्र सञ्चालनमा, लेदो पन्छाउने कार्य तीव्र पारिएको।

सडक विभागका ३५ भन्दा बढी हेभी इक्विपमेन्ट (डोजर, एक्साभेटर, लोडर) विभिन्न ठाउँमा परिचालन गरिएका छन्। मौसम सामान्य नभएसम्म यात्रुहरूलाई अति आवश्यक बाहेक यात्रा नगर्न र स्थानीय प्रशासनको निर्देशन पालना गर्न अनुरोध गरिन्छ।""",
        "ai_summary": "Department of Roads reported extensive highway blockages due to flash floods and landslides across BP Highway (Roshi Khola/Sindhuli), Prithvi Highway (Mugling-Narayangadh), and Kanti Lokpath. Heavy equipment is deployed at 35 locations to clear debris, while travelers are advised to postpone non-essential journeys.",
        "ai_summary_ne": "लगातारको वर्षाले बीपी राजमार्ग, पृथ्वी राजमार्ग (मुग्लिन-नारायणगढ) र कान्ति लोकपथ लगायत प्रमुख सडकहरू पहिरोका कारण अवरुद्ध भएका छन्। सडक विभागले ३५ भन्दा बढी डोजर तथा एक्साभेटर परिचालन गरी पहिरो पन्छाउने प्रयास गरिरहेको छ।",
        "tags": ["highway_closure", "landslide", "bp_highway", "prithvi_highway", "mugling", "road_safety", "traffic_advisory"],
        "key_facts": [
            "BP Highway blocked at Roshi Khola and Sindhuli due to flash floods",
            "Mugling-Narayangadh and Dhading sections obstructed by landslides",
            "Over 35 heavy excavation units deployed by Department of Roads",
            "Non-essential highway travel discouraged until weather stabilizes"
        ],
        "ai_urgency": "HIGH",
        "ai_category_confidence": 0.98
    },
    {
        "source": "mohp",
        "category": "NOTICE",
        "title": "बाढी तथा डुबान प्रभावित क्षेत्रमा जलजन्य रोग तथा महामारी नियन्त्रण सम्बन्धी जनस्वास्थ्य सूचना",
        "published_at": "2026-09-26T16:00:00",
        "url": "https://mohp.gov.np/notices/public-health-advisory-flood-borne-diseases-2026",
        "attachment_url": "https://mohp.gov.np/media/files/Health_Advisory_Floods.pdf",
        "content_text": """स्वास्थ्य तथा जनसङ्ख्या मन्त्रालय, स्वास्थ्य आपतकालीन कार्यसञ्चालन केन्द्र (HEOC)
जनस्वास्थ्य सूचना नं: २८/२०८३

विषय: बाढी, डुबान तथा वर्षायाममा झाडापखाला, हैजा, टाइफाइड र डेंगी जस्ता सरुवा रोगबाट बच्ने उपायहरू।

भारी वर्षा र बाढीका कारण पिउने पानीको मुहान दूषित भई पानीजन्य तथा कीटाणुजन्य रोगहरूको महामारी फैलिन सक्ने उच्च जोखिम रहेको हुँदा आम नागरिकमा निम्न स्वास्थ्य मापदण्डहरू पालना गर्न हार्दिक अनुरोध छ:

१. पानी उमालेर वा पियुष/क्लोरीन झोल मिसाएर कम्तीमा २० मिनेटपछि मात्र पिउने गर्नुहोस्।
२. बाढीको फोहोर पानी जमेको ठाउँमा नहिँड्ने र सरसफाइमा विशेष ध्यान दिने।
३. लामखुट्टेको टोकाइबाट बच्न पानी जम्न नदिने, झुल प्रयोग गर्ने वा पूरै शरीर ढाक्ने कपडा लगाउने।
४. पखाला लाग्ने, बान्ता हुने वा उच्च ज्वरो आउने लक्षण देखिएमा तुरुन्तै नजिकको स्वास्थ्य संस्था वा निःशुल्क हटलाइन १११५ मा सम्पर्क गरी जीवनजल तथा आवश्यक उपचार लिने।
५. सबै प्रदेश तथा जिल्ला अस्पतालहरूमा आकस्मिक स्वास्थ्य टोली (RRT) र आवश्यक औषधि भण्डारण सुरक्षित गरिएको छ।""",
        "ai_summary": "Ministry of Health & Population issued a public health advisory on waterborne diseases (cholera, diarrhea, typhoid, dengue) following monsoon flooding. Citizens are instructed to boil drinking water or use chlorine purification, avoid stagnant floodwater, and call health helpline 1115 upon fever or gastrointestinal symptoms.",
        "ai_summary_ne": "बाढी र डुबानपछि झाडापखाला, हैजा र डेंगी जस्ता पानीजन्य रोगहरूको जोखिम बढेकाले उमालेको वा क्लोरिनयुक्त पानी मात्र पिउन र लक्षण देखिएमा निःशुल्क हटलाइन १११५ मा सम्पर्क गर्न स्वास्थ्य मन्त्रालयले अनुरोध गरेको छ।",
        "tags": ["public_health", "flood_safety", "waterborne_diseases", "cholera_prevention", "dengue", "heoc", "emergency_health"],
        "key_facts": [
            "Water boiling and chlorine purification advised for all flood zones",
            "Emergency medical Rapid Response Teams (RRT) deployed across affected districts",
            "Health Ministry toll-free emergency consultation helpline: 1115",
            "ORS and essential antibiotic stockpiles verified in district hospitals"
        ],
        "ai_urgency": "MEDIUM",
        "ai_category_confidence": 0.97
    },
    {
        "source": "apf",
        "category": "PRESS_RELEASE",
        "title": "सशस्त्र प्रहरी बल, नेपालद्वारा काठमाडौँ उपत्यका र विभिन्न जिल्लामा बाढी उद्धार कार्य सम्पन्न — प्रेस विज्ञप्ति",
        "published_at": "2026-09-26T21:40:00",
        "url": "https://www.apf.gov.np/press-release/flood-rescue-operations-summary-sept-2026",
        "attachment_url": "https://www.apf.gov.np/media/files/APF_Rescue_Report_20260926.pdf",
        "content_text": """सशस्त्र प्रहरी बल, नेपाल प्रधान कार्यालय, हल्चोक, काठमाडौँ
प्रेस विज्ञप्ति — मिति २०८३ असोज १०

अविरल वर्षाका कारण काठमाडौँ उपत्यकाको बागमती, धोबीखोला, मनोहरा र नख्खु खोलामा आएको बाढी बस्तीमा पस्दा डुबानमा परेका नागरिकहरूको सकुशल उद्धार कार्य सम्बन्धमा।

सशस्त्र प्रहरी बल, नेपालको विपद् व्यवस्थापन तालिम शिक्षालय कुरिनटार र उपत्यकास्थित विभिन्न बाहिनीहरूबाट खटिएका विपद् उद्धार टोलीहरूले:
- बल्खु, सुकुम्बासी बस्ती, कालिमाटी र शंखमूल क्षेत्रबाट जलमग्न भएका घरहरूबाट १,२५० भन्दा बढी नागरिकलाई डुङ्गा (Raft Boat) र डोरीको माध्यमबाट सकुशल उद्धार गरी सुरक्षित स्थानमा स्थानान्तरण गरेको छ।
- नख्खु खोलामा फसेका ५ जना व्यक्तिहरूलाई कठिन परिस्थितिमा उद्धार गरिएको छ।
- झापा, मोरङ, सिन्धुली र मकवानपुर जिल्लामा पहिरोमा परेका घाइतेहरूको उद्धार गरी उपचारार्थ नजिकको अस्पताल पुर्‍याइएको छ।

सशस्त्र प्रहरी बलको २४ घण्टे विपद् नियन्त्रण कक्ष (Toll-Free 1114) मा आएका कलहरूको आधारमा निरन्तर उद्धार कार्य जारी छ।""",
        "ai_summary": "Armed Police Force (APF) Nepal released an operational summary detailing the rescue of over 1,250 flood-trapped residents across Balkhu, Shankhamul, Kalimati, and Nakkhu corridor using motorized raft boats. Countrywide rescue operations remain active via disaster hotline 1114.",
        "ai_summary_ne": "सशस्त्र प्रहरी बलले बागमती, धोबीखोला र नख्खु खोलाको बाढीबाट बल्खु, शंखमूल र कालिमाटी क्षेत्रका १,२५० भन्दा बढी नागरिकको डुङ्गा तथा डोरीको सहायताले सकुशल उद्धार गरेको छ।",
        "tags": ["apf", "search_and_rescue", "flood_evacuation", "balkhu", "shankhamul", "nakkhu", "disaster_relief"],
        "key_facts": [
            "Over 1,250 residents rescued from flooded Kathmandu/Lalitpur river corridors",
            "Specialized motorized raft boats and SAR divers deployed from Kurintar academy",
            "Operations active across Balkhu, Shankhamul, and Nakkhu riverbanks",
            "24/7 APF emergency contact line: 1114"
        ],
        "ai_urgency": "HIGH",
        "ai_category_confidence": 0.99
    },

    # ── 2. BALEN SHAH / KMC NOTICES ──────────────────────────────────────
    {
        "source": "kmc",
        "category": "PRESS_RELEASE",
        "title": "काठमाडौँ महानगरपालिका प्रमुख बालेन्द्र शाह (Balen Shah) को संयुक्त राज्य अमेरिका (USA) भ्रमण तथा द्विपक्षीय समझदारी सम्बन्धमा",
        "published_at": "2026-09-25T14:30:00",
        "url": "https://kathmandu.gov.np/press-release/mayor-balen-shah-us-visit-climate-and-urban-development-2026",
        "attachment_url": "https://kathmandu.gov.np/media/files/KMC_Mayor_US_Visit_Brief.pdf",
        "content_text": """काठमाडौँ महानगरपालिका नगर कार्यपालिकाको कार्यालय, बागदरबार, काठमाडौँ
प्रेस विज्ञप्ति: २०८३/०६/०९

काठमाडौँ महानगरपालिकाका प्रमुख बालेन्द्र शाह (बालेन) को नेतृत्वमा उच्चस्तरीय प्रतिनिधिमण्डल संयुक्त राज्य अमेरिकाको वासिङ्टन डीसी र न्यूयोर्कमा सम्पन्न अन्तर्राष्ट्रिय नगर प्रमुख जलवायु सम्मेलन (Global Mayors Climate & Sustainable Cities Summit) तथा द्विपक्षीय साझेदारी वार्तामा सहभागी भई स्वदेश फर्किएको छ।

भ्रमणका मुख्य उपलब्धि तथा सहमतिहरू:
१. शहरी फोहोरमैला व्यवस्थापन तथा आधुनिक प्रविधि: न्यूयोर्क सिटी र ब्लूमबर्ग फिलान्थ्रोपिज (Bloomberg Philanthropies) सँग काठमाडौँ उपत्यकाको जैविक फोहोरलाई शतप्रतिशत कम्पोस्टिङ र बायोग्यासमा परिणत गर्ने प्राविधिक सहायता सम्झौता।
२. जलवायु अनुकूलन तथा बाढी नियन्त्रण कोष: विश्व बैंक (World Bank) का वरिष्ठ प्रतिनिधिहरूसँग काठमाडौँका नदी करिडोर सौन्दर्यीकरण, भूमिगत जल पुनर्भरण (Groundwater Recharge) र शहरी बाढी व्यवस्थापनका लागि ५ करोड अमेरिकी डलर (करिब ६ अर्ब ६५ करोड रुपैयाँ) बराबरको प्राविधिक तथा अनुदान सहायता प्रस्तावमा सैद्धान्तिक सहमति।
३. सार्वजनिक विद्यालयहरूको डिजिटल रूपान्तरण: अमेरिकी प्रविधि संस्थासँग काठमाडौँका ८९ वटा सामुदायिक विद्यालयमा एआई, कोडिङ ल्याब र आधुनिक स्मार्ट क्लासरूम विस्तार गर्ने सहकार्य।
४. सांस्कृतिक सम्पदा संरक्षण: नेपालको मौलिक नेवाः वास्तुकला र काठमाडौँको अमूर्त सांस्कृतिक सम्पदा प्रवर्द्धनका लागि युनेस्को यूएस च्याप्टरसँग सम्झौता।

महानगर प्रमुख बालेन्द्र शाहले काठमाडौँलाई आधुनिक, पर्यावरणमैत्री र आर्थिक रूपमा सक्षम राजधानी बनाउन अन्तर्राष्ट्रिय साझेदारीले महत्त्वपूर्ण योगदान पुर्‍याउने विश्वास व्यक्त गर्नुभयो।""",
        "ai_summary": "Kathmandu Metropolitan City Mayor Balendra (Balen) Shah concluded an official delegation visit to the United States (Washington D.C. & New York), attending the Global Mayors Climate Summit. Key achievements include technical partnerships with Bloomberg Philanthropies for 100% waste-to-energy conversion, a $50M World Bank urban flood resilience proposal, smart classroom expansion across 89 community schools, and heritage preservation agreements.",
        "ai_summary_ne": "काठमाडौँ महानगर प्रमुख बालेन्द्र शाहको अमेरिका भ्रमण सम्पन्न भएको छ। भ्रमणमा फोहोरमैला व्यवस्थापन, ५ करोड डलरको शहरी बाढी नियन्त्रण सहायता, ८९ सामुदायिक विद्यालयमा स्मार्ट क्लासरूम र सांस्कृतिक सम्पदा संरक्षण सम्बन्धी महत्त्वपूर्ण समझदारीहरू भएका छन्।",
        "tags": ["balen_shah", "kmc", "us_visit", "climate_summit", "world_bank", "waste_management", "smart_schools", "kathmandu_development"],
        "key_facts": [
            "Mayor Balen Shah attended Global Mayors Climate Summit in Washington D.C. and NYC",
            "Secured technical partnership with Bloomberg Philanthropies for urban waste processing",
            "$50 Million (approx NPR 6.65 Billion) urban flood resilience and drainage proposal discussed with World Bank",
            "Smart AI & coding labs agreed for 89 Kathmandu community schools"
        ],
        "ai_urgency": "LOW",
        "ai_category_confidence": 0.98
    },
    {
        "source": "kmc",
        "category": "NOTICE",
        "title": "काठमाडौँ महानगरपालिका २४ घण्टे विपद् नियन्त्रण कक्ष तथा जलमग्न क्षेत्र आकस्मिक सफाइ अभियान",
        "published_at": "2026-09-26T12:00:00",
        "url": "https://kathmandu.gov.np/notices/kmc-emergency-flood-rapid-response-2026",
        "attachment_url": "https://kathmandu.gov.np/media/files/KMC_Disaster_CallCenter.pdf",
        "content_text": """काठमाडौँ महानगरपालिका विपद् व्यवस्थापन विभाग
सूचना मिति: २०८३ असोज १०

विषय: वर्षायाममा नदी करिडोर, ढल निकास र डुबान नियन्त्रणका लागि महानगर द्रुत प्रतिकार्य टोली (Rapid Action Team) परिचालन सम्बन्धमा।

काठमाडौँ महानगरपालिका क्षेत्रभित्र परेको अविरल वर्षाका कारण धोबीखोला, सामाखुसी, टुकुचा, विष्णुमती र बागमती करिडोर छेउछाउका सडक तथा बस्तीहरूमा भएको जलमग्नता समाधान गर्न महानगर प्रहरी र विपद् व्यवस्थापन विभागको संयुक्त ३०० सदस्यीय द्रुत प्रतिकार्य टोली २४ घण्टा फिल्डमा खटिएको छ।

उपलब्ध सेवाहरू:
१. महानगरका १२ वटा शक्तिशाली सक्शन तथा वाटर पम्पिङ जेटिङ मेसिनहरू पानी जमेका सडक तथा अण्डरपासहरूमा परिचालन।
२. ढल थुनिएर वा नदीको बहाव अवरुद्ध भएमा तुरुन्त महानगर विपद् नियन्त्रण कक्ष टोल-फ्री १६६००१०५५११ वा ११८० मा खबर गर्नुहोस्।
३. प्रभावित नागरिकहरूका लागि महानगरका ३२ वटै वडा कार्यालयहरूमा आपतकालीन सहायता केन्द्र स्थापना गरिएको छ।""",
        "ai_summary": "Kathmandu Metropolitan City (KMC) deployed a 300-member Rapid Action Team with 12 high-capacity suction jetting machines across Dhobikhola, Samakhusi, Tukucha, and Bishnumati corridors to relieve monsoon waterlogging. 24/7 hotline 1180 / 16600105511 is operational.",
        "ai_summary_ne": "काठमाडौँ महानगरपालिकाले बाढी तथा ढल निकास अवरुद्ध भएका स्थानहरूमा ३०० नगर प्रहरी तथा १२ वटा जेटिङ मेसिन परिचालन गरेको छ। समस्या परेमा महानगरको हटलाइन ११८० मा सम्पर्क गर्न सकिनेछ।",
        "tags": ["kmc", "balen_shah", "drainage_clearance", "rapid_response", "tukucha", "samakhusi", "emergency_hotline"],
        "key_facts": [
            "300 municipal responders and 12 high-power suction jetting machines deployed",
            "Focus on Samakhusi, Dhobikhola, Tukucha, and Bishnumati corridors",
            "Toll-free KMC disaster reporting hotlines: 1180 and 16600105511"
        ],
        "ai_urgency": "MEDIUM",
        "ai_category_confidence": 0.98
    },

    # ── 3. ELECTRICITY & HYDROPOWER NOTICES ──────────────────────────────
    {
        "source": "nea",
        "category": "NEWS",
        "title": "नेपाल विद्युत प्राधिकरणद्वारा मनसुनमा दैनिक ६५० मेगावाट भन्दा बढी जलविद्युत भारत तथा बंगलादेश निर्यात — ऐतिहासिक उपलब्धि",
        "published_at": "2026-09-24T10:00:00",
        "url": "https://nea.org.np/en/news/cross-border-electricity-export-record-monsoon-2026",
        "attachment_url": "https://nea.org.np/media/files/NEA_Export_Milestone_Report.pdf",
        "content_text": """नेपाल विद्युत प्राधिकरण (Nepal Electricity Authority - NEA)
केन्द्रीय कार्यालय, रत्नपार्क, काठमाडौँ
प्रेस विज्ञप्ति: २०८३ असोज ०८

विषय: मनसुनमा देशभित्रका जलविद्युत आयोजनाहरू पूर्ण क्षमतामा सञ्चालन भई दैनिक ६५० मेगावाट भन्दा बढी बिजुली निर्यात।

नेपाल विद्युत प्राधिकरणले चालू मनसुन सिजनमा देशभित्र खपत भई बचत भएको अतिरिक्त जलविद्युत भारतीय ऊर्जा एक्सचेन्ज (IEX) को प्रतिस्पर्धी बजार तथा द्विपक्षीय सम्झौता मार्फत भारत र बंगलादेशमा निर्यात गरिरहेको छ।

मुख्य विवरणहरू:
१. दैनिक निर्यात परिमाण: ६५० देखि ७०० मेगावाट (दैनिक करिब १० देखि १२ करोड रुपैयाँको विद्युत बिक्री)।
२. चालू आर्थिक वर्षको हालसम्मको कुल निर्यात आम्दानी रु. १२ अर्ब ५० करोड नाघेको छ, जसले देशको व्यापार घाटा न्यूनीकरण र विदेशी मुद्रा सञ्चितीमा ऐतिहासिक योगदान पुर्‍याएको छ।
३. ढल्केबर-मुजफ्फरपुर ४०० केभी अन्तरदेशीय प्रसारण लाइन पूर्ण क्षमतामा सञ्चालन भइरहेको छ भने नयाँ बुटवल-गोरखपुर ४०० केभी दोस्रो अन्तरदेशीय लाइनको निर्माण कार्य द्रुत गतिमा अघि बढेको छ।
४. प्राधिकरणका कार्यकारी निर्देशक कुलमान घिसिङले देशभित्र २४ घण्टा भरपर्दो र गुणस्तरीय विद्युत आपूर्ति सुनिश्चित गर्दै बचत भएको बिजुली शतप्रतिशत सदुपयोग गर्ने रणनीति सफल भएको बताउनुभयो।""",
        "ai_summary": "Nepal Electricity Authority (NEA) announced a record cross-border power export exceeding 650 MW daily to India and Bangladesh during peak monsoon runoff, generating over NPR 10-12 Crore in daily revenue. Total electricity export revenue for the current fiscal period has crossed NPR 12.5 Billion via the 400 kV Dhalkebar-Muzaffarpur cross-border interconnection.",
        "ai_summary_ne": "नेपाल विद्युत प्राधिकरणले मनसुनको बचत बिजुली दैनिक ६५० मेगावाट भन्दा बढी भारत तथा बंगलादेश निर्यात गरिरहेको छ। यसबाट दैनिक १० देखि १२ करोड रुपैयाँ आम्दानी भई चालू वर्षमा हालसम्म १२ अर्ब ५० करोड रुपैयाँ विदेशी मुद्रा आर्जन भएको छ।",
        "tags": ["electricity_export", "nea", "hydropower", "cross_border_energy", "dhalkebar_muzaffarpur", "clean_energy", "foreign_exchange"],
        "key_facts": [
            "Daily electricity export exceeds 650-700 MW to India and Bangladesh",
            "Daily export revenue stands between NPR 10 to 12 Crore",
            "Cumulative seasonal export revenue surpassed NPR 12.5 Billion",
            "400 kV Dhalkebar-Muzaffarpur and New Butwal-Gorakhpur transmission corridors expanding"
        ],
        "ai_urgency": "LOW",
        "ai_category_confidence": 0.99
    },
    {
        "source": "nea",
        "category": "NOTICE",
        "title": "काठमाडौँ उपत्यका भूमिगत तार बिछ्याउने (Underground Cabling) कार्य तथा फिडर स्तरवृद्धि सम्बन्धी सूचना",
        "published_at": "2026-09-25T11:30:00",
        "url": "https://nea.org.np/notices/underground-cabling-and-feeder-upgrade-kathmandu-2026",
        "attachment_url": "https://nea.org.np/media/files/Underground_Cabling_Schedule.pdf",
        "content_text": """नेपाल विद्युत प्राधिकरण, वितरण तथा ग्राहक सेवा निर्देशनालय
काठमाडौँ उपत्यका मध्य तथा उत्तर वितरण प्रणाली सुदृढीकरण आयोजना

विषय: रत्नपार्क, महाराजगञ्ज र बानेश्वर वितरण केन्द्र अन्तर्गत भूमिगत केबुलिङ तथा स्वचालित सब-स्टेसन स्तरोन्नति।

काठमाडौँ उपत्यकाको विद्युत वितरण प्रणालीलाई आधुनिक, भरपर्दो, सुरक्षित र सौन्दर्यमयी बनाउन सुरु गरिएको ११ केभी तथा एलटी लाइन भूमिगत गर्ने कार्य अन्तिम चरणमा पुगेको छ।

मुख्य जानकारी:
१. महाराजगञ्ज, बालुवाटार, लाजिम्पाट, रत्नपार्क र बानेश्वर क्षेत्रका मुख्य सडकहरूमा ९०% भन्दा बढी भूमिगत केबल चार्ज भइसकेको छ।
२. अब पुरानो ओभरहेड नाङ्गो तार र जीर्ण पोलहरू हटाउने कार्य चरणबद्ध रूपमा सुरु गरिएको छ।
३. नयाँ प्रणालीमा अटोमेटेड फल्ट डिटेक्सन सिस्टम जडान गरिएको हुँदा लाइन ट्रिपिङ वा खराबी आएमा केही सेकेन्डभित्रै वैकल्पिक फिडरबाट स्वतः बत्ती बल्ने व्यवस्था मिलाइएको छ।""",
        "ai_summary": "NEA published progress on the Kathmandu Valley Underground Cabling & Distribution Strengthening Project across Maharajgunj, Ratnapark, and Baneshwor. Over 90% of underground lines are charged, overhead wires are being decommissioned, and automated fault switching is activated to prevent blackouts.",
        "ai_summary_ne": "काठमाडौँ उपत्यकाका महाराजगञ्ज, बालुवाटार र बानेश्वर क्षेत्रमा ९०% भूमिगत तार चार्ज भइसकेको र पुराना नाङ्गा तार हटाउने कार्य सुरु भएको नेपाल विद्युत प्राधिकरणले जनाएको छ।",
        "tags": ["nea", "underground_cabling", "power_distribution", "smart_grid", "kathmandu_electricity"],
        "key_facts": [
            "Over 90% underground 11kV cables successfully charged in central Kathmandu",
            "Overhead bare cables and hazardous poles being systematically removed",
            "Automated loop fault isolation system reduces outage durations to seconds"
        ],
        "ai_urgency": "LOW",
        "ai_category_confidence": 0.97
    },

    # ── 4. FOREIGN GRANTS & ECONOMIC AGREEMENTS ───────────────────────────
    {
        "source": "mof",
        "category": "PRESS_RELEASE",
        "title": "नेपाल सरकार र विश्व बैंक (World Bank) बीच १५ करोड अमेरिकी डलर (करिब रु. २० अर्ब) बराबरको सडक स्तरोन्नति तथा जलवायु अनुकूलन सम्झौता",
        "published_at": "2026-09-24T15:00:00",
        "url": "https://mof.gov.np/press-release/world-bank-150m-resilient-connectivity-agreement-2026",
        "attachment_url": "https://mof.gov.np/media/files/WB_Grant_Agreement_Sept2026.pdf",
        "content_text": """अर्थ मन्त्रालय (Ministry of Finance), अन्तर्राष्ट्रिय आर्थिक सहायता समन्वय महाशाखा
सिंहदरबार, काठमाडौँ
प्रेस विज्ञप्ति — मिति: २०८३ असोज ०८

विषय: नेपाल सरकार र विश्व बैंक बीच 'ग्रामीण सडक स्तरोन्नति तथा जलवायु उत्थानशील सम्पर्क सञ्जाल आयोजना (Resilient Roads & Regional Connectivity Project)' का लागि १५ करोड अमेरिकी डलर (करिब २० अर्ब नेपाली रुपैयाँ) को सहुलियतपूर्ण ऋण तथा अनुदान सम्झौतामा हस्ताक्षर।

अर्थ मन्त्रालयमा आयोजित एक विशेष समारोहमा अर्थ सचिव र विश्व बैंकका नेपाल, माल्दिभ्स तथा श्रीलंकाका देशीय निर्देशकले सम्झौता पत्रमा हस्ताक्षर गर्नुभयो।

आयोजनाको मुख्य उद्देश्य र क्षेत्रहरू:
१. पूर्व-पश्चिम राजमार्गको बुटवल-गोरुसिङ्गे खण्डलाई ४-लेन हरित राजमार्ग (Green Resilient Highway) को रूपमा स्तरोन्नति गर्ने।
२. जलवायु परिवर्तनका कारण बाढी र पहिरोबाट अत्यधिक प्रभावित हुने पहाडी तथा तराईका ६५० किलोमिटर रणनीतिक सडकहरूमा बायो-इन्जिनियरिङ र बलियो पुलहरूको निर्माण।
३. महिला तथा स्थानीय युवाहरूका लागि सडक मर्मत तथा निर्माण कार्यमा हरित रोजगारी सिर्जना गर्ने।
४. यो सहायता अत्यन्त न्यून ब्याजदर (०.७५%) र ३८ वर्षको भुक्तानी अवधि (६ वर्ष ग्रेस पिरियड) सहितको सहुलियतपूर्ण ऋण र अनुदानको मिश्रित प्याकेज हो।""",
        "ai_summary": "Ministry of Finance and the World Bank signed a $150 Million (approx NPR 20 Billion) concessional financing and grant agreement for the Resilient Roads and Regional Connectivity Project. The package funds the 4-lane climate-resilient upgrade of the Butwal-Gorusinghe highway, bio-engineering reinforcements across 650 km of flood-prone roads, and green rural transport infrastructure.",
        "ai_summary_ne": "अर्थ मन्त्रालय र विश्व बैंकबीच सडक स्तरोन्नति र जलवायु उत्थानशीलताका लागि १५ करोड अमेरिकी डलर (करिब २० अर्ब रुपैयाँ) को सहुलियतपूर्ण ऋण तथा अनुदान सम्झौतामा हस्ताक्षर भएको छ। यसबाट बुटवल-गोरुसिङ्गे खण्ड ४-लेन बनाइनेछ।",
        "tags": ["foreign_grant", "world_bank", "mof", "road_infrastructure", "butwal_gorusinghe", "climate_resilience", "concessional_loan"],
        "key_facts": [
            "$150 Million (approx NPR 20 Billion) signed between MoF and World Bank",
            "Funds 4-lane green resilient upgrade of Butwal-Gorusinghe highway section",
            "Bio-engineering stabilization for 650 km of vulnerable mountain and plain roads",
            "Terms: 0.75% concessional interest rate with 38-year repayment period"
        ],
        "ai_urgency": "LOW",
        "ai_category_confidence": 0.99
    },
    {
        "source": "mof",
        "category": "PRESS_RELEASE",
        "title": "एसियाली विकास बैंक (ADB) द्वारा नेपालको दिगो खानेपानी तथा जलवायु अनुकूलनका लागि १० करोड अमेरिकी डलर अनुदान तथा ऋण स्वीकृत",
        "published_at": "2026-09-25T16:30:00",
        "url": "https://mof.gov.np/press-release/adb-100m-climate-resilient-water-supply-approval-2026",
        "attachment_url": "https://mof.gov.np/media/files/ADB_Water_Grant_2026.pdf",
        "content_text": """अर्थ मन्त्रालय तथा एसियाली विकास बैंक (ADB)
प्रेस विज्ञप्ति — मिति: २०८३ असोज ०९

विषय: नेपालका २२ वटा तराई तथा पहाडी नगरपालिकामा सुरक्षित, शुद्ध र जलवायु-उत्थानशील खानेपानी प्रणाली निर्माणका लागि एसियाली विकास बैंकबाट १० करोड डलर (करिब रु. १३ अर्ब ३० करोड) वित्तीय सहायता स्वीकृत।

मुख्य विशेषताहरू:
१. बाढी र खडेरी प्रतिरोधी आधुनिक खानेपानी प्रशोधन केन्द्र तथा २४ सै घण्टा पानी वितरण प्रणाली निर्माण गरिनेछ।
२. यस आयोजनाबाट करिब ३ लाख ५० हजार घरधुरीलाई प्रत्यक्ष रूपमा शुद्ध खानेपानीको पहुँच प्राप्त हुनेछ।
३. कूल रकम मध्ये २ करोड डलर प्रत्यक्ष अनुदान (Grant) र ८ करोड डलर सहुलियतपूर्ण ऋणका रूपमा प्रदान गरिएको हो।""",
        "ai_summary": "Asian Development Bank (ADB) approved a $100 Million (NPR 13.3 Billion) financing package ($20M direct grant + $80M concessional loan) to build climate-resilient water supply and sanitation infrastructure across 22 municipalities, benefiting 350,000 households.",
        "ai_summary_ne": "एसियाली विकास बैंक (ADB) ले नेपालका २२ नगरपालिकामा जलवायु-अनुकूल खानेपानी प्रणाली विस्तारका लागि १० करोड डलर (करिब १३ अर्ब ३० करोड रुपैयाँ) को सहायता स्वीकृत गरेको छ, जसमा २ करोड डलर अनुदान रहेको छ।",
        "tags": ["foreign_grant", "adb", "mof", "water_supply", "climate_adaptation", "municipal_infrastructure"],
        "key_facts": [
            "$100 Million total financing ($20M grant + $80M concessional loan)",
            "Covers 22 urban municipalities across hill and Tarai regions",
            "Provides safe 24/7 tap water to 350,000 households"
        ],
        "ai_urgency": "LOW",
        "ai_category_confidence": 0.98
    },

    # ── 5. GOVERNANCE, CENTRAL BANK & TRANSPORT ───────────────────────────
    {
        "source": "nrb",
        "category": "CIRCULAR",
        "title": "प्राकृतिक विपद् तथा बाढी प्रभावित ऋणीहरूका लागि विशेष पुनर्कर्जा तथा कर्जा पुनर्तालिकीकरण सम्बन्धी निर्देशन",
        "published_at": "2026-09-26T17:00:00",
        "url": "https://www.nrb.org.np/notices/directive-disaster-relief-refinancing-and-rescheduling-2026",
        "attachment_url": "https://www.nrb.org.np/media/files/NRB_Disaster_Relief_Directive.pdf",
        "content_text": """नेपाल राष्ट्र बैंक (Nepal Rastra Bank), बैंक तथा वित्तीय संस्था नियमन विभाग
परिपत्र नं: ०४/२०८३/८४
मिति: २०८३ असोज १०

क, ख र ग वर्गका इजाजतपत्रप्राप्त बैंक तथा वित्तीय संस्थाहरूको लागि:

विषय: हालैको भीषण वर्षा, बाढी र पहिरोबाट प्रभावित कृषि, घरेलु, साना तथा मझौला उद्योग (SMEs) र यातायात व्यवसायीहरूलाई कर्जा सहुलियत सम्बन्धमा।

बाढी पहिरोका कारण जनधन तथा भौतिक संरचनामा भएको क्षतिका कारण ऋणीहरूले भोग्नुपरेको समस्यालाई मध्यनजर गर्दै निम्न व्यवस्थाहरू गरिएको छ:
१. बाढी प्रभावित क्षेत्रका किसान, पशुपालक र साना व्यवसायीहरूको कर्जाको सावाँ र ब्याज भुक्तानी अवधि ६ महिनासम्मका लागि कुनै थप हर्जना वा जरिवाना विना पुनर्तालिकीकरण (Rescheduling) गर्न सकिनेछ।
२. पुनर्निर्माण तथा व्यवसाय पुनःसञ्चालनका लागि ५% सहुलियतपूर्ण ब्याजदरमा आकस्मिक पुनर्कर्जा (Emergency Disaster Refinancing) उपलब्ध गराइनेछ।
३. प्रभावित ऋणीहरूको धितो लिलामी प्रक्रिया आगामी ६ महिनासम्मका लागि स्थगित गर्न निर्देशन दिइएको छ।""",
        "ai_summary": "Nepal Rastra Bank (NRB) issued a mandatory regulatory directive ordering all commercial and development banks to provide a 6-month penalty-free loan rescheduling and concessional 5% emergency refinancing for flood-hit farmers, SMEs, and transport operators, alongside a 6-month moratorium on collateral auctions.",
        "ai_summary_ne": "नेपाल राष्ट्र बैंकले बाढी पहिरो प्रभावित किसान र साना व्यवसायीहरूका लागि ६ महिनासम्म हर्जाना बिना कर्जा पुनर्तालिकीकरण, ५% सहुलियतपूर्ण आकस्मिक पुनर्कर्जा र लिलामी प्रक्रिया स्थगित गर्ने निर्देशन जारी गरेको छ।",
        "tags": ["nrb", "monetary_directive", "flood_relief", "loan_rescheduling", "refinancing", "banking_relief"],
        "key_facts": [
            "6-month penalty-free loan rescheduling for flood-affected agriculture and SMEs",
            "Emergency disaster refinancing facility at 5% concessional interest",
            "6-month freeze on collateral auction notices for affected borrowers"
        ],
        "ai_urgency": "MEDIUM",
        "ai_category_confidence": 0.99
    },
    {
        "source": "dotm",
        "category": "NOTICE",
        "title": "सवारी चालक अनुमतिपत्र (Smart Driving License) छपाइ तथा वितरण तीव्र बनाउने सम्बन्धी सूचना",
        "published_at": "2026-09-25T09:00:00",
        "url": "https://dotm.gov.np/notices/smart-license-printing-expedited-schedule-2026",
        "attachment_url": "https://dotm.gov.np/media/files/DOTM_License_Notice_2026.pdf",
        "content_text": """यातायात व्यवस्था विभाग (Department of Transport Management - DOTM)
मीनभवन, काठमाडौँ

विषय: नयाँ उच्च-क्षमताको कार्ड प्रिन्टर जडान पश्चात् स्मार्ट ड्राइभिङ लाइसेन्स छपाइ तथा वितरण सम्बन्धमा।

विभागले दैनिक १५,००० कार्ड छाप्न सक्ने आधुनिक मास प्रिन्टर पूर्ण रूपमा सञ्चालनमा ल्याएको जानकारी गराउँदछ।

प्रमुख विवरण:
१. विगतमा ट्रायल पास गरी वा नवीकरणका लागि आवेदन दिएर लामो समयदेखि प्रतीक्षामा रहेका नागरिकहरूको ब्याकलक लाइसेन्स आगामी ३० दिनभित्र छपाइ सम्पन्न गरी सम्बन्धित यातायात कार्यालयहरूमा पठाइनेछ।
२. सेवाग्राहीहरूले आफ्नो लाइसेन्स छापिएको वा नछापिएको विवरण विभागको आधिकारिक वेबसाइट (dotm.gov.np) वा एसएमएस (SMS 'LC <Application ID>' to 33001) मार्फत तुरुन्त जाँच गर्न सक्नेछन्।
३. विदेश जाने श्रमिक र विद्यार्थीहरूको हकमा अनलाइन आवेदन दिएको ३ दिनभित्रै द्रुत (Emergency) सेवा मार्फत लाइसेन्स उपलब्ध गराउने व्यवस्था कायमै छ।""",
        "ai_summary": "Department of Transport Management (DOTM) operationalized its mass card printer with 15,000 cards/day capacity, pledging to clear all backlog driving license printings within 30 days. Real-time print status verification is accessible via website and SMS (33001), with a 3-day emergency turnaround for overseas travelers.",
        "ai_summary_ne": "यातायात व्यवस्था विभागले दैनिक १५ हजार कार्ड छाप्ने मास प्रिन्टर सञ्चालनमा ल्याई बाँकी सबै स्मार्ट लाइसेन्स ३० दिनभित्र छापेर सम्बन्धित कार्यालयमा पठाउने र विदेश जानेहरूलाई ३ दिनभित्र लाइसेन्स दिने व्यवस्था गरेको छ।",
        "tags": ["dotm", "smart_license", "driving_license", "public_service", "transport_management"],
        "key_facts": [
            "15,000 daily card mass printing capacity operationalized",
            "Complete backlog license printing targeted for clearance within 30 days",
            "SMS check: 'LC <Application ID>' to 33001",
            "3-day expedited delivery for overseas workers and students"
        ],
        "ai_urgency": "LOW",
        "ai_category_confidence": 0.98
    }
]

async def seed():
    print(f"Connecting to database: {DB_URL[:40]}...")
    conn = await asyncpg.connect(DB_URL)
    
    inserted = 0
    updated = 0
    
    for item in ITEMS:
        src_info = SOURCES[item["source"]]
        source_id = uuid.UUID(src_info["id"])
        source_label = src_info["name"]
        source_slug = src_info["slug"]
        
        item_id = uuid.uuid5(uuid.NAMESPACE_URL, item["url"])
        content_hash = hashlib.sha256((item["title"] + item["content_text"]).encode("utf-8")).hexdigest()
        published_at = datetime.fromisoformat(item["published_at"])
        now = datetime.utcnow()
        
        # Check if exists
        existing = await conn.fetchrow("SELECT id FROM scraped_items WHERE id = $1;", item_id)
        
        if existing:
            await conn.execute("""
                UPDATE scraped_items SET
                    title = $1,
                    source_url = $2,
                    source_label = $3,
                    source_slug = $4,
                    category = $5,
                    summary = $6,
                    content_text = $7,
                    attachment_url = $8,
                    ai_summary = $9,
                    ai_summary_ne = $10,
                    key_facts = $11,
                    tags = $12,
                    ai_urgency = $13,
                    ai_category_confidence = $14,
                    content_hash = $15,
                    published_at = $16,
                    summary_status = 'success',
                    updated_at = $17
                WHERE id = $18;
            """,
                item["title"],
                item["url"],
                source_label,
                source_slug,
                item["category"],
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
                published_at,
                now,
                item_id
            )
            updated += 1
            print(f"  [UPDATED] {item['title'][:60]}...")
        else:
            await conn.execute("""
                INSERT INTO scraped_items (
                    id, source_id, source_label, source_slug, category, title,
                    source_url, summary, content_text, attachment_url, ai_summary,
                    ai_summary_ne, key_facts, tags, ai_urgency, ai_category_confidence,
                    content_hash, published_at, scraped_at, updated_at,
                    summary_status, embedding_status, views
                ) VALUES (
                    $1, $2, $3, $4, $5, $6,
                    $7, $8, $9, $10, $11,
                    $12, $13, $14, $15, $16,
                    $17, $18, $19, $19,
                    'success', 'pending', 0
                );
            """,
                item_id,
                source_id,
                source_label,
                source_slug,
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
                published_at,
                now
            )
            inserted += 1
            print(f"  [INSERTED] {item['title'][:60]}...")
            
    print(f"\nDone! Inserted: {inserted}, Updated: {updated}, Total Seeded: {len(ITEMS)}")
    await conn.close()

if __name__ == "__main__":
    asyncio.run(seed())
