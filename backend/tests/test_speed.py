import pytest
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from httpx import ASGITransport, AsyncClient

from backend.api.deps import SESSION_COOKIE, SessionRenewalMiddleware
from backend.api.routes import health
from backend.core import timing
from backend.main import app
from backend.services import ratelimit


@pytest.mark.asyncio
async def test_every_response_carries_server_timing() -> None:
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get("/health")
        api_response = await client.get("/api/v1/health")

    assert api_response.status_code == 200
    header = response.headers["server-timing"]
    names = [part.strip().split(";")[0] for part in header.split(",")]
    assert names == ["db", "redis", "total"]
    assert 'desc="Postgres x0"' in header


def test_warm_up_probes_are_served_under_the_api_prefix() -> None:
    for router in (health.router, health.api_router):
        assert {getattr(route, "path", None) for route in router.routes} == {"/health", "/ready"}


def test_server_timing_header_reports_accumulated_work() -> None:
    timings, token = timing.start()
    try:
        timing.add_db(3.25)
        timing.add_db(1.0)
        timing.add_redis(7.5)
    finally:
        timing.stop(token)
    assert timing.header_value(timings, 20.04) == (
        'db;dur=4.2;desc="Postgres x2", redis;dur=7.5;desc="Redis x1", total;dur=20.0'
    )
    # Outside a request, recording is a no-op.
    timing.add_db(1.0)
    assert timing.current() is None


@pytest.mark.asyncio
async def test_rate_limits_share_one_redis_round_trip(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = []

    async def fake_pipeline(commands):
        calls.append(commands)
        return [3, 1, 60, 11, 0, 42]

    monkeypatch.setattr(ratelimit, "pipeline", fake_pipeline)
    allowed, retry_after = await ratelimit.check_rate_limits(
        [("login-ip:1.2.3.4", 30, 60), ("login-account:a@b.c", 10, 60)]
    )

    assert len(calls) == 1
    assert [command[0] for command in calls[0]] == ["INCR", "EXPIRE", "TTL"] * 2
    assert calls[0][3] == ["INCR", "rl:login-account:a@b.c"]
    assert allowed is False
    # The countdown uses the real remaining window, not the full window.
    assert retry_after == 42


@pytest.mark.asyncio
async def test_rate_limit_allows_under_every_limit(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_pipeline(_commands):
        return [1, 1, 60, 1, 1, 60]

    monkeypatch.setattr(ratelimit, "pipeline", fake_pipeline)
    assert await ratelimit.check_rate_limits([("a:x", 1, 60), ("b:x", 1, 60)]) == (True, 0)


def _renewal_app() -> FastAPI:
    inner = FastAPI()

    @inner.get("/renewed")
    async def renewed(request: Request) -> JSONResponse:
        request.state.renewed_session_token = "shrs_token"
        return JSONResponse({"ok": True})

    @inner.get("/plain")
    async def plain() -> dict:
        return {"ok": True}

    inner.add_middleware(SessionRenewalMiddleware)
    return inner


@pytest.mark.asyncio
async def test_renewed_sessions_get_a_fresh_cookie() -> None:
    transport = ASGITransport(app=_renewal_app())
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        renewed = await client.get("/renewed")
        plain = await client.get("/plain")

    cookie = renewed.headers["set-cookie"]
    assert cookie.startswith(f"{SESSION_COOKIE}=shrs_token")
    assert "Max-Age=2592000" in cookie
    assert "HttpOnly" in cookie
    assert "set-cookie" not in plain.headers
