# Frontend Performance

Status: proposed targets and measurements, not enforced budgets · Related: [architecture](architecture.md), [data fetching](data-fetching.md), [UI](ui-and-a11y.md)

## Baseline and targets

The application now has product routes (auth, workspace, links, analytics, members) and lint/build scripts, but it does **not** yet have recorded product-route measurements, size-limit/Lighthouse CI, browser performance tests or production Web Vitals reporting. Existing build output is not evidence that the current application meets these targets.

| Metric | Proposed target |
| --- | --- |
| LCP | < 2.5 s |
| INP | < 200 ms |
| CLS | < 0.1 |
| HTML TTFB | < 800 ms |
| Home's initial JS, gzip | < 200 KB |
| Initial CSS, gzip | < 30 KB |
| Additional lazy analytics JS, gzip | < 150 KB |
| Total first-view transfer | < 500 KB |

Establish a repeatable lab baseline on a documented mobile device/throttling profile and separate cold/warm navigation runs. Field targets are p75, segmented by device and route; a single Lighthouse score is not field p75, and lab interaction checks are not a measured production INP. Record tool versions, network profile, commit and whether responses/assets were cached before comparing changes.

## Keep the initial route small

- Keep auth, home/create and the not-found view eager; load management/analytics and chart code on their route. Verify the built dependency graph: a lazy page does not help if its chart is re-exported through an eager module.
- Use system fonts, CSS transitions and only the UI/icon modules needed. Do not add an animation library or large date library for simple UTC calendar arithmetic.
- Reserve space for result cards, totals and charts; match loading layouts to avoid shifts.
- Profile before adding memoization. Daily analytics has at most 366 buckets; V1 does not need a generalized virtualization layer.
- Bound visible workspace-link rows and their metadata requests; do not fetch every link's analytics on startup. The workspace list already carries `clicks_30d`, so the home list needs no per-link analytics request.
- The sign-in and sign-up pages call `warmUp()` (`GET /api/v1/ready`) once on mount, so the API's cold start and the database wake-up overlap with typing rather than with the submit.
- On reload, the shell renders from the cached account summary (`shortly.session.v1`) and starts the workspace link request in parallel with `/auth/me`, removing one serial round trip before links appear. The cache holds no credential; a `401` clears it.
- Add preconnect only if a measured API-origin handshake is on the critical path; no blanket hints for preview or unrelated origins. In production the API is same-origin behind the rewrite, so no cross-origin preconnect is needed.

## Cache efficiency must preserve authorization

TanStack Query is not used yet; the target is to deduplicate by key, with metadata stale for 30 s, analytics for 60 s and five-minute inactive garbage collection. Those are reuse targets, not server-freshness guarantees. The detailed request policy lives in [data fetching](data-fetching.md).

Correctness comes first:

- Public metadata, workspace-scoped link data and legacy-token data use distinct keys. Workspace keys include the workspace ID; legacy keys include code and a non-secret credential generation; analytics also includes the validated UTC range/interval. Tokens or token hashes must never be key material.
- On sign-out, session expiry, workspace switch or legacy-token replacement/rejection/forget, cancel/remove private queries and clear their displayed/retained results. Ignore late responses from old scopes, including stale 401s that must not reject a newer credential. Apply the same behavior across tabs for legacy tokens.
- Never persist Query data or token-bearing mutation results. Browser localStorage is limited to the active workspace ID, the token-free account summary and explicit legacy-token remembrance; memory is the default.
- Retain last successful analytics while a same-scope refresh/range request is pending, labeled with its real range and an updating/error state. Do not reuse it across codes, workspaces or credentials, or after authoritative access/state rejection.
- Do not prefetch analytics without an authorized scope or let a fresh old cache entry hide a rejected replacement credential. Test that supplying a session to metadata actually scopes the read to the requested workspace.

Use one analytics request per range, not per day. Disable focus refetch; poll at most once per 60 seconds only on a visible, mounted analytics view with a usable credential. Stop polling on sign-out, workspace switch, forget/rejection, hidden tabs or unmount. Manual refresh remains available.

