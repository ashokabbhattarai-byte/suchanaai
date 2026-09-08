import asyncio
import re
import time
from typing import Optional

import numpy as np

from app import config
from app import embeddings
from app import llm
from app.metrics import metrics  # the registry instance, not the module
from app import store
from app.logger import get_logger

logger = get_logger(__name__)

# Over-fetch factor: retrieve extra candidates so filtering/dedup can drop
# weak or redundant chunks and still return top_k good ones.
_CANDIDATE_MULTIPLIER = 3
_MAX_CANDIDATES = 20

# Greetings/pleasantries in English, romanized Nepali, and Devanagari.
# Matched only against short messages so document questions never hit this.
_SMALL_TALK_PHRASES = [
    "hi", "hii", "hey", "hello", "yo", "sup", "wassup", "whats up", "howdy",
    "hi there", "hello there", "hey there", "hi bro", "hello bro",
    "namaste", "namaskar", "नमस्ते", "नमस्कार",
    "good morning", "good afternoon", "good evening", "good day", "good night",
    "how are you", "how r u", "how are u", "how do you do",
    "thank you", "thanks", "thankyou", "thanku", "thx", "ty",
    "dhanyabad", "dhanyawad", "धन्यवाद",
    "ok", "okay", "k", "hmm", "nice", "cool", "great",
    "bye", "goodbye", "bye bye", "see you", "see ya", "tata",
]


def _squeeze(text: str) -> str:
    """Collapse letter runs so 'Helllloooooo' and 'hello' both become 'helo'."""
    return re.sub(r"(.)\1+", r"\1", text)


# Pre-squeezed lookup set; input is squeezed the same way before comparing.
_SMALL_TALK = {_squeeze(p) for p in _SMALL_TALK_PHRASES}


def _is_small_talk(question: str) -> bool:
    if len(question) > 40:
        return False
    text = question.strip().lower()
    # Drop punctuation/emoji, keep latin words and Devanagari; normalize spaces.
    text = re.sub(r"[^a-zऀ-ॿ\s]+", "", text)
    text = re.sub(r"\s+", " ", text).strip()
    return bool(text) and _squeeze(text) in _SMALL_TALK


# --- Semantic intent routing ---------------------------------------------
# The lexical match above only catches known phrases. For everything else
# short, the question's embedding (computed anyway for retrieval) is compared
# against prototype examples of chit-chat vs. document questions, so free-form
# human typing ("yo wassup my friend", "u there??") routes correctly.

_CHAT_EXAMPLES = [
    "hi", "hello there", "hey how are you doing", "good morning",
    "yo wassup my friend", "u there?", "are you a robot",
    "who are you", "what can you do", "what is your name",
    "nice to meet you", "lol ok cool", "haha nice one",
    "thanks a lot man", "thank you so much", "ok bye see you later",
    "how is your day going", "hows the weather today bro",
    "can you help me", "i need some help",
    "good morning ji", "hello ji", "thanks yaar", "thank u",
    "cya later", "bye cya", "ok bye",
    "नमस्ते", "तपाईं को हुनुहुन्छ", "तपाईंलाई कस्तो छ", "धन्यवाद",
    "k cha", "kasto cha", "sanchai hunuhunchha", "timro naam k ho",
    "k cha khabar", "khabar k cha", "sanchai chau",
]
_DOC_EXAMPLES = [
    "what does the notice say about the deadline",
    "when is the application deadline",
    "summarize this document",
    "what are the eligibility requirements",
    "how much budget was allocated for education",
    "who published this notice and when",
    "what documents are required for registration",
    "explain the main provisions of the policy",
    "what technologies are mentioned in the report",
    "list the key findings",
    "सूचनामा के लेखिएको छ",
    "आवेदनको म्याद कहिले सम्म हो",
    "यो कागजातको मुख्य बुँदाहरू के के हुन्",
    "notice ma k lekheko cha",
    "suchana ma k cha",
    "myad kahile samma ho",
    "budget kati chuttyaieko cha",
    "yo document ma k bhaneko cha",
    "kun technology use bhaeko cha",
]

# Similarity-difference band: outside it the embedding verdict is trusted;
# inside it (heavy textspeak, mixed-language) the LLM breaks the tie.
_INTENT_MARGIN = 0.04
_INTENT_MAX_LEN = 60

_chat_vecs: Optional[np.ndarray] = None
_doc_vecs: Optional[np.ndarray] = None


