"""Live, per-instance view of the reliability mechanisms behind the API."""

import time

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from backend.api.deps import (
    WorkspaceContext,
    enforce_same_origin,
    get_api_session,
    get_workspace_context,
    require_user,
)
from backend.api.routes import links as links_routes
from backend.api.routes import redirect
from backend.api.routes.redirect import cache_fills
from backend.core import metrics, security
from backend.core.config import get_settings
from backend.core.redis import CircuitOpenError, RedisError, breaker, command
from backend.models import User
from backend.services import analytics, leaderboard, tracer
from backend.services import links as links_service

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


def _config() -> dict:
    """The tunables behind each mechanism, read from the running code."""
    settings = get_settings()
    return {
        "short_codes": {
            "length": security.SHORT_CODE_LENGTH,
            "alphabet": len(security.BASE62),
            "space": len(security.BASE62) ** security.SHORT_CODE_LENGTH,
            "retry_limit": links_service.CODE_RETRY_LIMIT,
        },
        "rate_limits": [
            {
                "name": "Redirects",
                "limit": redirect.REDIRECT_LIMIT,
                "window_seconds": redirect.REDIRECT_WINDOW_SECONDS,
                "scope": "per IP",
                "fail_open": True,
            },
            {
                "name": "Alias checks",
                "limit": links_routes.ALIAS_CHECK_LIMIT,
                "window_seconds": 60,
                "scope": "per IP",
                "fail_open": True,
            },
            {
                "name": "Link creation",
                "limit": links_routes.CREATE_LIMIT_WORKSPACE,
                "window_seconds": 60,
                "scope": "per workspace",
                "fail_open": False,
            },
            {
                "name": "Anonymous creation",
                "limit": links_routes.CREATE_LIMIT_ANONYMOUS,
                "window_seconds": 60,
                "scope": "per IP",
                "fail_open": False,
            },
            {
                "name": "Traces",
                "limit": tracer.TRACE_LIMIT,
                "window_seconds": redirect.REDIRECT_WINDOW_SECONDS,
                "scope": "per user",
                "fail_open": True,
            },
        ],
        "redirect_cache_seconds": settings.redirect_cache_seconds,
        "leaderboard_cache_seconds": leaderboard.CACHE_SECONDS,
        "breaker": {
            "failure_threshold": breaker.failure_threshold,
            "reset_after_seconds": breaker.reset_after,
        },
        "analytics": {
            "drain_batch": analytics.DRAIN_BATCH,
            "max_events_per_drain": analytics.MAX_EVENTS_PER_DRAIN,
            "read_drain_limit": analytics.READ_DRAIN_LIMIT,
            "drain_on_read": settings.drain_on_read,
            "claim_min_idle_seconds": settings.analytics_claim_min_idle_seconds,
            "max_attempts": settings.analytics_max_attempts,
        },
        "retention": {
            "raw_click_days": settings.raw_click_retention_days,
            "daily_rollup_days": settings.daily_retention_days,
            "cleanup_batch": analytics.CLEANUP_BATCH,
        },
        "replay_ttl_seconds": settings.replay_ttl_seconds,
        "session_ttl_seconds": settings.session_ttl_seconds,
    }


class TraceRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    code: str = Field(min_length=1, max_length=64)
    cold: bool = False


@router.post(
    "/trace",
    summary="Trace one redirect through the real pipeline without counting a click",
    dependencies=[Depends(enforce_same_origin)],
)
async def trace(
    payload: TraceRequest,
    session: AsyncSession = Depends(get_api_session),
    context: WorkspaceContext = Depends(get_workspace_context),
) -> dict:
    # Only links in the caller's workspace can be traced.
    await links_service.get_workspace_url(session, payload.code, context.workspace.id)
    return await tracer.trace_redirect(
        session, payload.code, str(context.user.id), cold=payload.cold
    )


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
        "config": _config(),
    }
