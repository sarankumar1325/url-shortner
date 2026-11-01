"""Link lifecycle: idempotent creation, resolution, update, soft delete."""

import json
import uuid
from datetime import UTC, datetime, timedelta
from urllib.parse import urlsplit

from sqlalchemy import and_, case, delete, func, or_, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from backend.core.config import get_settings
from backend.core.problems import APIError
from backend.core.redis import RedisError, command
from backend.core.security import (
    decrypt_replay,
    encrypt_replay,
    generate_management_token,
    generate_password_hash,
    generate_short_code,
    hash_management_token,
    link_password_fingerprint,
    sha256,
    verify_management_token,
)
from backend.models import ClickDaily, CreateRequest, RetiredShortCode, Url, UrlTag
from backend.services.analytics import classify_device
from backend.services.retired_codes import is_retired
from backend.services.smart_redirects import validate_rules
from backend.services.validation import (
    MAX_TAGS,
    RESERVED_SEGMENTS,
    normalize_tags,
    validate_custom_alias,
    validate_long_url,
)

CODE_RETRY_LIMIT = 5
MAX_CLICKS_LIMIT = 1_000_000
MIN_LINK_PASSWORD = 4
MAX_LINK_PASSWORD = 128
# Link unfurlers that classify_device does not flag; they must not use up a visit.
PREVIEWER_MARKERS = ("whatsapp", "skypeuripreview", "vkshare")


def _now() -> datetime:
    return datetime.now(UTC)


def _short_host() -> str | None:
    host = urlsplit(get_settings().short_base_url).hostname
    return host.lower() if host else None


def _validate_destination(long_url: str) -> str:
    return validate_long_url(
        long_url,
        blocked_hosts=get_settings().blocked_hosts,
        short_host=_short_host(),
    )


def _validate_fallback(fallback_url: str | None) -> str | None:
    if fallback_url is None:
        return None
    try:
        return _validate_destination(fallback_url)
    except APIError as exc:
        message = exc.detail.replace("The destination", "The fallback")
        raise APIError(
            exc.status,
            exc.code,
            message,
            errors=[{"field": "fallback_url", "code": exc.code, "message": message}],
        ) from None


def _validate_max_clicks(max_clicks: int | None) -> int | None:
    if max_clicks is None:
        return None
    if not 1 <= max_clicks <= MAX_CLICKS_LIMIT:
        message = f"Visit limits must be between 1 and {MAX_CLICKS_LIMIT:,}."
        raise APIError(
            422,
            "validation_error",
            message,
            errors=[{"field": "max_clicks", "code": "out_of_range", "message": message}],
        )
    return max_clicks


def _validate_password(password: str | None) -> str | None:
    if password is None:
        return None
    if not MIN_LINK_PASSWORD <= len(password) <= MAX_LINK_PASSWORD:
        message = f"Link passwords must be {MIN_LINK_PASSWORD}–{MAX_LINK_PASSWORD} characters."
        raise APIError(
            422,
            "validation_error",
            message,
            errors=[{"field": "password", "code": "out_of_range", "message": message}],
        )
    return password


def _canonical_request(
    long_url: str,
    custom_alias: str | None,
    expires_at: str | None,
    tags: list[str],
    fallback_url: str | None = None,
    max_clicks: int | None = None,
    password: str | None = None,
    redirect_rules: list[dict] | None = None,
) -> bytes:
    # Only validated, canonical input is hashed — never raw client bytes.
    body: dict = {
        "long_url": long_url,
        "custom_alias": custom_alias,
        "expires_at": expires_at,
        "tags": tags,
    }
    # Omitted when unset so requests from before these fields keep their hash.
    if fallback_url is not None:
        body["fallback_url"] = fallback_url
    if max_clicks is not None:
        body["max_clicks"] = max_clicks
    if password is not None:
        # Fingerprinted with a server key: replay rows must not reveal it.
        body["password"] = link_password_fingerprint(password)
    if redirect_rules:
        body["redirect_rules"] = redirect_rules
    return json.dumps(body, sort_keys=True, separators=(",", ":")).encode()


def _validate_expiry(expires_at: datetime | None) -> datetime | None:
    if expires_at is None:
        return None
    now = _now()
    if expires_at <= now:
        raise APIError(422, "validation_error", "Expiry must be in the future.")
    if expires_at > now + timedelta(days=365 * 5):
        raise APIError(422, "validation_error", "Expiry may be at most five years ahead.")
    return expires_at


