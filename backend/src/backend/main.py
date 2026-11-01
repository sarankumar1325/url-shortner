import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.middleware.base import BaseHTTPMiddleware

from backend.api.deps import SessionRenewalMiddleware
from backend.api.router import api_router
from backend.api.routes import health, internal, redirect
from backend.core.access_log import AccessLogMiddleware, configure_access_logging
from backend.core.config import get_settings
from backend.core.problems import (
    APIError,
    api_error_handler,
    http_exception_handler,
    unhandled_exception_handler,
    validation_exception_handler,
)
from backend.core.redis import aclose
from backend.core.timing import ServerTimingMiddleware


class RequestIdMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        try:
            request.state.request_id = str(uuid.UUID(request.headers.get("x-request-id", "")))
        except ValueError:
            request.state.request_id = str(uuid.uuid4())
        response = await call_next(request)
        response.headers["X-Request-ID"] = request.state.request_id
        if request.url.path.startswith("/api/"):
            response.headers.setdefault("Cache-Control", "no-store")
        return response


@asynccontextmanager
async def lifespan(app: FastAPI):
    yield
    await aclose()


def create_app() -> FastAPI:
    settings = get_settings()
    configure_access_logging()

    app = FastAPI(
        title=settings.app_name,
        version="0.1.0",
        debug=settings.debug,
        docs_url="/docs" if settings.environment in ("local", "preview") else None,
        redoc_url=None,
        lifespan=lifespan,
    )
    app.add_middleware(AccessLogMiddleware)
    app.add_middleware(RequestIdMiddleware)
    app.add_middleware(SessionRenewalMiddleware)
    app.add_middleware(ServerTimingMiddleware)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["GET", "HEAD", "POST", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=[
            "Content-Type",
            "Idempotency-Key",
            "X-Management-Token",
            "X-Request-ID",
            "X-Workspace-Id",
        ],
        expose_headers=[
            "Location",
            "X-Request-ID",
            "RateLimit-Limit",
            "RateLimit-Remaining",
            "RateLimit-Reset",
            "Retry-After",
            "Server-Timing",
        ],
    )

    app.include_router(health.router)
    app.include_router(api_router, prefix=settings.api_prefix)
    app.include_router(internal.router)
    # Redirects must be registered last: /{code} would otherwise swallow
    # fixed routes like /health and /api.
    app.include_router(redirect.router)

    app.add_exception_handler(APIError, api_error_handler)
    app.add_exception_handler(StarletteHTTPException, http_exception_handler)
    app.add_exception_handler(RequestValidationError, validation_exception_handler)
    app.add_exception_handler(Exception, unhandled_exception_handler)

    return app


app = create_app()
