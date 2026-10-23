# API Contract

Status: target design; only `/health` currently exists · [Architecture](architecture.md) · [Frontend integration](../frontend/data-fetching.md)

## Common rules

- REST base: `/api/v1`; redirects: `/{code}` on the backend deployment, not the SPA.
- UTF-8 JSON, `snake_case`, UTC ISO 8601 timestamps. Reject unknown mutation fields.
- All API, redirect and error responses use `Cache-Control: no-store`. Custom auth headers do not prevent HTTP caching by themselves. No shared CDN caching of private responses.
- Return `X-Request-ID`; accept a bounded validated UUID from callers or generate one. Never reflect arbitrary header text in logs.
- Failures use [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) `application/problem+json`; OpenAPI describes response models, auth, errors and headers.
- Enforce 64 KiB JSON body size while reading (not just trusting Content-Length); serialized destination limit is 8192 characters. Return `413` for an oversized body.
- The contract is a pre-implementation revision, not a migration of an existing production API.

## Authentication and state

V1 has no accounts. Creation yields a 256-bit opaque management token, transported as `X-Management-Token` over HTTPS. The link row stores its HMAC-SHA256 hash plus key version. Creation replay is the explicit short-lived encrypted-storage exception; see below.

| Operation | Token behavior |
| --- | --- |
| Create / public redirect | No token |
| GET metadata without token | Public active, nonexpired link only |
| GET metadata with token | Validate token; allow inactive/expired links for management |
| PATCH / DELETE / analytics | Token required and checked against the database |

If a token is supplied and invalid, return `401 invalid_token`, never silently downgrade to public access. Missing required token also returns `401`. Unknown code is `404`. Deleted/blocked links are `404` after any required token validation, except valid-token repeat DELETE returns `204`. Authorization does not use a redirect cache.

For unauthenticated resolution: missing/deleted/blocked/inactive → `404`; otherwise expired → `410`; otherwise successful. Short codes and public metadata are not secrets.

## Endpoints

| Method | Path | Result |
| --- | --- | --- |
| POST | `/api/v1/links` | `201` creation, including token |
| GET | `/api/v1/links/{code}` | `200` metadata; optional token changes allowed states |
| PATCH | `/api/v1/links/{code}` | `200` updated metadata |
| DELETE | `/api/v1/links/{code}` | `204`, repeatable with valid token |
| GET | `/api/v1/links/{code}/analytics` | `200` private totals/series/breakdowns |
| GET / HEAD | `/{code}` | `302`, `404` or `410`; HEAD never counts a click |
| GET | `/health` | Dependency-free liveness |
| GET | `/ready` | Dependency readiness; `503` if required service unavailable |
| GET | `/internal/analytics/drain` | Cron-authenticated ingestion; no public data |
| GET | `/internal/maintenance` | Cron-authenticated bounded retention cleanup |

## Create

```http
POST /api/v1/links
Content-Type: application/json
Idempotency-Key: 8f14e45f-ea4d-4b1e-9c1a-5f0e2d7a6b31
```

```json
{
  "long_url": "https://example.com/articles/system-design?ref=shortener",
  "custom_alias": "sysdesign",
  "expires_at": "2027-01-01T00:00:00Z"
}
```

