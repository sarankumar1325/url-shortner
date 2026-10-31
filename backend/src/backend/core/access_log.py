"""Safe structured access logs: bounded route templates, never raw paths."""

import json
import logging
import sys
import time

from fastapi import Request
from starlette.middleware.base import BaseHTTPMiddleware

from backend.core.config import get_settings
from backend.core.problems import get_request_id

ACCESS_LOGGER_NAME = "shortly.access"
_logger = logging.getLogger(ACCESS_LOGGER_NAME)


def configure_access_logging() -> None:
    if _logger.handlers:
        return
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(logging.Formatter("%(message)s"))
    _logger.addHandler(handler)
    _logger.setLevel(logging.INFO)
    _logger.propagate = False


class AccessLogMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        started = time.perf_counter()
        try:
            response = await call_next(request)
        except Exception:
            self._log(request, 500, started, "internal_error")
            raise
        self._log(request, response.status_code, started)
        return response

    @staticmethod
    def _log(request: Request, status: int, started: float, error_code: str | None = None) -> None:
        route = request.scope.get("route")
        settings = get_settings()
        payload = {
            "event": "request",
            "service": "shortly-api",
            "environment": settings.environment,
            "request_id": get_request_id(request),
            "method": request.method,
            "route": getattr(route, "path", "unmatched"),
            "status": status,
            "duration_ms": round((time.perf_counter() - started) * 1000, 1),
            "error_code": error_code or getattr(request.state, "error_code", None),
        }
        _logger.log(
            logging.ERROR if status >= 500 else logging.INFO,
            json.dumps(payload, separators=(",", ":")),
        )
