"""Short codes are never reissued, even after their rows are hard-deleted.

Soft-deleted links keep their row, which already blocks reuse. Deleting a
workspace or an account removes the rows, so their codes are copied here first
and link creation and alias checks consult this table as well.
"""

import uuid

from sqlalchemy import exists, insert, literal, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.models import RetiredShortCode, Url


async def retire_workspace_codes(
    session: AsyncSession, workspace_ids: list[uuid.UUID], reason: str
) -> list[str]:
    """Record every code in these workspaces, deleted links included."""
    if not workspace_ids:
        return []
    result = await session.execute(
        select(Url.short_code).where(Url.workspace_id.in_(workspace_ids))
    )
    codes = list(result.scalars().all())
    if not codes:
        return []
    already = exists().where(RetiredShortCode.short_code == Url.short_code)
    await session.execute(
        insert(RetiredShortCode).from_select(
            ["short_code", "reason"],
            select(Url.short_code, literal(reason)).where(
                Url.workspace_id.in_(workspace_ids), ~already
            ),
        )
    )
    return codes


async def is_retired(session: AsyncSession, code: str) -> bool:
    result = await session.execute(
        select(RetiredShortCode.short_code).where(RetiredShortCode.short_code == code)
    )
    return result.scalar_one_or_none() is not None
