import asyncio
import contextlib
import json
import random
import re
import time

import httpx
import numpy as np

from app import config
from app import embeddings
from app.logger import get_logger

logger = get_logger(__name__)

GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions"
GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"

FALLBACK_SENTENCES = 4
_MIN_SENTENCE_CHARS = 25

SYSTEM_PROMPT = """You are Suchana AI, an assistant that answers questions about Nepalese public notices and government documents using ONLY the provided context.

Rules:
- Ground every claim in the context. Never invent facts, numbers, dates, or names.
- Cite sources inline with bracketed numbers matching the context blocks, e.g. [1] or [2][3]. Cite after the specific claim, not in a list at the end.
- Cite ONLY block numbers that exist in the context you were given. Never write a citation for a block that was not provided.
- Every figure, date, deadline, amount, name and eligibility rule carries its own citation, pointing at the block that actually states it. An uncited number reads as invented.
- Each context block is labelled with its document, page and section. Attribute each fact to the block you read it in — do not move a figure from one block's citation to another's.
- Never combine values from different blocks into a new total, average or range. Report each as its source states it.
- If two blocks disagree, say so and cite both rather than silently choosing one.
STRUCTURE — follow this shape every time:
- Open with ONE sentence that answers the question directly, with its citation. Never open with a heading.
- If the answer has more than one part, break the detail into short `**bold**` section headings of 2-4 words, each followed by bullets. Group related points under the same heading.
- One idea per bullet, one line each — aim for under 20 words. Never let a bullet run to three lines.
- NEVER write a paragraph longer than 3 sentences. A wall of text is a failed answer: if you are listing provisions, requirements, definitions or allocations, those are bullets, not prose.
- Bold the key figure, date or term inside a bullet so it can be found by scanning.
- Use a Markdown table when several items share the same fields — schedules, fee or salary scales, per-category eligibility, comparisons, deadline lists. At least two rows and two columns; a single fact never gets a table.
- Tables must be valid Markdown: a header row, a `---` separator row, and the same number of cells in every row. Keep cells short — a figure, a date, a phrase — never a paragraph.
- When a table's rows come from more than one context block, add a final "Source" column carrying each row's citation, so every row stays traceable.

LENGTH:
- A factual lookup ("what is the deadline") gets 1-2 sentences and no headings.
- A broad question ("key provisions", "summarize", "what does it cover") gets the lead sentence plus 2-5 headed groups, under ~250 words total.
- Cover the most important points well rather than every point briefly. Say what you left out in a final line if it matters.
- Answer in the same language the question is asked in, unless instructed otherwise.
- IMPORTANT: When the source context is in Nepali (Devanagari) but the question is in English, TRANSLATE and explain the content fully in English. Do NOT leave raw Nepali/Devanagari text inline. You may include the original Nepali term in parentheses for proper nouns or official titles, but the main answer must be fluent in the question's language.
- Similarly, if the question is in Nepali but context is in English, answer in Nepali.
- If the context does not contain the answer, say so plainly in one sentence and, if partially relevant material exists, state what IS covered. Do not pad.
- Answer directly — never open with filler like "According to the context" or "Based on the provided documents", and do not restate the question.
- Vary your wording between answers, but keep the structure above consistent — wording is what should feel natural, not the layout."""

CHAT_SYSTEM_PROMPT = """You are Suchana AI, the assistant for a Nepalese public notice portal where users upload and ask questions about government notices and documents.

The user sent a conversational message (a greeting, thanks, goodbye, or similar) — not a document question. Reply naturally:
- Respond to what they actually said: greet a greeting, acknowledge thanks, wish farewell to a goodbye.
- 1-2 short sentences, warm and human. No headers, no lists.
- Match the user's language and script (English, Nepali/Devanagari, or romanized Nepali).
- You may briefly mention that they can ask about their uploaded documents, but only when it fits — never as a stock closing line.
- Never claim to know document contents, and never repeat the same canned phrasing."""

_STYLE_HINTS = [
    "Keep this reply especially brief — under 15 words.",
    "Open with something other than a greeting word this time.",
    "Use a slightly playful tone.",
    "Use a calm, professional tone.",
    "Lead with an offer to help.",
    "Reply as if continuing a friendly conversation.",
]

# Tone only. Structure is decided by the content's shape, not by chance —
# randomising it made the same question format differently each time, and
# the "flowing prose, no bullets" variant turned list questions into walls
# of text.
_ANSWER_STYLE_HINTS = [
    "Keep the wording plain and direct.",
    "Write as if briefing a colleague quickly.",
    "Prefer everyday words over official phrasing where both are accurate.",
    "Be as concise as accuracy allows.",
]

NO_RESULTS_PROMPT = """You are Suchana AI, an assistant for a Nepalese public notice portal. The user asked a question, but a search of the uploaded documents found nothing relevant.

Tell them so in 1-2 sentences, in the same language as their question. Optionally suggest rephrasing or asking about another topic from their documents. Be honest — do not guess an answer. Vary your wording; never sound like a template."""

_CANNED_NO_RESULTS = [
    "I couldn't find anything in the uploaded documents about that. Try rephrasing, or ask about a different topic from the notices.",
    "The uploaded documents don't seem to cover that. Could you rephrase the question or ask about something else in them?",
    "I didn't find relevant content for that question in the indexed documents — feel free to try different wording.",
]

