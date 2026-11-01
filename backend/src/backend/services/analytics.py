"""Click analytics: durable Redis Streams ingestion with at-least-once delivery.

Events are appended with XADD and consumed through a consumer group. A batch is
only acknowledged after the database transaction commits, so a crash or a failed
commit leaves the messages pending for XAUTOCLAIM recovery. Poison messages and
messages that exceed the delivery budget go to a bounded dead-letter stream.
"""

import json
import os
import socket
import uuid
from datetime import UTC, date, datetime, timedelta

from sqlalchemy import delete, func, or_, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from backend.core.config import get_settings
from backend.core.redis import RedisError, command, pipeline
from backend.models import Click, ClickDaily, CreateRequest, UserSession, WorkspaceInvitation

STREAM_KEY = "clicks:stream"
CONSUMER_GROUP = "analytics"
CONSUMER_NAME = f"{socket.gethostname()}-{os.getpid()}-{uuid.uuid4().hex[:6]}"
DEAD_STREAM_KEY = "clicks:dead"

# Pre-stream deployments buffered clicks in a list; drain it without losing an
# entry if the process dies mid-migration.
LEGACY_LIST_KEY = "clicks:pending"
LEGACY_PROCESSING_KEY = "clicks:pending:processing"

DRAIN_BATCH = 200
MAX_EVENTS_PER_DRAIN = 5000
READ_DRAIN_LIMIT = 500
RECLAIM_BATCH = 100
LEGACY_MIGRATE_BATCH = 200
CLEANUP_BATCH = 1000
DEAD_STREAM_MAXLEN = 10_000
DEAD_PAYLOAD_CHARS = 1000

BOT_MARKERS = (
    "bot",
    "crawler",
    "spider",
    "slurp",
    "curl",
    "wget",
    "python-requests",
    "httpclient",
    "okhttp",
    "facebookexternalhit",
    "preview",
    "scan",
)


def classify_device(user_agent: str | None) -> tuple[str, bool]:
    if not user_agent:
        return "unknown", False
    ua = user_agent.lower()
    if any(marker in ua for marker in BOT_MARKERS):
        return "bot", True
    if "ipad" in ua or ("android" in ua and "mobile" not in ua):
        return "tablet", False
    if "iphone" in ua or ("android" in ua and "mobile" in ua):
        return "mobile", False
    if "mozill" in ua or "opera" in ua or "edg" in ua or "chrome" in ua or "safari" in ua:
        return "desktop", False
    return "unknown", False


def visitor_traits(
    user_agent: str | None, country: str | None
) -> tuple[frozenset[str], str | None]:
    """Device traits (mobile/tablet/desktop plus ios/android) and an ISO country.

    Bots and unrecognized clients have no traits, so device rules never match them.
    """
    device, is_bot = classify_device(user_agent)
    traits: set[str] = set()
    if not is_bot and device != "unknown":
        traits.add(device)
        ua = (user_agent or "").lower()
        if "iphone" in ua or "ipad" in ua or "ipod" in ua:
            traits.add("ios")
        elif "android" in ua:
            traits.add("android")
    code = (country or "").strip().upper()
    return frozenset(traits), code if len(code) == 2 and code.isascii() and code.isalpha() else None


def referer_origin(referer: str | None) -> str | None:
    if not referer:
        return None
    try:
        from urllib.parse import urlsplit

        parts = urlsplit(referer)
        if not parts.scheme or not parts.hostname:
            return None
        port = f":{parts.port}" if parts.port else ""
        return f"{parts.scheme.lower()}://{parts.hostname.lower()}{port}"
    except ValueError:
        return None


def _fields_dict(fields: list[str]) -> dict[str, str]:
    return {fields[index]: fields[index + 1] for index in range(0, len(fields) - 1, 2)}


def _parse_event(fields: dict[str, str]) -> dict | None:
    try:
        payload = fields.get("payload")
        event = json.loads(payload) if payload else None
        if not isinstance(event, dict):
            return None
        uuid.UUID(str(event["event_id"]))
        int(event["url_id"])
        datetime.fromisoformat(event["clicked_at"])
        return event
    except (KeyError, TypeError, ValueError):
        return None


