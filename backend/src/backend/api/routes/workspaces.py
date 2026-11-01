from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel, ConfigDict, EmailStr, Field
from sqlalchemy.ext.asyncio import AsyncSession

from backend.api.deps import (
    client_ip,
    enforce_same_origin,
    get_api_session,
    require_user,
    validate_body_size,
)
from backend.api.routes.redirect import invalidate_caches
from backend.core.problems import APIError
from backend.models import User
from backend.services import ratelimit
from backend.services import workspaces as workspace_service

router = APIRouter(tags=["workspaces"])

Role = Literal["admin", "member", "viewer"]


class CreateWorkspaceRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=80)


class RenameWorkspaceRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=80)


class DeleteWorkspaceRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    confirm_name: str = Field(min_length=1, max_length=80)


class TransferOwnershipRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    user_id: UUID


class UpdateMemberRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    role: Role


class InviteRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    role: Role = "member"
    email: EmailStr | None = None


async def _context(session: AsyncSession, user: User, workspace_id: UUID):
    return await workspace_service.get_workspace_context(session, user.id, workspace_id)


@router.post(
    "/workspaces",
    status_code=201,
    summary="Create a shared workspace",
    dependencies=[Depends(validate_body_size), Depends(enforce_same_origin)],
)
async def create_workspace(
    payload: CreateWorkspaceRequest,
    request: Request,
    user: User = Depends(require_user),
    session: AsyncSession = Depends(get_api_session),
) -> dict:
    allowed, retry_after = await ratelimit.check_rate_limit(f"workspace-create:{user.id}", 10, 3600)
    if not allowed:
        raise APIError(
            429, "rate_limited", "Too many requests.", headers={"Retry-After": str(retry_after)}
        )
    return await workspace_service.create_workspace(session, user, payload.name)


@router.patch(
    "/workspaces/{workspace_id}",
    summary="Rename a workspace",
    dependencies=[Depends(validate_body_size), Depends(enforce_same_origin)],
)
async def rename_workspace(
    workspace_id: UUID,
    payload: RenameWorkspaceRequest,
    user: User = Depends(require_user),
    session: AsyncSession = Depends(get_api_session),
) -> dict:
    workspace, role = await _context(session, user, workspace_id)
    return await workspace_service.rename_workspace(
        session, workspace=workspace, actor_role=role, name=payload.name
    )


@router.delete(
    "/workspaces/{workspace_id}",
    status_code=204,
    summary="Delete a shared workspace",
    dependencies=[Depends(validate_body_size), Depends(enforce_same_origin)],
)
async def delete_workspace(
    workspace_id: UUID,
    payload: DeleteWorkspaceRequest,
    user: User = Depends(require_user),
    session: AsyncSession = Depends(get_api_session),
) -> Response:
    workspace, _ = await _context(session, user, workspace_id)
    codes = await workspace_service.delete_workspace(
        session,
        workspace=workspace,
        actor_id=user.id,
        confirm_name=payload.confirm_name,
    )
    await invalidate_caches(codes)
    return Response(status_code=204)


@router.post(
    "/workspaces/{workspace_id}/transfer-ownership",
    status_code=204,
    summary="Transfer workspace ownership",
    dependencies=[Depends(validate_body_size), Depends(enforce_same_origin)],
)
async def transfer_ownership(
    workspace_id: UUID,
    payload: TransferOwnershipRequest,
    user: User = Depends(require_user),
    session: AsyncSession = Depends(get_api_session),
) -> Response:
    workspace, _ = await _context(session, user, workspace_id)
    await workspace_service.transfer_ownership(
        session,
        workspace=workspace,
        actor_id=user.id,
        target_id=payload.user_id,
    )
    return Response(status_code=204)


@router.get("/workspaces/{workspace_id}/members", summary="List workspace members")
async def list_members(
    workspace_id: UUID,
    user: User = Depends(require_user),
    session: AsyncSession = Depends(get_api_session),
) -> list[dict]:
    await _context(session, user, workspace_id)
    return await workspace_service.list_members(session, workspace_id)


