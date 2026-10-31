"""replay rows cascade with links

Revision ID: c2d8e1a46f90
Revises: b1f4c7d92a30
Create Date: 2026-10-24 17:20:00.000000

"""

from typing import Sequence, Union

from alembic import op

revision: str = "c2d8e1a46f90"
down_revision: Union[str, Sequence[str], None] = "b1f4c7d92a30"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # SET NULL left encrypted_response populated and violated
    # replay_state_consistency whenever a link was hard-deleted.
    op.drop_constraint("create_requests_url_id_fkey", "create_requests", type_="foreignkey")
    op.create_foreign_key(
        "create_requests_url_id_fkey",
        "create_requests",
        "urls",
        ["url_id"],
        ["id"],
        ondelete="CASCADE",
    )


def downgrade() -> None:
    op.drop_constraint("create_requests_url_id_fkey", "create_requests", type_="foreignkey")
    op.create_foreign_key(
        "create_requests_url_id_fkey",
        "create_requests",
        "urls",
        ["url_id"],
        ["id"],
        ondelete="SET NULL",
    )