def _parse_stream_entries(response: list | None) -> list[tuple[str, dict[str, str]]]:
    if not response:
        return []
    entries: list[tuple[str, dict[str, str]]] = []
    for stream in response:
        if not isinstance(stream, list) or len(stream) < 2:
            continue
        for message in stream[1] or []:
            try:
                message_id, fields = message
                entries.append((str(message_id), _fields_dict(fields)))
            except (TypeError, ValueError):
                continue
    return entries


def _parse_claimed(response: list | None) -> list[tuple[str, dict[str, str]]]:
    if not response or len(response) < 2:
        return []
    entries: list[tuple[str, dict[str, str]]] = []
    for message in response[1] or []:
        try:
            message_id, fields = message
            entries.append((str(message_id), _fields_dict(fields)))
        except (TypeError, ValueError):
            continue
    return entries


async def record_click(
    *,
    url_id: int,
    event_id: uuid.UUID,
    clicked_at: datetime,
    referer: str | None,
    country: str | None,
    user_agent: str | None,
) -> None:
    """Best-effort enqueue; a redirect never fails because analytics did."""
    device_type, is_bot = classify_device(user_agent)
    event = {
        "event_id": str(event_id),
        "url_id": url_id,
        "clicked_at": clicked_at.isoformat(),
        "referer_origin": referer_origin(referer),
        "country": (country or "").upper() or None,
        "device_type": device_type,
        "is_bot": is_bot,
    }
    try:
        await command("XADD", STREAM_KEY, "*", "payload", json.dumps(event, separators=(",", ":")))
    except RedisError:
        # The redirect already committed to its 302; capture is best effort.
        pass


async def _ensure_group() -> None:
    try:
        await command("XGROUP", "CREATE", STREAM_KEY, CONSUMER_GROUP, "0", "MKSTREAM")
    except RedisError as exc:
        if "BUSYGROUP" not in str(exc):
            raise


async def _migrate_legacy_list() -> int:
    """Move list-buffered events into the stream without a loss window.

    RPOPLPUSH parks an entry in a processing list before XADD; a crash at any
    point leaves the entry recoverable, and duplicates are deduplicated on
    event_id during persistence.
    """
    migrated = 0
    in_flight = await command("LRANGE", LEGACY_PROCESSING_KEY, 0, LEGACY_MIGRATE_BATCH - 1)
    for item in in_flight or []:
        await command("XADD", STREAM_KEY, "*", "payload", item)
        await command("LREM", LEGACY_PROCESSING_KEY, 1, item)
        migrated += 1
    while migrated < LEGACY_MIGRATE_BATCH:
        item = await command("RPOPLPUSH", LEGACY_LIST_KEY, LEGACY_PROCESSING_KEY)
        if item is None:
            break
        await command("XADD", STREAM_KEY, "*", "payload", item)
        await command("LREM", LEGACY_PROCESSING_KEY, 1, item)
        migrated += 1
    return migrated


async def _dead_letter(entries: list[tuple[str, str, str]]) -> int:
    if not entries:
        return 0
    now = datetime.now(UTC).isoformat()
    commands = [
        [
            "XADD",
            DEAD_STREAM_KEY,
            "MAXLEN",
            "~",
            DEAD_STREAM_MAXLEN,
            "*",
            "source_id",
            source_id,
            "reason",
            reason,
            "payload",
            payload[:DEAD_PAYLOAD_CHARS],
            "failed_at",
            now,
        ]
        for source_id, reason, payload in entries
    ]
    await pipeline(commands)
    return len(entries)


async def _acknowledge(message_ids: list[str]) -> None:
    if not message_ids:
        return
    try:
        await pipeline(
            [
                ["XACK", STREAM_KEY, CONSUMER_GROUP, *message_ids],
                ["XDEL", STREAM_KEY, *message_ids],
            ]
        )
    except RedisError:
        # Pending entries will be reclaimed; event_id dedup keeps retries safe.
        pass


