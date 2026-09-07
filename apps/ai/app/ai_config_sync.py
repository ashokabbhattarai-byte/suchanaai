"""Pulls admin-configured LLM API keys/models from apps/api and applies them
to this process, so an admin can rotate a key or switch models from
/admin/settings without a redeploy.

Deliberately pull-based (this service polls the API), not push-based — it's
the same pattern already used for `scraping.summarizeConcurrency`, just on a
timer instead of per-request, since these apply to every LLM call rather
than one scrape run. `config.py`'s module attributes (GROQ_API_KEY,
GEMINI_MODEL, etc.) are mutated in place: every other module reads them via
`config.GROQ_API_KEY` at call time, not a captured copy, so a live update
here takes effect on the very next LLM call with no other code changes.

A field is only overridden when apps/api reports it as actually configured
(non-null) — an admin who has only set a Gemini key must not accidentally
blank out a working Groq key that only exists as an env var here.
"""

import asyncio

import httpx

from app import config
from app import llm
from app.logger import get_logger

logger = get_logger(__name__)

_REFRESH_INTERVAL_SECONDS = 180
# Used only until the first successful pull (see sync_loop).
_STARTUP_RETRY_SECONDS = 5
_ENDPOINT = "/internal/ai-config"


def _env_key_for(slug: str | None) -> str | None:
    """Environment-variable credential for a built-in provider slug.

    Keeps existing env-configured deployments working after the registry
    lands: the admin only needs to enter a key here to *override* or to add a
    provider the environment knows nothing about.
    """
    return {
        "gemini": config.GEMINI_API_KEY,
        "groq": config.GROQ_API_KEY,
        "opencode": config.OPENCODE_ZEN_API_KEY,
        "bedrock": config.BEDROCK_API_KEY,
    }.get(slug or "") or None


_TEMPERATURE_FIELDS = {
    "answers": "TEMPERATURE_ANSWERS",
    "summaries": "TEMPERATURE_SUMMARIES",
    "conversation": "TEMPERATURE_CONVERSATION",
}


def _apply_temperatures(temperatures: object) -> None:
    """Mutate config's temperature attributes in place, like the provider
    registry above — every call site reads `config.TEMPERATURE_*` at call
    time, so a change lands on the next LLM call with no restart.

    Clamped and type-checked here rather than trusted: this value is passed
    straight to provider APIs, and an out-of-range one is rejected by the
    provider, which would surface as every AI call failing at once.
    """
    if not isinstance(temperatures, dict):
        return
    for field, attribute in _TEMPERATURE_FIELDS.items():
        raw = temperatures.get(field)
        if raw is None:
            continue
        try:
            value = float(raw)
        except (TypeError, ValueError):
            logger.warning("AI config sync: ignoring non-numeric %s temperature %r", field, raw)
            continue
        clamped = min(max(value, 0.0), 1.0)
        if clamped != value:
            logger.warning(
                "AI config sync: %s temperature %.2f out of range, clamped to %.2f",
                field,
                value,
                clamped,
            )
        if getattr(config, attribute) != clamped:
            logger.info("AI config sync: %s temperature -> %.2f", field, clamped)
        setattr(config, attribute, clamped)


# Why the last sync attempt failed, surfaced by /llm/providers/refresh. A bare
# "refreshed: false" gave an admin nothing to act on — the registry silently
# fell back to env vars and the panel showed a provider list the service was
# not actually using.
LAST_SYNC_ERROR: str | None = None


def last_sync_error() -> str | None:
    return LAST_SYNC_ERROR


def _fail(reason: str) -> bool:
    global LAST_SYNC_ERROR
    LAST_SYNC_ERROR = reason
    logger.warning("AI config sync: %s", reason)
    return False


