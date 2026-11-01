"""Stream ingestion semantics: ACK ordering, reclaim, DLQ, migration."""

import json
import uuid
from datetime import UTC, datetime

import pytest
from sqlalchemy.exc import SQLAlchemyError

from backend.services import analytics

STREAM = analytics.STREAM_KEY
DEAD = analytics.DEAD_STREAM_KEY
LEGACY = analytics.LEGACY_LIST_KEY
PROCESSING = analytics.LEGACY_PROCESSING_KEY


def event_payload(**overrides) -> str:
    event = {
        "event_id": str(uuid.uuid4()),
        "url_id": 7,
        "clicked_at": "2026-10-24T10:00:00+00:00",
        "referer_origin": None,
        "country": "US",
        "device_type": "desktop",
        "is_bot": False,
    }
    event.update(overrides)
    return json.dumps(event)


class FakeRedis:
    def __init__(self) -> None:
        self.calls: list[tuple] = []
        self.read_batches: list[list] = []
        self.pending_detail: list = []
        self.pending_summary: list = [0, None, None, None]
        self.groups: list = []
        self.autoclaim: list = ["0-0", [], []]
        self.payloads: dict[str, str] = {}
        self.in_flight: list[str] = []
        self.legacy_items: list[str] = []
        self.stream_depth = 0
        self.dead_depth = 0
        self.legacy_depth = 0
        self.offline = False
        self.no_group = False

    async def command(self, *parts):
        if self.offline:
            raise analytics.RedisError("offline")
        self.calls.append(tuple(parts))
        op = parts[0]
        if op == "XGROUP":
            return "OK"
        if op == "XADD":
            return "9-0"
        if op in ("XACK", "XDEL"):
            return 1
        if op == "XREADGROUP":
            return self.read_batches.pop(0) if self.read_batches else None
        if op == "XPENDING":
            if self.no_group:
                raise analytics.RedisError('NOGROUP No such consumer group "analytics"')
            if len(parts) == 3:
                return self.pending_summary
            # Upstash/Redis ranged form takes the count positionally.
            assert parts[3:] and parts[3] == "-" and parts[4] == "+"
            assert len(parts) == 6 and isinstance(parts[5], int)
            return self.pending_detail
        if op == "XINFO":
            return self.groups
        if op == "XAUTOCLAIM":
            return self.autoclaim
        if op == "XRANGE":
            message_id = parts[2]
            if message_id not in self.payloads:
                return []
            return [[message_id, ["payload", self.payloads[message_id]]]]
        if op == "LRANGE":
            return self.in_flight
        if op == "LREM":
            item = parts[3]
            if item in self.in_flight:
                self.in_flight.remove(item)
            return 1
        if op == "RPOPLPUSH":
            return self.legacy_items.pop(0) if self.legacy_items else None
        if op == "XLEN":
            return self.dead_depth if parts[1] == DEAD else self.stream_depth
        if op == "LLEN":
            return self.legacy_depth if parts[1] == LEGACY else len(self.in_flight)
        raise AssertionError(f"unexpected command: {parts}")

    async def pipeline(self, commands):
        return [await self.command(*command) for command in commands]

    def ops(self) -> list[str]:
        return [call[0] for call in self.calls]


class FakeSession:
    def __init__(self) -> None:
        self.rollbacks = 0

    async def rollback(self) -> None:
        self.rollbacks += 1


@pytest.fixture
def redis(monkeypatch) -> FakeRedis:
    fake = FakeRedis()
    monkeypatch.setattr(analytics, "command", fake.command)
    monkeypatch.setattr(analytics, "pipeline", fake.pipeline)

    async def all_links_exist(session, url_ids):
        return set(url_ids)

    monkeypatch.setattr(analytics, "_existing_url_ids", all_links_exist)
    return fake


@pytest.mark.asyncio
async def test_ack_happens_only_after_commit(redis: FakeRedis, monkeypatch) -> None:
    timeline: list[str] = []

    async def persist(session, events):
        timeline.append("persist")
        return len(events)

    monkeypatch.setattr(analytics, "_persist", persist)
    original_command = redis.command

    async def tracking_command(*parts):
        timeline.append(parts[0])
        return await original_command(*parts)

    redis.command = tracking_command
    redis.read_batches = [[[STREAM, [["1-0", ["payload", event_payload()]]]]]]

    result = await analytics.drain_events(FakeSession(), max_events=10)

    assert result["inserted"] == 1
    assert result["drained"] == 1
    assert timeline.index("persist") < timeline.index("XACK")
    assert result["redis_ok"] is True


@pytest.mark.asyncio
async def test_failed_commit_leaves_messages_pending(redis: FakeRedis, monkeypatch) -> None:
    async def persist(session, events):
        raise SQLAlchemyError("commit failed")

    monkeypatch.setattr(analytics, "_persist", persist)
    redis.read_batches = [[[STREAM, [["1-0", ["payload", event_payload()]]]]]]
    session = FakeSession()

    result = await analytics.drain_events(session, max_events=10)

    assert result["failed"] == 1
    assert result["inserted"] == 0
    assert session.rollbacks == 1
    assert "XACK" not in redis.ops()


