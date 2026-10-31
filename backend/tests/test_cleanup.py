import pytest

from backend.services.analytics import cleanup_expired


class _Result:
    def __init__(self, rowcount: int) -> None:
        self.rowcount = rowcount


class _Session:
    def __init__(self, rowcounts: list[int]) -> None:
        self._rowcounts = list(rowcounts)
        self.statements = []
        self.committed = False

    async def execute(self, statement):
        self.statements.append(statement)
        return _Result(self._rowcounts.pop(0))

    async def commit(self) -> None:
        self.committed = True


@pytest.mark.asyncio
async def test_cleanup_covers_sessions_and_invitations() -> None:
    session = _Session([2, 3, 4, 5, 6])

    result = await cleanup_expired(session)

    tables = [statement.table.name for statement in session.statements]
    assert tables.count("user_sessions") == 1
    assert tables.count("workspace_invitations") == 1
    assert result == {
        "sessions_deleted": 2,
        "invitations_deleted": 3,
        "replay_rows_deleted": 4,
        "raw_clicks_deleted": 5,
        "rollups_deleted": 6,
    }
    assert session.committed


@pytest.mark.asyncio
async def test_cleanup_batches_large_session_backlogs() -> None:
    session = _Session([1000, 25, 0, 0, 0, 0])

    result = await cleanup_expired(session)

    assert [statement.table.name for statement in session.statements[:2]] == [
        "user_sessions",
        "user_sessions",
    ]
    assert result["sessions_deleted"] == 1025
    assert session.committed
