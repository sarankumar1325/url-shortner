"""Fixed-window rate limiting in Redis.

Security-relevant paths fail closed when Redis is unavailable; redirects opt
into fail-open so a limiter outage does not take public links down.
"""

from backend.core.problems import APIError
from backend.core.redis import RedisError, pipeline


async def check_rate_limit(
    key: str,
    limit: int,
    window_seconds: int = 60,
    *,
    fail_open: bool = False,
) -> tuple[bool, int]:
    """Returns (allowed, retry_after_seconds)."""
    redis_key = f"rl:{key}"
    try:
        count, ttl = await pipeline(
            [["INCR", redis_key], ["EXPIRE", redis_key, window_seconds, "NX"]]
        )
        if count > limit:
            retry = ttl if isinstance(ttl, int) and ttl > 0 else window_seconds
            return False, retry
        return True, 0
    except RedisError:
        if fail_open:
            return True, 0
        raise APIError(
            503,
            "dependency_unavailable",
            "Rate limiting is temporarily unavailable.",
        ) from None
