"""Minimal async client for the Upstash Redis REST API.

Only the pipeline endpoint is used; each command is a list of strings and
results come back positionally. Errors surface as RedisError so callers can
degrade gracefully (redirects must not fail because Redis is down).

Transport failures feed a circuit breaker; while it is open, calls fail fast
with CircuitOpenError instead of each waiting out the HTTP timeout. Command
errors (wrong type, NOGROUP) mean Redis answered, so they count as successes.
"""

import httpx

from backend.core.breaker import CircuitBreaker
from backend.core.config import get_settings

_client: httpx.AsyncClient | None = None

breaker = CircuitBreaker("redis", failure_threshold=5, reset_after=15.0)


def get_client() -> httpx.AsyncClient:
    global _client
    if _client is None:
        settings = get_settings()
        _client = httpx.AsyncClient(
            base_url=settings.upstash_redis_rest_url,
            headers={"Authorization": f"Bearer {settings.upstash_redis_rest_token}"},
            timeout=5.0,
        )
    return _client


class RedisError(Exception):
    pass


class CircuitOpenError(RedisError):
    pass


async def pipeline(commands: list[list[str | int | float | None]]) -> list:
    if not breaker.allow():
        raise CircuitOpenError("redis circuit is open")
    try:
        response = await get_client().post("/pipeline", json=commands)
    except httpx.HTTPError as exc:
        breaker.record_failure(type(exc).__name__)
        raise RedisError("upstash request failed") from exc
    if response.status_code != 200:
        breaker.record_failure(f"http {response.status_code}")
        raise RedisError(f"upstash returned {response.status_code}")
    try:
        body = response.json()
    except ValueError as exc:
        breaker.record_failure("invalid json")
        raise RedisError("upstash returned invalid json") from exc
    breaker.record_success()
    results = []
    for entry in body:
        if isinstance(entry, dict) and "error" in entry:
            raise RedisError(entry["error"])
        results.append(entry.get("result") if isinstance(entry, dict) else entry)
    return results


async def command(*parts: str | int | float | None):
    results = await pipeline([list(parts)])
    return results[0]


async def aclose() -> None:
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None
