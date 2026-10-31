import asyncio
import uuid

import pytest
from httpx import ASGITransport, AsyncClient

from backend.api import deps
from backend.api.routes import redirect as redirect_routes
from backend.core import metrics
from backend.core.redis import RedisError
from backend.main import app
from backend.services import leaderboard
from backend.services import links as links_service


class _Result:
    def __init__(self, value) -> None:
        self.value = value

    def scalar_one_or_none(self):
        return self.value


class _Session:
    def __init__(self, value=None) -> None:
        self.value = value
        self.queries = 0

    async def execute(self, _query):
        self.queries += 1
        return _Result(self.value)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("alias", "reason"),
    [("api", "reserved"), ("ab", "invalid"), ("Promo", "invalid"), ("-bad-", "invalid")],
)
async def test_alias_rules_are_checked_before_any_lookup(alias, reason) -> None:
    session = _Session()

    result = await links_service.alias_availability(session, alias)

    assert result["available"] is False
    assert result["reason"] == reason
    assert session.queries == 0


@pytest.mark.asyncio
async def test_cached_alias_is_taken_without_a_database_query(monkeypatch) -> None:
    async def exists(*_parts):
        return 1

    monkeypatch.setattr(links_service, "command", exists)
    session = _Session()

    result = await links_service.alias_availability(session, "spring-sale")

    assert result == {
        "alias": "spring-sale",
        "available": False,
        "reason": "taken",
        "message": "That alias is already in use.",
        "source": "cache",
    }
    assert session.queries == 0


@pytest.mark.asyncio
async def test_alias_falls_back_to_postgres_when_redis_is_down(monkeypatch) -> None:
    async def down(*_parts):
        raise RedisError("down")

    monkeypatch.setattr(links_service, "command", down)

    taken = await links_service.alias_availability(_Session(value=7), "spring-sale")
    free = await links_service.alias_availability(_Session(value=None), "spring-sale")

    assert (taken["available"], taken["source"]) == (False, "database")
    assert (free["available"], free["reason"]) == (True, None)


@pytest.mark.asyncio
async def test_leaderboard_serves_cache_hits_without_querying(monkeypatch) -> None:
    store: dict[str, str] = {}
    computed = 0

    async def fake_command(name, key, *args):
        if name == "GET":
            return store.get(key)
        store[key] = args[-1]
        return "OK"

    async def compute(_session, _workspace, days, _limit):
        nonlocal computed
        computed += 1
        await asyncio.sleep(0)
        return {"days": days, "links": [], "generated_at": "2026-01-01T00:00:00Z"}

    monkeypatch.setattr(leaderboard, "command", fake_command)
    monkeypatch.setattr(leaderboard, "_compute", compute)
    workspace = uuid.uuid4()

    first, second = await asyncio.gather(
        leaderboard.top_links(None, workspace, 7, 5), leaderboard.top_links(None, workspace, 7, 5)
    )
    third = await leaderboard.top_links(None, workspace, 7, 5)

    assert computed == 1
    assert (first["cached"], second["cached"], third["cached"]) == (False, False, True)
    assert metrics.get("leaderboard.cache_hit") == 1


@pytest.mark.asyncio
async def test_redirect_misses_for_one_code_share_one_load(monkeypatch) -> None:
    loads = 0
    gate = asyncio.Event()

    async def cache_miss(_code):
        return None

    async def load(_code, _session):
        nonlocal loads
        loads += 1
        await gate.wait()
        return {
            "url_id": 1,
            "long_url": "https://example.com/",
            "expires_at": None,
            "fallback_url": None,
            "max_clicks": None,
        }

    monkeypatch.setattr(redirect_routes, "_cache_get", cache_miss)
    monkeypatch.setattr(redirect_routes, "_load_entry", load)
    redirect_routes.cache_fills.reset()

    tasks = [asyncio.create_task(redirect_routes.resolve_redirect("hot", None)) for _ in range(5)]
    await asyncio.sleep(0)
    gate.set()
    entries = await asyncio.gather(*tasks)

    assert loads == 1
    assert {entry["long_url"] for entry in entries} == {"https://example.com/"}
    assert metrics.get("redirect.cache_miss") == 5
    assert redirect_routes.cache_fills.shared == 4


async def _no_session():
    yield _Session()


@pytest.mark.asyncio
async def test_system_status_requires_sign_in() -> None:
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get("/api/v1/system/status")

    assert response.status_code == 401


@pytest.mark.asyncio
async def test_system_status_reports_mechanisms(monkeypatch) -> None:
    from backend.api.routes import system

    async def ping(*_parts):
        return "PONG"

    async def ingestion():
        return {"redis_ok": True, "stream_depth": 0}

    monkeypatch.setattr(system, "command", ping)
    monkeypatch.setattr(system.analytics, "ingestion_status", ingestion)
    metrics.incr("redirect.cache_hit", 3)
    metrics.incr("redirect.cache_miss", 1)
    app.dependency_overrides[deps.get_api_session] = _no_session
    app.dependency_overrides[deps.require_user] = lambda: object()
    try:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get("/api/v1/system/status")
    finally:
        app.dependency_overrides.pop(deps.get_api_session, None)
        app.dependency_overrides.pop(deps.require_user, None)

    assert response.status_code == 200
    body = response.json()
    assert body["dependencies"]["redis"]["ok"] is True
    assert body["dependencies"]["postgres"]["ok"] is True
    assert body["circuit_breaker"]["state"] == "closed"
    assert body["redirect_cache"]["hit_ratio"] == 0.75
    config = body["config"]
    assert config["short_codes"]["space"] == 62**5
    assert config["breaker"]["failure_threshold"] == 5
    assert {limit["name"] for limit in config["rate_limits"]} >= {"Redirects", "Traces"}
