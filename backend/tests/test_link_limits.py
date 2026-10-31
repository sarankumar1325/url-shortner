from datetime import UTC, datetime, timedelta

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy.dialects import postgresql

from backend.api import deps
from backend.api.routes import redirect as redirect_routes
from backend.core.problems import APIError
from backend.main import app
from backend.services import links as links_service

PAST = (datetime.now(UTC) - timedelta(days=1)).isoformat()
FUTURE = (datetime.now(UTC) + timedelta(days=1)).isoformat()
CHROME = "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/140.0 Safari/537.36"


def _entry(**overrides) -> dict:
    return {
        "url_id": 9,
        "long_url": "https://example.com/offer",
        "expires_at": None,
        "fallback_url": None,
        "max_clicks": None,
        **overrides,
    }


async def _no_session():
    yield None


@pytest.fixture
def harness(monkeypatch: pytest.MonkeyPatch):
    state: dict = {"clicks": [], "consume": [], "allow": True, "entry": _entry()}

    async def allow(*_args, **_kwargs):
        return True, 0

    async def record_click(**kwargs):
        state["clicks"].append(kwargs["url_id"])

    async def cache_get(_code):
        return state["entry"]

    async def consume_visit(_session, url_id, *, count):
        state["consume"].append((url_id, count))
        return state["allow"]

    monkeypatch.setattr(redirect_routes.ratelimit, "check_rate_limit", allow)
    monkeypatch.setattr(redirect_routes.analytics_service, "record_click", record_click)
    monkeypatch.setattr(redirect_routes, "_cache_get", cache_get)
    monkeypatch.setattr(links_service, "consume_visit", consume_visit)
    app.dependency_overrides[deps.get_api_session] = _no_session
    yield state
    app.dependency_overrides.pop(deps.get_api_session, None)


async def _request(method: str, path: str, **headers: str):
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        return await client.request(method, path, headers=headers)


@pytest.mark.asyncio
async def test_expired_link_with_fallback_redirects_there(harness) -> None:
    harness["entry"] = _entry(expires_at=PAST, fallback_url="https://example.com/next")

    response = await _request("GET", "/offer1")

    assert response.status_code == 302
    assert response.headers["location"] == "https://example.com/next"
    assert harness["clicks"] == [9]


@pytest.mark.asyncio
async def test_expired_link_without_fallback_is_gone(harness) -> None:
    harness["entry"] = _entry(expires_at=PAST)

    response = await _request("GET", "/offer1", accept="application/json")

    assert response.status_code == 410
    assert response.json()["code"] == "link_expired"


@pytest.mark.asyncio
async def test_uncapped_links_never_touch_the_counter(harness) -> None:
    response = await _request("GET", "/offer1", **{"user-agent": CHROME})

    assert response.status_code == 302
    assert harness["consume"] == []


@pytest.mark.asyncio
async def test_capped_link_uses_a_visit(harness) -> None:
    harness["entry"] = _entry(max_clicks=1, expires_at=FUTURE)

    response = await _request("GET", "/offer1", **{"user-agent": CHROME})

    assert response.status_code == 302
    assert response.headers["location"] == "https://example.com/offer"
    assert harness["consume"] == [(9, True)]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "agent",
    [
        "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
        "WhatsApp/2.23.20.0 A",
        "Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)",
    ],
)
async def test_link_unfurlers_do_not_use_up_visits(harness, agent: str) -> None:
    harness["entry"] = _entry(max_clicks=1)

    await _request("GET", "/offer1", **{"user-agent": agent})

    assert harness["consume"] == [(9, False)]


@pytest.mark.asyncio
async def test_used_up_link_without_fallback(harness) -> None:
    harness["entry"] = _entry(max_clicks=3)
    harness["allow"] = False

    api = await _request("GET", "/offer1", accept="application/json")
    page = await _request("GET", "/offer1", accept="text/html")

    assert api.status_code == 410
    assert api.json()["code"] == "link_exhausted"
    assert page.status_code == 410
    assert "used up" in page.text
    assert harness["clicks"] == []


