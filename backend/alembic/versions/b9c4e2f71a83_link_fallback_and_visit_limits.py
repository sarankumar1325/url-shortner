"""link fallback destination and visit limits

Also merges the two heads that both followed d5a1c8f37e42.

Revision ID: b9c4e2f71a83
Revises: e7b3a9c14d52, f6a2b8c31d40
Create Date: 2026-10-31 12:00:00.000000

"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "b9c4e2f71a83"
down_revision: Union[str, Sequence[str], None] = ("e7b3a9c14d52", "f6a2b8c31d40")
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("urls", sa.Column("fallback_url", sa.Text(), nullable=True))
    op.add_column("urls", sa.Column("max_clicks", sa.Integer(), nullable=True))
    op.add_column(
        "urls",
        sa.Column("clicks_used", sa.Integer(), server_default=sa.text("0"), nullable=False),
    )
    op.create_check_constraint(
        "urls_fallback_url_length",
        "urls",
        "fallback_url IS NULL OR char_length(fallback_url) BETWEEN 1 AND 8192",
    )
    op.create_check_constraint(
        "urls_max_clicks_range",
        "urls",
        "max_clicks IS NULL OR max_clicks BETWEEN 1 AND 1000000",
    )
    op.create_check_constraint("urls_clicks_used_nonnegative", "urls", "clicks_used >= 0")


def downgrade() -> None:
    op.drop_constraint("urls_clicks_used_nonnegative", "urls", type_="check")
    op.drop_constraint("urls_max_clicks_range", "urls", type_="check")
    op.drop_constraint("urls_fallback_url_length", "urls", type_="check")
    op.drop_column("urls", "clicks_used")
    op.drop_column("urls", "max_clicks")
    op.drop_column("urls", "fallback_url")
