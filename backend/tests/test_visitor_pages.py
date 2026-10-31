import pytest
from httpx import ASGITransport, AsyncClient

from backend.api import deps
from backend.api.routes import redirect as redirect_routes
from backend.core.problems import APIError
from backend.main import app
from backend.services import visitor_pages

LIVE = {"url_id": 7, "long_url": "https://example.com/launch?x=1", "expires_at": None}


async def _no_session():
    yield None


@pytest.fixture
def clicks(monkeypatch: pytest.MonkeyPatch) -> list[int]:
    recorded: list[int] = []

    async def allow(*_args, **_kwargs):
        return True, 0

    async def record_click(**kwargs):
        recorded.append(kwargs["url_id"])

    monkeypatch.setattr(redirect_routes.ratelimit, "check_rate_limit", allow)
    monkeypatch.setattr(redirect_routes.analytics_service, "record_click", record_click)
    app.dependency_overrides[deps.get_api_session] = _no_session
    yield recorded
    app.dependency_overrides.pop(deps.get_api_session, None)


def _resolve_to(monkeypatch: pytest.MonkeyPatch, outcome) -> list[str]:
    seen: list[str] = []

    async def resolve(code, _session):
        seen.append(code)
        if isinstance(outcome, APIError):
            raise outcome
        return outcome

    monkeypatch.setattr(redirect_routes, "resolve_redirect", resolve)
    return seen


async def _get(path: str, accept: str = "*/*"):
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        return await client.get(path, headers={"Accept": accept})


@pytest.mark.asyncio
async def test_preview_shows_destination_without_counting_a_click(clicks, monkeypatch) -> None:
    seen = _resolve_to(monkeypatch, LIVE)

    response = await _get("/abc12+")

    assert response.status_code == 200
    assert seen == ["abc12"]
    assert clicks == []
    assert "example.com" in response.text
    assert "https://example.com/launch?x=1" in response.text
    assert 'href="/abc12"' in response.text
    assert "/report?code=abc12" in response.text
    assert response.headers["cache-control"] == "no-store"
    assert "default-src 'none'" in response.headers["content-security-policy"]


@pytest.mark.asyncio
async def test_redirect_still_counts_clicks(clicks, monkeypatch) -> None:
    _resolve_to(monkeypatch, LIVE)

    response = await _get("/abc12")

    assert response.status_code == 302
    assert response.headers["location"] == LIVE["long_url"]
    assert clicks == [7]


@pytest.mark.asyncio
async def test_preview_escapes_destination(clicks, monkeypatch) -> None:
    _resolve_to(
        monkeypatch,
        {**LIVE, "long_url": 'https://example.com/?q="><script>alert(1)</script>'},
    )

    response = await _get("/abc12+")

    assert "<script>alert(1)</script>" not in response.text
    assert "&lt;script&gt;" in response.text


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("error", "status", "phrase"),
    [
        (APIError(404, "link_not_found", "No such link."), 404, "isn’t available"),
        (APIError(410, "link_expired", "This link has expired."), 410, "has expired"),
    ],
)
async def test_browsers_get_a_readable_page(clicks, monkeypatch, error, status, phrase) -> None:
    _resolve_to(monkeypatch, error)

    response = await _get("/gone1", accept="text/html,application/xhtml+xml")

    assert response.status_code == status
    assert response.headers["content-type"].startswith("text/html")
    assert phrase in response.text
    assert clicks == []


@pytest.mark.asyncio
async def test_api_clients_keep_problem_details(clicks, monkeypatch) -> None:
    _resolve_to(monkeypatch, APIError(410, "link_expired", "This link has expired."))

    response = await _get("/gone1", accept="application/json")

    assert response.status_code == 410
    assert response.headers["content-type"] == "application/problem+json"
    assert response.json()["code"] == "link_expired"


@pytest.mark.asyncio
async def test_preview_of_missing_link_is_a_page(clicks, monkeypatch) -> None:
    _resolve_to(monkeypatch, APIError(404, "link_not_found", "No such link."))

    response = await _get("/nope1+")

    assert response.status_code == 404
    assert "isn’t available" in response.text


def test_signals_for_a_plain_https_site() -> None:
    assert visitor_pages.destination_signals("https://www.example.com/docs") == []


@pytest.mark.parametrize(
    ("url", "phrase"),
    [
        ("http://example.com/", "does not use HTTPS"),
        ("https://203.0.113.9/login", "raw IP address"),
        ("https://[2001:db8::1]/", "raw IP address"),
        ("https://xn--pple-43d.com/", "international characters (аpple.com)"),
        ("https://bit.ly/abc", "another link shortener"),
        ("https://example.com:8443/", "unusual network port (8443)"),
    ],
)
def test_signals_flag_risky_addresses(url: str, phrase: str) -> None:
    assert any(phrase in signal for signal in visitor_pages.destination_signals(url))