async def _insert_url(
    session: AsyncSession,
    long_url: str,
    custom_alias: str | None,
    expires_at: datetime | None,
    token_hash: bytes | None,
    workspace_id: uuid.UUID | None,
    created_by_user_id: uuid.UUID | None,
    fallback_url: str | None = None,
    max_clicks: int | None = None,
    password_hash: str | None = None,
    redirect_rules: list[dict] | None = None,
) -> Url:
    for _ in range(CODE_RETRY_LIMIT):
        code = custom_alias
        if code is None:
            code = generate_short_code()
            while code.lower() in RESERVED_SEGMENTS:
                code = generate_short_code()
        if await is_retired(session, code):
            if custom_alias is not None:
                raise APIError(409, "alias_taken", "That alias is already in use.")
            continue
        stmt = (
            pg_insert(Url)
            .values(
                short_code=code,
                long_url=long_url,
                management_token_hash=token_hash,
                token_hash_version=1 if token_hash is not None else None,
                is_custom_alias=custom_alias is not None,
                expires_at=expires_at,
                workspace_id=workspace_id,
                created_by_user_id=created_by_user_id,
                fallback_url=fallback_url,
                max_clicks=max_clicks,
                password_hash=password_hash,
                redirect_rules=redirect_rules,
            )
            .on_conflict_do_nothing(index_elements=["short_code"])
            .returning(Url)
        )
        result = await session.execute(stmt)
        url = result.scalar_one_or_none()
        if url is not None:
            return url
        if custom_alias is not None:
            raise APIError(409, "alias_taken", "That alias is already in use.")
    raise APIError(500, "internal_error", "Could not allocate a short code.")


async def _insert_tags(session: AsyncSession, url_id: int, tags: list[str]) -> None:
    if not tags:
        return
    await session.execute(
        pg_insert(UrlTag)
        .values([{"url_id": url_id, "tag": tag} for tag in tags])
        .on_conflict_do_nothing(index_elements=["url_id", "tag"])
    )


async def create_link(
    session: AsyncSession,
    *,
    idempotency_key: uuid.UUID,
    long_url: str,
    custom_alias: str | None,
    expires_at: datetime | None,
    response_builder,
    workspace_id: uuid.UUID | None = None,
    created_by_user_id: uuid.UUID | None = None,
    tags: list[str] | None = None,
    fallback_url: str | None = None,
    max_clicks: int | None = None,
    password: str | None = None,
    redirect_rules: list[dict] | None = None,
) -> dict:
    """Create a link with atomic idempotency replay storage.

    response_builder(url, management_token, tags) produces the JSON response
    body; it is encrypted and stored in the same transaction as the link.
    Workspace links carry no management token and are authorized by session.
    """
    settings = get_settings()
    long_url = _validate_destination(long_url)
    if custom_alias is not None:
        custom_alias = validate_custom_alias(custom_alias)
    expires_at = _validate_expiry(expires_at)
    fallback_url = _validate_fallback(fallback_url)
    max_clicks = _validate_max_clicks(max_clicks)
    password = _validate_password(password)
    redirect_rules = validate_rules(redirect_rules, _validate_destination)
    tags = normalize_tags(tags)
    if tags and workspace_id is None:
        raise APIError(
            422,
            "validation_error",
            "Tags require a workspace.",
            errors=[
                {
                    "field": "tags",
                    "code": "workspace_required",
                    "message": "Tags require a workspace.",
                }
            ],
        )

    scope = workspace_id.bytes if workspace_id is not None else b""
    key_hash = sha256(idempotency_key.bytes + scope)
    expires_iso = expires_at.isoformat().replace("+00:00", "Z") if expires_at else None
    request_hash = sha256(
        _canonical_request(
            long_url,
            custom_alias,
            expires_iso,
            tags,
            fallback_url,
            max_clicks,
            password,
            redirect_rules,
        )
        + scope
    )

    # Fast path: replay an existing completed request.
    existing = await session.get(CreateRequest, key_hash)
    if existing is not None:
        if existing.request_hash != request_hash:
            raise APIError(
                409,
                "idempotency_conflict",
                "This idempotency key was used with a different request body.",
            )
        if existing.expires_at <= _now():
            # Key expired; it no longer deduplicates. Treat as new request by
            # deleting the stale row inside the create transaction below.
            await session.delete(existing)
            await session.flush()
        elif existing.encrypted_response is not None:
            plaintext = decrypt_replay(
                existing.encrypted_response,
                associated_data=key_hash + request_hash,
            )
            return json.loads(plaintext)

    token = generate_management_token() if workspace_id is None else None
    token_hash = hash_management_token(token) if token is not None else None

    # Reserve the key first: any concurrent same-key insert blocks/fails here.
    reserve = (
        pg_insert(CreateRequest)
        .values(
            key_hash=key_hash,
            request_hash=request_hash,
            expires_at=_now() + timedelta(seconds=settings.replay_ttl_seconds),
        )
        .on_conflict_do_nothing(index_elements=["key_hash"])
    )
    reserve_result = await session.execute(reserve)
    if reserve_result.rowcount == 0:
        # Lost the race; read the winner's state.
        await session.rollback()
        existing = await session.get(CreateRequest, key_hash)
        if existing is not None and existing.encrypted_response is not None:
            if existing.request_hash != request_hash:
                raise APIError(
                    409,
                    "idempotency_conflict",
                    "This idempotency key was used with a different request body.",
                )
            plaintext = decrypt_replay(
                existing.encrypted_response, associated_data=key_hash + request_hash
            )
            return json.loads(plaintext)
        raise APIError(
            409,
            "request_in_progress",
            "A request with this idempotency key is still in progress.",
            headers={"Retry-After": "1"},
        )

    url = await _insert_url(
        session,
        long_url,
        custom_alias,
        expires_at,
        token_hash,
        workspace_id,
        created_by_user_id,
        fallback_url,
        max_clicks,
        generate_password_hash(password) if password is not None else None,
        redirect_rules,
    )
    await _insert_tags(session, url.id, tags)
    response = response_builder(url, token, tags=tags)
    payload = json.dumps(response, separators=(",", ":")).encode()
    # The reservation holds the row; fill in the completed response. (A
    # partial-row upsert would trip NOT NULL checks before conflict handling.)
    await session.execute(
        update(CreateRequest)
        .where(CreateRequest.key_hash == key_hash)
        .values(
            url_id=url.id,
            encrypted_response=encrypt_replay(payload, associated_data=key_hash + request_hash),
            encryption_key_id="replay-v1",
        )
    )
    await session.commit()
    return response


