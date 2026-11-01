"""link passwords and smart redirect rules

Revision ID: a4c7e2d91f06
Revises: c8e2f5a93b17
Create Date: 2026-11-20 10:00:00.000000

"""

from typing import Sequence, Union

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "a4c7e2d91f06"
down_revision: Union[str, Sequence[str], None] = "c8e2f5a93b17"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Expand-only: both columns are nullable, so the previous release keeps
    # reading and writing links without knowing about them.
    op.add_column("urls", sa.Column("password_hash", sa.Text(), nullable=True))
    op.add_column(
        "urls",
        sa.Column("redirect_rules", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    )
    op.create_check_constraint(
        "urls_redirect_rules_array",
        "urls",
        "redirect_rules IS NULL OR jsonb_typeof(redirect_rules) = 'array'",
    )


def downgrade() -> None:
    op.drop_constraint("urls_redirect_rules_array", "urls", type_="check")
    op.drop_column("urls", "redirect_rules")
    op.drop_column("urls", "password_hash")
