# Data Fetching and API Integration

Status: target design; Query, generated types and API hooks are not present in the scaffold · Related: [API contract](../backend/api.md), [analytics](../backend/analytics.md), [architecture](architecture.md)

## Transport and generated contracts

Generate request/response types from the backend OpenAPI schema after the V1 endpoints and schema are implemented. Plan an `api:types` script with a pinned local generator; commit its output and fail a future CI check on regeneration drift. Do not generate against a health-only scaffold and mistake that for the product contract. Root-relative verification commands and prerequisites are in [deployment](deployment.md).

Use one typed transport with per-request headers; components call feature hooks. Set `cache: "no-store"` and `credentials: "omit"`. **All API responses**, success or failure, require `Cache-Control: no-store`. There is no service worker or persistent Query cache in V1. Give each transport attempt an `X-Request-ID`; use the response's request ID for support. Never log bodies, token headers, idempotency keys or destination URLs. The create key can replay a token and must itself be treated as a secret.

Pass `X-Management-Token` only when the caller supplies a credential. Do not mutate a shared default token header or silently fall back to an unauthenticated request after 401.

## Errors that callers can implement

The following are local normalized error types, not replacements for generated endpoint types:

```ts
export type ValidationIssue = {
  field: string;
  code: string;
  message: string;
};

export type ApiProblem = {
  kind: "http";
  status: number;
  code: string;
  title: string;
  detail: string;
  type?: string;
  instance?: string;
  requestId?: string;
  retryAfterSeconds?: number;
  errors: readonly ValidationIssue[];
};

export type RequestFailure =
  | ApiProblem
  | {
      kind: "network" | "timeout" | "cancelled" | "protocol";
      message: string;
      requestId?: string;
    };
```

Normalize RFC 9457 bodies from `unknown`: validate property types; take HTTP status from the response; map `request_id`/`X-Request-ID` to `requestId`; default absent `errors` to `[]`. Validation's `errors[]` contains `field`, `code`, `message`; map recognized fields to form inputs and retain other issues in the form summary. Parse a valid `Retry-After` into nonnegative seconds (the API emits seconds; tolerate an HTTP date). Do not show raw HTML, stack traces or unvalidated exception text if an upstream response is malformed. An HTTP failure with an unreadable body still has its HTTP status; an invalid successful payload is a `protocol` failure, not a retriable network error. Handle 204 without trying to parse JSON.

| Status/code | UI action |
| --- | --- |
| 400 / 422 | Field errors from `errors[]`, otherwise form-level message |
| 401 `invalid_token` | Retire the matching credential generation and prompt for a saved token |
| 404 `link_not_found` | Unavailable/deleted/blocked view; do not claim which hidden state applies |
| 409 `alias_taken` | Alias field conflict; changing the body starts a new create key |
| 409 `idempotency_conflict` | Stop; do not silently mint a new key for an uncertain request |
| 409 `request_in_progress` | Offer manual retry of the same pending key/body |
| Other 409 | Show its safe problem detail; never assume every conflict is an alias collision |
| 410 `link_expired` | Public link expired; token entry may unlock owner metadata/analytics |
| 429 `rate_limited` | No automatic retry; show when a manual retry is allowed |
| 503 | Temporary failure; only the operation-specific retry policy applies |
| Network / timeout | Preserve input; outcome of a mutation may be unknown |
| Cancelled | No automatic retry or failure toast; cancellation does not undo a server write |

Request IDs belong in an optional support disclosure, not in the primary error copy.

## Cancellation, timeouts and retry policy

For **each attempt**, compose the caller's cancellation signal (including TanStack Query's signal) with a fresh timeout signal, normally 10 seconds. `AbortSignal.any([callerSignal, AbortSignal.timeout(10_000)])` is suitable only after confirming target-browser support. Otherwise create a controller, forward caller aborts (including an already-aborted signal), and use a timer to abort it with a timeout reason. Clear the timer and remove listeners in `finally` after both fetch and body processing finish.

Keep the original caller signal and timeout reason so cancellation is not misclassified as a timeout. Check caller cancellation before starting any retry or while waiting for backoff. Use a fresh timeout for the next attempt, not the already-aborted combined signal. For Query, preserve cancellation semantics rather than converting it to a generic network exception. Mutations need their own caller-owned controller; resetting a mutation observer alone does not cancel fetch. Late results must also pass the credential/attempt-generation check before touching state.

