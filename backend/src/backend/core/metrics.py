"""In-process counters for the live system-status view.

These are per instance and reset on cold start; they illustrate behavior
rather than replace a real metrics pipeline.
"""

import time
from collections import Counter
from datetime import UTC, datetime

STARTED_AT = datetime.now(UTC)
_started_monotonic = time.monotonic()
_counters: Counter[str] = Counter()


def incr(name: str, amount: int = 1) -> None:
    _counters[name] += amount


def get(name: str) -> int:
    return _counters[name]


def uptime_seconds() -> float:
    return round(time.monotonic() - _started_monotonic, 1)


def snapshot() -> dict[str, int]:
    return dict(_counters)


def reset() -> None:
    _counters.clear()
