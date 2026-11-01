from datetime import UTC, date, datetime, timedelta
from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Header, Query, Request
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, ConfigDict, Field, StringConstraints
from sqlalchemy.ext.asyncio import AsyncSession

from backend.api.deps import (
    WorkspaceContext,
    client_ip,
    enforce_same_origin,
    get_api_session,
    get_optional_workspace_context,
    get_workspace_context,
    require_idempotency_key,
    validate_body_size,
)
from backend.api.routes.redirect import invalidate_cache, invalidate_caches
from backend.core.config import get_settings
from backend.core.problems import APIError
from backend.services import leaderboard, ratelimit
from backend.services import links as links_service
from backend.services.validation import normalize_tag
from backend.services.workspaces import require_role

router = APIRouter(prefix="/links", tags=["links"])

CREATE_LIMIT_WORKSPACE = 60
CREATE_LIMIT_ANONYMOUS = 20
ALIAS_CHECK_LIMIT = 120
BULK_LIMIT = 30


def _iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    return value.isoformat().replace("+00:00", "Z")


def _serialize(
    url,
    token: str | None = None,
    clicks_30d: int | None = None,
    tags: list[str] | None = None,
) -> dict:
    settings = get_settings()
    body = {
        "short_code": url.short_code,
        "short_url": f"{settings.short_base_url.rstrip('/')}/{url.short_code}",
        "long_url": url.long_url,
        "is_custom_alias": url.is_custom_alias,
        "is_active": url.is_active,
        "expires_at": _iso(url.expires_at),
        "created_at": _iso(url.created_at),
        "updated_at": _iso(url.updated_at),
        "tags": tags or [],
        "fallback_url": url.fallback_url,
        "max_clicks": url.max_clicks,
        "clicks_used": url.clicks_used or 0,
        "has_password": url.password_hash is not None,
        "redirect_rules": url.redirect_rules or [],
    }
    if token is not None:
        body["management_token"] = token
    if clicks_30d is not None:
        body["clicks_30d"] = clicks_30d
    return body


def _utc(value: datetime | None) -> datetime | None:
    return value.astimezone(UTC) if value is not None and value.tzinfo else value


class RedirectRule(BaseModel):
    model_config = ConfigDict(extra="forbid")

    devices: list[str] | None = None
    countries: list[str] | None = None
    url: str


def _rules(rules: list[RedirectRule] | None) -> list[dict] | None:
    return [rule.model_dump(exclude_none=True) for rule in rules] if rules else None


class CreateLinkRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    long_url: str
    custom_alias: str | None = None
    expires_at: datetime | None = None
    tags: list[str] | None = None
    fallback_url: str | None = None
    max_clicks: int | None = None
    password: str | None = None
    redirect_rules: list[RedirectRule] | None = None


class UpdateLinkRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    long_url: str | None = None
    expires_at: datetime | None = None
    is_active: bool | None = None
    tags: list[str] | None = None
    fallback_url: str | None = None
    max_clicks: int | None = None
    # Omit to keep the current password; null removes it.
    password: str | None = None
    # Omit to keep the rules; null or [] removes them all.
    redirect_rules: list[RedirectRule] | None = None


@router.post(
    "",
    status_code=201,
    summary="Create a short link",
    dependencies=[Depends(validate_body_size), Depends(enforce_same_origin)],
)
async def create_link(
    payload: CreateLinkRequest,
    request: Request,
    session: AsyncSession = Depends(get_api_session),
    idempotency_key: UUID = Depends(require_idempotency_key),
    context: WorkspaceContext | None = Depends(get_optional_workspace_context),
) -> JSONResponse:
    if context is not None:
        require_role(context.role, "member")
        limit_key = f"create-user:{context.workspace.id}"
        limit = CREATE_LIMIT_WORKSPACE
    else:
        limit_key = f"create:{client_ip(request)}"
        limit = CREATE_LIMIT_ANONYMOUS
    allowed, retry_after = await ratelimit.check_rate_limit(limit_key, limit)
    if not allowed:
        raise APIError(
            429, "rate_limited", "Too many requests.", headers={"Retry-After": str(retry_after)}
        )

    response = await links_service.create_link(
        session,
        idempotency_key=idempotency_key,
        long_url=payload.long_url,
        custom_alias=payload.custom_alias,
        expires_at=_utc(payload.expires_at),
        response_builder=_serialize,
        workspace_id=context.workspace.id if context else None,
        created_by_user_id=context.user.id if context else None,
        tags=payload.tags,
        fallback_url=payload.fallback_url,
        max_clicks=payload.max_clicks,
        password=payload.password,
        redirect_rules=_rules(payload.redirect_rules),
    )
    return JSONResponse(
        status_code=201,
        content=response,
        headers={
            "Location": f"{get_settings().api_prefix}/links/{response['short_code']}",
        },
    )


