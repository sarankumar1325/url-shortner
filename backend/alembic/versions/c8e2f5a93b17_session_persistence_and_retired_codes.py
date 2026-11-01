"""stay signed in flag on sessions and retired short codes

Revision ID: c8e2f5a93b17
Revises: b9c4e2f71a83
Create Date: 2026-11-01 10:00:00.000000

"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "c8e2f5a93b17"
down_revision: Union[str, Sequence[str], None] = "b9c4e2f71a83"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Expand-only: the server default keeps the previous release's inserts valid,
    # and existing sessions were all issued as 30-day sessions.
    op.add_column(
        "user_sessions",
        sa.Column("persistent", sa.Boolean(), server_default=sa.text("true"), nullable=False),
    )
    op.create_table(
        "retired_short_codes",
        sa.Column("short_code", sa.String(length=32), nullable=False),
        sa.Column("reason", sa.String(length=24), nullable=False),
        sa.Column(
            "retired_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "reason IN ('account_deleted','workspace_deleted')",
            name="retired_reason_domain",
        ),
        sa.PrimaryKeyConstraint("short_code"),
    )


def downgrade() -> None:
    op.drop_table("retired_short_codes")
    op.drop_column("user_sessions", "persistent")
