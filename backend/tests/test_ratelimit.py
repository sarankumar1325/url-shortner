import pytest

from backend.core.problems import APIError
from backend.core.redis import RedisError
from backend.services import ratelimit


@pytest.mark.asyncio
async def test_rate_limit_fails_closed(monkeypatch: pytest.MonkeyPatch) -> None:
    async def unavailable(*_args, **_kwargs):
        raise RedisError("down")

    monkeypatch.setattr(ratelimit, "pipeline", unavailable)
    with pytest.raises(APIError) as error:
        await ratelimit.check_rate_limit("create:test", 10)
    assert error.value.status == 503


@pytest.mark.asyncio
async def test_redirect_rate_limit_fails_open(monkeypatch: pytest.MonkeyPatch) -> None:
    async def unavailable(*_args, **_kwargs):
        raise RedisError("down")

    monkeypatch.setattr(ratelimit, "pipeline", unavailable)
    allowed, retry_after = await ratelimit.check_rate_limit("redirect:test", 600, fail_open=True)
    assert allowed is True
    assert retry_after == 0
