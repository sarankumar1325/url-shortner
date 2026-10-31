"""link tags and abuse reports

Revision ID: f6a2b8c31d40
Revises: d5a1c8f37e42
Create Date: 2026-10-25 14:00:00.000000

"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "f6a2b8c31d40"
down_revision: Union[str, Sequence[str], None] = "d5a1c8f37e42"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "url_tags",
        sa.Column(
            "url_id",
            sa.BigInteger(),
            sa.ForeignKey("urls.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("tag", sa.String(length=24), nullable=False),
        sa.CheckConstraint("tag ~ '^[a-z0-9]([a-z0-9-]{0,22}[a-z0-9])?$'", name="tag_format"),
        sa.PrimaryKeyConstraint("url_id", "tag"),
    )
    op.create_index("url_tags_tag_idx", "url_tags", ["tag", "url_id"], unique=False)

    op.create_table(
        "abuse_reports",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("short_code", sa.String(length=32), nullable=False),
        sa.Column(
            "url_id",
            sa.BigInteger(),
            sa.ForeignKey("urls.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("reason", sa.String(length=16), nullable=False),
        sa.Column("details", sa.Text(), nullable=True),
        sa.Column("reporter_email", sa.String(length=320), nullable=True),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "reason IN ('spam','phishing','malware','impersonation','other')",
            name="abuse_reason_domain",
        ),
        sa.CheckConstraint("status IN ('open','resolved')", name="abuse_status_domain"),
        sa.CheckConstraint(
            "details IS NULL OR char_length(details) <= 2000",
            name="abuse_reports_details_check",
        ),
        sa.CheckConstraint(
            "reporter_email IS NULL OR char_length(reporter_email) BETWEEN 3 AND 320",
            name="abuse_reports_reporter_email_check",
        ),
        sa.CheckConstraint(
            "short_code ~ '^[A-Za-z0-9_-]{1,32}$'",
            name="abuse_short_code_format",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "abuse_reports_status_created_idx",
        "abuse_reports",
        ["status", "created_at"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("abuse_reports_status_created_idx", table_name="abuse_reports")
    op.drop_table("abuse_reports")
    op.drop_index("url_tags_tag_idx", table_name="url_tags")
    op.drop_table("url_tags")
