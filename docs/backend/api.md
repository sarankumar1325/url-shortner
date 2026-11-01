# API Contract

Status: implemented and verified in production 2026-10-25 · [Architecture](architecture.md) · [Data model](data-model.md) · [Frontend integration](../frontend/data-fetching.md)

## Common rules

- REST base: `/api/v1`; redirects: `/{code}` on the backend deployment, not the SPA.
- UTF-8 JSON, `snake_case`, UTC ISO 8601 timestamps. Reject unknown mutation fields.
- All API, redirect and error responses use `Cache-Control: no-store`. Cookies and custom auth headers do not prevent HTTP caching by themselves. No shared CDN caching of private responses.
- Return `X-Request-ID`; accept a bounded validated UUID from callers or generate one. Never reflect arbitrary header text in logs.
- Every response carries `Server-Timing: db;dur=…;desc="Postgres xN", redis;dur=…;desc="Redis xN", total;dur=…` with the time and call count spent in each dependency for that request. See [observability](observability.md#server-timing).
- Failures use [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) `application/problem+json`; OpenAPI describes response models, auth, errors and headers.
- Enforce a 64 KiB JSON body size while reading (not just trusting Content-Length); the serialized destination limit is 8192 characters. Return `413` for an oversized body.

## Authentication and state

V1 now has first-party accounts, workspaces and role-based access, plus a legacy per-link token path for unowned links.

### Browser sessions

- `POST /auth/signup` and `POST /auth/login` set an opaque `shortly_session` cookie: `HttpOnly`, `SameSite=Lax`, `Path=/`, and `Secure` when `ENVIRONMENT` is `production` or `preview`.
- Both accept `remember` (boolean, default `true`, the UI's "Stay signed in"). A persistent session gets a 30-day `Max-Age` cookie; once it is past half its life, any authenticated request extends the row to a fresh 30 days and re-sends the cookie with a new `Max-Age`. With `remember: false` the cookie has no `Max-Age` (it ends when the browser closes) and the server row expires after 24 hours (`SHORT_SESSION_TTL_SECONDS`) without renewal. The flag is stored as `user_sessions.persistent`.
- Raw session tokens are `shrs_` strings shown only in the cookie. The database stores a SHA-256 digest in `user_sessions`.
- The SPA sends `credentials: 'include'` and never reads or stores the cookie value.
- `POST /auth/logout` deletes the server-side row and clears the cookie. Expired sessions are rejected and removed on lookup.
- Every session also has a non-secret public UUID (`user_sessions.id`). Session listing returns `{id, created_at, expires_at, current}` and never exposes the token digest.
- `POST /auth/password` verifies the current password, rejects a reused password, rotates the Argon2id hash, deletes every other session, and keeps the caller signed in. It is same-origin checked and limited to 10 attempts/hour/user; a wrong current password is `403 invalid_password`.
- Cookie-authenticated writes (`POST`, `PATCH`, `DELETE`) require an `Origin` or `Referer` allowed by `CORS_ORIGINS`; otherwise `403 csrf_rejected`. Non-browser callers without either header are allowed because they cannot be tricked into sending a victim's cookie.
- Signup and login share an intentionally indistinguishable `401 invalid_credentials` for unknown email or wrong password. Unknown emails still run a dummy Argon2 verification. A successful login rehashes a password stored with older Argon2 parameters.

Passwords are 10–128 characters and stored only as Argon2id hashes. Emails are trimmed and lowercased. There is no email verification, password reset, SSO or MFA in v1. Users can change a known password, revoke individual sessions or all other sessions, and delete their own account.

### Workspaces and roles

- Signup creates a personal workspace owned by the new user. Shared workspaces are created through `POST /workspaces`.
- `X-Workspace-Id` selects the workspace for link and people operations. Omitting it selects the caller's personal workspace for authenticated requests.
- Non-members receive `404 workspace_not_found` rather than `403` to avoid disclosing workspace existence.
- Role order is `viewer < member < admin < owner`:

| Action | Minimum role |
| --- | --- |
| Read metadata and analytics; list links and members | viewer |
| Create, update or delete links | member |
| Invite people, revoke invitations, change roles, remove members, rename the workspace | admin |
| Delete the workspace, transfer ownership, manage admins | owner |

The owner cannot be removed or demoted, users cannot change their own role, and admins cannot manage other admins or the owner. Server checks are authoritative; the UI only reflects them.

Deleting a workspace requires the owner, a non-personal workspace, and an exact trimmed name confirmation (`confirm_name`); it hard-deletes links, analytics, invitations and memberships. Personal workspaces cannot be deleted or transferred, and the last owner cannot be removed. Ownership transfer requires an existing non-owner member and demotes the acting owner to `admin`. Both lifecycle mutations lock the relevant memberships with `SELECT … FOR UPDATE`.

Invitations are `shri_` tokens stored as SHA-256 digests, expire after seven days, may optionally record an email, and are consumed on acceptance. The recorded `invited_email` is informational and is not enforced against the accepting account in v1; possession of the token authorizes joining. Preview is public; acceptance requires a signed-in account. Accepting while already a member is idempotent.

### Legacy management tokens

Unowned links created before accounts keep the capability model from [ADR 0005](../adr/0005-anonymous-management-tokens.md). Creation returns a 256-bit `management_token` transported as `X-Management-Token`; the link stores only its HMAC digest plus key version.

| Operation | Workspace link | Legacy unowned link |
| --- | --- | --- |
| Create | Session + optional `X-Workspace-Id`; response has no token | Anonymous or sessionless; response has `management_token` |
| GET metadata | Session + membership; inactive/expired allowed for members | Public active/unexpired only unless a valid token is supplied |
| PATCH / DELETE | Session + `member` | Valid token required |
| Analytics | Session + any role | Valid token required |
| List | Session + membership | Not available |

If `X-Management-Token` is supplied it takes precedence and is never combined with workspace access. An invalid supplied token is `401 invalid_token`, never a silent public fallback. Missing required auth is `401 authentication_required`. Authorization never uses a redirect cache.

For public unauthenticated resolution: missing/deleted/blocked/inactive → `404`; otherwise expired → `410`; otherwise successful. Short codes and public metadata are not secrets.

## Endpoints

### Accounts and workspaces

| Method | Path | Result |
| --- | --- | --- |
| POST | `/api/v1/auth/signup` | `201` session payload, Set-Cookie, personal workspace created |
| POST | `/api/v1/auth/login` | `200` session payload, Set-Cookie |
| POST | `/api/v1/auth/logout` | `204`; deletes the session and clears the cookie |
| GET | `/api/v1/auth/me` | `200` current user and workspace memberships |
| POST | `/api/v1/auth/password` | `204`; rotates password and revokes other sessions |
| GET | `/api/v1/auth/sessions` | `200` active sessions with a public id and `current` flag |
| DELETE | `/api/v1/auth/sessions/{session_id}` | `204`; revoke one session owned by the caller |
| POST | `/api/v1/auth/sessions/revoke-others` | `200` `{"revoked": n}`; keeps the current session |
| DELETE | `/api/v1/auth/account` | `204` with `{password, confirm_email}`; deletes the account and the workspaces only it uses, clears the cookie |
| POST | `/api/v1/workspaces` | `201` shared workspace; caller becomes owner |
| PATCH | `/api/v1/workspaces/{workspace_id}` | `200` renamed workspace summary (`admin+`) |
| DELETE | `/api/v1/workspaces/{workspace_id}` | `204` hard delete with `{confirm_name}` (`owner`, non-personal) |
| POST | `/api/v1/workspaces/{workspace_id}/transfer-ownership` | `204` with `{user_id}` (`owner`, non-personal) |
| GET | `/api/v1/workspaces/{workspace_id}/members` | `200` member list |
| PATCH | `/api/v1/workspaces/{workspace_id}/members/{member_id}` | `200` role change |
| DELETE | `/api/v1/workspaces/{workspace_id}/members/{member_id}` | `204` remove member or leave |
| GET | `/api/v1/workspaces/{workspace_id}/invitations` | `200` pending invitations (`admin+`) |
| POST | `/api/v1/workspaces/{workspace_id}/invitations` | `201` invitation, including token (`admin+`) |
| DELETE | `/api/v1/workspaces/{workspace_id}/invitations/{invitation_id}` | `204` revoke (`admin+`) |
| GET | `/api/v1/invitations/{token}` | `200` public preview |
| POST | `/api/v1/invitations/{token}/accept` | `200` joined workspace summary |

### Links, redirects and operations

| Method | Path | Result |
| --- | --- | --- |
| POST | `/api/v1/links` | `201` creation; token only for legacy unowned links |
| GET | `/api/v1/links` | `200` workspace links with `clicks_30d` |
| GET | `/api/v1/links/availability?alias=` | `200` whether a custom alias is free, with `reason` `invalid`/`reserved`/`taken` (`taken` includes soft-deleted and retired codes); public, rate limited per IP |
| GET | `/api/v1/links/top?days=&limit=` | `200` most-clicked workspace links over 1, 7 or 30 days; cached 60 seconds |
| POST | `/api/v1/links/bulk` | `200` per-code results for pause, resume, delete, add or remove tags on up to 200 workspace links ([bulk actions](#bulk-actions)) |
| GET | `/api/v1/links/{code}` | `200` metadata; workspace, token or public access (public access to a password-protected link is `401 password_required`) |
| PATCH | `/api/v1/links/{code}` | `200` updated metadata |
| DELETE | `/api/v1/links/{code}` | `204`; repeatable with a valid legacy token |
| GET | `/api/v1/links/{code}/analytics` | `200` private totals/series/breakdowns |
| GET / HEAD | `/{code}` | `302`, `401`, `404` or `410`; HEAD never counts a click; browsers (`Accept: text/html`) get an HTML page for `404`/`410` and a password page for protected links |
| POST | `/{code}` | Unlock a password-protected link (`password` as form or JSON field); `303` back to `/{code}` with an unlock cookie ([password-protected links](#password-protected-links)) |
| GET | `/{code}+` | `200` HTML destination preview (Peek), or an HTML `404`/`410` page; never counts a click |
| GET | `/api/v1/dashboard?days=7\|30\|90` | `200` workspace totals with period-over-period change, daily series, breakdowns, status counts and per-link health (up to 500 links); any workspace role |
| GET | `/api/v1/system/status` | `200` per-instance probes, circuit breaker, cache and rate-limit counters, plus a `config` block of the running tunables; signed-in users only |
| POST | `/api/v1/system/trace` | `200` one redirect traced step by step with server timings (`{"code", "cold"}`); never counts a click or consumes a visit; workspace links only (`404` otherwise), same-origin, rate limited per user |
| GET | `/health` | Dependency-free liveness |
| GET | `/ready` | Dependency readiness; `503` if required service unavailable |
| GET | `/api/v1/health`, `/api/v1/ready` | Same probes under the API prefix, so the web app can warm the function and database through its same-origin `/api` rewrite |
| GET | `/internal/analytics/drain` | Cron-authenticated ingestion; no public data |
| GET | `/internal/analytics/status` | Cron-authenticated queue backlog, pending age, lag and dead-letter counts |
| GET | `/internal/maintenance` | Cron-authenticated bounded retention cleanup |

## Account examples

```http
POST /api/v1/auth/signup
Content-Type: application/json
Origin: https://shortlyyy-web.vercel.app
```

```json
{
  "email": "person@example.com",
  "password": "a-long-enough-password",
  "display_name": "Saran",
  "remember": true
}
```

`201` plus `Set-Cookie: shortly_session=shrs_…; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000` (no `Max-Age` when `remember` is `false`):

```json
{
  "user": {
    "id": "8b2f2f1e-10d0-4b0f-a42e-5f7a0e2c1d33",
    "email": "person@example.com",
    "display_name": "Saran",
    "created_at": "2026-10-24T12:00:00Z"
  },
  "workspaces": [
    {
      "id": "b9f3b7a2-0f1d-4c6a-9b0e-8b4a1c2d3e4f",
      "name": "Saran's workspace",
      "role": "owner",
      "is_personal": true
    }
  ]
}
```

`GET /auth/me` returns the same shape. Workspace list rows carry `id`, `name`, `role`, `is_personal`; there is no raw session token in any JSON body.

### Invitations

```http
POST /api/v1/workspaces/{workspace_id}/invitations
X-Workspace-Id: {workspace_id}
Content-Type: application/json
```

```json
{ "role": "viewer", "email": null }
```

`201` includes `id`, `role`, `invited_email`, `created_at`, `expires_at`, and the one-time `token` (`shri_…`). The inviter copies `https://<web-host>/invite/<token>`; the token is not available from the list endpoint again. Preview returns workspace name, role, inviter display name and expiry. Acceptance returns the joined workspace summary.

### Password and sessions

```http
POST /api/v1/auth/password
Content-Type: application/json
```

```json
{ "current_password": "old-password", "new_password": "new-password" }
```

`204` on success. A wrong current password is `403 invalid_password`; reusing the current password is `422 validation_error`. Other sessions are deleted in the same commit, while the caller's session stays valid.

```http
GET /api/v1/auth/sessions
```

```json
[
  {
    "id": "b88d66e6-a35e-4f1d-ac8c-53ffdd1e55ee",
    "created_at": "2026-10-25T10:32:16.460354Z",
    "expires_at": "2026-11-24T10:32:16.669916Z",
    "current": true
  }
]
```

`DELETE /auth/sessions/{session_id}` revokes one session and returns `204`; the public ID is scoped to the caller, so another user's ID is `404 session_not_found`. `POST /auth/sessions/revoke-others` deletes every other session and returns `{"revoked": n}`. No response ever contains a token or token digest.

### Account deletion

```http
DELETE /api/v1/auth/account
Content-Type: application/json

{ "password": "current-password", "confirm_email": "person@example.com" }
```

`204` and a cleared cookie on success. A wrong password is `403 invalid_password`; `confirm_email` must match the account email after trimming and lowercasing (`422 confirmation_mismatch`). If the caller owns a shared workspace that still has other members, the request is `409 owns_shared_workspaces` and nothing changes; its `errors[]` lists each blocking workspace with `workspace_id` and `name`, so the user can transfer or delete them first.

Otherwise one transaction deletes the personal workspace, every shared workspace where the caller is the only member, and the user row. Sessions and memberships cascade with the user. Links the user created in other people's workspaces stay there with `created_by_user_id` cleared. Codes from the deleted workspaces are recorded in `retired_short_codes` so they are never reissued, and their redirect cache entries are invalidated. Same-origin checked and limited to 10 attempts/hour/user.

### Workspace lifecycle

```http
PATCH /api/v1/workspaces/{workspace_id}
Content-Type: application/json
```

```json
{ "name": "Acme Team" }
```

`200` with `{id, name, role, is_personal}`. Names are 1–80 characters after trimming; `admin+` required.

```http
DELETE /api/v1/workspaces/{workspace_id}
Content-Type: application/json

{ "confirm_name": "Acme Team" }
```

`204` hard delete. `confirm_name` must equal the trimmed workspace name (`422 confirmation_mismatch`). Owner only, non-personal only (`403 personal_workspace`). Links, clicks, invitations and memberships cascade. The workspace's codes, including soft-deleted ones, are copied into `retired_short_codes` first so they can never be reissued, and their redirect cache entries are invalidated.

```http
POST /api/v1/workspaces/{workspace_id}/transfer-ownership
Content-Type: application/json

{ "user_id": "6fbe11e6-5f4b-4707-b169-c49276cc1aa6" }
```

`204`. The target must be a current non-owner member (`404 member_not_found`, `409 owner_conflict`); the actor becomes `admin`. Personal workspaces cannot be transferred.

## Create

Workspace creation:

```http
POST /api/v1/links
Content-Type: application/json
X-Workspace-Id: b9f3b7a2-0f1d-4c6a-9b0e-8b4a1c2d3e4f
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
- `custom_alias`: optional/null; lowercase `^[a-z0-9][a-z0-9_-]{1,30}[a-z0-9]$`, 3–32 characters, not reserved. Missing/null means generated code. An alias in use, soft-deleted or retired by a workspace/account deletion is `409 alias_taken`; generated codes skip retired values.
- `expires_at`: optional/null means no expiry; otherwise strictly future, at most five years ahead.
- `fallback_url`: optional/null; validated like `long_url`, errors use field `fallback_url`. Visitors are sent here once the link expires or runs out of visits.
- `max_clicks`: optional/null; integer 1–1,000,000. Each counted redirect uses one visit; once used up, redirects go to `fallback_url` or return `410 link_exhausted`.
- `password`: optional/null; 4–128 characters, compared exactly. Stored only as an Argon2id hash in `urls.password_hash`; responses expose only `has_password`. See [password-protected links](#password-protected-links).
- `redirect_rules`: optional/null; up to 10 rules sending some visitors to another destination. See [smart redirects](#smart-redirects).
- `Idempotency-Key`: required random UUIDv4; generate with `crypto.randomUUID()` or `uuid.uuid4()`.

Return `201` with `Location: /api/v1/links/sysdesign` and:

```json
{
  "short_code": "sysdesign",
  "short_url": "https://shortlygo.vercel.app/sysdesign",
  "long_url": "https://example.com/articles/system-design?ref=shortener",
  "is_custom_alias": true,
  "is_active": true,
  "expires_at": "2027-01-01T00:00:00Z",
  "created_at": "2026-10-23T12:00:00Z",
  "updated_at": "2026-10-23T12:00:00Z",
  "tags": [],
  "fallback_url": null,
  "max_clicks": null,
  "clicks_used": 0,
  "has_password": false,
  "redirect_rules": []
}
```

`has_password` is `true` when the link has a password; the password and its hash are never returned. `redirect_rules` is the stored rule list, `[]` when there are none.

A legacy unowned creation adds `"management_token": "…"` and stores only its HMAC digest. Workspace metadata responses never contain a token. GET/PATCH metadata otherwise have the same fields. Internal bigint IDs are not exposed. Build `short_url` from trusted configuration, not the incoming Host header.

### Idempotent creation

1. Validate key format and canonical input; hash both. Treat omitted and null optional create fields equivalently. A `password` enters the fingerprint only as a server-keyed HMAC, never in plain text. Do not re-evaluate a previously successful request's time-relative expiry check on replay.
2. Serialize requests on the key hash in Postgres. Reserve it, create the link, and encrypt/store the complete successful response in the same transaction.
3. Concurrent same key/body → one link and the same response; different body → `409 idempotency_conflict`. On a bounded key-lock wait → `409 request_in_progress` with `Retry-After`.
4. Same key/body within 24 hours → replay the original `201` body and Location, with a fresh request ID. It describes creation, not current mutable state; replay cannot reactivate a deleted link or undo a block.
5. Enforce 24-hour expiry during reads and cleanup; after expiry the key is not guaranteed to deduplicate. Do not indefinitely retry an ambiguous request.

For legacy links the replay includes the management token, so the replay key is also a capability; store only its digest and encrypt the response with AEAD. Workspace replays contain no such secret. Malformed input does not consume a key. Transaction failure rolls back both link and replay reservation.

## List

```http
GET /api/v1/links?limit=50
X-Workspace-Id: b9f3b7a2-0f1d-4c6a-9b0e-8b4a1c2d3e4f
```

Returns `{ "links": [...], "total": n, "workspace_id": "...", "role": "owner" }`. `limit` is 1–200, default 50. Each row includes metadata plus `clicks_30d`. Listing is workspace-only; the legacy token model cannot list.

## Update and delete

PATCH accepts only `long_url`, `expires_at`, `is_active`, `tags`, `fallback_url`, `max_clicks`, `password` and `redirect_rules`, and requires at least one field. Null expiry, fallback, visit limit or password clears it; omission preserves it. A new `password` replaces the hash, which invalidates existing unlock cookies. `redirect_rules` replaces the whole list; null or `[]` removes every rule. Clearing `max_clicks` resets `clicks_used`; raising it allows more visits. Null URL/active values are invalid. Code and operator block state cannot be changed. Workspace callers need `member`; legacy callers need a valid token. Revalidate URL/expiry, commit, then invalidate the positive cache best-effort.

### Bulk actions

```http
POST /api/v1/links/bulk
X-Workspace-Id: b9f3b7a2-0f1d-4c6a-9b0e-8b4a1c2d3e4f
Content-Type: application/json
```

```json
{ "codes": ["sysdesign", "a1B2c"], "action": "add_tags", "tags": ["launch"] }
```

- `codes`: 1–200 short codes in the selected workspace; duplicates are collapsed.
- `action`: `pause`, `resume`, `delete` (soft delete), `add_tags` or `remove_tags`.
- `tags`: required (at least one) for the tag actions and rejected for the others (`422 validation_error` on field `tags`).

The whole request runs in one transaction. The response is `{action, results: [{short_code, status}], updated, workspace_id}`, where each `status` is `ok`, `not_found` (missing, deleted, blocked or in another workspace) or, for `add_tags`, `too_many_tags` when the link would exceed the per-link tag limit. Requires `member`, a same-origin request and is limited to 30 requests per minute per workspace (fails closed). Pause, resume and delete evict the changed codes from the redirect cache.

For v1, concurrent valid PATCH operations use last-committed-write-wins for supplied fields. Do not auto-retry PATCH after ambiguous failure: read authenticated metadata and ask the user to confirm.

DELETE soft-deletes atomically and invalidates the cache. Workspace callers need `member`; legacy repeat DELETE with the correct token returns `204`; unknown or operator-blocked codes return `404`. The token cannot read analytics or mutate a deleted link. Account/workspace deletion is a separate hard-delete path; replay rows cascade with links, and the codes move to `retired_short_codes` so they stay unavailable.

Redirect changes may take up to the 60-second [cache-age bound](caching-and-scale.md#freshness-and-mutation-races); do not promise immediate revocation from a `200`/`204`. Urgent abuse takedowns use the edge control described in security docs.

## Analytics

```http
GET /api/v1/links/sysdesign/analytics?from=2026-10-23&to=2026-10-24&interval=day
X-Workspace-Id: b9f3b7a2-0f1d-4c6a-9b0e-8b4a1c2d3e4f
```

| Parameter | Default | Semantics |
| --- | --- | --- |
| `to` | Tomorrow's UTC date | Exclusive date `YYYY-MM-DD`; at most tomorrow UTC |
| `from` | `to` minus 30 days | Inclusive UTC date; must precede `to` |
| `interval` | `day` | Only `day` in v1 |

Any workspace role may read analytics; legacy links require the management token. The interval is `[from at 00:00 UTC, to at 00:00 UTC)`. Accept 1–366 days (the web app offers 7, 30, 90 and 365 day presets plus a custom UTC range, and compares against the previous period of the same length with a second request); reject timestamp strings, reversed ranges, or dates outside the two-year rollup retention with `422`. This default includes today's partial bucket. Zero-fill every requested day and make totals equal the series sum.

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
  "data_through": null,
  "freshness": {
    "redis_ok": true,
    "pending_events": 0,
    "lag_events": 0,
    "oldest_pending_seconds": null,
    "dead_letter_events": 0,
    "captured_at": "2026-10-23T12:02:00Z"
  }
}
```

- V1 includes referrer-origin, country and device breakdowns. Top referrers/countries are limited to 10 entries each; `value: null` means unknown/unavailable, not proof of direct traffic. Devices list observed categories. All count bot and non-bot events; tie-break by value for stable output.
- Breakdown range is the intersection with the last 90 UTC days, including today; older range portions are marked `truncated: true`. If no overlap, `from`/`to` are null and arrays empty. Top-10 totals need not equal overall clicks.
- Totals/series always come from rollups, including today; never add the same raw counts again. Use a consistent read snapshot for totals and breakdowns.
- `last_processed_at` is the latest `ingested_at` among this link's retained raw events, or null. It is not proof the queue is drained.
- `freshness` is a snapshot of the shared stream pipeline: queue lag, group pending count, oldest pending age, dead-letter depth, Redis availability and capture time. `redis_ok: false` means metrics were unavailable; it does not fail the analytics read. Use this for freshness messaging rather than inferring pipeline health from a link's zeros.
- `data_through` is null in v1: enqueue remains best-effort, so complete event-time coverage cannot be certified.
- `GET /internal/analytics/status` returns the same snapshot plus stream/legacy depths for operators.
- Under normal operation aim for p95 captured-event freshness under two minutes. Missed schedules, pending recovery and backlog can exceed it.
- Inactive/expired links remain available to authorized callers; deleted/blocked links do not. `human_clicks` is a classifier estimate, not verified people; no unique-visitor metric.

## Internal operations

Both routes require `Authorization: Bearer <CRON_SECRET>` and return `503 dependency_unavailable` when no secret is configured.

`GET /internal/analytics/drain` drains a bounded batch:

```json
{
  "redis_ok": true,
  "drained": 12,
  "reclaimed": 1,
  "inserted": 12,
  "dead_lettered": 0,
  "failed": 0,
  "migrated": 0
}
```

- `drained` counts new stream messages read; `reclaimed` counts stale pending messages recovered. Both may contribute to `inserted`.
- `failed` counts valid events whose database transaction failed; they stay pending for retry.
- `redis_ok: false` means the batch could not run; the response is still `200` so a scheduler can log and retry.

`GET /internal/analytics/status` returns `{redis_ok, consumer, stream_depth, pending, lag, oldest_pending_age_seconds, dead_letter_depth, legacy_pending, legacy_in_flight, generated_at}`. See [analytics](analytics.md).

## Redirects

GET resolves state, awaits a bounded enqueue attempt, and emits `302` with Location, `no-store`, `X-Robots-Tag: noindex, nofollow` and `Referrer-Policy: no-referrer`. HEAD emits identical status/headers but no body/event. Other methods return `405` and never record a click. Expired links with a `fallback_url` redirect there (and count the click) instead of returning `410`. For links with `max_clicks`, a counted GET uses one visit atomically in Postgres; HEAD, Peek and link unfurlers (bot user agents plus WhatsApp-style previewers) only check that a visit remains. The positive cache still applies, so adding a cap may take up to the cache TTL to take effect. Redirects never require a session and never expose workspace membership.

When a `404` or `410` request accepts `text/html`, the response is an escaped, self-contained HTML page with the same status, `no-store`, `noindex`, `nosniff` and a `default-src 'none'` CSP; other clients keep Problem Details. Unavailable pages do not distinguish missing, deleted, blocked and paused links.

`GET /{code}+` (Peek) resolves the link through the same cache and rate limit as redirects, records no click, and renders the destination host, full URL, expiry and offline address signals (plain HTTP, raw IP, punycode host, known third-party shortener, non-default port). It never fetches the destination. Its Continue button points at `/{code}`, so the visit is counted and current link state applies. Pages link to the web app's abuse form using `WEB_BASE_URL`, or the first `CORS_ORIGINS` entry when it is unset.

### Password-protected links

A link with a password redirects only after the visitor unlocks it:

- `GET /{code}` without a valid unlock cookie returns the HTML password page (`401`) when the request accepts `text/html`, otherwise `401 password_required`. `HEAD` returns `401` with no body. Link unfurlers get the same `401`, so chat previews never see the destination.
- `POST /{code}` takes `password` as a form field or JSON body (at most 4 KiB). It is limited to 10 attempts per 5 minutes per client IP and code, and 100 per hour per code; the limiter fails closed. A correct password returns `303` to `/{code}` and sets `shortly_unlock`: `HttpOnly`, `SameSite=Lax`, `Path=/{code}`, `Max-Age` 12 hours, `Secure` in production/preview. A wrong password returns the password page with an error, or `401 invalid_password`. Missing links are `404`; expired or unprotected links `303` straight back to `/{code}`.
- The cookie holds an expiry and an HMAC bound to the code and a tag derived from the password hash, so changing or removing the password invalidates earlier unlocks.
- While locked, the visit limit is checked but no visit is used and no click is recorded. Expired or used-up links with a `fallback_url` go to the fallback without a password, because the fallback is not the protected destination.
- Peek (`/{code}+`) never shows a protected destination, even after unlocking; it shows a locked page with a link to enter the password.
- `GET /api/v1/links/{code}` without workspace or token access returns `401 password_required` for protected links.

### Smart redirects

`redirect_rules` is an ordered list of up to 10 rules:

```json
[
  { "devices": ["ios"], "url": "https://apps.apple.com/app/example" },
  { "devices": ["android"], "countries": ["DE", "AT"], "url": "https://play.google.com/store/apps/details?id=example" }
]
```

- `devices`: any of `ios`, `android`, `mobile`, `tablet`, `desktop`; stored in that order.
- `countries`: ISO 3166 alpha-2 codes, uppercased, de-duplicated and sorted; at most 50.
- `url`: validated like `long_url`.
- Each rule needs at least one of `devices` or `countries`. Errors use fields such as `redirect_rules`, `redirect_rules.2.devices`, `redirect_rules.2.countries` or `redirect_rules.2.url`.

On `GET` and `HEAD /{code}`, rules are checked in order and the first match wins; otherwise the visitor goes to `long_url`. Within a rule every condition that is set must match, and any listed value satisfies a condition. Device traits come from the user agent (`mobile`, `tablet` or `desktop`, plus `ios` for iPhone/iPad/iPod and `android`); bots and unrecognized clients have no device traits, so device rules never match them. Country comes from `x-vercel-ip-country`. Link previewers always get `long_url`, and expired or used-up links go to `fallback_url` instead of evaluating rules. Peek shows the destination for the requesting visitor and notes that the link varies by device or country.

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
| 400 | `invalid_url`, `reserved_alias`, `invalid_workspace` |
| 401 | `authentication_required`, `invalid_credentials`, `invalid_token`, `password_required`, `invalid_password` (link unlock) |
| 403 | `forbidden`, `csrf_rejected`, `invalid_password`, `personal_workspace` |
| 404 | `link_not_found`, `workspace_not_found`, `member_not_found`, `invitation_not_found`, `session_not_found` |
| 409 | `email_taken`, `alias_taken`, `idempotency_conflict`, `request_in_progress`, `owner_conflict`, `owns_shared_workspaces` |
| 410 | `link_expired`, `link_exhausted` |
| 413 | `payload_too_large` |
| 422 | `validation_error` (including invalid idempotency key, self role change, invalid role), `confirmation_mismatch` |
| 429 | `rate_limited` |
| 500 | `internal_error` |
| 503 | `dependency_unavailable` |

Validation errors carry `errors: [{field, code, message}]`; never include Pydantic's raw input, passwords, cookies, tokens or destination in telemetry. A 409 is not always an alias collision.

Initial limits: signup 10/hour/IP; login 30/minute/IP plus 10/minute/account (both checked in one Redis pipeline); password change 10/hour/user; account deletion 10/hour/user; invite preview 60/minute/IP; workspace creation 10/hour/user; workspace link creation 60/minute/workspace; legacy create 20/minute/IP; bulk link actions 30/minute/workspace; link unlock 10 per 5 minutes per IP and code plus 100/hour/code; redirect 600/minute/IP; public metadata 120/minute/IP; legacy management/analytics 60/minute. The limiter fails closed for account, creation and management paths. Limits are in [caching-and-scale.md](caching-and-scale.md).

`429` always carries integer `Retry-After` seconds. Optional `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` use delta-seconds. Cron uses constant-time bearer validation against **`CRON_SECRET`**, rejects missing configuration and unauthorized callers, and returns only processing counts.

## CORS and schema

CORS allows only exact approved origins, with credentials enabled for the cookie flow. Methods: `GET`, `HEAD`, `POST`, `PATCH`, `DELETE`, `OPTIONS`. Allow `Content-Type`, `Idempotency-Key`, `X-Management-Token`, `X-Request-ID` and `X-Workspace-Id`; expose `Location`, `X-Request-ID`, rate-limit headers, `Retry-After` and `Server-Timing`. Preflight never triggers a click or consumes mutation limits. Origin/Referer validation is a separate CSRF check, not a substitute for CORS.

`/openapi.json` is public and contains no secrets; `/docs` and `/redoc` are local/preview only. Frontend types are currently hand-written.
