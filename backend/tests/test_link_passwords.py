"""Password-protected links: storage, the unlock flow, and what never leaks."""

import time
import uuid
from types import SimpleNamespace

import pytest
from httpx import ASGITransport, AsyncClient

from backend.api import deps
from backend.api.routes import redirect as redirect_routes
from backend.core.config import get_settings
from backend.core.problems import APIError
from backend.core.security import (
    generate_password_hash,
    link_password_fingerprint,
    link_password_tag,
    link_unlock_token,
    verify_link_unlock,
    verify_password,
)
from backend.main import app
from backend.models import Url, Workspace
from backend.services import links as links_service

PASSWORD = "open-sesame"
DESTINATION = "https://example.com/secret-plans"
SLACK = "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)"
CHROME = "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/140.0 Safari/537.36"


@pytest.fixture(autouse=True)
def _secret(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("SECRET_KEY", "Tj5I2o7uKkc0jSJsTXb3RxfYpD9dKa/Tb3V0hqmeXiM=")
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def _hash() -> str:
    return generate_password_hash(PASSWORD)


def _entry(password_hash: str, **overrides) -> dict:
    return {
        "url_id": 9,
        "long_url": DESTINATION,
        "expires_at": None,
        "fallback_url": None,
        "max_clicks": None,
        "protected": True,
        "password_tag": link_password_tag(password_hash),
        **overrides,
    }


def test_password_length_is_bounded() -> None:
    assert links_service._validate_password(None) is None
    assert links_service._validate_password("abcd") == "abcd"
    assert links_service._validate_password("x" * 128) == "x" * 128
    for bad in ("abc", "x" * 129, ""):
        with pytest.raises(APIError) as caught:
            links_service._validate_password(bad)
        assert caught.value.errors[0]["field"] == "password"


def test_replay_fingerprint_never_contains_the_password() -> None:
    canonical = links_service._canonical_request(
        "https://example.com/", None, None, [], None, None, PASSWORD
    )
    assert PASSWORD.encode() not in canonical
    assert link_password_fingerprint(PASSWORD).encode() in canonical
    assert link_password_fingerprint(PASSWORD) != link_password_fingerprint(PASSWORD + "!")
    without = links_service._canonical_request("https://example.com/", None, None, [])
    assert b"password" not in without


def test_unlock_tokens_are_bound_to_code_password_and_time() -> None:
    tag = link_password_tag(_hash())
    now = int(time.time())
    token = link_unlock_token("offer1", tag, now + 60)
    assert verify_link_unlock(token, "offer1", tag, now)
    assert not verify_link_unlock(token, "other", tag, now)
    assert not verify_link_unlock(token, "offer1", link_password_tag(_hash()), now)
    assert not verify_link_unlock(token, "offer1", tag, now + 61)
    assert not verify_link_unlock(token.replace(".", ".0"), "offer1", tag, now)
    assert not verify_link_unlock("garbage", "offer1", tag, now)
    assert not verify_link_unlock(None, "offer1", tag, now)


@pytest.mark.asyncio
async def test_set_keep_replace_and_remove_a_password(factory) -> None:
    async with factory() as session:
        workspace = Workspace(name="Team", is_personal=False)
        session.add(workspace)
        await session.flush()
        url = Url(id=501, short_code="vault", long_url=DESTINATION, workspace_id=workspace.id)
        session.add(url)
        await session.commit()

        async def update(**fields):
            defaults = {"long_url": None, "expires_at": None, "is_active": None}
            return await links_service.update_link(
                session, url, clear_expiry=False, **{**defaults, **fields}
            )

        await update(password=PASSWORD)
        first = url.password_hash
        assert first.startswith("$argon2id$") and verify_password(PASSWORD, first)

        await update(is_active=True)
        assert url.password_hash == first

        await update(password="new-password")
        assert verify_password("new-password", url.password_hash)
        assert not verify_password(PASSWORD, url.password_hash)

        await update(clear_password=True)
        assert url.password_hash is None


async def _no_session():
    yield None


@pytest.fixture
def harness(monkeypatch: pytest.MonkeyPatch):
    password_hash = _hash()
    state: dict = {
        "clicks": [],
        "consume": [],
        "allow": True,
        "hash": password_hash,
        "entry": _entry(password_hash),
        "limited": False,
        "row": SimpleNamespace(password_hash=password_hash),
        "state": "active",
    }

    async def allow(*_args, **_kwargs):
        return True, 0

    async def unlock_limits(_rules, **_kwargs):
        return (False, 120) if state["limited"] else (True, 0)

    async def record_click(**kwargs):
        state["clicks"].append(kwargs["url_id"])

    async def cache_get(_code):
        return state["entry"]

    async def consume_visit(_session, url_id, *, count):
        state["consume"].append((url_id, count))
        return state["allow"]

    async def resolve_public(_session, _code):
        return state["row"], state["state"]

    monkeypatch.setattr(redirect_routes.ratelimit, "check_rate_limit", allow)
    monkeypatch.setattr(redirect_routes.ratelimit, "check_rate_limits", unlock_limits)
    monkeypatch.setattr(redirect_routes.analytics_service, "record_click", record_click)
    monkeypatch.setattr(redirect_routes, "_cache_get", cache_get)
    monkeypatch.setattr(links_service, "consume_visit", consume_visit)
    monkeypatch.setattr(links_service, "resolve_public", resolve_public)
    app.dependency_overrides[deps.get_api_session] = _no_session
    yield state
    app.dependency_overrides.pop(deps.get_api_session, None)


async def _request(method: str, path: str, *, cookies=None, data=None, json=None, **headers):
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test", cookies=cookies) as client:
        return await client.request(method, path, headers=headers, data=data, json=json)


def _cookie(state: dict, code: str = "offer1", ttl: int = 3600) -> dict:
    tag = link_password_tag(state["hash"])
    return {redirect_routes.UNLOCK_COOKIE: link_unlock_token(code, tag, int(time.time()) + ttl)}


@pytest.mark.asyncio
async def test_browsers_get_a_password_page_and_api_clients_a_401(harness) -> None:
    page = await _request("GET", "/offer1", accept="text/html", **{"user-agent": CHROME})
    api = await _request("GET", "/offer1", accept="application/json")

    assert page.status_code == 401
    assert '<form method="post" action="/offer1">' in page.text
    assert "form-action 'self'" in page.headers["content-security-policy"]
    assert api.status_code == 401
    assert api.json()["code"] == "password_required"
    for response in (page, api):
        assert "location" not in response.headers
        assert "secret-plans" not in response.text
    assert harness["clicks"] == []


@pytest.mark.asyncio
async def test_preview_head_and_unfurlers_never_see_the_destination(harness) -> None:
    preview = await _request("GET", "/offer1+")
    head = await _request("HEAD", "/offer1")
    bot = await _request("GET", "/offer1", **{"user-agent": SLACK})
    unlocked_preview = await _request("GET", "/offer1+", cookies=_cookie(harness))

    assert preview.status_code == 200 and "password protected" in preview.text
    assert head.status_code == 401
    assert bot.status_code == 401
    for response in (preview, head, bot, unlocked_preview):
        assert "secret-plans" not in response.text
        assert "location" not in response.headers
    assert harness["clicks"] == []


@pytest.mark.asyncio
async def test_a_valid_cookie_redirects_and_counts_once(harness) -> None:
    harness["entry"] = _entry(harness["hash"], max_clicks=3)

    response = await _request("GET", "/offer1", cookies=_cookie(harness), **{"user-agent": CHROME})
    head = await _request("HEAD", "/offer1", cookies=_cookie(harness))

    assert response.status_code == 302
    assert response.headers["location"] == DESTINATION
    assert head.headers["location"] == DESTINATION
    assert harness["clicks"] == [9]
    assert harness["consume"] == [(9, True), (9, False)]


@pytest.mark.asyncio
async def test_cookies_for_another_link_or_an_old_password_do_not_unlock(harness) -> None:
    other = await _request("GET", "/offer1", cookies=_cookie(harness, code="other"))
    harness["entry"] = _entry(generate_password_hash("changed"))
    stale = await _request("GET", "/offer1", cookies=_cookie(harness))

    assert other.status_code == stale.status_code == 401


@pytest.mark.asyncio
async def test_locked_links_check_but_do_not_spend_visits(harness) -> None:
    harness["entry"] = _entry(harness["hash"], max_clicks=1)

    locked = await _request("GET", "/offer1", **{"user-agent": CHROME})
    harness["allow"] = False
    used_up = await _request("GET", "/offer1", accept="application/json")

    assert locked.status_code == 401
    assert used_up.status_code == 410
    assert used_up.json()["code"] == "link_exhausted"
    assert harness["consume"] == [(9, False), (9, False)]


@pytest.mark.asyncio
async def test_fallbacks_need_no_password(harness) -> None:
    harness["entry"] = _entry(
        harness["hash"], expires_at="2020-01-01T00:00:00+00:00", fallback_url="https://example.com/"
    )

    response = await _request("GET", "/offer1", **{"user-agent": CHROME})

    assert response.status_code == 302
    assert response.headers["location"] == "https://example.com/"


@pytest.mark.asyncio
async def test_wrong_password_shows_the_form_again(harness) -> None:
    page = await _request("POST", "/offer1", data={"password": "nope"}, accept="text/html")
    api = await _request("POST", "/offer1", json={"password": "nope"})

    assert page.status_code == 401
    assert "That password is not right." in page.text
    assert 'aria-invalid="true"' in page.text
    assert "set-cookie" not in page.headers
    assert api.status_code == 401
    assert api.json()["code"] == "invalid_password"


@pytest.mark.asyncio
async def test_right_password_sets_a_scoped_cookie_then_redirects(harness, monkeypatch) -> None:
    monkeypatch.setattr(redirect_routes, "_cookie_secure", lambda: True)

    response = await _request("POST", "/offer1", data={"password": PASSWORD}, accept="text/html")

    assert response.status_code == 303
    assert response.headers["location"] == "/offer1"
    cookie = response.headers["set-cookie"]
    assert cookie.startswith(f"{redirect_routes.UNLOCK_COOKIE}=")
    for attribute in ("HttpOnly", "Secure", "Path=/offer1", "Max-Age=43200", "SameSite=lax"):
        assert attribute in cookie
    assert PASSWORD not in cookie and harness["hash"] not in cookie
    assert harness["clicks"] == []

    token = cookie.split(";")[0].split("=", 1)[1]
    follow = await _request(
        "GET",
        "/offer1",
        cookies={redirect_routes.UNLOCK_COOKIE: token},
        **{"user-agent": CHROME},
    )
    assert follow.status_code == 302
    assert follow.headers["location"] == DESTINATION
    assert harness["clicks"] == [9]


@pytest.mark.asyncio
async def test_unlock_attempts_are_rate_limited(harness) -> None:
    harness["limited"] = True

    page = await _request("POST", "/offer1", data={"password": PASSWORD}, accept="text/html")
    api = await _request("POST", "/offer1", json={"password": PASSWORD})

    assert page.status_code == 429
    assert "Too many attempts" in page.text
    assert page.headers["retry-after"] == "120"
    assert api.status_code == 429
    assert "set-cookie" not in page.headers


@pytest.mark.asyncio
async def test_unlock_limits_are_per_visitor_link_and_per_link(monkeypatch) -> None:
    seen: list = []

    async def capture(rules, **kwargs):
        seen.append((rules, kwargs))
        return False, 60

    monkeypatch.setattr(redirect_routes.ratelimit, "check_rate_limits", capture)
    app.dependency_overrides[deps.get_api_session] = _no_session
    try:
        await _request("POST", "/offer1", json={"password": "x"}, **{"x-forwarded-for": "1.2.3.4"})
    finally:
        app.dependency_overrides.pop(deps.get_api_session, None)

    rules, kwargs = seen[0]
    assert rules == [("unlock:1.2.3.4:offer1", 10, 300), ("unlock-link:offer1", 100, 3600)]
    assert kwargs.get("fail_open", False) is False


@pytest.mark.asyncio
async def test_unprotected_links_just_redirect_after_a_post(harness) -> None:
    harness["row"] = SimpleNamespace(password_hash=None)

    response = await _request("POST", "/offer1", data={"password": "anything"})

    assert response.status_code == 303
    assert response.headers["location"] == "/offer1"
    assert "set-cookie" not in response.headers


@pytest.mark.asyncio
async def test_public_metadata_hides_protected_destinations(monkeypatch) -> None:
    row = SimpleNamespace(password_hash=_hash(), id=1)

    async def public(_session, _code, _token):
        return row

    monkeypatch.setattr(links_service, "get_public_url", public)
    app.dependency_overrides[deps.get_api_session] = _no_session
    try:
        response = await _request("GET", "/api/v1/links/offer1")
    finally:
        app.dependency_overrides.pop(deps.get_api_session, None)

    assert response.status_code == 401
    assert response.json()["code"] == "password_required"
    assert "secret-plans" not in response.text


def test_metadata_reports_only_whether_a_password_is_set() -> None:
    from datetime import UTC, datetime

    from backend.api.routes.links import _serialize

    now = datetime.now(UTC)
    url = Url(
        id=1,
        short_code="vault",
        long_url=DESTINATION,
        workspace_id=uuid.uuid4(),
        is_custom_alias=True,
        is_active=True,
        created_at=now,
        updated_at=now,
        password_hash=_hash(),
    )
    body = _serialize(url)
    assert body["has_password"] is True
    assert "password_hash" not in body and "password" not in body
    assert "$argon2" not in str(body)
