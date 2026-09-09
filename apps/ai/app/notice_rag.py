"""RAG pipeline for the public notices chatbot — hybrid search with
PostgreSQL keyword results (passed from the NestJS API) + Qdrant semantic
fallback. The LLM synthesizes an answer from the retrieved context."""

import asyncio
import random

from app import clarify
from app import config
from app import llm
from app import notice_store
from app.logger import get_logger

logger = get_logger(__name__)

_NOTICES_SYSTEM_PROMPT = """You are Suchana AI, an assistant for a Nepalese public notice portal. Answer the user's question using ONLY the provided notice context.

Rules:
- Ground every claim in the context. Never invent facts, numbers, dates, or names.
- If multiple notices are relevant, synthesize the key information from each.
- Open with ONE sentence that answers the question directly. Never open with a heading.
- If the answer has more than one part, break the detail into short **bold** section headings of 2-4 words, each followed by bullets.
- One idea per bullet, one line each — under 20 words. NEVER write a paragraph longer than 3 sentences; a wall of text is a failed answer.
- Bold the key figure, date or term inside a bullet so it can be found by scanning.
- When several notices are relevant, or the answer lists items sharing the same fields (deadlines, categories, sources, fees), present them as a Markdown table with a header row. At least two rows and two columns, otherwise bullets.
- Keep answers concise (1-2 sentences for factual lookups, up to ~250 words for broader questions).
- Answer in the same language the question is asked in. If the content is in Nepali but the question is in English, translate and explain in English.
- Answer whenever the context is relevant, even partially. If the notices cover
  part of the question, give what they establish and then name what they do not
  cover. Refusing outright when related notices are present is a wrong answer.
- A notice is relevant if it is about the same subject, even when its wording
  differs from the question — the corpus is mostly Nepali, so an English
  question will rarely share words with the notice that answers it.
- Only say nothing was found when the context is genuinely about other subjects.
- If the context doesn't contain the answer, say so plainly — do not guess.
- When citing a specific notice, mention its title in quotes so the user knows which one.
- Every notice carries a "Published" date. Use THAT date when the user asks
  when something was posted, and never present a date found inside a summary
  (often a Bikram Sambat date from the notice body) as the publication date.
- NEVER combine figures from different notices into one total. Death tolls,
  amounts, quotas and counts belong to the specific incident, scheme or period
  their notice reports. Adding them together invents a number no notice states.
- When the notices report different incidents or periods, give each figure
  separately and say which incident, date and source it comes from. Never
  present one incident's figure as the answer to a general question.
- If the question asks for a single figure but the notices cover several
  distinct events, say so plainly and list what each one reports, rather than
  choosing one silently.
- The context is ordered — [1] is the best match for the question. For
  "latest"/"recent" questions it is ordered newest first, so answer from the
  top of the list and give each notice's published date.
- Only the notices in the context exist. Never imply the list is exhaustive
  beyond it, and never claim a notice is the newest unless its Published date
  is the most recent one you were given.
- Answer directly — no filler like "Based on the notices..." or "According to the context..."."""

_NO_RESULTS_PROMPT = """You are Suchana AI, an assistant for a Nepalese public notice portal. The user asked a question but no relevant notices were found in the database.

Tell them so in 1-2 sentences. Suggest they try different keywords or browse the notices page. Be honest — never fabricate information about notices. Vary your wording naturally."""

# Tone only — structure comes from the rules above, not from chance.
_STYLE_HINTS = [
    "Keep the wording plain and direct.",
    "Be as concise as accuracy allows.",
    "Frame the answer as a quick briefing.",
]