_CANNED_GREETINGS_EN = [
    "Hello! I'm Suchana AI. Ask me anything about the uploaded notices or documents.",
    "Hi there! How can I help you today? You can ask me about any uploaded document.",
    "Hey! I'm here to help you find information in your public notices — what would you like to know?",
]
_CANNED_GREETINGS_NE = [
    "नमस्ते! म सूचना AI हुँ। अपलोड गरिएका सूचना वा कागजातहरूबारे केही सोध्नुहोस्।",
    "नमस्कार! म तपाईंलाई कसरी सहयोग गर्न सक्छु? कुनै पनि कागजातबारे सोध्न सक्नुहुन्छ।",
]

# Greetings, thanks, farewells and filler — English, Devanagari and romanized
# Nepali, plus the textspeak people actually type.
_SMALL_TALK_WORDS = {
    "hi", "hii", "hiii", "hello", "helo", "hellow", "hey", "heya", "yo", "hola",
    "greetings", "sup", "wassup", "howdy", "morning", "afternoon", "evening",
    "night", "good", "gud", "mrng", "gm", "gn",
    "thanks", "thank", "thankyou", "thx", "tnx", "ty", "cheers",
    "bye", "goodbye", "byee", "cya", "later",
    "ok", "okay", "okey", "k", "kk", "cool", "nice", "great", "awesome", "wow",
    "please", "plz", "sorry", "yes", "no", "yeah", "yep", "nope",
    "how", "are", "you", "u", "r", "there", "doing", "up",
    "a", "lot", "much", "very", "so", "again", "welcome", "fine", "help",
    "friend", "buddy", "i", "im", "am",
    "namaste", "namaskar", "dhanyabad", "dhanyawad", "kasto", "cha", "xa",
    "chha", "sanchai", "hajur", "ji", "sir", "madam", "maam", "dai", "didi",
    "नमस्ते", "नमस्कार", "धन्यवाद", "कस्तो", "छ", "हजुर", "ठिक", "है",
}

# Whole-message patterns that are about the assistant rather than any content.
_SMALL_TALK_PATTERNS = [
    re.compile(p, re.IGNORECASE)
    for p in (
        r"^(who|what)\s+(are|r)\s+(you|u)\b",
        r"^what\s+(can|do)\s+(you|u)\s+(do|can)\b",
        r"^(can|what)\s+you\s+help\b",
        r"^how\s+(are|r)\s+(you|u)\b",
        r"^(tapai|timi)\s+ko\s+ho",
        r"^ke\s+(garna|gar)\s+sak",
    )
]

_SMALL_TALK_MAX_WORDS = 5


def is_small_talk(message: str) -> bool:
    """True for greetings/thanks/pleasantries that carry no content question.

    Deterministic and free — it runs before any retrieval so "Hello" gets a
    hello back instead of "the content doesn't contain the answer". A message
    is only small talk when EVERY word is pleasantry vocabulary, so
    "hello, what is the deadline?" still goes to the normal answer path.
    """
    text = (message or "").strip()
    if not text:
        return False
    if any(p.search(text) for p in _SMALL_TALK_PATTERNS):
        return True

    words = [w for w in re.split(r"[^\wऀ-ॿ]+", text.lower()) if w]
    if not words or len(words) > _SMALL_TALK_MAX_WORDS:
        return False
    return all(w in _SMALL_TALK_WORDS for w in words)


def _context_label(chunk: dict) -> str:
    """Human locator for one context block — what its citation resolves to.

    A block labelled only by filename is indistinguishable from every other
    block of the same document, so "[2]" carries no more information than
    "[1]". Adding the page and section is what lets the model attribute a
    figure to the place it actually read it.
    """
    parts = [f"“{chunk.get('title') or 'Untitled document'}”"]

    pages = [p for p in (chunk.get("page_range") or []) if p is not None]
    if pages:
        low, high = min(pages), max(pages)
        parts.append(f"p. {low}" if low == high else f"pp. {low}–{high}")

    section = str(chunk.get("section_path") or "").strip()
    if section:
        parts.append(f"§ {section}")

    return ", ".join(parts)


async def generate_answer(
    question: str, context_chunks: list[dict], language: str = "en"
) -> str:
    if not any_provider_configured():
        logger.info("No LLM key configured; using extractive fallback")
        return _extractive_fallback(question, context_chunks)

    context = "\n\n".join(
        f"[{i + 1}] (from {_context_label(chunk)})\n{chunk['content']}"
        for i, chunk in enumerate(context_chunks)
    )

    lang_instruction = ""
    if language == "ne":
        lang_instruction = "\nRespond in Nepali (Devanagari script)."

    style_hint = f"\n\nFor this answer: {random.choice(_ANSWER_STYLE_HINTS)}"

    messages = [
        {"role": "system", "content": SYSTEM_PROMPT + lang_instruction + style_hint},
        {
            "role": "user",
            "content": f"Context:\n{context}\n\nQuestion: {question}",
        },
    ]

    answer = await _llm_chat(messages, max_tokens=1024, temperature=config.TEMPERATURE_ANSWERS)
    if answer is None:
        return _extractive_fallback(question, context_chunks)
    return answer


