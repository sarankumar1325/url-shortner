# API Contract

Status: target design · Base path: `/api/v1` · Public redirects: `/{code}`

## Conventions

- JSON request and response bodies use UTF-8 and `snake_case`.
- Timestamps are UTC ISO 8601 with an explicit offset (`2026-10-23T12:00:00Z`).
- The API is versioned by path. Additive fields are non-breaking; removals or semantic changes require `/api/v2`.
- Every response carries `X-Request-ID`. Clients may send their own; invalid values are replaced.
- Errors use [RFC 9457 Problem Details](https://www.rfc-editor.org/rfc/rfc9457) with `application/problem+json`.
- Public create and redirect endpoints are rate-limited. Management endpoints additionally require a token.
- The OpenAPI schema is the source of truth for the generated frontend client.

## Authentication model

V1 has no user accounts.

- Anyone may create a link and follow a link.
- Creation returns a **management token** exactly once.
- Mutating or reading analytics requires `X-Management-Token: <token>`.
- The server stores only `HMAC-SHA256(pepper, token)`. It cannot recover a lost token.
- Tokens are 32 random bytes encoded as URL-safe base64 (256 bits of entropy).
- A token authorizes exactly one link. Future account auth will add a separate bearer/JWT scheme.

Public metadata is readable without a token because the destination is already discoverable by following the redirect. Analytics and mutation are private.

## Endpoint summary

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `POST` | `/api/v1/links` | none | Create a short link |
| `GET` | `/api/v1/links/{code}` | none | Read public link metadata |
| `PATCH` | `/api/v1/links/{code}` | management token | Update destination, expiry, or active state |
| `DELETE` | `/api/v1/links/{code}` | management token | Soft-delete a link |
| `GET` | `/api/v1/links/{code}/analytics` | management token | Read click totals and series |
| `GET` | `/{code}` | none | Redirect to the destination |
| `GET` | `/health` | none | Liveness probe |
| `GET` | `/ready` | none | Readiness probe (Postgres + Redis) |
| `GET` | `/internal/analytics/drain` | cron secret | Drain click events (scheduler only) |

## Create a link

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

| Field | Type | Required | Rules |
| --- | --- | --- | --- |
| `long_url` | string | yes | Absolute `http`/`https` URL, 1–8192 characters, no credentials, no control characters |
| `custom_alias` | string | no | 3–32 characters, lowercase `[a-z0-9_-]`, starts and ends alphanumeric, not reserved |
| `expires_at` | string \| null | no | Future timestamp, at most 5 years ahead; omitted or `null` means no expiry |

Response: `201 Created`

```http
Location: /api/v1/links/sysdesign
```

```json
{
  "id": 42,
  "short_code": "sysdesign",
  "short_url": "https://short.example/sysdesign",
  "long_url": "https://example.com/articles/system-design?ref=shortener",
  "is_custom_alias": true,
  "is_active": true,
  "expires_at": "2027-01-01T00:00:00Z",
  "created_at": "2026-10-23T12:00:00Z",
  "management_token": "Q2xvdWQtc2NhbGUtc2VjcmV0LXRva2Vu..."
}
```

`management_token` appears only in this response. The client must store it before navigating away. If the request includes `Idempotency-Key`, replaying the same key and body returns the original response, including the token, for 24 hours.

Errors: `400` invalid URL, `409` alias taken / idempotency conflict, `422` schema validation, `429` rate limited, `503` dependency unavailable.

## Read link metadata

```http
GET /api/v1/links/sysdesign
```

```json
{
  "short_code": "sysdesign",
  "short_url": "https://short.example/sysdesign",
  "long_url": "https://example.com/articles/system-design?ref=shortener",
  "is_custom_alias": true,
  "is_active": true,
  "expires_at": "2027-01-01T00:00:00Z",
  "created_at": "2026-10-23T12:00:00Z"
}
```

The management token is never returned. Expired links return `410 Gone`; deleted or inactive links return `404 Not Found` to avoid confirming their existence.

## Update a link

```http
PATCH /api/v1/links/sysdesign
Content-Type: application/json
X-Management-Token: Q2xvdWQtc2NhbGUtc2VjcmV0LXRva2Vu...
```

```json
{
  "long_url": "https://example.com/articles/system-design-v2",
  "expires_at": null,
  "is_active": true
}
```

- All fields are optional; at least one must be present.
- `expires_at: null` clears the expiry; omitting the field leaves it unchanged.
- Changing the destination invalidates the redirect cache.
- The short code and management token cannot be changed.
- Response: `200 OK` with the same shape as the public metadata response.
- Errors: `401` missing/invalid token, `404`, `409` invalid state, `422`.

## Delete a link

```http
DELETE /api/v1/links/sysdesign
X-Management-Token: Q2xvdWQtc2NhbGUtc2VjcmV0LXRva2Vu...
```

- Response: `204 No Content`.
- Soft-deletes the row, preserves analytics, and invalidates the cache.
- The alias remains reserved; it is not reused by new links.
- Following the link afterwards returns `404`.
- Repeated deletes return `404`.

## Read analytics

```http
GET /api/v1/links/sysdesign/analytics?from=2026-10-01&to=2026-10-23&interval=day
X-Management-Token: Q2xvdWQtc2NhbGUtc2VjcmV0LXRva2Vu...
```

| Parameter | Default | Rules |
| --- | --- | --- |
| `from` | 30 days before `to` | Date or timestamp; inclusive |
| `to` | now | Date or timestamp; inclusive |
| `interval` | `day` | `day` only in v1 |

```json
{
  "short_code": "sysdesign",
  "from": "2026-10-01T00:00:00Z",
  "to": "2026-10-23T00:00:00Z",
  "totals": {
    "clicks": 1234,
    "human_clicks": 1200,
    "bot_clicks": 34
  },
  "series": [
    { "day": "2026-10-01", "clicks": 42, "human_clicks": 40, "bot_clicks": 2 }
  ]
}
```

- Raw event breakdowns (referrer, country, device) are available for the last 90 days in a later additive revision of this endpoint.
- A range longer than 366 days returns `422`.
- Data is eventually consistent: a click may take up to one drain interval to appear.
- Expired or inactive links remain readable with the token.

## Redirect

```http
GET /sysdesign
```

```http
HTTP/1.1 302 Found
Location: https://example.com/articles/system-design?ref=shortener
Cache-Control: no-store
X-Robots-Tag: noindex, nofollow
```

- `302` is intentional: `301` may be cached indefinitely by browsers, which breaks analytics and link updates.
- `Cache-Control: no-store` keeps click capture accurate. Scale comes from Redis, not browser caches.
- `404` for unknown, deleted, or inactive codes; `410` for expired codes.
- Browser requests (`Accept: text/html`) receive a minimal HTML error page; API clients receive Problem Details.
- Every redirect attempts to append a click event. Failure to enqueue never changes the redirect response.

## Manage reserved aliases

The following aliases are unavailable at every case:

```text
api, health, ready, docs, redoc, openapi.json, admin, login, logout, signup,
static, assets, favicon.ico, robots.txt, sitemap.xml, well-known, internal,
metrics, _next, graphql
```

The list is code-owned and versioned with the API. Custom alias validation rejects reserved values with `400` and code `reserved_alias`.

## Rate limits

Limits are per hashed client IP and per scope. Values are configurable; these are production defaults.

| Scope | Limit | Window | On exceed |
| --- | --- | --- | --- |
| Create link | 20 | 60 s | `429`, `Retry-After` |
| Redirect | 600 | 60 s | `429`, `Retry-After` |
| Public metadata | 120 | 60 s | `429` |
| Analytics | 60 | 60 s | `429` |
| Internal drain | cron secret only | n/a | `401` |

Successful responses may include:

```http
RateLimit-Limit: 20
RateLimit-Remaining: 17
RateLimit-Reset: 1761220800
```

`429` responses always include `Retry-After` in seconds. The server fails open for redirects if Redis is unavailable, and logs a metric so the degradation is visible.

## Errors

```http
HTTP/1.1 409 Conflict
Content-Type: application/problem+json
```

```json
{
  "type": "https://api.short.example/problems/alias-taken",
  "title": "Alias already taken",
  "status": 409,
  "detail": "The alias 'sysdesign' is already in use.",
  "instance": "/api/v1/links",
  "code": "alias_taken",
  "request_id": "01JQ9Z3K4M8YV2R6T0W7X1N5B8"
}
```

| Status | Code | Meaning |
| --- | --- | --- |
| `400` | `invalid_url` | Unsupported scheme, credentials, private target, or malformed URL |
| `400` | `reserved_alias` | Alias is reserved by the service |
| `401` | `invalid_token` | Missing or incorrect management token |
| `404` | `link_not_found` | Unknown, deleted, or inactive link |
| `409` | `alias_taken` | Custom alias already exists |
| `409` | `idempotency_conflict` | Same idempotency key with a different request body |
| `410` | `link_expired` | Link existed but has expired |
| `422` | `validation_error` | Schema or query validation failed |
| `429` | `rate_limited` | Rate limit exceeded |
| `500` | `internal_error` | Unexpected server error; includes `request_id` |
| `503` | `dependency_unavailable` | Postgres or Redis required for this operation is unavailable |

Validation errors include a `errors` extension array with `field`, `code`, and `message` per issue. Internal errors never include stack traces or SQL.

## Idempotency

- `Idempotency-Key` is optional on `POST /api/v1/links`.
- Accepted format: 8–128 printable ASCII characters; UUIDs are recommended.
- The server stores a fingerprint of the request body and the full response for 24 hours.
- Same key + same body → replay the stored response.
- Same key + different body → `409 idempotency_conflict`.
- If Redis is unavailable and the header is present, creation fails with `503` rather than risking a duplicate.

## CORS

- Allowed origins are explicit; wildcards are not used.
- Production: `https://app.short.example`.
- Local: `http://localhost:5173`.
- Methods: `GET`, `POST`, `PATCH`, `DELETE`, `OPTIONS`.
- Allowed request headers: `Content-Type`, `Idempotency-Key`, `X-Management-Token`, `X-Request-ID`.
- Exposed response headers: `X-Request-ID`, `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`, `Retry-After`.
- Credentials are disabled in v1 because no cookies are used.

## OpenAPI and documentation

- Schema: `GET /openapi.json`.
- Interactive docs (`/docs`, `/redoc`) are enabled locally and disabled when `ENVIRONMENT=production`.
- The frontend generates types from the schema; see [frontend/data-fetching.md](../frontend/data-fetching.md).
- CI snapshots the schema so accidental breaking changes are reviewed.

## Examples

```bash
curl -sS -X POST http://127.0.0.1:8000/api/v1/links \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: 3d2f6a10-8c44-4f5e-9b0a-6a1d7e2c4b90' \
  -d '{"long_url":"https://example.com","custom_alias":"demo"}'
```

```bash
curl -sSI http://127.0.0.1:8000/demo
```

```bash
curl -sS http://127.0.0.1:8000/api/v1/links/demo/analytics \
  -H "X-Management-Token: $TOKEN"
```
