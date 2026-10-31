from fastapi import APIRouter

from backend.api.routes import abuse, auth, dashboard, links, system, workspaces

api_router = APIRouter()
api_router.include_router(auth.router)
api_router.include_router(workspaces.router)
api_router.include_router(links.router)
api_router.include_router(abuse.router)
api_router.include_router(system.router)
api_router.include_router(dashboard.router)
