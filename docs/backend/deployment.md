# Backend Deployment on Vercel

Status: target design · Related: [Architecture](architecture.md) · [ADR 0001](../adr/0001-two-vercel-projects.md)

## Topology

| Piece | Service | Notes |
| --- | --- | --- |
| API and redirects | Vercel Function (FastAPI) | One function bundle, Fluid compute |
| Durability | Neon Postgres | Pooled connection string |
| Cache, limits, stream | Upstash Redis | TLS, same region as functions |
| Scheduling | Vercel Cron or Upstash QStash | Analytics drain and cleanup |
| Web app | Separate Vercel project | See [frontend deployment](../frontend/deployment.md) |

Domains:

- `https://api.short.example` — REST API.
- `https://short.example` — public redirects.
- `https://app.short.example` — web app.

The API and redirect hostnames can point at the same Vercel project. Keeping them separate makes it possible to apply different WAF, cache, and DNS policies later.

## Vercel project configuration

- **Root directory**: `backend`
- **Framework preset**: FastAPI (auto-detected from `pyproject.toml`)
- **Install command**: default; Vercel uses uv with `uv.lock`
- **Build command**: default; no frontend build required
- **Output**: not applicable
- **Python**: 3.12 (`.python-version` pins `3.12`; Vercel supports 3.12–3.14)

**Entrypoint**

`backend/pyproject.toml` contains:

```toml
[tool.vercel]
entrypoint = "backend.main:app"
```

Vercel loads the `app` instance from `src/backend/main.py`. The `src/` layout is installed by uv, so the `backend` package is importable at runtime.

**Function settings**

Create `backend/vercel.json`:

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "functions": {
    "backend.main:app": {
      "maxDuration": 30
    }
  },
  "crons": [
    {
      "path": "/internal/analytics/drain",
      "schedule": "* * * * *"
    }
  ]
}
```

Notes:

- The function key must match Vercel's resolved entrypoint. Confirm it in the preview deployment output; some Vercel versions display the resolved file path (`src/backend/main.py`). If so, use that key.
- `maxDuration` applies to the whole FastAPI function. Redirects still return in milliseconds; the higher ceiling exists for the analytics drain.
- Vercel sends `Authorization: Bearer $CRON_SECRET` to cron paths when `CRON_SECRET` is configured.
- Minute-level cron requires a plan that supports it. On plans limited to daily schedules, use Upstash QStash for the drain or accept daily analytics freshness.
- The function bundle must stay under the 500 MB limit; runtime dependencies only.

**Lifespan**

Use FastAPI lifespan to create the async SQLAlchemy engine and Redis client, and dispose them on shutdown. Vercel allows at most 500 ms of cleanup after SIGTERM, so shutdown work must be trivial.

## Environment variables

| Variable | Example | Notes |
| --- | --- | --- |
| `URLSHORTNER_ENVIRONMENT` | `production` | Disables debug and API docs |
| `URLSHORTNER_DEBUG` | `false` | Never true in production |
| `URLSHORTNER_CORS_ORIGINS` | `["https://app.short.example"]` | JSON array |
| `URLSHORTNER_DATABASE_URL` | `postgresql+asyncpg://...-pooler...` | Neon pooled endpoint, TLS |
| `URLSHORTNER_REDIS_URL` | `rediss://default:...@...upstash.io:6379` | TLS |
| `URLSHORTNER_PUBLIC_BASE_URL` | `https://short.example` | Used to build `short_url` |
| `URLSHORTNER_MANAGEMENT_TOKEN_PEPPER` | random 32+ bytes | Token hashing |
| `URLSHORTNER_ANALYTICS_IP_SALT` | random 32+ bytes | IP hashing |
| `URLSHORTNER_CRON_SECRET` | random 32+ bytes | Internal drain auth |
| `URLSHORTNER_SENTRY_DSN` | optional | Error reporting |

Rules:

- Production, preview, and local values are separate.
- Secrets are never committed; `.env.example` contains placeholders.
- Vercel environment variables are scoped per environment.
- The application role for runtime has DML only; the migration role owns schema changes.

## Neon setup

1. Create a project in the region closest to the Vercel function region (for example, `aws-us-east-1` / `iad1`).
2. Use the **pooled** connection string for the application. Direct connections are for migrations.
3. Add `?sslmode=require` if it is not already present.
4. Create a production branch and a development branch.
5. For preview deployments, create a Neon branch per preview or use the Neon-Vercel integration to automate it.
6. Run Alembic migrations as a separate deployment step, not on function cold start.
7. Size the connection pool conservatively (`pool_size=5` per instance) and monitor active connections.

`DATABASE_URL` must use the async driver:

