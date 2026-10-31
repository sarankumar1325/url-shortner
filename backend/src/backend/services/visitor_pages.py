"""Server-rendered pages for people who open short links in a browser.

API clients keep receiving Problem Details; these pages only answer requests
that accept HTML. Every interpolated value is escaped, and the page loads no
external resources so a strict CSP can apply.
"""

import ipaddress
from datetime import datetime
from html import escape
from urllib.parse import quote, urlsplit

from fastapi.responses import HTMLResponse

from backend.core.config import get_settings

KNOWN_SHORTENERS = frozenset(
    {
        "bit.ly",
        "buff.ly",
        "cutt.ly",
        "goo.gl",
        "is.gd",
        "ow.ly",
        "rebrand.ly",
        "shorturl.at",
        "t.co",
        "tiny.cc",
        "tinyurl.com",
    }
)

PAGE_HEADERS = {
    "Cache-Control": "no-store",
    "X-Robots-Tag": "noindex, nofollow",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": (
        "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; "
        "form-action 'none'; frame-ancestors 'none'"
    ),
}

_STYLE = """
:root{color-scheme:light dark;--bg:#f6f4ef;--card:#fffdf8;--ink:#1d1b18;--muted:#6b665d;
--line:#e4dfd4;--accent:#1f5f4a;--accent-ink:#fff;--warn:#8a4b0f;--warn-bg:#fbf0e1}
@media (prefers-color-scheme:dark){:root{--bg:#151412;--card:#1e1c19;--ink:#f2efe8;
--muted:#a39d92;--line:#33302b;--accent:#7fc8a9;--accent-ink:#10231b;--warn:#f0b56f;
--warn-bg:#2d2215}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;
padding:24px;background:var(--bg);color:var(--ink);
font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
main{width:100%;max-width:560px;background:var(--card);border:1px solid var(--line);
border-radius:18px;padding:32px}
.brand{font-weight:650;letter-spacing:-.01em;color:var(--muted);font-size:14px;margin:0 0 20px}
h1{font-size:26px;line-height:1.2;letter-spacing:-.02em;margin:0 0 10px}
p{margin:0 0 14px;color:var(--muted)}
.host{font-size:22px;font-weight:650;color:var(--ink);overflow-wrap:anywhere;margin:4px 0 6px}
.url{font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--bg);
border:1px solid var(--line);border-radius:10px;padding:10px 12px;overflow-wrap:anywhere;
color:var(--ink);margin:0 0 18px}
.label{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:0}
ul.signals{list-style:none;padding:0;margin:0 0 18px;display:grid;gap:8px}
ul.signals li{background:var(--warn-bg);color:var(--warn);border-radius:10px;padding:10px 12px;
font-size:14px}
.ok{font-size:14px;margin:0 0 18px}
.actions{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-top:8px}
a.button{display:inline-block;background:var(--accent);color:var(--accent-ink);
text-decoration:none;font-weight:600;padding:11px 18px;border-radius:999px}
a.button:focus-visible,a.quiet:focus-visible{outline:3px solid var(--accent);outline-offset:3px}
a.quiet{color:var(--muted);font-size:14px}
code{font:inherit;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
"""


def _web_base_url() -> str:
    settings = get_settings()
    base = settings.web_base_url or (settings.cors_origins[0] if settings.cors_origins else "")
    return base.rstrip("/")


def _report_link(code: str) -> str:
    base = _web_base_url()
    if not base:
        return ""
    href = f"{base}/report?code={quote(code, safe='')}"
    return f'<a class="quiet" href="{escape(href)}">Report this link</a>'


def _page(title: str, body: str) -> str:
    return (
        '<!doctype html><html lang="en"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1">'
        '<meta name="robots" content="noindex,nofollow">'
        f"<title>{escape(title)} · Shortly</title><style>{_STYLE}</style></head>"
        f'<body><main><p class="brand">Shortly</p>{body}</main></body></html>'
    )


def _display_code(code: str) -> str:
    return code if len(code) <= 64 else f"{code[:64]}…"


