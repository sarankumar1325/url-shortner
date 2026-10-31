"""Single-flight: concurrent callers for the same key share one execution.

When a hot link falls out of the cache, every request in flight for it would
otherwise query Postgres at once (a cache stampede). The first caller runs the
load; the rest await its result. Coalescing is per process.
"""

import asyncio
from collections.abc import Awaitable, Callable
from typing import TypeVar

T = TypeVar("T")


class SingleFlight:
    def __init__(self) -> None:
        self._calls: dict[str, asyncio.Future] = {}
        self.leaders = 0
        self.shared = 0

    @property
    def in_flight(self) -> int:
        return len(self._calls)

    async def do(self, key: str, fn: Callable[[], Awaitable[T]]) -> T:
        existing = self._calls.get(key)
        if existing is not None:
            self.shared += 1
            try:
                return await asyncio.shield(existing)
            except asyncio.CancelledError:
                task = asyncio.current_task()
                # The leader was cancelled, not this caller: do the work ourselves.
                if existing.cancelled() and not (task and task.cancelling()):
                    return await fn()
                raise

        future: asyncio.Future = asyncio.get_running_loop().create_future()
        self._calls[key] = future
        self.leaders += 1
        try:
            result = await fn()
        except asyncio.CancelledError:
            future.cancel()
            raise
        except BaseException as exc:
            future.set_exception(exc)
            # Mark retrieved so a leader without followers does not log a warning.
            future.exception()
            raise
        else:
            future.set_result(result)
            return result
        finally:
            self._calls.pop(key, None)

    def snapshot(self) -> dict:
        return {"leaders": self.leaders, "shared": self.shared, "in_flight": self.in_flight}

    def reset(self) -> None:
        self._calls.clear()
        self.leaders = 0
        self.shared = 0