async def generate_chat(
    message: str, language: str = "en", context_hint: str | None = None
) -> str:
    """Conversational reply. `context_hint` names what the user is looking at
    (e.g. a notice title) so the invitation to ask something fits the screen
    they're on."""
    if any_provider_configured():
        hint = (
            f"\n\nThe user is currently viewing {context_hint}. If you invite a "
            "question, make it about that."
            if context_hint
            else ""
        )
        messages = [
            {
                "role": "system",
                "content": f"{CHAT_SYSTEM_PROMPT}{hint}\n\n{random.choice(_STYLE_HINTS)}",
            },
            {"role": "user", "content": message},
        ]
        answer = await _llm_chat(messages, max_tokens=150, temperature=config.TEMPERATURE_CONVERSATION)
        if answer:
            return answer

    canned = _CANNED_GREETINGS_NE if language == "ne" else _CANNED_GREETINGS_EN
    return random.choice(canned)


async def generate_no_results(question: str, language: str = "en") -> str:
    if any_provider_configured():
        messages = [
            {
                "role": "system",
                "content": f"{NO_RESULTS_PROMPT}\n\n{random.choice(_STYLE_HINTS)}",
            },
            {"role": "user", "content": question},
        ]
        answer = await _llm_chat(messages, max_tokens=150, temperature=config.TEMPERATURE_CONVERSATION)
        if answer:
            return answer

    return random.choice(_CANNED_NO_RESULTS)


_INTENT_PROMPT = """Classify the user's message for a document Q&A assistant on a Nepalese public notice portal. Messages may be in English, Nepali, romanized Nepali, or sloppy textspeak ("gud mrng ji", "helo kasto xa").

Reply with exactly one word:
- "chat" — greeting, small talk, thanks, goodbye, or a question about the assistant itself
- "docs" — asking about the content of documents, notices, deadlines, policies, or any information lookup"""


async def classify_intent(message: str) -> str | None:
    if not any_provider_configured():
        return None
    result = await _llm_chat(
        [
            {"role": "system", "content": _INTENT_PROMPT},
            {"role": "user", "content": message},
        ],
        max_tokens=5,
        temperature=0.0,
    )
    if result is None:
        return None
    return "chat" if "chat" in result.lower() else "docs"


# ---------------------------------------------------------------------------
# Unified LLM dispatch: Gemini primary, Groq fallback
# ---------------------------------------------------------------------------


# ── Dynamic provider registry ──────────────────────────────────────────────
#
# Providers are no longer hardcoded: apps/api owns an `ai_providers` table an
# admin can add to, and ai_config_sync pushes the resolved list in here. Each
# entry: {slug, label, kind, base_url, model, api_key, enabled}.
#
# `kind` selects the wire format — OPENAI_COMPATIBLE covers Groq, OpenRouter,
# Together, DeepSeek, vLLM, Ollama and most others; GEMINI has its own shape.
# The env-var built-ins below are the fallback until the first sync lands, so
# a deployment with no API reachable still answers.

RUNTIME_PROVIDERS: list[dict] = []


def _env_fallback_providers() -> list[dict]:
    """Built-ins from environment variables, used until the registry syncs."""
    out = []
    if config.GEMINI_API_KEY:
        out.append({
            "slug": "gemini", "label": "Google Gemini", "kind": "GEMINI",
            "base_url": None, "model": config.GEMINI_MODEL,
            "api_key": config.GEMINI_API_KEY, "enabled": True,
        })
    if config.GROQ_API_KEY:
        out.append({
            "slug": "groq", "label": "Groq", "kind": "OPENAI_COMPATIBLE",
            "base_url": GROQ_API_URL, "model": config.GROQ_MODEL,
            "api_key": config.GROQ_API_KEY, "enabled": True,
        })
    if config.OPENCODE_ZEN_API_KEY:
        out.append({
            "slug": "opencode", "label": "OpenCode Zen", "kind": "OPENAI_COMPATIBLE",
            "base_url": config.OPENCODE_ZEN_BASE_URL, "model": config.OPENCODE_ZEN_MODEL,
            "api_key": config.OPENCODE_ZEN_API_KEY, "enabled": True,
        })
    if config.BEDROCK_API_KEY:
        out.append({
            "slug": "bedrock", "label": "AWS Bedrock (Claude Sonnet 5)", "kind": "BEDROCK",
            "base_url": None, "region": config.BEDROCK_REGION, "model": config.BEDROCK_MODEL,
            "api_key": config.BEDROCK_API_KEY, "enabled": True,
        })
    return out


def set_runtime_providers(providers: list[dict]) -> None:
    """Called by ai_config_sync after each successful pull from apps/api."""
    global RUNTIME_PROVIDERS
    RUNTIME_PROVIDERS = providers


def all_providers() -> list[dict]:
    """Registry if synced, else the env-var built-ins."""
    return RUNTIME_PROVIDERS or _env_fallback_providers()


def active_providers() -> list[dict]:
    """Enabled providers that actually have a key, in fallback order.

    A provider with no key is skipped rather than treated as an error: that is
    just an unconfigured tier. A disabled one is never called at all.
    """
    return [p for p in all_providers() if p.get("enabled") and p.get("api_key")]


def any_provider_configured() -> bool:
    """True when at least one provider could answer.

    Callers use this to choose between an LLM path and a non-LLM fallback
    (extractive answers, canned greetings).
    """
    return bool(active_providers())