async def search_and_answer(
    question: str,
    pg_results: list[dict] | None = None,
    category: str | None = None,
    language: str = "en",
    top_k: int = 5,
    recency_intent: bool = False,
    skip_clarification: bool = False,
) -> dict:
    """Hybrid notice search: use PG keyword results if provided, otherwise
    fall back to Qdrant semantic search. Then generate an LLM answer.

    pg_results: pre-fetched keyword search results from PostgreSQL (passed by
                the NestJS API). Each dict has: id, title, aiSummary, category,
                sourceLabel, sourceUrl, publishedAt.
    recency_intent: the API parsed the question as asking for the newest
                items ("latest tender notices"). Similarity order is the wrong
                axis for those, so the context is re-sorted by date.
    skip_clarification: set when the user has already been asked to
                disambiguate and chose to see everything anyway — suppresses
                the ambiguity gate so the same question can't loop.
    """
    logger.info(
        "Notice search (pg_results=%d, category=%s, top_k=%d): %.80s",
        len(pg_results) if pg_results else 0,
        category,
        top_k,
        question,
    )

    # Greetings and thanks get a conversational reply — searching the notice
    # corpus for "hello" only ever produced a "nothing found" message.
    if llm.is_small_talk(question):
        return {
            "answer": await llm.generate_chat(
                question, language, context_hint="Nepalese public notices"
            ),
            "sources": [],
            "model_used": _model_name(),
        }

    # Both legs always run, then fuse. The previous either/or ("if we got any
    # keyword hit, don't bother searching semantically") meant one weak
    # literal match — the word "policy" buried in an unrelated PDF — silently
    # suppressed the semantic leg, which is the only leg that can match an
    # English question against a Nepali notice at all.
    keyword_hits = list(pg_results or [])
    # Off the event loop: the dense leg encodes the question and calls Qdrant,
    # both blocking, and this worker serves /health from the same loop.
    semantic_hits = await asyncio.to_thread(_semantic_search, question, category, top_k)
    sources = _fuse(keyword_hits, semantic_hits, top_k)
    logger.info(
        "Retrieval: %d keyword + %d semantic → %d fused",
        len(keyword_hits),
        len(semantic_hits),
        len(sources),
    )

    if not sources:
        no_result_answer = await _generate_no_results(question, language)
        return {
            "answer": no_result_answer,
            "sources": [],
            "model_used": _model_name(),
        }

    if recency_intent:
        sources = _by_published_desc(sources)

    # "How many are dead?" matches flood, earthquake and road-accident
    # notices equally well — each with a different toll. Answering from the
    # top hit picks one at random; the gate asks which one instead. Its
    # options come from `sources`, so every choice offered is one the corpus
    # can actually answer.
    if not skip_clarification and clarify.looks_underspecified(question):
        clarification = await clarify.assess(question, sources, language)
        if clarification:
            return {
                "answer": clarification["question"],
                "clarification": clarification,
                "sources": _source_payload(sources),
                "model_used": _model_name(),
            }

    # Published dates are part of the context: without them the model has no
    # way to answer "latest"/"when" questions and will quote whatever date it
    # finds inside a summary — typically the Bikram Sambat date printed in the
    # notice body, which is not the publication date.
    context = "\n\n".join(
        f"[{i+1}] Title: \"{s.get('title', 'Untitled')}\"\n"
        f"Category: {s.get('category', 'NOTICE')}\n"
        f"Source: {s.get('sourceLabel', '')}\n"
        f"Published: {_published_label(s)}\n"
        f"{_source_body(s, budget)}"
        for i, (s, budget) in enumerate(_with_budgets(sources))
    )

    style = random.choice(_STYLE_HINTS)
    lang_instruction = ""
    if language == "ne":
        lang_instruction = "\nRespond in Nepali (Devanagari script)."

    messages = [
        {"role": "system", "content": f"{_NOTICES_SYSTEM_PROMPT}{lang_instruction}\n\nFor this answer: {style}"},
        {"role": "user", "content": f"Context (notices found):\n{context}\n\nQuestion: {question}"},
    ]

    # Budget covers reasoning tokens too — a reasoning model spends most of
    # this before emitting any content, and 800 left nothing for the answer.
    answer = await llm._llm_chat(messages, max_tokens=2000, temperature=config.TEMPERATURE_ANSWERS)
    if answer is None:
        answer = _extractive_fallback(sources)

    return {
        "answer": answer,
        "sources": _source_payload(sources),
        "model_used": _model_name(),
    }


