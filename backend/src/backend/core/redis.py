"""Minimal async client for the Upstash Redis REST API.

Only the pipeline endpoint is used; each command is a list of strings and
results come back positionally. Errors surface as RedisError so callers can
degrade gracefully (redirects must not fail because Redis is down).
"""

import httpx

from backend.core.config import get_settings

_client: httpx.AsyncClient | None = None


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


async def pipeline(commands: list[list[str | int | float | None]]) -> list:
    try:
        response = await get_client().post("/pipeline", json=commands)
    except httpx.HTTPError as exc:
        raise RedisError("upstash request failed") from exc
    if response.status_code != 200:
        raise RedisError(f"upstash returned {response.status_code}")
    try:
        body = response.json()
    except ValueError as exc:
        raise RedisError("upstash returned invalid json") from exc
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
