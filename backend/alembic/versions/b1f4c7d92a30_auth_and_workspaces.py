"""auth, workspaces, and tenant-scoped links

Revision ID: b1f4c7d92a30
Revises: a7e3c9f14b20
Create Date: 2026-10-24 16:20:00.000000

"""

from typing import Sequence, Union

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "b1f4c7d92a30"
down_revision: Union[str, Sequence[str], None] = "a7e3c9f14b20"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "users",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("email", sa.String(length=320), nullable=False),
        sa.Column("password_hash", sa.Text(), nullable=False),
        sa.Column("display_name", sa.String(length=80), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint("char_length(display_name) BETWEEN 1 AND 80"),
        sa.CheckConstraint("char_length(email) BETWEEN 3 AND 320"),
        sa.CheckConstraint("email = lower(email)", name="email_lowercase"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("email"),
    )
    op.create_table(
        "workspaces",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("name", sa.String(length=80), nullable=False),
        sa.Column("is_personal", sa.Boolean(), nullable=False),
        sa.Column("personal_user_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint("char_length(name) BETWEEN 1 AND 80"),
        sa.CheckConstraint(
            "(is_personal AND personal_user_id IS NOT NULL) OR "
            "(NOT is_personal AND personal_user_id IS NULL)",
            name="personal_workspace_owner",
        ),
        sa.ForeignKeyConstraint(["personal_user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("personal_user_id"),
    )
    op.create_table(
        "user_sessions",
        sa.Column("token_hash", sa.LargeBinary(length=32), nullable=False),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("expires_at > created_at"),
        sa.CheckConstraint("octet_length(token_hash) = 32"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("token_hash"),
    )
    op.create_index("user_sessions_expiry_idx", "user_sessions", ["expires_at"], unique=False)
    op.create_index("user_sessions_user_idx", "user_sessions", ["user_id"], unique=False)
    op.create_table(
        "workspace_members",
        sa.Column("workspace_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("role", sa.String(length=16), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "role IN ('owner','admin','member','viewer')",
            name="workspace_role_domain",
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["workspace_id"], ["workspaces.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("workspace_id", "user_id"),
    )
    op.create_index("workspace_members_user_idx", "workspace_members", ["user_id"], unique=False)
    op.create_table(
        "workspace_invitations",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("workspace_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("role", sa.String(length=16), nullable=False),
        sa.Column("token_hash", sa.LargeBinary(length=32), nullable=False),
        sa.Column("invited_email", sa.String(length=320), nullable=True),
        sa.Column("created_by_user_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("accepted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("accepted_by_user_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("expires_at > created_at"),
        sa.CheckConstraint("octet_length(token_hash) = 32"),
        sa.CheckConstraint("role IN ('admin','member','viewer')", name="invitation_role_domain"),
        sa.ForeignKeyConstraint(["accepted_by_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["created_by_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["workspace_id"], ["workspaces.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("token_hash"),
    )
    op.create_index(
        "workspace_invitations_workspace_idx",
        "workspace_invitations",
        ["workspace_id"],
        unique=False,
    )

    op.add_column("urls", sa.Column("workspace_id", postgresql.UUID(as_uuid=True), nullable=True))
    op.add_column(
        "urls", sa.Column("created_by_user_id", postgresql.UUID(as_uuid=True), nullable=True)
    )
    op.alter_column(
        "urls", "management_token_hash", existing_type=sa.LargeBinary(32), nullable=True
    )
    op.alter_column("urls", "token_hash_version", existing_type=sa.SmallInteger, nullable=True)
    op.create_foreign_key(
        "urls_workspace_id_fkey",
        "urls",
        "workspaces",
        ["workspace_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.create_foreign_key(
        "urls_created_by_user_id_fkey",
        "urls",
        "users",
        ["created_by_user_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_check_constraint(
        "management_scope",
        "urls",
        "(workspace_id IS NULL AND management_token_hash IS NOT NULL "
        "AND token_hash_version IS NOT NULL) "
        "OR (workspace_id IS NOT NULL AND management_token_hash IS NULL "
        "AND token_hash_version IS NULL)",
    )
    op.create_index(
        "urls_workspace_created_idx", "urls", ["workspace_id", "created_at"], unique=False
    )


def downgrade() -> None:
    op.drop_index("urls_workspace_created_idx", table_name="urls")
    op.drop_constraint("management_scope", "urls", type_="check")
    # Workspace links cannot exist in the token-only model.
    op.execute("DELETE FROM urls WHERE workspace_id IS NOT NULL")
    op.drop_constraint("urls_created_by_user_id_fkey", "urls", type_="foreignkey")
    op.drop_constraint("urls_workspace_id_fkey", "urls", type_="foreignkey")
    op.alter_column("urls", "token_hash_version", existing_type=sa.SmallInteger(), nullable=False)
    op.alter_column(
        "urls", "management_token_hash", existing_type=sa.LargeBinary(32), nullable=False
    )
    op.drop_column("urls", "created_by_user_id")
    op.drop_column("urls", "workspace_id")

    op.drop_index("workspace_invitations_workspace_idx", table_name="workspace_invitations")
    op.drop_table("workspace_invitations")
    op.drop_index("workspace_members_user_idx", table_name="workspace_members")
    op.drop_table("workspace_members")
    op.drop_index("user_sessions_user_idx", table_name="user_sessions")
    op.drop_index("user_sessions_expiry_idx", table_name="user_sessions")
    op.drop_table("user_sessions")
    op.drop_table("workspaces")
    op.drop_table("users")
