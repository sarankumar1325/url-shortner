"""Account deletion: who owns what, and removing an account with its data."""

import uuid
from dataclasses import dataclass, field

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.core.problems import APIError
from backend.core.security import verify_password
from backend.models import User, Workspace, WorkspaceMember
from backend.services.auth import normalize_email
from backend.services.retired_codes import retire_workspace_codes


@dataclass
class OwnedWorkspace:
    id: uuid.UUID
    name: str
    members: int


@dataclass
class DeletionPlan:
    """Workspaces removed with the account, and shared ones that block it."""

    delete_workspace_ids: list[uuid.UUID] = field(default_factory=list)
    blocking: list[OwnedWorkspace] = field(default_factory=list)


async def deletion_plan(session: AsyncSession, user_id: uuid.UUID) -> DeletionPlan:
    counts = (
        select(WorkspaceMember.workspace_id, func.count().label("members"))
        .group_by(WorkspaceMember.workspace_id)
        .subquery()
    )
    result = await session.execute(
        select(Workspace.id, Workspace.name, Workspace.is_personal, WorkspaceMember.role)
        .add_columns(counts.c.members)
        .join(WorkspaceMember, WorkspaceMember.workspace_id == Workspace.id)
        .join(counts, counts.c.workspace_id == Workspace.id)
        .where(WorkspaceMember.user_id == user_id)
        .order_by(Workspace.created_at)
    )
    plan = DeletionPlan()
    for workspace_id, name, is_personal, role, members in result.all():
        if is_personal:
            plan.delete_workspace_ids.append(workspace_id)
        elif role == "owner":
            # Owners cannot be removed, so a shared workspace whose only member
            # is this owner has nobody left to hand it to.
            if members <= 1:
                plan.delete_workspace_ids.append(workspace_id)
            else:
                plan.blocking.append(OwnedWorkspace(workspace_id, name, members))
    return plan


def blocking_error(blocking: list[OwnedWorkspace]) -> APIError:
    names = ", ".join(item.name for item in blocking)
    return APIError(
        409,
        "owns_shared_workspaces",
        f"Transfer or delete these workspaces before deleting your account: {names}.",
        errors=[
            {
                "field": "workspaces",
                "code": "owned_shared_workspace",
                "message": f"{item.name} has {item.members - 1} other "
                f"member{'s' if item.members != 2 else ''}.",
                "workspace_id": str(item.id),
                "name": item.name,
            }
            for item in blocking
        ],
    )


async def purge_account(session: AsyncSession, user: User, plan: DeletionPlan) -> list[str]:
    """Delete the account and the workspaces in the plan; returns retired codes.

    Sessions and memberships cascade with the user; links the user created in
    other people's workspaces stay there with their creator cleared.
    """
    codes = await retire_workspace_codes(session, plan.delete_workspace_ids, "account_deleted")
    if plan.delete_workspace_ids:
        await session.execute(delete(Workspace).where(Workspace.id.in_(plan.delete_workspace_ids)))
    await session.execute(delete(User).where(User.id == user.id))
    await session.commit()
    return codes


async def delete_account(
    session: AsyncSession,
    *,
    user: User,
    password: str,
    confirm_email: str,
) -> list[str]:
    if not verify_password(password, user.password_hash):
        raise APIError(
            403,
            "invalid_password",
            "The password is incorrect.",
            errors=[
                {"field": "password", "code": "invalid", "message": "The password is incorrect."}
            ],
        )
    if normalize_email(confirm_email) != user.email:
        raise APIError(
            422,
            "confirmation_mismatch",
            "Type your account email exactly to confirm deletion.",
            errors=[
                {
                    "field": "confirm_email",
                    "code": "mismatch",
                    "message": "This does not match your account email.",
                }
            ],
        )
    plan = await deletion_plan(session, user.id)
    if plan.blocking:
        raise blocking_error(plan.blocking)
    return await purge_account(session, user, plan)