- `long_url`: required absolute HTTP(S) URL; [validation policy](short-links.md#destination-validation).
- `custom_alias`: optional/null; lowercase `^[a-z0-9][a-z0-9_-]{1,30}[a-z0-9]$`, 3–32 characters, not reserved. Missing/null means generated code.
- `expires_at`: optional/null means no expiry; otherwise strictly future, at most five years ahead.
- `Idempotency-Key`: required random UUIDv4; generate with `crypto.randomUUID()` or `uuid.uuid4()`.

Return `201` with `Location: /api/v1/links/sysdesign` and:

```json
{
  "short_code": "sysdesign",
  "short_url": "https://short.example/sysdesign",
  "long_url": "https://example.com/articles/system-design?ref=shortener",
  "is_custom_alias": true,
  "is_active": true,
  "expires_at": "2027-01-01T00:00:00Z",
  "created_at": "2026-10-23T12:00:00Z",
  "updated_at": "2026-10-23T12:00:00Z",
  "management_token": "illustrative-token-not-a-real-credential"
}
```

GET/PATCH metadata have the same fields **except `management_token`**. Internal bigint IDs are not exposed. Build `short_url` from trusted configuration, not the incoming Host header.

### Idempotent creation

1. Validate key format and canonical input; hash both. Treat omitted and null optional create fields equivalently. Do not re-evaluate a previously successful request's time-relative expiry check on replay; an expiry that is now past does not invalidate the original result.
2. Serialize requests on the key hash in Postgres. Reserve it, create the link, and encrypt/store the complete successful response in the same transaction.
3. Concurrent same key/body → one link and the same token; different body → `409 idempotency_conflict`. On a bounded key-lock wait → `409 request_in_progress` with `Retry-After`.
4. Same key/body within 24 hours → replay original `201` body and Location, with a fresh request ID. It describes creation, not the current mutable link state; replay cannot reactivate a deleted link or undo a block.
5. Enforce 24-hour expiry during reads and cleanup; after expiry the key is not guaranteed to deduplicate. Do not indefinitely retry an ambiguous request.

The key grants access to the replayed token: redact it as a secret, require high entropy, store only its digest. A random-looking format cannot prove a caller used good randomness; document the client requirement. Store replay ciphertext with AEAD, unique nonces, associated key/request hashes and a separate versioned encryption key. No plaintext response cache in Redis.

Malformed input does not consume a key. Transaction failure rolls back both link and replay reservation; do not commit an incomplete record. A successful DB commit followed by a dropped HTTP response is recoverable using the same key. Required concurrency/crash tests are in [data-model.md](data-model.md).

## Update and delete

PATCH accepts only `long_url`, `expires_at`, `is_active`, and requires at least one field. Null expiry clears it; omission preserves it. Null URL/active values are invalid. Code, token and operator block state cannot be changed. Revalidate URL/expiry, commit, then invalidate the positive cache best-effort.

For v1, concurrent valid PATCH operations use last-committed-write-wins for supplied fields. Do not auto-retry PATCH after ambiguous failure: read authenticated metadata and ask the user to confirm. Conditional versioning can be added if collaborative editing becomes necessary.

DELETE soft-deletes atomically and invalidates the cache. Repeat DELETE with the correct token returns `204`; unknown or operator-blocked codes return `404`. The token cannot read analytics or mutate a deleted link. "Forget locally" is a separate frontend action and never deletes the server resource.

Redirect changes may take up to the 60-second [cache-age bound](caching-and-scale.md#freshness-and-mutation-races); do not promise immediate revocation from a `200`/`204`. Urgent abuse takedowns use the edge control described in security docs.

## Analytics

```http
GET /api/v1/links/sysdesign/analytics?from=2026-10-23&to=2026-10-24&interval=day
X-Management-Token: illustrative-token-not-a-real-credential
```

| Parameter | Default | Semantics |
| --- | --- | --- |
| `to` | Tomorrow's UTC date | Exclusive date `YYYY-MM-DD`; at most tomorrow UTC |
| `from` | `to` minus 30 days | Inclusive UTC date; must precede `to` |
| `interval` | `day` | Only `day` in v1 |

The interval is `[from at 00:00 UTC, to at 00:00 UTC)`. Accept 1–366 days; reject timestamp strings, reversed ranges, or dates outside the two-year rollup retention with `422`. This default includes today's partial bucket. Zero-fill every requested day and make totals equal the series sum.

Example for a one-day range:

```json
{
  "short_code": "sysdesign",
  "from": "2026-10-23",
  "to": "2026-10-24",
  "totals": { "clicks": 12, "human_clicks": 10, "bot_clicks": 2 },
  "series": [
    { "day": "2026-10-23", "clicks": 12, "human_clicks": 10, "bot_clicks": 2 }
  ],
  "breakdowns": {
    "from": "2026-10-23",
    "to": "2026-10-24",
    "truncated": false,
    "top_referers": [{ "value": "https://example.com", "clicks": 12 }],
    "top_countries": [{ "value": "US", "clicks": 12 }],
    "devices": [{ "value": "desktop", "clicks": 10 }, { "value": "bot", "clicks": 2 }]
  },
  "last_processed_at": "2026-10-23T12:01:30Z",
  "data_through": null
}
```

- V1 includes referrer-origin, country and device breakdowns. Top referrers/countries are limited to 10 entries each; `value: null` means unknown/unavailable, not proof of direct traffic. Devices list observed categories. All count bot and non-bot events; tie-break by value for stable output.
- Breakdown range is the intersection with the last 90 UTC days, including today; older range portions are marked `truncated: true`. If no overlap, `from`/`to` are null and arrays empty. Top-10 totals need not equal overall clicks.
- Totals/series always come from rollups, including today; never add the same raw counts again. Use a consistent read snapshot for totals and breakdowns.
- `last_processed_at` is the latest `ingested_at` among this link's retained raw events, or null. It is not proof the queue is drained; old links with only rollups may have null here.
- `data_through` is null in v1: best-effort capture cannot certify complete event-time coverage. Do not turn the last event timestamp into a completeness guarantee.
- Under normal operation aim for p95 captured-event freshness under two minutes. Missed schedules, pending recovery and backlog can exceed it; the UI must not promise a click appears in exactly one minute.
- Inactive/expired links remain available with valid auth; deleted/blocked links do not. `human_clicks` is a classifier estimate, not verified people; no unique-visitor metric.

## Redirects

GET resolves state, awaits a bounded enqueue attempt, and emits `302` with Location, `no-store`, `X-Robots-Tag: noindex, nofollow` and `Referrer-Policy: no-referrer`. HEAD emits identical status/headers but no body/event. Other methods return `405` and never record a click.

`302` avoids permanent browser redirect caching; it does not make click analytics exact. Crawlers, previews, transport failures and event loss still affect counts. HTML error pages must escape all content; API clients get Problem Details.

## Errors and rate limits

```json
{
  "type": "about:blank",
  "title": "Conflict",
  "status": 409,
  "detail": "That alias is already in use.",
  "instance": "/api/v1/links",
  "code": "alias_taken",
  "request_id": "8f14e45f-ea4d-4b1e-9c1a-5f0e2d7a6b31"
}
```

| Status | Codes |
| --- | --- |
| 400 | `invalid_url`, `reserved_alias` |
| 401 | `invalid_token` |
| 404 | `link_not_found` |
| 409 | `alias_taken`, `idempotency_conflict`, `request_in_progress` |
| 410 | `link_expired` |
| 413 | `payload_too_large` |
| 422 | `validation_error` (including missing/invalid idempotency key) |
| 429 | `rate_limited` |
| 500 | `internal_error` |
| 503 | `dependency_unavailable` |

Validation errors carry `errors: [{field, code, message}]`; never include Pydantic's raw input, a submitted token or destination in error telemetry. A 409 is not always an alias collision.

Initial per-IP limits: create 20/minute, redirect 600/minute, public metadata 120/minute, management/analytics combined 60/minute. Limit management attempts before token lookup, plus a bounded per-code attempt budget. Create also has an operator-set global daily budget. Limits and degraded policies are in [caching-and-scale.md](caching-and-scale.md).

`429` always carries integer `Retry-After` seconds. Optional `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` use documented delta-seconds for reset, not Unix timestamps. Cron uses constant-time bearer validation against **`CRON_SECRET`**, rejects missing configuration and unauthorized callers, and returns only processing counts.

## CORS and schema

Exact controlled origins; no credentialed cookies and no broad preview wildcard. Methods: GET, HEAD, POST, PATCH, DELETE, OPTIONS. Allow Content-Type, Idempotency-Key, X-Management-Token, X-Request-ID; expose Location, X-Request-ID, rate-limit headers and Retry-After. Preflight never triggers a click or consumes mutation limits.

`/openapi.json` is public and contains no secrets; `/docs` and `/redoc` are local/preview only. Generate the schema offline and frontend types in CI without a live database. These settings are planned; the scaffold currently exposes interactive docs in all environments.