async def _detect_chat_intent(question: str, query_embedding: list[float]) -> bool:
    if len(question) > _INTENT_MAX_LEN:
        return False

    # Unambiguous pleasantries skip the embedding comparison (and its possible
    # LLM tiebreak) entirely — same verdict, no compute.
    if llm.is_small_talk(question):
        logger.info("Intent (small talk): chat for %.40r", question)
        return True

    global _chat_vecs, _doc_vecs
    if _chat_vecs is None:
        chat_embs = await asyncio.to_thread(embeddings.get_embeddings, _CHAT_EXAMPLES, kind="query")
        doc_embs = await asyncio.to_thread(embeddings.get_embeddings, _DOC_EXAMPLES, kind="query")
        _chat_vecs = np.array(chat_embs)
        _doc_vecs = np.array(doc_embs)

    q_vec = np.array(query_embedding)
    chat_sim = float(np.max(_chat_vecs @ q_vec))
    doc_sim = float(np.max(_doc_vecs @ q_vec))
    diff = chat_sim - doc_sim

    if abs(diff) >= _INTENT_MARGIN:
        is_chat = diff > 0
        logger.info(
            "Intent (embedding): %s (chat=%.3f, doc=%.3f) for %.40r",
            "chat" if is_chat else "document",
            chat_sim,
            doc_sim,
            question,
        )
        return is_chat

    verdict = await llm.classify_intent(question)
    logger.info(
        "Intent (LLM tiebreak): %s (chat=%.3f, doc=%.3f) for %.40r",
        verdict or "unavailable->document",
        chat_sim,
        doc_sim,
        question,
    )
    return verdict == "chat"


def _select_context(results: list[dict], top_k: int) -> list[dict]:
    """Filter candidates: drop low-score hits and near-duplicate chunks.
    Then merge adjacent chunks from the same document/page/section for
    coherent citations with page-range output."""
    selected: list[dict] = []
    seen_chunk_keys: set[tuple[str, int]] = set()
    seen_content_hashes: set[str] = set()

    for r in results:
        if r["score"] < config.RAG_SCORE_THRESHOLD:
            continue
        # Primary dedup: same doc + chunk_index (exact duplicate)
        chunk_key = (r.get("doc_id", ""), r.get("chunk_index", -1))
        if chunk_key in seen_chunk_keys:
            continue
        seen_chunk_keys.add(chunk_key)
        # Secondary dedup: hash of normalized full content (handles re-indexed
        # chunks) — only drops exact content duplicates, not shared prefixes.
        import hashlib
        content_hash = hashlib.md5(" ".join(r["content"].split()).lower().encode()).hexdigest()
        if content_hash in seen_content_hashes:
            continue
        seen_content_hashes.add(content_hash)
        selected.append(r)
        if len(selected) >= top_k:
            break

    # Merge adjacent chunks from same document/page/section
    return _merge_adjacent_chunks(selected)


_CITATION = re.compile(r"\[(\d+)\]")


def _drop_dangling_citations(answer: str, n_sources: int) -> str:
    """Remove citation markers that point past the context actually supplied.

    The UI numbers its source chips from the same list the prompt was built
    from, so a "[7]" written against three context blocks resolves to
    nothing the reader can open — a reference that looks authoritative and
    is not. Dropping the marker leaves the prose intact and honest.
    """
    if not answer:
        return answer
    if n_sources <= 0:
        return _CITATION.sub("", answer).strip()

    dropped: list[str] = []

    def _keep(match: re.Match) -> str:
        if 1 <= int(match.group(1)) <= n_sources:
            return match.group(0)
        dropped.append(match.group(0))
        return ""

    cleaned = _CITATION.sub(_keep, answer)
    if dropped:
        logger.warning(
            "Dropped %d out-of-range citation(s) %s (only %d context blocks)",
            len(dropped),
            ", ".join(sorted(set(dropped))),
            n_sources,
        )
    # Removing a marker can leave " ." or a double space behind.
    cleaned = re.sub(r"[ \t]{2,}", " ", cleaned)
    return re.sub(r"\s+([.,;:!?])", r"\1", cleaned).strip()


def _page_of(chunk: dict) -> Optional[int]:
    """Page number, wherever the store left it.

    `store.search` returns indexed payload fields nested under "metadata",
    but chunks are handled top-level elsewhere in this module. Reading only
    the top level is what made every merged `page_range` come out as
    [None, None] — the range was computed correctly against a key that was
    never there."""
    page = chunk.get("page_num")
    if page is None:
        page = (chunk.get("metadata") or {}).get("page_num")
    return page


def _section_of(chunk: dict) -> str:
    """Section path ("Introduction > Eligibility"), from either shape."""
    section = chunk.get("section_path")
    if not section:
        section = (chunk.get("metadata") or {}).get("section_path")
    return str(section or "")


