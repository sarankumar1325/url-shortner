# URL Shortener — System Design Docs

Status: design baseline · Last updated: 2026-10-23

This directory is the source of truth for the product scope, architecture, API, data model, and deployment of the URL shortener. The code is implemented in two independent Vercel projects:

| Project | Local path | Stack | Vercel root directory |
| --- | --- | --- | --- |
| API | `backend/` | Python 3.12, FastAPI, uv | `backend` |
| Web app | `urlshortner/` | Bun, Vite 8, React 19, TypeScript | `urlshortner` |

## Product scope

**V1 is anonymous, but accounts-ready.**

Included:

- Create a short link with a generated or custom alias.
- Optional expiry.
- Fast redirects from `short.example/{code}`.
- Anonymous link management with a one-time management token.
- Rich click analytics: referrer, device, country, bot flag, and daily totals.
- Abuse controls: validation, rate limits, reserved aliases, and hashed IPs.

Designed for later, not built in v1:

- User accounts, dashboards, and teams.
- Custom domains per user.
- QR codes, bulk import, and link-in-bio pages.
- Safe Browsing / malware scanning.
- Multi-region active-active writes.

Non-goals:

- General-purpose file hosting.
- Tracking pixels or cross-site user tracking.
- Guaranteed analytics exactly-once semantics.

## Fixed decisions

| Decision | Choice | Rationale |
| --- | --- | --- |
| Hosting | Two Vercel projects, one repository | Independent deploy and scaling for API and static web app |
| Database | Neon Postgres (pooled) | Durable, relational, serverless-friendly connections |
| Cache and limits | Upstash Redis | Shared redirect cache, rate limits, and analytics stream |
| Short codes | Random 7-character Base62 with collision retry | Stateless generation fits serverless; unique constraint guarantees correctness |
| Redirect status | `302 Found` with `Cache-Control: no-store` | Preserves click analytics and allows link changes |
| Anonymous management | 256-bit token, shown once, stored as a hash | Enables edit/delete/analytics without accounts |
| Analytics | Async rich events via Redis Stream, batched into Postgres | Keeps the redirect path fast and failure-tolerant |
| Frontend | React SPA, Tailwind v4, shadcn/ui, TanStack Query | Static delivery, typed contracts, accessible components |

Detailed tradeoffs live in [`adr/`](adr/).

## System context

```mermaid
flowchart LR
    browser[User browser] -->|loads app| web[Web app<br/>Vite + React<br/>Vercel CDN]
    browser -->|REST /api/v1| api[FastAPI<br/>Vercel Function]
    browser -->|GET /{code}| api
    api -->|cache-aside| redis[(Upstash Redis)]
    api -->|SQL| db[(Neon Postgres)]
    api -->|XADD click event| redis
    cron[Vercel Cron / QStash] -->|drain every minute| api
    api -->|batch insert + rollups| db
```

The redirect path is intentionally short: **rate limit → Redis → Postgres on miss → enqueue click → redirect**. Analytics work never blocks the user's redirect.

## Request flows

**Create a link**

1. The app posts a validated URL and optional alias to `POST /api/v1/links`.
2. The API rate-limits the request, generates a code, and inserts the row.
3. A unique index resolves rare collisions; the API retries with a new code.
4. The API returns the short URL and a one-time management token.
5. The token is hashed in Postgres; only the client keeps the raw value.

**Follow a link**

1. `GET /{code}` hits the API.
2. The IP is rate-limited using a hashed key.
3. Redis returns the cached target; on a miss the API reads Postgres and repopulates the cache.
4. Expiry and active state are checked before redirecting.
5. A click event is appended to a Redis Stream.
6. The API returns `302` with `Cache-Control: no-store`.

**Read analytics**

1. The app sends the management token to `GET /api/v1/links/{code}/analytics`.
2. The API verifies the token hash and queries daily rollups (plus raw events for recent days).
3. The app renders totals and a time series.

## Reading order

1. [Backend architecture](backend/architecture.md)
2. [API contract](backend/api.md)
3. [Data model](backend/data-model.md)
4. [Short-link strategy](backend/short-links.md)
5. [Caching and scaling](backend/caching-and-scale.md)
6. [Analytics pipeline](backend/analytics.md)
7. [Security and abuse](backend/security.md)
8. [Observability and SLOs](backend/observability.md)
9. [Backend deployment](backend/deployment.md)
10. [Frontend architecture](frontend/architecture.md)
11. [Frontend data fetching](frontend/data-fetching.md)
12. [UI and accessibility](frontend/ui-and-a11y.md)
13. [Frontend performance](frontend/performance.md)
14. [Frontend deployment](frontend/deployment.md)
15. [Architecture decision records](adr/)

## Environments

| Environment | Web app | API | Data |
| --- | --- | --- | --- |
| Local | `http://localhost:5173` | `http://127.0.0.1:8000` | Docker Postgres + Redis, or Neon/Upstash dev databases |
| Preview | Vercel Preview URL | Vercel Preview URL | Neon branch + Upstash preview namespace |
| Production | `https://app.short.example` | `https://api.short.example` | Neon production + Upstash production databases |

Short links use a separate public origin: `https://short.example`. It points at the same FastAPI function as the API origin. Keeping the API and redirect hosts separate makes CORS, caching, and future WAF rules easier to reason about.

## Design principles

**Backend**

- Stateless request handling; no reliance on in-memory state across invocations.
- Clear layers: transport → service → repository → infrastructure.
- Correctness at the database boundary: unique constraints, foreign keys, transactions.
- Read path optimized for cache hits and low tail latency.
- Writes are idempotent where retries are possible.
- Dependencies fail soft for redirects and fail loudly for writes.
- Every request is traceable without logging secrets or raw IPs.

**Frontend**

- Server state is cached and deduplicated, never copied into a global store.
- API types are generated from the OpenAPI schema; no hand-written duplicates.
- Every screen has loading, empty, error, and success states.
- Route-level code splitting and a strict performance budget.
- Accessibility is part of the definition of done.
- Environment-specific API URLs; no secrets in the bundle.

## Implementation status

The current repository contains the scaffolds only:

- Backend: app factory, typed settings, CORS, `/health`, tests, lint, and Vercel entrypoint.
- Frontend: default Vite React/TypeScript app with Bun lockfile.

Everything else in this directory is the target design. Implementation milestones are tracked outside these docs.

## Document conventions

- `MUST`, `SHOULD`, and `MAY` follow RFC 2119 semantics.
- All timestamps are UTC ISO 8601; database columns use `timestamptz`.
- Examples use placeholder domains (`short.example`, `app.short.example`, `api.short.example`).
- "V1" means the first production release described here.
