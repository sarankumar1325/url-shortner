import time
from collections.abc import AsyncIterator
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from sqlalchemy import event
from sqlalchemy.engine import Engine
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from backend.core import timing
from backend.core.config import get_settings

_engine: AsyncEngine | None = None
_session_factory: async_sessionmaker[AsyncSession] | None = None


def async_url(url: str) -> str:
    """Accept plain postgresql:// URLs (as Neon and Vercel provide), switch
    to asyncpg and drop libpq-only params that asyncpg rejects."""
    for prefix in ("postgresql://", "postgres://"):
        if url.startswith(prefix):
            parts = urlsplit("postgresql://" + url[len(prefix) :])
            query = [
                (key, value)
                for key, value in parse_qsl(parts.query)
                if key not in ("sslmode", "channel_binding")
            ]
            return urlunsplit(
                ("postgresql+asyncpg", parts.netloc, parts.path, urlencode(query), parts.fragment)
            )
    return url


def connect_args() -> dict:
    return {"ssl": True, "timeout": 10, "command_timeout": 10}


def _before_execute(conn, cursor, statement, parameters, context, executemany) -> None:
    context._shortly_started = time.perf_counter()


def _after_execute(conn, cursor, statement, parameters, context, executemany) -> None:
    started = getattr(context, "_shortly_started", None)
    if started is not None:
        timing.add_db((time.perf_counter() - started) * 1000)


def instrument(engine: Engine) -> None:
    """Feed query time into the request's Server-Timing header."""
    event.listen(engine, "before_cursor_execute", _before_execute)
    event.listen(engine, "after_cursor_execute", _after_execute)


def get_engine() -> AsyncEngine:
    global _engine
    if _engine is None:
        settings = get_settings()
        _engine = create_async_engine(
            async_url(settings.database_url),
            pool_size=5,
            max_overflow=2,
            pool_timeout=10,
            pool_pre_ping=True,
            pool_recycle=300,
            connect_args=connect_args(),
        )
        instrument(_engine.sync_engine)
    return _engine


def get_session_factory() -> async_sessionmaker[AsyncSession]:
    global _session_factory
    if _session_factory is None:
        _session_factory = async_sessionmaker(get_engine(), expire_on_commit=False)
    return _session_factory


async def get_session() -> AsyncIterator[AsyncSession]:
    async with get_session_factory()() as session:
        yield session