| Operation | Automatic retries | Eligibility |
| --- | --- | --- |
| GET metadata/analytics | At most 2 | Network/timeout or HTTP 500/502/503/504; no 4xx, protocol errors or cancellations |
| Default mutation | 0 | Query mutation configuration is always `retry: 0` |
| POST create | At most 1 in an explicit create-only sequence | Network failure, timeout or 503; identical key and serialized body |
| PATCH / DELETE | 0 | User decides whether to retry after reconciling an uncertain result |
| 409 `request_in_progress` | 0 | Manual retry, same create key/body |

Use bounded backoff (500 ms then 1.5 s with jitter for GET); respect a returned `Retry-After` before an eligible retry. If waiting is impractical, show a manual action instead. The create sequence uses only its first backoff and must not also enable library retries. Do not queue offline mutations or retry on reconnect. Aborted/cancelled operations never automatically retry.

## Create: one request identity, one recoverable response

`POST /api/v1/links` **requires a UUIDv4 `Idempotency-Key`**. The key is a header, not a JSON field. After validation, snapshot the body and key once; this standalone example demonstrates that separation (production body types should be generated):

```ts
export type CreateLinkBody = Readonly<{
  long_url: string;
  custom_alias?: string | null;
  expires_at?: string | null;
}>;

export type CreateAttempt = Readonly<{
  idempotencyKey: string;
  bodyJson: string;
}>;

export function newCreateAttempt(body: CreateLinkBody): CreateAttempt {
  return Object.freeze({
    idempotencyKey: crypto.randomUUID(), // UUIDv4; requires a secure context
    bodyJson: JSON.stringify(body),
  });
}

export function createRequestInit(
  attempt: CreateAttempt,
  signal: AbortSignal,
): RequestInit {
  return {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": attempt.idempotencyKey,
      "X-Request-ID": crypto.randomUUID(),
    },
    body: attempt.bodyJson,
    cache: "no-store",
    credentials: "omit",
    signal,
  };
}
```

Only call `newCreateAttempt` for a new logical submission. The explicit retry sequence calls `createRequestInit` again with the existing attempt and a newly composed signal. Disable duplicate submits; keep an unresolved attempt in memory for manual recovery. Changed body means a new key, with a warning that the earlier request may already have created a link. Do not silently re-key on timeout, 409 or a lost response.

The backend commits the link and an **encrypted replay response atomically in Postgres**. Same key/body replays the original creation response, including the **same management token**, for 24 hours. This does not depend on a Redis-only deduplication record. A same-key/different-body conflict must stop the sequence. After the replay window, do not promise a safe replay; explain the uncertainty before starting a new submission. See [short links](../backend/short-links.md).

On success, transfer the token directly into credential memory and the one-time backup UI. Seed only token-free metadata if useful, not the full create response in Query. A replay describes the original creation, not current state: revalidate authenticated metadata before treating a recovered result as active or manageable. Reset/scrub the token-bearing mutation result after transfer/dismissal; generic mutation history, devtools capture and persistence must not retain it. The backup UI offers reveal/copy before dismissal, explicit optional device storage, and the lost-copy warning. No later metadata endpoint returns the token.

## Query keys and credential transitions

Use separate public and credential-scoped metadata keys. A fresh random generation ID is non-secret and unrelated to the token; do not derive it from a token hash.

```ts
export const queryKeys = {
  publicLink: (code: string) => ["link", code, "public"] as const,
  privateLink: (code: string, generation: string) =>
    ["link", code, "credential", generation] as const,
  analytics: (code: string, generation: string, from: string, to: string) =>
    ["analytics", code, generation, from, to, "day"] as const,
};
```

Initial targets: metadata `staleTime` 30 s, analytics 60 s, inactive cache `gcTime` 5 minutes; disable focus refetch. Analytics is disabled without a token. Poll no faster than 60 s and only while the analytics view is mounted, the document is visible, and the credential remains usable. Provide manual refresh. Neither polling nor freshness settings guarantee pipeline completion.

On token **replace, reject or forget**:

1. Retire the current generation, disable its queries and clear rendered private data/retained results.
2. Cancel and remove its analytics **and token-bearing metadata** caches; cancel associated pending management requests and scrub mutation state. Cancellation cannot reverse a committed write.
3. Update credential memory/storage as requested; allocate a new generation before fetching with a replacement token. An error/response from an old generation cannot reject or populate the new one.

