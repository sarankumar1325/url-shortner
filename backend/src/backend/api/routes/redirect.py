import json
import time
import uuid
from datetime import UTC, datetime
from urllib.parse import parse_qs, quote

from fastapi import APIRouter, Depends, Request, Response
from sqlalchemy.ext.asyncio import AsyncSession

from backend.api.deps import _cookie_secure, get_api_session
from backend.core import metrics
from backend.core.config import get_settings
from backend.core.problems import APIError
from backend.core.redis import RedisError, command, pipeline
from backend.core.security import (
    link_password_tag,
    link_unlock_token,
    verify_link_unlock,
    verify_password,
)
from backend.core.singleflight import SingleFlight
from backend.models import Url
from backend.services import analytics as analytics_service
from backend.services import links as links_service
from backend.services import ratelimit, smart_redirects, visitor_pages

router = APIRouter(tags=["redirects"])

CACHE_PREFIX = "redir:"
REDIRECT_LIMIT = 600
REDIRECT_WINDOW_SECONDS = 60
UNLOCK_COOKIE = "shortly_unlock"
UNLOCK_TTL_SECONDS = 12 * 60 * 60
# Per visitor and link, then per link across all visitors.
UNLOCK_VISITOR_LIMIT = (10, 5 * 60)
UNLOCK_LINK_LIMIT = (100, 60 * 60)
MAX_UNLOCK_BODY_BYTES = 4096
REDIRECT_HEADERS = {
    "Cache-Control": "no-store",
    "X-Robots-Tag": "noindex, nofollow",
    "Referrer-Policy": "no-referrer",
}

cache_fills = SingleFlight()


def _client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


async def _cache_get(code: str) -> dict | None:
    try:
        raw = await command("GET", f"{CACHE_PREFIX}{code}")
    except RedisError:
        return None
    if raw is None:
        return None
    try:
        return json.loads(raw)
    except (TypeError, ValueError):
        return None


async def _cache_set(code: str, entry: dict) -> None:
    try:
        await command(
            "SETEX",
            f"{CACHE_PREFIX}{code}",
            get_settings().redirect_cache_seconds,
            json.dumps(entry, separators=(",", ":")),
        )
    except RedisError:
        pass


async def invalidate_cache(code: str) -> None:
    try:
        await command("DEL", f"{CACHE_PREFIX}{code}")
    except RedisError:
        pass


async def invalidate_caches(codes: list[str], batch: int = 200) -> None:
    """Evict many cached redirects in one round trip per batch of keys."""
    for start in range(0, len(codes), batch):
        keys = [f"{CACHE_PREFIX}{code}" for code in codes[start : start + batch]]
        try:
            await pipeline([["DEL", *keys]])
        except RedisError:
            # Entries expire on their own within redirect_cache_seconds.
            return


def fallback_or_gone(entry: dict, code: str, detail: str) -> dict:
    """Send visitors to the fallback destination, or answer 410 without one."""
    if entry.get("fallback_url"):
        return {**entry, "long_url": entry["fallback_url"], "via_fallback": True}
    raise APIError(410, code, detail)


def _expired(entry: dict) -> bool:
    expires_at = entry.get("expires_at")
    return bool(expires_at) and datetime.fromisoformat(expires_at) <= datetime.now(UTC)


def entry_for(url: Url) -> dict:
    """The cached redirect entry. Password links carry a tag, never the hash."""
    entry = {
        "url_id": url.id,
        "long_url": url.long_url,
        "expires_at": url.expires_at.isoformat() if url.expires_at else None,
        "fallback_url": url.fallback_url,
        "max_clicks": url.max_clicks,
    }
    if url.password_hash is not None:
        entry["protected"] = True
        entry["password_tag"] = link_password_tag(url.password_hash)
    if url.redirect_rules:
        entry["rules"] = url.redirect_rules
    return entry


async def _load_entry(code: str, session: AsyncSession) -> dict:
    url, state = await links_service.resolve_public(session, code)
    entry = entry_for(url)
    if state != "expired":
        await _cache_set(code, entry)
    return entry


