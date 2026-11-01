# Frontend Architecture

Status: accounts, workspaces, RBAC, settings and link management implemented and deployed to a free `.vercel.app` host; smoke-tested, not load-tested · Related: [API contract](../backend/api.md), [data fetching](data-fetching.md), [deployment](deployment.md)

## Current implementation versus target

The application lives in `urlshortner/`: React 19, Vite 8, strict TypeScript 6, React Router 7, Tailwind v4, lucide-react, oxlint and `bun test`. It calls the real API through `src/api.ts`; session and workspace selection live in `src/auth.tsx`; link records and pure display helpers live in `src/links.ts`. The app shell and product routes are in `src/App.tsx`; `AuthPage` and `InvitePage` are static modules, while `MembersPage`, `SettingsPage` and analytics load as route chunks.

Remaining gaps relative to the target:

| Concern | Current state |
| --- | --- |
| Reproducibility | No `packageManager` pin or frozen-install CI yet |
| Type safety | API types are hand-written in `src/api.ts`, not generated from OpenAPI |
| Server state | TanStack Query is not used; workspace data is fetched imperatively and held in React |
| Forms | React Hook Form/Zod are not used; local validation mirrors server rules |
| UI | shadcn/ui is not used; Tailwind v4 plus project CSS |
| Verification | One Playwright journey in `e2e/` (see [deployment](deployment.md#end-to-end-tests)); no Testing Library/MSW/axe or measured bundle budgets yet |

`bun test` covers transport, validation, storage-independent series mapping and API error mapping with mocked `fetch`. Those tests supplement, but do not replace, the browser and hosted checks described below.

## Product boundary

V1 is an authenticated multi-tenant SPA:

- **Account:** email/password sign-up and sign-in with "Stay signed in", a personal workspace created automatically, sign-out, and self-service account deletion from Settings. There is no forgot-password flow.
- **Workspaces:** switch between personal and shared workspaces from the command palette (⌘K/Ctrl+K); owners/admins create shared workspaces, invite people and manage roles.
- **Links:** create with destination, optional alias, expiry, UTM fields and password; list workspace links with 30-day click counts; edit, pause/resume or delete with `member` or above, one at a time or in bulk; CSV import and export; smart redirect rules on the detail page.
- **Understand:** totals, daily clicks, top referrer origins/countries and device categories. Breakdowns are V1, not future work.
- **Legacy:** links created before accounts (or by unauthenticated API clients) still accept a management token on the detail page.

There are no server-rendered pages, password reset/email verification flows, token recovery service or unique-visitor tracking. Public redirects run on the backend short domain, outside this app. See [backend architecture](../backend/architecture.md) and [analytics](../backend/analytics.md).

## Routes and ownership

| Route | Content | Access |
| --- | --- | --- |
| `/login` | Email/password sign-in, optional `next` return path | Anonymous; authenticated users are sent into the app |
| `/signup` | Account creation with display name and password | Anonymous |
| `/invite/:token` | Invitation preview and join, or sign-in/sign-up links | Public preview; joining requires a session |
| `/` | Workspace shell: create form and link list; workspaces are switched from the command palette | Authenticated |
| `/links` | Full link list | Authenticated |
| `/links/:code` | Metadata, analytics and management; legacy token entry when needed | Authenticated or legacy token |
| `/members` | Members, roles and pending invitations | Authenticated; admin actions hidden by role |
| `/settings` | Account identity, password, active sessions, workspace rename/transfer/delete, delete account | Authenticated; owner/admin controls hidden by role |
| Unmatched path | Not-found view with navigation home | Public |

`ProtectedWorkspace` gates the product routes: while the session is loading it shows a checking state, and an anonymous user is redirected to `/login?next=…`. A static SPA fallback normally serves `index.html` with **HTTP 200**, including unknown client routes; the not-found component is not a transport-level 404.

Only the link code and validated UTC date-only `from`/`to` values may appear in route/search state. Never put session tokens, legacy management tokens or invitation tokens anywhere except the invitation route, which receives a one-time capability by design. A shared analytics URL shares the selection, not authorization.

## Session and workspace state

- The session is an `HttpOnly` cookie. JavaScript never reads, stores or logs it; every request uses `credentials: 'include'` against the same-origin `/api` base.
- `AuthProvider` calls `GET /api/v1/auth/me` on load, then exposes `status` (`loading`/`authenticated`/`anonymous`), `session`, `verified`, the active workspace and its role.
- `src/sessionCache.ts` stores the last account summary (user and workspace list, never a token) in `localStorage` under `shortly.session.v1`. On startup the shell renders from it with `verified: false`, and the workspace links load in parallel with `/auth/me` instead of after it. When `/auth/me` answers, the summary is replaced and `verified` becomes true; a `401` clears the cache and sends the user to sign-in; a network or server failure keeps the cached shell rather than signing out. The sign-in page only redirects into the app once the session is verified.
- `auth.forget(notice)` clears local session state and the cache without a server call and shows the notice once on the sign-in page; account deletion uses it.
- The active workspace is sent as `X-Workspace-Id`. Its ID is remembered in `localStorage` under `shortly.workspace.v1`; it is non-secret UI preference, not authorization. If the remembered workspace is no longer accessible, selection falls back to the personal workspace.
- Sign-in/sign-up applies the returned session and selects a workspace. Sign-out clears server and client state, including the cached summary; the protected tree unmounts, so link and analytics state cannot survive into the next account.
- A `401` from any workspace request refreshes the session once; a failed refresh returns the user to sign-in. A `404 workspace_not_found` means the workspace is gone or no longer a membership and must not be retried as a transient error.
- Invitation acceptance calls `auth.addWorkspace`, making the joined workspace active immediately.
- Ownership transfer updates the local membership role to `admin`; workspace deletion calls `auth.removeWorkspace`, which selects a fallback workspace and clears the remembered ID.
- `/settings` is keyed by workspace ID, so switching workspaces remounts its forms and session state instead of leaking a draft across tenants.

UI state stays local; forms own drafts; the router owns navigation. Browser storage is neither an account nor authoritative metadata. No Redux/Zustand is needed for this scope.

## RBAC in the UI

The API is authoritative; the UI hides or disables controls it knows will fail.

| Role | Visible and enabled |
| --- | --- |
| `viewer` | Read links, open analytics, view the member list; create form, edit, pause/resume and delete disabled |
| `member` | All link actions; no invitation or role controls |
| `admin` | Link actions plus invite/revoke, role changes and member removal for non-admin targets; rename the workspace |
| `owner` | All admin actions, including managing admins and deleting/transferring a non-personal workspace; cannot leave or be removed |

`MembersPage` derives `manageable(target)` from the active role and hides role selects and remove buttons otherwise. Self-service “Leave” is shown for a non-owner’s own row. The owner row has an immutable badge. A `403` from the API is surfaced as an error rather than silently retried; role changes refresh the local row only after success.

`SettingsPage` always shows account identity, password change, active sessions and a Delete account danger section. Workspace rename appears for `admin+`; ownership transfer and deletion appear only for the owner of a non-personal workspace, and members/viewers get an explanatory fallback instead. Password change refreshes the session list because other sessions are revoked. Deleting a workspace asks for the exact name, then removes it from local auth state and falls back to another workspace. Deleting the account asks for the password and the account email typed again; a `409 owns_shared_workspaces` lists the blocking workspaces by name, and success calls `auth.forget('Your account was deleted.')`.

## Credential and cache boundary

Account access is cookie-based and must never be mirrored into JavaScript storage. The workspace ID and the cached account summary in localStorage are safe because they grant nothing on their own; the summary does hold the email and workspace names, so it is cleared on sign-out, `401` and account deletion.

Legacy management tokens remain a separate capability:

- The token lives in component memory by default. “Remember on this device” is an explicit opt-in with a warning that same-origin scripts can read it.
- Creation offers reveal/copy before dismissing the result and explains that a lost copy cannot be recovered by the server. The 24-hour idempotent replay is transport recovery, not a token-retrieval endpoint.
- Token-bearing requests go through an explicit access object (`{ token }`); they are never a shared client's mutable default header.
- On replacement, rejection or forgetting a token, cancel its requests, remove its visible results and ignore late responses. Cross-tab replacement/forget must clear the same view.

Every workspace/credential change must invalidate private in-memory state. Do not persist session responses, token-bearing mutation results or pending requests. Do not send credentials to URLs, logs, telemetry or generic error capture.

## API invariants

- All API responses use `Cache-Control: no-store`; the client also requests `cache: "no-store"`.
- Browser mutations (`POST`, `PATCH`, `DELETE`) carry `Origin`; the API rejects disallowed origins with `403 csrf_rejected`. The frontend treats it as a configuration/session error, not something a retry fixes.
- Create requires a UUIDv4 `Idempotency-Key` header separate from the JSON body. For workspace creates, the response contains no management token; replay returns the same link for 24 hours.
- Workspace link routes require a valid session. Omitting `X-Workspace-Id` selects the personal workspace; the app always sends the active workspace ID explicitly.
- Legacy link routes use `X-Management-Token`. Providing an invalid credential returns `401`; never fall back to public or workspace metadata. Deleted/blocked links return `404`.
- All mutation defaults have zero retries. Only the explicit create request sequence permits one retry for network failure, timeout or 503 with the identical key/body. `409 request_in_progress` is a manual same-key retry; cancellations and PATCH/DELETE have no automatic retries. Repeated DELETE with the same valid scope returns `204`.
- Analytics uses UTC date-only `[from,to)`, defaulting to tomorrow UTC and 30 days earlier, maximum 366 days. Freshness comes from server timestamps; the UI must not promise a one-minute guarantee.

Exact errors, retry behavior and analytics fields are centralized in [data fetching](data-fetching.md), not duplicated in component-specific clients. `LinkAnalytics` labels the shared ingestion queue from the response's `freshness` snapshot (clear, queued with oldest age, or unavailable) instead of implying real-time completeness.

## Delivery and verification

Build a static bundle for the separate Vercel frontend project. The browser calls same-origin `/api`, which Vite proxies in development and Vercel rewrites to the backend in production, keeping the session cookie first-party. `VITE_API_BASE_URL` is normally blank; if set, it must be an exact public API origin and the browser then needs credentialed CORS rather than the rewrite.

The deployed host is `https://shortlyyy-web.vercel.app`, wired to `https://shortlyyy-api.vercel.app`. Hosted checks covered sign-up/sign-in, workspace creation, invitations, all four roles, link create/redirect/analytics/pause/delete, SPA deep links and the settings flows (password/session revoke, rename, transfer, delete with fallback). `bun test` currently has 213 passing tests, including request-contract coverage for the lifecycle endpoints and ingestion-freshness labels. The Playwright journey (`bun run e2e`) covers signup, paste-to-shorten, create and copy, the `c` shortcut, `Server-Timing`, sign-out/sign-in, "Stay signed in" across a simulated browser restart and account deletion. Response-header, accessibility, load and rollback gates remain open.

Implement in feature-sized steps: shell and session bootstrap; auth pages and protected routes; workspace switch and link CRUD; members/invitations; rich analytics; then accessibility, security and measured performance gates. Use [UI requirements](ui-and-a11y.md) and [performance targets](performance.md) as acceptance criteria, not claims about the current implementation.

Required tests cover create replay/cancellation, code conflicts, session expiry and workspace changes, role-based control visibility, invitation errors, cross-tab/legacy-token state, expired/inactive/deleted links, UTC ranges and delayed analytics. Browser checks must include keyboard/screen-reader flows and a real preview API, not only mocked happy paths. The E2E journey runs against a real API but is one serial happy path, not a substitute for those checks.
