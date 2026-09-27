"""Ambiguity gate for corpus-wide notice questions.

"How many are dead?" names no subject. The corpus holds death tolls from
floods, earthquakes, road accidents and fires — each a different number,
each stated by a different notice. Answering from the top-ranked hit
silently picks one of them; adding them up invents a total no notice
states. Both are confidently-delivered wrong answers, and both are what
this module exists to prevent: when the retrieved notices would each give
a *different* answer to the question as asked, ask which one the user
means instead of guessing.

The gate is deliberately two-stage. `looks_underspecified` is a free
regex pre-filter that rules out the overwhelmingly common case (a
question that names its own subject), so the LLM call below only happens
for questions that might actually be ambiguous — no latency tax on
ordinary lookups. `assess` then decides on the *evidence*: it sees the
notices that were actually retrieved, so a clarifying question can only
ever offer choices that exist in the corpus and are therefore answerable.
"""

import json
import re

from app import config
from app import llm
from app.logger import get_logger

logger = get_logger(__name__)

# Questions that seek one specific fact — a count, an amount, a date, a
# name. These are the ones whose answer changes depending on which event
# the user meant. Broad questions ("what's new", "tell me about floods")
# are answerable as asked and never reach the LLM gate.
_FACT_SEEKING = [
    re.compile(r"\bhow many\b", re.I),
    re.compile(r"\bhow much\b", re.I),
    re.compile(r"\bhow long\b", re.I),
    re.compile(r"\bhow old\b", re.I),
    re.compile(r"\btotal (number|amount|count)\b", re.I),
    re.compile(r"\bwhat (is|are|was|were) the\b.*\b(deadline|fee|amount|total|date|cost|salary|number|limit|quota|toll)\b", re.I),
    re.compile(r"\bwhen (is|was|does|did|will)\b", re.I),
    re.compile(r"\bwho (died|won|is|are|was|were)\b", re.I),
    re.compile(r"\b(death toll|casualt|fatalit)", re.I),
    # Nepali: कति (how many/much), कहिले (when), कति जना (how many people)
    re.compile(r"कति"),
    re.compile(r"कहिले"),
    re.compile(r"मृत्यु|मरे|घाइते"),
]

# An anchor is anything that pins the question to one subject: an explicit
# year, or a quoted title. Their presence means the user already told us
# which one they meant, so the gate stays out of the way.
_YEAR = re.compile(r"\b(19|20)\d{2}\b")
_QUOTED = re.compile(r"[\"'“”‘’].+?[\"'“”‘’]")
_RECENCY = re.compile(
    r"\b(recent|latest|newest|current|today|yesterday|now|updated|पछिल्लो|हाल|आज|भर्खर|अहिले|नयाँ)\b",
    re.I,
)

# Beyond this a question carries enough of its own context (place, event,
# organisation) that treating it as under-specified is more likely to
# annoy than to help.
_MAX_WORDS = 14

_ASSESS_PROMPT = """You decide whether a question about a corpus of Nepalese public notices can be answered as asked, or whether it is ambiguous and needs ONE clarifying question first.

You are given the user's question and the notices that were retrieved for it.

Ask for clarification ONLY when ALL of these hold:
1. The question asks for one specific fact — a number, a date, an amount, a name, or a status.
2. The retrieved notices describe two or more DIFFERENT subjects: different incidents, events, disasters, schemes, exams, organisations, or reporting periods.
3. Those different subjects would each give a DIFFERENT answer to the question.

Do NOT ask for clarification when:
- All the notices concern the same subject, even if worded differently, or are follow-up updates on one event.
- The question is broad or exploratory ("what's new", "summarise recent notices", "tell me about floods") — answer those as asked.
- The user explicitly asks for all of them, a total across all, or a comparison.
- Only one notice is genuinely relevant.
- You could answer completely by listing each subject separately in a short answer. Prefer answering over asking.

When you DO ask:
- "question": one short clarifying sentence, in the SAME language as the user's question. Name precisely what is ambiguous.
- "options": 2 to 5 choices drawn STRICTLY from the retrieved notices. Never invent a subject that is not in them.
  - "label": a short human label (max 8 words) naming that specific event or subject. Include the place or date when that is what distinguishes it from the others.
  - "query": the user's original question rewritten to name that subject explicitly, so it can be answered directly on its own.

Return ONLY raw JSON, no prose and no code fences:
{"ambiguous": true, "question": "...", "options": [{"label": "...", "query": "..."}]}
or
{"ambiguous": false}"""


def looks_underspecified(question: str) -> bool:
    """Cheap pre-filter: could this question be ambiguous enough to be worth
    an LLM check? Deliberately permissive — the LLM gate makes the real
    decision, this only avoids paying for it on questions that plainly name
    their own subject."""
    text = (question or "").strip()
    if not text:
        return False
    if not any(p.search(text) for p in _FACT_SEEKING):
        return False
    if _YEAR.search(text) or _QUOTED.search(text) or _RECENCY.search(text):
        return False
    return len(text.split()) <= _MAX_WORDS


async def assess(question: str, sources: list[dict], language: str = "en") -> dict | None:
    """Decide, against the retrieved notices, whether to ask a clarifying
    question. Returns {"question": str, "options": [{label, query}]} or None
    to mean "answer it normally".

    Every failure mode here — no provider, unparseable output, too few
    options — resolves to None. Falling through to a real answer is always
    safer than blocking one behind a broken clarification.
    """
    if not llm.any_provider_configured():
        return None
    # One option is not a choice, and zero subjects cannot conflict.
    if len(sources) < 2:
        return None

    context = "\n\n".join(
        f"[{i + 1}] Title: \"{s.get('title', 'Untitled')}\"\n"
        f"Category: {s.get('category', 'NOTICE')}\n"
        f"Published: {str(s.get('publishedAt') or s.get('published_at') or 'unknown')[:10]}\n"
        f"Summary: {s.get('aiSummary', '') or 'No summary available'}"
        for i, s in enumerate(sources)
    )
    lang_note = "\nThe user asked in Nepali — write the clarifying question and labels in Nepali." if language == "ne" else ""

    messages = [
        {"role": "system", "content": f"{_ASSESS_PROMPT}{lang_note}"},
        {"role": "user", "content": f"Notices retrieved:\n{context}\n\nUser question: {question}"},
    ]

    raw = await llm._llm_chat(messages, max_tokens=500, temperature=config.TEMPERATURE_SUMMARIES)
    if raw is None:
        return None

    cleaned = re.sub(r"^```(json)?|```$", "", raw.strip(), flags=re.MULTILINE).strip()
    try:
        data = json.loads(cleaned)
    except json.JSONDecodeError:
        logger.warning("clarify.assess: could not parse LLM JSON output")
        return None

    if not isinstance(data, dict) or not data.get("ambiguous"):
        return None

    clarifying = str(data.get("question") or "").strip()
    options = []
    for opt in data.get("options") or []:
        if not isinstance(opt, dict):
            continue
        label = str(opt.get("label") or "").strip()
        query = str(opt.get("query") or "").strip()
        if label and query:
            options.append({"label": label[:80], "query": query})

    # A clarifying question the user cannot act on is worse than an answer:
    # without at least two concrete, corpus-backed choices, fall through.
    if not clarifying or len(options) < 2:
        return None

    logger.info("Clarification requested (%d options): %.80s", len(options), question)
    return {"question": clarifying, "options": options[:5]}