async def resolve_redirect(code: str, session: AsyncSession) -> dict:
    """Positive cache of {url_id, long_url, expires_at, fallback_url, max_clicks}
    plus {protected, password_tag} for password links and {rules} for smart
    redirects.

    Entries are only written for live links; mutations may take up to the
    cache TTL to land. Concurrent misses for one code share a single Postgres
    load. Visit limits are enforced separately against Postgres.
    """
    entry = await _cache_get(code)
    if entry is not None:
        metrics.incr("redirect.cache_hit")
    else:
        metrics.incr("redirect.cache_miss")
        entry = await cache_fills.do(code, lambda: _load_entry(code, session))
    if _expired(entry):
        return fallback_or_gone(entry, "link_expired", "This link has expired.")
    return entry


async def apply_visit_limit(entry: dict, code: str, session: AsyncSession, *, count: bool) -> dict:
    if not entry.get("max_clicks") or entry.get("via_fallback"):
        return entry
    if await links_service.consume_visit(session, entry["url_id"], count=count):
        return entry
    return fallback_or_gone(entry, "link_exhausted", "This link has reached its visit limit.")


def _locked(entry: dict) -> bool:
    # A fallback is where the owner sends people after the link ends; it is
    # not the protected destination, so it needs no password.
    return bool(entry.get("protected")) and not entry.get("via_fallback")


def is_unlocked(entry: dict, code: str, request: Request) -> bool:
    if not _locked(entry):
        return True
    return verify_link_unlock(
        request.cookies.get(UNLOCK_COOKIE), code, entry["password_tag"], int(time.time())
    )


async def guard_visit(
    entry: dict, code: str, session: AsyncSession, *, unlocked: bool, count: bool
) -> dict | None:
    """Apply the visit limit, or return None while the password is still needed.

    A locked link only has its limit checked, so a used-up link says so (or
    goes to its fallback) instead of asking for a password, and nothing is
    counted until the visitor unlocks it.
    """
    if _locked(entry) and not unlocked:
        checked = await apply_visit_limit(entry, code, session, count=False)
        return checked if checked.get("via_fallback") else None
    return await apply_visit_limit(entry, code, session, count=count)


def destination_for(entry: dict, request: Request) -> str:
    """Where this visitor goes: the first matching rule, else the main destination.

    Rules only apply while the link is live, and link unfurlers always get the
    main destination so chat previews stay the same for everyone.
    """
    rules = entry.get("rules")
    user_agent = request.headers.get("user-agent")
    if not rules or entry.get("via_fallback") or links_service.is_link_previewer(user_agent):
        return entry["long_url"]
    matched = smart_redirects.pick(rules, user_agent, request.headers.get("x-vercel-ip-country"))
    return matched or entry["long_url"]


def _wants_html(request: Request) -> bool:
    return "text/html" in request.headers.get("accept", "").lower()


async def _enforce_redirect_limit(request: Request) -> None:
    allowed, retry_after = await ratelimit.check_rate_limit(
        f"redirect:{_client_ip(request)}",
        REDIRECT_LIMIT,
        REDIRECT_WINDOW_SECONDS,
        fail_open=True,
    )
    if not allowed:
        raise APIError(
            429, "rate_limited", "Too many requests.", headers={"Retry-After": str(retry_after)}
        )


# Registered before /{code}: that pattern would otherwise match "abc12+" too.
@router.get("/{code}+", summary="Preview the destination without visiting it")
async def preview(
    code: str,
    request: Request,
    session: AsyncSession = Depends(get_api_session),
) -> Response:
    await _enforce_redirect_limit(request)
    try:
        entry = await resolve_redirect(code, session)
        # Previews never reveal a protected destination, even when unlocked.
        entry = await guard_visit(entry, code, session, unlocked=False, count=False)
    except APIError as exc:
        if exc.status in (404, 410):
            return visitor_pages.unavailable_response(code, exc.status, exc.code)
        raise
    if entry is None:
        return visitor_pages.protected_preview_response(code)
    return visitor_pages.preview_response(
        code,
        destination_for(entry, request),
        entry.get("expires_at"),
        via_fallback=bool(entry.get("via_fallback")),
        limited=bool(entry.get("max_clicks")),
        varies=bool(entry.get("rules")) and not entry.get("via_fallback"),
    )


def _password_required(code: str, request: Request) -> Response:
    if _wants_html(request):
        return visitor_pages.password_page(code)
    raise APIError(401, "password_required", "This link is password protected.")


