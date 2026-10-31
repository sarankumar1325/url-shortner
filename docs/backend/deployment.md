# Backend Deployment on Vercel

Status: accounts/workspaces/trust-recovery releases deployed and smoke-tested on Vercel 2026-10-25; durable stream analytics implemented and locally smoke-tested, pending deployment; open release gates remain · Vendor docs reviewed 2026-10-23

## Topology and prerequisites

Two projects in one repository: `backend` (FastAPI), `urlshortner` (static Vite). Neon and Upstash are external services. Both API and redirect domains point to the backend; this is not isolation between those routes. Select one function region close to both data services and verify availability/cost on the purchased plans.

The deployed projects use the free Vercel plan with `.vercel.app` hostnames:

- API and redirects: `https://shortlyyy-api.vercel.app`
- Web app: `https://shortlyyy-web.vercel.app`

The earlier `shortly-saran-api` and `shortly-saran-web` projects remain deployed as legacy hosts so links created before the rename continue to redirect. They share the same database but have their own `SHORT_BASE_URL` and CORS settings.

Custom origins such as `api.short.example`, `short.example` and `app.short.example` remain placeholders, not provisioned domains. Environment values are recorded in the Vercel project settings; they are not committed.

## Entrypoint and reproducibility

`backend/pyproject.toml` declares:

```toml
[tool.vercel]
entrypoint = "main:app"
```

`backend/main.py` is a thin Vercel entry shim that prepends `src/` to `sys.path` and imports `backend.main:app`. This resolves the nested source layout. Verified: the build installs runtime dependencies from `uv.lock`, uses Python 3.12 from `.python-version`, and `/health` responds. `backend/vercel.json` must keep `"framework": "fastapi"`; without it Vercel skips framework detection, falls back to the static builder and serves 404 for every route.

- Root directory: `backend`; framework: FastAPI; no frontend output directory.
- Runtime: Python 3.12, declared in `.python-version`.
- `httpx` is a runtime dependency because the Upstash REST client uses it; keep it out of dev-only dependencies.
- The whole FastAPI app becomes one function. `.vercelignore` excludes `.env*`, tests, Alembic files and caches from the bundle.
- Lifespan may initialize reusable clients, not migrations or recurring jobs. Shutdown cleanup has a 500 ms allowance; business work cannot depend on it.

## Continuous integration

`.github/workflows/ci.yml` runs on pushes, pull requests and manual dispatch:

- Backend: frozen `uv sync`, `ruff check`, `ruff format --check`, `pytest`.
- Frontend: frozen `bun install`, `bun test`, `bun run lint`, `bun run build`.

CI uses no production credentials and performs no migrations or deployments. Promotion remains an explicit release step; a green pipeline is not load, restore or availability evidence.

## Migrations

Alembic reads `DATABASE_URL_DIRECT` when set, otherwise `DATABASE_URL`, and connects with TLS. Run migrations once as an explicit release step before deploying code that needs the schema:

```bash
(cd backend && uv run alembic current && uv run alembic upgrade head)
```

Current production head is `e7b3a9c14d52` (session public IDs, applied 2026-10-25), following the invitation cleanup index and replay-cascade migrations. Never run migrations during function import, request handling or cold start. Use an expand/contract order so the previous backend revision keeps working during promotion; a failed migration needs a tested forward fix or an explicit safe rollback, not a blind downgrade.

## Function and cron configuration

