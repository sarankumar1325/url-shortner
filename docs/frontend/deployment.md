# Frontend Deployment on Vercel

Status: accounts/workspaces release deployed to Vercel and smoke-tested 2026-10-24, with open release gates · Related: [architecture](architecture.md), [backend deployment](../backend/deployment.md), [API contract](../backend/api.md)

## What exists and what remains gated

The frontend is `urlshortner/`, with React/Vite source, product auth/workspace routes, a typed API client, `bun.lock`, an environment example, a same-origin `/api` rewrite plus SPA fallback in `vercel.json`, and `dev`, `lint`, `test`, `build`, `preview` scripts. `build` runs `tsc -b && vite build`. There is still no `packageManager` pin or generated API types. A Playwright journey lives in `e2e/` ([below](#end-to-end-tests)). Existing `dist/` output does not by itself establish product readiness.

A live deployment exists at `https://shortlyyy-web.vercel.app`, built from the `urlshortner` root directory against `https://shortlyyy-api.vercel.app`. The smoke test covered sign-up/sign-in, the personal workspace, workspace creation, invitation acceptance, role-based controls, link create/copy/redirect, analytics, pause/resume, legacy-token access and delete. It did not cover unknown-route HTTP status, response-header policy, preview isolation or accessibility; those gates remain open. Backend package/entrypoint resolution is covered by [backend deployment](../backend/deployment.md).

## Verified deployment (2026-10-24)

| Check | Result |
| --- | --- |
| Framework/build | Vite static build from `urlshortner/`; `vercel.json` rewrites `/api/*` to the API and other paths to `/index.html` |
| Public config | `VITE_API_BASE_URL` blank, so all requests are same-origin `/api`; bundle contains no secrets |
| Auth | Sign-up, sign-in, reload session restore, sign-out; `shortly_session` cookie is `HttpOnly` and `SameSite=Lax` |
| Tenancy | Personal workspace auto-created; shared workspace creation; switching workspace updates `X-Workspace-Id` (the sidebar switcher used then has since been replaced by the command palette) |
| RBAC | Owner/admin/member/viewer controls behaved per role; unauthorized actions were hidden or rejected |
| Invitations | Create, copy link, preview, accept, and join the workspace; revoked/expired links rejected |
| Product flow | Create → copy → redirect → analytics → pause/resume → delete in a browser against production |
| CORS | Production API accepts only the exact web origin with credentials; preflight allows `X-Workspace-Id` |
| SPA delivery | `/`, direct `/links/:code` and fingerprinted `/assets/*` load on the hosted host |

Not verified: performance/load, HTML/asset cache and security headers, CSP, unknown-route 404 semantics, preview environments, custom domains, automated a11y suites, cross-tab state. The Playwright journey covers one happy path, not the full browser matrix. Treat the deployment as a working demonstration, not a release-approved service.

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

For the integrated product, also confirm the backend plan's function runtime/duration, region and scheduler capabilities. The deployed projects use the free Vercel plan: Hobby permits only daily jobs, so the backend runs a daily drain and additionally drains up to 500 queued clicks on analytics reads (`DRAIN_ON_READ=true`). That gives eventual freshness on read, not the V1 two-minute target under idle or high-volume conditions; faster processing needs a supporting plan or a validated external scheduler. The frontend must display actual analytics freshness regardless of schedule. Do not promise a one-minute end-to-end guarantee.

## Same-origin API route and cookie model

The session is a credentialed `HttpOnly` cookie, so the browser must see the API as same-origin:

- **Local:** Vite proxies `/api` to `API_PROXY_TARGET` (default `http://127.0.0.1:8000`). Run the web app at `http://localhost:5173`; the backend `CORS_ORIGINS` must include that exact origin because the browser's `Origin` header carries it even through the proxy.
- **Production:** `vercel.json` rewrites `/api/:path*` to `https://shortlyyy-api.vercel.app/api/:path*`. The browser requests `https://shortlyyy-web.vercel.app/api/...`, and the cookie is set for the web host.
- Leave `VITE_API_BASE_URL` blank in production. Setting it to a different origin breaks the first-party cookie assumption and requires credentialed CORS, a different cookie domain strategy and new tests.

Do not route the redirect hostname through this rewrite; short links resolve on the backend short domain.

## Environment and origins

| Variable | Local example | Production value |
| --- | --- | --- |
| `VITE_API_BASE_URL` | empty | empty (same-origin `/api`) |
| `API_PROXY_TARGET` | `http://127.0.0.1:8000` | not used at build/runtime by the static host |

These are public **build-time** values. Changing them requires a new build/deployment; no secret belongs in any `VITE_*` value.

The short-link origin is not a frontend build input: copy actions use the API's returned `short_url`, which the backend builds from `SHORT_BASE_URL`. Custom hostnames such as `api.short.example` remain placeholders, not provisioned domains.

- Production web origin: `https://shortlyyy-web.vercel.app` (exact CORS entry on the API).
- Preview: a controlled frontend preview origin paired with a preview API, preview short domain and isolated backend data. Never use production credentials, links or analytics stores for preview tests.
- Local web origin: normally `http://localhost:5173`; `127.0.0.1` and alternate ports are distinct origins and must be explicitly allowed if used.

CORS belongs to the API, not the static frontend. Allow only exact approved frontend origins **with credentials enabled**, methods `GET`, `HEAD`, `POST`, `PATCH`, `DELETE`, `OPTIONS` and request headers `Content-Type`, `Idempotency-Key`, `X-Management-Token`, `X-Workspace-Id`, `X-Request-ID`. Expose `Location`, `X-Request-ID`, `Retry-After` and the documented rate-limit headers. Cookies are the account credential; `X-Management-Token` remains only for legacy links.

For previews, register exact origins from trusted deployment metadata or use an exact controlled preview alias. Remove retired origins. **Do not use `*`, `*.vercel.app`, project-name wildcard patterns or broad preview-origin regexes.** A wildcard with credentials is invalid and would be unsafe; production CORS must not acquire preview entries by default. Test OPTIONS and actual browser requests, including error responses.

## Routing, cache and security headers

Plan the SPA fallback only for document navigation. Verify real assets are served as assets and missing assets/API-like paths do not silently become an HTTP-200 HTML success. The `/api` rewrite must precede the catch-all; do not send unknown API paths to the SPA shell.

Deep links such as `/links/abc123` must load on refresh. An unknown client route normally gets the SPA shell with **HTTP 200** and then renders its not-found UI; that is not a true HTTP 404. True document status behavior needs a different hosting design.

| Response | Policy to verify on the deployed URL |
| --- | --- |
| Fingerprinted `/assets/*` | `Cache-Control: public, max-age=31536000, immutable` |
| HTML and SPA fallback | `Cache-Control: no-cache` (revalidate) |
| All API responses, including public metadata/errors/204 | `Cache-Control: no-store`, configured by backend |
| Backend redirects | `Cache-Control: no-store`, outside this project |

No service worker or persisted Query cache in V1. Private link/workspace data stays in memory and is discarded when the session or workspace changes. Check that HTML fallback headers do not accidentally make assets uncacheable or missing HTML responses immutable.

Security-header targets: `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, and a Permissions Policy disabling unused camera, microphone and geolocation. A starting **production CSP policy to test**, not a configuration already installed:

```text
default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self' https://shortlyyy-api.vercel.app; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'
```

Generate/check the policy per environment: `connect-src` must contain the **exact deployed API origin** (or only `'self'` if all requests truly stay same-origin through the rewrite), and only exact explicitly approved telemetry origins if that tooling is later added. Preview builds must allow their preview API rather than a wildcard or production API. Keep scripts same-origin, without blanket inline/eval allowances. Test chart/component inline styles; if necessary, document and narrowly scope a style exception rather than copying a generic permissive policy. Preview toolbars or protection flows also need testing; disable unneeded injections rather than weakening CSP broadly.

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

Typechecking is also part of `build`; the explicit command isolates its failures and uses the installed compiler without fetching an unpinned `bunx` package. `strict`, `noUnusedLocals`, `noUnusedParameters` and `erasableSyntaxOnly` are enabled. The final command starts a local static preview, not a backend or production server; the `/api` rewrite is not exercised by `vite preview`.

The following commands are **planned only**, after the corresponding scripts/dependencies and product schema exist:

```bash
bun run --cwd "./urlshortner" api:types
git diff --exit-code -- "./urlshortner/src/shared/api/schema.d.ts"
```

`bun run test` already exists and runs `bun test`. Define `api:types` to use a pinned local generator against a verified backend OpenAPI snapshot or controlled running API. Commit generated types; CI should regenerate and detect drift before compiling. Until it exists, do not advertise it as a successful check or installed capability. Bundle/accessibility gates likewise require implementation and a recorded baseline; see [performance](performance.md).

## End-to-end tests

Playwright runs one serial journey in Chromium with clipboard permissions: `urlshortner/e2e/journey.e2e.ts`, helpers in `e2e/account.ts`, configuration in `urlshortner/playwright.config.ts`. Files are named `*.e2e.ts` so `bun test` does not pick them up.

```bash
(cd urlshortner && bunx playwright install chromium)        # once
bun run --cwd "./urlshortner" e2e                          # local: starts Vite on :5173; API must run at 127.0.0.1:8000
E2E_BASE_URL=https://shortlyyy-web.vercel.app bun run --cwd "./urlshortner" e2e
```

`E2E_BASE_URL` selects the target; without it the config starts (or reuses) `bun run dev` on `http://localhost:5173`. The journey signs up a fresh `qa-droid-<timestamp>@example.com` account and covers: landing in the personal workspace; pasting into the destination field and a global paste; picking an expiry a week out with the keyboard in the date picker; create, focus on **Copy link** and the full URL on the clipboard; copying a hovered row with `c`; `Server-Timing` on API responses; opening the command palette with ⌘K/Ctrl+K and navigating to Your links; a password-protected link (wrong password rejected, correct password unlocks and reaches the destination); a smart redirect rule for iPhone checked by requesting the link with iPhone and desktop user agents; the **Password** and **Smart** list badges and bulk-pausing both links from the selection bar (the paused link then returns `404`); sign-out, a rejected wrong password and sign-in; "Stay signed in" surviving a simulated browser restart (persistent cookies kept, session cookies dropped) while an unchecked box does not; and deleting the account from Settings. `afterAll` deletes the account through the API even when a test fails. Any leftovers can be removed with the [cleanup script](../backend/deployment.md#test-account-cleanup).

`.github/workflows/e2e.yml` runs the same suite manually (`workflow_dispatch`) against its `base_url` input, default `https://shortlyyy-web.vercel.app`, and uploads the report on failure. It is not part of push CI. Running it against production creates and deletes one real account.

## Preview and production gates

1. **Reproducibility:** clean frozen install, actual tool versions recorded, lint/typecheck/build pass; all planned feature tests/types needed for release have landed and passed. Verify the HTML entrypoint and emitted assets in a browser with no console exceptions.
2. **Backend readiness:** preview API entrypoint/package resolution, health/readiness, migrations and isolated data are verified by its owner. Confirm the API schema matches hand-written client types. Vercel cron runs only on production deployments: test preview drains through explicitly authorized manual invocations, and verify the production schedule before promotion.
3. **Origin/cookie isolation:** preview points only to preview API/data; exact credentialed CORS preflight succeeds; `Set-Cookie` is accepted and sent on subsequent requests; CSP permits the intended connections. Confirm any preview deployment protection allows the intended browser flow without exposing bypass secrets in the bundle.
4. **Routing/delivery:** `/`, `/login`, `/signup`, direct `/invite/:token`, `/links/:code`, unknown routes, existing/missing assets, actual cache/security headers and compressed delivery behave as intended. Inspect both HTTP status and rendered page rather than treating the not-found component as a 404 response.
5. **Auth smoke tests:** sign-up creates a personal workspace; duplicate email returns `409`; bad credentials return uniform `401`; reload restores the session; sign-out clears it; a cross-origin `POST` is rejected with `csrf_rejected`; expired/invalid session redirects to login.
6. **Tenancy and RBAC:** create a second workspace; invite each assignable role; accept with a signed-in account; verify viewer cannot mutate, member cannot manage people, admin cannot manage admins, owner controls remain, and cross-workspace access returns `404`. Test leaving as a non-owner.
7. **Contract smoke tests:** create with a UUIDv4 key; replay identical key/body and verify the same link; distinguish all `409` codes; cancel/timeout safely; test legacy token paste/rejection/forget, PATCH, repeated valid DELETE returning 204, and the backend redirect.
8. **Analytics:** active links and token-authorized expired/inactive links work; deleted/blocked reads return 404. Check UTC presets, zero-filled series, V1 breakdown ranges/truncation, nullable freshness and retained-result labels under delay. Confirm all API success/error responses are `no-store`.
9. **Promotion:** keyboard/accessibility checks and proposed performance measurements are reviewed; domain/certificates, production environment/CSP/CORS and plan limits are approved. Retain a known compatible previous deployment and record release evidence before promotion.

A green static build alone is not approval to release the product. Do not run production mutations to test a preview.

## Release and rollback

Deploy a backward-compatible backend and verify it before promoting a frontend that needs the new contract. Rebuild when public environment values change; check the promoted bundle actually contains the intended API origin (or same-origin `/api`) and no secrets.

For rollback, choose a known frontend artifact compatible with the currently running API and session/cookie behavior. Verify rollback availability/permissions on the selected Vercel plan. Do not automatically roll back the backend first: migrations and client compatibility must be considered together. A static app still has browser state, open tabs and old cached assets; keep required assets/contracts compatible during the transition. Preserve legacy token copies and make invalid/corrupt stored records fail safely rather than silently deleting access. Sessions survive a frontend rollback because they are server-side.

After rollback, verify sign-in/session restore, create/replay, workspace-scoped reads, redirects, deep links, headers and environment isolation again.
