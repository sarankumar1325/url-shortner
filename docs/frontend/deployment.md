# Frontend Deployment on Vercel

Status: deployment plan, not a verified deployment · Related: [architecture](architecture.md), [backend deployment](../backend/deployment.md), [API contract](../backend/api.md)

## What exists and what remains gated

The frontend is `urlshortner/`, with React/Vite source, `bun.lock`, an environment example, and `dev`, `lint`, `build`, `preview` scripts. `build` runs `tsc -b && vite build`. There is no frontend `vercel.json`, `packageManager` pin, strict-TypeScript setting, product router, API type-generation script or Vitest setup yet. Existing `dist/` output does not establish deployability or product readiness.

A future deployment must prove the checked-in `index.html` entrypoint, source imports and public assets resolve in a clean build and hosted browser. Do not assume a configuration snippet or Vercel framework detection works without preview evidence. Backend package/entrypoint resolution is separately gated by [backend deployment](../backend/deployment.md); a healthy static page does not prove the API is ready.

## Project settings to verify

| Setting | Target |
| --- | --- |
| Vercel project | Separate frontend project, distinct from API/redirects |
| Root directory | `urlshortner` |
| Framework | Vite, confirmed in build output |
| Install | `bun install --frozen-lockfile` |
| Build | `bun run build` |
| Output | `dist` |
| Runtime/toolchain | Explicit tested Bun and compatible Node versions, recorded in project settings |

Pin the tested Bun version through `packageManager` in a later implementation change and verify that the hosting build actually uses it. Check the locked Vite/plugin engine requirements against the selected Node runtime; do not rely on a moving “current LTS” or claim a pin already exists. A frozen-install failure is a release blocker, not permission to regenerate the lock during deployment. Lock updates belong in a reviewed dependency change.

### Plan/capability gate

Before wiring production or previews, record the chosen Vercel plan and confirm its support/limits for this repository, Git integration, preview protection, build/runtime versions, usage and spend controls. Automatic PR previews are an integration setting to verify, not an unconditional platform promise.

For the integrated product, also confirm the backend plan's function runtime/duration, region and scheduler capabilities. Minute-level cron requires a supporting plan or a separately validated external scheduler. Hobby's daily schedule does not meet the V1 two-minute healthy-operation freshness target; slower processing requires an explicit product/SLO change, not a silent deployment fallback. The frontend must display actual analytics freshness regardless of schedule. Do not promise a one-minute end-to-end guarantee.

## Environment and origins

These are public **build-time** values. Changing them requires a new build/deployment; no secret belongs in any `VITE_*` value.

| Variable | Local example | Production example |
| --- | --- | --- |
| `VITE_API_BASE_URL` | `http://127.0.0.1:8000` | `https://api.short.example` |
| `VITE_SHORT_BASE_URL` | `http://127.0.0.1:8000` | `https://short.example` |

All `short.example` hostnames here are placeholders. Validate required URLs before a release build: HTTPS outside local development, expected origin, no embedded credentials or tokens. Keep local environment files untracked. The implementation should prefer the API's returned `short_url` for copying rather than inventing a potentially mismatched short domain.

- Production web origin: for example `https://app.short.example`.
- Preview: a controlled frontend preview origin paired with a preview API, preview short domain and isolated backend data. Never use production credentials, links or analytics stores for preview tests.
- Local web origin: normally `http://localhost:5173`; `127.0.0.1` and alternate ports are distinct origins and must be explicitly allowed if used.

CORS belongs to the API, not the static frontend. Allow only exact approved frontend origins, with methods `GET`, `HEAD`, `POST`, `PATCH`, `DELETE`, `OPTIONS` and request headers `Content-Type`, `Idempotency-Key`, `X-Management-Token`, `X-Request-ID`. Expose `Location`, `X-Request-ID`, `Retry-After` and the documented rate-limit headers. V1 uses token headers, not cookie credentials.

For previews, register exact origins from trusted deployment metadata or use an exact controlled preview alias. Remove retired origins. **Do not use `*`, `*.vercel.app`, project-name wildcard patterns or broad preview-origin regexes.** Production CORS must not acquire preview entries by default. Test OPTIONS and actual browser requests, including error responses.

## Routing, cache and security headers

Plan the SPA fallback only for document navigation. Verify real assets are served as assets and missing assets/API-like paths do not silently become an HTTP-200 HTML success. The API is a separate origin; do not proxy it through a catch-all static rewrite.

Deep links such as `/links/abc123` must load on refresh. An unknown client route normally gets the SPA shell with **HTTP 200** and then renders its not-found UI; that is not a true HTTP 404. True document status behavior needs a different hosting design.

| Response | Policy to verify on the deployed URL |
| --- | --- |
| Fingerprinted `/assets/*` | `Cache-Control: public, max-age=31536000, immutable` |
| HTML and SPA fallback | `Cache-Control: no-cache` (revalidate) |
| All API responses, including public metadata/errors/204 | `Cache-Control: no-store`, configured by backend |
| Backend redirects | `Cache-Control: no-store`, outside this project |

No service worker or persisted Query cache in V1. Check that HTML fallback headers do not accidentally make assets uncacheable or missing HTML responses immutable.