async def _fetch_payloads(message_ids: list[str]) -> dict[str, str]:
    if not message_ids:
        return {}
    results = await pipeline(
        [["XRANGE", STREAM_KEY, message_id, message_id] for message_id in message_ids]
    )
    payloads: dict[str, str] = {}
    for message_id, result in zip(message_ids, results, strict=True):
        try:
            fields = _fields_dict(result[0][1])
        except (IndexError, TypeError):
            continue
        payloads[message_id] = fields.get("payload") or json.dumps(fields, separators=(",", ":"))
    return payloads


async def _read_new(count: int) -> list[tuple[str, dict[str, str]]]:
    response = await command(
        "XREADGROUP",
        "GROUP",
        CONSUMER_GROUP,
        CONSUMER_NAME,
        "COUNT",
        count,
        "STREAMS",
        STREAM_KEY,
        ">",
    )
    return _parse_stream_entries(response)


async def _process_entries(
    session: AsyncSession, entries: list[tuple[str, dict[str, str]]]
) -> dict[str, int]:
    valid: list[tuple[str, dict]] = []
    invalid: list[tuple[str, str, str]] = []
    for message_id, fields in entries:
        event = _parse_event(fields)
        payload = fields.get("payload") or json.dumps(fields, separators=(",", ":"))
        if event is None:
            invalid.append((message_id, "malformed_event", payload))
        else:
            valid.append((message_id, event))

    dead_lettered = 0
    if invalid:
        dead_lettered = await _dead_letter(invalid)
        await _acknowledge([message_id for message_id, _, _ in invalid])

    inserted = 0
    failed = 0
    if valid:
        try:
            inserted = await _persist(session, [event for _, event in valid])
        except SQLAlchemyError:
            await session.rollback()
            failed = len(valid)
        else:
            await _acknowledge([message_id for message_id, _ in valid])

    return {"inserted": inserted, "dead_lettered": dead_lettered, "failed": failed}


async def _reclaim_stale(session: AsyncSession, limit: int) -> dict[str, int]:
    settings = get_settings()
    min_idle_ms = settings.analytics_claim_min_idle_seconds * 1000
    max_attempts = settings.analytics_max_attempts

    raw = await command("XPENDING", STREAM_KEY, CONSUMER_GROUP, "-", "+", limit)
    stale: list[tuple[str, int]] = []
    for row in raw or []:
        try:
            message_id, _consumer, idle_ms, deliveries = row
            if int(idle_ms) >= min_idle_ms:
                stale.append((str(message_id), int(deliveries)))
        except (TypeError, ValueError):
            continue
    if not stale:
        return {"reclaimed": 0, "inserted": 0, "dead_lettered": 0, "failed": 0}

    exhausted = [message_id for message_id, deliveries in stale if deliveries >= max_attempts]
    dead_lettered = 0
    if exhausted:
        payloads = await _fetch_payloads(exhausted)
        dead_lettered = await _dead_letter(
            [
                (message_id, "max_attempts_exceeded", payloads.get(message_id, ""))
                for message_id in exhausted
            ]
        )
        await _acknowledge(exhausted)

    result = {"reclaimed": 0, "inserted": 0, "dead_lettered": dead_lettered, "failed": 0}
    claimable = [message_id for message_id, deliveries in stale if deliveries < max_attempts]
    if not claimable:
        return result

    claimed = await command(
        "XAUTOCLAIM",
        STREAM_KEY,
        CONSUMER_GROUP,
        CONSUMER_NAME,
        min_idle_ms,
        claimable[0],
        "COUNT",
        len(claimable),
    )
    entries = _parse_claimed(claimed)
    if entries:
        result["reclaimed"] = len(entries)
        processed = await _process_entries(session, entries)
        result["inserted"] += processed["inserted"]
        result["dead_lettered"] += processed["dead_lettered"]
        result["failed"] += processed["failed"]
    return result


