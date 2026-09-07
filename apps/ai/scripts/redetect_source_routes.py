"""One-off maintenance run: re-detect the correct notice/news/press-release
listing URL for every configured ScrapeSource.

Calls this *running* AI service's own POST /scrape/discover for each
source's baseUrl — the exact route-finding logic behind the admin UI's
"Auto-detect URLs" button — and writes a report of what changed vs. what's
currently configured. Applying the report to Postgres is a separate step
(scripts/apply-route-redetect.js, plain Prisma, no Python DB driver needed).

Usage:
  # 1. Start the AI service locally (it must be reachable for real crawling):
  #      .venv/bin/python -m uvicorn app.main:app --port 8000
  # 2. Dump current sources from Postgres (see apply-route-redetect.js --dump)
  # 3. .venv/bin/python scripts/redetect_source_routes.py sources.json
  #      -> writes redetect_source_routes_report.json
  # 4. node scripts/apply-route-redetect.js --apply   (in apps/api)
"""

import asyncio
import json
import os
import sys

import httpx

AI_URL = os.environ.get("AI_SELF_URL", "http://localhost:8000")
SECRET = os.environ.get("INTERNAL_SERVICE_SECRET", "")
# Each discovery run may hold the pooled browser for a while (schema
# resolution + up to ~10 verification crawls per site), so this is well
# under the server's SCRAPE_BROWSER_CONCURRENCY headroom, not full parallel.
CONCURRENCY = 3
TIMEOUT = 480.0

FIELD_BY_CATEGORY = {
    "NOTICE": "noticeListUrl",
    "NEWS": "newsListUrl",
    "PRESS_RELEASE": "pressReleaseListUrl",
}


async def discover(client: httpx.AsyncClient, source: dict, sem: asyncio.Semaphore) -> dict:
    async with sem:
        try:
            resp = await client.post(
                f"{AI_URL}/scrape/discover",
                json={"base_url": source["baseUrl"]},
                headers={"x-internal-secret": SECRET} if SECRET else {},
                timeout=TIMEOUT,
            )
            resp.raise_for_status()
            return {"source": source, "result": resp.json(), "error": None}
        except Exception as e:  # noqa: BLE001 — reported per source, not fatal
            # str(e) is empty for some httpx exceptions (e.g. a bare
            # ReadTimeout), which must still be treated as a failure — not as
            # "no error", or the caller falls through to reading a None result.
            return {"source": source, "result": None, "error": str(e) or type(e).__name__}


def plan_changes(source: dict, best: dict) -> dict:
    changes = {}
    for category, field in FIELD_BY_CATEGORY.items():
        new_url = best.get(category)
        if not new_url:
            continue
        current = (source.get(field) or "").rstrip("/")
        if new_url.rstrip("/") != current:
            changes[field] = new_url
    return changes


async def main():
    if len(sys.argv) < 2:
        print("Usage: redetect_source_routes.py <sources.json> [--resume]")
        sys.exit(1)
    sources = json.load(open(sys.argv[1]))
    sources = [s for s in sources if not s.get("isAdHoc")]

    out_path = os.path.join(os.path.dirname(__file__), "redetect_source_routes_report.json")
    report: list[dict] = []
    if "--resume" in sys.argv and os.path.exists(out_path):
        report = json.load(open(out_path))
        done_ids = {r["id"] for r in report}
        sources = [s for s in sources if s["id"] not in done_ids]
        print(f"Resuming — {len(done_ids)} source(s) already in the report, skipping them.")

    print(f"Checking {len(sources)} source(s) against {AI_URL} …\n")
    sem = asyncio.Semaphore(CONCURRENCY)
    counts = {"updated": 0, "unchanged": 0, "no_route": 0, "error": 0}

    def flush():
        with open(out_path, "w") as f:
            json.dump(report, f, indent=2, ensure_ascii=False)

    async with httpx.AsyncClient() as client:
        tasks = [discover(client, s, sem) for s in sources]
        for i, coro in enumerate(asyncio.as_completed(tasks), 1):
            outcome = await coro
            source = outcome["source"]
            label = f"[{i}/{len(sources)}] {source['name']} ({source['baseUrl']})"

            if outcome["error"]:
                counts["error"] += 1
                print(f"{label}\n  ERROR: {outcome['error']}\n")
                report.append({"id": source["id"], "name": source["name"], "status": "error", "error": outcome["error"]})
                flush()
                continue

            result = outcome["result"]
            best = result.get("best") or {}
            changes = plan_changes(source, best)

            if not best:
                counts["no_route"] += 1
                notes = "; ".join(result.get("notes") or [])
                print(f"{label}\n  No confirmed routes found. {notes}\n")
                report.append({"id": source["id"], "name": source["name"], "status": "no_route", "notes": notes})
                flush()
                continue

            if not changes:
                counts["unchanged"] += 1
                print(f"{label}\n  Already correct: {best}\n")
                report.append({"id": source["id"], "name": source["name"], "status": "unchanged", "best": best})
                flush()
                continue

            counts["updated"] += 1
            print(f"{label}")
            for field, new in changes.items():
                print(f"  {field}: {source.get(field)!r} -> {new!r}")
            # Evidence for the admin's review, not applied anywhere.
            for route in result.get("routes") or []:
                if route["verified"] and route["url"] in changes.values():
                    print(f"    ({route['row_count']} notice link(s) found — {', '.join(route['evidence'])})")
            print()
            report.append({
                "id": source["id"], "name": source["name"], "status": "would_update", "changes": changes,
            })
            # Flushed after every source, not just at the end — a crash or
            # timeout partway through (this run took ~17 minutes for 41
            # sites) must not throw away everything completed so far.
            flush()

    print("=" * 60)
    print(
        f"Would update: {counts['updated']}   Unchanged: {counts['unchanged']}   "
        f"No route found: {counts['no_route']}   Errors: {counts['error']}"
    )
    print(f"\nReport written: {out_path}")


if __name__ == "__main__":
    asyncio.run(main())
