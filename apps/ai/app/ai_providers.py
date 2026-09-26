"""ai_providers.py - Clean provider abstraction for LLM notice summarization.

Supports sequential fallback with circuit breakers:
  1. Cloudflare Workers AI (Default: @cf/ibm-granite/granite-4.0-h-micro, configurable)
  2. Groq (Sequential single-key, no hedged racing)
"""

from abc import ABC, abstractmethod
import json
import os
import re
import time
from typing import Optional, Tuple

import httpx

from app import config
from app.logger import get_logger

logger = get_logger("ai_providers")

ANALYZE_PROMPT = """You analyze a single Nepalese government/public notice or news item and produce a JSON summary for display on a notice detail page.

Return ONLY a JSON object (no markdown fences, no commentary) with this exact shape:
{"summary": "2-3 sentence plain-language summary in English", "summary_ne": "Same summary translated to Nepali (देवनागरी script)", "urgency": "<LOW|MEDIUM|HIGH>", "key_facts": ["short fact 1", "short fact 2", "..."], "tags": ["topic1", "topic2", "..."], "category": "<one of: NOTICE, NEWS, PRESS_RELEASE, CIRCULAR, TENDER, VACANCY, JOB, INTERNSHIP, OTHER>", "category_confidence": <0.0-1.0 float>}

Rules:
- summary: plain language English, no jargon, captures what the notice actually says and who it affects. If the content is in Nepali, translate and summarize in English.
- summary_ne: the same summary written in Nepali (देवनागरी). If the content is already in Nepali, summarize directly. If in English, translate to Nepali.
- urgency: HIGH for exam deadlines, visa deadlines, tenders with close dates, vacancy deadlines; MEDIUM for important policy/regulatory changes; LOW for routine press releases, general news.
- key_facts: 3-6 short, concrete, standalone facts (dates, eligibility, amounts, deadlines, affected wards/groups, procedures) — each under ~12 words. Omit facts not actually stated in the content.
- tags: 2-5 short topical keywords (organization name, subject area, affected group) useful for filtering — not generic words like "notice" or "government".
- category: classify the notice type. JOB for job openings/career postings; INTERNSHIP for internship/trainee programs; VACANCY for generic openings with no clear job-vs-intern nature; CIRCULAR for internal directives; TENDER for procurement; PRESS_RELEASE for official statements; NEWS for general news; NOTICE for general public notices.
- category_confidence: how confident you are in the classification (0.0-1.0).
- Ground everything in the provided content. Never invent facts."""

VALID_CATEGORIES = {
    "NOTICE", "NEWS", "PRESS_RELEASE", "CIRCULAR", "TENDER",
    "VACANCY", "JOB", "INTERNSHIP", "OTHER",
}


