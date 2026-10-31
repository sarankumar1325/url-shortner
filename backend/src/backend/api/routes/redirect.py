import json
import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, Request, Response
from sqlalchemy.ext.asyncio import AsyncSession

from backend.api.deps import get_api_session
from backend.core.config import get_settings
from backend.core.problems import APIError
from backend.core.redis import RedisError, command
from backend.services import analytics as analytics_service
from backend.services import links as links_service
from backend.services import ratelimit, visitor_pages

router = APIRouter(tags=["redirects"])

CACHE_PREFIX = "redir:"


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


async def resolve_redirect(code: str, session: AsyncSession) -> dict:
    """Positive cache of {url_id, long_url, expires_at}. Entries are only
    written for live links; mutations may take up to the cache TTL to land."""
    cached = await _cache_get(code)
    if cached is not None:
        if cached.get("expires_at") and datetime.fromisoformat(
            cached["expires_at"]
        ) <= datetime.now(UTC):
            raise APIError(410, "link_expired", "This link has expired.")
        return cached

    url, state = await links_service.resolve_public(session, code)
    if state == "expired":
        raise APIError(410, "link_expired", "This link has expired.")
    entry = {
        "url_id": url.id,
        "long_url": url.long_url,
        "expires_at": url.expires_at.isoformat() if url.expires_at else None,
    }
    await _cache_set(code, entry)
    return entry


def _wants_html(request: Request) -> bool:
    return "text/html" in request.headers.get("accept", "").lower()


async def _enforce_redirect_limit(request: Request) -> None:
    allowed, retry_after = await ratelimit.check_rate_limit(
        f"redirect:{_client_ip(request)}", 600, fail_open=True
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
    except APIError as exc:
        if exc.status in (404, 410):
            return visitor_pages.unavailable_response(code, exc.status)
        raise
    return visitor_pages.preview_response(code, entry["long_url"], entry.get("expires_at"))


@router.get("/{code}", summary="Redirect to the destination")
async def redirect(
    code: str,
    request: Request,
    session: AsyncSession = Depends(get_api_session),
) -> Response:
    await _enforce_redirect_limit(request)

    try:
        entry = await resolve_redirect(code, session)
    except APIError as exc:
        if exc.status in (404, 410) and _wants_html(request):
            return visitor_pages.unavailable_response(code, exc.status)
        raise

    await analytics_service.record_click(
        url_id=entry["url_id"],
        event_id=uuid.uuid4(),
        clicked_at=datetime.now(UTC),
        referer=request.headers.get("referer"),
        country=request.headers.get("x-vercel-ip-country"),
        user_agent=request.headers.get("user-agent"),
    )

    return Response(
        status_code=302,
        headers={
            "Location": entry["long_url"],
            "Cache-Control": "no-store",
            "X-Robots-Tag": "noindex, nofollow",
            "Referrer-Policy": "no-referrer",
        },
    )


@router.head("/{code}", summary="Resolve without recording a click")
async def redirect_head(
    code: str,
    session: AsyncSession = Depends(get_api_session),
) -> Response:
    entry = await resolve_redirect(code, session)
    return Response(
        status_code=302,
        headers={
            "Location": entry["long_url"],
            "Cache-Control": "no-store",
            "X-Robots-Tag": "noindex, nofollow",
            "Referrer-Policy": "no-referrer",
        },
    )
