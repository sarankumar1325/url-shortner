"""Workspace-wide dashboard: traffic across every link plus link health.

Totals and the series come from daily rollups; referrer, country and device
breakdowns come from raw clicks, which are only kept for the retention window.
Statuses use the same precedence as the web app so the two never disagree.
"""

import uuid
from datetime import UTC, date, datetime, timedelta

from sqlalchemy import and_, case, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.core.config import get_settings
from backend.models import Click, ClickDaily, Url
from backend.services import analytics

ALLOWED_DAYS = (7, 30, 90)
TABLE_LIMIT = 500
EXPIRING_SOON = timedelta(days=7)
NEAR_LIMIT_RATIO = 0.8
QUIET_AFTER = timedelta(days=7)
STATUSES = ("active", "paused", "expired", "used_up", "blocked")


def link_status(url: Url, now: datetime) -> str:
    if url.is_blocked:
        return "blocked"
    if url.expires_at is not None and url.expires_at <= now:
        return "expired"
    if url.max_clicks is not None and (url.clicks_used or 0) >= url.max_clicks:
        return "used_up"
    return "active" if url.is_active else "paused"


def link_issues(url: Url, status: str, clicks: int, now: datetime) -> list[str]:
    """Things a person may want to act on, most urgent first."""
    issues: list[str] = []
    if status != "active":
        issues.append(status)
        if status in ("expired", "used_up") and url.fallback_url:
            issues.append("serving_fallback")
        return issues
    if url.expires_at is not None and url.expires_at - now <= EXPIRING_SOON:
        issues.append("expiring_soon")
    if url.max_clicks is not None and (url.clicks_used or 0) >= url.max_clicks * NEAR_LIMIT_RATIO:
        issues.append("near_limit")
    if clicks == 0 and url.created_at is not None and now - url.created_at >= QUIET_AFTER:
        issues.append("no_recent_clicks")
    return issues


def zero_fill(rows: dict[date, tuple[int, int, int]], start: date, end: date) -> list[dict]:
    series = []
    cursor = start
    while cursor < end:
        clicks, human, bot = rows.get(cursor, (0, 0, 0))
        series.append(
            {"day": cursor.isoformat(), "clicks": clicks, "human_clicks": human, "bot_clicks": bot}
        )
        cursor += timedelta(days=1)
    return series


def change_ratio(current: int, previous: int) -> float | None:
    if previous == 0:
        return None
    return round((current - previous) / previous, 3)


def _top(counts: dict, limit: int) -> list[dict]:
    ranked = sorted(counts.items(), key=lambda kv: (-kv[1], str(kv[0])))[:limit]
    return [{"value": value, "clicks": count} for value, count in ranked]


def _iso(value: datetime | None) -> str | None:
    return value.isoformat().replace("+00:00", "Z") if value else None


