"""shorten generated codes

Revision ID: a7e3c9f14b20
Revises: dd94a333e872
Create Date: 2026-10-24 14:10:00.000000

"""

from typing import Sequence, Union

from alembic import op


# revision identifiers, used by Alembic.
revision: str = "a7e3c9f14b20"
down_revision: Union[str, Sequence[str], None] = "dd94a333e872"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

OLD_CHECK = (
    "(is_custom_alias AND short_code ~ '^[a-z0-9][a-z0-9_-]{1,30}[a-z0-9]$') "
    "OR (NOT is_custom_alias AND short_code ~ '^[A-Za-z0-9]{7}$')"
)
NEW_CHECK = (
    "(is_custom_alias AND short_code ~ '^[a-z0-9][a-z0-9_-]{1,30}[a-z0-9]$') "
    "OR (NOT is_custom_alias AND short_code ~ '^[A-Za-z0-9]{5,7}$')"
)


def upgrade() -> None:
    """Allow 5-character generated codes while keeping existing 7-char codes."""
    op.drop_constraint("short_code_format", "urls", type_="check")
    op.create_check_constraint("short_code_format", "urls", NEW_CHECK)


def downgrade() -> None:
    """Restore the 7-character rule; fails if shorter codes already exist."""
    op.drop_constraint("short_code_format", "urls", type_="check")
    op.create_check_constraint("short_code_format", "urls", OLD_CHECK)