async def _call_provider(provider: dict, messages: list[dict], max_tokens: int, temperature: float) -> str | None:
    kind = provider.get("kind")
    if kind == "GEMINI":
        return await _gemini_chat(messages, max_tokens, temperature, provider)
    if kind == "BEDROCK":
        return await _bedrock_chat(messages, max_tokens, temperature, provider)
    return await _openai_compatible_chat(messages, max_tokens, temperature, provider)


# An 8-token health ping slips under a daily-token cap that blocks every real
# answer, so the panel showed "ok" while nothing worked. Remember what real
# calls hit and let /llm/health report that instead of the probe's optimism.
_RECENT_FAILURES: dict[str, tuple[float, str]] = {}
_FAILURE_TTL_SECONDS = 300


def _note_failure(slug: str | None, message: str) -> None:
    if slug:
        _RECENT_FAILURES[slug] = (time.monotonic(), message)


def _clear_failure(slug: str | None) -> None:
    if slug:
        _RECENT_FAILURES.pop(slug, None)


def recent_failure(slug: str | None) -> str | None:
    """Last real-call failure for this provider, if still recent."""
    entry = _RECENT_FAILURES.get(slug or "")
    if not entry:
        return None
    when, message = entry
    if time.monotonic() - when > _FAILURE_TTL_SECONDS:
        _RECENT_FAILURES.pop(slug or "", None)
        return None
    return message


async def _llm_chat(
    messages: list[dict], max_tokens: int, temperature: float
) -> str | None:
    """Try each configured provider in admin-defined order — first non-empty
    answer wins. Reasoning models can return HTTP 200 with empty `content`
    when max_tokens runs out mid-reasoning, which counts as a failure here,
    not a blank success."""
    providers = active_providers()
    if not providers:
        logger.info("No LLM provider is configured")
        return None

    for i, provider in enumerate(providers):
        result = await _call_provider(provider, messages, max_tokens, temperature)
        if result:
            return result
        remaining = providers[i + 1:]
        logger.warning(
            "%s failed or returned empty; %s",
            provider.get("label", provider.get("slug")),
            f"falling back to {remaining[0].get('label')}" if remaining
            else "no fallback providers remain",
        )
    return None


# ---------------------------------------------------------------------------
# AWS Bedrock provider (Claude)
# ---------------------------------------------------------------------------


def _split_system(messages: list[dict]) -> tuple[str, list[dict]]:
    """Split OpenAI-shaped messages into Anthropic's (system, messages) pair.

    The Messages API takes the system prompt as a top-level argument rather
    than a `system`-role turn, and rejects a conversation that doesn't start
    with `user` — so a leading assistant turn is dropped rather than sent.
    """
    system_parts: list[str] = []
    turns: list[dict] = []
    for msg in messages:
        role = msg.get("role")
        content = msg.get("content") or ""
        if role == "system":
            system_parts.append(content)
        elif role in ("user", "assistant"):
            turns.append({"role": role, "content": content})
    while turns and turns[0]["role"] != "user":
        turns.pop(0)
    return "\n\n".join(system_parts), turns


def _bedrock_base_url(region: str) -> str:
    """Messages-API Bedrock endpoint for a region."""
    return f"https://bedrock-mantle.{region}.api.aws/anthropic"


# Inference-profile prefixes and ARN-style version suffixes both mark a model
# as belonging to the legacy `bedrock-runtime` InvokeModel API. Sonnet 4.6 and
# Opus 4.6 are only served there; Sonnet 5 and newer only on the Messages
# endpoint. Routing on the ID means an admin can switch between them from the
# panel without a code change.
_BEDROCK_LEGACY_PREFIXES = ("global.", "us.", "eu.", "jp.", "apac.", "au.", "ca.")


def _is_legacy_bedrock_model(model: str) -> bool:
    return model.startswith(_BEDROCK_LEGACY_PREFIXES) or ":" in model


def _bedrock_client(provider: dict):
    """Client for Claude on Bedrock, authenticated with a bearer token.

    Two wire APIs exist and the model ID decides which one applies:

    * Legacy `bedrock-runtime` InvokeModel — inference-profile IDs like
      `global.anthropic.claude-sonnet-4-6` or ARN-versioned ones ending in
      `-v1:0`. Served by `AnthropicBedrock`.
    * Bedrock Messages endpoint — plain `anthropic.`-prefixed IDs such as
      `anthropic.claude-sonnet-5`. Reached with the standard `Anthropic`
      client pointed at bedrock-mantle; the dedicated `AnthropicBedrockMantle`
      class signs with SigV4, whereas the admin panel stores a bearer token.

    Imported lazily so a deployment that hasn't installed the SDK yet still
    starts and serves every other provider.
    """
    region = provider.get("region") or config.BEDROCK_REGION
    model = provider.get("model") or config.BEDROCK_MODEL
    api_key = provider.get("api_key")

    if _is_legacy_bedrock_model(model):
        from anthropic import AnthropicBedrock

        return AnthropicBedrock(api_key=api_key, aws_region=region)

    from anthropic import Anthropic

    return Anthropic(api_key=api_key, base_url=_bedrock_base_url(region))


