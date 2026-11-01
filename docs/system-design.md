# System design showcase

Shortly is a URL shortener, but most of the code exists to make it behave well under load, during outages, and around untrusted input. The in-app **System design** page (`/system`) lists each technique with the file that implements it and, where possible, a live signal from the running API instance. This document is the written version of that page.

Live numbers come from `GET /api/v1/system/status`. They are per instance, kept in memory, and reset on a cold start. They show behavior; they are not a metrics pipeline, a benchmark, or a capacity claim. The same response carries a `config` block (code length and space, every rate limit, cache TTLs, breaker thresholds, analytics and retention settings) read from the running code, and the page fills its descriptions from it, so the numbers in the app never drift from the deployment. The tables below quote the defaults at the time of writing.

## Request path

```mermaid
flowchart LR
    Visitor -->|GET /code| Limit[Rate limit\nfail-open]
    Limit --> Cache{Redis\nredirect cache}
    Cache -->|hit| Redirect[302]
    Cache -->|miss| SF[Single-flight\none load per key]
    SF --> PG[(Postgres)]
    PG --> Fill[SETEX 60s] --> Redirect
    Redirect --> Stream[XADD click event]
    Stream -.->|later| Drain[Consumer group drain] -.-> Rollups[(Daily rollups)]
    Breaker[[Circuit breaker]] -. guards every Redis call .- Cache
```

## Performance

| Technique | How it works | Tradeoff | Code |
| --- | --- | --- | --- |
| Cache-aside redirect cache | A miss loads the link from Postgres and writes a small JSON entry with a 60 second TTL. Only live links are cached; edits and deletes evict the key. | Changes made elsewhere can take up to one TTL to land everywhere. | `backend/src/backend/api/routes/redirect.py` |
| Single-flight cache fills | The first request for a missing key becomes the leader and runs the load. Concurrent requests for the same key await its result, which prevents a cache stampede. | Coalescing is per process; each serverless instance still loads once. | `backend/src/backend/core/singleflight.py` |
| Analytics off the hot path | Each redirect appends one event to a Redis Stream. A consumer drains it in batches into Postgres later. | Charts are eventually consistent. | `backend/src/backend/services/analytics.py` |
| Daily rollups | Ingestion upserts `click_daily` counters keyed by `(url_id, day)` in a consistent order to avoid deadlocks. | Finer breakdowns need raw clicks, kept 90 days. | `backend/src/backend/services/analytics.py` |
| Cached top-links leaderboard | The ranking over daily rollups is cached per workspace for 60 seconds, behind single-flight. | Rankings lag by up to a minute plus queued events. | `backend/src/backend/services/leaderboard.py` |
| Random base62 codes | Five CSPRNG base62 characters (~916 million codes). A unique index catches collisions; creation retries up to five times. Retired codes are skipped. | Codes are unguessable but unordered. | `backend/src/backend/core/security.py` |
| One-query session context | Each authenticated request loads the session, user and selected workspace role in one joined query, and renews a persistent session in the same request when needed. | One wider query instead of three narrow ones. | `backend/src/backend/services/auth.py` |
| Pipelined rate limits | `check_rate_limits` sends several fixed-window counters in one Redis pipeline; login checks per-IP and per-account limits in one round trip. | All rules share one failure policy. | `backend/src/backend/services/ratelimit.py` |
| Server-Timing | Every response reports Postgres and Redis time and call counts plus the total, visible in the browser's Network panel. | Covers work done before the response starts, not streaming. | `backend/src/backend/core/timing.py` |
| Warm-up on auth pages | The login and signup pages fetch `/api/v1/ready` once on mount, so a cold function and database start while the user types. | One extra request per visit. | `urlshortner/src/api.ts` |
| Cached app shell | The last account summary (no token) is kept in localStorage; on reload the shell renders from it and links load in parallel with `/auth/me`. A `401` clears it. | The shell can show stale workspace names for one round trip. | `urlshortner/src/sessionCache.ts` |
| Saved links list | The last links list per workspace (link fields only) is kept in sessionStorage; a reload draws it at once and refreshes it in the background. Sign-out clears it. | A link changed in another tab shows its old state until the refresh lands. | `urlshortner/src/linksCache.ts` |

## Reliability