async def drain_events(session: AsyncSession, max_events: int = MAX_EVENTS_PER_DRAIN) -> dict:
    """Drain legacy entries and stream batches; ACK only after a committed write."""
    result = {
        "redis_ok": True,
        "drained": 0,
        "reclaimed": 0,
        "inserted": 0,
        "dead_lettered": 0,
        "failed": 0,
        "migrated": 0,
    }
    try:
        await _ensure_group()
        result["migrated"] = await _migrate_legacy_list()
    except RedisError:
        result["redis_ok"] = False
        return result

    remaining = max_events
    if remaining > 0:
        try:
            reclaimed = await _reclaim_stale(session, min(RECLAIM_BATCH, remaining))
        except RedisError:
            result["redis_ok"] = False
            return result
        result["reclaimed"] = reclaimed["reclaimed"]
        result["inserted"] += reclaimed["inserted"]
        result["dead_lettered"] += reclaimed["dead_lettered"]
        result["failed"] += reclaimed["failed"]
        remaining -= reclaimed["reclaimed"]

    while result["drained"] < max_events and remaining > 0:
        batch_size = min(DRAIN_BATCH, remaining)
        try:
            entries = await _read_new(batch_size)
            if not entries:
                break
            counts = await _process_entries(session, entries)
        except RedisError:
            result["redis_ok"] = False
            break
        result["drained"] += len(entries)
        result["inserted"] += counts["inserted"]
        result["dead_lettered"] += counts["dead_lettered"]
        result["failed"] += counts["failed"]
        remaining -= len(entries)
        if len(entries) < batch_size:
            break
    return result


async def ingestion_status() -> dict:
    """Operational snapshot: backlog, pending age, dead letters, legacy buffer."""
    now = datetime.now(UTC)
    base_commands = [
        ["XLEN", STREAM_KEY],
        ["XLEN", DEAD_STREAM_KEY],
        ["LLEN", LEGACY_LIST_KEY],
        ["LLEN", LEGACY_PROCESSING_KEY],
    ]
    commands = [
        *base_commands,
        ["XPENDING", STREAM_KEY, CONSUMER_GROUP],
        ["XPENDING", STREAM_KEY, CONSUMER_GROUP, "-", "+", 1],
        ["XINFO", "GROUPS", STREAM_KEY],
    ]
    try:
        results = await pipeline(commands)
    except RedisError as exc:
        if "NOGROUP" not in str(exc):
            return {
                "redis_ok": False,
                "consumer": CONSUMER_NAME,
                "stream_depth": None,
                "pending": None,
                "lag": None,
                "oldest_pending_age_seconds": None,
                "dead_letter_depth": None,
                "legacy_pending": None,
                "legacy_in_flight": None,
                "generated_at": now.isoformat().replace("+00:00", "Z"),
            }
        # A fresh deployment has an empty stream and no group yet.
        try:
            base = await pipeline(base_commands)
        except RedisError:
            return {
                "redis_ok": False,
                "consumer": CONSUMER_NAME,
                "stream_depth": None,
                "pending": None,
                "lag": None,
                "oldest_pending_age_seconds": None,
                "dead_letter_depth": None,
                "legacy_pending": None,
                "legacy_in_flight": None,
                "generated_at": now.isoformat().replace("+00:00", "Z"),
            }
        results = [*base, None, None, []]

    stream_depth, dead_letter_depth, legacy_pending, legacy_in_flight = results[:4]
    pending = 0
    lag = 0
    oldest_age: float | None = None
    try:
        summary, oldest, groups = results[4], results[5], results[6]
        if summary:
            pending = int(summary[0])
        if oldest:
            oldest_age = round(int(oldest[0][2]) / 1000, 1)
        for group in groups or []:
            fields = _fields_dict(group)
            if fields.get("name") == CONSUMER_GROUP and fields.get("lag") is not None:
                lag = int(fields["lag"])
    except (IndexError, TypeError, ValueError):
        # Base counts remain useful even if group metrics are malformed.
        pass

    return {
        "redis_ok": True,
        "consumer": CONSUMER_NAME,
        "stream_depth": int(stream_depth or 0),
        "pending": pending,
        "lag": lag,
        "oldest_pending_age_seconds": oldest_age,
        "dead_letter_depth": int(dead_letter_depth or 0),
        "legacy_pending": int(legacy_pending or 0),
        "legacy_in_flight": int(legacy_in_flight or 0),
        "generated_at": now.isoformat().replace("+00:00", "Z"),
    }