Apply the same cleanup on cross-tab forget, clear or replacement. Never reuse private cache data as public metadata. Never persist Query data or include tokens in keys, URLs or logs.

## Device storage and endpoint states

Memory is the default. Store a versioned, validated, minimal `{code, token}` record in localStorage only after explicit “Remember on this device” consent. A local recent-code list is not proof of authorization. Wrap **reads and writes** in error handling: denied storage or quota failure leaves the session usable in memory and reports that remembering failed. Ignore malformed JSON/invalid records without crashing; never print their contents. On load, validate records before using them and give loaded credentials fresh generations.

Listen for `storage` events, including removal and `clear()` (`key === null`), and update same-tab subscribers directly because those events fire in other tabs. Reconcile against current storage rather than trusting an old event; forget must not be undone by a stale tab writing its full snapshot back. If removing storage fails, clear memory/private caches anyway and warn that the saved device copy might remain. “Forget” is not server deletion or token revocation.

| Request | Visibility/auth behavior |
| --- | --- |
| Metadata without token | Active, unexpired metadata only; expired 410, inactive/unknown/deleted/blocked 404 |
| Metadata with token | Validate supplied token; invalid 401, not public fallback. Valid token allows expired/inactive metadata; deleted/blocked 404 |
| Analytics | Token required; valid token allows expired/inactive data; deleted/blocked 404 |
| PATCH | Token required; wait for server confirmation, then invalidate public/private metadata and relevant analytics |
| DELETE | Token required; success and repeated deletion with a valid token return 204. On confirmed success remove local credential and all cached views for that link |

For uncertain PATCH, re-read token-scoped metadata before deciding on a manual repeat. For uncertain DELETE, offer a deliberate same-token repeat; its idempotent 204 contract is not permission for automatic retries. Retain the credential until the outcome is resolved.

## Analytics ranges, data and freshness

- Accept real calendar dates `YYYY-MM-DD`, interpreted in **UTC**, with inclusive `from`, exclusive `to`, `from < to`, maximum **366 days**, `interval=day`. Reject impossible dates rather than relying on JavaScript date rollover. `to` cannot exceed tomorrow UTC; the server also rejects ranges outside two-year rollup retention.
- Default `to` is tomorrow at 00:00 UTC and `from` is 30 UTC calendar days before it. On 2026-10-23 UTC, the default is `[2026-09-24, 2026-10-24)`. Last-7/30-day presets use the same rule and include today. Date-only values are not local-midnight timestamps.
- Keep the validated range in search params. If a picker presents an inclusive last day, add one UTC day for `to` and subtract one for display; validate the resulting span.
- `totals` and the zero-filled daily `series` come from rollups for the whole requested range; totals equal the series sum. Use one range request, not per-day requests, and never add raw-event breakdown counts to rollup totals.
- V1 also returns `breakdowns: {from, to, truncated, top_referers, top_countries, devices}`. The effective range intersects the requested range with the last 90 UTC days, including today; display its boundaries and truncation, not the full rollup range. No overlap means nullable `from`/`to` are null and arrays are empty, not that older rollup totals disappear. Entries are `{value, clicks}`: referrers are **origins**, top referrers and countries are limited to 10, and devices list observed categories. `value: null` means unknown/unavailable, not proven direct traffic. Breakdowns include bot and non-bot events; top lists need not sum to totals.
- `last_processed_at` is the nullable latest ingestion timestamp among this link's retained raw events. `data_through` is a nullable pipeline watermark, **null in V1** because best-effort capture cannot certify complete coverage. Neither is the last successful browser fetch, and a processing timestamp does not prove queue health. Show “Freshness not yet available” when appropriate; never claim “real time” or “within one minute.” A successful fetch or zero-filled series does not prove all clicks were processed. V1 collects no IP hashes or unique visitors.
- During refetch/range changes, retain the last successful results **only for the same code and credential generation**, clearly labeled with their old range and an updating/error state. Do not relabel old values as the newly selected range. Clear them immediately on credential changes or authoritative access/state rejection.

## Test acceptance

Plan tests for error-shape validation; each 409 code; retry counts and identical create bodies/keys; timeout versus caller abort; late responses after credential replacement; private metadata isolation; denied/quota/corrupt storage and cross-tab forget; repeated DELETE; leap days, UTC rollover and 366-day bounds; zero-filled series, clipped breakdowns and nullable freshness. Mock tests supplement, not replace, an end-to-end preview test of the [backend contract](../backend/api.md).
