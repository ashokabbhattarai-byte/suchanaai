"""Build the Suchana AI demo presentation (15 slides, Times New Roman).

Usage:  .cache/pptvenv/bin/python scripts/build_ppt.py
Output: Suchana_AI_Presentation.pptx
"""

import os

from PIL import Image
from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from pptx.util import Emu, Inches, Pt

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.path.join(ROOT, ".cache", "ppt_assets")
DIAGRAMS = os.path.join(ROOT, "Chapter4&5", "diagrams")
OUT = os.path.join(ROOT, "Suchana_AI_Presentation.pptx")

FONT = "Times New Roman"
NAVY = RGBColor(0x0C, 0x2D, 0x48)
ACCENT = RGBColor(0x0C, 0x5C, 0xAB)
INK = RGBColor(0x1A, 0x1A, 0x1A)
MUTED = RGBColor(0x5A, 0x63, 0x6E)
RULE = RGBColor(0xD4, 0xD9, 0xDF)
PANEL = RGBColor(0xF4, 0xF6, 0xF8)
WHITE = RGBColor(0xFF, 0xFF, 0xFF)

SW, SH = Inches(13.333), Inches(7.5)
MARGIN = Inches(0.72)
BODY_W = SW - 2 * MARGIN

FOOTER = "Suchana AI  ·  Public Notice Management System  ·  Ashok Bhattarai (NP069811)"


# --------------------------------------------------------------------------- helpers
def textbox(slide, left, top, width, height, align=PP_ALIGN.LEFT):
    box = slide.shapes.add_textbox(left, top, width, height)
    tf = box.text_frame
    tf.word_wrap = True
    tf.margin_left = tf.margin_right = tf.margin_top = tf.margin_bottom = 0
    tf.paragraphs[0].alignment = align
    return tf


def write(tf, runs, size=16, color=INK, bold=False, space_after=6, line=1.25,
          align=None, first=False, italic=False, indent=0):
    """runs: str, or list of (text, bold) tuples."""
    p = tf.paragraphs[0] if first else tf.add_paragraph()
    if align is not None:
        p.alignment = align
    p.space_after = Pt(space_after)
    p.line_spacing = line
    if indent:
        p.level = indent
    if isinstance(runs, str):
        runs = [(runs, bold)]
    for text, is_bold in runs:
        r = p.add_run()
        r.text = text
        r.font.name = FONT
        r.font.size = Pt(size)
        r.font.bold = is_bold
        r.font.italic = italic
        r.font.color.rgb = color
    return p


def rect(slide, left, top, width, height, fill=None, line=None, line_w=0.75):
    shp = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, left, top, width, height)
    shp.shadow.inherit = False
    if fill is None:
        shp.fill.background()
    else:
        shp.fill.solid()
        shp.fill.fore_color.rgb = fill
    if line is None:
        shp.line.fill.background()
    else:
        shp.line.color.rgb = line
        shp.line.width = Pt(line_w)
    shp.text_frame.word_wrap = True
    return shp


def picture(slide, path, left, top, max_w, max_h, border=True):
    """Fit an image inside a box, centred, keeping aspect ratio."""
    iw, ih = Image.open(path).size
    scale = min(max_w / iw, max_h / ih)
    w, h = int(iw * scale), int(ih * scale)
    x = int(left + (max_w - w) / 2)
    y = int(top + (max_h - h) / 2)
    pic = slide.shapes.add_picture(path, x, y, w, h)
    if border:
        pic.line.color.rgb = RULE
        pic.line.width = Pt(0.75)
    return pic


def base_slide(prs):
    return prs.slides.add_slide(prs.slide_layouts[6])