Security-header targets: `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, and a Permissions Policy disabling unused camera, microphone and geolocation. A starting **production CSP policy to test**, not a configuration already installed:

```text
default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self' https://api.short.example; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'
```

Generate/check the policy per environment: `connect-src` must contain the **exact deployed API origin**, and only exact explicitly approved telemetry origins if that tooling is later added. Preview builds must allow their preview API rather than a wildcard or production API. Keep scripts same-origin, without blanket inline/eval allowances. Test chart/component inline styles; if necessary, document and narrowly scope a style exception rather than copying a generic permissive policy. Preview toolbars or protection flows also need testing; disable unneeded injections rather than weakening CSP broadly.

Verify HTTPS/certificate ownership for each hostname. Review existing platform HSTS and start with an appropriate host-scoped policy; do **not** blindly add `includeSubDomains` or `preload`. Those require domain-wide HTTPS readiness, ownership review and a deliberate rollout.

## Verification commands from the repository root

The following are operator instructions, not commands executed by this documentation review. Run from `/Users/saran/Downloads/learning/url shortner` (or the equivalent checkout root); there is no root frontend package script.

Current scripts/tooling, after selecting compatible versions:

```bash
bun --version
node --version
bun install --cwd "./urlshortner" --frozen-lockfile
bun run --cwd "./urlshortner" lint
./urlshortner/node_modules/.bin/tsc -b ./urlshortner/tsconfig.json
bun run --cwd "./urlshortner" build
bun run --cwd "./urlshortner" preview --host 127.0.0.1
```

Typechecking is also part of `build`; the explicit command isolates its failures and uses the installed compiler without fetching an unpinned `bunx` package. Passing it does not imply strict mode, which is not currently enabled. The final command starts a local static preview, not a backend or production server.

The following commands are **planned only**, after the corresponding scripts/dependencies and product schema exist:

```bash
bun run --cwd "./urlshortner" api:types
git diff --exit-code -- "./urlshortner/src/shared/api/schema.d.ts"
bun run --cwd "./urlshortner" test
bun run --cwd "./urlshortner" test:e2e
```

Define `api:types` to use a pinned local generator against a verified backend OpenAPI snapshot or controlled running API. Commit generated types; CI should regenerate and detect drift, including unexpected new output, before compiling. Define `test` for Vitest and `test:e2e` for the controlled preview/local stack. Until these exist, do not advertise them as successful checks or installed capabilities. Bundle/accessibility gates likewise require implementation and a recorded baseline; see [performance](performance.md).

## Preview and production gates

1. **Reproducibility:** clean frozen install, actual tool versions recorded, lint/typecheck/build pass; all planned feature tests/types needed for release have landed and passed. Verify HTML entrypoint and emitted assets in a browser with no console exceptions.
2. **Backend readiness:** preview API entrypoint/package resolution, health/readiness, migrations and isolated data are verified by its owner. Confirm the API schema matches generated client types. Vercel cron runs only on production deployments: test preview drains through explicitly authorized manual invocations, and verify the production schedule before promotion.
3. **Origin isolation:** preview points only to preview API/data; exact CORS preflight succeeds; CSP permits the intended connections and denies unintended ones. Confirm any preview deployment protection allows the intended browser flow without exposing bypass secrets in the bundle.
4. **Routing/delivery:** `/`, direct `/links/:code`, unknown routes, existing/missing assets, actual cache/security headers and compressed delivery behave as intended. Inspect both HTTP status and rendered page rather than treating the not-found component as a 404 response.
5. **Contract smoke tests:** create with a UUIDv4 key; replay identical key/body and verify the same link/token; distinguish all 409 codes; cancel/timeout safely; test copy/token backup, explicit remembrance and denied storage, token replacement/rejection/cross-tab forget, PATCH, repeated valid-token DELETE returning 204, and the backend redirect.
6. **Analytics:** active and token-authorized expired/inactive links work; invalid-token metadata returns 401 and deleted/blocked reads 404. Check UTC presets, zero-filled series, V1 breakdown ranges/truncation, nullable freshness and retained-result labels under delay. Confirm all API success/error responses are `no-store`.
7. **Promotion:** keyboard/accessibility checks and proposed performance measurements are reviewed; domain/certificates, production environment/CSP/CORS and plan limits are approved. Retain a known compatible previous deployment and record release evidence before promotion.

A green static build alone is not approval to release the product. Do not run production mutations to test a preview.

## Release and rollback

Deploy a backward-compatible backend and verify it before promoting a frontend that needs the new contract. Rebuild when public environment values change; check the promoted bundle actually contains the intended non-secret origins.

For rollback, choose a known frontend artifact compatible with the currently running API and stored credential-record version. Verify rollback availability/permissions on the selected Vercel plan. Do not automatically roll back the backend first: migrations and client compatibility must be considered together. A static app still has browser state, open tabs and old cached assets; keep required assets/contracts compatible during the transition. Preserve token copies and make invalid/corrupt stored records fail safely rather than silently deleting access.

After rollback, verify create/replay, token-scoped reads, redirects, deep links, headers and environment isolation again.
