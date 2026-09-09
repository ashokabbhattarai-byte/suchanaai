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

# Portion of the overall progress bar allotted to each stage, weighted by how
# long each actually takes rather than evenly. Extraction owns the largest
# band because OCR of a scanned PDF dominates every other stage combined —
# it previously held 3-15%, so a multi-minute OCR looked frozen at 7% while
# chunking, which takes milliseconds, owned a full 10 points and made the bar
# leap. Extraction now reports per-page sub-progress inside its band, so a
# scan advances smoothly and a text PDF simply clears the band quickly.
_STAGE_BASE = {
    "queued": (0, 2),
    "extracting": (2, 45),
    "chunking": (45, 48),
    "embedding": (48, 90),
    "indexing": (90, 100),
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
            # Indeterminate: no total yet, so sit a little way into the band —
            # visible movement without claiming progress we can't measure.
            # Expressed as a fraction of the band so it can never overshoot
            # `hi`, which a fixed "+4" did once the bands were re-weighted.
            new_percent = round(lo + (hi - lo) * 0.15)
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
