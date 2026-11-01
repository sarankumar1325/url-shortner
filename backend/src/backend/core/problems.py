"""RFC 9457 Problem Details responses."""

import json
import logging

from fastapi import Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

MEDIA_TYPE = "application/problem+json"
ERROR_LOGGER_NAME = "shortly.errors"
_error_logger = logging.getLogger(ERROR_LOGGER_NAME)


def get_request_id(request: Request) -> str:
    return getattr(request.state, "request_id", "")


class APIError(Exception):
    def __init__(
        self,
        status: int,
        code: str,
        detail: str,
        title: str | None = None,
        headers: dict[str, str] | None = None,
        errors: list[dict[str, str]] | None = None,
    ) -> None:
        self.status = status
        self.code = code
        self.detail = detail
        self.title = title
        self.headers = headers or {}
        self.errors = errors
        super().__init__(detail)


def problem_response(
    request: Request,
    status: int,
    code: str,
    detail: str,
    title: str,
    headers: dict[str, str] | None = None,
    errors: list[dict[str, str]] | None = None,
) -> JSONResponse:
    body: dict = {
        "type": "about:blank",
        "title": title,
        "status": status,
        "detail": detail,
        "instance": request.url.path,
        "code": code,
        "request_id": get_request_id(request),
    }
    request.state.error_code = code
    if errors:
        body["errors"] = errors
    return JSONResponse(
        status_code=status,
        content=body,
        media_type=MEDIA_TYPE,
        headers={"Cache-Control": "no-store", **(headers or {})},
    )


async def api_error_handler(request: Request, exc: APIError) -> JSONResponse:
    return problem_response(
        request,
        exc.status,
        exc.code,
        exc.detail,
        exc.title or "Request failed",
        exc.headers,
        exc.errors,
    )


async def http_exception_handler(request: Request, exc: StarletteHTTPException) -> JSONResponse:
    code = {404: "not_found", 405: "method_not_allowed", 413: "payload_too_large"}.get(
        exc.status_code, "http_error"
    )
    return problem_response(
        request,
        exc.status_code,
        code,
        str(exc.detail),
        {404: "Not Found", 405: "Method Not Allowed", 413: "Payload Too Large"}.get(
            exc.status_code, "Error"
        ),
        getattr(exc, "headers", None),
    )


async def validation_exception_handler(
    request: Request, exc: RequestValidationError
) -> JSONResponse:
    errors = []
    for error in exc.errors():
        field = ".".join(str(part) for part in error.get("loc", ())[1:]) or "body"
        errors.append(
            {"field": field, "code": "invalid", "message": error.get("msg", "Invalid value")}
        )
    return problem_response(
        request,
        422,
        "validation_error",
        "One or more fields are invalid.",
        "Validation Error",
        errors=errors,
    )


async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    route = request.scope.get("route")
    _error_logger.error(
        json.dumps(
            {
                "event": "unhandled_exception",
                "request_id": get_request_id(request),
                "method": request.method,
                "route": getattr(route, "path", "unmatched"),
                "exception": type(exc).__name__,
            },
            separators=(",", ":"),
        ),
        exc_info=exc,
    )
    return problem_response(
        request,
        500,
        "internal_error",
        "An unexpected error occurred.",
        "Internal Server Error",
    )
