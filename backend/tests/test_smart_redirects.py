"""Smart redirects: visitor traits, rule validation and matching, and the redirect."""

from datetime import UTC, datetime

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import text

from backend.api import deps
from backend.api.routes import redirect as redirect_routes
from backend.api.routes.links import _serialize
from backend.core.problems import APIError
from backend.main import app
from backend.models import Url, Workspace
from backend.services import links as links_service
from backend.services.analytics import visitor_traits
from backend.services.smart_redirects import matches, pick, validate_rules

IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile Safari"
IPAD = "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Safari"
ANDROID = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/140.0 Mobile Safari"
ANDROID_TABLET = "Mozilla/5.0 (Linux; Android 15; SM-X910) AppleWebKit/537.36 Chrome/140.0 Safari"
DESKTOP = "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/140.0 Safari/537.36"
SLACK = "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)"
DEFAULT = "https://example.com/"
IOS_URL = "https://apps.apple.com/app/id1"
ANDROID_URL = "https://play.google.com/store/apps/details?id=x"
GERMANY_URL = "https://example.de/"


def _same(url: str) -> str:
    if not url.startswith("https://"):
        raise APIError(422, "invalid_url", "The destination must use https.")
    return url


RULES = [
    {"devices": ["ios"], "url": IOS_URL},
    {"devices": ["android"], "url": ANDROID_URL},
    {"countries": ["DE", "AT"], "url": GERMANY_URL},
]


def test_visitor_traits_add_platforms_to_device_classes() -> None:
    assert visitor_traits(IPHONE, None) == (frozenset({"mobile", "ios"}), None)
    assert visitor_traits(IPAD, None)[0] == {"tablet", "ios"}
    assert visitor_traits(ANDROID, None)[0] == {"mobile", "android"}
    assert visitor_traits(ANDROID_TABLET, None)[0] == {"tablet", "android"}
    assert visitor_traits(DESKTOP, "de") == (frozenset({"desktop"}), "DE")
    assert visitor_traits(SLACK, "DE") == (frozenset(), "DE")
    assert visitor_traits(None, "XYZ") == (frozenset(), None)
    assert visitor_traits(DESKTOP, "1A")[1] is None


def test_rules_are_normalized() -> None:
    cleaned = validate_rules(
        [{"devices": ["desktop", "ios", "ios"], "countries": [" de", "at", "DE"], "url": DEFAULT}],
        _same,
    )
    assert cleaned == [{"url": DEFAULT, "devices": ["ios", "desktop"], "countries": ["AT", "DE"]}]
    assert validate_rules([], _same) is None
    assert validate_rules(None, _same) is None


@pytest.mark.parametrize(
    ("rules", "field", "fragment"),
    [
        ([{"devices": ["ios"], "url": DEFAULT}] * 11, "redirect_rules", "at most 10"),
        ([{"devices": ["watch"], "url": DEFAULT}], "redirect_rules.0.devices", "unknown device"),
        ([{"countries": ["GER"], "url": DEFAULT}], "redirect_rules.0.countries", "two-letter"),
        ([{"url": DEFAULT}], "redirect_rules.0", "at least one device or country"),
        ([{"devices": [], "countries": [], "url": DEFAULT}], "redirect_rules.0", "at least one"),
        (
            [{"devices": ["ios"], "url": DEFAULT}, {"devices": ["ios"], "url": "http://x.test/"}],
            "redirect_rules.1.url",
            "Rule 2: The destination must use https.",
        ),
    ],
)
def test_bad_rules_name_the_field(rules, field, fragment) -> None:
    with pytest.raises(APIError) as caught:
        validate_rules(rules, _same)
    assert caught.value.status == 422
    assert caught.value.errors[0]["field"] == field
    assert fragment in caught.value.detail


def test_every_condition_must_match_and_the_first_rule_wins() -> None:
    both = {"devices": ["mobile"], "countries": ["DE"], "url": GERMANY_URL}
    assert matches(both, frozenset({"mobile", "ios"}), "DE")
    assert not matches(both, frozenset({"mobile"}), "FR")
    assert not matches(both, frozenset({"desktop"}), "DE")
    assert pick(RULES, IPHONE, "DE") == IOS_URL
    assert pick(RULES, DESKTOP, "AT") == GERMANY_URL
    assert pick(RULES, DESKTOP, "FR") is None
    assert pick(RULES, None, None) is None


def test_entries_and_metadata_carry_rules_only_when_set() -> None:
    now = datetime.now(UTC)
    url = Url(
        id=1,
        short_code="smart",
        long_url=DEFAULT,
        is_custom_alias=True,
        is_active=True,
        created_at=now,
        updated_at=now,
    )
    assert "rules" not in redirect_routes.entry_for(url)
    assert _serialize(url)["redirect_rules"] == []
    url.redirect_rules = RULES
    assert redirect_routes.entry_for(url)["rules"] == RULES
    assert _serialize(url)["redirect_rules"] == RULES