The checked-in `backend/vercel.json` is:

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "crons": [
    { "path": "/internal/analytics/drain", "schedule": "0 3 * * *" },
    { "path": "/internal/maintenance", "schedule": "30 3 * * *" }
  ],
  "framework": "fastapi"
}
```

Do not add a `functions` block keyed on `main.py`: Vercel validates those patterns against an `api/` directory and rejects this layout. If route-level `maxDuration`/`excludeFiles` settings are needed, first confirm the resolved function file path in a build. Choose the region through supported project/function configuration and verify the actual runtime region.

## Scheduler gate

Vercel Cron requires **`CRON_SECRET`**. It sends `Authorization: Bearer <value>` automatically, which the internal routes validate. Fail closed when missing.

Deployed schedules are daily (`0 3 * * *` drain, `30 3 * * *` maintenance, UTC) because Hobby permits only daily jobs. A daily drain cannot meet the two-minute analytics target, so production also sets `DRAIN_ON_READ=true`: each analytics read drains up to 500 queued click events before querying. This gives read-triggered freshness for low traffic, not a bounded freshness guarantee under sustained traffic. A minute-level cron requires a supporting plan or a separately validated external scheduler (such as QStash), including its HTTP method, auth/signatures, retries and cost.

- Schedules target production only. Preview tests invoke internal routes explicitly with preview-only credentials and never touch production data.
- Failed cron calls are not automatically retried; a missed run is recovered by drain-on-read or the next daily run.
- Verified: authorized cron calls returned success and unauthorized calls returned 401.

## Environment settings

Settings are unprefixed (`env_file=".env"`), so Vercel receives exactly these names. Production values are stored in the Vercel project, never committed.

| Variable | Purpose |
| --- | --- |
| `ENVIRONMENT` | `local`, `test`, `preview`, `production`; production disables `/docs` and OpenAPI |
| `DEBUG` | Must be false in production |
| `DATABASE_URL` | Runtime Neon **pooled** URL (plain `postgresql://` accepted; normalized to `postgresql+asyncpg`) |
| `DATABASE_URL_DIRECT` | Direct Neon URL for migrations only |
| `UPSTASH_REDIS_REST_URL` | Upstash REST endpoint |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash REST token; server-side only |
| `SHORT_BASE_URL` | Trusted public short-link origin (`https://shortlyyy-api.vercel.app`); never derived from Host |
| `CORS_ORIGINS` | JSON array of exact web origins allowed **with credentials**; production holds only `["https://shortlyyy-web.vercel.app"]` |
| `SECRET_KEY` | Base secret; legacy token pepper and replay-encryption key are derived from it with HKDF. It does not encrypt session tokens |
| `CRON_SECRET` | Unprefixed platform bearer secret for internal routes |
| `DRAIN_ON_READ` | `true` on the free plan: bounded 500-event drain before analytics reads |
| `ANALYTICS_CLAIM_MIN_IDLE_SECONDS`, `ANALYTICS_MAX_ATTEMPTS` | Optional; stale pending messages are reclaimable after 60 seconds and dead-lettered after 5 deliveries |
| `SESSION_TTL_SECONDS`, `INVITATION_TTL_SECONDS` | Optional; session 30 days and invitation 7 days by default |
| `REDIRECT_CACHE_SECONDS`, `REPLAY_TTL_SECONDS`, `RAW_CLICK_RETENTION_DAYS`, `DAILY_RETENTION_DAYS` | Optional bounded defaults (60, 86400, 90, 730) |

Production rejects debug mode and disables interactive docs; this was verified on the deployed host. The OpenAPI document remains publicly reachable by design. Rotating `SECRET_KEY` invalidates existing legacy management tokens and replay ciphertexts but **not** active sessions, because session tokens are random and hashed independently. Rotating it does not invalidate session cookies; use explicit session deletion for that. Introduce versioned legacy keys before rotating in place. Never pass secrets in Vite variables, logs or screenshots.

Session cookies are `HttpOnly`, `SameSite=Lax`, `Path=/`, 30-day `Max-Age`, and `Secure` when `ENVIRONMENT` is `production` or `preview`. The frontend must reach the API through the same-origin `/api` rewrite for the cookie to stay first-party. Credentialed CORS is allowed only for the exact origins in `CORS_ORIGINS`; `allow_credentials=True` with a wildcard is invalid and must never be configured.

## Neon: pooling and TLS

Use a pooled endpoint for runtime, direct endpoint and separate DDL role for Alembic. Preview branches must derive from sanitized seed data, **not copies containing production customer links/tokens**. Database branch isolation alone does not sanitize copied data.

Do not append a psycopg-style `sslmode=require` option blindly to a SQLAlchemy asyncpg URL. asyncpg's raw DSN and SQLAlchemy keyword forwarding differ. The implementation normalizes `postgresql://`/`postgres://` to `postgresql+asyncpg`, strips `sslmode` and `channel_binding`, and connects with:

```python
create_async_engine(
    async_url(database_url),
    pool_size=5,
    max_overflow=2,
    pool_timeout=10,
    pool_pre_ping=True,
    pool_recycle=300,
    connect_args={"ssl": True, "timeout": 10, "command_timeout": 10},
)
```