async def refresh_once() -> bool:
    """Fetch overrides and apply them. Returns True on a successful fetch
    (even if every field was null, i.e. nothing to override) so callers can
    log distinctly from a network/config failure."""
    global LAST_SYNC_ERROR
    if not config.INTERNAL_SERVICE_SECRET:
        return _fail("INTERNAL_SERVICE_SECRET is not set on the AI service, so sync is disabled.")

    url = f"{config.API_INTERNAL_URL.rstrip('/')}{_ENDPOINT}"
    try:
        # follow_redirects: an API_INTERNAL_URL on http:// gets a 301 to https
        # once TLS is in front of the API, and httpx does not follow redirects
        # by default — so the sync failed permanently while every other health
        # signal stayed green. Custom headers survive the hop, so the internal
        # secret still reaches the API.
        async with httpx.AsyncClient(timeout=10.0, follow_redirects=True) as client:
            response = await client.get(
                url,
                headers={"x-internal-secret": config.INTERNAL_SERVICE_SECRET},
            )
    except httpx.HTTPError as e:
        return _fail(f"could not reach {url}: {e}")

    if response.status_code != 200:
        return _fail(
            f"{url} returned {response.status_code}: {response.text[:200]}"
            + (
                " — INTERNAL_SERVICE_SECRET likely differs from the API's."
                if response.status_code in (401, 403)
                else ""
            )
        )

    try:
        data = response.json()
    except ValueError:
        return _fail(f"{url} did not return valid JSON")

    LAST_SYNC_ERROR = None

    _apply_temperatures(data.get("temperatures"))

    providers = data.get("providers")
    if isinstance(providers, list):
        # Normalise to the shape llm.py expects. Providers with no key are
        # kept (so the admin panel can still show them as "not configured");
        # active_providers() filters them out at dispatch time.
        normalised = [
            {
                "slug": p.get("slug"),
                "label": p.get("label") or p.get("slug"),
                "kind": p.get("kind") or "OPENAI_COMPATIBLE",
                "base_url": p.get("baseUrl"),
                # BEDROCK only; falls back to this service's own env default
                # so a row synced before the column existed still resolves.
                "region": p.get("region") or config.BEDROCK_REGION,
                "model": p.get("model"),
                # A registry row with no key means "use this service's own env
                # var", not "this provider is unusable" — otherwise the first
                # sync would silently disable a deployment that has always run
                # on env-var credentials.
                "api_key": p.get("apiKey") or _env_key_for(p.get("slug")),
                "enabled": bool(p.get("enabled")),
            }
            for p in providers
            if p.get("slug") and p.get("model")
        ]
        llm.set_runtime_providers(normalised)
        usable = [p["slug"] for p in normalised if p["enabled"] and p["api_key"]]
        logger.info(
            "AI provider registry synced: %d provider(s), fallback order: %s",
            len(normalised),
            " -> ".join(usable) or "(none configured)",
        )
        return True

    logger.debug("AI config sync: response contained no provider list")
    return True


async def sync_loop() -> None:
    """Runs for the lifetime of the process — refreshes immediately, then on
    a fixed interval. Never raises: a single bad cycle (API briefly down)
    just leaves the current in-memory config in place until the next tick."""
    if not config.INTERNAL_SERVICE_SECRET:
        logger.info("AI config sync disabled (INTERNAL_SERVICE_SECRET not set)")
        return

    # Services start in no guaranteed order, so the very first pull often
    # races the API's own boot ("All connection attempts failed"). Retrying
    # on the slow steady-state interval would leave this process on stale
    # env-var config for minutes, so back off quickly until the first
    # success, then settle into the normal cadence.
    synced = False
    while not synced:
        try:
            synced = await refresh_once()
        except Exception:
            logger.exception("AI config sync cycle crashed unexpectedly")
        if not synced:
            await asyncio.sleep(_STARTUP_RETRY_SECONDS)

    while True:
        await asyncio.sleep(_REFRESH_INTERVAL_SECONDS)
        try:
            await refresh_once()
        except Exception:
            logger.exception("AI config sync cycle crashed unexpectedly")