async def _bedrock_call(
    messages: list[dict], max_tokens: int, temperature: float, provider: dict
) -> tuple[str | None, str | None]:
    """Call Claude on Bedrock. Returns (text, error) — exactly one is set.

    The error string is the provider's own message, surfaced verbatim to the
    admin panel. A generic "check the token, region and model" would hide the
    difference between a bad token, a model that doesn't exist on this
    endpoint, and an account without Bedrock model access — three problems
    with three different fixes.
    """
    system, turns = _split_system(messages)
    if not turns:
        return None, "No user turn to send."

    try:
        client = _bedrock_client(provider)
    except ImportError:
        return None, "`anthropic` is not installed on the AI service."
    except Exception as e:  # noqa: BLE001 — bad region/token surfaces here
        return None, f"Could not build the Bedrock client: {e}"

    kwargs = {
        "model": provider.get("model") or config.BEDROCK_MODEL,
        "max_tokens": max_tokens,
        "temperature": temperature,
        "messages": turns,
    }
    if system:
        kwargs["system"] = system

    try:
        # The SDK client is synchronous; keep it off the event loop so a slow
        # Bedrock call doesn't stall every other request this worker serves.
        message = await asyncio.to_thread(lambda: client.messages.create(**kwargs))
    except Exception as e:  # noqa: BLE001 — one provider must never break the chain
        detail = getattr(e, "message", None) or str(e)
        logger.error("Bedrock request failed: %.300s", detail)
        return None, detail[:300]
    finally:
        with contextlib.suppress(Exception):
            client.close()

    # A safety decline is a real outcome, not a transport error: report it and
    # let _llm_chat move to the next provider rather than retrying here.
    if getattr(message, "stop_reason", None) == "refusal":
        return None, "Bedrock declined the request (stop_reason=refusal)."

    text = "".join(
        block.text for block in (message.content or []) if getattr(block, "type", None) == "text"
    ).strip()
    if not text:
        return None, f"Bedrock returned no text (stop_reason={getattr(message, 'stop_reason', None)})."
    return text, None


async def _bedrock_chat(
    messages: list[dict], max_tokens: int, temperature: float, provider: dict
) -> str | None:
    """Chat-path wrapper: text on success, None so the chain falls through."""
    text, error = await _bedrock_call(messages, max_tokens, temperature, provider)
    if error:
        logger.warning("Bedrock provider unavailable: %.200s", error)
    return text


# ---------------------------------------------------------------------------
# Gemini provider
# ---------------------------------------------------------------------------


async def _gemini_chat(
    messages: list[dict], max_tokens: int, temperature: float, provider: dict
) -> str | None:
    """Call Google Gemini API. Returns None on any failure."""
    system_parts = []
    contents = []

    for msg in messages:
        if msg["role"] == "system":
            system_parts.append(msg["content"])
        elif msg["role"] == "user":
            contents.append({"role": "user", "parts": [{"text": msg["content"]}]})
        elif msg["role"] == "assistant":
            contents.append({"role": "model", "parts": [{"text": msg["content"]}]})

    payload = {
        "contents": contents,
        "generationConfig": {
            "maxOutputTokens": max_tokens,
            "temperature": temperature,
        },
    }
    if system_parts:
        payload["systemInstruction"] = {
            "parts": [{"text": "\n\n".join(system_parts)}]
        }

    url = GEMINI_API_URL.format(model=provider["model"]) + f"?key={provider['api_key']}"

    for attempt in range(2):
        try:
            async with httpx.AsyncClient(timeout=45.0) as client:
                response = await client.post(url, json=payload)
        except httpx.HTTPError as e:
            logger.error("Gemini request failed (attempt %d): %s", attempt + 1, e)
            if attempt == 0:
                await asyncio.sleep(1.0)
                continue
            return None

        if response.status_code in (429, 500, 502, 503) and attempt == 0:
            logger.warning("Gemini returned %d; retrying once", response.status_code)
            await asyncio.sleep(1.5)
            continue

        if response.status_code != 200:
            logger.error(
                "Gemini returned %d: %.200s", response.status_code, response.text
            )
            _note_failure(
                provider.get("slug"),
                _describe_http_failure(response.status_code, response.text),
            )
            return None

        try:
            data = response.json()
            content = data["candidates"][0]["content"]["parts"][0]["text"]
        except (ValueError, KeyError, IndexError, TypeError):
            logger.error("Gemini response missing content: %.200s", response.text)
            return None

        logger.debug("Gemini answer generated with model=%s", provider["model"])
        _clear_failure(provider.get("slug"))
        return _clean_answer(content)

    return None


# ---------------------------------------------------------------------------
# OpenAI-compatible provider (Groq, OpenRouter, Together, DeepSeek, vLLM, …)
# ---------------------------------------------------------------------------


