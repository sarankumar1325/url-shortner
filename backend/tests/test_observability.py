import json
import logging
from collections.abc import Iterator

import pytest
from httpx import ASGITransport, AsyncClient
from starlette.requests import Request

from backend.core.access_log import ACCESS_LOGGER_NAME
from backend.core.problems import ERROR_LOGGER_NAME, unhandled_exception_handler
from backend.main import app


class _Capture(logging.Handler):
    def __init__(self) -> None:
        super().__init__()
        self.messages: list[str] = []
        self.records: list[logging.LogRecord] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.messages.append(record.getMessage())
        self.records.append(record)


@pytest.fixture
def access_log() -> Iterator[_Capture]:
    capture = _Capture()
    logger = logging.getLogger(ACCESS_LOGGER_NAME)
    logger.addHandler(capture)
    yield capture
    logger.removeHandler(capture)


@pytest.mark.asyncio
async def test_access_log_uses_route_template_without_query(access_log: _Capture) -> None:
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get("/health?token=super-secret")

    assert response.status_code == 200
    assert len(access_log.messages) == 1
    message = access_log.messages[0]
    payload = json.loads(message)
    assert payload["event"] == "request"
    assert payload["service"] == "shortly-api"
    assert payload["method"] == "GET"
    assert payload["route"] == "/health"
    assert payload["status"] == 200
    assert payload["error_code"] is None
    assert payload["request_id"]
    assert "super-secret" not in message


@pytest.mark.asyncio
async def test_access_log_records_not_found_without_leaking_path(access_log: _Capture) -> None:
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get(
            "/not/a/route?token=super-secret",
            headers={"X-Request-ID": "6f1c2f4a-3b3e-4c5d-8a9b-0c1d2e3f4a5b"},
        )

    assert response.status_code == 404
    message = access_log.messages[0]
    payload = json.loads(message)
    assert payload["route"] == "unmatched"
    assert payload["status"] == 404
    assert payload["error_code"] == "not_found"
    assert payload["request_id"] == "6f1c2f4a-3b3e-4c5d-8a9b-0c1d2e3f4a5b"
    assert "not/a/route" not in message
    assert "super-secret" not in message


@pytest.mark.asyncio
async def test_unhandled_exception_is_logged_with_its_traceback() -> None:
    capture = _Capture()
    logger = logging.getLogger(ERROR_LOGGER_NAME)
    logger.addHandler(capture)
    request = Request(
        {
            "type": "http",
            "method": "GET",
            "scheme": "http",
            "server": ("test", 80),
            "path": "/api/v1/dashboard",
            "root_path": "",
            "query_string": b"",
            "headers": [],
        }
    )
    try:
        try:
            raise RuntimeError("boom")
        except RuntimeError as exc:
            response = await unhandled_exception_handler(request, exc)
    finally:
        logger.removeHandler(capture)

    assert response.status_code == 500
    assert len(capture.records) == 1
    record = capture.records[0]
    assert record.levelno == logging.ERROR
    assert record.exc_info and record.exc_info[0] is RuntimeError
    payload = json.loads(record.getMessage())
    assert payload["event"] == "unhandled_exception"
    assert payload["exception"] == "RuntimeError"
    assert payload["method"] == "GET"
