# Backend Deployment on Vercel

Status: proposed deployment, **not validated on Vercel** · Vendor docs reviewed 2026-10-23

## Topology and prerequisites

Two projects in one repository: `backend` (FastAPI), `urlshortner` (static Vite). Neon and Upstash are external services. Both API and redirect domains point to the backend; this is not isolation between those routes. Select one function region close to both data services and verify availability/cost on the purchased plans.

No Vercel projects, production databases, scheduler, credentials or custom domains are created by these docs. Placeholder origins are `api.short.example`, `short.example`, `app.short.example`.

## Entrypoint and reproducibility

Existing `backend/pyproject.toml`:

```toml
[tool.vercel]
entrypoint = "backend.main:app"
```

The app source is `src/backend/main.py`. Local uv installation makes `backend.main` importable, but this alone does **not prove Vercel resolves the nested source layout**. First deployment gate: inspect the resolved entrypoint and invoke `/health` in an authorized preview.

Vercel documents root `app.py`/`main.py` and equivalent files directly under `src/` or `app/`, plus custom module entrypoints. If this layout does not resolve, add a supported root ASGI entry module as a deliberate deployment adaptation in that milestone; do not invent an untested mapping now.

- Root directory: `backend`; framework: FastAPI; no frontend output directory.
- Runtime: Python 3.12, declared in `.python-version`. `requires-python >=3.12` alone does not pin a minor version; verify the build runtime and align it in implementation.
- Commit `uv.lock`; local/CI installs use `uv sync --locked`. Verify the Vercel install honors the lock and installs the local package; inspect build logs rather than assuming.
- The whole FastAPI app becomes one function. Standard uncompressed bundle limit is 500 MB; keep dev dependencies/test data out. Larger-function options are not needed for v1.
- Lifespan may initialize reusable clients, not migrations or recurring jobs. Shutdown cleanup has a 500 ms allowance; business work cannot depend on it.

## Proposed function configuration

Only after the build confirms `src/backend/main.py` as the resolved source, use a **file path relative to backend root**, not `backend.main:app`, in `functions`:

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "functions": {
    "src/backend/main.py": {
      "maxDuration": 30,
      "excludeFiles": "{tests/**,.pytest_cache/**,.ruff_cache/**}"
    }
  }
}
```

This is an illustrative configuration, not an existing file. If resolution uses a different entry file, use that verified path. Validate the schema/build using the chosen Vercel CLI version. Choose region using supported project/function configuration and verify the actual runtime region.

## Scheduler gate

Vercel Cron requires **`CRON_SECRET`**. It sends `Authorization: Bearer <value>` automatically; `URLSHORTNER_CRON_SECRET` alone does not work. Explicitly map the unprefixed variable in Pydantic settings. Fail closed when missing.

Pro/Enterprise production schedule proposal (merge into the validated function configuration only after routes exist):

```json
{
  "crons": [
    { "path": "/internal/analytics/drain", "schedule": "* * * * *" },
    { "path": "/internal/maintenance", "schedule": "17 3 * * *" }
  ]
}
```

- Schedules are UTC, target production, and can overlap or be missed. Failed cron calls are not automatically retried.
- Hobby permits daily jobs, with timing within the scheduled hour. A minute-level schedule fails deployment; it does not silently degrade.
- A daily drain cannot meet the two-minute analytics target. Choose a supporting plan or validate an external scheduler (such as QStash) before launch. Verify that scheduler's HTTP method, auth/signatures, retries and cost separately.
- Preview tests invoke internal routes explicitly with preview-only credentials; they never schedule production work or touch production data.

## Planned environment settings

The current scaffold has only app/environment/debug/API-prefix/CORS settings. Add the following with runtime startup validation during implementation; schema generation must work without external secrets or connections.

| Variable | Purpose |
| --- | --- |
| `URLSHORTNER_ENVIRONMENT` | `local`, `test`, `preview`, `production` |
| `URLSHORTNER_DEBUG` | Must be false in production |
| `URLSHORTNER_CORS_ORIGINS` | Exact controlled web origins, JSON array |
| `URLSHORTNER_DATABASE_URL` | Runtime Neon pooled async URL |
| `URLSHORTNER_REDIS_URL` | Certificate-verified TLS Redis endpoint |
| `URLSHORTNER_PUBLIC_BASE_URL` | Trusted short-link origin; never derived from Host |
| `URLSHORTNER_TOKEN_PEPPERS` | Versioned HMAC key map, current plus transitional previous keys |
| `URLSHORTNER_TOKEN_HASH_VERSION` | Version used for newly generated token digests |
| `URLSHORTNER_REPLAY_KEYS` | Versioned AEAD encryption key map, separate from peppers |
| `URLSHORTNER_REPLAY_KEY_ID` | Current encryption key ID |
| `URLSHORTNER_RATE_LIMIT_KEY` | Dedicated HMAC key for transient client identifiers |
| `CRON_SECRET` | Unprefixed platform bearer secret |

Additional limiter caps/deadlines must be bounded and documented in `.env.example` when implemented. Set an explicit global create budget and per-code management-attempt limit before public traffic. Keep the direct migration URL in the deployment job only, not the function environment.

Production, previews and local development use different secrets/data. Never pass secrets in Vite variables, commands saved in docs, logs or screenshots. Production rejects debug mode and disables interactive docs; the scaffold does not yet enforce those rules.

## Neon: pooling and TLS

Use a pooled endpoint for runtime, direct endpoint and separate DDL role for Alembic. Preview branches must derive from sanitized seed data, **not copies containing production customer links/tokens**. Database branch isolation alone does not sanitize copied data.

Do not append a psycopg-style `sslmode=require` option blindly to a SQLAlchemy asyncpg URL. asyncpg's raw DSN and SQLAlchemy keyword forwarding differ. For a URL without SSL query parameters, an explicit certificate-verifying configuration is:

```python
import ssl

