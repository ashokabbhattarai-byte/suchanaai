"""In-memory ingestion progress registry, keyed by doc_id.

Tracks each document as it moves through extract -> chunk -> embed -> index,
so the API/UI can poll live progress while large documents are processed.
State is process-local; a restart clears it, which is fine because the
authoritative document status lives in the API's database.
"""

import threading
import time
from typing import Optional

# Terminal entries are kept for a while so a final poll can still see them.
_TTL_SECONDS = 15 * 60
_MAX_ENTRIES = 200

_lock = threading.Lock()
_progress: dict[str, dict] = {}

STAGES = ("queued", "extracting", "chunking", "embedding", "indexing", "done", "failed")

# Portion of the overall progress bar allotted to each stage.
# queued is 0-3 so a card waiting for the concurrency slot still looks alive
# rather than stuck at 0% — the 3% indeterminate bar prevents "Queued 0%"
# flicker that confused users in the previous batch?ids=... burst.
_STAGE_BASE = {
    "queued": (0, 3),
    "extracting": (3, 15),
    "chunking": (15, 25),
    "embedding": (25, 85),
    "indexing": (85, 100),
}


def start(doc_id: str, filename: str) -> None:
    with _lock:
        _evict_locked()
        _progress[doc_id] = {
            "doc_id": doc_id,
            "filename": filename,
            "stage": "queued",
            "percent": 2,
            "total_chunks": 0,
            "processed_chunks": 0,
            "message": "Queued — waiting for worker...",
            "error": None,
            "started_at": time.time(),
            "updated_at": time.time(),
        }


def update(
    doc_id: str,
    stage: str,
    message: str = "",
    done: int = 0,
    total: int = 0,
) -> None:
    """Advance a document's progress. done/total are stage-local units
    (e.g. embedded chunks out of total chunks)."""
    with _lock:
        entry = _progress.get(doc_id)
        if entry is None:
            return
        # Never regress stage order — a retry's new ``start`` resets via
        # ``start()``, but ``update`` should not jump embedding 45% back to
        # extracting 5% if a stray callback fires late.
        stage_order = {"queued": 0, "extracting": 1, "chunking": 2, "embedding": 3, "indexing": 4, "done": 5, "failed": 6}
        # Allow forward moves and same-stage progress; ignore backward stage updates
        # unless moving to a terminal stage.
        if stage in stage_order and entry["stage"] in stage_order:
            if stage_order[stage] < stage_order[entry["stage"]] and stage not in ("done", "failed"):
                # Keep newer stage's message but don't move percent backwards
                if message:
                    entry["message"] = message
                entry["updated_at"] = time.time()
                return
        entry["stage"] = stage
        if message:
            entry["message"] = message
        if stage in ("embedding", "indexing") and total:
            entry["total_chunks"] = total
            entry["processed_chunks"] = done
        lo, hi = _STAGE_BASE.get(stage, (0, 0))
        if total:
            fraction = done / total
            new_percent = round(lo + (hi - lo) * min(fraction, 1.0))
        else:
            # Indeterminate stages have no total but still need a visible,
            # non-zero percent so the card never flickers to "Queued 0%"
            # while OCR is running or while waiting for a concurrency slot.
            if stage == "queued":
                new_percent = lo + 2  # 2% — shows queued is alive
            elif stage == "extracting":
                new_percent = lo + 4  # 7% within 3-15
            elif stage == "chunking":
                new_percent = lo + 4  # 19% within 15-25
            elif stage in ("embedding", "indexing"):
                # Should have total; fallback still shows movement
                new_percent = lo + 2
            else:
                new_percent = lo
        # Monotonic percent — retries or out-of-order callbacks must not make
        # the bar jump backwards (32% -> 5%), which reads as a flicker/failure.
        if stage not in ("done", "failed"):
            new_percent = max(int(entry.get("percent", 0)), int(new_percent))
        entry["percent"] = int(new_percent)
        entry["updated_at"] = time.time()


def finish(doc_id: str, chunk_count: int) -> None:
    with _lock:
        entry = _progress.get(doc_id)
        if entry is None:
            return
        entry.update(
            stage="done",
            percent=100,
            total_chunks=chunk_count,
            processed_chunks=chunk_count,
            message=f"Indexed {chunk_count} chunks",
            updated_at=time.time(),
        )


def fail(doc_id: str, error: str) -> None:
    with _lock:
        entry = _progress.get(doc_id)
        if entry is None:
            return
        entry.update(
            stage="failed",
            message="Processing failed",
            error=error,
            updated_at=time.time(),
        )


def get(doc_id: str) -> Optional[dict]:
    with _lock:
        entry = _progress.get(doc_id)
        return dict(entry) if entry else None


def get_many(doc_ids: list[str]) -> dict[str, Optional[dict]]:
    with _lock:
        return {
            doc_id: dict(_progress[doc_id]) if doc_id in _progress else None
            for doc_id in doc_ids
        }


def clear(doc_id: str) -> None:
    with _lock:
        _progress.pop(doc_id, None)


def _evict_locked() -> None:
    now = time.time()
    stale = [
        k
        for k, v in _progress.items()
        if v["stage"] in ("done", "failed") and now - v["updated_at"] > _TTL_SECONDS
    ]
    for k in stale:
        del _progress[k]
    # Hard cap as a safety net against unbounded growth.
    if len(_progress) > _MAX_ENTRIES:
        oldest = sorted(_progress.items(), key=lambda kv: kv[1]["updated_at"])
        for k, _ in oldest[: len(_progress) - _MAX_ENTRIES]:
            del _progress[k]