async def _openai_compatible_chat(
    messages: list[dict], max_tokens: int, temperature: float, provider: dict
) -> str | None:
    """One adapter for every vendor speaking the OpenAI chat-completions
    schema — which is nearly all of them, and is what makes an admin-added
    provider work with no code change. Returns None on any failure."""
    url = provider.get("base_url")
    if not url:
        logger.error("Provider %s has no endpoint URL", provider.get("slug"))
        return None

    payload = {
        "model": provider["model"],
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": temperature,
    }

    for attempt in range(2):
        try:
            async with httpx.AsyncClient(timeout=45.0) as client:
                response = await client.post(
                    url,
                    headers={
                        "Authorization": f"Bearer {provider['api_key']}",
                        "Content-Type": "application/json",
                    },
                    json=payload,
                )
        except httpx.HTTPError as e:
            logger.error("%s request failed (attempt %d): %s", provider.get("slug"), attempt + 1, e)
            if attempt == 0:
                await asyncio.sleep(1.5)
                continue
            return None

        if response.status_code in (429, 500, 502, 503) and attempt == 0:
            logger.warning("%s returned %d; retrying once", provider.get("slug"), response.status_code)
            await asyncio.sleep(2.0)
            continue

        if response.status_code != 200:
            logger.error("%s returned %d: %.200s", provider.get("slug"), response.status_code, response.text)
            _note_failure(
                provider.get("slug"),
                _describe_http_failure(response.status_code, response.text),
            )
            return None

        try:
            choice = response.json()["choices"][0]
            content = choice["message"]["content"]
        except (ValueError, KeyError, IndexError, TypeError):
            logger.error("%s response missing choices: %.200s", provider.get("slug"), response.text)
            return None

        # A reasoning model that burns the whole budget before writing an answer
        # returns 200 with empty content — log it, or the retry looks like a
        # network failure and the real cause (max_tokens too low) stays hidden.
        if not (content or "").strip():
            logger.error(
                "%s returned empty content (finish_reason=%s, max_tokens=%d) — likely exhausted on reasoning",
                provider.get("slug"), choice.get("finish_reason"), max_tokens,
            )
            _note_failure(
                provider.get("slug"),
                f"Returned an empty answer (finish_reason={choice.get('finish_reason')}).",
            )
            return None

        _clear_failure(provider.get("slug"))
        return _clean_answer(content)

    return None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _clean_answer(text: str) -> str:
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL)
    return text.strip()


# ---------------------------------------------------------------------------
# Provider health probes (admin panel)
# ---------------------------------------------------------------------------

# Deliberately separate from the chat adapters: those retry and swallow the
# HTTP status to return a clean str|None. A health check wants the opposite —
# one attempt, no retry, and the real reason surfaced so an admin can tell a
# bad key (401) from a rate limit (429) or a wrong model name (404).
_HEALTH_TIMEOUT_SECONDS = 12.0


def _describe_http_failure(status: int, body: str) -> str:
    if status in (401, 403):
        return "Authentication failed — the API key is invalid or revoked."
    if status == 404:
        return "Not found — check the model name and endpoint URL."
    if status == 429:
        return "Rate limited — the key works but the quota is currently exhausted."
    if status >= 500:
        return f"Provider is having problems (HTTP {status})."
    return f"HTTP {status}: {body[:160]}"


async def _probe_provider(provider: dict) -> tuple[bool, str | None]:
    """One real, tiny request. Works for any registry entry, including
    admin-added ones, because it dispatches on `kind` exactly like chat does."""
    if provider.get("kind") == "BEDROCK":
        # No raw HTTP path here — Bedrock is reached through the SDK client,
        # so the probe is the same one-token call the chat path would make.
        _, error = await _bedrock_call(
            [{"role": "user", "content": "ping"}], 8, 0.0, provider
        )
        return (error is None), error

    if provider.get("kind") == "GEMINI":
        url = GEMINI_API_URL.format(model=provider["model"]) + f"?key={provider['api_key']}"
        payload = {
            "contents": [{"role": "user", "parts": [{"text": "ping"}]}],
            "generationConfig": {"maxOutputTokens": 8, "temperature": 0.0},
        }
        async with httpx.AsyncClient(timeout=_HEALTH_TIMEOUT_SECONDS) as client:
            response = await client.post(url, json=payload)
    else:
        url = provider.get("base_url")
        if not url:
            return False, "No endpoint URL configured."
        payload = {
            "model": provider["model"],
            "messages": [{"role": "user", "content": "ping"}],
            "max_tokens": 8,
            "temperature": 0.0,
        }
        async with httpx.AsyncClient(timeout=_HEALTH_TIMEOUT_SECONDS) as client:
            response = await client.post(
                url,
                headers={
                    "Authorization": f"Bearer {provider['api_key']}",
                    "Content-Type": "application/json",
                },
                json=payload,
            )

    if response.status_code != 200:
        return False, _describe_http_failure(response.status_code, response.text)
    return True, None


async def _health_for(provider: dict) -> dict:
    base = {
        "provider": provider.get("slug"),
        "label": provider.get("label") or provider.get("slug"),
        "model": provider.get("model"),
        "kind": provider.get("kind"),
        "enabled": bool(provider.get("enabled")),
        "configured": bool(provider.get("api_key")),
    }
    if not base["enabled"]:
        return {**base, "ok": False, "latencyMs": None,
                "error": "Disabled — this provider is never called."}
    if not base["configured"]:
        return {**base, "ok": False, "latencyMs": None, "error": "No API key configured."}

    started = time.perf_counter()
    try:
        ok, error = await _probe_provider(provider)
    except httpx.HTTPError as e:
        return {**base, "ok": False,
                "latencyMs": round((time.perf_counter() - started) * 1000),
                "error": f"Could not reach the provider: {e}"}
    except Exception as e:  # one bad provider must not break the panel
        logger.exception("Health probe crashed for %s", provider.get("slug"))
        return {**base, "ok": False,
                "latencyMs": round((time.perf_counter() - started) * 1000),
                "error": f"Probe failed: {e}"}
    # A passing probe doesn't clear a real failure: the probe asks for 8 tokens
    # and a daily-token cap only rejects the ~1.5k a real answer needs.
    observed = recent_failure(provider.get("slug"))
    if ok and observed:
        ok, error = False, f"Probe succeeded, but real requests are failing: {observed}"

    return {**base, "ok": ok,
            "latencyMs": round((time.perf_counter() - started) * 1000),
            "error": error}


