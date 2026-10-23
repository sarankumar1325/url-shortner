# Frontend Deployment on Vercel

Status: target design · Related: [Frontend architecture](architecture.md) · [Backend deployment](../backend/deployment.md)

## Vercel project configuration

- **Root directory**: `urlshortner`
- **Framework preset**: Vite
- **Install command**: `bun install` (auto-detected from `bun.lock`)
- **Build command**: `bun run build`
- **Output directory**: `dist`
- **Node.js**: 22.12+ (Vite 8 requirement); Vercel's current LTS default is fine
- **Bun**: 1.4.x; commit `bun.lock` and pin via `packageManager`

`package.json`:

```json
{
  "packageManager": "bun@1.4.0",
  "engines": {
    "node": ">=22.12"
  },
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "lint": "oxlint",
    "test": "vitest run"
  }
}
```

If Vercel does not auto-detect Bun, set the install command explicitly to `bun install` in project settings.

## Environment variables

Vite embeds `VITE_*` variables at build time, so changing one requires a new deployment.

| Variable | Local | Production |
| --- | --- | --- |
| `VITE_API_BASE_URL` | `http://127.0.0.1:8000` | `https://api.short.example` |
| `VITE_SHORT_BASE_URL` | `http://127.0.0.1:8000` | `https://short.example` |

Rules:

- Never place secrets in `VITE_*` variables; they are visible in the bundle.
- Preview deployments use the preview API URL, not production.
- Keep `.env.local` out of version control; commit `.env.example`.
- Validate env variables at startup and fail fast with a clear error if missing.

```ts
// src/shared/lib/env.ts
const apiBaseUrl = import.meta.env.VITE_API_BASE_URL;
const shortBaseUrl = import.meta.env.VITE_SHORT_BASE_URL;

if (!apiBaseUrl || !shortBaseUrl) {
  throw new Error("Missing VITE_API_BASE_URL or VITE_SHORT_BASE_URL");
}

export const env = { VITE_API_BASE_URL: apiBaseUrl, VITE_SHORT_BASE_URL: shortBaseUrl };
```

## SPA routing and headers

React Router needs a fallback to `index.html` for client-side routes. Vercel serves existing static files before applying rewrites, so hashed assets are unaffected.

`urlshortner/vercel.json`:

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "rewrites": [
    {
      "source": "/(.*)",
      "destination": "/index.html"
    }
  ],
  "headers": [
    {
      "source": "/assets/(.*)",
      "headers": [
        {
          "key": "Cache-Control",
          "value": "public, max-age=31536000, immutable"
        }
      ]
    },
    {
      "source": "/(.*)",
      "headers": [
        {
          "key": "Strict-Transport-Security",
          "value": "max-age=63072000; includeSubDomains; preload"
        },
        {
          "key": "X-Content-Type-Options",
          "value": "nosniff"
        },
        {
          "key": "Referrer-Policy",
          "value": "strict-origin-when-cross-origin"
        },
        {
          "key": "X-Frame-Options",
          "value": "DENY"
        },
        {
          "key": "Permissions-Policy",
          "value": "geolocation=(), microphone=(), camera=()"
        },
        {
          "key": "Content-Security-Policy",
          "value": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' https://api.short.example; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
        }
      ]
    }
  ]
}
```

Notes:

- Connect-src must include the API origin. Add any approved error/analytics origins explicitly.
- `style-src 'unsafe-inline'` is required by some component and chart inline styles. If a nonce-based setup becomes possible, tighten it.
- The CSP is production-specific; preview deployments need their API origin added or a preview-specific header.
- Do not add `Access-Control-Allow-Origin` here; CORS belongs to the API.
- The rewrite must not break `/api` because the API is a separate domain, not a path on the web origin.

## Domains and TLS

- Add `app.short.example` as the production domain to the frontend project.
- Add `api.short.example` and `short.example` to the backend project.
- Let Vercel manage DNS and certificates, or point existing DNS at Vercel.
- Verify HTTPS and HSTS after DNS propagation.
- Keep the API and web app on separate origins as designed; do not proxy API traffic through the static site.

## Preview deployments

- Every pull request gets a Vercel preview URL.
- The preview frontend points at a preview API (`VITE_API_BASE_URL` preview scope).
- Add the preview origin to the backend's preview CORS allowlist. If using wildcard preview URLs, configure a constrained regex (for example `https://urlshortner-*.vercel.app`) only in preview, never in production.
- Preview builds use the same code path as production; do not gate features with `NODE_ENV` differences beyond env URLs.
- Do not let previews write to production analytics or production links.

## Deploy order

1. Deploy or verify the backend and its `/health` and `/ready`.
2. Confirm the frontend's API and short base URLs.
3. Build the frontend (`bun run build`).
4. Deploy to Vercel.
5. Smoke test: create a link, copy it, follow it, open analytics with the token.
6. Check CSP violations and CORS errors in the browser console.

## Rollback

- Use Vercel's instant rollback to a previous deployment.
- Environment variable changes require a redeploy; roll back both the deployment and the env if they changed together.
- The frontend is stateless; no migration or cleanup is needed.
- If the API contract changed, roll back the backend first or use an additive contract.

## CI checks

Before merging:

- `bun run lint` (oxlint)
- `bunx tsc -b`
- `bun run test`
- `bun run build`
- Generated API types are current
- Bundle size budget passes
- Playwright E2E against preview or local stack (optional gate)

Vercel builds previews automatically; CI should fail fast before Vercel spends a build.

## Local development

```bash
cd urlshortner
bun install
cp .env.example .env.local
bun dev
```

`.env.local`:

```dotenv
VITE_API_BASE_URL=http://127.0.0.1:8000
VITE_SHORT_BASE_URL=http://127.0.0.1:8000
```

Run the backend on port 8000 and confirm CORS includes `http://localhost:5173`.

## Caching behavior

- Hashed assets: immutable, one-year cache.
- `index.html`: revalidated so new deployments are picked up.
- No service worker in v1.
- API calls are not cached by the browser; TanStack Query caches in memory.
- Redirect URLs are not part of this project.

## Deployment checklist

- [ ] `bun.lock` is committed and current.
- [ ] `VITE_API_BASE_URL` and `VITE_SHORT_BASE_URL` are set per environment.
- [ ] SPA rewrite works for a deep link such as `/links/abc123`.
- [ ] CSP allows the API origin and no unexpected sources.
- [ ] CORS on the API includes the deployed web origin.
- [ ] Hashed assets return immutable cache headers.
- [ ] `index.html` is not cached indefinitely.
- [ ] Preview deployments use preview data.
- [ ] Create, copy, redirect, and analytics work end to end.
- [ ] Rollback deployment is known.