async def get_url(session: AsyncSession, code: str) -> Url | None:
    result = await session.execute(select(Url).where(Url.short_code == code))
    return result.scalar_one_or_none()


async def tags_for(session: AsyncSession, url_ids: list[int]) -> dict[int, list[str]]:
    if not url_ids:
        return {}
    result = await session.execute(
        select(UrlTag.url_id, UrlTag.tag).where(UrlTag.url_id.in_(url_ids)).order_by(UrlTag.tag)
    )
    tags: dict[int, list[str]] = {}
    for url_id, tag in result.all():
        tags.setdefault(url_id, []).append(tag)
    return tags


async def tags_for_url(session: AsyncSession, url_id: int) -> list[str]:
    result = await session.execute(
        select(UrlTag.tag).where(UrlTag.url_id == url_id).order_by(UrlTag.tag)
    )
    return list(result.scalars().all())


async def require_url_with_token(session: AsyncSession, code: str, token: str | None) -> Url:
    """Fetch a link for management: token is required and checked first."""
    if not token:
        raise APIError(401, "invalid_token", "A management token is required.")
    url = await get_url(session, code)
    if url is None or url.deleted_at is not None or url.is_blocked:
        raise APIError(404, "link_not_found", "No such link.")
    if not verify_token(token, url):
        raise APIError(401, "invalid_token", "The management token is invalid.")
    return url


def verify_token(token: str, url: Url) -> bool:
    if url.management_token_hash is None:
        return False
    return verify_management_token(token, url.management_token_hash)


async def get_workspace_url(session: AsyncSession, code: str, workspace_id: uuid.UUID) -> Url:
    result = await session.execute(
        select(Url).where(
            Url.short_code == code,
            Url.workspace_id == workspace_id,
            Url.deleted_at.is_(None),
            Url.is_blocked.is_(False),
        )
    )
    url = result.scalar_one_or_none()
    if url is None:
        raise APIError(404, "link_not_found", "No such link.")
    return url


