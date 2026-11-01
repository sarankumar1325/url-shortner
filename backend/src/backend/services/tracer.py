"""Trace one redirect through the real cache, database and guard steps.

Every step runs the same code a visitor's request would, and its wall time is
measured. Two things differ on purpose: the rate limit uses a separate trace
bucket so tracing never spends a visitor's budget, and the click is never
enqueued, so traces do not show up in analytics. Redirect metrics are left
untouched for the same reason.
"""

import time
from datetime import UTC, datetime

from sqlalchemy.ext.asyncio import AsyncSession

from backend.api.routes import redirect
from backend.core import metrics
from backend.core.config import get_settings
from backend.core.problems import APIError
from backend.core.redis import breaker
from backend.services import links as links_service
from backend.services import ratelimit

TRACE_LIMIT = 30


def _ms(started: float) -> float:
    return round((time.perf_counter() - started) * 1000, 2)


class _Trace:
    def __init__(self) -> None:
        self.steps: list[dict] = []

    def add(self, step: str, label: str, ms: float, outcome: str, detail: str) -> None:
        self.steps.append(
            {"step": step, "label": label, "ms": ms, "outcome": outcome, "detail": detail}
        )


async def trace_redirect(session: AsyncSession, code: str, user_key: str, *, cold: bool) -> dict:
    settings = get_settings()
    trace = _Trace()
    wall = time.perf_counter()
    response: dict = {"status": 302, "location": None, "reason": None}

    fail_open_before = metrics.get("ratelimit.fail_open")
    started = time.perf_counter()
    allowed, retry_after = await ratelimit.check_rate_limit(
        f"trace:{user_key}", TRACE_LIMIT, redirect.REDIRECT_WINDOW_SECONDS, fail_open=True
    )
    if not allowed:
        raise APIError(
            429, "rate_limited", "Too many traces.", headers={"Retry-After": str(retry_after)}
        )
    failed_open = metrics.get("ratelimit.fail_open") > fail_open_before
    trace.add(
        "rate_limit",
        "Rate limit",
        _ms(started),
        "fail_open" if failed_open else "allowed",
        (
            "Redis was unreachable, so the limiter let the request through."
            if failed_open
            else f"INCR + EXPIRE NX in one pipeline. Visitors get {redirect.REDIRECT_LIMIT} "
            f"per {redirect.REDIRECT_WINDOW_SECONDS}s per IP."
        ),
    )

    if cold:
        started = time.perf_counter()
        await redirect.invalidate_cache(code)
        trace.add(
            "evict",
            "Cache evicted",
            _ms(started),
            "done",
            "DEL removed the cached entry so this trace takes the cold path.",
        )

    breaker_open = breaker.state == "open"
    started = time.perf_counter()
    entry = None if breaker_open else await redirect._cache_get(code)
    trace.add(
        "cache",
        "Redis cache",
        _ms(started),
        "skipped" if breaker_open else ("hit" if entry is not None else "miss"),
        (
            "The circuit breaker is open, so Redis was not called."
            if breaker_open
            else (
                "GET returned the cached entry; Postgres is not touched."
                if entry is not None
                else f"GET found nothing. The fill below caches it for "
                f"{settings.redirect_cache_seconds}s."
            )
        ),
    )

    try:
        if entry is None:
            joined = redirect.cache_fills.joining(code)
            timings: dict[str, float] = {}
            postgres = {
                "outcome": "loaded",
                "detail": "Indexed lookup by short_code, then state checks.",
            }

            async def load() -> dict:
                started = time.perf_counter()
                try:
                    url, state = await links_service.resolve_public(session, code)
                except APIError as exc:
                    timings["postgres"] = _ms(started)
                    postgres.update(outcome="not_found", detail=exc.detail)
                    raise
                timings["postgres"] = _ms(started)
                loaded = redirect.entry_for(url)
                started = time.perf_counter()
                if state != "expired":
                    await redirect._cache_set(code, loaded)
                    timings["fill"] = _ms(started)
                return loaded

            started = time.perf_counter()
            try:
                entry = await redirect.cache_fills.do(code, load)
            finally:
                trace.add(
                    "single_flight",
                    "Single-flight",
                    _ms(started) if joined else 0.0,
                    "shared" if joined else "leader",
                    (
                        "Another request was already loading this code; this one waited for it."
                        if joined
                        else "No load was in flight for this code, so this request led one."
                    ),
                )
                if "postgres" in timings:
                    trace.add("postgres", "Postgres", timings["postgres"], **postgres)
            if "fill" in timings:
                trace.add(
                    "cache_fill",
                    "Cache fill",
                    timings["fill"],
                    "skipped" if breaker.state == "open" else "written",
                    f"SETEX with a {settings.redirect_cache_seconds}s TTL.",
                )

        started = time.perf_counter()
        expired = redirect._expired(entry)
        trace.add(
            "expiry",
            "Expiry check",
            _ms(started),
            "expired" if expired else "live",
            "Compared expires_at with the current time in memory.",
        )
        if expired:
            entry = redirect.fallback_or_gone(entry, "link_expired", "This link has expired.")

        if entry.get("max_clicks") and not entry.get("via_fallback"):
            started = time.perf_counter()
            remaining = await links_service.consume_visit(session, entry["url_id"], count=False)
            trace.add(
                "visit_guard",
                "Visit guard",
                _ms(started),
                "remaining" if remaining else "exhausted",
                "Checked clicks_used < max_clicks without spending a visit.",
            )
            if not remaining:
                entry = redirect.fallback_or_gone(
                    entry, "link_exhausted", "This link has reached its visit limit."
                )
        response["location"] = entry["long_url"]
        if entry.get("via_fallback"):
            response["reason"] = "fallback"
    except APIError as exc:
        if exc.status not in (404, 410):
            raise
        response = {"status": exc.status, "location": None, "reason": exc.code}

    trace.add(
        "enqueue",
        "Click event",
        0.0,
        "skipped",
        "A real visit appends one XADD event here. Traces never record a click.",
    )

    return {
        "code": code,
        "cold": cold,
        "steps": trace.steps,
        "total_ms": _ms(wall),
        "response": response,
        "breaker_state": breaker.state,
        "traced_at": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
    }