async def _persist(session: AsyncSession, events: list[dict]) -> int:
    # Sort by (url_id, day) so concurrent drains upsert in a consistent order.
    def sort_key(event: dict) -> tuple[int, str]:
        return (event["url_id"], event["clicked_at"][:10])

    events.sort(key=sort_key)

    rows = []
    for event in events:
        clicked_at = datetime.fromisoformat(event["clicked_at"])
        rows.append(
            {
                "event_id": uuid.UUID(event["event_id"]),
                "url_id": event["url_id"],
                "clicked_at": clicked_at,
                "referer_origin": event.get("referer_origin"),
                "country": event.get("country"),
                "device_type": event.get("device_type") or "unknown",
                "is_bot": bool(event.get("is_bot")),
            }
        )

    result = await session.execute(
        pg_insert(Click)
        .values(rows)
        .on_conflict_do_nothing(index_elements=["event_id"])
        .returning(Click.url_id, Click.clicked_at, Click.is_bot)
    )
    new_rows = result.all()
    if not new_rows:
        await session.commit()
        return 0

    deltas: dict[tuple[int, date], list[int]] = {}
    for url_id, clicked_at, is_bot in new_rows:
        day = clicked_at.astimezone(UTC).date()
        counts = deltas.setdefault((url_id, day), [0, 0, 0])
        counts[0] += 1
        counts[2 if is_bot else 1] += 1

    for (url_id, day), (clicks, human, bot) in sorted(deltas.items()):
        await session.execute(
            pg_insert(ClickDaily)
            .values(url_id=url_id, day=day, clicks=clicks, human_clicks=human, bot_clicks=bot)
            .on_conflict_do_update(
                index_elements=["url_id", "day"],
                set_={
                    "clicks": ClickDaily.clicks + clicks,
                    "human_clicks": ClickDaily.human_clicks + human,
                    "bot_clicks": ClickDaily.bot_clicks + bot,
                },
            )
        )
    await session.commit()
    return len(new_rows)


async def _delete_in_batches(session: AsyncSession, model, key, condition) -> int:
    """Delete matching rows in bounded batches to keep lock/index work small."""
    deleted = 0
    while True:
        batch = select(key).where(condition).limit(CLEANUP_BATCH)
        result = await session.execute(delete(model).where(key.in_(batch)))
        count = result.rowcount or 0
        deleted += count
        if count < CLEANUP_BATCH:
            return deleted


async def cleanup_expired(session: AsyncSession) -> dict:
    """Bounded retention cleanup: credentials, replay rows, clicks and rollups."""
    settings = get_settings()
    now = datetime.now(UTC)
    sessions_deleted = await _delete_in_batches(
        session, UserSession, UserSession.token_hash, UserSession.expires_at <= now
    )
    invitations_deleted = await _delete_in_batches(
        session,
        WorkspaceInvitation,
        WorkspaceInvitation.id,
        or_(
            WorkspaceInvitation.expires_at <= now,
            WorkspaceInvitation.accepted_at.is_not(None),
            WorkspaceInvitation.revoked_at.is_not(None),
        ),
    )
    replay_result = await session.execute(
        delete(CreateRequest).where(CreateRequest.expires_at <= now)
    )
    raw_cutoff = datetime.combine(
        now.date() - timedelta(days=settings.raw_click_retention_days - 1),
        datetime.min.time(),
        tzinfo=UTC,
    )
    click_result = await session.execute(delete(Click).where(Click.clicked_at < raw_cutoff))
    rollup_cutoff = now.date() - timedelta(days=settings.daily_retention_days)
    rollup_result = await session.execute(delete(ClickDaily).where(ClickDaily.day < rollup_cutoff))
    await session.commit()
    return {
        "sessions_deleted": sessions_deleted,
        "invitations_deleted": invitations_deleted,
        "replay_rows_deleted": replay_result.rowcount,
        "raw_clicks_deleted": click_result.rowcount,
        "rollups_deleted": rollup_result.rowcount,
    }


