import uuid
from datetime import date, datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Identity,
    Index,
    Integer,
    LargeBinary,
    SmallInteger,
    String,
    Text,
    func,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    email: Mapped[str] = mapped_column(String(320), unique=True, nullable=False)
    password_hash: Mapped[str] = mapped_column(Text, nullable=False)
    display_name: Mapped[str] = mapped_column(String(80), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )

    __table_args__ = (
        CheckConstraint("email = lower(email)", name="email_lowercase"),
        CheckConstraint("char_length(email) BETWEEN 3 AND 320"),
        CheckConstraint("char_length(display_name) BETWEEN 1 AND 80"),
    )


class UserSession(Base):
    __tablename__ = "user_sessions"

    token_hash: Mapped[bytes] = mapped_column(LargeBinary(32), primary_key=True)
    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), nullable=False, default=uuid.uuid4, unique=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    # "Stay signed in": persistent sessions get a 30-day renewing cookie; the
    # others get a browser-session cookie and a short server-side lifetime.
    persistent: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default="true"
    )

    __table_args__ = (
        CheckConstraint("octet_length(token_hash) = 32"),
        CheckConstraint("expires_at > created_at"),
        Index("user_sessions_user_idx", "user_id"),
        Index("user_sessions_expiry_idx", "expires_at"),
    )


class Workspace(Base):
    __tablename__ = "workspaces"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(80), nullable=False)
    is_personal: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    personal_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), unique=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )

    __table_args__ = (
        CheckConstraint("char_length(name) BETWEEN 1 AND 80"),
        CheckConstraint(
            "(is_personal AND personal_user_id IS NOT NULL) "
            "OR (NOT is_personal AND personal_user_id IS NULL)",
            name="personal_workspace_owner",
        ),
    )


class WorkspaceMember(Base):
    __tablename__ = "workspace_members"

    workspace_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("workspaces.id", ondelete="CASCADE"),
        primary_key=True,
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        primary_key=True,
    )
    role: Mapped[str] = mapped_column(String(16), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    __table_args__ = (
        CheckConstraint(
            "role IN ('owner','admin','member','viewer')", name="workspace_role_domain"
        ),
        Index("workspace_members_user_idx", "user_id"),
    )


class WorkspaceInvitation(Base):
    __tablename__ = "workspace_invitations"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    workspace_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("workspaces.id", ondelete="CASCADE"),
        nullable=False,
    )
    role: Mapped[str] = mapped_column(String(16), nullable=False)
    token_hash: Mapped[bytes] = mapped_column(LargeBinary(32), unique=True, nullable=False)
    invited_email: Mapped[str | None] = mapped_column(String(320))
    created_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL")
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    accepted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    accepted_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL")
    )
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        CheckConstraint("role IN ('admin','member','viewer')", name="invitation_role_domain"),
        CheckConstraint("octet_length(token_hash) = 32"),
        CheckConstraint("expires_at > created_at"),
        Index("workspace_invitations_workspace_idx", "workspace_id"),
        Index("workspace_invitations_expiry_idx", "expires_at"),
    )


class Url(Base):
    __tablename__ = "urls"

    id: Mapped[int] = mapped_column(BigInteger, Identity(always=True), primary_key=True)
    short_code: Mapped[str] = mapped_column(String(32), unique=True, nullable=False)
    long_url: Mapped[str] = mapped_column(Text, nullable=False)
    workspace_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("workspaces.id", ondelete="CASCADE")
    )
    created_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL")
    )
    management_token_hash: Mapped[bytes | None] = mapped_column(LargeBinary(32))
    token_hash_version: Mapped[int | None] = mapped_column(SmallInteger)
    is_custom_alias: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    is_blocked: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Where visitors go once the link has expired or used up its visit limit.
    fallback_url: Mapped[str | None] = mapped_column(Text)
    max_clicks: Mapped[int | None] = mapped_column(Integer)
    clicks_used: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        CheckConstraint("char_length(long_url) BETWEEN 1 AND 8192"),
        CheckConstraint("octet_length(management_token_hash) = 32"),
        CheckConstraint("token_hash_version > 0"),
        CheckConstraint(
            "(is_custom_alias AND short_code ~ '^[a-z0-9][a-z0-9_-]{1,30}[a-z0-9]$') "
            "OR (NOT is_custom_alias AND short_code ~ '^[A-Za-z0-9]{5,7}$')",
            name="short_code_format",
        ),
        CheckConstraint(
            "(workspace_id IS NULL AND management_token_hash IS NOT NULL "
            "AND token_hash_version IS NOT NULL) "
            "OR (workspace_id IS NOT NULL AND management_token_hash IS NULL "
            "AND token_hash_version IS NULL)",
            name="management_scope",
        ),
        CheckConstraint("expires_at IS NULL OR expires_at > created_at"),
        CheckConstraint(
            "fallback_url IS NULL OR char_length(fallback_url) BETWEEN 1 AND 8192",
            name="urls_fallback_url_length",
        ),
        CheckConstraint(
            "max_clicks IS NULL OR max_clicks BETWEEN 1 AND 1000000",
            name="urls_max_clicks_range",
        ),
        CheckConstraint("clicks_used >= 0", name="urls_clicks_used_nonnegative"),
        Index("urls_workspace_created_idx", "workspace_id", "created_at"),
    )


