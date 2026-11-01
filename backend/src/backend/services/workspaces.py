"""Workspaces, memberships, role checks, and invitations."""

import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.core.config import get_settings
from backend.core.problems import APIError
from backend.core.security import generate_invitation_token, hash_opaque_token
from backend.models import (
    User,
    Workspace,
    WorkspaceInvitation,
    WorkspaceMember,
)
from backend.services.retired_codes import retire_workspace_codes

ROLE_RANK = {"viewer": 1, "member": 2, "admin": 3, "owner": 4}
ASSIGNABLE_ROLES = frozenset({"admin", "member", "viewer"})


def _now() -> datetime:
    return datetime.now(UTC)


def _iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    return value.isoformat().replace("+00:00", "Z")


def require_role(role: str, minimum: str) -> None:
    if ROLE_RANK[role] < ROLE_RANK[minimum]:
        raise APIError(
            403,
            "forbidden",
            "Your workspace role does not allow this action.",
        )


async def get_workspace_context(
    session: AsyncSession,
    user_id: uuid.UUID,
    workspace_id: uuid.UUID | None,
) -> tuple[Workspace, str]:
    query = (
        select(Workspace, WorkspaceMember.role)
        .join(WorkspaceMember, WorkspaceMember.workspace_id == Workspace.id)
        .where(WorkspaceMember.user_id == user_id)
    )
    if workspace_id is None:
        query = query.where(Workspace.is_personal.is_(True))
    else:
        query = query.where(Workspace.id == workspace_id)
    result = await session.execute(query)
    row = result.one_or_none()
    if row is None:
        raise APIError(404, "workspace_not_found", "No such workspace.")
    return row[0], row[1]


def clean_workspace_name(name: str) -> str:
    cleaned = " ".join(name.split())
    if not cleaned or len(cleaned) > 80:
        raise APIError(
            422,
            "validation_error",
            "Workspace names must be between 1 and 80 characters.",
            errors=[
                {
                    "field": "name",
                    "code": "invalid",
                    "message": "Use between 1 and 80 characters.",
                }
            ],
        )
    return cleaned


async def create_workspace(session: AsyncSession, user: User, name: str) -> dict:
    cleaned = clean_workspace_name(name)
    workspace = Workspace(name=cleaned, is_personal=False)
    session.add(workspace)
    await session.flush()
    session.add(WorkspaceMember(workspace_id=workspace.id, user_id=user.id, role="owner"))
    await session.commit()
    return {
        "id": str(workspace.id),
        "name": workspace.name,
        "role": "owner",
        "is_personal": False,
    }


async def rename_workspace(
    session: AsyncSession,
    *,
    workspace: Workspace,
    actor_role: str,
    name: str,
) -> dict:
    require_role(actor_role, "admin")
    workspace.name = clean_workspace_name(name)
    await session.commit()
    return {
        "id": str(workspace.id),
        "name": workspace.name,
        "role": actor_role,
        "is_personal": workspace.is_personal,
    }


async def _locked_membership(
    session: AsyncSession, workspace_id: uuid.UUID, user_id: uuid.UUID
) -> WorkspaceMember | None:
    result = await session.execute(
        select(WorkspaceMember)
        .where(
            WorkspaceMember.workspace_id == workspace_id,
            WorkspaceMember.user_id == user_id,
        )
        .with_for_update()
    )
    return result.scalar_one_or_none()


async def delete_workspace(
    session: AsyncSession,
    *,
    workspace: Workspace,
    actor_id: uuid.UUID,
    confirm_name: str,
) -> list[str]:
    """Hard-delete a shared workspace; returns its retired short codes."""
    actor = await _locked_membership(session, workspace.id, actor_id)
    if actor is None:
        raise APIError(404, "workspace_not_found", "No such workspace.")
    require_role(actor.role, "owner")
    if workspace.is_personal:
        raise APIError(403, "personal_workspace", "Your personal workspace cannot be deleted.")
    if confirm_name.strip() != workspace.name:
        raise APIError(
            422,
            "confirmation_mismatch",
            "Type the workspace name exactly to confirm deletion.",
            errors=[
                {
                    "field": "confirm_name",
                    "code": "mismatch",
                    "message": "This does not match the workspace name.",
                }
            ],
        )
    codes = await retire_workspace_codes(session, [workspace.id], "workspace_deleted")
    await session.delete(workspace)
    await session.commit()
    return codes


