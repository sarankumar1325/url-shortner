# Frontend Architecture

Status: target design, not implemented · Related: [API contract](../backend/api.md), [data fetching](data-fetching.md), [deployment](deployment.md)

## Current scaffold versus target

The application lives in `urlshortner/`. It currently declares React 19, Vite 8, TypeScript 6 and oxlint, with `dev`, `build`, `lint` and `preview` scripts and a `bun.lock`. `src/App.tsx` and the CSS are starter UI; there is no product router or API integration yet.

The following are **planned**, not installed/configured guarantees:

| Concern | Target |
| --- | --- |
| Reproducibility | Pin a tested Bun version via `packageManager`; use frozen installs |
| Type safety | Enable strict TypeScript; generate and check API types from OpenAPI |
| Navigation | React Router, with lazy analytics route |
| Server state | TanStack Query, memory-only cache |
| Forms | React Hook Form and Zod, with server validation authoritative |
| UI | Tailwind v4 and selected shadcn/ui primitives; system fonts |
| Analytics | Lazy chart dependency plus accessible tables |
| Verification | Vitest, Testing Library/MSW, Playwright/axe and measured bundle budgets |

Do not describe those checks as running in CI until scripts and workflows exist. In particular, `tsconfig.app.json` does not currently enable `strict`, and there are no test or API-generation scripts. Add tools only alongside the feature that needs them; no speculative store or repository layer is needed.

## Product boundary

V1 is an anonymous static SPA:

- **Create:** destination URL, optional alias and expiry; show the returned short link and one-time management-token backup.
- **Manage:** edit, deactivate or delete one link using its token; optionally remember that token on this device.
- **Understand:** totals, daily clicks, top referrer origins/countries and device categories. Breakdowns are V1, not future work.

No accounts, team dashboard, server-rendered pages, token recovery service or unique-visitor tracking. Public redirects run on the backend short domain, outside this app. See [backend architecture](../backend/architecture.md) and [analytics](../backend/analytics.md).

## Routes and ownership

| Route | Content | Loading |
| --- | --- | --- |
| `/` | Create, result and local recent links | Eager |
| `/links/:code` | Metadata, token entry, analytics and management | Lazy |
| Unmatched path | Not-found view with navigation home | Eager |

A static SPA fallback normally serves `index.html` with **HTTP 200**, including unknown client routes. A not-found component is not a transport-level 404. Backend metadata/redirect errors retain their actual HTTP statuses; a true document 404 would require different hosting behavior.

Only code and validated UTC date-only `from`/`to` values belong in route/search state. Never put tokens in URLs. A shared analytics URL shares the selection, not authorization.

Keep responsibilities small as features land:

- App shell: router, stable QueryClient, error boundaries and status announcements.
- Feature UI/hooks: create, local recent links, metadata/management and analytics.
- Shared API code: generated types, transport, normalized errors and query keys.
- Credential state: token in memory, optional device storage, generation changes and cache cleanup.

UI state stays local; Query owns server snapshots; forms own drafts; the router owns navigation. Browser storage is neither an account nor authoritative metadata. No Redux/Zustand is needed for this scope.

## Credential and cache boundary

The default token lifetime is the current page session in memory. “Remember on this device” is an explicit opt-in to localStorage, with a warning that same-origin scripts can read it. Creation must offer reveal/copy before dismissing its result, and explain that a lost copy cannot be recovered by the server. The 24-hour idempotent replay is transport recovery, not a token-retrieval endpoint.

Every private query uses a **non-secret credential-generation identifier** in its key, including metadata requests that carry a token. Tokens and token hashes are not query-key material. Public metadata and token-bearing metadata use separate keys.

On replacement, rejection or forgetting a token: disable the old credential, cancel its requests, remove its private caches and visible results, and create a fresh generation before new requests. Ignore late responses/errors from older generations. Retained analytics results must never cross that boundary. Handle cross-tab forget/replace and storage denial, quota failures and corrupt records; details are in [data fetching](data-fetching.md).

Do not persist Query caches, token-bearing mutation results, or pending requests. Do not send tokens to URLs, logs, telemetry or generic error capture. Pass the token per request in `X-Management-Token`, not as a shared client's mutable default header.

## API invariants

- All API responses, including errors and public metadata, use `Cache-Control: no-store`. The frontend also requests `cache: "no-store"`; bounded in-memory Query reuse is separate from HTTP caching.
- Public metadata is for active, unexpired links. Supplying a token always requests validation: an invalid token returns 401, not a public fallback. Valid tokens allow expired/inactive metadata; deleted/blocked links return 404. Analytics requires a token and has the same state rules.
- Create requires a UUIDv4 `Idempotency-Key` header separate from the JSON body. The backend atomically commits the link and encrypted replay response in Postgres; the same key/body replays the original response, including its token, for 24 hours.
- All mutation defaults have zero retries. Only the explicit create request sequence permits one retry for network failure, timeout or 503, using the identical key/body. `409 request_in_progress` is a manual same-key retry; cancellations and PATCH/DELETE have no automatic retries. Repeated DELETE with a valid token returns 204.
- Analytics uses UTC date-only `[from,to)`, with default `to` tomorrow UTC and `from` 30 days earlier, including today; maximum 366 days. Freshness is described using server timestamps/watermarks, never a one-minute guarantee.

Exact errors, retry behavior and analytics fields are centralized in [data fetching](data-fetching.md), not duplicated in component-specific clients.

## Delivery and verification

Build a static bundle for the separate Vercel frontend project. `VITE_*` values are public build-time configuration. Deployment remains unverified until the entrypoint, deep links, response headers, exact-origin CORS/CSP and backend integration pass the [deployment gates](deployment.md).

Implement in feature-sized steps: shell and tooling; typed create/token backup; credential-scoped metadata and management; rich analytics; then accessibility, security and measured performance gates. Use [UI requirements](ui-and-a11y.md) and [performance targets](performance.md) as acceptance criteria, not claims about the starter.

Required tests cover create replay/cancellation, code-specific conflicts, token changes and late responses, localStorage/cross-tab failures, expired/inactive/deleted states, UTC ranges and delayed analytics. Browser checks must include keyboard/screen-reader flows and a real preview API, not only mocked happy paths.