def content_slide(prs, number, title, kicker=None):
    s = base_slide(prs)
    tf = textbox(s, MARGIN, Inches(0.46), BODY_W, Inches(0.55))
    write(tf, title, size=28, color=NAVY, bold=True, first=True, space_after=0)
    if kicker:
        k = textbox(s, MARGIN, Inches(1.02), BODY_W, Inches(0.3))
        write(k, kicker, size=13.5, color=MUTED, italic=True, first=True, space_after=0)
    rect(s, MARGIN, Inches(1.36 if kicker else 1.14), Inches(1.5), Pt(2.5), fill=ACCENT)
    # footer
    ft = textbox(s, MARGIN, SH - Inches(0.5), BODY_W - Inches(0.6), Inches(0.25))
    write(ft, FOOTER, size=9.5, color=MUTED, first=True, space_after=0)
    nf = textbox(s, SW - MARGIN - Inches(0.6), SH - Inches(0.5), Inches(0.6),
                 Inches(0.25), align=PP_ALIGN.RIGHT)
    write(nf, str(number), size=9.5, color=MUTED, first=True, space_after=0,
          align=PP_ALIGN.RIGHT)
    return s


def bullets(slide, left, top, width, items, size=15.5, gap=9):
    """items: list of (bold_lead, rest) or plain strings."""
    tf = textbox(slide, left, top, width, Inches(0.4))
    for i, item in enumerate(items):
        if isinstance(item, tuple):
            runs = [("▪  ", True), (item[0], True), (item[1], False)]
        else:
            runs = [("▪  ", True), (item, False)]
        p = write(tf, runs, size=size, space_after=gap, first=(i == 0))
        p.runs[0].font.color.rgb = ACCENT
    return tf


def card(slide, left, top, width, height, heading, lines, num=None):
    rect(slide, left, top, width, height, fill=PANEL)
    rect(slide, left, top, Pt(3), height, fill=ACCENT)
    pad = Inches(0.22)
    tf = textbox(slide, left + pad, top + Inches(0.16), width - 2 * pad, height)
    head = f"{num}.  {heading}" if num else heading
    write(tf, head, size=15, color=NAVY, bold=True, first=True, space_after=5)
    for ln in lines:
        write(tf, ln, size=12.5, color=INK, space_after=3, line=1.2)
    return tf


def table_block(slide, left, top, width, headers, rows, col_w, size=12.5,
                row_h=Inches(0.34)):
    """Lightweight ruled table (avoids PowerPoint's themed table styling)."""
    total = sum(col_w)
    col_w = [Emu(int(width * c / total)) for c in col_w]
    y = top
    # header
    rect(slide, left, y, width, row_h, fill=NAVY)
    x = left
    for h, cw in zip(headers, col_w):
        tf = textbox(slide, x + Inches(0.1), y + Inches(0.05), cw - Inches(0.15), row_h)
        write(tf, h, size=size, color=WHITE, bold=True, first=True, space_after=0)
        x += cw
    y += row_h
    for i, row in enumerate(rows):
        if i % 2 == 1:
            rect(slide, left, y, width, row_h, fill=PANEL)
        x = left
        for j, cell in enumerate(row):
            tf = textbox(slide, x + Inches(0.1), y + Inches(0.05),
                         col_w[j] - Inches(0.15), row_h)
            write(tf, cell, size=size, color=INK, bold=(j == 0), first=True,
                  space_after=0)
            x += col_w[j]
        y += row_h
        rect(slide, left, y, width, Pt(0.5), fill=RULE)
    return y


def flow(slide, left, top, width, steps, height=Inches(1.0), size=12,
         captions=None):
    """Horizontal chevron pipeline."""
    n = len(steps)
    gap = Inches(0.12)
    bw = int((width - gap * (n - 1)) / n)
    for i, step in enumerate(steps):
        x = left + i * (bw + gap)
        shp = slide.shapes.add_shape(
            MSO_SHAPE.PENTAGON if i < n - 1 else MSO_SHAPE.RECTANGLE, x, top, bw, height)
        shp.shadow.inherit = False
        shp.fill.solid()
        shp.fill.fore_color.rgb = NAVY if i in (0, n - 1) else ACCENT
        shp.line.fill.background()
        tf = shp.text_frame
        tf.word_wrap = True
        tf.vertical_anchor = MSO_ANCHOR.MIDDLE
        tf.margin_left = tf.margin_right = Inches(0.08)
        write(tf, step, size=size, color=WHITE, bold=True, first=True,
              space_after=0, align=PP_ALIGN.CENTER, line=1.1)
        if captions:
            ctf = textbox(slide, x, top + height + Inches(0.08), bw, Inches(0.6),
                          align=PP_ALIGN.CENTER)
            write(ctf, captions[i], size=10.5, color=MUTED, first=True,
                  space_after=0, align=PP_ALIGN.CENTER, line=1.15)