async def workspace_dashboard(session: AsyncSession, workspace_id: uuid.UUID, days: int) -> dict:
    settings = get_settings()
    now = datetime.now(UTC)
    today = now.date()
    to_day = today + timedelta(days=1)
    from_day = to_day - timedelta(days=days)
    previous_from = from_day - timedelta(days=days)
    live = and_(Url.workspace_id == workspace_id, Url.deleted_at.is_(None))

    daily = (
        await session.execute(
            select(
                ClickDaily.day,
                func.sum(ClickDaily.clicks),
                func.sum(ClickDaily.human_clicks),
                func.sum(ClickDaily.bot_clicks),
            )
            .join(Url, Url.id == ClickDaily.url_id)
            .where(live, ClickDaily.day >= previous_from, ClickDaily.day < to_day)
            .group_by(ClickDaily.day)
        )
    ).all()
    current_rows: dict[date, tuple[int, int, int]] = {}
    previous_clicks = 0
    for day, clicks, human, bot in daily:
        if day >= from_day:
            current_rows[day] = (int(clicks or 0), int(human or 0), int(bot or 0))
        else:
            previous_clicks += int(clicks or 0)
    series = zero_fill(current_rows, from_day, to_day)
    totals = {
        "clicks": sum(point["clicks"] for point in series),
        "human_clicks": sum(point["human_clicks"] for point in series),
        "bot_clicks": sum(point["bot_clicks"] for point in series),
        "previous_clicks": previous_clicks,
    }
    totals["change"] = change_ratio(totals["clicks"], previous_clicks)

    in_period = case((ClickDaily.day >= from_day, ClickDaily.clicks), else_=0)
    in_previous = case((ClickDaily.day < from_day, ClickDaily.clicks), else_=0)
    per_link = (
        await session.execute(
            select(
                Url,
                func.coalesce(func.sum(in_period), 0),
                func.coalesce(func.sum(in_previous), 0),
            )
            .outerjoin(
                ClickDaily,
                and_(
                    ClickDaily.url_id == Url.id,
                    ClickDaily.day >= previous_from,
                    ClickDaily.day < to_day,
                ),
            )
            .where(live)
            .group_by(Url.id)
            .order_by(Url.created_at.desc(), Url.id.desc())
        )
    ).all()

    last_clicks = dict(
        (
            await session.execute(
                select(Click.url_id, func.max(Click.clicked_at))
                .join(Url, Url.id == Click.url_id)
                .where(live)
                .group_by(Click.url_id)
            )
        ).all()
    )

    base = settings.short_base_url.rstrip("/")
    counts = dict.fromkeys(STATUSES, 0)
    issue_counts: dict[str, int] = {}
    links = []
    for url, clicks, previous in per_link:
        status = link_status(url, now)
        issues = link_issues(url, status, int(clicks), now)
        counts[status] += 1
        for issue in issues:
            issue_counts[issue] = issue_counts.get(issue, 0) + 1
        links.append(
            {
                "short_code": url.short_code,
                "short_url": f"{base}/{url.short_code}",
                "long_url": url.long_url,
                "status": status,
                "issues": issues,
                "clicks": int(clicks),
                "previous_clicks": int(previous),
                "change": change_ratio(int(clicks), int(previous)),
                "last_click_at": _iso(last_clicks.get(url.id)),
                "created_at": _iso(url.created_at),
                "expires_at": _iso(url.expires_at),
                "max_clicks": url.max_clicks,
                "clicks_used": url.clicks_used or 0,
                "fallback_url": url.fallback_url,
            }
        )
    links.sort(key=lambda item: (-item["clicks"], item["short_code"]))

    raw_start = today - timedelta(days=settings.raw_click_retention_days - 1)
    breakdown_from = max(from_day, raw_start)
    rows = (
        await session.execute(
            select(Click.referer_origin, Click.country, Click.device_type, func.count())
            .join(Url, Url.id == Click.url_id)
            .where(
                live,
                Click.clicked_at >= datetime.combine(breakdown_from, datetime.min.time(), UTC),
                Click.clicked_at < datetime.combine(to_day, datetime.min.time(), UTC),
            )
            .group_by(Click.referer_origin, Click.country, Click.device_type)
        )
    ).all()
    referers: dict = {}
    countries: dict = {}
    devices: dict = {}
    for origin, country, device, count in rows:
        referers[origin] = referers.get(origin, 0) + count
        countries[country] = countries.get(country, 0) + count
        devices[device] = devices.get(device, 0) + count

    ingestion = await analytics.ingestion_status()
    return {
        "days": days,
        "from": from_day.isoformat(),
        "to": to_day.isoformat(),
        "totals": totals,
        "series": series,
        "breakdowns": {
            "from": breakdown_from.isoformat(),
            "truncated": breakdown_from > from_day,
            "top_referers": _top(referers, 8),
            "top_countries": _top(countries, 8),
            "devices": _top(devices, 4),
        },
        "status_counts": {**counts, "total": len(per_link)},
        "issue_counts": issue_counts,
        "links": links[:TABLE_LIMIT],
        "links_truncated": len(links) > TABLE_LIMIT,
        "freshness": {
            "redis_ok": ingestion["redis_ok"],
            "pending_events": ingestion["pending"],
            "lag_events": ingestion["lag"],
            "oldest_pending_seconds": ingestion["oldest_pending_age_seconds"],
            "dead_letter_events": ingestion["dead_letter_depth"],
            "captured_at": ingestion["generated_at"],
        },
        "thresholds": {
            "expiring_soon_days": EXPIRING_SOON.days,
            "near_limit_ratio": NEAR_LIMIT_RATIO,
            "quiet_after_days": QUIET_AFTER.days,
        },
        "generated_at": _iso(now),
    }