def clean_and_parse_analysis(raw: str) -> Optional[dict]:
    """Cleans code fences and parses structured notice analysis JSON."""
    if not raw or not raw.strip():
        return None

    cleaned = raw.strip()
    # Strip markdown fences
    cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\s*```$", "", cleaned)
    cleaned = cleaned.strip()

    # If LLM put conversational filler before or after the JSON block, extract the JSON object
    if not (cleaned.startswith("{") and cleaned.endswith("}")):
        start_idx = cleaned.find("{")
        end_idx = cleaned.rfind("}")
        if start_idx != -1 and end_idx != -1 and end_idx > start_idx:
            cleaned = cleaned[start_idx : end_idx + 1]

    try:
        data = json.loads(cleaned)
    except json.JSONDecodeError as err:
        logger.warning("Could not parse LLM JSON output (%d chars): %s | Error: %s", len(cleaned), cleaned[:150], err)
        return None

    if not isinstance(data, dict):
        return None

    summary = data.get("summary")
    if not summary or not isinstance(summary, str) or not summary.strip():
        return None

    category = data.get("category")
    if category and str(category).upper() in VALID_CATEGORIES:
        category = str(category).upper()
    else:
        category = None

    try:
        confidence = float(data.get("category_confidence", 0.8))
    except (ValueError, TypeError):
        confidence = 0.8

    urgency = str(data.get("urgency") or "").strip().upper()
    if urgency not in ("LOW", "MEDIUM", "HIGH"):
        urgency = "LOW"

    key_facts = [str(f).strip() for f in (data.get("key_facts") or []) if str(f).strip()][:6]
    tags = [str(t).strip() for t in (data.get("tags") or []) if str(t).strip()][:5]

    return {
        "summary": summary.strip(),
        "summary_ne": str(data.get("summary_ne") or "").strip() or None,
        "urgency": urgency,
        "key_facts": key_facts,
        "tags": tags,
        "category": category,
        "category_confidence": confidence,
    }


class AIProvider(ABC):
    """Abstract base class for LLM providers."""

    name: str = "generic"
    model: str = "unknown"
    is_available: bool = True
    disabled_reason: Optional[str] = None

    @abstractmethod
    async def chat(self, messages: list[dict], max_tokens: int = 1500, temperature: float = 0.2) -> Tuple[Optional[str], Optional[str]]:
        """Sends chat request. Returns (text_content, error_message)."""
        pass

    async def summarize_notice(
        self, title: str, content: str, category_hint: Optional[str] = None
    ) -> Tuple[Optional[dict], Optional[str]]:
        """Summarizes and categorizes a notice using this provider."""
        if not self.is_available:
            return None, self.disabled_reason or "Provider is disabled"

        trimmed_content = content[:8000] if content else ""
        user_msg = f"Title: {title}\n"
        if category_hint:
            user_msg += f"Listing category: {category_hint}\n"
        user_msg += f"\nContent:\n{trimmed_content}"

        messages = [
            {"role": "system", "content": ANALYZE_PROMPT},
            {"role": "user", "content": user_msg},
        ]

        text, err = await self.chat(messages, max_tokens=1500, temperature=0.2)
        if not text:
            return None, err or "Empty response from provider"

        parsed = clean_and_parse_analysis(text)
        if not parsed:
            return None, f"Failed to parse JSON response: {text[:150]}"

        return parsed, None


class CloudflareAIProvider(AIProvider):
    """Cloudflare Workers AI REST API provider.

    Default model: @cf/ibm-granite/granite-4.0-h-micro
    Configurable via CLOUDFLARE_AI_MODEL env var (e.g. @cf/zai-org/glm-4.7-flash).
    """

    def __init__(
        self,
        account_id: Optional[str] = None,
        api_token: Optional[str] = None,
        model: Optional[str] = None,
        enabled: Optional[bool] = None,
    ):
        self.name = "cloudflare"
        self.account_id = account_id or os.environ.get("CLOUDFLARE_ACCOUNT_ID") or getattr(config, "CLOUDFLARE_ACCOUNT_ID", "")
        self.api_token = api_token or os.environ.get("CLOUDFLARE_API_TOKEN") or getattr(config, "CLOUDFLARE_API_TOKEN", "")
        self.model = (
            model
            or os.environ.get("CLOUDFLARE_AI_MODEL")
            or getattr(config, "CLOUDFLARE_AI_MODEL", "")
            or "@cf/ibm-granite/granite-4.0-h-micro"
        )
        if enabled is not None:
            self.enabled = enabled
        else:
            env_val = os.environ.get("CLOUDFLARE_AI_ENABLED")
            if env_val is not None:
                self.enabled = env_val.lower() in ("1", "true", "yes")
            else:
                self.enabled = getattr(config, "CLOUDFLARE_AI_ENABLED", True)

        if not self.enabled:
            self.is_available = False
            self.disabled_reason = "Cloudflare Workers AI is disabled by config (CLOUDFLARE_AI_ENABLED=false)"
        elif not self.account_id or not self.api_token:
            self.is_available = False
            self.disabled_reason = "Missing CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN"
        else:
            self.is_available = True
            self.disabled_reason = None

    @property
    def current_model(self) -> str:
        return getattr(config, "CLOUDFLARE_AI_MODEL", "") or self.model or "@cf/ibm-granite/granite-4.0-h-micro"

    @property
    def current_token(self) -> str:
        return getattr(config, "CLOUDFLARE_API_TOKEN", "") or self.api_token or ""

    @property
    def current_account_id(self) -> str:
        return getattr(config, "CLOUDFLARE_ACCOUNT_ID", "") or self.account_id or ""

    async def chat(self, messages: list[dict], max_tokens: int = 1500, temperature: float = 0.2) -> Tuple[Optional[str], Optional[str]]:
        if not self.is_available:
            return None, self.disabled_reason

        if not getattr(config, "CLOUDFLARE_AI_ENABLED", True):
            return None, "Cloudflare Workers AI is disabled by config"

        account_id = self.current_account_id
        api_token = self.current_token
        model = self.current_model

        if not account_id or not api_token:
            return None, "Missing CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN"

        endpoint = f"https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/run/{model}"
        headers = {
            "Authorization": f"Bearer {api_token}",
            "Content-Type": "application/json",
        }
        payload = {
            "messages": messages,
            "max_tokens": max_tokens,
            "temperature": temperature,
        }

        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                resp = await client.post(endpoint, headers=headers, json=payload)
        except httpx.TimeoutException:
            logger.warning("Cloudflare Workers AI request timed out (model: %s)", self.model)
            return None, "Cloudflare request timeout (30s)"
        except Exception as e:
            logger.warning("Cloudflare Workers AI request network failure: %s", e)
            return None, f"Cloudflare network failure: {e}"

        # Circuit breaker: disable on authentication or forbidden errors
        if resp.status_code in (401, 403):
            self.is_available = False
            self.disabled_reason = f"Cloudflare HTTP {resp.status_code}: Unauthorized/Forbidden. Disabling for this run."
            logger.error("Cloudflare Workers AI auth error %d. %s", resp.status_code, self.disabled_reason)
            return None, self.disabled_reason

        if resp.status_code == 429:
            retry_after = resp.headers.get("Retry-After", "unknown")
            logger.warning("Cloudflare Workers AI rate limited (429). Retry-After: %s", retry_after)
            return None, f"Cloudflare rate limit 429 (Retry-After: {retry_after})"

        if resp.status_code != 200:
            logger.warning("Cloudflare Workers AI returned status %d: %.200s", resp.status_code, resp.text)
            return None, f"Cloudflare HTTP {resp.status_code}: {resp.text[:200]}"

        try:
            body = resp.json()
        except Exception as err:
            return None, f"Failed to parse Cloudflare JSON response: {err}"

        result = body.get("result")
        text = ""
        if isinstance(result, dict):
            # Check OpenAI-compatible format returned by Cloudflare Workers AI
            choices = result.get("choices")
            if choices and isinstance(choices, list) and len(choices) > 0:
                msg = choices[0].get("message") or {}
                text = msg.get("content") or ""
            if not text:
                text = result.get("response") or result.get("text") or ""
        elif isinstance(result, str):
            text = result

        if not text and not body.get("success", False):
            errors = body.get("errors") or []
            return None, f"Cloudflare API reported error: {errors}"

        return text, None


class GeminiAIProvider(AIProvider):
    """Google Gemini REST API provider."""

    def __init__(self, api_key: Optional[str] = None, model: Optional[str] = None):
        self.name = "gemini"
        self.api_key = api_key or os.environ.get("GEMINI_API_KEY") or getattr(config, "GEMINI_API_KEY", "")
        self.model = model or os.environ.get("GEMINI_MODEL") or getattr(config, "GEMINI_MODEL", "gemini-2.5-flash-lite")

        if not self.api_key:
            self.is_available = False
            self.disabled_reason = "Missing GEMINI_API_KEY"
        else:
            self.is_available = True
            self.disabled_reason = None

    async def chat(self, messages: list[dict], max_tokens: int = 1500, temperature: float = 0.2) -> Tuple[Optional[str], Optional[str]]:
        if not self.is_available:
            return None, self.disabled_reason

        system_parts = []
        contents = []
        for msg in messages:
            role = msg.get("role")
            content = msg.get("content") or ""
            if role == "system":
                system_parts.append(content)
            elif role == "user":
                contents.append({"role": "user", "parts": [{"text": content}]})
            elif role == "assistant":
                contents.append({"role": "model", "parts": [{"text": content}]})

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

        clean_model = self.model.replace("models/", "")
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{clean_model}:generateContent?key={self.api_key}"

        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                resp = await client.post(url, json=payload)
        except Exception as e:
            return None, f"Gemini network error: {e}"

        if resp.status_code in (401, 403):
            self.is_available = False
            self.disabled_reason = f"Gemini HTTP {resp.status_code}: Invalid API key or permission denied. Disabling for this run."
            logger.error("Gemini auth error %d. %s", resp.status_code, self.disabled_reason)
            return None, self.disabled_reason

        if resp.status_code == 429:
            return None, "Gemini rate limited (429)"

        if resp.status_code != 200:
            return None, f"Gemini HTTP {resp.status_code}: {resp.text[:200]}"

        try:
            data = resp.json()
            text = data["candidates"][0]["content"]["parts"][0]["text"]
            return text, None
        except Exception as err:
            return None, f"Gemini response parsing error: {err}"


class GroqAIProvider(AIProvider):
    """Groq OpenAI-compatible provider with sequential single-key fallback (no hedged racing)."""

    def __init__(self, api_keys: Optional[list[str]] = None, model: Optional[str] = None):
        self.name = "groq"
        self.model = model or os.environ.get("GROQ_MODEL") or getattr(config, "GROQ_MODEL", "openai/gpt-oss-120b")
        if api_keys is not None:
            self.keys = [k.strip() for k in api_keys if k and k.strip()]
        else:
            cfg_keys = getattr(config, "GROQ_API_KEYS", [])
            single_key = os.environ.get("GROQ_API_KEY") or getattr(config, "GROQ_API_KEY", "")
            raw = cfg_keys or ([single_key] if single_key else [])
            self.keys = [k.strip() for k in raw if k and k.strip()]

        self.current_key_idx = 0
        if not self.keys:
            self.is_available = False
            self.disabled_reason = "Missing GROQ_API_KEY / GROQ_API_KEYS"
        else:
            self.is_available = True
            self.disabled_reason = None

    async def chat(self, messages: list[dict], max_tokens: int = 1500, temperature: float = 0.2) -> Tuple[Optional[str], Optional[str]]:
        if not self.is_available:
            return None, self.disabled_reason

        endpoint = "https://api.groq.com/openai/v1/chat/completions"
        payload = {
            "model": self.model,
            "messages": messages,
            "max_tokens": max_tokens,
            "temperature": temperature,
        }

        # Try active keys sequentially
        last_error = None
        while self.current_key_idx < len(self.keys):
            active_key = self.keys[self.current_key_idx]
            headers = {
                "Authorization": f"Bearer {active_key}",
                "Content-Type": "application/json",
            }
            try:
                async with httpx.AsyncClient(timeout=20.0) as client:
                    resp = await client.post(endpoint, headers=headers, json=payload)
            except Exception as e:
                last_error = f"Groq network error: {e}"
                self.current_key_idx += 1
                continue

            if resp.status_code in (401, 403):
                logger.error("Groq key #%d invalid (HTTP %d). Switching to next key.", self.current_key_idx + 1, resp.status_code)
                self.current_key_idx += 1
                last_error = f"Groq HTTP {resp.status_code}"
                continue

            if resp.status_code == 429:
                logger.warning("Groq key #%d rate limited (429). Switching to next key.", self.current_key_idx + 1)
                self.current_key_idx += 1
                last_error = "Groq rate limit 429"
                continue

            if resp.status_code != 200:
                last_error = f"Groq HTTP {resp.status_code}: {resp.text[:200]}"
                self.current_key_idx += 1
                continue

            try:
                data = resp.json()
                text = data["choices"][0]["message"]["content"]
                return text, None
            except Exception as err:
                return None, f"Groq response parsing error: {err}"

        # All keys failed or exhausted
        self.is_available = False
        self.disabled_reason = f"All Groq keys exhausted or failed: {last_error}"
        return None, self.disabled_reason


class CommonAIProvider:
    """Unified Common AI Provider for all scraping & notice intelligence tasks.

    Desired Architecture:
                 COMMON AI PROVIDER
                       │
                       ▼
                Cloudflare FIRST
       @cf/ibm-granite/granite-4.0-h-micro
                       │
                   failure
                       ▼
                     Groq
                       │
                   failure
                       ▼
                 graceful fallback

    And both of these use it:
    summarize_notice()   ──► Cloudflare → Groq
    _detect_schema_llm() ──► Cloudflare → Groq
    """

    def __init__(self, providers: Optional[list[AIProvider]] = None):
        if providers is not None:
            self.providers = providers
        else:
            self.providers = [
                CloudflareAIProvider(),
                GroqAIProvider(),
            ]

    async def chat(
        self, messages: list[dict], max_tokens: int = 1500, temperature: float = 0.2
    ) -> Tuple[Optional[str], Optional[str], Optional[str], Optional[str]]:
        """Executes chat completion sequentially across Cloudflare -> Groq.

        Returns:
            (response_text, provider_name, model_name, error_message)
        """
        errors = []
        for provider in self.providers:
            if not provider.is_available:
                continue

            t0 = time.perf_counter()
            text, err = await provider.chat(messages, max_tokens=max_tokens, temperature=temperature)
            dt = time.perf_counter() - t0

            if text and text.strip():
                logger.info("AI chat succeeded via %s (%s) in %.2fs", provider.name, provider.model, dt)
                return text.strip(), provider.name, provider.model, None

            logger.warning("Provider %s failed in %.2fs: %s", provider.name, dt, err)
            errors.append(f"{provider.name}: {err}")

        combined_error = "; ".join(errors) if errors else "No AI provider was available"
        return None, None, None, combined_error

    async def raw_chat(
        self, system_prompt: str, user_content: str, max_tokens: int = 1000, temperature: float = 0.0
    ) -> Optional[str]:
        """Convenience method for one-shot chat prompt across Cloudflare -> Groq.

        Used by _detect_schema_llm() and other one-shot schema extraction tasks.
        """
        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_content},
        ]
        text, prov, model, err = await self.chat(messages, max_tokens=max_tokens, temperature=temperature)
        return text

    async def summarize_notice(
        self, title: str, content: str, category_hint: Optional[str] = None
    ) -> Tuple[Optional[dict], Optional[str], Optional[str], Optional[str]]:
        """Summarizes and categorizes a notice using Cloudflare -> Groq.

        Returns:
            (analysis_dict, provider_name, model_name, error_message)
        """
        errors = []
        for provider in self.providers:
            if not provider.is_available:
                continue

            t0 = time.perf_counter()
            result, err = await provider.summarize_notice(title, content, category_hint)
            dt = time.perf_counter() - t0

            if result:
                logger.info("Notice summarized successfully via %s (%s) in %.2fs", provider.name, provider.model, dt)
                return result, provider.name, provider.model, None

            logger.warning("Provider %s failed (%.2fs): %s", provider.name, dt, err)
            errors.append(f"{provider.name}: {err}")

        combined_error = "; ".join(errors) if errors else "No AI provider was available"
        return None, None, None, combined_error

    async def summarize(
        self, title: str, content: str, category_hint: Optional[str] = None
    ) -> Tuple[Optional[dict], Optional[str], Optional[str], Optional[str]]:
        """Alias for summarize_notice."""
        return await self.summarize_notice(title, content, category_hint)


# Global singleton instance for common AI tasks
common_ai = CommonAIProvider()

# Backwards compatibility alias
NoticeSummarizer = CommonAIProvider
