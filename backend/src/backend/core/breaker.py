"""Circuit breaker for remote dependencies.

After `failure_threshold` consecutive transport failures the circuit opens and
calls fail immediately for `reset_after` seconds instead of each waiting on a
timeout. Then one trial call is let through (half-open): success closes the
circuit, failure opens it again. State is per process, which suits serverless
instances that each see their own network path to Redis.
"""

import time
from collections.abc import Callable
from typing import Literal

State = Literal["closed", "open", "half_open"]


class CircuitBreaker:
    def __init__(
        self,
        name: str,
        *,
        failure_threshold: int = 5,
        reset_after: float = 15.0,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.name = name
        self.failure_threshold = failure_threshold
        self.reset_after = reset_after
        self._clock = clock
        self.reset()

    def reset(self) -> None:
        self._state: State = "closed"
        self._consecutive_failures = 0
        self._opened_at: float | None = None
        self._trial_in_flight = False
        self.calls = 0
        self.failures = 0
        self.rejected = 0
        self.times_opened = 0
        self.last_failure: str | None = None

    @property
    def state(self) -> State:
        if (
            self._state == "open"
            and self._opened_at is not None
            and self._clock() - self._opened_at >= self.reset_after
        ):
            self._state = "half_open"
            self._trial_in_flight = False
        return self._state

    def allow(self) -> bool:
        state = self.state
        if state == "closed":
            self.calls += 1
            return True
        if state == "half_open" and not self._trial_in_flight:
            self._trial_in_flight = True
            self.calls += 1
            return True
        self.rejected += 1
        return False

    def record_success(self) -> None:
        self._consecutive_failures = 0
        self._trial_in_flight = False
        self._state = "closed"
        self._opened_at = None

    def record_failure(self, reason: str) -> None:
        self.failures += 1
        self._consecutive_failures += 1
        self.last_failure = reason
        self._trial_in_flight = False
        if self._state == "half_open" or self._consecutive_failures >= self.failure_threshold:
            if self._state != "open":
                self.times_opened += 1
            self._state = "open"
            self._opened_at = self._clock()

    def snapshot(self) -> dict:
        state = self.state
        retry_in = None
        if state == "open" and self._opened_at is not None:
            retry_in = round(max(0.0, self.reset_after - (self._clock() - self._opened_at)), 1)
        return {
            "name": self.name,
            "state": state,
            "consecutive_failures": self._consecutive_failures,
            "failure_threshold": self.failure_threshold,
            "reset_after_seconds": self.reset_after,
            "retry_in_seconds": retry_in,
            "calls": self.calls,
            "failures": self.failures,
            "rejected": self.rejected,
            "times_opened": self.times_opened,
            "last_failure": self.last_failure,
        }
