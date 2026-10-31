"""Redis client fail-open boundary: transport failures become RedisError."""

import httpx
import pytest

from backend.core import redis


class _BrokenClient:
    async def post(self, *args, **kwargs):
        raise httpx.ConnectTimeout("upstash timed out")


class _Response:
    def __init__(self, status_code: int, body) -> None:
        self.status_code = status_code
        self._body = body

    def json(self):
        if isinstance(self._body, Exception):
            raise self._body
        return self._body


class _StaticClient:
    def __init__(self, response: _Response) -> None:
        self.response = response

    async def post(self, *args, **kwargs):
        return self.response


@pytest.mark.asyncio
async def test_transport_errors_become_redis_errors(monkeypatch) -> None:
    monkeypatch.setattr(redis, "get_client", lambda: _BrokenClient())

    with pytest.raises(redis.RedisError):
        await redis.pipeline([["PING"]])


@pytest.mark.asyncio
async def test_non_200_responses_become_redis_errors(monkeypatch) -> None:
    monkeypatch.setattr(redis, "get_client", lambda: _StaticClient(_Response(503, [])))

    with pytest.raises(redis.RedisError):
        await redis.command("PING")


@pytest.mark.asyncio
async def test_invalid_json_becomes_redis_error(monkeypatch) -> None:
    client = _StaticClient(_Response(200, ValueError("bad json")))
    monkeypatch.setattr(redis, "get_client", lambda: client)

    with pytest.raises(redis.RedisError):
        await redis.pipeline([["PING"]])


@pytest.mark.asyncio
async def test_command_errors_become_redis_errors(monkeypatch) -> None:
    client = _StaticClient(_Response(200, [{"error": "ERR wrong type"}]))
    monkeypatch.setattr(redis, "get_client", lambda: client)

    with pytest.raises(redis.RedisError):
        await redis.command("PING")