Default mutation retries are zero. Only the explicit create sequence may retry once for network failure, timeout or 503 with the same UUIDv4 key and body; request-in-progress is manual. PATCH, DELETE and caller cancellation never automatically retry. Measure duplicate requests as correctness failures, not merely excess traffic.

## Perceived performance and truthful data

Create waits for the server-generated result. Disable duplicate submits, preserve the draft/attempt on transport failure, and keep any one-time legacy token backup usable before navigation. Copy is local and should not trigger a request. Workspace creates return no token, so the result can be dismissed without a credential-backup step.

Show loading before the first analytics response, then processed totals/zero-filled series without fabricating values. Keep successful old results during permitted refetches rather than blanking the screen. A failed refetch shows a warning alongside explicitly stale data.

Rollups cover the requested UTC `[from,to)`; V1 breakdowns cover only available raw events from the last 90 UTC days, including today. Show the returned breakdown range and truncation. `last_processed_at` is a nullable retained-event ingestion timestamp, not a fetch timestamp or pipeline-health proof; the nullable watermark `data_through` is null in V1. The `freshness` object reports queue lag, pending count/age, dead-letter depth and Redis availability. Measure fetch duration separately from backend processing-lag metrics; never promise one-minute delivery or infer complete ingestion from zeros. See [backend analytics](../backend/analytics.md).

## HTTP delivery targets

| Content | Required/target behavior |
| --- | --- |
| Fingerprinted static assets | Long-lived immutable caching; verify actual deployed headers |
| HTML, including SPA fallback | Revalidate (`no-cache`), not immutable |
| Every API success/error response | `Cache-Control: no-store`; browser request also uses `cache: "no-store"` |
| Redirects on backend short domain | `no-store`, outside the SPA delivery path |

Bounded in-memory Query caching does not change the HTTP policy. No service worker or offline mutation queue in V1. Do not assume compression, rewrite precedence or asset headers from hosting defaults; inspect the deployed responses, including missing asset paths. See [deployment](deployment.md).

## Proposed measurement workflow

From the repository root, using dependencies already installed from the lockfile:

```bash
bun run --cwd "./urlshortner" build
bun run --cwd "./urlshortner" preview --host 127.0.0.1
```

These existing scripts can exercise the built app; no product baseline or successful build is asserted here. The [deployment guide](deployment.md) contains frozen-install and verification prerequisites.

1. **Bundle/build:** record compressed initial and route chunks; use browser Network to confirm charts are absent on `/` and not redundantly downloaded during navigation.
2. **Interaction:** use each API response's `Server-Timing` header (Postgres, Redis and total server time; see [observability](../backend/observability.md#server-timing)) to separate server work from network and cold-start time. Trace sign-in, workspace switch, create through response, route navigation, date changes and manual refresh. Separate network wait from render work with browser/React profiling; check pending/retained states under slow and failed requests.
3. **Authorization regression:** switch workspaces, sign out, and replace/forget legacy tokens during slow metadata and analytics requests; exercise cross-tab removal. Confirm no old private data reappears, no private HTTP cache hits occur and query keys/devtools contain no token or cookie.
4. **Delivery:** compare cold/warm reloads and deep links on a controlled preview; inspect HTML, hashed assets, all API response classes and `no-store` headers.
5. **Future CI:** after tooling and repeatable baselines exist, add bundle-budget and browser regression gates. Until then document measured deltas in review rather than claiming automated enforcement.
6. **Optional field telemetry:** add only after privacy/security review, explicit origin/CSP approval and sampling. Measure Web Vitals, JS errors and sanitized route templates such as `/links/:code`; never tokens, cookies, request bodies, emails, full destination URLs or identifying route values. Do not assume a hosted insights/error SDK is already installed.

Release review should include both performance evidence and authorization tests; a faster cache that leaks another workspace's or previous credential's results is a regression.