def _source_payload(sources: list[dict]) -> list[dict]:
    """The subset of each retrieved notice the clients render as citations."""
    return [
        {
            "id": s.get("id", ""),
            "title": s.get("title", ""),
            "category": s.get("category", ""),
            "sourceUrl": s.get("sourceUrl", ""),
            "score": s.get("score", 1.0),
        }
        for s in sources
    ]


def _semantic_search(question: str, category: str | None, top_k: int) -> list[dict]:
    """Dense-vector leg. Over-fetches, then applies an absolute floor and a
    margin relative to the best hit.

    The floor matters: the codebase's own note on E5 scores puts *irrelevant*
    hits at ~0.76-0.78, so the 0.75 this used to hardcode admitted results it
    already knew to be noise — and the model then dutifully summarised them as
    though they answered the question."""
    raw = notice_store.search(
        query_text=question,
        # Over-fetch so the margin gate has a real distribution to cut
        # against rather than just the top_k it was going to return anyway.
        top_k=max(top_k * 3, 15),
        category=category,
    )
    if not raw:
        return []

    best = max(r["score"] for r in raw)
    floor = max(config.NOTICE_SCORE_THRESHOLD, best - config.NOTICE_SCORE_MARGIN)
    kept = [
        {
            "id": r["notice_id"],
            "title": r["title"],
            "aiSummary": r["ai_summary"],
            "contentExcerpt": r.get("content_excerpt", ""),
            "category": r["category"],
            "sourceLabel": r["source_label"],
            "sourceUrl": r["source_url"],
            "publishedAt": r.get("published_at"),
            "score": r["score"],
        }
        for r in raw
        if r["score"] >= floor
    ]
    logger.info(
        "Semantic leg: %d/%d kept (best=%.3f, floor=%.3f)", len(kept), len(raw), best, floor
    )
    return kept


def _fuse(keyword_hits: list[dict], semantic_hits: list[dict], top_k: int) -> list[dict]:
    """Reciprocal-rank fusion of the two legs.

    RRF rather than raw scores because the legs aren't comparable: one is a
    cosine similarity, the other a Postgres keyword ranking. A notice found by
    *both* legs outranks one found by either alone, which is exactly the
    signal we want — agreement between an exact term match and a semantic
    match is the strongest evidence a notice is on-topic.
    """
    K = 60  # standard RRF damping; large enough that rank 1 vs 2 isn't decisive
    fused: dict[str, dict] = {}
    ranks: dict[str, float] = {}

    for leg in (keyword_hits, semantic_hits):
        for rank, hit in enumerate(leg):
            key = hit.get("id") or hit.get("notice_id") or hit.get("title", "")
            if not key:
                continue
            ranks[key] = ranks.get(key, 0.0) + 1.0 / (K + rank + 1)
            # First writer wins on metadata, but a semantic hit carries a
            # score the keyword leg doesn't — keep it when it shows up.
            if key in fused:
                if "score" in hit and "score" not in fused[key]:
                    fused[key]["score"] = hit["score"]
            else:
                fused[key] = dict(hit)

    ordered = sorted(fused.items(), key=lambda kv: ranks[kv[0]], reverse=True)
    return [hit for _, hit in ordered[:top_k]]


async def _generate_no_results(question: str, language: str) -> str:
    if config.GEMINI_API_KEY or config.GROQ_API_KEY:
        messages = [
            {"role": "system", "content": _NO_RESULTS_PROMPT},
            {"role": "user", "content": question},
        ]
        answer = await llm._llm_chat(messages, max_tokens=150, temperature=config.TEMPERATURE_CONVERSATION)
        if answer:
            return answer

    return "I couldn't find any relevant notices for that question. Try different keywords or browse the notices page directly."