async def list_workspace_links(
    session: AsyncSession,
    workspace_id: uuid.UUID,
    limit: int,
    tag: str | None = None,
) -> list[tuple[Url, int]]:
    cutoff = _now().date() - timedelta(days=29)
    clicks = func.coalesce(func.sum(ClickDaily.clicks), 0).label("clicks_30d")
    query = (
        select(Url, clicks)
        .outerjoin(
            ClickDaily,
            and_(
                ClickDaily.url_id == Url.id,
                ClickDaily.day >= cutoff,
                ClickDaily.day <= _now().date(),
            ),
        )
        .where(Url.workspace_id == workspace_id, Url.deleted_at.is_(None))
    )
    if tag is not None:
        query = query.join(UrlTag, and_(UrlTag.url_id == Url.id, UrlTag.tag == tag))
    result = await session.execute(
        query.group_by(Url.id).order_by(Url.created_at.desc(), Url.id.desc()).limit(limit)
    )
    return [(url, int(total)) for url, total in result.all()]


async def resolve_public(session: AsyncSession, code: str) -> tuple[Url, str]:
    """State machine: missing/deleted/blocked/inactive → 404, expired → 410."""
    url = await get_url(session, code)
    if url is None or url.deleted_at is not None or url.is_blocked or not url.is_active:
        raise APIError(404, "link_not_found", "No such link.")
    if url.expires_at is not None and url.expires_at <= _now():
        return url, "expired"
    return url, "active"


async def get_public_url(session: AsyncSession, code: str, token: str | None) -> Url:
    """GET metadata: token holders see inactive/expired states too."""
    if token is not None:
        return await require_url_with_token(session, code, token)
    url, state = await resolve_public(session, code)
    if state == "expired":
        raise APIError(410, "link_expired", "This link has expired.")
    return url


async def update_link(
    session: AsyncSession,
    url: Url,
    *,
    long_url: str | None,
    expires_at: datetime | None,
    is_active: bool | None,
    clear_expiry: bool,
    replace_tags: bool = False,
    tags: list[str] | None = None,
    fallback_url: str | None = None,
    clear_fallback: bool = False,
    max_clicks: int | None = None,
    clear_max_clicks: bool = False,
    password: str | None = None,
    clear_password: bool = False,
    redirect_rules: list[dict] | None = None,
    replace_redirect_rules: bool = False,
) -> Url:
    if long_url is not None:
        url.long_url = _validate_destination(long_url)
    if clear_fallback:
        url.fallback_url = None
    elif fallback_url is not None:
        url.fallback_url = _validate_fallback(fallback_url)
    if clear_max_clicks:
        # Removing the limit restarts the count if a limit is added later.
        url.max_clicks = None
        url.clicks_used = 0
    elif max_clicks is not None:
        url.max_clicks = _validate_max_clicks(max_clicks)
    if clear_password:
        url.password_hash = None
    elif password is not None:
        url.password_hash = generate_password_hash(_validate_password(password))
    if replace_redirect_rules:
        url.redirect_rules = validate_rules(redirect_rules, _validate_destination)
    if clear_expiry:
        url.expires_at = None
    elif expires_at is not None:
        url.expires_at = _validate_expiry(expires_at)
    if is_active is not None:
        url.is_active = is_active
    if replace_tags:
        normalized = normalize_tags(tags)
        await session.execute(delete(UrlTag).where(UrlTag.url_id == url.id))
        await _insert_tags(session, url.id, normalized)
    url.updated_at = _now()
    await session.commit()
    await session.refresh(url)
    return url


def is_link_previewer(user_agent: str | None) -> bool:
    if classify_device(user_agent)[1]:
        return True
    ua = (user_agent or "").lower()
    return any(marker in ua for marker in PREVIEWER_MARKERS)


async def consume_visit(session: AsyncSession, url_id: int, *, count: bool) -> bool:
    """Atomically use one visit of a capped link; False once the limit is reached.

    With count=False the remaining allowance is only checked, for previews,
    HEAD requests and link unfurlers.
    """
    remaining = or_(Url.max_clicks.is_(None), Url.clicks_used < Url.max_clicks)
    if not count:
        result = await session.execute(select(Url.id).where(Url.id == url_id, remaining))
        return result.scalar_one_or_none() is not None
    result = await session.execute(
        update(Url)
        .where(Url.id == url_id, remaining)
        .values(
            clicks_used=case(
                (Url.max_clicks.is_(None), Url.clicks_used), else_=Url.clicks_used + 1
            ),
            # Keep updated_at meaning "edited by a person", not "visited".
            updated_at=Url.updated_at,
        )
        .returning(Url.id)
    )
    allowed = result.scalar_one_or_none() is not None
    await session.commit()
    return allowed


