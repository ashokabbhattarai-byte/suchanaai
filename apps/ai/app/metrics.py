"""Structured metrics and logging for the AI service.

Provides:
- Latency histograms (embedding, search, OCR, chunking)
- Counter metrics (requests, errors, cache hits/misses)
- Chunk size distribution tracking
- OCR rate tracking
"""

import time
import threading
from dataclasses import dataclass, field

from app.logger import get_logger

logger = get_logger(__name__)


@dataclass
class Histogram:
    """Simple in-memory histogram for latency tracking."""
    buckets: list[float] = field(default_factory=lambda: [0.01, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0])
    counts: list[int] = field(default_factory=lambda: [0] * 10)
    total: int = 0
    sum: float = 0.0
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False, compare=False)

    def observe(self, value: float) -> None:
        with self._lock:
            self.total += 1
            self.sum += value
            for i, bucket in enumerate(self.buckets):
                if value <= bucket:
                    self.counts[i] += 1
                    break

    def percentiles(self) -> dict[str, float]:
        if self.total == 0:
            return {}
        result = {}
        cumulative = 0
        for pct in [50, 90, 95, 99]:
            target = self.total * pct / 100
            cumulative = 0
            for i, count in enumerate(self.counts):
                cumulative += count
                if cumulative >= target:
                    result[f"p{pct}"] = self.buckets[i]
                    break
            else:
                result[f"p{pct}"] = self.buckets[-1]
        result["mean"] = self.sum / self.total if self.total else 0
        result["count"] = self.total
        return result


@dataclass
class Counter:
    """Simple counter metric."""
    value: int = 0

    def inc(self, n: int = 1) -> None:
        self.value += n


class MetricsRegistry:
    """Thread-safe metrics registry for the AI service."""

    def __init__(self):
        self._lock = threading.Lock()
        self._histograms: dict[str, Histogram] = {}
        self._counters: dict[str, Counter] = {}
        self._chunk_size_stats = {
            "total_chunks": 0,
            "total_chars": 0,
            "min_size": float("inf"),
            "max_size": 0,
        }

    def histogram(self, name: str) -> Histogram:
        with self._lock:
            if name not in self._histograms:
                self._histograms[name] = Histogram()
            return self._histograms[name]

    def counter(self, name: str) -> Counter:
        with self._lock:
            if name not in self._counters:
                self._counters[name] = Counter()
            return self._counters[name]

    def record_chunk_stats(self, chunk_count: int, total_chars: int) -> None:
        with self._lock:
            self._chunk_size_stats["total_chunks"] += chunk_count
            self._chunk_size_stats["total_chars"] += total_chars
            avg = total_chars / chunk_count if chunk_count else 0
            self._chunk_size_stats["min_size"] = min(self._chunk_size_stats["min_size"], avg)
            self._chunk_size_stats["max_size"] = max(self._chunk_size_stats["max_size"], avg)

    def get_summary(self) -> dict:
        with self._lock:
            return {
                "histograms": {k: v.percentiles() for k, v in self._histograms.items()},
                "counters": {k: v.value for k, v in self._counters.items()},
                "chunk_stats": {
                    "total_chunks": self._chunk_size_stats["total_chunks"],
                    "total_chars": self._chunk_size_stats["total_chars"],
                    "avg_chunk_size": (
                        self._chunk_size_stats["total_chars"] / self._chunk_size_stats["total_chunks"]
                        if self._chunk_size_stats["total_chunks"] else 0
                    ),
                    "min_chunk_size": self._chunk_size_stats["min_size"] if self._chunk_size_stats["min_size"] != float("inf") else 0,
                    "max_chunk_size": self._chunk_size_stats["max_size"],
                },
            }


# Global registry
metrics = MetricsRegistry()


def timed_operation(metric_name: str):
    """Decorator to time an async or sync function and record latency."""
    def decorator(func):
        async def async_wrapper(*args, **kwargs):
            start = time.perf_counter()
            try:
                return await func(*args, **kwargs)
            finally:
                metrics.histogram(metric_name).observe(time.perf_counter() - start)

        def sync_wrapper(*args, **kwargs):
            start = time.perf_counter()
            try:
                return func(*args, **kwargs)
            finally:
                metrics.histogram(metric_name).observe(time.perf_counter() - start)

        import asyncio
        if asyncio.iscoroutinefunction(func):
            return async_wrapper
        return sync_wrapper
    return decorator


def log_metrics_summary() -> None:
    """Log a summary of all metrics. Call periodically."""
    summary = metrics.get_summary()
    logger.info("=== Metrics Summary ===")
    for name, data in summary["histograms"].items():
        if data:
            logger.info(f"  {name}: count={data['count']}, mean={data['mean']:.3f}s, p50={data.get('p50', 0):.3f}s, p95={data.get('p95', 0):.3f}s, p99={data.get('p99', 0):.3f}s")
    for name, value in summary["counters"].items():
        logger.info(f"  {name}: {value}")
    cs = summary["chunk_stats"]
    if cs["total_chunks"] > 0:
        logger.info(f"  chunks: total={cs['total_chunks']}, avg_size={cs['avg_chunk_size']:.0f} chars, min={cs['min_chunk_size']:.0f}, max={cs['max_chunk_size']:.0f}")