from sqlalchemy.ext.asyncio import create_async_engine


def create_engine(database_url: str):
    return create_async_engine(
        database_url,
        connect_args={"ssl": ssl.create_default_context()},
        pool_size=2,
        max_overflow=0,
        pool_timeout=0.25,
        pool_pre_ping=True,
    )
```

This is proposed dependency code, not installed here. Local non-TLS Docker connections use explicit local-only configuration; never disable production verification. Validate prepared statements, transaction-pool behavior, cancellation and reconnects against the pinned SQLAlchemy/asyncpg/Neon combination. Session state/advisory locks must not assume a stable backend connection across transactions.

Budget **live engine instances × pool capacity**, with worker/migration headroom. Neon's pooler client limit is not the number of concurrently executing backend transactions. `NullPool` may suit a validated driver/pooler combination, but requires its own concurrency cap and reconnect-cost measurement.

## Upstash and privacy

- Co-locate with functions; use separate production/preview databases where feasible, otherwise unique per-preview prefixes and scoped credentials (prefixes alone are not access control).
- Verify Lua, Streams, consumer-group creation/read/ACK/delete/reclaim and limits on the selected plan. Do not assume an HTTP adapter supports every TCP command.
- Prevent eviction of limiter/stream keys. Bound cache entries, stream bytes/events/age and diagnostics. Separate eviction domains if the service cannot safely mix them.
- A cache outage may lose click capture and force bounded DB fallback; size plans and alerts accordingly.
- Review platform access logs, telemetry and backups as well as application logs; app redaction does not automatically remove IPs from vendor logs.

## Delivery order and release gates

1. Run frozen installs, format/lint, unit/integration tests and generated-contract checks against disposable data.
2. Provision isolated target data with authorized credentials; run reviewed expand-only migrations once using the DDL role.
3. Build/deploy backend to preview and verify entrypoint, Python, TLS, connection behavior, CORS and headers. Production promotion must be explicitly gated after migrations/tests; default automatic main-branch deploys alone do not enforce this order.
4. Test create/replay, GET/HEAD redirect, update/delete cache bounds, token failure, rich analytics, overlapping drain, cleanup and worker auth.
5. Deploy frontend against the matching API; browser-test deep links, retries, storage failures and private-cache clearing.
6. Authorize production promotion/scheduling separately. Verify both backend hosts, budget alerts, backup restore, takedown/erasure procedure and rollback.

A Vercel code rollback does not undo migrations, data, secrets or a copied preview branch. Keep the previous deployment compatible through expand/contract. Restore only into an isolated DB first, measure RPO/RTO, and choose an explicit recovery action; never blindly downgrade destructive migrations.

## Local checks from repository root

Run backend/frontend development in separate terminals. Do not chain sibling `cd` commands that leave the next command in the wrong directory.

```bash
(cd backend && uv sync --locked && uv run pytest && uv run ruff check . && uv run ruff format --check .)
(cd urlshortner && bun install --frozen-lockfile && bun run lint && bun run build)
```

Migrations, dependency audits, OpenAPI generation, integration tests and Vercel build validation remain future gates until their tooling exists. This docs review does not deploy or claim those gates passed.

## Official references

- [FastAPI entrypoints and function settings](https://vercel.com/docs/frameworks/backend/fastapi)
- [Python runtime and versions](https://vercel.com/docs/functions/runtimes/python)
- [Cron behavior and authentication](https://vercel.com/docs/cron-jobs/manage-cron-jobs)
- [Cron plan restrictions](https://vercel.com/docs/cron-jobs/usage-and-pricing)
- [Neon connection pooling](https://neon.com/docs/connect/connection-pooling)
- [SQLAlchemy asyncpg dialect](https://docs.sqlalchemy.org/en/20/dialects/postgresql.html#module-sqlalchemy.dialects.postgresql.asyncpg)
- [asyncpg connection API](https://magicstack.github.io/asyncpg/current/api/index.html#asyncpg.connect)