@router.patch(
    "/workspaces/{workspace_id}/members/{member_id}",
    summary="Change a member role",
    dependencies=[Depends(enforce_same_origin)],
)
async def update_member(
    workspace_id: UUID,
    member_id: UUID,
    payload: UpdateMemberRequest,
    user: User = Depends(require_user),
    session: AsyncSession = Depends(get_api_session),
) -> dict:
    _, role = await _context(session, user, workspace_id)
    await workspace_service.change_member_role(
        session,
        workspace_id=workspace_id,
        actor_id=user.id,
        actor_role=role,
        target_id=member_id,
        new_role=payload.role,
    )
    return {"user_id": str(member_id), "role": payload.role}


@router.delete(
    "/workspaces/{workspace_id}/members/{member_id}",
    status_code=204,
    summary="Remove a member or leave a workspace",
    dependencies=[Depends(enforce_same_origin)],
)
async def remove_member(
    workspace_id: UUID,
    member_id: UUID,
    user: User = Depends(require_user),
    session: AsyncSession = Depends(get_api_session),
) -> Response:
    _, role = await _context(session, user, workspace_id)
    await workspace_service.remove_member(
        session,
        workspace_id=workspace_id,
        actor_id=user.id,
        actor_role=role,
        target_id=member_id,
    )
    return Response(status_code=204)


@router.get("/workspaces/{workspace_id}/invitations", summary="List pending invitations")
async def list_invitations(
    workspace_id: UUID,
    user: User = Depends(require_user),
    session: AsyncSession = Depends(get_api_session),
) -> list[dict]:
    _, role = await _context(session, user, workspace_id)
    return await workspace_service.list_invitations(session, workspace_id, role)


@router.post(
    "/workspaces/{workspace_id}/invitations",
    status_code=201,
    summary="Invite someone to the workspace",
    dependencies=[Depends(validate_body_size), Depends(enforce_same_origin)],
)
async def create_invitation(
    workspace_id: UUID,
    payload: InviteRequest,
    user: User = Depends(require_user),
    session: AsyncSession = Depends(get_api_session),
) -> dict:
    _, role = await _context(session, user, workspace_id)
    return await workspace_service.create_invitation(
        session,
        workspace_id=workspace_id,
        actor=user,
        actor_role=role,
        role=payload.role,
        invited_email=str(payload.email) if payload.email else None,
    )


@router.delete(
    "/workspaces/{workspace_id}/invitations/{invitation_id}",
    status_code=204,
    summary="Revoke an invitation",
    dependencies=[Depends(enforce_same_origin)],
)
async def revoke_invitation(
    workspace_id: UUID,
    invitation_id: UUID,
    user: User = Depends(require_user),
    session: AsyncSession = Depends(get_api_session),
) -> Response:
    _, role = await _context(session, user, workspace_id)
    await workspace_service.revoke_invitation(
        session,
        workspace_id=workspace_id,
        invitation_id=invitation_id,
        actor_role=role,
    )
    return Response(status_code=204)


@router.get("/invitations/{token}", summary="Preview an invitation")
async def preview_invitation(
    token: str,
    request: Request,
    session: AsyncSession = Depends(get_api_session),
) -> dict:
    allowed, retry_after = await ratelimit.check_rate_limit(
        f"invite-preview:{client_ip(request)}", 60
    )
    if not allowed:
        raise APIError(
            429, "rate_limited", "Too many requests.", headers={"Retry-After": str(retry_after)}
        )
    return await workspace_service.preview_invitation(session, token)


@router.post(
    "/invitations/{token}/accept",
    summary="Accept an invitation",
    dependencies=[Depends(enforce_same_origin)],
)
async def accept_invitation(
    token: str,
    user: User = Depends(require_user),
    session: AsyncSession = Depends(get_api_session),
) -> dict:
    return await workspace_service.accept_invitation(session, token, user)
