"""Abuse reports: canonical input, safe persistence, operator listing."""

import uuid
from datetime import UTC, datetime
from urllib.parse import urlsplit

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.core.problems import APIError
from backend.models import AbuseReport, Url

REASONS = frozenset({"spam", "phishing", "malware", "impersonation", "other"})
MAX_DETAILS = 2000
MAX_REPORTS = 200
SHORT_CODE_CHARS = frozenset("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-")


def _iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


def normalize_short_code(raw: str) -> str:
    value = raw.strip()
    if "://" in value:
        value = urlsplit(value).path
    value = value.rstrip("/").rsplit("/", 1)[-1]
    if not 1 <= len(value) <= 32 or any(char not in SHORT_CODE_CHARS for char in value):
        raise APIError(
            422,
            "validation_error",
            "Enter a valid short code or short link.",
            errors=[
                {
                    "field": "short_code",
                    "code": "invalid",
                    "message": "Enter a valid short code or short link.",
                }
            ],
        )
    return value


def normalize_details(raw: str | None) -> str | None:
    if raw is None:
        return None
    details = raw.strip()
    if not details:
        return None
    if len(details) > MAX_DETAILS:
        raise APIError(
            422,
            "validation_error",
            f"Details must be {MAX_DETAILS} characters or fewer.",
            errors=[
                {
                    "field": "details",
                    "code": "too_long",
                    "message": f"Details must be {MAX_DETAILS} characters or fewer.",
                }
            ],
        )
    return details


def normalize_email(raw: str | None) -> str | None:
    if raw is None:
        return None
    email = raw.strip().lower()
    if not email:
        return None
    if len(email) > 320 or email.count("@") != 1 or " " in email:
        raise APIError(
            422,
            "validation_error",
            "Enter a valid email address or leave it empty.",
            errors=[
                {
                    "field": "reporter_email",
                    "code": "invalid",
                    "message": "Enter a valid email address or leave it empty.",
                }
            ],
        )
    return email


async def create_report(
    session: AsyncSession,
    *,
    short_code: str,
    reason: str,
    details: str | None,
    reporter_email: str | None,
) -> dict:
    if reason not in REASONS:
        raise APIError(
            422,
            "validation_error",
            "Choose a valid report reason.",
            errors=[
                {
                    "field": "reason",
                    "code": "invalid",
                    "message": "Choose a valid report reason.",
                }
            ],
        )
    code = normalize_short_code(short_code)
    details = normalize_details(details)
    reporter_email = normalize_email(reporter_email)

    url_id = (
        await session.execute(select(Url.id).where(Url.short_code == code))
    ).scalar_one_or_none()
    report = AbuseReport(
        id=uuid.uuid4(),
        short_code=code,
        url_id=url_id,
        reason=reason,
        details=details,
        reporter_email=reporter_email,
        status="open",
        created_at=datetime.now(UTC),
    )
    session.add(report)
    await session.commit()
    return {
        "id": str(report.id),
        "short_code": code,
        "status": report.status,
        "created_at": _iso(report.created_at),
    }


async def list_reports(session: AsyncSession, status: str, limit: int) -> list[dict]:
    if status not in ("open", "resolved", "all"):
        raise APIError(422, "validation_error", "status must be open, resolved or all.")
    query = select(AbuseReport).order_by(AbuseReport.created_at.desc()).limit(limit)
    if status != "all":
        query = query.where(AbuseReport.status == status)
    rows = (await session.execute(query)).scalars().all()
    return [
        {
            "id": str(item.id),
            "short_code": item.short_code,
            "reason": item.reason,
            "details": item.details,
            "reporter_email": item.reporter_email,
            "status": item.status,
            "created_at": _iso(item.created_at),
            "resolved_at": _iso(item.resolved_at),
        }
        for item in rows
    ]