async def health_snapshot(slug: str | None = None) -> dict:
    """Live status of every provider in fallback order, or just one when
    `slug` is given (the per-card "Test" button). Probes run concurrently —
    three sequential round-trips to external APIs would make the panel feel
    broken on a single slow provider."""
    providers = all_providers()
    if slug:
        providers = [p for p in providers if p.get("slug") == slug]
        if not providers:
            return {"providers": [], "activeProvider": None, "healthy": False}

    results = list(await asyncio.gather(*(_health_for(p) for p in providers)))

    # Which provider a real request would land on right now. Only meaningful
    # for a full snapshot; a single-slug probe says nothing about the chain.
    active = None
    if not slug:
        active = next((r for r in results if r["enabled"] and r["ok"]), None)
    return {
        "providers": results,
        "activeProvider": active["provider"] if active else None,
        "healthy": any(r["ok"] for r in results),
    }


def _split_sentences(text: str) -> list[str]:
    """Splits `text` into standalone, rankable units for the extractive
    fallback. Processes line-by-line rather than collapsing the whole block
    first: a "- label: value" fact line has no terminal period, so joining it
    onto neighbouring lines before splitting on punctuation used to glue
    several unrelated facts into one unreadable run-on sentence (only
    breaking wherever the *next* period happened to land). Each bullet line
    is already one atomic fact and is kept as-is; section headers (e.g.
    "NOTICE FACTS:") aren't answerable content and are dropped; everything
    else is prose and gets real sentence splitting.
    """
    units: list[str] = []
    for raw_line in text.split("\n"):
        line = raw_line.strip()
        if not line:
            continue

        stripped_bullet = re.sub(r"^[-•●▪]\s*", "", line)
        if stripped_bullet != line:
            if len(stripped_bullet) >= _MIN_SENTENCE_CHARS:
                units.append(stripped_bullet)
            continue

        # A bare section header ("NOTICE FACTS:", "AI SUMMARY (Nepali):",
        # "ATTACHED FILES (1) — ... notice page:") carries no fact of its
        # own — the lines under it do.
        if line.endswith(":"):
            continue

        for sentence in re.split(r"(?<=[.!?।])\s+", line):
            sentence = sentence.strip()
            if len(sentence) >= _MIN_SENTENCE_CHARS and not sentence[:1].islower():
                units.append(sentence)

    return units


def _extractive_fallback(question: str, context_chunks: list[dict]) -> str:
    if not context_chunks:
        return "The provided documents do not contain this information."

    sentences: list[str] = []
    for chunk in context_chunks:
        sentences.extend(_split_sentences(chunk["content"]))

    if not sentences:
        return context_chunks[0]["content"].strip()

    try:
        q_vec = np.array(embeddings.get_embedding(question))
        sent_vecs = np.array(embeddings.get_embeddings(sentences))
        scores = sent_vecs @ q_vec
        ranked = np.argsort(scores)[::-1]

        # Embeddings are normalized, so `scores` are cosine similarities. When
        # even the best-matching sentence falls short of the same bar used for
        # retrieval, nothing in this document actually answers the question —
        # forcing out the top-K anyway (e.g. file size, unrelated notice
        # titles) reads as an answer when it isn't one.
        if scores[ranked[0]] < config.RAG_SCORE_THRESHOLD:
            return "The provided documents do not contain this information."

        picked: list[int] = []
        seen: set[str] = set()
        for i in ranked:
            if scores[i] < config.RAG_SCORE_THRESHOLD:
                break
            key = sentences[i][:60].lower()
            if key in seen:
                continue
            seen.add(key)
            picked.append(int(i))
            if len(picked) >= FALLBACK_SENTENCES:
                break

        best = [sentences[i] for i in sorted(picked)]
        if len(best) == 1:
            return best[0]
        return "The most relevant points from the documents:\n\n" + "\n".join(
            f"- {s}" for s in best
        )
    except Exception:
        logger.exception("Extractive ranking failed; returning first sentence")
        return sentences[0]

# --- Single-notice AI analysis (summary/key facts/tags) + Q&A ---

