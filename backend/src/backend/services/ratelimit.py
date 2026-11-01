"""Fixed-window rate limiting in Redis.

Security-relevant paths fail closed when Redis is unavailable; redirects opt
into fail-open so a limiter outage does not take public links down.
"""

from collections.abc import Sequence

from backend.core import metrics
from backend.core.problems import APIError
from backend.core.redis import RedisError, pipeline

Rule = tuple[str, int, int]  # (key, limit, window_seconds)


async def check_rate_limits(
    rules: Sequence[Rule],
    *,
    fail_open: bool = False,
) -> tuple[bool, int]:
    """Count one hit against every rule in a single Redis round trip.

    Returns (allowed, retry_after_seconds); a request is blocked when any rule
    is over its limit, and retry_after is the longest remaining window.
    """
    commands: list[list[str | int | float | None]] = []
    for key, _limit, window_seconds in rules:
        redis_key = f"rl:{key}"
        commands += [
            ["INCR", redis_key],
            ["EXPIRE", redis_key, window_seconds, "NX"],
            ["TTL", redis_key],
        ]
    try:
        results = await pipeline(commands)
    except RedisError:
        if fail_open:
            metrics.incr("ratelimit.fail_open")
            return True, 0
        metrics.incr("ratelimit.fail_closed")
        raise APIError(
            503,
            "dependency_unavailable",
            "Rate limiting is temporarily unavailable.",
        ) from None

    retry_after = 0
    for index, (_key, limit, window_seconds) in enumerate(rules):
        count, _expire, ttl = results[index * 3 : index * 3 + 3]
        if count > limit:
            wait = ttl if isinstance(ttl, int) and ttl > 0 else window_seconds
            retry_after = max(retry_after, wait)
    if retry_after:
        metrics.incr("ratelimit.blocked")
        return False, retry_after
    metrics.incr("ratelimit.allowed")
    return True, 0


async def check_rate_limit(
    key: str,
    limit: int,
    window_seconds: int = 60,
    *,
    fail_open: bool = False,
) -> tuple[bool, int]:
    """Returns (allowed, retry_after_seconds)."""
    return await check_rate_limits([(key, limit, window_seconds)], fail_open=fail_open)