@router.get("", summary="List links in the active workspace")
async def list_links(
    limit: int = Query(default=50, ge=1, le=200),
    tag: str | None = Query(default=None, max_length=24),
    session: AsyncSession = Depends(get_api_session),
    context: WorkspaceContext = Depends(get_workspace_context),
) -> dict:
    normalized = normalize_tag(tag) if tag is not None else None
    rows = await links_service.list_workspace_links(
        session, context.workspace.id, limit, normalized
    )
    tags = await links_service.tags_for(session, [url.id for url, _ in rows])
    return {
        "links": [
            _serialize(url, clicks_30d=total, tags=tags.get(url.id, [])) for url, total in rows
        ],
        "total": len(rows),
        "workspace_id": str(context.workspace.id),
        "role": context.role,
    }


@router.get("/availability", summary="Check whether a custom alias is free")
async def alias_availability(
    request: Request,
    alias: str = Query(min_length=1, max_length=64),
    session: AsyncSession = Depends(get_api_session),
) -> dict:
    allowed, retry_after = await ratelimit.check_rate_limit(
        f"alias-check:{client_ip(request)}", ALIAS_CHECK_LIMIT, fail_open=True
    )
    if not allowed:
        raise APIError(
            429, "rate_limited", "Too many requests.", headers={"Retry-After": str(retry_after)}
        )
    return await links_service.alias_availability(session, alias)


@router.get("/top", summary="Most-clicked links in the active workspace (cached)")
async def top_links(
    days: int = Query(default=7),
    limit: int = Query(default=5, ge=1, le=10),
    session: AsyncSession = Depends(get_api_session),
    context: WorkspaceContext = Depends(get_workspace_context),
) -> dict:
    if days not in leaderboard.ALLOWED_DAYS:
        raise APIError(422, "validation_error", "days must be 1, 7 or 30.")
    return await leaderboard.top_links(session, context.workspace.id, days, limit)


class BulkLinksRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    codes: list[Annotated[str, StringConstraints(min_length=1, max_length=64)]] = Field(
        min_length=1, max_length=links_service.MAX_BULK_CODES
    )
    action: Literal["pause", "resume", "delete", "add_tags", "remove_tags"]
    tags: list[str] | None = None


@router.post(
    "/bulk",
    summary="Pause, resume, delete or tag many links at once",
    dependencies=[Depends(validate_body_size), Depends(enforce_same_origin)],
)
async def bulk_links(
    payload: BulkLinksRequest,
    session: AsyncSession = Depends(get_api_session),
    context: WorkspaceContext = Depends(get_workspace_context),
) -> dict:
    require_role(context.role, "member")
    allowed, retry_after = await ratelimit.check_rate_limit(
        f"bulk:{context.workspace.id}", BULK_LIMIT
    )
    if not allowed:
        raise APIError(
            429, "rate_limited", "Too many requests.", headers={"Retry-After": str(retry_after)}
        )
    results = await links_service.bulk_update(
        session, context.workspace.id, payload.codes, payload.action, payload.tags
    )
    changed = [item["short_code"] for item in results if item["status"] == "ok"]
    if payload.action in ("pause", "resume", "delete"):
        await invalidate_caches(changed)
    return {
        "action": payload.action,
        "results": results,
        "updated": len(changed),
        "workspace_id": str(context.workspace.id),
    }


@router.get("/{code}", summary="Link metadata (workspace, token, or public)")
async def get_link(
    code: str,
    session: AsyncSession = Depends(get_api_session),
    token: str | None = Header(default=None, alias="X-Management-Token"),
    context: WorkspaceContext | None = Depends(get_optional_workspace_context),
) -> dict:
    if token is not None:
        url = await links_service.get_public_url(session, code, token)
    elif context is not None:
        url = await links_service.get_workspace_url(session, code, context.workspace.id)
    else:
        url = await links_service.get_public_url(session, code, None)
        if url.password_hash is not None:
            raise APIError(401, "password_required", "This link is password protected.")
    tags = await links_service.tags_for_url(session, url.id) if context is not None else []
    return _serialize(url, tags=tags)


