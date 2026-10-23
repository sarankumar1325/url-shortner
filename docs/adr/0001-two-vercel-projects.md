# ADR 0001: Two Vercel Projects in One Repository

- Status: Accepted
- Date: 2026-10-23

## Context

The product needs a FastAPI backend with Python dependencies and a static React frontend built with Bun and Vite. Both must be hosted on Vercel. The repository already contains two independent folders:

- `backend/` with `pyproject.toml`, `uv.lock`, and a Python runtime.
- `urlshortner/` with `package.json`, `bun.lock`, and a Vite build.

The backend and frontend have different runtimes, install commands, build outputs, and scaling behavior. The API also needs a public redirect host that is distinct from the web app.

## Decision

Use **one repository** and **two Vercel projects**:

| Project | Root directory | Domain |
| --- | --- | --- |
| API | `backend` | `api.short.example`, `short.example` |
| Web app | `urlshortner` | `app.short.example` |

Each project has its own environment variables, preview deployments, build settings, and rollback history. The two communicate over HTTPS with strict CORS. The API is stateless; the web app is static.

## Consequences

**Positive**

- Independent deploy cadence and rollback: a UI-only change does not redeploy the API.
- Independent scaling and runtime configuration.
- Clear separation of public origins: redirects and API traffic can receive different WAF/cache policies.
- One repository keeps contract changes reviewable in a single pull request.
- Vercel's native FastAPI and Vite presets work without custom servers.

**Negative**

- CORS must be configured and kept in sync with frontend origins.
- Environment variables and preview data isolation are duplicated across projects.
- A breaking API change requires deploying both sides in the right order.
- Two Vercel projects to monitor, budget, and secure.
- There is no shared build pipeline by default; CI covers the contract instead.

**Mitigations**

- Additive API versioning (`/api/v1`) and OpenAPI schema diffs in CI.
- Preview CORS allowlists scoped to preview URLs only.
- A deploy-order checklist: backend first, then frontend.
- Separate preview Neon branches and Upstash namespaces.

## Alternatives considered

### One Vercel project with Vercel Services

Vercel Services can host a frontend and a private FastAPI backend with service bindings. This reduces public API surface and avoids CORS. It was not chosen because:

- The redirect domain must be publicly reachable and independently cacheable.
- The user explicitly asked for two separate folders/projects.
- Separate public API and web origins are simpler to reason about for a learning system design.

It remains a reasonable future option if the API becomes private to the frontend.

### One FastAPI project serving the built frontend

FastAPI can serve static assets and expose the API from one origin. This removes CORS but couples frontend deploys to Python function deploys, increases function traffic for static assets, and loses Vercel's static CDN advantages. Rejected for v1.

### Two separate repositories

Maximum independence, but contract changes span two repos and require coordinated releases. The single-repo, two-project model keeps atomic changes without coupling deploys.

## References

- [Backend deployment](../backend/deployment.md)
- [Frontend deployment](../frontend/deployment.md)
- [API contract](../backend/api.md)