@pytest.mark.asyncio
async def test_malformed_payload_is_dead_lettered_and_acked(redis: FakeRedis, monkeypatch) -> None:
    async def persist(session, events):
        raise AssertionError("malformed events must not reach persistence")

    monkeypatch.setattr(analytics, "_persist", persist)
    redis.read_batches = [[[STREAM, [["1-0", ["payload", "not-json"]]]]]]

    result = await analytics.drain_events(FakeSession(), max_events=10)

    dead_adds = [call for call in redis.calls if call[0] == "XADD" and call[1] == DEAD]
    assert len(dead_adds) == 1
    assert "malformed_event" in dead_adds[0]
    assert "1-0" in dead_adds[0]
    assert result["dead_lettered"] == 1
    ack = next(call for call in redis.calls if call[0] == "XACK")
    assert "1-0" in ack


@pytest.mark.asyncio
async def test_exhausted_pending_message_goes_to_dead_letter(redis: FakeRedis, monkeypatch) -> None:
    redis.pending_detail = [["2-0", "old-consumer", 120_000, 5]]
    redis.payloads = {"2-0": event_payload()}

    async def persist(session, events):
        raise AssertionError("exhausted messages must not be persisted")

    monkeypatch.setattr(analytics, "_persist", persist)

    result = await analytics.drain_events(FakeSession(), max_events=10)

    dead_adds = [call for call in redis.calls if call[0] == "XADD" and call[1] == DEAD]
    assert len(dead_adds) == 1
    assert "max_attempts_exceeded" in dead_adds[0]
    assert result["dead_lettered"] == 1
    assert "XAUTOCLAIM" not in redis.ops()
    assert "2-0" in next(call for call in redis.calls if call[0] == "XACK")


@pytest.mark.asyncio
async def test_stale_pending_message_is_reclaimed_and_processed(
    redis: FakeRedis, monkeypatch
) -> None:
    redis.pending_detail = [["3-0", "old-consumer", 120_000, 2]]
    redis.autoclaim = ["0-0", [["3-0", ["payload", event_payload()]]], []]

    async def persist(session, events):
        return len(events)

    monkeypatch.setattr(analytics, "_persist", persist)

    result = await analytics.drain_events(FakeSession(), max_events=10)

    assert result["reclaimed"] == 1
    assert result["inserted"] == 1
    assert "3-0" in next(call for call in redis.calls if call[0] == "XACK")


@pytest.mark.asyncio
async def test_fresh_pending_messages_are_not_reclaimed(redis: FakeRedis, monkeypatch) -> None:
    redis.pending_detail = [["4-0", "worker", 1_000, 1]]

    async def persist(session, events):
        raise AssertionError("fresh pending messages must wait")

    monkeypatch.setattr(analytics, "_persist", persist)

    result = await analytics.drain_events(FakeSession(), max_events=10)

    assert result["reclaimed"] == 0
    assert "XAUTOCLAIM" not in redis.ops()


@pytest.mark.asyncio
async def test_legacy_list_migration_recovers_in_flight_entries(redis: FakeRedis) -> None:
    first = event_payload()
    second = event_payload()
    redis.in_flight = [first]
    redis.legacy_items = [second]

    migrated = await analytics._migrate_legacy_list()

    assert migrated == 2
    payloads = [call[4] for call in redis.calls if call[0] == "XADD" and call[1] == STREAM]
    assert payloads == [first, second]
    assert redis.in_flight == []
    assert redis.legacy_items == []


@pytest.mark.asyncio
async def test_ingestion_status_reports_backlog_and_lag(redis: FakeRedis) -> None:
    redis.stream_depth = 12
    redis.dead_depth = 3
    redis.legacy_depth = 4
    redis.in_flight = ["one"]
    redis.pending_summary = [2, "1-0", "2-0", [["worker", "2"]]]
    redis.pending_detail = [["1-0", "worker", 90_000, 3]]
    redis.groups = [
        [
            "name",
            analytics.CONSUMER_GROUP,
            "consumers",
            1,
            "pending",
            2,
            "last-delivered-id",
            "2-0",
            "entries-read",
            10,
            "lag",
            7,
        ]
    ]

    status = await analytics.ingestion_status()

    assert status["redis_ok"] is True
    assert status["stream_depth"] == 12
    assert status["pending"] == 2
    assert status["lag"] == 7
    assert status["oldest_pending_age_seconds"] == 90.0
    assert status["dead_letter_depth"] == 3
    assert status["legacy_pending"] == 4
    assert status["legacy_in_flight"] == 1


@pytest.mark.asyncio
async def test_ingestion_status_degrades_when_redis_is_down(redis: FakeRedis) -> None:
    redis.offline = True

    status = await analytics.ingestion_status()

    assert status["redis_ok"] is False
    assert status["pending"] is None
    assert status["dead_letter_depth"] is None


@pytest.mark.asyncio
async def test_ingestion_status_handles_missing_group(redis: FakeRedis) -> None:
    redis.no_group = True
    redis.stream_depth = 0

    status = await analytics.ingestion_status()

    assert status["redis_ok"] is True
    assert status["pending"] == 0
    assert status["lag"] == 0