def _merge_adjacent_chunks(chunks: list[dict]) -> list[dict]:
    """Merge adjacent chunks from the same document/page/section.
    Returns merged chunks with page_range metadata for citations."""
    if not chunks:
        return chunks

    def _seed_range(chunk: dict) -> None:
        if "page_range" not in chunk:
            page = _page_of(chunk)
            chunk["page_range"] = [page, page]

    merged: list[dict] = []
    current = chunks[0].copy()

    for next_chunk in chunks[1:]:
        # Check if chunks are from same doc and adjacent (chunk_index diff <= 1)
        same_doc = current["doc_id"] == next_chunk["doc_id"]
        adjacent = next_chunk["chunk_index"] - current["chunk_index"] <= 1
        same_section = _section_of(current) == _section_of(next_chunk)

        if same_doc and adjacent and same_section:
            # Merge: concatenate content, update ranges
            current["content"] += "\n\n" + next_chunk["content"]
            current["char_end"] = next_chunk.get("char_end") or current.get("char_end")
            current["chunk_index"] = current["chunk_index"]  # keep first index
            # Track page range
            _seed_range(current)
            next_page = _page_of(next_chunk)
            if next_page is not None:
                # A merged span runs from its first page to its last; seeding
                # from a chunk with no page must not pin the low end to None.
                if current["page_range"][0] is None:
                    current["page_range"][0] = next_page
                current["page_range"][1] = next_page
        else:
            # Finalize current, start new
            _seed_range(current)
            merged.append(current)
            current = next_chunk.copy()

    # Don't forget the last chunk
    _seed_range(current)
    merged.append(current)

    return merged


async def query(
    question: str,
    doc_id: Optional[str] = None,
    doc_ids: Optional[list[str]] = None,
    top_k: int = 5,
    language: str = "en",
) -> dict:
    logger.info(
        "RAG query (doc_id=%s, doc_ids=%s, top_k=%d, lang=%s): %.80s",
        doc_id,
        f"[{len(doc_ids)} ids]" if doc_ids else None,
        top_k,
        language,
        question,
    )

    async def _chat_reply() -> dict:
        answer = await llm.generate_chat(question, language)
        return {
            "answer": answer,
            "sources": [],
            "model_used": config.GROQ_MODEL if config.GROQ_API_KEY else None,
        }

    if _is_small_talk(question):
        logger.info("Small talk detected (lexical); skipping retrieval")
        return await _chat_reply()

    query_embedding = await asyncio.to_thread(embeddings.get_embedding, question, kind="query")

    if await _detect_chat_intent(question, query_embedding):
        logger.info("Small talk detected (semantic); skipping retrieval")
        return await _chat_reply()

    search_start = time.perf_counter()
    candidates = store.search(
        query_embedding=query_embedding,
        query_text=question,
        top_k=min(top_k * _CANDIDATE_MULTIPLIER, _MAX_CANDIDATES),
        filter_doc_id=doc_id,
        filter_doc_ids=doc_ids,
    )
    metrics.histogram("search_latency").observe(time.perf_counter() - search_start)
    metrics.counter("searches_total").inc()

    results = _select_context(candidates["results"], top_k)
    search_mode = candidates["mode"]
    logger.info(
        "Retrieved %d candidates, kept %d after threshold/dedup (mode=%s)",
        len(candidates["results"]),
        len(results),
        search_mode,
    )

    if not results:
        return {
            "answer": await llm.generate_no_results(question, language),
            "sources": [],
            "model_used": config.GROQ_MODEL if config.GROQ_API_KEY else None,
        }

    # Locators travel with the context: a model told to cite [2] can only
    # make that citation mean something if block [2] says which page and
    # section it came from. Without them two chunks of the same document are
    # indistinguishable in the prompt, which is exactly when citations drift.
    context_chunks = [
        {
            "content": r["content"],
            "title": r["metadata"].get("title", ""),
            "page_range": r.get("page_range"),
            "section_path": _section_of(r),
        }
        for r in results
    ]

    answer = await llm.generate_answer(question, context_chunks, language)
    answer = _drop_dangling_citations(answer, len(results))

    model_used = config.GROQ_MODEL if config.GROQ_API_KEY else "extractive"
    logger.info(
        "RAG query answered from %d sources (model=%s)", len(results), model_used
    )

    sources = [
        {
            "doc_id": r["doc_id"],
            "chunk_index": r["chunk_index"],
            "content": r["content"],
            "score": r["score"],
            "title": r["metadata"].get("title", ""),
            # What the citation [i+1] in the answer actually points at.
            "page_range": [p for p in (r.get("page_range") or []) if p is not None] or None,
            "section_path": _section_of(r) or None,
        }
        for r in results
    ]

    return {
        "answer": answer,
        "sources": sources,
        "model_used": model_used,
        "search_mode": search_mode,
    }