async def transfer_ownership(
    session: AsyncSession,
    *,
    workspace: Workspace,
    actor_id: uuid.UUID,
    target_id: uuid.UUID,
) -> None:
    if target_id == actor_id:
        raise APIError(422, "validation_error", "You already own this workspace.")
    actor = await _locked_membership(session, workspace.id, actor_id)
    if actor is None:
        raise APIError(404, "workspace_not_found", "No such workspace.")
    require_role(actor.role, "owner")
    if workspace.is_personal:
        raise APIError(
            403, "personal_workspace", "Personal workspace ownership cannot be transferred."
        )
    target = await _locked_membership(session, workspace.id, target_id)
    if target is None:
        raise APIError(404, "member_not_found", "No such workspace member.")
    if target.role == "owner":
        raise APIError(409, "owner_conflict", "This member already owns the workspace.")
    target.role = "owner"
    actor.role = "admin"
    await session.commit()


async def list_members(session: AsyncSession, workspace_id: uuid.UUID) -> list[dict]:
    result = await session.execute(
        select(User, WorkspaceMember.role, WorkspaceMember.created_at)
        .join(WorkspaceMember, WorkspaceMember.user_id == User.id)
        .where(WorkspaceMember.workspace_id == workspace_id)
        .order_by(WorkspaceMember.created_at)
    )
    return [
        {
            "user_id": str(user.id),
            "email": user.email,
            "display_name": user.display_name,
            "role": role,
            "joined_at": _iso(joined_at),
        }
        for user, role, joined_at in result.all()
    ]


async def _membership(
    session: AsyncSession, workspace_id: uuid.UUID, user_id: uuid.UUID
) -> WorkspaceMember | None:
    return await session.get(WorkspaceMember, (workspace_id, user_id))


async def change_member_role(
    session: AsyncSession,
    *,
    workspace_id: uuid.UUID,
    actor_id: uuid.UUID,
    actor_role: str,
    target_id: uuid.UUID,
    new_role: str,
) -> None:
    require_role(actor_role, "admin")
    if new_role not in ASSIGNABLE_ROLES:
        raise APIError(422, "validation_error", "Choose admin, member, or viewer.")
    if target_id == actor_id:
        raise APIError(422, "validation_error", "You cannot change your own role.")
    target = await _membership(session, workspace_id, target_id)
    if target is None:
        raise APIError(404, "member_not_found", "No such workspace member.")
    if actor_role != "owner" and target.role in ("owner", "admin"):
        raise APIError(403, "forbidden", "Only the owner can manage admins.")
    target.role = new_role
    await session.commit()


async def remove_member(
    session: AsyncSession,
    *,
    workspace_id: uuid.UUID,
    actor_id: uuid.UUID,
    actor_role: str,
    target_id: uuid.UUID,
) -> None:
    target = await _membership(session, workspace_id, target_id)
    if target is None:
        raise APIError(404, "member_not_found", "No such workspace member.")
    if target.role == "owner":
        raise APIError(403, "forbidden", "The workspace owner cannot be removed.")
    leaving = target_id == actor_id
    if not leaving:
        require_role(actor_role, "admin")
        if actor_role != "owner" and target.role == "admin":
            raise APIError(403, "forbidden", "Only the owner can remove admins.")
    await session.execute(
        delete(WorkspaceMember).where(
            WorkspaceMember.workspace_id == workspace_id,
            WorkspaceMember.user_id == target_id,
        )
    )
    await session.commit()


def _serialize_invitation(invitation: WorkspaceInvitation, *, token: str | None = None) -> dict:
    body = {
        "id": str(invitation.id),
        "role": invitation.role,
        "invited_email": invitation.invited_email,
        "created_at": _iso(invitation.created_at),
        "expires_at": _iso(invitation.expires_at),
    }
    if token is not None:
        body["token"] = token
    return body