async def analytics(session: AsyncSession, url_id: int, from_day: date, to_day: date) -> dict:
    """Rollup totals + zero-filled series + raw-event breakdowns."""
    series_rows = (
        await session.execute(
            select(
                ClickDaily.day,
                ClickDaily.clicks,
                ClickDaily.human_clicks,
                ClickDaily.bot_clicks,
            )
            .where(ClickDaily.url_id == url_id)
            .where(ClickDaily.day >= from_day)
            .where(ClickDaily.day < to_day)
            .order_by(ClickDaily.day)
        )
    ).all()
    by_day = {row.day: row for row in series_rows}

    days = []
    total_clicks = total_human = total_bot = 0
    cursor = from_day
    while cursor < to_day:
        row = by_day.get(cursor)
        clicks = row.clicks if row else 0
        human = row.human_clicks if row else 0
        bot = row.bot_clicks if row else 0
        days.append(
            {"day": cursor.isoformat(), "clicks": clicks, "human_clicks": human, "bot_clicks": bot}
        )
        total_clicks += clicks
        total_human += human
        total_bot += bot
        cursor += timedelta(days=1)

    settings = get_settings()
    today = datetime.now(UTC).date()
    raw_start = today - timedelta(days=settings.raw_click_retention_days - 1)
    breakdown_from = max(from_day, raw_start)
    truncated = breakdown_from > from_day

    referers: list[dict] = []
    countries: list[dict] = []
    devices: list[dict] = []
    breakdown_to = min(to_day, today + timedelta(days=1))
    if breakdown_from < breakdown_to:
        rows = (
            await session.execute(
                select(
                    Click.referer_origin,
                    Click.country,
                    Click.device_type,
                    func.count().label("count"),
                )
                .where(Click.url_id == url_id)
                .where(
                    Click.clicked_at
                    >= datetime.combine(breakdown_from, datetime.min.time(), tzinfo=UTC)
                )
                .where(
                    Click.clicked_at
                    < datetime.combine(breakdown_to, datetime.min.time(), tzinfo=UTC)
                )
                .group_by(Click.referer_origin, Click.country, Click.device_type)
            )
        ).all()

        referer_counts: dict[str | None, int] = {}
        country_counts: dict[str | None, int] = {}
        device_counts: dict[str, int] = {}
        for origin, country, device, count in rows:
            referer_counts[origin] = referer_counts.get(origin, 0) + count
            country_counts[country] = country_counts.get(country, 0) + count
            device_counts[device] = device_counts.get(device, 0) + count

        def top(counts: dict, limit: int) -> list[dict]:
            return [
                {"value": value, "clicks": count}
                for value, count in sorted(counts.items(), key=lambda kv: (-kv[1], str(kv[0])))[
                    :limit
                ]
            ]

        referers = top(referer_counts, 10)
        countries = top(country_counts, 10)
        devices = top(device_counts, 4)
    elif breakdown_from >= breakdown_to:
        truncated = truncated or from_day < to_day <= today

    last_ingested = (
        await session.execute(select(func.max(Click.ingested_at)).where(Click.url_id == url_id))
    ).scalar_one_or_none()

    status = await ingestion_status()
    freshness = {
        "redis_ok": status["redis_ok"],
        "pending_events": status["pending"],
        "lag_events": status["lag"],
        "oldest_pending_seconds": status["oldest_pending_age_seconds"],
        "dead_letter_events": status["dead_letter_depth"],
        "captured_at": status["generated_at"],
    }

    return {
        "totals": {"clicks": total_clicks, "human_clicks": total_human, "bot_clicks": total_bot},
        "series": days,
        "breakdowns": {
            "from": breakdown_from.isoformat() if breakdown_from < breakdown_to else None,
            "to": breakdown_to.isoformat() if breakdown_from < breakdown_to else None,
            "truncated": truncated,
            "top_referers": referers,
            "top_countries": countries,
            "devices": devices,
        },
        "last_processed_at": last_ingested.isoformat().replace("+00:00", "Z")
        if last_ingested
        else None,
        "data_through": None,
        "freshness": freshness,
    }


async def pending_depth() -> int | None:
    """Legacy depth helper retained for callers that only want queue length."""
    try:
        return int(await command("LLEN", LEGACY_LIST_KEY))
    except RedisError:
        return None
