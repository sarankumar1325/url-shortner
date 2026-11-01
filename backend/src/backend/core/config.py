from functools import lru_cache
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict

Environment = Literal["local", "test", "preview", "production"]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    app_name: str = "URL Shortener API"
    environment: Environment = "local"
    debug: bool = False
    api_prefix: str = "/api/v1"

    database_url: str = ""
    database_url_direct: str = ""

    upstash_redis_rest_url: str = ""
    upstash_redis_rest_token: str = ""

    # Base secret (base64 or hex). The token pepper and replay-encryption key
    # are derived from it with HKDF so one rotation rotates both.
    secret_key: str = ""

    short_base_url: str = "http://localhost:8000"
    cors_origins: list[str] = ["http://localhost:5173"]
    # Web app origin for links on visitor pages; falls back to the first CORS origin.
    web_base_url: str = ""
    # Hostnames (and their subdomains) that may never be link destinations.
    # The short host itself is always rejected to prevent redirect loops.
    blocked_hosts: list[str] = []
    cron_secret: str = ""

    redirect_cache_seconds: int = 60
    replay_ttl_seconds: int = 86400
    raw_click_retention_days: int = 90
    daily_retention_days: int = 730
    session_ttl_seconds: int = 60 * 60 * 24 * 30
    # Server-side lifetime of sessions created without "Stay signed in".
    short_session_ttl_seconds: int = 60 * 60 * 24
    invitation_ttl_seconds: int = 60 * 60 * 24 * 7
    # Vercel Hobby allows only daily cron, so production drains a bounded
    # batch when analytics is read instead of waiting for the daily job.
    drain_on_read: bool = False
    # A pending stream message becomes claimable after this idle period, and is
    # dead-lettered once reclaiming it has failed this many times.
    analytics_claim_min_idle_seconds: int = 60
    analytics_max_attempts: int = 5


@lru_cache
def get_settings() -> Settings:
    return Settings()
