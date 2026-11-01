"""First-party email/password accounts and opaque cookie sessions."""

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy import and_, delete, join, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from backend.core.config import get_settings
from backend.core.problems import APIError
from backend.core.security import (
    generate_password_hash,
    generate_session_token,
    hash_opaque_token,
    password_needs_rehash,
    verify_dummy_password,
    verify_password,
)
from backend.models import User, UserSession, Workspace, WorkspaceMember

MIN_PASSWORD_LENGTH = 10
MAX_PASSWORD_LENGTH = 128


def _now() -> datetime:
    return datetime.now(UTC)


def _iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    return value.isoformat().replace("+00:00", "Z")


def _aware(value: datetime) -> datetime:
    return value if value.tzinfo else value.replace(tzinfo=UTC)


def session_ttl_seconds(persistent: bool) -> int:
    settings = get_settings()
    return settings.session_ttl_seconds if persistent else settings.short_session_ttl_seconds


def normalize_email(value: str) -> str:
    return value.strip().lower()


def normalize_display_name(raw: str | None, email: str) -> str:
    name = " ".join((raw or "").split())
    if not name:
        name = email.split("@", 1)[0]
    return name[:80] or "Member"


def validate_password(password: str) -> str:
    if len(password) < MIN_PASSWORD_LENGTH:
        raise APIError(
            422,
            "validation_error",
            f"Passwords must be at least {MIN_PASSWORD_LENGTH} characters.",
            errors=[
                {
                    "field": "password",
                    "code": "too_short",
                    "message": f"Use at least {MIN_PASSWORD_LENGTH} characters.",
                }
            ],
        )
    if len(password) > MAX_PASSWORD_LENGTH:
        raise APIError(
            422,
            "validation_error",
            f"Passwords must be at most {MAX_PASSWORD_LENGTH} characters.",
            errors=[
                {
                    "field": "password",
                    "code": "too_long",
                    "message": f"Use at most {MAX_PASSWORD_LENGTH} characters.",
                }
            ],
        )
    return password


async def _issue_session(session: AsyncSession, user: User, *, persistent: bool = True) -> str:
    token = generate_session_token()
    session.add(
        UserSession(
            token_hash=hash_opaque_token(token),
            user_id=user.id,
            persistent=persistent,
            expires_at=_now() + timedelta(seconds=session_ttl_seconds(persistent)),
        )
    )
    return token


async def signup(
    session: AsyncSession,
    *,
    email: str,
    password: str,
    display_name: str | None,
    persistent: bool = True,
) -> tuple[User, str]:
    email = normalize_email(email)
    validate_password(password)
    name = normalize_display_name(display_name, email)
    user = User(
        email=email,
        password_hash=generate_password_hash(password),
        display_name=name,
    )
    session.add(user)
    try:
        await session.flush()
        workspace = Workspace(
            name=f"{name}'s workspace",
            is_personal=True,
            personal_user_id=user.id,
        )
        session.add(workspace)
        await session.flush()
        session.add(WorkspaceMember(workspace_id=workspace.id, user_id=user.id, role="owner"))
        token = await _issue_session(session, user, persistent=persistent)
        await session.commit()
    except IntegrityError:
        await session.rollback()
        raise APIError(409, "email_taken", "An account with this email already exists.") from None
    await session.refresh(user)
    return user, token


async def login(
    session: AsyncSession, *, email: str, password: str, persistent: bool = True
) -> tuple[User, str]:
    email = normalize_email(email)
    result = await session.execute(select(User).where(User.email == email))
    user = result.scalar_one_or_none()
    if user is None:
        verify_dummy_password(password)
        raise APIError(401, "invalid_credentials", "Email or password is incorrect.")
    if not verify_password(password, user.password_hash):
        raise APIError(401, "invalid_credentials", "Email or password is incorrect.")
    if password_needs_rehash(user.password_hash):
        user.password_hash = generate_password_hash(password)
    token = await _issue_session(session, user, persistent=persistent)
    await session.commit()
    return user, token


async def logout(session: AsyncSession, token: str | None) -> None:
    if not token:
        return
    await session.execute(
        delete(UserSession).where(UserSession.token_hash == hash_opaque_token(token))
    )
    await session.commit()


async def change_password(
    session: AsyncSession,
    *,
    user: User,
    current_password: str,
    new_password: str,
    current_token: str | None,
) -> None:
    validate_password(new_password)
    if not verify_password(current_password, user.password_hash):
        raise APIError(
            403,
            "invalid_password",
            "The current password is incorrect.",
            errors=[
                {
                    "field": "current_password",
                    "code": "invalid",
                    "message": "The current password is incorrect.",
                }
            ],
        )
    if verify_password(new_password, user.password_hash):
        raise APIError(
            422,
            "validation_error",
            "Choose a password different from the current one.",
            errors=[
                {
                    "field": "new_password",
                    "code": "unchanged",
                    "message": "Choose a different password.",
                }
            ],
        )
    user.password_hash = generate_password_hash(new_password)
    condition = UserSession.user_id == user.id
    if current_token:
        condition = condition & (UserSession.token_hash != hash_opaque_token(current_token))
    await session.execute(delete(UserSession).where(condition))
    await session.commit()


