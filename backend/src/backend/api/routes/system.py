"""Live, per-instance view of the reliability mechanisms behind the API."""

import time

from fastapi import APIRouter, Depends
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from backend.api.deps import get_api_session, require_user
from backend.api.routes.redirect import cache_fills
from backend.core import metrics
from backend.core.config import get_settings
from backend.core.redis import CircuitOpenError, RedisError, breaker, command
from backend.models import User
from backend.services import analytics, leaderboard

router = APIRouter(prefix="/system", tags=["system"])


def _ms(started: float) -> float:
    return round((time.perf_counter() - started) * 1000, 1)


async def _probe_postgres(session: AsyncSession) -> dict:
    started = time.perf_counter()
    try:
        await session.execute(text("SELECT 1"))
    except Exception:
        return {"ok": False, "latency_ms": _ms(started), "error": "unreachable"}
    return {"ok": True, "latency_ms": _ms(started), "error": None}


async def _probe_redis() -> dict:
    started = time.perf_counter()
    try:
        await command("PING")
    except CircuitOpenError:
        return {"ok": False, "latency_ms": 0.0, "error": "circuit_open"}
    except RedisError:
        return {"ok": False, "latency_ms": _ms(started), "error": "unreachable"}
    return {"ok": True, "latency_ms": _ms(started), "error": None}


def _ratio(hits: int, misses: int) -> float | None:
    total = hits + misses
    return round(hits / total, 3) if total else None


@router.get("/status", summary="Live system-design signals for this instance")
async def system_status(
    session: AsyncSession = Depends(get_api_session),
    _user: User = Depends(require_user),
) -> dict:
    settings = get_settings()
    postgres = await _probe_postgres(session)
    redis = await _probe_redis()
    ingestion = await analytics.ingestion_status()
    counters = metrics.snapshot()
    hits = counters.get("redirect.cache_hit", 0)
    misses = counters.get("redirect.cache_miss", 0)
    return {
        "instance": {
            "started_at": metrics.STARTED_AT.isoformat().replace("+00:00", "Z"),
            "uptime_seconds": metrics.uptime_seconds(),
            "consumer": analytics.CONSUMER_NAME,
            "environment": settings.environment,
        },
        "dependencies": {"postgres": postgres, "redis": redis},
        "circuit_breaker": breaker.snapshot(),
        "redirect_cache": {
            "ttl_seconds": settings.redirect_cache_seconds,
            "hits": hits,
            "misses": misses,
            "hit_ratio": _ratio(hits, misses),
            "single_flight": cache_fills.snapshot(),
        },
        "leaderboard_cache": {
            "ttl_seconds": leaderboard.CACHE_SECONDS,
            "hits": counters.get("leaderboard.cache_hit", 0),
            "misses": counters.get("leaderboard.cache_miss", 0),
            "single_flight": leaderboard.fills.snapshot(),
        },
        "rate_limits": {
            "allowed": counters.get("ratelimit.allowed", 0),
            "blocked": counters.get("ratelimit.blocked", 0),
            "fail_open": counters.get("ratelimit.fail_open", 0),
            "fail_closed": counters.get("ratelimit.fail_closed", 0),
        },
        "analytics_stream": ingestion,
    }
