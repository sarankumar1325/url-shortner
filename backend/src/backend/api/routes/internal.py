from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from backend.api.deps import get_api_session, verify_cron
from backend.services import abuse as abuse_service
from backend.services import analytics as analytics_service

router = APIRouter(prefix="/internal", tags=["internal"], dependencies=[Depends(verify_cron)])


@router.get("/analytics/drain", summary="Cron: drain queued click events")
async def drain(session: AsyncSession = Depends(get_api_session)) -> dict:
    return await analytics_service.drain_events(session)


@router.get("/analytics/status", summary="Cron: analytics ingestion health")
async def status() -> dict:
    return await analytics_service.ingestion_status()


@router.get("/maintenance", summary="Cron: bounded retention cleanup")
async def maintenance(session: AsyncSession = Depends(get_api_session)) -> dict:
    return await analytics_service.cleanup_expired(session)


@router.get("/abuse-reports", summary="Operator: recent abuse reports")
async def abuse_reports(
    status: str = Query(default="open"),
    limit: int = Query(default=50, ge=1, le=200),
    session: AsyncSession = Depends(get_api_session),
) -> dict:
    reports = await abuse_service.list_reports(session, status, limit)
    return {"reports": reports, "total": len(reports)}