```text
postgresql+asyncpg://user:password@ep-xxx-pooler.us-east-1.aws.neon.tech/neondb?sslmode=require
```

## Upstash setup

1. Create a Redis database in the same region as the functions.
2. Enable TLS and copy the `rediss://` URL.
3. Use separate databases or key prefixes for `production` and `preview`.
4. Keep cache keys and rate-limit keys in the same database in v1 for simplicity; use distinct prefixes.
5. If eviction becomes a concern, separate the stream/limits database (no eviction) from the cache database (LRU).
6. Monitor command latency and error rate; place Upstash and Vercel in the same region.

The application abstracts Redis behind a `CacheClient` protocol. If TCP connection limits become a problem, replace the adapter with Upstash's REST API without changing services.

## CORS and domains

- Add `api.short.example` and `short.example` to the backend Vercel project.
- Add `app.short.example` to the frontend project.
- Set `URLSHORTNER_CORS_ORIGINS` to `["https://app.short.example"]`.
- Preview frontend deployments must use the preview API URL; add the exact preview origin to the preview environment's CORS list.
- Do not use wildcard origins.
- DNS is managed through Vercel; enable HSTS after the domains are verified.

## Local development

```bash
cd backend
uv sync
cp .env.example .env
# Start Postgres and Redis locally (Docker Compose planned) or point .env at dev instances
uv run uvicorn backend.main:app --reload
```

- `http://127.0.0.1:8000/health`
- `http://127.0.0.1:8000/docs` (debug/local only)
- `uv run pytest`
- `uv run ruff check .`
- `vercel dev` is optional and uses the Vercel runtime; use it to catch entrypoint issues before deploying.

Local `.env`:

```dotenv
URLSHORTNER_ENVIRONMENT=local
URLSHORTNER_DEBUG=true
URLSHORTNER_CORS_ORIGINS=["http://localhost:5173"]
URLSHORTNER_DATABASE_URL=postgresql+asyncpg://postgres:postgres@localhost:5432/urlshortner
URLSHORTNER_REDIS_URL=redis://localhost:6379/0
URLSHORTNER_PUBLIC_BASE_URL=http://127.0.0.1:8000
```

## CI/CD

Git integration with Vercel builds previews for pull requests and production for the main branch.

Required checks before merge:

- `uv run ruff check .`
- `uv run ruff format --check .`
- `uv run pytest`
- Alembic migration check (`alembic check`)
- OpenAPI schema snapshot diff
- Dependency audit (`pip-audit` or equivalent over `uv.lock`)

Deployment order:

1. Run backward-compatible migrations against the target database.
2. Deploy the backend.
3. Verify `/health`, `/ready`, create, redirect, and drain.
4. Deploy the frontend if its contract changed.

Never run destructive migrations in the same release as the code that removes their use. Use expand/contract.

## Preview environments

- Vercel Preview deployment with preview-scoped env vars.
- Separate Neon branch and Upstash prefix.
- `URLSHORTNER_ENVIRONMENT=preview`.
- API docs may be enabled in preview.
- Never point previews at production data.
- Cron jobs should be disabled or point at a preview-only drain to avoid duplicate ingestion.

## Rollback

- Use Vercel's instant rollback to a previous deployment.
- Keep migrations backward compatible for at least one release.
- Do not roll back a migration that has already removed data; use a forward fix.
- Verify a canary redirect and a create request after rollback.

## Limits and cost controls

- Function bundle: 500 MB standard limit; keep test and fixture files out of the bundle with `excludeFiles`.
- Request body: keep application limits well below platform limits (16 KB for JSON).
- Function duration: redirects are short; the drain has a 30 s ceiling.
- Fluid compute: pay for active CPU and provisioned memory; keep dependencies lean to reduce cold-start cost.
- Neon and Upstash: monitor storage, IOPS, command counts, and connection counts; set budget alerts.
- Vercel WAF: enable managed rules and rate limiting for volumetric abuse.

## Deployment checklist

- [ ] `uv.lock` is committed and current.
- [ ] `tool.vercel.entrypoint` resolves in a preview deployment.
- [ ] Python version is 3.12 in Vercel and local.
- [ ] Production secrets exist only in the production scope.
- [ ] `CORS_ORIGINS` matches the production web origin exactly.
- [ ] Neon pooled URL and Upstash TLS URL are used.
- [ ] Migrations have run and `alembic check` is clean.
- [ ] `/health` and `/ready` return success.
- [ ] Create, redirect, update, delete, and analytics work end to end.
- [ ] Cron invokes the drain with the secret and processes events.
- [ ] API docs are disabled in production.
- [ ] Alerts and dashboards are configured.
- [ ] A rollback deployment is known and viable.