_ANALYZE_PROMPT = """You analyze a single Nepalese government/public notice or news item and produce a JSON summary for display on a notice detail page.

Return ONLY a JSON object (no markdown fences, no commentary) with this exact shape:
{"summary": "2-3 sentence plain-language summary in English", "summary_ne": "Same summary translated to Nepali (देवनागरी script)", "key_facts": ["short fact 1", "short fact 2", "..."], "tags": ["topic1", "topic2", "..."], "category": "<one of: NOTICE, NEWS, PRESS_RELEASE, CIRCULAR, TENDER, VACANCY, JOB, INTERNSHIP, OTHER>", "category_confidence": <0.0-1.0 float>}

Rules:
- summary: plain language English, no jargon, captures what the notice actually says and who it affects. If the content is in Nepali, translate and summarize in English.
- summary_ne: the same summary written in Nepali (देवनागरी). If the content is already in Nepali, summarize directly. If in English, translate to Nepali.
- key_facts: 3-6 short, concrete, standalone facts (dates, eligibility, amounts, deadlines, affected wards/groups, procedures) — each under ~12 words. Omit facts not actually stated in the content.
- tags: 2-5 short topical keywords (organization name, subject area, affected group) useful for filtering — not generic words like "notice" or "government".
- category: classify the notice type. JOB for job openings/career postings; INTERNSHIP for internship/trainee programs; VACANCY for generic openings with no clear job-vs-intern nature; CIRCULAR for internal directives; TENDER for procurement; PRESS_RELEASE for official statements; NEWS for general news; NOTICE for general public notices.
- category_confidence: how confident you are in the classification (0.0-1.0).
- Ground everything in the provided content. Never invent facts."""

_ASK_PROMPT = """You are Suchana AI, answering a question about ONE specific Nepalese public notice/news item using ONLY the context below.

The context may contain several labelled sections — NOTICE FACTS, STRUCTURED METADATA, ATTACHED FILES, AI SUMMARY, KEY POINTS and NOTICE TEXT. Every section is factual information about this same notice; use whichever ones answer the question.

Rules:
- Ground every claim in the context. Never invent facts, dates, or numbers not present.
- Questions about attachments, PDFs, documents or downloads are answered from the ATTACHED FILES section — list the file names. Only say there is no attachment when that section says "none".
- NOTICE TEXT is machine-extracted and is sometimes garbled or empty (scanned pages, legacy Nepali fonts). When it is unusable, answer from the summary, key points and metadata instead. Never describe encoding or formatting problems to the user, and never call the notice unreadable while other sections still have content.
- Answer in Markdown, short paragraphs or bullet points, under ~150 words.
- Use a Markdown table when the answer covers several items sharing the same fields (dates, fees, eligibility per category, a list of attachments with their types). At least two rows and two columns, otherwise prose or bullets.
- Match the shape of the answer to the question: a yes/no or lookup question gets a direct short answer, an "explain"/"summarize" question gets structure.
- Answer in the same language the question is asked in. If the notice content is in Nepali but the question is in English, translate/explain in English.
- If none of the sections contain the answer, say so plainly in one sentence — do not guess.
- Answer directly, no filler like "Based on the notice...\""""


async def analyze_notice(title: str, content: str) -> dict | None:
    if not any_provider_configured():
        return None

    trimmed_content = content[:8000]

    messages = [
        {"role": "system", "content": _ANALYZE_PROMPT},
        {"role": "user", "content": f"Title: {title}\n\nContent:\n{trimmed_content}"},
    ]

    # 600 truncated the JSON mid-object on real notices: the reply carries an
    # English summary, a Devanagari one (token-expensive), six key facts and
    # five tags, so every long notice failed to parse and went unsummarized.
    raw = await _llm_chat(messages, max_tokens=1800, temperature=config.TEMPERATURE_SUMMARIES)
    if raw is None:
        return None

    cleaned = re.sub(r"^```(json)?|```$", "", raw.strip(), flags=re.MULTILINE).strip()
    try:
        data = json.loads(cleaned)
    except json.JSONDecodeError:
        logger.warning(
            "analyze_notice: could not parse LLM JSON output (%d chars): %.200s",
            len(cleaned), cleaned,
        )
        return None

    summary = data.get("summary")
    if not summary:
        return None

    # Validate category if present
    valid_categories = {
        "NOTICE", "NEWS", "PRESS_RELEASE", "CIRCULAR", "TENDER", "VACANCY",
        "JOB", "INTERNSHIP", "OTHER"
    }
    llm_category = data.get("category")
    if llm_category and llm_category not in valid_categories:
        llm_category = None
    llm_confidence = float(data.get("category_confidence", 0.0)) if data.get("category_confidence") is not None else 0.0

    return {
        "summary": str(summary).strip(),
        "summary_ne": str(data.get("summary_ne") or "").strip() or None,
        "key_facts": [str(f).strip() for f in (data.get("key_facts") or []) if str(f).strip()][:6],
        "tags": [str(t).strip() for t in (data.get("tags") or []) if str(t).strip()][:5],
        "category": llm_category,
        "category_confidence": llm_confidence,
    }


async def answer_notice_question(title: str, content: str, question: str) -> str:
    """`content` is the assembled context block built by the API layer — it may
    hold labelled sections (facts, attachments, summary, key points, text)."""
    if not any_provider_configured():
        return _extractive_fallback(question, [{"content": content, "title": title}])

    # Generous cap: the block leads with the reliable sections, so a long
    # extracted body is what gets cut, not the summary or attachment list.
    trimmed_content = content[:12000]
    messages = [
        {"role": "system", "content": _ASK_PROMPT},
        {
            "role": "user",
            "content": f"Notice title: {title}\n\nContext:\n{trimmed_content}\n\nQuestion: {question}",
        },
    ]

    answer = await _llm_chat(messages, max_tokens=500, temperature=config.TEMPERATURE_ANSWERS)
    if answer is None:
        return _extractive_fallback(question, [{"content": content, "title": title}])
    return answer