def caption(slide, text, top):
    tf = textbox(slide, MARGIN, top, BODY_W, Inches(0.3), align=PP_ALIGN.CENTER)
    write(tf, text, size=11.5, color=MUTED, italic=True, first=True,
          space_after=0, align=PP_ALIGN.CENTER)


# --------------------------------------------------------------------------- slides
prs = Presentation()
prs.slide_width, prs.slide_height = SW, SH

# 1 — Title
s = base_slide(prs)
rect(s, 0, 0, SW, SH, fill=NAVY)
rect(s, 0, SH - Inches(0.85), SW, Inches(0.85), fill=RGBColor(0x08, 0x1E, 0x30))
rect(s, MARGIN, Inches(2.05), Inches(1.9), Pt(3), fill=ACCENT)
tf = textbox(s, MARGIN, Inches(1.35), Inches(11), Inches(0.5))
write(tf, "FINAL YEAR PROJECT  ·  SYSTEM DEMONSTRATION", size=13,
      color=RGBColor(0x9C, 0xC3, 0xE8), bold=True, first=True, space_after=0)
tf = textbox(s, MARGIN, Inches(2.45), Inches(11.3), Inches(2.2))
write(tf, "Suchana AI", size=52, color=WHITE, bold=True, first=True, space_after=8)
write(tf, "An AI-Powered Cloud-Based Public Notice Management System for Nepal",
      size=23, color=RGBColor(0xD8, 0xE4, 0xEF), line=1.2)
tf = textbox(s, MARGIN, Inches(5.15), Inches(11.3), Inches(1.2))
write(tf, [("Presented by:  ", True), ("Ashok Bhattarai  (NP069811)", False)],
      size=15, color=RGBColor(0xC9, 0xD8, 0xE6), first=True, space_after=4)
write(tf, "Next.js 16  ·  NestJS 11  ·  Python ASGI  ·  PostgreSQL  ·  Qdrant  ·  crawl4ai",
      size=14, color=RGBColor(0x9C, 0xC3, 0xE8))
tf = textbox(s, MARGIN, SH - Inches(0.62), Inches(11), Inches(0.3))
write(tf, "Introduction  ·  Architecture  ·  Flows  ·  User Interface  ·  Pipelines",
      size=12, color=RGBColor(0x8F, 0xA9, 0xC0), first=True, space_after=0)

# 2 — Problem & motivation
s = content_slide(prs, 2, "The Problem", "Why public notices in Nepal are hard to find and easy to miss")
bullets(s, MARGIN, Inches(1.75), Inches(6.5), [
    ("Fragmented sources. ", "Every ministry, commission and public body publishes to its own website; there is no single national index."),
    ("Unstructured formats. ", "Most notices are scanned PDFs or images — invisible to ordinary text search engines."),
    ("Deadline-driven loss. ", "Vacancies, tenders and exam notices carry short windows; citizens miss them simply by not checking daily."),
    ("Language barrier. ", "Content is mixed Nepali and English, and existing search does not handle Devanagari well."),
    ("No push channel. ", "Nothing notifies a citizen when a notice relevant to them appears."),
], size=15)
card(s, Inches(8.05), Inches(1.85), Inches(4.55), Inches(4.35),
     "Consequence", [
         "",
         "A citizen must manually visit dozens of",
         "government portals, read scanned documents",
         "one by one, and repeat this every single day —",
         "with no guarantee of completeness.",
         "",
         "Suchana AI replaces that manual routine with",
         "automated aggregation, machine-readable text,",
         "semantic search and personalised alerts.",
     ])

# 3 — Aim, objectives, scope
s = content_slide(prs, 3, "Aim, Objectives and Scope")
tf = textbox(s, MARGIN, Inches(1.62), BODY_W, Inches(0.6))
write(tf, [("Aim:  ", True), ("to design and build a cloud-based platform that automatically aggregates public notices "
            "from Nepali government sources, makes them searchable in natural language, and delivers "
            "relevant notices to citizens through personalised alerts.", False)],
      size=15.5, first=True, space_after=0, line=1.3)
