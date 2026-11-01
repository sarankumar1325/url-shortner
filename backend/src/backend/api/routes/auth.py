from uuid import UUID

from fastapi import APIRouter, Depends, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, EmailStr, Field
from sqlalchemy.ext.asyncio import AsyncSession

from backend.api.deps import (
    SESSION_COOKIE,
    clear_session_cookie,
    client_ip,
    enforce_same_origin,
    get_api_session,
    require_user,
    set_session_cookie,
    validate_body_size,
)
from backend.api.routes.redirect import invalidate_caches
from backend.core.problems import APIError
from backend.models import User
from backend.services import accounts as accounts_service
from backend.services import auth as auth_service
from backend.services import ratelimit

router = APIRouter(prefix="/auth", tags=["auth"])


class SignupRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    email: EmailStr
    password: str = Field(min_length=1, max_length=256)
    display_name: str | None = Field(default=None, max_length=80)
    remember: bool = True


class LoginRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    email: EmailStr
    password: str = Field(min_length=1, max_length=256)
    # "Stay signed in"; false gives a browser-session cookie and a 24-hour session.
    remember: bool = True


class DeleteAccountRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    password: str = Field(min_length=1, max_length=256)
    confirm_email: str = Field(min_length=1, max_length=320)


class ChangePasswordRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    current_password: str = Field(min_length=1, max_length=256)
    new_password: str = Field(min_length=1, max_length=256)


async def _limit(key: str, limit: int, window_seconds: int = 60) -> None:
    await _limit_all([(key, limit, window_seconds)])


async def _limit_all(rules: list[ratelimit.Rule]) -> None:
    allowed, retry_after = await ratelimit.check_rate_limits(rules)
    if not allowed:
        raise APIError(
            429,
            "rate_limited",
            "Too many attempts. Try again shortly.",
            headers={"Retry-After": str(retry_after)},
        )


@router.post(
    "/signup",
    status_code=201,
    summary="Create an account and personal workspace",
    dependencies=[Depends(validate_body_size), Depends(enforce_same_origin)],
)
async def signup(
    payload: SignupRequest,
    request: Request,
    session: AsyncSession = Depends(get_api_session),
) -> JSONResponse:
    await _limit(f"signup:{client_ip(request)}", 10, 3600)
    user, token = await auth_service.signup(
        session,
        email=str(payload.email),
        password=payload.password,
        display_name=payload.display_name,
        persistent=payload.remember,
    )
    body = await auth_service.session_payload(session, user)
    response = JSONResponse(status_code=201, content=body)
    set_session_cookie(response, token, payload.remember)
    return response


@router.post(
    "/login",
    summary="Sign in",
    dependencies=[Depends(validate_body_size), Depends(enforce_same_origin)],
)
async def login(
    payload: LoginRequest,
    request: Request,
    session: AsyncSession = Depends(get_api_session),
) -> JSONResponse:
    email = auth_service.normalize_email(str(payload.email))
    await _limit_all(
        [(f"login-ip:{client_ip(request)}", 30, 60), (f"login-account:{email}", 10, 60)]
    )
    user, token = await auth_service.login(
        session, email=email, password=payload.password, persistent=payload.remember
    )
    body = await auth_service.session_payload(session, user)
    response = JSONResponse(status_code=200, content=body)
    set_session_cookie(response, token, payload.remember)
    return response


@router.post(
    "/logout",
    status_code=204,
    summary="Sign out of this browser",
    dependencies=[Depends(enforce_same_origin)],
)
async def logout(
    request: Request,
    session: AsyncSession = Depends(get_api_session),
) -> Response:
    await auth_service.logout(session, request.cookies.get(SESSION_COOKIE))
    response = Response(status_code=204)
    clear_session_cookie(response)
    return response


@router.post(
    "/password",
    status_code=204,
    summary="Change the account password",
    dependencies=[Depends(validate_body_size), Depends(enforce_same_origin)],
)
async def change_password(
    payload: ChangePasswordRequest,
    request: Request,
    user: User = Depends(require_user),
    session: AsyncSession = Depends(get_api_session),
) -> Response:
    await _limit(f"password-change:{user.id}", 10, 3600)
    await auth_service.change_password(
        session,
        user=user,
        current_password=payload.current_password,
        new_password=payload.new_password,
        current_token=request.cookies.get(SESSION_COOKIE),
    )
    return Response(status_code=204)


@router.delete(
    "/account",
    status_code=204,
    summary="Delete the account, its personal workspace and sole-member workspaces",
    dependencies=[Depends(validate_body_size), Depends(enforce_same_origin)],
)
async def delete_account(
    payload: DeleteAccountRequest,
    user: User = Depends(require_user),
    session: AsyncSession = Depends(get_api_session),
) -> Response:
    await _limit(f"account-delete:{user.id}", 10, 3600)
    codes = await accounts_service.delete_account(
        session,
        user=user,
        password=payload.password,
        confirm_email=payload.confirm_email,
    )
    await invalidate_caches(codes)
    response = Response(status_code=204)
    clear_session_cookie(response)
    return response


@router.get("/sessions", summary="List active sessions")
async def list_sessions(
    request: Request,
    user: User = Depends(require_user),
    session: AsyncSession = Depends(get_api_session),
) -> list[dict]:
    return await auth_service.list_sessions(
        session, user=user, current_token=request.cookies.get(SESSION_COOKIE)
    )


@router.delete(
    "/sessions/{session_id}",
    status_code=204,
    summary="Revoke an active session",
    dependencies=[Depends(enforce_same_origin)],
)
async def revoke_session(
    session_id: UUID,
    user: User = Depends(require_user),
    session: AsyncSession = Depends(get_api_session),
) -> Response:
    await auth_service.revoke_session(session, user=user, session_id=session_id)
    return Response(status_code=204)


@router.post(
    "/sessions/revoke-others",
    summary="Sign out every other session",
    dependencies=[Depends(enforce_same_origin)],
)
async def revoke_other_sessions(
    request: Request,
    user: User = Depends(require_user),
    session: AsyncSession = Depends(get_api_session),
) -> dict:
    revoked = await auth_service.revoke_other_sessions(
        session, user=user, current_token=request.cookies.get(SESSION_COOKIE)
    )
    return {"revoked": revoked}


@router.get("/me", summary="Current account and workspace memberships")
async def me(
    user: User = Depends(require_user),
    session: AsyncSession = Depends(get_api_session),
) -> dict:
    return await auth_service.session_payload(session, user)