@router.get("/{code}", summary="Redirect to the destination")
async def redirect(
    code: str,
    request: Request,
    session: AsyncSession = Depends(get_api_session),
) -> Response:
    await _enforce_redirect_limit(request)

    user_agent = request.headers.get("user-agent")
    try:
        entry = await resolve_redirect(code, session)
        entry = await guard_visit(
            entry,
            code,
            session,
            unlocked=is_unlocked(entry, code, request),
            count=not links_service.is_link_previewer(user_agent),
        )
        if entry is None:
            return _password_required(code, request)
    except APIError as exc:
        if exc.status in (404, 410) and _wants_html(request):
            return visitor_pages.unavailable_response(code, exc.status, exc.code)
        raise

    await analytics_service.record_click(
        url_id=entry["url_id"],
        event_id=uuid.uuid4(),
        clicked_at=datetime.now(UTC),
        referer=request.headers.get("referer"),
        country=request.headers.get("x-vercel-ip-country"),
        user_agent=user_agent,
    )

    return Response(
        status_code=302,
        headers={"Location": destination_for(entry, request), **REDIRECT_HEADERS},
    )


@router.head("/{code}", summary="Resolve without recording a click")
async def redirect_head(
    code: str,
    request: Request,
    session: AsyncSession = Depends(get_api_session),
) -> Response:
    entry = await resolve_redirect(code, session)
    entry = await guard_visit(
        entry, code, session, unlocked=is_unlocked(entry, code, request), count=False
    )
    if entry is None:
        return Response(status_code=401, headers=REDIRECT_HEADERS)
    return Response(
        status_code=302,
        headers={"Location": destination_for(entry, request), **REDIRECT_HEADERS},
    )


async def _submitted_password(request: Request) -> str:
    body = await request.body()
    if len(body) > MAX_UNLOCK_BODY_BYTES:
        raise APIError(413, "payload_too_large", "Request body is too large.")
    content_type = request.headers.get("content-type", "").split(";")[0].strip().lower()
    if content_type == "application/json":
        try:
            value = json.loads(body or b"{}").get("password")
        except (ValueError, AttributeError):
            value = None
    else:
        value = (parse_qs(body.decode("utf-8", "replace")).get("password") or [None])[0]
    return value if isinstance(value, str) else ""


@router.post("/{code}", summary="Unlock a password-protected link")
async def unlock(
    code: str,
    request: Request,
    session: AsyncSession = Depends(get_api_session),
) -> Response:
    html = _wants_html(request)
    password = await _submitted_password(request)
    visitor_limit, visitor_window = UNLOCK_VISITOR_LIMIT
    link_limit, link_window = UNLOCK_LINK_LIMIT
    allowed, retry_after = await ratelimit.check_rate_limits(
        [
            (f"unlock:{_client_ip(request)}:{code}", visitor_limit, visitor_window),
            (f"unlock-link:{code}", link_limit, link_window),
        ]
    )
    if not allowed:
        headers = {"Retry-After": str(retry_after)}
        if html:
            minutes = max(1, round(retry_after / 60))
            return visitor_pages.password_page(
                code,
                error=f"Too many attempts. Try again in {minutes} minute"
                f"{'' if minutes == 1 else 's'}.",
                status=429,
                headers=headers,
            )
        raise APIError(429, "rate_limited", "Too many attempts.", headers=headers)

    try:
        url, state = await links_service.resolve_public(session, code)
    except APIError as exc:
        if exc.status == 404 and html:
            return visitor_pages.unavailable_response(code, exc.status, exc.code)
        raise
    target = f"/{quote(code, safe='')}"
    if state == "expired" or url.password_hash is None:
        # Nothing to unlock; the redirect handles expiry and fallbacks.
        return Response(status_code=303, headers={"Location": target, **REDIRECT_HEADERS})
    if not password or not verify_password(password, url.password_hash):
        if html:
            return visitor_pages.password_page(code, error="That password is not right.")
        raise APIError(401, "invalid_password", "The password is not right.")

    token = link_unlock_token(
        code, link_password_tag(url.password_hash), int(time.time()) + UNLOCK_TTL_SECONDS
    )
    response = Response(status_code=303, headers={"Location": target, **REDIRECT_HEADERS})
    response.set_cookie(
        UNLOCK_COOKIE,
        token,
        max_age=UNLOCK_TTL_SECONDS,
        path=target,
        httponly=True,
        secure=_cookie_secure(),
        samesite="lax",
    )
    return response
