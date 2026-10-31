"""invitation expiry index for retention cleanup

Revision ID: d5a1c8f37e42
Revises: c2d8e1a46f90
Create Date: 2026-10-25 12:00:00.000000

"""

from typing import Sequence, Union

from alembic import op

revision: str = "d5a1c8f37e42"
down_revision: Union[str, Sequence[str], None] = "c2d8e1a46f90"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_index(
        "workspace_invitations_expiry_idx",
        "workspace_invitations",
        ["expires_at"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("workspace_invitations_expiry_idx", table_name="workspace_invitations")
