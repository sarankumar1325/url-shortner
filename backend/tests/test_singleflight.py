import asyncio

import pytest

from backend.core.singleflight import SingleFlight


@pytest.mark.asyncio
async def test_concurrent_callers_share_one_execution() -> None:
    flight = SingleFlight()
    calls = 0
    gate = asyncio.Event()

    async def load() -> str:
        nonlocal calls
        calls += 1
        await gate.wait()
        return "value"

    tasks = [asyncio.create_task(flight.do("k", load)) for _ in range(10)]
    await asyncio.sleep(0)
    gate.set()
    results = await asyncio.gather(*tasks)

    assert results == ["value"] * 10
    assert calls == 1
    assert flight.snapshot() == {"leaders": 1, "shared": 9, "in_flight": 0}


@pytest.mark.asyncio
async def test_errors_reach_every_caller_and_do_not_stick() -> None:
    flight = SingleFlight()
    gate = asyncio.Event()

    async def failing() -> str:
        await gate.wait()
        raise LookupError("missing")

    tasks = [asyncio.create_task(flight.do("k", failing)) for _ in range(3)]
    await asyncio.sleep(0)
    gate.set()
    results = await asyncio.gather(*tasks, return_exceptions=True)

    assert all(isinstance(result, LookupError) for result in results)

    async def ok() -> str:
        return "fresh"

    assert await flight.do("k", ok) == "fresh"


@pytest.mark.asyncio
async def test_followers_recover_when_the_leader_is_cancelled() -> None:
    flight = SingleFlight()
    gate = asyncio.Event()

    async def slow() -> str:
        await gate.wait()
        return "leader"

    async def quick() -> str:
        return "follower"

    leader = asyncio.create_task(flight.do("k", slow))
    await asyncio.sleep(0)
    follower = asyncio.create_task(flight.do("k", quick))
    await asyncio.sleep(0)
    leader.cancel()

    assert await follower == "follower"
    with pytest.raises(asyncio.CancelledError):
        await leader


@pytest.mark.asyncio
async def test_distinct_keys_do_not_coalesce() -> None:
    flight = SingleFlight()

    async def value(name: str) -> str:
        await asyncio.sleep(0)
        return name

    results = await asyncio.gather(
        flight.do("a", lambda: value("a")), flight.do("b", lambda: value("b"))
    )

    assert results == ["a", "b"]
    assert flight.shared == 0