async def list_invitations(
    session: AsyncSession, workspace_id: uuid.UUID, actor_role: str
) -> list[dict]:
    require_role(actor_role, "admin")
    result = await session.execute(
        select(WorkspaceInvitation)
        .where(
            WorkspaceInvitation.workspace_id == workspace_id,
            WorkspaceInvitation.accepted_at.is_(None),
            WorkspaceInvitation.revoked_at.is_(None),
            WorkspaceInvitation.expires_at > _now(),
        )
        .order_by(WorkspaceInvitation.created_at.desc())
    )
    return [_serialize_invitation(item) for item in result.scalars().all()]


async def create_invitation(
    session: AsyncSession,
    *,
    workspace_id: uuid.UUID,
    actor: User,
    actor_role: str,
    role: str,
    invited_email: str | None,
) -> dict:
    require_role(actor_role, "admin")
    if role not in ASSIGNABLE_ROLES:
        raise APIError(422, "validation_error", "Choose admin, member, or viewer.")
    token = generate_invitation_token()
    invitation = WorkspaceInvitation(
        workspace_id=workspace_id,
        role=role,
        token_hash=hash_opaque_token(token),
        invited_email=invited_email.strip().lower() if invited_email else None,
        created_by_user_id=actor.id,
        expires_at=_now() + timedelta(seconds=get_settings().invitation_ttl_seconds),
    )
    session.add(invitation)
    await session.commit()
    await session.refresh(invitation)
    return _serialize_invitation(invitation, token=token)


async def revoke_invitation(
    session: AsyncSession,
    *,
    workspace_id: uuid.UUID,
    invitation_id: uuid.UUID,
    actor_role: str,
) -> None:
    require_role(actor_role, "admin")
    invitation = await session.get(WorkspaceInvitation, invitation_id)
    if invitation is None or invitation.workspace_id != workspace_id:
        raise APIError(404, "invitation_not_found", "No such invitation.")
    invitation.revoked_at = _now()
    await session.commit()


async def preview_invitation(session: AsyncSession, token: str) -> dict:
    invitation = await _pending_invitation(session, token, lock=False)
    workspace = await session.get(Workspace, invitation.workspace_id)
    inviter = (
        await session.get(User, invitation.created_by_user_id)
        if invitation.created_by_user_id
        else None
    )
    return {
        "workspace_id": str(invitation.workspace_id),
        "workspace_name": workspace.name if workspace else "Workspace",
        "role": invitation.role,
        "invited_email": invitation.invited_email,
        "invited_by": inviter.display_name if inviter else None,
        "expires_at": _iso(invitation.expires_at),
    }


async def accept_invitation(session: AsyncSession, token: str, user: User) -> dict:
    invitation = await _pending_invitation(session, token, lock=True)
    membership = await _membership(session, invitation.workspace_id, user.id)
    if membership is None:
        session.add(
            WorkspaceMember(
                workspace_id=invitation.workspace_id,
                user_id=user.id,
                role=invitation.role,
            )
        )
    invitation.accepted_at = _now()
    invitation.accepted_by_user_id = user.id
    await session.commit()
    workspace = await session.get(Workspace, invitation.workspace_id)
    role = membership.role if membership is not None else invitation.role
    return {
        "id": str(workspace.id),
        "name": workspace.name,
        "role": role,
        "is_personal": workspace.is_personal,
    }


async def _pending_invitation(
    session: AsyncSession, token: str, *, lock: bool
) -> WorkspaceInvitation:
    query = select(WorkspaceInvitation).where(
        WorkspaceInvitation.token_hash == hash_opaque_token(token)
    )
    if lock:
        query = query.with_for_update()
    result = await session.execute(query)
    invitation = result.scalar_one_or_none()
    if (
        invitation is None
        or invitation.revoked_at is not None
        or invitation.accepted_at is not None
        or invitation.expires_at <= _now()
    ):
        raise APIError(404, "invitation_not_found", "This invitation is no longer valid.")
    return invitation