`ssl=True` uses asyncpg's default verifying TLS context. Validate prepared statements, transaction-pool behavior, cancellation and reconnects against the pinned SQLAlchemy/asyncpg/Neon combination. Session state/advisory locks must not assume a stable backend connection across transactions.

Budget **live engine instances × pool capacity**, with worker/migration headroom. Neon's pooler client limit is not the number of concurrently executing backend transactions. `NullPool` may suit a validated driver/pooler combination, but requires its own concurrency cap and reconnect-cost measurement.

## Upstash and privacy

- Co-locate with functions; use separate production/preview databases where feasible, otherwise unique per-preview prefixes and scoped credentials (prefixes alone are not access control).
- Verify Lua, Streams, consumer-group creation/read/ACK/delete/reclaim and limits on the selected plan. Do not assume an HTTP adapter supports every TCP command. Verified against the current Upstash REST endpoint on 2026-10-25: `XADD`, `XGROUP CREATE ... MKSTREAM`, `XREADGROUP`, `XACK`, `XDEL`, `XPENDING` (summary and ranged), `XAUTOCLAIM`, `XRANGE`, `XLEN`, `XTRIM` and `RPOPLPUSH` all work.
- Prevent eviction of limiter/stream keys. Bound cache entries, stream bytes/events/age and diagnostics. Separate eviction domains if the service cannot safely mix them.
- A cache outage may lose click capture and force bounded DB fallback; size plans and alerts accordingly.
- Review platform access logs, telemetry and backups as well as application logs; app redaction does not automatically remove IPs from vendor logs.

## Backup and restore runbook

Postgres is the source of truth; Redis is a transient buffer. A backup is not a backup until a restore has been rehearsed.

**Neon**

- Enable the plan's PITR or scheduled backups and record the retention window. Free-plan retention is limited; do not claim a recovery point objective the plan cannot meet.
- Take an on-demand logical backup before risky migrations:

  ```bash
  pg_dump "$DATABASE_URL_DIRECT" -Fc -f "shortly-$(date -u +%Y%m%dT%H%M%SZ).dump"
  ```

- Restore into a **new Neon branch/database**, never directly over production:

  ```bash
  pg_restore --clean --if-exists --no-owner -d "$RESTORE_DATABASE_URL" shortly-<timestamp>.dump
  (cd backend && DATABASE_URL="$RESTORE_DATABASE_URL" uv run alembic current)
  ```

- Verify row counts for users, workspaces, memberships, links, raw clicks and daily rollups; verify foreign keys, a sample redirect, workspace ownership, invitation state and analytics totals. Run a session listing to confirm token hashes survived intact. If sessions must be invalidated after an incident, delete them deliberately rather than relying on a partial restore.
- Promote the restored database only after smoke checks and an explicit decision. A Vercel rollback does not revert data or migrations.

**Redis**

- Before planned maintenance or a database restore, drain until `stream_depth`, `pending`, `legacy_pending` and `legacy_in_flight` are 0 using the authenticated drain endpoint. Otherwise buffered clicks may be lost or replayed against a restored database.
- Capture a diagnostic copy of unprocessed events if the plan supports it: `XRANGE clicks:stream - + COUNT 1000` or the provider backup feature. Treat the payload as personal data.
- After restoring an older database snapshot, delete stream/dead-letter keys or accept that replaying old events may re-add clicks within the restored time range. `event_id` dedup prevents double counting only for rows present in the restored data.
- Backups and dumps contain token hashes and personal link data: encrypt at rest, restrict access, and delete drill copies.

**Verification cadence:** rehearse a restore quarterly (or before a major migration), measure actual RPO/RTO, and record the result. A Green CI run or successful deployment is not restore evidence.

## Verified deployment (2026-10-25)