def destination_signals(long_url: str) -> list[str]:
    """Offline hints about a destination. Never fetches the URL."""
    parts = urlsplit(long_url)
    host = (parts.hostname or "").lower()
    signals: list[str] = []
    if parts.scheme == "http":
        signals.append("This destination does not use HTTPS, so the connection is not encrypted.")
    try:
        ipaddress.ip_address(host)
    except ValueError:
        pass
    else:
        signals.append("The destination is a raw IP address rather than a named website.")
    if any(label.startswith("xn--") for label in host.split(".")):
        try:
            readable = host.encode("ascii").decode("idna")
        except UnicodeError:
            readable = host
        signals.append(
            f"The domain uses international characters ({readable}). "
            "Check that it is not imitating a site you know."
        )
    if host.removeprefix("www.") in KNOWN_SHORTENERS:
        signals.append("This points to another link shortener, so the final destination is hidden.")
    try:
        port = parts.port
    except ValueError:
        port = None
    if port is not None and port not in (80, 443):
        signals.append(f"The destination uses an unusual network port ({port}).")
    return signals


def _format_expiry(expires_at: str | None) -> str | None:
    if not expires_at:
        return None
    try:
        moment = datetime.fromisoformat(expires_at)
    except ValueError:
        return None
    return moment.strftime("%d %b %Y, %H:%M UTC")


def unavailable_response(code: str, status: int, reason: str = "") -> HTMLResponse:
    shown = escape(_display_code(code))
    if reason == "link_exhausted":
        title = "This link has been used up"
        message = (
            f"The short link <code>{shown}</code> allowed a limited number of visits, and "
            "they have all been used. Ask the person who shared it for a new link."
        )
    elif status == 410:
        title = "This link has expired"
        message = (
            f"The short link <code>{shown}</code> reached its expiry date and no longer "
            "redirects. If you were expecting it to work, ask the person who shared it "
            "for an updated link."
        )
    else:
        title = "This link isn’t available"
        message = (
            f"The short link <code>{shown}</code> doesn’t exist, was removed, or has "
            "been paused by its owner. Check for a typo, or ask the person who shared it."
        )
    report = _report_link(code)
    actions = f'<div class="actions">{report}</div>' if report else ""
    body = f"<h1>{escape(title)}</h1><p>{message}</p>{actions}"
    return HTMLResponse(_page(title, body), status_code=status, headers=PAGE_HEADERS)


def preview_response(
    code: str,
    long_url: str,
    expires_at: str | None,
    *,
    via_fallback: bool = False,
    limited: bool = False,
) -> HTMLResponse:
    parts = urlsplit(long_url)
    host = (parts.hostname or long_url).removeprefix("www.")
    signals = destination_signals(long_url)
    if signals:
        checks = (
            '<p class="label">Worth a second look</p><ul class="signals">'
            + "".join(f"<li>{escape(signal)}</li>" for signal in signals)
            + "</ul>"
        )
    else:
        checks = (
            '<p class="ok">No warning signs in the address itself. Shortly checks the '
            "address only, not the page content.</p>"
        )
    expiry = _format_expiry(expires_at)
    if via_fallback:
        notes = (
            "<p>The original link is no longer active, so it now leads to the "
            "fallback page its owner chose.</p>"
        )
    else:
        notes = f"<p>This link expires {escape(expiry)}.</p>" if expiry else ""
        if limited:
            notes += "<p>This is a limited-use link. Opening it uses one of its visits.</p>"
    report = _report_link(code)
    body = (
        f"<h1>Before you go</h1><p>This short link leads to</p>"
        f'<p class="host">{escape(host)}</p>'
        f'<p class="label">Full address</p><p class="url">{escape(long_url)}</p>'
        f"{checks}{notes}"
        f'<div class="actions"><a class="button" href="/{quote(code, safe="")}" '
        f'rel="noreferrer">Continue to {escape(host)}</a>{report}</div>'
    )
    return HTMLResponse(_page(f"Preview {host}", body), headers=PAGE_HEADERS)
