import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass

from fastapi import Depends, Header, Request, Response
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.datastructures import MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from backend.core.config import get_settings
from backend.core.db import get_session_factory
from backend.core.problems import APIError
from backend.models import User, Workspace
from backend.services import auth as auth_service

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


def set_session_cookie(response: Response, token: str, persistent: bool = True) -> None:
    """Persistent sessions outlive the browser; the others end when it closes."""
    response.set_cookie(
        SESSION_COOKIE,
        token,
        max_age=get_settings().session_ttl_seconds if persistent else None,
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


class SessionRenewalMiddleware:
    """Re-sends the session cookie with a fresh Max-Age after a renewal.

    Dependencies cannot add headers to a Response a route returns directly, so
    the lookup leaves the token in request state and the cookie is added here.
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def send_with_cookie(message: Message) -> None:
            if message["type"] == "http.response.start":
                token = (scope.get("state") or {}).get("renewed_session_token")
                if token and message.get("status", 200) < 400:
                    cookie = Response()
                    set_session_cookie(cookie, token)
                    headers = MutableHeaders(scope=message)
                    if "set-cookie" not in headers:
                        headers.append("set-cookie", cookie.headers["set-cookie"])
            await send(message)

        await self.app(scope, receive, send_with_cookie)


async def _session_context(
    request: Request,
    session: AsyncSession,
    workspace_id: uuid.UUID | None = None,
    *,
    with_workspace: bool = False,
) -> auth_service.SessionContext | None:
    token = request.cookies.get(SESSION_COOKIE)
    if not token:
        return None
    context = await auth_service.session_context(
        session, token, workspace_id, with_workspace=with_workspace
    )
    if context is not None and context.renewed:
        request.state.renewed_session_token = token
    return context


async def get_optional_user(
    request: Request,
    session: AsyncSession = Depends(get_api_session),
) -> User | None:
    context = await _session_context(request, session)
    return context.user if context else None


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


async def _workspace_session(
    request: Request, session: AsyncSession, workspace_id: str | None
) -> WorkspaceContext | None:
    """Session, account and membership from one query; None when signed out."""
    if not request.cookies.get(SESSION_COOKIE):
        return None
    context = await _session_context(
        request, session, _workspace_header(workspace_id), with_workspace=True
    )
    if context is None:
        return None
    if context.workspace is None or context.role is None:
        raise APIError(404, "workspace_not_found", "No such workspace.")
    return WorkspaceContext(workspace=context.workspace, role=context.role, user=context.user)


async def get_workspace_context(
    request: Request,
    session: AsyncSession = Depends(get_api_session),
    workspace_id: str | None = Header(default=None, alias="X-Workspace-Id"),
) -> WorkspaceContext:
    context = await _workspace_session(request, session, workspace_id)
    if context is None:
        raise APIError(401, "authentication_required", "Sign in to continue.")
    return context


async def get_optional_workspace_context(
    request: Request,
    session: AsyncSession = Depends(get_api_session),
    workspace_id: str | None = Header(default=None, alias="X-Workspace-Id"),
) -> WorkspaceContext | None:
    context = await _workspace_session(request, session, workspace_id)
    if context is None and workspace_id is not None:
        raise APIError(401, "authentication_required", "Sign in to continue.")
    return context


SessionDep = Depends(get_api_session)