@pytest.mark.asyncio
async def test_drain_returns_cleanly_when_redis_is_down(redis: FakeRedis) -> None:
    redis.offline = True

    result = await analytics.drain_events(FakeSession(), max_events=10)

    assert result["redis_ok"] is False
    assert result["drained"] == 0


@pytest.mark.asyncio
async def test_record_click_fails_open(monkeypatch) -> None:
    calls: list[tuple] = []

    async def failing_command(*parts):
        calls.append(parts)
        raise analytics.RedisError("offline")

    monkeypatch.setattr(analytics, "command", failing_command)

    await analytics.record_click(
        url_id=1,
        event_id=uuid.uuid4(),
        clicked_at=datetime.now(UTC),
        referer="https://example.com/x",
        country="us",
        user_agent="Mozilla/5.0 (iPhone)",
    )

    assert calls[0][0] == "XADD"
    assert calls[0][1] == STREAM


class _Result:
    def __init__(self, rows: list) -> None:
        self._rows = rows

    def all(self) -> list:
        return self._rows


class _PersistSession:
    def __init__(self, inserted_rows: list) -> None:
        self._rows = inserted_rows
        self.statements: list = []
        self.commits = 0
        self.rollbacks = 0

    async def execute(self, statement):
        self.statements.append(statement)
        return _Result(self._rows if len(self.statements) == 1 else [])

    async def commit(self) -> None:
        self.commits += 1

    async def rollback(self) -> None:
        self.rollbacks += 1


@pytest.mark.asyncio
async def test_rollups_are_deltaed_from_inserted_rows_only() -> None:
    clicked_at = datetime(2026, 10, 24, 10, 0, tzinfo=UTC)
    session = _PersistSession([(7, clicked_at, False)])
    events = [
        json.loads(event_payload(event_id=str(uuid.uuid4()))),
        json.loads(event_payload(event_id=str(uuid.uuid4()))),
    ]

    inserted = await analytics._persist(session, events)

    assert inserted == 1
    assert session.commits == 1
    assert len(session.statements) == 2
    assert session.statements[0].compile().string.find("event_id") >= 0
    assert session.statements[1].table.name == "click_daily"


@pytest.mark.asyncio
async def test_clicks_for_deleted_links_are_dead_lettered_not_retried(
    redis: FakeRedis, monkeypatch
) -> None:
    persisted: list[list[dict]] = []

    async def persist(session, events):
        persisted.append(events)
        return len(events)

    async def only_link_7(session, url_ids):
        return {7} & set(url_ids)

    monkeypatch.setattr(analytics, "_persist", persist)
    monkeypatch.setattr(analytics, "_existing_url_ids", only_link_7)
    redis.read_batches = [
        [
            [
                STREAM,
                [
                    ["1-0", ["payload", event_payload(url_id=7)]],
                    ["2-0", ["payload", event_payload(url_id=40)]],
                ],
            ]
        ]
    ]

    result = await analytics.drain_events(FakeSession(), max_events=10)

    assert result["inserted"] == 1
    assert result["dead_lettered"] == 1
    assert result["failed"] == 0
    assert [event["url_id"] for event in persisted[0]] == [7]
    dead = [call for call in redis.calls if call[0] == "XADD" and call[1] == DEAD]
    assert len(dead) == 1
    assert dead[0][dead[0].index("reason") + 1] == "link_missing"
    assert dead[0][dead[0].index("source_id") + 1] == "2-0"
    acked = next(call for call in redis.calls if call[0] == "XACK")
    assert set(acked[3:]) == {"1-0", "2-0"}


@pytest.mark.asyncio
async def test_batch_with_only_deleted_links_skips_the_insert(
    redis: FakeRedis, monkeypatch
) -> None:
    async def persist(session, events):
        raise AssertionError("nothing to persist")

    async def no_links(session, url_ids):
        return set()

    monkeypatch.setattr(analytics, "_persist", persist)
    monkeypatch.setattr(analytics, "_existing_url_ids", no_links)
    redis.read_batches = [[[STREAM, [["1-0", ["payload", event_payload(url_id=40)]]]]]]

    result = await analytics.drain_events(FakeSession(), max_events=10)

    assert result["dead_lettered"] == 1
    assert result["inserted"] == 0
    assert "XACK" in redis.ops()


@pytest.mark.asyncio
async def test_failed_link_lookup_leaves_messages_pending(redis: FakeRedis, monkeypatch) -> None:
    async def lookup_fails(session, url_ids):
        raise SQLAlchemyError("connection lost")

    monkeypatch.setattr(analytics, "_existing_url_ids", lookup_fails)
    redis.read_batches = [[[STREAM, [["1-0", ["payload", event_payload()]]]]]]
    session = FakeSession()

    result = await analytics.drain_events(session, max_events=10)

    assert result["failed"] == 1
    assert session.rollbacks == 1
    assert "XACK" not in redis.ops()
    assert not [call for call in redis.calls if call[0] == "XADD" and call[1] == DEAD]
