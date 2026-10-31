"""URL validation per docs/backend/short-links.md — syntactic abuse reduction."""

import ipaddress
import re
from urllib.parse import urlsplit

from backend.core.problems import APIError

RESERVED_SEGMENTS = frozenset(
    {
        "api",
        "health",
        "ready",
        "docs",
        "redoc",
        "openapi.json",
        "admin",
        "login",
        "logout",
        "signup",
        "invite",
        "invitations",
        "workspaces",
        "members",
        "settings",
        "static",
        "assets",
        "favicon.ico",
        "robots.txt",
        "sitemap.xml",
        ".well-known",
        "well-known",
        "internal",
        "metrics",
        "report",
        "_next",
        "graphql",
    }
)

ALIAS_PATTERN = re.compile(r"^[a-z0-9][a-z0-9_-]{1,30}[a-z0-9]$")
TAG_PATTERN = re.compile(r"^[a-z0-9]([a-z0-9-]{0,22}[a-z0-9])?$")

MAX_URL_LENGTH = 8192
MAX_ALIAS_LENGTH = 32
MIN_ALIAS_LENGTH = 3
MAX_TAGS = 5
MAX_TAG_LENGTH = 24


def _host_matches(host: str, blocked: str) -> bool:
    blocked = blocked.strip().lower().rstrip(".")
    return bool(blocked) and (host == blocked or host.endswith(f".{blocked}"))


def _reject_blocked(host: str, blocked_hosts: list[str], short_host: str | None) -> None:
    candidates = list(blocked_hosts)
    if short_host:
        candidates.append(short_host.lower().rstrip("."))
    if any(_host_matches(host, blocked) for blocked in candidates):
        raise APIError(
            422,
            "url_blocked",
            "That destination is not allowed. Try linking to the original page.",
        )


def validate_long_url(
    raw: str,
    *,
    blocked_hosts: list[str] | None = None,
    short_host: str | None = None,
) -> str:
    if (
        raw != raw.strip()
        or any(c.isspace() or ord(c) < 0x20 or c == "\x7f" for c in raw)
        or "\\" in raw
    ):
        raise APIError(400, "invalid_url", "The destination URL contains invalid characters.")
    if len(raw) > MAX_URL_LENGTH:
        raise APIError(400, "invalid_url", "The destination URL exceeds 8192 characters.")

    parts = urlsplit(raw)
    if parts.scheme.lower() not in ("http", "https"):
        raise APIError(400, "invalid_url", "The destination must be an absolute http(s) URL.")
    if not parts.netloc or parts.username is not None or parts.password is not None:
        raise APIError(400, "invalid_url", "The destination URL has an invalid host.")

    host = parts.hostname
    if host is None:
        raise APIError(400, "invalid_url", "The destination URL has an invalid host.")
    host = host.rstrip(".")
    lowered = host.lower()

    if (
        lowered == "localhost"
        or lowered.endswith(".localhost")
        or lowered.endswith(".local")
        or lowered.endswith(".internal")
    ):
        raise APIError(400, "invalid_url", "Private and local hostnames are not allowed.")

    # IDNA-encode non-ASCII hostnames; reject failures.
    try:
        ascii_host = lowered.encode("idna").decode("ascii") if not lowered.isascii() else lowered
    except UnicodeError:
        raise APIError(400, "invalid_url", "The destination hostname is invalid.") from None

    try:
        address = ipaddress.ip_address(ascii_host)
    except ValueError:
        pass
    else:
        if not address.is_global:
            raise APIError(400, "invalid_url", "Private and reserved addresses are not allowed.")

    _reject_blocked(ascii_host, blocked_hosts or [], short_host)

    # Rebuild scheme/host case normalization, preserve path/query/fragment.
    port = f":{parts.port}" if parts.port else ""
    path = parts.path or "/"
    if not path.startswith("/"):
        path = "/" + path
    return (
        f"{parts.scheme.lower()}://{ascii_host}{port}{path}"
        + (f"?{parts.query}" if parts.query else "")
        + (f"#{parts.fragment}" if parts.fragment else "")
    )


def normalize_tag(raw: str) -> str:
    tag = re.sub(r"[\s_]+", "-", raw.strip().lstrip("#").lower())
    tag = re.sub(r"-{2,}", "-", tag).strip("-")
    if not tag or len(tag) > MAX_TAG_LENGTH or not TAG_PATTERN.match(tag):
        raise APIError(
            422,
            "validation_error",
            "Tags must be 1–24 lowercase letters, digits or hyphens.",
            errors=[
                {
                    "field": "tags",
                    "code": "invalid",
                    "message": "Tags must be 1–24 lowercase letters, digits or hyphens.",
                }
            ],
        )
    return tag


def normalize_tags(tags: list[str] | None) -> list[str]:
    """Canonical, de-duplicated tags; order follows first appearance."""
    if tags is None:
        return []
    normalized: list[str] = []
    for raw in tags:
        tag = normalize_tag(raw)
        if tag not in normalized:
            normalized.append(tag)
    if len(normalized) > MAX_TAGS:
        raise APIError(
            422,
            "validation_error",
            f"Use at most {MAX_TAGS} tags per link.",
            errors=[
                {
                    "field": "tags",
                    "code": "too_many",
                    "message": f"Use at most {MAX_TAGS} tags per link.",
                }
            ],
        )
    return normalized


def validate_custom_alias(alias: str) -> str:
    lowered = alias.lower()
    if lowered != alias:
        raise APIError(400, "validation_error", "Custom aliases must be lowercase.")
    if not MIN_ALIAS_LENGTH <= len(alias) <= MAX_ALIAS_LENGTH:
        raise APIError(400, "validation_error", "Custom aliases must be 3–32 characters.")
    if not ALIAS_PATTERN.match(alias):
        raise APIError(
            400,
            "validation_error",
            "Custom aliases may use lowercase letters, digits, hyphens and underscores.",
        )
    if alias in RESERVED_SEGMENTS:
        raise APIError(400, "reserved_alias", "That alias is reserved.")
    return alias