async def delete_link(session: AsyncSession, url: Url) -> None:
    url.deleted_at = _now()
    url.updated_at = _now()
    await session.commit()


BULK_ACTIONS = ("pause", "resume", "delete", "add_tags", "remove_tags")
MAX_BULK_CODES = 200


async def bulk_update(
    session: AsyncSession,
    workspace_id: uuid.UUID,
    codes: list[str],
    action: str,
    tags: list[str] | None = None,
) -> list[dict]:
    """Apply one action to many links of a workspace in a single transaction.

    Each code gets its own status: "ok", "not_found" (missing, deleted, blocked
    or in another workspace) or, when adding tags, "too_many_tags".
    """
    unique = list(dict.fromkeys(codes))
    tag_action = action in ("add_tags", "remove_tags")
    normalized: list[str] = []
    if tag_action:
        normalized = normalize_tags(tags)
        if not normalized:
            message = "Choose at least one tag."
            raise APIError(
                422,
                "validation_error",
                message,
                errors=[{"field": "tags", "code": "missing", "message": message}],
            )
    elif tags is not None:
        message = "Tags are only used when adding or removing tags."
        raise APIError(
            422,
            "validation_error",
            message,
            errors=[{"field": "tags", "code": "unexpected", "message": message}],
        )

    result = await session.execute(
        select(Url.id, Url.short_code).where(
            Url.workspace_id == workspace_id,
            Url.short_code.in_(unique),
            Url.deleted_at.is_(None),
            Url.is_blocked.is_(False),
        )
    )
    found = {code: url_id for url_id, code in result.all()}
    status = {code: ("ok" if code in found else "not_found") for code in unique}
    ids = list(found.values())
    now = _now()

    if ids and action in ("pause", "resume"):
        await session.execute(
            update(Url).where(Url.id.in_(ids)).values(is_active=action == "resume", updated_at=now)
        )
    elif ids and action == "delete":
        await session.execute(
            update(Url).where(Url.id.in_(ids)).values(deleted_at=now, updated_at=now)
        )
    elif ids and action == "remove_tags":
        await session.execute(
            delete(UrlTag).where(UrlTag.url_id.in_(ids), UrlTag.tag.in_(normalized))
        )
        await session.execute(update(Url).where(Url.id.in_(ids)).values(updated_at=now))
    elif ids and action == "add_tags":
        current = await tags_for(session, ids)
        additions: list[dict] = []
        changed: list[int] = []
        for code, url_id in found.items():
            existing = current.get(url_id, [])
            missing = [tag for tag in normalized if tag not in existing]
            if len(existing) + len(missing) > MAX_TAGS:
                status[code] = "too_many_tags"
                continue
            additions += [{"url_id": url_id, "tag": tag} for tag in missing]
            if missing:
                changed.append(url_id)
        if additions:
            await session.execute(
                pg_insert(UrlTag)
                .values(additions)
                .on_conflict_do_nothing(index_elements=["url_id", "tag"])
            )
            await session.execute(update(Url).where(Url.id.in_(changed)).values(updated_at=now))
    await session.commit()
    return [{"short_code": code, "status": status[code]} for code in unique]


async def alias_availability(session: AsyncSession, alias: str) -> dict:
    """Syntax and reserved-word checks first, then a cache probe, then Postgres.

    Soft-deleted and retired codes stay taken: short codes are never reissued,
    so an old printed link can never start pointing somewhere new.
    """
    try:
        validate_custom_alias(alias)
    except APIError as exc:
        reason = "reserved" if exc.code == "reserved_alias" else "invalid"
        return {"alias": alias, "available": False, "reason": reason, "message": exc.detail}

    try:
        cached = await command("EXISTS", f"redir:{alias}")
    except RedisError:
        cached = 0
    if cached:
        return {
            "alias": alias,
            "available": False,
            "reason": "taken",
            "message": "That alias is already in use.",
            "source": "cache",
        }

    in_use = select(Url.short_code).where(Url.short_code == alias)
    retired = select(RetiredShortCode.short_code).where(RetiredShortCode.short_code == alias)
    result = await session.execute(in_use.union_all(retired).limit(1))
    if result.scalar_one_or_none() is not None:
        return {
            "alias": alias,
            "available": False,
            "reason": "taken",
            "message": "That alias is already in use.",
            "source": "database",
        }
    return {
        "alias": alias,
        "available": True,
        "reason": None,
        "message": "That alias is available.",
        "source": "database",
    }