class RetiredShortCode(Base):
    """Codes whose rows were hard-deleted; they are never issued again."""

    __tablename__ = "retired_short_codes"

    short_code: Mapped[str] = mapped_column(String(32), primary_key=True)
    reason: Mapped[str] = mapped_column(String(24), nullable=False)
    retired_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    __table_args__ = (
        CheckConstraint(
            "reason IN ('account_deleted','workspace_deleted')",
            name="retired_reason_domain",
        ),
    )


class UrlTag(Base):
    __tablename__ = "url_tags"

    url_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("urls.id", ondelete="CASCADE"), primary_key=True
    )
    tag: Mapped[str] = mapped_column(String(24), primary_key=True)

    __table_args__ = (
        CheckConstraint("tag ~ '^[a-z0-9]([a-z0-9-]{0,22}[a-z0-9])?$'", name="tag_format"),
        Index("url_tags_tag_idx", "tag", "url_id"),
    )


class AbuseReport(Base):
    __tablename__ = "abuse_reports"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    short_code: Mapped[str] = mapped_column(String(32), nullable=False)
    url_id: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("urls.id", ondelete="SET NULL")
    )
    reason: Mapped[str] = mapped_column(String(16), nullable=False)
    details: Mapped[str | None] = mapped_column(Text)
    reporter_email: Mapped[str | None] = mapped_column(String(320))
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="open")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        CheckConstraint(
            "reason IN ('spam','phishing','malware','impersonation','other')",
            name="abuse_reason_domain",
        ),
        CheckConstraint("status IN ('open','resolved')", name="abuse_status_domain"),
        CheckConstraint(
            "details IS NULL OR char_length(details) <= 2000",
            name="abuse_reports_details_check",
        ),
        CheckConstraint(
            "reporter_email IS NULL OR char_length(reporter_email) BETWEEN 3 AND 320",
            name="abuse_reports_reporter_email_check",
        ),
        CheckConstraint("short_code ~ '^[A-Za-z0-9_-]{1,32}$'", name="abuse_short_code_format"),
        Index("abuse_reports_status_created_idx", "status", "created_at"),
    )


class CreateRequest(Base):
    __tablename__ = "create_requests"

    key_hash: Mapped[bytes] = mapped_column(LargeBinary(32), primary_key=True)
    request_hash: Mapped[bytes] = mapped_column(LargeBinary(32), nullable=False)
    url_id: Mapped[int | None] = mapped_column(
        ForeignKey("urls.id", ondelete="CASCADE"), unique=True
    )
    encrypted_response: Mapped[bytes | None] = mapped_column(LargeBinary)
    encryption_key_id: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)

    __table_args__ = (
        CheckConstraint("octet_length(key_hash) = 32"),
        CheckConstraint("octet_length(request_hash) = 32"),
        CheckConstraint("expires_at > created_at"),
        CheckConstraint(
            "(url_id IS NULL AND encrypted_response IS NULL AND encryption_key_id IS NULL) "
            "OR (url_id IS NOT NULL AND encrypted_response IS NOT NULL "
            "AND encryption_key_id IS NOT NULL)",
            name="replay_state_consistency",
        ),
        Index("create_requests_expiry_idx", "expires_at"),
    )


class Click(Base):
    __tablename__ = "clicks"

    event_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    url_id: Mapped[int] = mapped_column(ForeignKey("urls.id", ondelete="CASCADE"), nullable=False)
    clicked_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    ingested_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    referer_origin: Mapped[str | None] = mapped_column(Text)
    country: Mapped[str | None] = mapped_column(String(2))
    device_type: Mapped[str] = mapped_column(String(16), nullable=False)
    is_bot: Mapped[bool] = mapped_column(Boolean, nullable=False)

    __table_args__ = (
        CheckConstraint("referer_origin IS NULL OR char_length(referer_origin) <= 2048"),
        CheckConstraint("country IS NULL OR country ~ '^[A-Z]{2}$'"),
        CheckConstraint(
            "device_type IN ('desktop','mobile','tablet','bot','unknown')",
            name="device_type_domain",
        ),
        Index("clicks_url_clicked_idx", "url_id", "clicked_at"),
        Index("clicks_clicked_idx", "clicked_at"),
    )


class ClickDaily(Base):
    __tablename__ = "click_daily"

    url_id: Mapped[int] = mapped_column(ForeignKey("urls.id", ondelete="CASCADE"), primary_key=True)
    day: Mapped[date] = mapped_column(Date, primary_key=True)
    clicks: Mapped[int] = mapped_column(BigInteger, nullable=False)
    human_clicks: Mapped[int] = mapped_column(BigInteger, nullable=False)
    bot_clicks: Mapped[int] = mapped_column(BigInteger, nullable=False)

    __table_args__ = (
        CheckConstraint("clicks >= 0"),
        CheckConstraint("human_clicks >= 0"),
        CheckConstraint("bot_clicks >= 0"),
        CheckConstraint("clicks = human_clicks + bot_clicks", name="clicks_sum"),
    )
