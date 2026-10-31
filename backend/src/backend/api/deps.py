import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass

from fastapi import Depends, Header, Request, Response
from sqlalchemy.ext.asyncio import AsyncSession

from backend.core.config import get_settings
from backend.core.db import get_session_factory
from backend.core.problems import APIError
from backend.models import User, Workspace
from backend.services import auth as auth_service
from backend.services import workspaces as workspace_service

MAX_BODY_BYTES = 64 * 1024
SESSION_COOKIE = "shortly_session"
SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})


async def get_api_session() -> AsyncIterator[AsyncSession]:
    async with get_session_factory()() as session:
        yield session


async def validate_body_size(request: Request) -> None:
    content_length = request.headers.get("content-length")
    if content_length is not None and int(content_length) > MAX_BODY_BYTES:
        raise APIError(413, "payload_too_large", "Request body exceeds 64 KiB.")


async def require_idempotency_key(
    request: Request,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> uuid.UUID:
    if idempotency_key is None:
        raise APIError(
            422,
            "validation_error",
            "An Idempotency-Key header is required.",
            errors=[
                {
                    "field": "idempotency_key",
                    "code": "missing",
                    "message": "Idempotency-Key header is required.",
                }
            ],
        )
    try:
        return uuid.UUID(idempotency_key)
    except ValueError:
        raise APIError(
            422,
            "validation_error",
            "Idempotency-Key must be a UUID.",
            errors=[
                {
                    "field": "idempotency_key",
                    "code": "invalid",
                    "message": "Idempotency-Key must be a UUID.",
                }
            ],
        ) from None


async def verify_cron(
    authorization: str | None = Header(default=None),
) -> None:
    secret = get_settings().cron_secret
    if not secret:
        raise APIError(503, "dependency_unavailable", "Cron is not configured.")
    if authorization != f"Bearer {secret}":
        raise APIError(401, "invalid_token", "Invalid cron credentials.")


def client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def _cookie_secure() -> bool:
    return get_settings().environment in ("production", "preview")


def set_session_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        SESSION_COOKIE,
        token,
        max_age=get_settings().session_ttl_seconds,
        httponly=True,
        secure=_cookie_secure(),
        samesite="lax",
        path="/",
    )


def clear_session_cookie(response: Response) -> None:
    response.delete_cookie(
        SESSION_COOKIE,
        httponly=True,
        secure=_cookie_secure(),
        samesite="lax",
        path="/",
    )


async def enforce_same_origin(request: Request) -> None:
    """Cookie-authenticated writes must come from an allowed browser origin.

    Requests without Origin/Referer are non-browser clients, which cannot be
    tricked into sending a victim's cookie, so they are left alone.
    """
    if request.method in SAFE_METHODS:
        return
    origin = request.headers.get("origin")
    if origin is None:
        referer = request.headers.get("referer")
        if referer:
            parts = referer.split("/")
            origin = "/".join(parts[:3]) if len(parts) >= 3 else None
    if origin is None:
        return
    allowed = {item.rstrip("/") for item in get_settings().cors_origins}
    if origin.rstrip("/") not in allowed:
        raise APIError(403, "csrf_rejected", "Request origin is not allowed.")


async def get_optional_user(
    request: Request,
    session: AsyncSession = Depends(get_api_session),
) -> User | None:
    token = request.cookies.get(SESSION_COOKIE)
    if not token:
        return None
    return await auth_service.user_for_session(session, token)


async def require_user(
    user: User | None = Depends(get_optional_user),
) -> User:
    if user is None:
        raise APIError(401, "authentication_required", "Sign in to continue.")
    return user


@dataclass
class WorkspaceContext:
    workspace: Workspace
    role: str
    user: User


def _workspace_header(
    workspace_id: str | None,
) -> uuid.UUID | None:
    if workspace_id is None:
        return None
    try:
        return uuid.UUID(workspace_id)
    except ValueError:
        raise APIError(400, "invalid_workspace", "X-Workspace-Id must be a UUID.") from None


async def get_workspace_context(
    user: User = Depends(require_user),
    session: AsyncSession = Depends(get_api_session),
    workspace_id: str | None = Header(default=None, alias="X-Workspace-Id"),
) -> WorkspaceContext:
    workspace, role = await workspace_service.get_workspace_context(
        session, user.id, _workspace_header(workspace_id)
    )
    return WorkspaceContext(workspace=workspace, role=role, user=user)


async def get_optional_workspace_context(
    user: User | None = Depends(get_optional_user),
    session: AsyncSession = Depends(get_api_session),
    workspace_id: str | None = Header(default=None, alias="X-Workspace-Id"),
) -> WorkspaceContext | None:
    if user is None:
        if workspace_id is not None:
            raise APIError(401, "authentication_required", "Sign in to continue.")
        return None
    workspace, role = await workspace_service.get_workspace_context(
        session, user.id, _workspace_header(workspace_id)
    )
    return WorkspaceContext(workspace=workspace, role=role, user=user)


SessionDep = Depends(get_api_session)
