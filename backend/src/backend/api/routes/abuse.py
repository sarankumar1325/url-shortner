from typing import Literal

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict
from sqlalchemy.ext.asyncio import AsyncSession

from backend.api.deps import (
    client_ip,
    enforce_same_origin,
    get_api_session,
    validate_body_size,
)
from backend.core.problems import APIError
from backend.services import abuse as abuse_service
from backend.services import ratelimit

router = APIRouter(prefix="/abuse-reports", tags=["abuse"])


class AbuseReportRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    short_code: str
    reason: Literal["spam", "phishing", "malware", "impersonation", "other"]
    details: str | None = None
    reporter_email: str | None = None


@router.post(
    "",
    status_code=201,
    summary="Report a short link for abuse",
    dependencies=[Depends(validate_body_size), Depends(enforce_same_origin)],
)
async def report_abuse(
    payload: AbuseReportRequest,
    request: Request,
    session: AsyncSession = Depends(get_api_session),
) -> JSONResponse:
    allowed, retry_after = await ratelimit.check_rate_limit(
        f"abuse:{client_ip(request)}", 5, window_seconds=3600, fail_open=True
    )
    if not allowed:
        raise APIError(
            429,
            "rate_limited",
            "Too many reports from this connection. Try again later.",
            headers={"Retry-After": str(retry_after)},
        )
    result = await abuse_service.create_report(
        session,
        short_code=payload.short_code,
        reason=payload.reason,
        details=payload.details,
        reporter_email=payload.reporter_email,
    )
    return JSONResponse(status_code=201, content=result)