@pytest.mark.asyncio
async def test_used_up_link_with_fallback(harness) -> None:
    harness["entry"] = _entry(max_clicks=3, fallback_url="https://example.com/sold-out")
    harness["allow"] = False

    response = await _request("GET", "/offer1", **{"user-agent": CHROME})

    assert response.status_code == 302
    assert response.headers["location"] == "https://example.com/sold-out"
    assert harness["clicks"] == [9]


@pytest.mark.asyncio
async def test_previews_and_head_only_check_the_limit(harness) -> None:
    harness["entry"] = _entry(max_clicks=1)

    preview = await _request("GET", "/offer1+")
    head = await _request("HEAD", "/offer1")

    assert preview.status_code == 200
    assert "limited-use link" in preview.text
    assert head.status_code == 302
    assert harness["consume"] == [(9, False), (9, False)]
    assert harness["clicks"] == []


@pytest.mark.asyncio
async def test_preview_explains_fallback(harness) -> None:
    harness["entry"] = _entry(expires_at=PAST, fallback_url="https://example.com/next")

    response = await _request("GET", "/offer1+")

    assert response.status_code == 200
    assert "fallback page" in response.text
    assert "https://example.com/next" in response.text


def test_visit_limit_bounds() -> None:
    assert links_service._validate_max_clicks(None) is None
    assert links_service._validate_max_clicks(1) == 1
    assert links_service._validate_max_clicks(1_000_000) == 1_000_000
    for bad in (0, -1, 1_000_001):
        with pytest.raises(APIError) as caught:
            links_service._validate_max_clicks(bad)
        assert caught.value.errors[0]["field"] == "max_clicks"


def test_fallback_errors_name_the_fallback_field() -> None:
    assert links_service._validate_fallback("https://Example.com") == "https://example.com/"
    with pytest.raises(APIError) as caught:
        links_service._validate_fallback("ftp://example.com/file")
    assert caught.value.errors[0]["field"] == "fallback_url"
    assert "fallback" in caught.value.detail


def test_replay_hash_is_unchanged_when_new_fields_are_unset() -> None:
    before = (
        b'{"custom_alias":null,"expires_at":null,'
        b'"long_url":"https://example.com/","tags":[]}'
    )
    assert links_service._canonical_request("https://example.com/", None, None, []) == before
    assert b"max_clicks" in links_service._canonical_request(
        "https://example.com/", None, None, [], None, 5
    )


def test_previewer_detection() -> None:
    assert links_service.is_link_previewer("WhatsApp/2.23.20.0 A")
    assert links_service.is_link_previewer("Slackbot-LinkExpanding 1.0")
    assert not links_service.is_link_previewer(CHROME)
    assert not links_service.is_link_previewer(None)


class _CapturingSession:
    def __init__(self) -> None:
        self.statements: list = []
        self.commits = 0

    async def execute(self, statement):
        self.statements.append(statement)

        class _Result:
            def scalar_one_or_none(self_inner):
                return 9

        return _Result()

    async def commit(self) -> None:
        self.commits += 1


@pytest.mark.asyncio
async def test_consume_visit_is_a_single_guarded_update() -> None:
    session = _CapturingSession()

    assert await links_service.consume_visit(session, 9, count=True)

    sql = str(session.statements[0].compile(dialect=postgresql.dialect()))
    assert sql.startswith("UPDATE urls SET")
    assert "urls.clicks_used < urls.max_clicks" in sql
    assert "RETURNING urls.id" in sql
    assert session.commits == 1


@pytest.mark.asyncio
async def test_checking_a_limit_does_not_write() -> None:
    session = _CapturingSession()

    assert await links_service.consume_visit(session, 9, count=False)

    assert str(session.statements[0].compile(dialect=postgresql.dialect())).startswith("SELECT")
    assert session.commits == 0