def test_rules_join_the_idempotency_fingerprint() -> None:
    plain = links_service._canonical_request(DEFAULT, None, None, [])
    smart = links_service._canonical_request(
        DEFAULT, None, None, [], None, None, None, [{"devices": ["ios"], "url": IOS_URL}]
    )
    assert b"redirect_rules" not in plain
    assert plain != smart
    assert links_service._canonical_request(DEFAULT, None, None, [], redirect_rules=[]) == plain


@pytest.mark.asyncio
async def test_set_keep_and_clear_rules(factory) -> None:
    async with factory() as session:
        workspace = Workspace(name="Team", is_personal=False)
        session.add(workspace)
        await session.flush()
        url = Url(id=601, short_code="smart", long_url=DEFAULT, workspace_id=workspace.id)
        session.add(url)
        await session.commit()

        async def update(**fields):
            defaults = {"long_url": None, "expires_at": None, "is_active": None}
            return await links_service.update_link(
                session, url, clear_expiry=False, **{**defaults, **fields}
            )

        await update(
            replace_redirect_rules=True, redirect_rules=[{"devices": ["ios"], "url": IOS_URL}]
        )
        assert url.redirect_rules == [{"url": IOS_URL, "devices": ["ios"]}]
        await update(is_active=True)
        assert url.redirect_rules == [{"url": IOS_URL, "devices": ["ios"]}]
        await update(replace_redirect_rules=True, redirect_rules=[])
        assert url.redirect_rules is None
        stored = await session.execute(
            text("SELECT redirect_rules IS NULL FROM urls WHERE id = 601")
        )
        assert stored.scalar_one() == 1


def test_no_rules_are_stored_as_sql_null_not_json_null() -> None:
    from sqlalchemy.dialects.postgresql import asyncpg

    # A JSON 'null' would violate urls_redirect_rules_array in Postgres.
    column_type = Url.__table__.c.redirect_rules.type
    assert column_type.none_as_null
    assert column_type.dialect_impl(asyncpg.dialect()).none_as_null


async def _no_session():
    yield None


@pytest.fixture
def harness(monkeypatch: pytest.MonkeyPatch):
    state: dict = {
        "clicks": [],
        "entry": {
            "url_id": 7,
            "long_url": DEFAULT,
            "expires_at": None,
            "fallback_url": None,
            "max_clicks": None,
            "rules": RULES,
        },
    }

    async def allow(*_args, **_kwargs):
        return True, 0

    async def record_click(**kwargs):
        state["clicks"].append(kwargs["url_id"])

    async def cache_get(_code):
        return state["entry"]

    monkeypatch.setattr(redirect_routes.ratelimit, "check_rate_limit", allow)
    monkeypatch.setattr(redirect_routes.analytics_service, "record_click", record_click)
    monkeypatch.setattr(redirect_routes, "_cache_get", cache_get)
    app.dependency_overrides[deps.get_api_session] = _no_session
    yield state
    app.dependency_overrides.pop(deps.get_api_session, None)


async def _request(method: str, path: str, **headers):
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        return await client.request(method, path, headers=headers)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("user_agent", "country", "expected"),
    [
        (IPHONE, None, IOS_URL),
        (ANDROID_TABLET, "DE", ANDROID_URL),
        (DESKTOP, "AT", GERMANY_URL),
        (DESKTOP, "US", DEFAULT),
        (SLACK, "DE", DEFAULT),
        (None, None, DEFAULT),
    ],
)
async def test_redirect_follows_the_first_matching_rule(
    harness, user_agent, country, expected
) -> None:
    headers = {}
    if user_agent:
        headers["user-agent"] = user_agent
    if country:
        headers["x-vercel-ip-country"] = country

    response = await _request("GET", "/smart", **headers)
    head = await _request("HEAD", "/smart", **headers)

    assert response.status_code == 302
    assert response.headers["location"] == expected
    assert head.headers["location"] == expected
    assert harness["clicks"] == [7]


@pytest.mark.asyncio
async def test_expired_links_use_the_fallback_not_the_rules(harness) -> None:
    harness["entry"] = {
        **harness["entry"],
        "expires_at": "2020-01-01T00:00:00+00:00",
        "fallback_url": "https://example.com/ended",
    }

    response = await _request("GET", "/smart", **{"user-agent": IPHONE})
    preview = await _request("GET", "/smart+", **{"user-agent": IPHONE})

    assert response.headers["location"] == "https://example.com/ended"
    assert "different pages" not in preview.text


@pytest.mark.asyncio
async def test_preview_shows_this_visitors_destination_and_that_it_varies(harness) -> None:
    phone = await _request("GET", "/smart+", **{"user-agent": IPHONE})
    desktop = await _request("GET", "/smart+", **{"user-agent": DESKTOP})
    harness["entry"] = {**harness["entry"], "rules": None}
    plain = await _request("GET", "/smart+", **{"user-agent": IPHONE})

    assert "apps.apple.com" in phone.text
    assert "different pages depending on their device or country" in phone.text
    assert "apps.apple.com" not in desktop.text and "example.com" in desktop.text
    assert "different pages" not in plain.text