# Bodies run from a few hundred characters to 1.4M, so the context needs a hard
# ceiling as well as a per-notice cap — otherwise one long notice crowds out the
# other four, or the request blows the model's context window entirely.
_CONTEXT_CHAR_BUDGET = 14000
_MIN_SOURCE_CHARS = 700


def _with_budgets(sources: list[dict]) -> list[tuple[dict, int]]:
    """Pair each source with the character budget its body may use.

    Earlier sources rank higher, so they get the larger share; the floor keeps
    the tail from collapsing to a title-only entry.
    """
    if not sources:
        return []
    per_source = max(_CONTEXT_CHAR_BUDGET // len(sources), _MIN_SOURCE_CHARS)
    return [(s, per_source) for s in sources]


def _source_body(source: dict, budget: int) -> str:
    """Best available text for one notice, trimmed to its budget.

    Prefers the AI summary because it is already condensed, but 4 out of 5
    notices don't have one — for those the body is the only thing that can
    answer a question, and sending "No summary available" guaranteed it
    couldn't.
    """
    summary = (source.get("aiSummary") or "").strip()
    body = (source.get("contentExcerpt") or source.get("contentText") or "").strip()

    if summary and body:
        room = budget - len(summary)
        if room >= _MIN_SOURCE_CHARS // 2:
            return f"Summary: {summary}\nExcerpt: {_trim(body, room)}"
        return f"Summary: {_trim(summary, budget)}"
    if summary:
        return f"Summary: {_trim(summary, budget)}"
    if body:
        return f"Excerpt: {_trim(body, budget)}"
    return "Summary: No summary available"


def _trim(text: str, limit: int) -> str:
    """Cut on a word boundary so the model never sees a half-word."""
    if limit <= 0 or len(text) <= limit:
        return text
    cut = text[:limit]
    space = cut.rfind(" ")
    if space > limit * 0.6:
        cut = cut[:space]
    return cut.rstrip() + "…"


def _published_label(source: dict) -> str:
    """YYYY-MM-DD from whatever the caller sent (the API sends ISO 8601)."""
    raw = source.get("publishedAt") or source.get("published_at")
    if not raw:
        return "unknown"
    return str(raw)[:10]


def _by_published_desc(sources: list[dict]) -> list[dict]:
    """Newest first; undated notices sink to the bottom rather than the top,
    where an empty date would otherwise sort as the largest value."""
    return sorted(sources, key=lambda s: (_published_label(s) != "unknown", _published_label(s)), reverse=True)


def _extractive_fallback(sources: list[dict]) -> str:
    """Used when every LLM provider failed. It is a search-result list, not an
    answer, and says so — the previous wording ("Here are the most relevant
    notices") read as a considered response to whatever was asked, so a
    provider outage looked like a confidently wrong answer."""
    lines = []
    for s in sources[:5]:
        title = s.get("title", "Untitled")
        # Fall through the summary fields — keying only on aiSummary rendered
        # notices that have a Nepali or scraped summary as a bare title.
        summary = s.get("aiSummary") or s.get("aiSummaryNe") or s.get("summary") or ""
        published = _published_label(s)
        source_label = s.get("sourceLabel") or ""
        meta = " · ".join(p for p in (source_label, published if published != "unknown" else "") if p)
        meta_part = f"\n_{meta}_" if meta else ""
        lines.append(f"**{title}**" + (f"\n{summary}" if summary else "") + meta_part)
    return (
        "I couldn't generate a summary just now, but here are the notices that "
        "best match your search:\n\n" + "\n\n".join(lines)
    )


def _model_name() -> str | None:
    """Model an answer would come from right now — the head of the live
    fallback chain, not a hardcoded guess. Reading the registry keeps this
    honest as admins reorder providers or add new ones (e.g. Bedrock)."""
    providers = llm.active_providers()
    return providers[0].get("model") if providers else None
