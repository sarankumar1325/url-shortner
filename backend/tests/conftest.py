import pytest

from backend.core import metrics
from backend.core.redis import breaker


@pytest.fixture(autouse=True)
def _reset_process_state():
    breaker.reset()
    metrics.reset()
    yield
    breaker.reset()
    metrics.reset()
