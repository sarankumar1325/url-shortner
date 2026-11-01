from datetime import UTC, date, datetime, timedelta
from types import SimpleNamespace

import pytest
from httpx import ASGITransport, AsyncClient

from backend.api import deps
from backend.api.routes import redirect
from backend.core import metrics
from backend.core.problems import APIError
from backend.main import app
from backend.services import dashboard, tracer
from backend.services import links as links_service

NOW = datetime(2026, 10, 31, 12, tzinfo=UTC)


def _url(**overrides):
    values = {
        "is_blocked": False,
        "is_active": True,
        "expires_at": None,
        "max_clicks": None,
        "clicks_used": 0,
        "fallback_url": None,
        "created_at": NOW - timedelta(days=30),
    }
    values.update(overrides)
    return SimpleNamespace(**values)


@pytest.mark.parametrize(
    ("overrides", "status"),
    [
        ({}, "active"),
        ({"is_active": False}, "paused"),
        ({"expires_at": NOW - timedelta(seconds=1), "is_active": False}, "expired"),
        ({"max_clicks": 10, "clicks_used": 10, "is_active": False}, "used_up"),
        ({"is_blocked": True, "expires_at": NOW - timedelta(days=1)}, "blocked"),
    ],
)
def test_status_precedence_matches_the_web_app(overrides, status) -> None:
    assert dashboard.link_status(_url(**overrides), NOW) == status


def test_issues_flag_what_needs_attention() -> None:
    soon = _url(expires_at=NOW + timedelta(days=2), max_clicks=10, clicks_used=8)
    assert dashboard.link_issues(soon, "active", 3, NOW) == ["expiring_soon", "near_limit"]

    quiet = _url()
    assert dashboard.link_issues(quiet, "active", 0, NOW) == ["no_recent_clicks"]

    new = _url(created_at=NOW - timedelta(days=1))
    assert dashboard.link_issues(new, "active", 0, NOW) == []

    exhausted = _url(max_clicks=5, clicks_used=5, fallback_url="https://example.com/")
    assert dashboard.link_issues(exhausted, "used_up", 5, NOW) == ["used_up", "serving_fallback"]


def test_series_is_zero_filled_and_change_needs_a_baseline() -> None:
    start = date(2026, 10, 1)
    series = dashboard.zero_fill({date(2026, 10, 2): (4, 3, 1)}, start, date(2026, 10, 4))

    assert [point["clicks"] for point in series] == [0, 4, 0]
    assert series[1] == {"day": "2026-10-02", "clicks": 4, "human_clicks": 3, "bot_clicks": 1}
    assert dashboard.change_ratio(15, 10) == 0.5
    assert dashboard.change_ratio(5, 0) is None


async def _no_session():
    yield None


def _context():
    return SimpleNamespace(
        workspace=SimpleNamespace(id="ws"), role="owner", user=SimpleNamespace(id="u1")
    )


@pytest.mark.asyncio
async def test_dashboard_rejects_unsupported_periods() -> None:
    app.dependency_overrides[deps.get_api_session] = _no_session
    app.dependency_overrides[deps.get_workspace_context] = _context
    try:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get("/api/v1/dashboard?days=5")
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 422


def _row(**overrides):
    values = {
        "id": 1,
        "long_url": "https://example.com/",
        "expires_at": None,
        "fallback_url": None,
        "max_clicks": None,
        "password_hash": None,
    }
    values.update(overrides)
    return SimpleNamespace(**values)


@pytest.fixture
def pipeline(monkeypatch):
    calls: list[str] = []
    cache: dict[str, dict] = {}

    async def allow(*_args, **_kwargs):
        return True, 0

    async def cache_get(code):
        calls.append("get")
        return cache.get(code)

    async def cache_set(code, entry):
        calls.append("set")
        cache[code] = entry

    async def evict(code):
        calls.append("del")
        cache.pop(code, None)

    monkeypatch.setattr(tracer.ratelimit, "check_rate_limit", allow)
    monkeypatch.setattr(redirect, "_cache_get", cache_get)
    monkeypatch.setattr(redirect, "_cache_set", cache_set)
    monkeypatch.setattr(redirect, "invalidate_cache", evict)
    return SimpleNamespace(calls=calls, cache=cache)


@pytest.mark.asyncio
async def test_cold_trace_walks_the_miss_path_without_counting(monkeypatch, pipeline) -> None:
    async def resolve(_session, _code):
        return _row(), "active"

    monkeypatch.setattr(links_service, "resolve_public", resolve)
    pipeline.cache["abc12"] = {"stale": True}

    result = await tracer.trace_redirect(None, "abc12", "u1", cold=True)

    steps = [(step["step"], step["outcome"]) for step in result["steps"]]
    assert steps == [
        ("rate_limit", "allowed"),
        ("evict", "done"),
        ("cache", "miss"),
        ("single_flight", "leader"),
        ("postgres", "loaded"),
        ("cache_fill", "written"),
        ("expiry", "live"),
        ("enqueue", "skipped"),
    ]
    assert pipeline.calls == ["del", "get", "set"]
    assert result["response"] == {"status": 302, "location": "https://example.com/", "reason": None}
    assert metrics.get("redirect.cache_miss") == 0


@pytest.mark.asyncio
async def test_warm_trace_never_touches_postgres(monkeypatch, pipeline) -> None:
    async def resolve(_session, _code):
        raise AssertionError("cache hits must not query Postgres")

    monkeypatch.setattr(links_service, "resolve_public", resolve)
    pipeline.cache["abc12"] = {"url_id": 1, "long_url": "https://example.com/", "max_clicks": None}

    result = await tracer.trace_redirect(None, "abc12", "u1", cold=False)

    assert [step["step"] for step in result["steps"]] == [
        "rate_limit",
        "cache",
        "expiry",
        "enqueue",
    ]
    assert result["steps"][1]["outcome"] == "hit"


@pytest.mark.asyncio
async def test_trace_reports_paused_links_and_used_up_fallbacks(monkeypatch, pipeline) -> None:
    async def paused(_session, _code):
        raise APIError(404, "link_not_found", "No such link.")

    monkeypatch.setattr(links_service, "resolve_public", paused)
    result = await tracer.trace_redirect(None, "off11", "u1", cold=False)
    assert result["response"] == {"status": 404, "location": None, "reason": "link_not_found"}
    assert ("postgres", "not_found") in [(s["step"], s["outcome"]) for s in result["steps"]]

    async def limited(_session, _code):
        return _row(max_clicks=3, fallback_url="https://fallback.example/"), "active"

    async def exhausted(_session, _url_id, *, count):
        assert count is False
        return False

    monkeypatch.setattr(links_service, "resolve_public", limited)
    monkeypatch.setattr(links_service, "consume_visit", exhausted)
    result = await tracer.trace_redirect(None, "lim11", "u1", cold=False)
    assert ("visit_guard", "exhausted") in [(s["step"], s["outcome"]) for s in result["steps"]]
    assert result["response"] == {
        "status": 302,
        "location": "https://fallback.example/",
        "reason": "fallback",
    }


@pytest.mark.asyncio
async def test_trace_endpoint_only_traces_workspace_links(monkeypatch) -> None:
    async def foreign(_session, _code, _workspace):
        raise APIError(404, "link_not_found", "No such link.")

    monkeypatch.setattr(links_service, "get_workspace_url", foreign)
    app.dependency_overrides[deps.get_api_session] = _no_session
    app.dependency_overrides[deps.get_workspace_context] = _context
    try:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.post("/api/v1/system/trace", json={"code": "zzz99"})
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 404
