import pytest
import pytest_asyncio
from sqlalchemy import CheckConstraint, MetaData, event
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from backend.core import metrics
from backend.core.db import instrument
from backend.core.redis import breaker
from backend.models import Base


@pytest.fixture(autouse=True)
def _reset_process_state():
    breaker.reset()
    metrics.reset()
    yield
    breaker.reset()
    metrics.reset()


@pytest_asyncio.fixture
async def factory():
    """The real schema in SQLite, minus Postgres-only CHECK constraints."""
    metadata = MetaData()
    for table in Base.metadata.sorted_tables:
        copy = table.to_metadata(metadata)
        for constraint in [c for c in copy.constraints if isinstance(c, CheckConstraint)]:
            copy.constraints.discard(constraint)
    engine = create_async_engine("sqlite+aiosqlite://", poolclass=StaticPool)

    @event.listens_for(engine.sync_engine, "connect")
    def _foreign_keys(dbapi_connection, _record) -> None:
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

    instrument(engine.sync_engine)
    async with engine.begin() as connection:
        await connection.run_sync(metadata.create_all)
    yield async_sessionmaker(engine, expire_on_commit=False)
    await engine.dispose()