| Technique | How it works | Tradeoff | Code |
| --- | --- | --- | --- |
| Circuit breaker on Redis | Five consecutive transport failures open the circuit for 15 seconds. Then one trial call is allowed: success closes it, failure reopens it. Command errors do not count, because Redis answered. | While open, caching is skipped and limiters apply their fail-open or fail-closed policy. | `backend/src/backend/core/breaker.py`, `backend/src/backend/core/redis.py` |
| Fail-open / fail-closed rate limits | A fixed-window counter (`INCR` + `EXPIRE NX` in one pipeline). Redirects fail open; sign-in and writes fail closed. | Fixed windows allow bursts at window edges. | `backend/src/backend/services/ratelimit.py` |
| Durable consumer group | `XREADGROUP`, ACK only after the Postgres commit, `XAUTOCLAIM` for stale messages, dead-letter stream for repeated failures. | At-least-once delivery, made safe by event-ID dedupe. | `backend/src/backend/services/analytics.py` |
| Idempotency keys | Each create carries an `Idempotency-Key`; the first response is stored encrypted and replayed for 24 hours. | Very late retries create new links. | `backend/src/backend/services/links.py` |
| Atomic guarded counters | One `UPDATE ... WHERE clicks_used < max_clicks` enforces visit limits under concurrency. | Limited links always hit Postgres for that check. | `backend/src/backend/services/links.py` |
| Drain on read | Opening analytics drains a bounded batch first, because the free plan only allows a daily cron. | The first view after a busy period is slower. | `backend/src/backend/api/routes/links.py` |
| Liveness and readiness | `/health` does no I/O; `/ready` runs `SELECT 1` and `PING`. Both are also served under `/api/v1/` for warm-up through the web app's rewrite. | One instance at one moment. | `backend/src/backend/api/routes/health.py` |

## Data, security and product safety

| Technique | Summary | Code |
| --- | --- | --- |
| Workspaces with RBAC | `X-Workspace-Id` is resolved against membership on every request; owner > admin > member > viewer. | `backend/src/backend/api/deps.py` |
| Soft deletes | Deleted codes stay in the unique index and are never reissued. | `backend/src/backend/services/links.py` |
| Retired codes | Workspace and account deletion copy their codes into `retired_short_codes` before the hard delete, so no code is ever reissued. | `backend/src/backend/services/retired_codes.py` |
| Tiered retention | Raw clicks 90 days, rollups two years, deleted in batches of 1,000. | `backend/src/backend/services/analytics.py` |
| Argon2id and hashed tokens | Passwords use Argon2id at OWASP parameters (t=2, 19 MiB, p=1) and are rehashed on login when the parameters change; session tokens are SHA-256 hashes; management tokens are HMACs. | `backend/src/backend/core/security.py` |
| Stay signed in | Persistent sessions get a 30-day cookie that renews past half its life; otherwise a browser-session cookie and a 24-hour server expiry. | `backend/src/backend/api/deps.py` |
| Self-service account deletion | Password plus typed email; blocked while the user owns shared workspaces with other members. | `backend/src/backend/services/accounts.py` |
| HKDF and AES-GCM | One secret is expanded into a token pepper and a replay-encryption key. | `backend/src/backend/core/security.py` |
| Origin checks | Cookie-authenticated writes must come from an allowed origin. | `backend/src/backend/api/deps.py` |
| Destination validation | Rejects private/reserved IPs, local names, blocked hosts and redirect loops. | `backend/src/backend/services/validation.py` |
| Problem details and request IDs | RFC 9457 errors; `X-Request-ID` in responses and JSON access logs. | `backend/src/backend/core/problems.py` |
| Peek | `/{code}+` previews the destination with offline risk checks and never counts a click. | `backend/src/backend/services/visitor_pages.py` |
| Link-previewer classification | Chat unfurlers do not consume visit limits; bots are tagged. | `backend/src/backend/services/links.py` |
| Live alias availability | Syntax and reserved words, then a redirect-cache probe, then one indexed lookup. Rate limited per IP. Creation still enforces uniqueness. | `backend/src/backend/services/links.py` |
| Privacy-first analytics | Referrer origin, country and device class only; no IP addresses. | `backend/src/backend/services/analytics.py` |

## Request tracer

The **Trace a real redirect** panel sends one of your links through the same code a visitor hits, step by step, and reports how long each step took on the server. `POST /api/v1/system/trace` with `{"code": "...", "cold": true}` runs:

1. the redirect rate limiter (in its own `trace:` bucket, so tracing cannot lock real visitors out),
2. an optional cache eviction when `cold` is true,
3. the Redis cache read,
4. on a miss, the single-flight leader election, the Postgres load and the cache fill,
5. the expiry check and, for limited links, a read-only visit-limit check.

The response lists each step with `ms`, an `outcome` (`hit`, `miss`, `leader`, `loaded`, `skipped`, ...) and a detail line, plus the response a visitor would get (`302`, `404` or `410` and the reason). It never appends a click event and never consumes a visit; the enqueue step is reported as `skipped`. **Cold vs warm** runs an evicting trace and then a cached one and shows the speedup. Traces are limited per user, and only links in the active workspace can be traced.

## Workspace dashboard

`/dashboard` shows every link in the workspace at once. `GET /api/v1/dashboard?days=7|30|90` drains a bounded batch of queued clicks first (when drain-on-read is enabled), then returns:

- totals and a zero-filled daily series from rollups, with the previous period of the same length and the relative change,
- referrer, country and device breakdowns from retained raw events,
- a status count with one status per link, in the order blocked, expired, used up, then active or paused,
- per-link health: clicks this and last period, last click time, visit-limit usage, and issues such as `expiring_soon` (within 7 days), `near_limit` (80% of visits used), `no_recent_clicks` (no clicks this period for links older than 7 days) and `serving_fallback`,
- the same ingestion freshness snapshot as link analytics.

The table is capped at 500 links, sorted by clicks.

## Endpoints added for the showcase

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/v1/links/availability?alias=` | Public, rate limited per IP (fails open). Returns `available` and a `reason` of `invalid`, `reserved` or `taken`. Soft-deleted codes count as taken. |
| GET | `/api/v1/links/top?days=1\|7\|30&limit=1..10` | Workspace-scoped, cached briefly. Response includes `cached` and `ttl_seconds`. |
| GET | `/api/v1/system/status` | Requires a signed-in user. Dependency probes with latency, breaker state, cache hit ratio, single-flight leaders/shared counts, rate-limit outcomes, stream backlog and the `config` block. |
| POST | `/api/v1/system/trace` | Workspace-scoped, same-origin, rate limited per user. Traces one redirect with per-step timings; never counts a click. |
| GET | `/api/v1/dashboard?days=7\|30\|90` | Workspace-scoped. Totals with period-over-period change, series, breakdowns, status counts and per-link health. |

## QR studio

The QR studio (`/qr`) runs entirely in the browser; nothing is uploaded.

- **Content:** pick one of the workspace's short links, or paste any link or text into the box (or use **Paste from clipboard**). Bare hosts such as `example.com/menu` get `https://` added so phones open them as links; `javascript:`, `data:` and similar schemes are refused, and content over 1,200 bytes is rejected because it would not fit a code at level H. Pasted content is encoded as is, so its scans are not counted in analytics. Workspaces without links start in paste mode.
- **Density:** the preview shows the QR version and module count. Above version 10 the studio suggests a minimum print width (about 0.4 mm per module). Each style has a tested density limit (square had none up to version 28, the densest tried; bars 22; rounded, dots, dither and halftone 20; diamond and ASCII 17). Past it, the style tile is marked **Too dense** and the warning becomes an error.

- **Styles:** square, rounded, dots, bars, diamond, dither (an ordered 3×3 dither that fades across the code), halftone (dots that shrink toward the edges) and ASCII (characters instead of shapes, from `#@%&`, `0 1` or the link's own code). Finder patterns can be square, rounded or circular.
- **Fonts:** sans, serif, mono, rounded and display, used for the center label and ASCII glyphs. Fonts are loaded before a raster export so the file matches the preview.
- **Scan safety:** a center label or logo, or any artistic style, raises error correction to level H. Low contrast, inverted colors, a thin quiet zone and artistic styles show warnings. Every style, eye and font combination decodes with Chrome's built-in `BarcodeDetector` at 600 px, but test-scan prints anyway.
- **Export:** PNG, JPEG, WebP, SVG, a print-ready PDF (fit-to-code, A4 or Letter; the image is rendered for 600 DPI at the chosen size, with an optional caption) and text art. The preview can be copied as an image, as SVG markup, as text art, or as the link itself.
- **Bulk:** selecting several links produces one ZIP in any of those formats, built in the browser with stored entries.

Each link's detail page also shows its QR code with a PNG download and a link into the studio.
