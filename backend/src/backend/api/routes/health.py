from typing import Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from backend.api.deps import get_api_session
from backend.core.problems import APIError
from backend.core.redis import command

router = APIRouter(tags=["system"])
# Same probes under the API prefix, so the web app can warm the function and
# the database up through its same-origin /api rewrite.
api_router = APIRouter(tags=["system"])


class HealthResponse(BaseModel):
    status: Literal["ok"] = "ok"


class ReadyResponse(BaseModel):
    status: Literal["ok", "unavailable"]


@router.get("/health", response_model=HealthResponse, summary="Liveness probe")
@api_router.get("/health", response_model=HealthResponse, summary="Liveness probe and warm-up")
async def health() -> HealthResponse:
    return HealthResponse()


@router.get("/ready", response_model=ReadyResponse, summary="Readiness probe")
@api_router.get("/ready", response_model=ReadyResponse, summary="Readiness probe and warm-up")
async def ready(session: AsyncSession = Depends(get_api_session)) -> ReadyResponse:
    try:
        await session.execute(text("SELECT 1"))
        await command("PING")
    except Exception:
        raise APIError(
            503, "dependency_unavailable", "A required dependency is unavailable."
        ) from None
    return ReadyResponse(status="ok")