def _serialize_session(item: UserSession, current_digest: bytes | None) -> dict:
    return {
        "id": str(item.id),
        "created_at": _iso(item.created_at),
        "expires_at": _iso(item.expires_at),
        "current": current_digest is not None and item.token_hash == current_digest,
    }


async def list_sessions(
    session: AsyncSession, *, user: User, current_token: str | None
) -> list[dict]:
    digest = hash_opaque_token(current_token) if current_token else None
    result = await session.execute(
        select(UserSession)
        .where(UserSession.user_id == user.id)
        .order_by(UserSession.created_at.desc())
    )
    return [_serialize_session(item, digest) for item in result.scalars().all()]


async def revoke_session(session: AsyncSession, *, user: User, session_id: uuid.UUID) -> None:
    result = await session.execute(
        delete(UserSession).where(
            UserSession.id == session_id,
            UserSession.user_id == user.id,
        )
    )
    await session.commit()
    if not result.rowcount:
        raise APIError(404, "session_not_found", "No such active session.")


async def revoke_other_sessions(
    session: AsyncSession, *, user: User, current_token: str | None
) -> int:
    condition = UserSession.user_id == user.id
    if current_token:
        condition = condition & (UserSession.token_hash != hash_opaque_token(current_token))
    result = await session.execute(delete(UserSession).where(condition))
    await session.commit()
    return result.rowcount or 0


@dataclass
class SessionContext:
    user: User
    persistent: bool
    expires_at: datetime
    workspace: Workspace | None = None
    role: str | None = None
    renewed: bool = False


def _context_query(digest: bytes, workspace_id: uuid.UUID | None, with_workspace: bool):
    query = (
        select(User, UserSession.expires_at, UserSession.persistent)
        .join(UserSession, UserSession.user_id == User.id)
        .where(UserSession.token_hash == digest)
    )
    if not with_workspace:
        return query
    chosen = (
        Workspace.id == workspace_id
        if workspace_id is not None
        else Workspace.personal_user_id == User.id
    )
    memberships = join(WorkspaceMember, Workspace, WorkspaceMember.workspace_id == Workspace.id)
    return query.outerjoin(
        memberships, and_(WorkspaceMember.user_id == User.id, chosen)
    ).add_columns(Workspace, WorkspaceMember.role)


async def session_context(
    session: AsyncSession,
    token: str,
    workspace_id: uuid.UUID | None = None,
    *,
    with_workspace: bool = False,
) -> SessionContext | None:
    """Session, account and (optionally) workspace role in one query.

    Expired sessions are deleted. Persistent sessions past half their lifetime
    are extended, and renewed=True tells the caller to refresh the cookie.
    """
    digest = hash_opaque_token(token)
    result = await session.execute(_context_query(digest, workspace_id, with_workspace))
    row = result.first()
    if row is None:
        return None
    user, expires_at, persistent = row[0], _aware(row[1]), bool(row[2])
    now = _now()
    if expires_at <= now:
        await session.execute(delete(UserSession).where(UserSession.token_hash == digest))
        await session.commit()
        return None
    context = SessionContext(user=user, persistent=persistent, expires_at=expires_at)
    if with_workspace and row[3] is not None:
        context.workspace, context.role = row[3], row[4]
    ttl = session_ttl_seconds(persistent)
    if persistent and expires_at - now < timedelta(seconds=ttl / 2):
        context.expires_at = now + timedelta(seconds=ttl)
        await session.execute(
            update(UserSession)
            .where(UserSession.token_hash == digest)
            .values(expires_at=context.expires_at)
        )
        await session.commit()
        context.renewed = True
    return context


async def user_for_session(session: AsyncSession, token: str) -> User | None:
    context = await session_context(session, token)
    return context.user if context else None


def serialize_user(user: User) -> dict:
    return {
        "id": str(user.id),
        "email": user.email,
        "display_name": user.display_name,
        "created_at": user.created_at.isoformat().replace("+00:00", "Z"),
    }


async def workspaces_for_user(session: AsyncSession, user_id) -> list[dict]:
    result = await session.execute(
        select(Workspace, WorkspaceMember.role)
        .join(WorkspaceMember, WorkspaceMember.workspace_id == Workspace.id)
        .where(WorkspaceMember.user_id == user_id)
        .order_by(Workspace.is_personal.desc(), Workspace.created_at)
    )
    return [
        {
            "id": str(workspace.id),
            "name": workspace.name,
            "role": role,
            "is_personal": workspace.is_personal,
        }
        for workspace, role in result.all()
    ]


async def session_payload(session: AsyncSession, user: User) -> dict:
    return {
        "user": serialize_user(user),
        "workspaces": await workspaces_for_user(session, user.id),
    }