cw, gap = Inches(3.95), Inches(0.35)
cards = [
    ("Objectives", [
        "• Aggregate notices from any public source",
        "  without writing per-site code.",
        "• Extract text from scanned documents",
        "  using bilingual OCR (Nepali + English).",
        "• Answer natural-language questions with",
        "  citations from the notice corpus.",
        "• Deliver keyword and category alerts",
        "  over email and WhatsApp.",
    ]),
    ("In Scope", [
        "• Public browsing, search and filtering.",
        "• Authenticated user dashboard: saved",
        "  notices, alert rules, activity.",
        "• Admin panel: sources, scrape runs,",
        "  notices, users, plans, settings.",
        "• RAG document upload and chat.",
        "• Subscription plans and usage quotas.",
    ]),
    ("Out of Scope", [
        "• Native mobile applications.",
        "• Legally authoritative republication",
        "  of government documents.",
        "• Automatic translation between",
        "  Nepali and English notice text.",
        "• Real-time (sub-minute) scraping of",
        "  every configured source.",
    ]),
]
for i, (h, lines) in enumerate(cards):
    card(s, MARGIN + i * (cw + gap), Inches(2.75), cw, Inches(3.55), h, lines)

# 4 — System at a glance
s = content_slide(prs, 4, "The System at a Glance", "Five capabilities delivered by three cooperating services")
feats = [
    ("Automated Aggregation", ["Admin adds a source URL; the crawler detects",
                               "the page structure itself and keeps scraping",
                               "on a schedule — no per-site code."]),
    ("Bilingual OCR Ingestion", ["Scanned PDFs and images are converted to text",
                                 "with Tesseract (nep + eng), making image-only",
                                 "notices fully searchable."]),
    ("RAG Question Answering", ["Ask a question in plain Nepali or English;",
                                "answers are generated only from retrieved",
                                "notice text, with source citations."]),
    ("Personalised Alerts", ["Keyword, category and organisation rules are",
                             "matched against every new notice and pushed",
                             "by email and WhatsApp."]),
    ("Role-Based Administration", ["Separate guest, user and admin surfaces;",
                                   "admins manage sources, notices, users,",
                                   "plans and system settings."]),
    ("Multilingual Interface", ["The entire interface switches between",
                                "English and नेपाली instantly, with",
                                "locale-aware dates."]),
]
cw, ch, gx, gy = Inches(3.95), Inches(2.05), Inches(0.35), Inches(0.32)
for i, (h, lines) in enumerate(feats):
    x = MARGIN + (i % 3) * (cw + gx)
    y = Inches(1.85) + (i // 3) * (ch + gy)
    card(s, x, y, cw, ch, h, lines, num=f"0{i + 1}")

# 5 — Technology stack
s = content_slide(prs, 5, "Technology Stack", "Chosen for a single-developer build with production-grade behaviour")
table_block(s, MARGIN, Inches(1.75), BODY_W,
            ["Layer", "Technology", "Why this choice"],
            [
                ("Web", "Next.js 16 · React 19 · Tailwind v4 · shadcn/ui",
                 "App Router streaming, one language across the stack"),
                ("API", "NestJS 11 · Prisma 6 · PostgreSQL",
                 "Modular DI structure, typed schema and migrations"),
                ("AI service", "Python raw ASGI on Uvicorn",
                 "Only seven routes — no framework overhead needed"),
                ("Vector store", "Qdrant (dense + BM25 sparse)",
                 "Payload filtering and native hybrid fusion"),
                ("Embeddings", "intfloat/multilingual-e5-base (768-dim)",
                 "Nepali and English share one vector space, free and CPU-friendly"),
                ("Generation", "Groq — llama-3.3-70b-versatile",
                 "Very fast inference, OpenAI-compatible, generous free tier"),
                ("Crawling", "crawl4ai (Playwright-backed, async)",
                 "Renders JavaScript pages; declarative CSS-to-JSON extraction"),
                ("OCR", "Tesseract via pytesseract (nep + eng)",
                 "Scanned government notices need a Nepali language pack"),
                ("Notifications", "SMTP email · Evolution API (WhatsApp)",
                 "Reaches citizens on the channel they actually use"),
                ("Tooling", "Turborepo · pnpm workspaces · TypeScript 5",
                 "One repository, cached builds, shared domain types"),
            ], col_w=[1.5, 3.4, 4.4], row_h=Inches(0.42))

# 6 — Architecture
s = content_slide(prs, 6, "System Architecture",
                  "Three services, one system of record, clear ownership boundaries")
picture(s, os.path.join(DIAGRAMS, "architecture.png"),
        MARGIN, Inches(1.8), BODY_W, Inches(2.5), border=False)
y = Inches(4.55)
owns = [
    ("Web — apps/web", ["Rendering, routing, client state,", "i18n, forms and validation.",
                        "Holds no business rules."]),
    ("API — apps/api", ["Trusted gateway. JWT auth, RBAC,", "Prisma persistence, quotas,",
                        "scheduling, notifications."]),
    ("AI — apps/ai", ["Crawling, OCR, chunking,", "embeddings, hybrid retrieval",
                      "and answer generation."]),
]
cw, gx = Inches(3.95), Inches(0.35)
for i, (h, lines) in enumerate(owns):
    card(s, MARGIN + i * (cw + gx), y, cw, Inches(1.65), h, lines)
caption(s, "Figure 1 — High-level service architecture", Inches(4.22))

# 7 — Request flow
s = content_slide(prs, 7, "End-to-End Request Flow",
                  "How a single user action travels through the stack")
flow(s, MARGIN, Inches(1.85), BODY_W,
     ["Browser\n(Next.js)", "NestJS API\nGateway", "Guards &\nQuota", "Prisma /\nPostgreSQL",
      "Python AI\nService", "Response\n+ Citations"],
     height=Inches(1.05), size=12.5,
     captions=["User action on a\nclient component",
               "Validated DTO,\nrequest ID attached",
               "JWT verified, role\nand plan checked",
               "System of record\nfor all entities",
               "Only for AI work:\ncrawl, embed, query",
               "Typed JSON returned\nto the browser"])
tf = textbox(s, MARGIN, Inches(4.35), BODY_W, Inches(2.2))
write(tf, "Cross-cutting behaviour", size=17, color=NAVY, bold=True, first=True,
      space_after=8)
for lead, rest in [
    ("Correlation IDs — ", "an x-request-id is generated by NestJS middleware, forwarded through the axios interceptor, and set on the AI service, so one identifier links the logs of all three services."),
    ("Structured logging — ", "all services emit JSON logs by default, with configurable level, format and slow-query thresholds."),
    ("Read-path caching — ", "the public notices list and category counts are served from an in-process TTL cache (10s and 60s), cutting repeated database work under load."),
    ("Connection tuning — ", "pool size, pool timeout and a forced UTC session are applied to the database URL at startup so timezone-aware queries never drift."),
]:
    p = write(tf, [("▪  ", True), (lead, True), (rest, False)], size=13.5,
              space_after=6, line=1.2)
    p.runs[0].font.color.rgb = ACCENT

# 8 — Data model
s = content_slide(prs, 8, "Domain Model",
                  "PostgreSQL is the single system of record; Qdrant stores only vectors")
picture(s, os.path.join(DIAGRAMS, "erd.png"), MARGIN, Inches(1.75), Inches(7.2),
        Inches(4.6), border=False)
tf = textbox(s, Inches(8.5), Inches(1.9), Inches(4.15), Inches(4.4))
write(tf, "Core entities", size=17, color=NAVY, bold=True, first=True, space_after=8)
for lead, rest in [
    ("User", " — identity, role, plan and usage."),
    ("Notice", " — title, organisation, category, priority, publish and expiry dates, source URL."),
    ("Document", " — an uploaded or scraped file, its extraction status and OCR flag."),
    ("Alert", " — a user rule of type keyword, category or organisation, with match history."),
    ("ScrapeSource", " — a configured site, its cached CSS schema and pagination scheme."),
    ("ScrapeRun / ScrapedItem", " — run history, live status and deduplicated results."),
]:
    p = write(tf, [("▪  ", True), (lead, True), (rest, False)], size=13,
              space_after=7, line=1.2)
    p.runs[0].font.color.rgb = ACCENT
caption(s, "Figure 2 — Entity relationship diagram", Inches(6.42))

# 9 — UI: public
s = content_slide(prs, 9, "User Interface — Public Surface",
                  "Landing page and the notice browser, open to every visitor")
half = (BODY_W - Inches(0.35)) / 2
picture(s, os.path.join(SHOTS, "01_homepage.png"), MARGIN, Inches(1.85), half, Inches(3.5))
picture(s, os.path.join(SHOTS, "03_notices.png"), MARGIN + half + Inches(0.35),
        Inches(1.85), half, Inches(3.5))
tf = textbox(s, MARGIN, Inches(5.55), half, Inches(1.2))
write(tf, "Landing page", size=14, color=NAVY, bold=True, first=True, space_after=4)
write(tf, "Value proposition, live notice counts and a direct entry point to search. "
          "Language toggle and theme switch are available before sign-in.",
      size=12.5, color=MUTED, line=1.2)
tf = textbox(s, MARGIN + half + Inches(0.35), Inches(5.55), half, Inches(1.2))
write(tf, "Notice browser", size=14, color=NAVY, bold=True, first=True, space_after=4)
write(tf, "Full-text search with category, organisation, source and date filters; "
          "priority badges and deadline indicators on every card.",
      size=12.5, color=MUTED, line=1.2)

# 10 — UI: dashboard
s = content_slide(prs, 10, "User Interface — Citizen Dashboard",
                  "Everything a signed-in citizen keeps track of")
picture(s, os.path.join(SHOTS, "04_user_dashboard.png"), MARGIN, Inches(1.8),
        Inches(7.35), Inches(4.0))
tf = textbox(s, Inches(8.55), Inches(1.9), Inches(4.1), Inches(4.4))
for h, body in [
    ("Overview", "Saved notices, active alert rules, recent matches and remaining plan quota at a glance."),
    ("Saved notices", "One-click bookmarking from any notice card, with the original source link preserved."),
    ("My alerts", "Create keyword, category or organisation rules, enable or disable them, and see match counts."),
    ("Activity", "A chronological log of searches, saves, alert matches and AI queries."),
    ("Settings", "Profile, notification channels (email and WhatsApp), language and theme."),
]:
    write(tf, h, size=14.5, color=NAVY, bold=True, first=(h == "Overview"), space_after=3)
    write(tf, body, size=12.5, color=MUTED, space_after=10, line=1.2)
caption(s, "Figure 3 — Dashboard overview", Inches(5.9))

# 11 — UI: admin
s = content_slide(prs, 11, "User Interface — Administration",
                  "Source configuration, live scrape monitoring and platform management")
half = (BODY_W - Inches(0.35)) / 2
picture(s, os.path.join(SHOTS, "07_admin_scraping.png"), MARGIN, Inches(1.8), half, Inches(3.3))
picture(s, os.path.join(SHOTS, "10_admin_users.png"), MARGIN + half + Inches(0.35),
        Inches(1.8), half, Inches(3.3))
tf = textbox(s, MARGIN, Inches(5.35), half, Inches(1.4))
write(tf, "Scraping console", size=14, color=NAVY, bold=True, first=True, space_after=4)
write(tf, "Add or edit a source, trigger a run on demand, and follow live status messages "
          "such as “Crawling Notice listing, page 2…” instead of an opaque spinner.",
      size=12.5, color=MUTED, line=1.2)
tf = textbox(s, MARGIN + half + Inches(0.35), Inches(5.35), half, Inches(1.4))
write(tf, "User and plan management", size=14, color=NAVY, bold=True, first=True, space_after=4)
write(tf, "Role assignment, account status, subscription plans and per-user quota usage; "
          "further screens cover notices, categories, alert channels and system settings.",
      size=12.5, color=MUTED, line=1.2)

# 12 — Scraping pipeline
s = content_slide(prs, 12, "Pipeline I — Notice Scraping",
                  "Dynamic, multi-source crawling with no per-site code")
flow(s, MARGIN, Inches(1.8), BODY_W,
     ["Admin adds\nsource", "crawl4ai\nrenders page", "Schema\ndetection",
      "Extract rows\n+ details", "Dedupe &\nupsert", "Notice\npublished"],
     height=Inches(1.0), size=12,
     captions=["Name, base URL,\nlisting URLs",
               "Playwright renders\nJavaScript pages",
               "Cached → LLM →\nheuristics",
               "Title, link, date,\nthen detail body",
               "Prisma writes to\nPostgreSQL",
               "Indexed, alerted,\nsearchable"])
tf = textbox(s, MARGIN, Inches(4.15), Inches(6.5), Inches(2.4))
write(tf, "Three-tier schema detection", size=17, color=NAVY, bold=True, first=True,
      space_after=8)
for lead, rest in [
    ("1. Cached schema (free) — ", "reuse the CSS schema stored on the source from the last successful run. This is the path almost every run takes."),
    ("2. LLM-assisted (paid once) — ", "only when no schema is cached or the cached one returns zero rows; Groq reads the page once and proposes a schema."),
    ("3. Structural heuristics (free) — ", "group sibling DOM elements by tag and class, score by repetition and list-like naming, penalise navigation and footers."),
]:
    p = write(tf, [(lead, True), (rest, False)], size=13, space_after=7, line=1.2)
    p.runs[0].font.color.rgb = NAVY
card(s, Inches(7.7), Inches(4.15), Inches(4.9), Inches(2.4),
     "Why this design", [
         "",
         "Detection cost is paid at most once per source",
         "per site redesign — never on a scheduled run.",
         "",
         "Detail pages are handled generically: chrome",
         "(nav, header, footer, script) is stripped and the",
         "densest text block is kept, so no body selector",
         "has to be written for any site.",
     ])

# 13 — RAG ingestion pipeline
s = content_slide(prs, 13, "Pipeline II — Document Ingestion",
                  "From an uploaded file to searchable vectors")
flow(s, MARGIN, Inches(1.8), BODY_W,
     ["Upload\n(NestJS)", "Extract text\n/ OCR", "Structure-aware\nchunking",
      "Batched\nembedding", "Index into\nQdrant", "Ready to\nquery"],
     height=Inches(1.0), size=12,
     captions=["Validated, stored,\nstatus tracked",
               "pypdf, then Tesseract\nnep+eng fallback",
               "800 chars, 120\noverlap",
               "e5-base, 768-dim,\npassage: prefix",
               "Dense + BM25\nsparse vectors",
               "Live progress shown\nin the UI"])
tf = textbox(s, MARGIN, Inches(4.15), Inches(6.5), Inches(2.4))
write(tf, "Chunking that respects structure", size=17, color=NAVY, bold=True,
      first=True, space_after=8)
write(tf, "Text is split on blank lines into paragraphs; paragraphs longer than the "
          "chunk size are split on sentence ends — including the Devanagari danda (।) — "
          "and only then on word boundaries. Segments are greedily packed, and each chunk "
          "begins with the tail of the previous one so a fact spanning a boundary still "
          "appears whole in at least one chunk.", size=13, line=1.28, space_after=8)
write(tf, "The overlap is snapped to a word boundary, so no chunk starts mid-word — "
          "this measurably improved both retrieval quality and displayed text.",
      size=13, line=1.28, italic=True, color=MUTED)
card(s, Inches(7.7), Inches(4.15), Inches(4.9), Inches(2.4),
     "Lifecycle and operations", [
         "",
         "• Ingestion runs asynchronously; the UI polls a",
         "  progress endpoint for per-stage percentages.",
         "• Documents can be embedded and un-embedded",
         "  without deleting the underlying file.",
         "• Metadata (status, owner, timestamps) lives in",
         "  PostgreSQL; only vectors live in Qdrant.",
     ])

# 14 — RAG query + alerts
s = content_slide(prs, 14, "Pipeline III — Retrieval and Alerting",
                  "Grounded answers, and notices that find the citizen")
tf = textbox(s, MARGIN, Inches(1.72), Inches(6.4), Inches(0.35))
write(tf, "RAG query pipeline", size=17, color=NAVY, bold=True, first=True, space_after=0)
flow(s, MARGIN, Inches(2.2), Inches(6.4),
     ["Intent\nrouter", "Hybrid\nsearch", "RRF +\nrescore", "Groq\nanswer"],
     height=Inches(0.85), size=11.5,
     captions=["Small talk never\ntouches Qdrant",
               "Dense + BM25\nrun together",
               "Cosine re-score,\nthreshold, dedupe",
               "Cited markdown,\ncontext only"])
tf = textbox(s, MARGIN, Inches(4.05), Inches(6.4), Inches(2.3))
for lead, rest in [
    ("Hybrid retrieval. ", "Dense embeddings capture meaning; BM25 catches exact identifiers such as notice numbers and dates. Qdrant fuses both rankings with Reciprocal Rank Fusion."),
    ("Cosine re-scoring. ", "Fused ranks are not similarities, so each hit is re-scored against the query vector — restoring a meaningful threshold and the relevance percentage shown to the user."),
    ("Grounding. ", "The model answers only from retrieved context; when the corpus does not contain the answer it says so, and degrades to an extractive answer if no API key is configured."),
]:
    p = write(tf, [("▪  ", True), (lead, True), (rest, False)], size=12.5,
              space_after=6, line=1.2)
    p.runs[0].font.color.rgb = ACCENT

rect(s, Inches(7.35), Inches(1.72), Pt(1), Inches(4.55), fill=RULE)
tf = textbox(s, Inches(7.75), Inches(1.72), Inches(4.9), Inches(0.35))
write(tf, "Alert pipeline", size=17, color=NAVY, bold=True, first=True, space_after=0)
flow(s, Inches(7.75), Inches(2.2), Inches(4.85),
     ["New\nnotice", "Match\nengine", "Fan-out", "Deliver"],
     height=Inches(0.85), size=11.5,
     captions=["Scraped or\ncreated", "Keyword,\ncategory, org",
               "Per-user rules,\nquota checked", "Email and\nWhatsApp"])
tf = textbox(s, Inches(7.75), Inches(4.05), Inches(4.9), Inches(2.3))
for lead, rest in [
    ("Matching. ", "Every newly published notice is evaluated against all enabled alert rules; matches update the rule's counter and last-matched timestamp."),
    ("Channels. ", "Email is delivered over SMTP; WhatsApp through a self-hosted Evolution API instance, with delivery status recorded per notification."),
    ("Digests. ", "A scheduled digest service batches matches for users who prefer a summary over immediate messages."),
]:
    p = write(tf, [("▪  ", True), (lead, True), (rest, False)], size=12.5,
              space_after=6, line=1.2)
    p.runs[0].font.color.rgb = ACCENT

# 15 — Status, deployment, conclusion
s = content_slide(prs, 15, "Deployment, Status and Next Steps")
table_block(s, MARGIN, Inches(1.72), Inches(6.35),
            ["Module", "Status"],
            [
                ("Public site and notice browser", "Complete"),
                ("Authentication and RBAC (JWT)", "Complete"),
                ("Citizen dashboard and alerts", "Complete"),
                ("Admin panel and scraping console", "Complete"),
                ("Scraping pipeline (crawl4ai)", "Complete"),
                ("RAG ingestion and query", "Complete"),
                ("Plans, quotas and billing", "Complete"),
                ("Cloud deployment and hardening", "In progress"),
            ], col_w=[3.5, 1.4], row_h=Inches(0.4))
card(s, Inches(7.5), Inches(1.72), Inches(5.1), Inches(2.1),
     "Deployment", [
         "",
         "Web on Vercel; API and AI service on EC2;",
         "PostgreSQL on a managed instance; Qdrant and",
         "Evolution API self-hosted in Docker alongside",
         "the AI service.",
     ])
card(s, Inches(7.5), Inches(4.05), Inches(5.1), Inches(2.25),
     "Next steps", [
         "",
         "• Manual CSS schema override in the admin UI",
         "  for sites that resist automatic detection.",
         "• Reranking model ahead of answer generation.",
         "• Nepali ↔ English notice translation.",
         "• Load testing against the 100-user target.",
     ])
tf = textbox(s, MARGIN, Inches(6.05), Inches(6.35), Inches(0.9))
write(tf, "Thank you — questions welcome.", size=17, color=NAVY, bold=True,
      first=True, space_after=0)

prs.save(OUT)
print("Wrote", OUT, "-", len(prs.slides.__iter__.__self__._sldIdLst), "slides")