@router.patch("/{code}", summary="Update a link", dependencies=[Depends(enforce_same_origin)])
async def update_link(
    code: str,
    payload: UpdateLinkRequest,
    session: AsyncSession = Depends(get_api_session),
    token: str | None = Header(default=None, alias="X-Management-Token"),
    context: WorkspaceContext | None = Depends(get_optional_workspace_context),
) -> dict:
    if not payload.model_fields_set:
        raise APIError(422, "validation_error", "At least one field is required.")
    replace_tags = "tags" in payload.model_fields_set
    if token is not None:
        if replace_tags:
            raise APIError(422, "validation_error", "Tags require a workspace.")
        url = await links_service.require_url_with_token(session, code, token)
    elif context is not None:
        require_role(context.role, "member")
        url = await links_service.get_workspace_url(session, code, context.workspace.id)
    else:
        raise APIError(401, "authentication_required", "Sign in to continue.")
    # Null expiry clears it; omitting the field preserves it. Tags follow the
    # same contract: an omitted field preserves them, null clears them.
    clear_expiry = "expires_at" in payload.model_fields_set and payload.expires_at is None
    fields = payload.model_fields_set
    url = await links_service.update_link(
        session,
        url,
        long_url=payload.long_url,
        expires_at=_utc(payload.expires_at),
        is_active=payload.is_active,
        clear_expiry=clear_expiry,
        replace_tags=replace_tags,
        tags=payload.tags,
        fallback_url=payload.fallback_url,
        clear_fallback="fallback_url" in fields and payload.fallback_url is None,
        max_clicks=payload.max_clicks,
        clear_max_clicks="max_clicks" in fields and payload.max_clicks is None,
        password=payload.password,
        clear_password="password" in fields and payload.password is None,
        redirect_rules=_rules(payload.redirect_rules),
        replace_redirect_rules="redirect_rules" in fields,
    )
    await invalidate_cache(code)
    tags = await links_service.tags_for_url(session, url.id) if context is not None else []
    return _serialize(url, tags=tags)


@router.delete(
    "/{code}",
    status_code=204,
    summary="Soft-delete a link",
    dependencies=[Depends(enforce_same_origin)],
)
async def delete_link(
    code: str,
    session: AsyncSession = Depends(get_api_session),
    token: str | None = Header(default=None, alias="X-Management-Token"),
    context: WorkspaceContext | None = Depends(get_optional_workspace_context),
) -> Response:
    if token is not None:
        url = await links_service.get_url(session, code)
        if url is not None and url.deleted_at is not None:
            # Repeatable with a valid token; an invalid one still gets 401.
            if not links_service.verify_token(token, url):
                raise APIError(401, "invalid_token", "The management token is invalid.")
            return Response(status_code=204)
        url = await links_service.require_url_with_token(session, code, token)
    elif context is not None:
        require_role(context.role, "member")
        url = await links_service.get_workspace_url(session, code, context.workspace.id)
    else:
        raise APIError(401, "authentication_required", "Sign in to continue.")
    await links_service.delete_link(session, url)
    await invalidate_cache(code)
    return Response(status_code=204)


@router.get("/{code}/analytics", summary="Click analytics")
async def link_analytics(
    code: str,
    request: Request,
    session: AsyncSession = Depends(get_api_session),
    token: str | None = Header(default=None, alias="X-Management-Token"),
    context: WorkspaceContext | None = Depends(get_optional_workspace_context),
    from_date: str | None = Query(default=None, alias="from"),
    to_date: str | None = Query(default=None, alias="to"),
    interval: str = "day",
) -> dict:
    if interval != "day":
        raise APIError(422, "validation_error", "Only interval=day is supported.")
    if token is not None:
        url = await links_service.require_url_with_token(session, code, token)
    elif context is not None:
        url = await links_service.get_workspace_url(session, code, context.workspace.id)
    else:
        raise APIError(401, "authentication_required", "Sign in to continue.")

    today = datetime.now(UTC).date()
    try:
        to_day = date.fromisoformat(to_date) if to_date else today + timedelta(days=1)
        from_day = date.fromisoformat(from_date) if from_date else to_day - timedelta(days=30)
    except ValueError:
        raise APIError(422, "validation_error", "Dates must be YYYY-MM-DD.") from None

    if from_day >= to_day or (to_day - from_day).days > 366:
        raise APIError(422, "validation_error", "Range must be 1–366 days with 'from' before 'to'.")
    if to_day > today + timedelta(days=1):
        raise APIError(422, "validation_error", "'to' may be at most tomorrow UTC.")

    from backend.services import analytics as analytics_service

    # Keeps free-plan deployments fresh despite a daily-only cron.
    if get_settings().drain_on_read:
        await analytics_service.drain_events(session, max_events=analytics_service.READ_DRAIN_LIMIT)

    result = await analytics_service.analytics(session, url.id, from_day, to_day)
    return {
        "short_code": code,
        "from": from_day.isoformat(),
        "to": to_day.isoformat(),
        **result,
    }
