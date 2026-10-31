"""Top links leaderboard, cached per workspace in Redis (cache-aside).

The ranking reads pre-aggregated daily rollups, then the result is cached for
a short TTL so dashboards polling it do not re-run the aggregate. Concurrent
misses share one query through single-flight. Staleness is bounded by the TTL;
clicks still waiting in the analytics stream are not counted until drained.
"""

import json
import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.core import metrics
from backend.core.config import get_settings
from backend.core.redis import RedisError, command
from backend.core.singleflight import SingleFlight
from backend.models import ClickDaily, Url

CACHE_PREFIX = "top:"
CACHE_SECONDS = 60
ALLOWED_DAYS = (1, 7, 30)

fills = SingleFlight()


def cache_key(workspace_id: uuid.UUID, days: int, limit: int) -> str:
    return f"{CACHE_PREFIX}{workspace_id}:{days}:{limit}"


def _iso(value: datetime) -> str:
    return value.isoformat().replace("+00:00", "Z")


async def _compute(session: AsyncSession, workspace_id: uuid.UUID, days: int, limit: int) -> dict:
    today = datetime.now(UTC).date()
    cutoff = today - timedelta(days=days - 1)
    clicks = func.sum(ClickDaily.clicks).label("clicks")
    result = await session.execute(
        select(Url.short_code, Url.long_url, clicks)
        .join(ClickDaily, ClickDaily.url_id == Url.id)
        .where(
            Url.workspace_id == workspace_id,
            Url.deleted_at.is_(None),
            ClickDaily.day >= cutoff,
            ClickDaily.day <= today,
        )
        .group_by(Url.id)
        .order_by(clicks.desc(), Url.id.desc())
        .limit(limit)
    )
    base = get_settings().short_base_url.rstrip("/")
    return {
        "days": days,
        "links": [
            {
                "short_code": code,
                "short_url": f"{base}/{code}",
                "long_url": long_url,
                "clicks": int(total or 0),
            }
            for code, long_url, total in result.all()
        ],
        "generated_at": _iso(datetime.now(UTC)),
    }


async def _read_cache(key: str) -> dict | None:
    try:
        raw = await command("GET", key)
    except RedisError:
        return None
    if raw is None:
        return None
    try:
        return json.loads(raw)
    except (TypeError, ValueError):
        return None


async def _write_cache(key: str, payload: dict) -> None:
    try:
        await command("SETEX", key, CACHE_SECONDS, json.dumps(payload, separators=(",", ":")))
    except RedisError:
        pass


async def top_links(session: AsyncSession, workspace_id: uuid.UUID, days: int, limit: int) -> dict:
    key = cache_key(workspace_id, days, limit)
    cached = await _read_cache(key)
    if cached is not None:
        metrics.incr("leaderboard.cache_hit")
        return {**cached, "cached": True, "ttl_seconds": CACHE_SECONDS}

    metrics.incr("leaderboard.cache_miss")

    async def load() -> dict:
        payload = await _compute(session, workspace_id, days, limit)
        await _write_cache(key, payload)
        return payload

    payload = await fills.do(key, load)
    return {**payload, "cached": False, "ttl_seconds": CACHE_SECONDS}
