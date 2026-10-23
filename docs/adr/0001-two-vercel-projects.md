# ADR 0001: Two Vercel Projects in One Repository

Status: Accepted hosting direction; deployment validation pending · Reviewed: 2026-10-23

## Decision

Keep FastAPI/uv in `backend/` and Bun/Vite/React in `urlshortner/`. Deploy as separate Vercel projects from the same repository, each with its own root, environment, preview and rollback settings.

The backend handles both API and public redirects. Separate API/redirect hostnames enable distinct policies but do not create separate compute or security boundaries. The static frontend calls the API over HTTPS with exact CORS origins.

## Tradeoffs

- Separate builds/runtime settings and independent promotion; the repository allows coordinated contract changes.
- CORS, preview API pairing, credentials and schema compatibility must be managed explicitly.
- Deploying only changed directories requires actual CI/Vercel build rules; folder separation alone does not prevent redundant builds.
- Migrations and approval gates must precede production promotion; automatic main-branch deployment is not a substitute.
- The nested Python entrypoint must be verified before treating the backend as deploy-ready.

## Alternatives

One combined deployment could reduce CORS and coordinate builds, but couples releases. Current Vercel FastAPI static-asset/CDN support means it is inaccurate to say combining necessarily loses CDN delivery. Two folders alone do not mandate two Vercel projects; independent runtime/release control is the reason for this choice.

Two repositories add cross-repository contract coordination without a current benefit. No microservice split is needed for a single link-management domain.

## References

[Backend deployment](../backend/deployment.md) · [Frontend deployment](../frontend/deployment.md) · [Delivery gates](../README.md#implementation-plan)
