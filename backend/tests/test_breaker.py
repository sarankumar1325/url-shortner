import httpx
import pytest

from backend.core import redis
from backend.core.breaker import CircuitBreaker


class _Clock:
    def __init__(self) -> None:
        self.now = 100.0

    def __call__(self) -> float:
        return self.now


def test_opens_after_threshold_and_rejects_fast() -> None:
    clock = _Clock()
    breaker = CircuitBreaker("test", failure_threshold=3, reset_after=10, clock=clock)
    for _ in range(3):
        assert breaker.allow()
        breaker.record_failure("timeout")

    assert breaker.state == "open"
    assert breaker.allow() is False
    assert breaker.snapshot()["rejected"] == 1
    assert breaker.snapshot()["times_opened"] == 1


def test_success_resets_the_failure_streak() -> None:
    breaker = CircuitBreaker("test", failure_threshold=3)
    breaker.record_failure("timeout")
    breaker.record_failure("timeout")
    breaker.record_success()
    breaker.record_failure("timeout")

    assert breaker.state == "closed"


def test_half_open_allows_one_trial_then_closes_on_success() -> None:
    clock = _Clock()
    breaker = CircuitBreaker("test", failure_threshold=1, reset_after=10, clock=clock)
    breaker.record_failure("timeout")
    clock.now += 10

    assert breaker.state == "half_open"
    assert breaker.allow() is True
    assert breaker.allow() is False
    breaker.record_success()
    assert breaker.state == "closed"


def test_failed_trial_reopens_the_circuit() -> None:
    clock = _Clock()
    breaker = CircuitBreaker("test", failure_threshold=1, reset_after=10, clock=clock)
    breaker.record_failure("timeout")
    clock.now += 10
    assert breaker.allow()
    breaker.record_failure("timeout")

    assert breaker.state == "open"
    assert breaker.snapshot()["retry_in_seconds"] == 10


class _CountingBrokenClient:
    def __init__(self) -> None:
        self.calls = 0

    async def post(self, *args, **kwargs):
        self.calls += 1
        raise httpx.ConnectTimeout("upstash timed out")


@pytest.mark.asyncio
async def test_redis_client_stops_calling_upstash_once_open(monkeypatch) -> None:
    client = _CountingBrokenClient()
    monkeypatch.setattr(redis, "get_client", lambda: client)

    for _ in range(redis.breaker.failure_threshold):
        with pytest.raises(redis.RedisError):
            await redis.command("PING")
    with pytest.raises(redis.CircuitOpenError):
        await redis.command("PING")

    assert client.calls == redis.breaker.failure_threshold


class _Response:
    status_code = 200

    def json(self):
        return [{"error": "NOGROUP no such group"}]


class _CommandErrorClient:
    async def post(self, *args, **kwargs):
        return _Response()


@pytest.mark.asyncio
async def test_command_errors_do_not_trip_the_breaker(monkeypatch) -> None:
    monkeypatch.setattr(redis, "get_client", lambda: _CommandErrorClient())

    for _ in range(redis.breaker.failure_threshold + 1):
        with pytest.raises(redis.RedisError) as error:
            await redis.command("XPENDING", "s", "g")
        assert not isinstance(error.value, redis.CircuitOpenError)

    assert redis.breaker.state == "closed"
