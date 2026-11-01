"""Delete accounts whose email matches a SQL LIKE pattern.

Dry run by default; nothing changes without --yes. Run from backend/ so the
database settings in .env are picked up:

    uv run python -m backend.scripts.delete_accounts --email-like 'qa-droid-%@example.com'
    uv run python -m backend.scripts.delete_accounts --email-like 'qa-droid-%@example.com' --yes

Accounts that still own shared workspaces with other members are skipped,
the same rule the API applies.
"""

import argparse
import asyncio
import sys

from sqlalchemy import func, select

from backend.api.routes.redirect import invalidate_caches
from backend.core.db import get_engine, get_session_factory
from backend.core.redis import aclose
from backend.models import Url, User
from backend.services import accounts


def check_pattern(pattern: str) -> str | None:
    """Refuse patterns broad enough to sweep up real accounts."""
    if "@" not in pattern:
        return "The pattern must include an @ and a domain."
    prefix = pattern.split("%", 1)[0].split("_", 1)[0]
    if len(prefix) < 3:
        return "The pattern must start with at least 3 literal characters."
    return None


async def run(pattern: str, *, yes: bool) -> int:
    factory = get_session_factory()
    async with factory() as session:
        result = await session.execute(
            select(User).where(User.email.like(pattern)).order_by(User.created_at)
        )
        users = list(result.scalars().all())
        if not users:
            print(f"No accounts match {pattern!r}.")
            return 0

        plans = {}
        print(f"{len(users)} account(s) match {pattern!r}:")
        for user in users:
            plan = await accounts.deletion_plan(session, user.id)
            plans[user.id] = plan
            links = 0
            if plan.delete_workspace_ids:
                links = (
                    await session.execute(
                        select(func.count())
                        .select_from(Url)
                        .where(Url.workspace_id.in_(plan.delete_workspace_ids))
                    )
                ).scalar_one()
            note = ""
            if plan.blocking:
                names = ", ".join(item.name for item in plan.blocking)
                note = f"  SKIP: owns shared workspaces with members ({names})"
            print(
                f"  {user.email}  {user.display_name!r}  created {user.created_at:%Y-%m-%d}  "
                f"workspaces={len(plan.delete_workspace_ids)} links={links}{note}"
            )

        if not yes:
            print("Dry run: nothing was deleted. Re-run with --yes to delete.")
            return 0

        deleted = 0
        for user in users:
            plan = plans[user.id]
            if plan.blocking:
                continue
            codes = await accounts.purge_account(session, user, plan)
            await invalidate_caches(codes)
            deleted += 1
            print(f"Deleted {user.email} ({len(codes)} short codes retired).")
        print(f"Deleted {deleted} of {len(users)} account(s).")
        return 0


async def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--email-like", required=True, help="SQL LIKE pattern, e.g. qa-%%@x.com")
    parser.add_argument("--yes", action="store_true", help="Actually delete (default: dry run)")
    args = parser.parse_args(argv)
    problem = check_pattern(args.email_like)
    if problem:
        print(problem, file=sys.stderr)
        return 2
    try:
        return await run(args.email_like, yes=args.yes)
    finally:
        await aclose()
        await get_engine().dispose()


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
