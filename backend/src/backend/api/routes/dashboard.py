from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from backend.api.deps import WorkspaceContext, get_api_session, get_workspace_context
from backend.core.config import get_settings
from backend.core.problems import APIError
from backend.services import analytics, dashboard

router = APIRouter(prefix="/dashboard", tags=["dashboard"])


@router.get("", summary="Traffic and health across every link in the active workspace")
async def workspace_dashboard(
    days: int = Query(default=30),
    session: AsyncSession = Depends(get_api_session),
    context: WorkspaceContext = Depends(get_workspace_context),
) -> dict:
    if days not in dashboard.ALLOWED_DAYS:
        raise APIError(422, "validation_error", "days must be 7, 30 or 90.")
    # A failed drain rolls the session back and expires loaded objects, so read ids first.
    workspace_id = context.workspace.id
    if get_settings().drain_on_read:
        await analytics.drain_events(session, max_events=analytics.READ_DRAIN_LIMIT)
    return await dashboard.workspace_dashboard(session, workspace_id, days)