| Check | Result |
| --- | --- |
| Entrypoint/build | `main:app` shim resolved; framework `fastapi`; Python 3.12; uv install from lockfile |
| Health | `/health` and `/ready` returned 200 on the hosted API |
| Production gating | `/docs` returned 404 with `DEBUG=false`; exact-origin credentialed CORS preflight passed |
| Auth | Sign-up 201 sets `HttpOnly` `SameSite=Lax` `Secure` cookie; login/logout; `/auth/me`; duplicate email 409; bad password 401 |
| CSRF | Allowed-origin browser writes succeed; disallowed/missing allowed origin returns 403 `csrf_rejected` |
| Tenancy/RBAC | Personal workspace on signup; shared workspace creation; owner/admin/member/viewer permissions; non-member workspace 404 |
| Invitations | Create, preview, accept, revoke; expired/accepted tokens 404 |
| Links | Workspace create 201, redirect 302 with `no-store`, HEAD not counted, pause 404, resume 302; legacy token path still works |
| Management | Legacy unlock, wrong-token 401, delete 204, repeat delete 204 |
| Analytics | Queued clicks drained on read; totals, device and referrer breakdowns correct |
| Password/sessions | Wrong current password 403; change 204 revoked other sessions and kept the current one; old password 401, new password 200; per-session revoke and revoke-others worked |
| Workspace lifecycle | Rename, ownership transfer (actor demoted to admin), personal-workspace guards, cross-tenant 404s, exact-name delete confirmation and hard delete verified |
| Settings UI | Production browser checks: rename, wrong/valid password change, session list/revoke, transfer confirmation, delete fallback to personal workspace |
| Scheduler | Authorized drain/maintenance calls succeeded; unauthorized calls returned 401 |
| Schema | Alembic at `e7b3a9c14d52`; session public IDs applied and backfilled |

Durable stream ingestion is implemented and was verified locally against the live Neon/Upstash instances on 2026-10-25: enqueue → drain → committed click and rollup → `XACK`/`XDEL` → queue clear, with the synthetic click and rollup delta removed afterward. It has **not** been deployed to Vercel yet, so the hosted API still runs the previous list-based consumer until the release is promoted.

Not verified: load/capacity, cold-start latency, region behavior, backup/restore, alerting, preview isolation, credential rotation, automated browser suite, and the durable-stream release in production. The deployment is a working demonstration, not a release-approved service.

## Delivery order and release gates

1. Run frozen installs, format/lint, unit/integration tests and generated-contract checks against disposable data.
2. Provision isolated target data with authorized credentials; run reviewed expand-only migrations once using the DDL role.
3. Build/deploy backend to preview and verify entrypoint, Python, TLS, connection behavior, CORS and headers. Production promotion must be explicitly gated after migrations/tests; default automatic main-branch deploys alone do not enforce this order.
4. Test auth/session/CSRF, workspace RBAC, invitations, create/replay, GET/HEAD redirect, update/delete cache bounds, credential failure, rich analytics, overlapping drain, cleanup and worker auth.
5. Deploy frontend against the matching API; browser-test same-origin cookie flow, auth pages, invitation acceptance, settings (password/session/workspace lifecycle), role-based controls, deep links, retries, storage failures and private-cache clearing.
6. Authorize production promotion/scheduling separately. Verify both backend hosts, budget alerts, backup restore, takedown/erasure procedure and rollback.

A Vercel code rollback does not undo migrations, data, secrets or a copied preview branch. Keep the previous deployment compatible through expand/contract. Restore only into an isolated DB first, measure RPO/RTO, and choose an explicit recovery action; never blindly downgrade destructive migrations.

## Local checks from repository root

Run backend/frontend development in separate terminals. Do not chain sibling `cd` commands that leave the next command in the wrong directory.

```bash
(cd backend && uv sync --locked && uv run pytest && uv run ruff check . && uv run ruff format --check .)
(cd backend && uv run alembic upgrade head)
(cd urlshortner && bun install --frozen-lockfile && bun run lint && bun run build)
```

Migrations, dependency audits, OpenAPI generation, load tests and CI-gated Vercel builds remain future gates. A local `vercel build` and the hosted deployment were validated for the current code; that does not establish the ongoing gates above.

## Official references

- [FastAPI entrypoints and function settings](https://vercel.com/docs/frameworks/backend/fastapi)
- [Python runtime and versions](https://vercel.com/docs/functions/runtimes/python)
- [Cron behavior and authentication](https://vercel.com/docs/cron-jobs/manage-cron-jobs)
- [Cron plan restrictions](https://vercel.com/docs/cron-jobs/usage-and-pricing)
- [Neon connection pooling](https://neon.com/docs/connect/connection-pooling)
- [SQLAlchemy asyncpg dialect](https://docs.sqlalchemy.org/en/20/dialects/postgresql.html#module-sqlalchemy.dialects.postgresql.asyncpg)
- [asyncpg connection API](https://magicstack.github.io/asyncpg/current/api/index.html#asyncpg.connect)
