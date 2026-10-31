"""public identifier for user sessions

Revision ID: e7b3a9c14d52
Revises: d5a1c8f37e42
Create Date: 2026-10-25 13:10:00.000000

"""

from typing import Sequence, Union

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "e7b3a9c14d52"
down_revision: Union[str, Sequence[str], None] = "d5a1c8f37e42"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "user_sessions",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.execute("UPDATE user_sessions SET id = gen_random_uuid() WHERE id IS NULL")
    op.alter_column("user_sessions", "id", nullable=False)
    op.create_unique_constraint("user_sessions_id_key", "user_sessions", ["id"])


def downgrade() -> None:
    op.drop_constraint("user_sessions_id_key", "user_sessions", type_="unique")
    op.drop_column("user_sessions", "id")
