"""Per-request Server-Timing: time spent in Postgres, in Redis and in total.

A mutable accumulator lives in a context variable for the life of one HTTP
request. Database and Redis helpers add to it; the middleware writes the
header when the response starts, so the numbers cover all work done by then.
"""

import time
from contextvars import ContextVar
from dataclasses import dataclass

from starlette.datastructures import MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send


@dataclass
class RequestTimings:
    db_ms: float = 0.0
    db_queries: int = 0
    redis_ms: float = 0.0
    redis_calls: int = 0


_current: ContextVar[RequestTimings | None] = ContextVar("request_timings", default=None)


def current() -> RequestTimings | None:
    return _current.get()


def start() -> tuple[RequestTimings, object]:
    timings = RequestTimings()
    return timings, _current.set(timings)


def stop(token) -> None:
    _current.reset(token)


def add_db(elapsed_ms: float) -> None:
    timings = _current.get()
    if timings is not None:
        timings.db_ms += elapsed_ms
        timings.db_queries += 1


def add_redis(elapsed_ms: float) -> None:
    timings = _current.get()
    if timings is not None:
        timings.redis_ms += elapsed_ms
        timings.redis_calls += 1


def header_value(timings: RequestTimings, total_ms: float) -> str:
    return (
        f'db;dur={timings.db_ms:.1f};desc="Postgres x{timings.db_queries}", '
        f'redis;dur={timings.redis_ms:.1f};desc="Redis x{timings.redis_calls}", '
        f"total;dur={total_ms:.1f}"
    )


class ServerTimingMiddleware:
    """Pure ASGI so the context variable is set before any inner task starts."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        timings, token = start()
        started = time.perf_counter()

        async def send_with_timing(message: Message) -> None:
            if message["type"] == "http.response.start":
                total_ms = (time.perf_counter() - started) * 1000
                MutableHeaders(scope=message).append(
                    "Server-Timing", header_value(timings, total_ms)
                )
            await send(message)

        try:
            await self.app(scope, receive, send_with_timing)
        finally:
            stop(token)
