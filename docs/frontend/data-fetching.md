# Data Fetching and API Integration

Status: target design · Related: [Backend API](../backend/api.md) · [Frontend architecture](architecture.md)

## Contract-first flow

The backend's OpenAPI schema is the single source of truth.

```text
FastAPI /openapi.json
        │
        ▼
openapi-typescript
        │
        ▼
src/shared/api/schema.d.ts  (generated, committed)
        │
        ▼
openapi-fetch client + TanStack Query hooks
```

Local generation:

```bash
# Terminal 1: run the API
cd backend && uv run uvicorn backend.main:app --reload

# Terminal 2: generate types
cd urlshortner && bun run api:types
```

`package.json`:

```json
{
  "scripts": {
    "api:types": "openapi-typescript http://127.0.0.1:8000/openapi.json -o src/shared/api/schema.d.ts"
  }
}
```

CI can dump the schema without a running server:

```bash
cd backend
uv run python -c "import json; from backend.main import app; print(json.dumps(app.openapi()))" > openapi.json
```

Then regenerate `schema.d.ts` and fail if `git diff --exit-code` reports a change. Commit the generated file so type-checking works without the backend.

## Client setup

```ts
// src/shared/api/client.ts
import createClient from "openapi-fetch";
import type { paths } from "./schema";
import { env } from "../lib/env";

export const api = createClient<paths>({
  baseUrl: env.VITE_API_BASE_URL,
});

api.use({
  onRequest({ request }) {
    request.headers.set("X-Request-ID", crypto.randomUUID());
    return request;
  },
});
```

Rules:

- One client instance per app; do not create clients inside components.
- Components call typed query hooks, never `fetch`.
- The management token is passed per request, not stored on the client instance.
- Request IDs are generated client-side and echoed by the API for support.

## TanStack Query configuration

```ts
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: false,
      retry: (failureCount, error) =>
        failureCount < 2 && isRetryableQueryError(error),
    },
    mutations: {
      retry: 0,
    },
  },
});
```

- **Server state** is cached by Query and shared across routes.
- **URL state** (selected date range) lives in router search params.
- **Form state** lives in React Hook Form.
- **Local persistence** stores anonymous ownership only.

## Query keys

```ts
export const queryKeys = {
  link: (code: string) => ["link", code] as const,
  analytics: (code: string, from: string, to: string) =>
    ["analytics", code, from, to] as const,
  managedLinks: () => ["managed-links"] as const,
};
```

Keys are serializable and hierarchical. Invalidate `["link", code]` after an update; invalidate `["analytics", code]` after a mutation that affects data.

## Query hooks

| Hook | Endpoint | Cache behavior |
| --- | --- | --- |
| `useLink(code)` | `GET /api/v1/links/{code}` | `staleTime` 30 s; disabled for empty code |
| `useCreateLink()` | `POST /api/v1/links` | Mutation; stores token locally; no cache prefill |
| `useUpdateLink(code)` | `PATCH /api/v1/links/{code}` | Invalidates link + analytics |
| `useDeleteLink(code)` | `DELETE /api/v1/links/{code}` | Invalidates link; removes local token |
| `useLinkAnalytics(code, range)` | `GET /api/v1/links/{code}/analytics` | `staleTime` 60 s; optional 60 s polling while visible |
| `useRecentLinks()` | local storage + `useLink` per code | Fetches metadata for saved codes |

Example:

```ts
export function useLink(code: string) {
  return useQuery({
    queryKey: queryKeys.link(code),
    queryFn: async ({ signal }) => {
      const { data, error, response } = await api.GET("/api/v1/links/{code}", {
        params: { path: { code } },
        signal,
      });
      if (error) throw toApiProblem(error, response);
      return data;
    },
    enabled: code.length > 0,
  });
}
```

## Create flow

1. Validate the form with Zod.
2. Generate one `Idempotency-Key` per submission attempt sequence.
3. Send the create request.
4. Store `{ code, token, shortUrl, longUrl, createdAt }` in local storage.
5. Show the result card with copy and manage actions.
6. Do not refetch the public metadata immediately; use the create response.

```ts
const mutation = useMutation({
  mutationFn: async (input: CreateLinkInput) => {
    const { data, error, response } = await api.POST("/api/v1/links", {
      body: input,
      headers: { "Idempotency-Key": input.idempotencyKey },
    });
    if (error) throw toApiProblem(error, response);
    return data;
  },
});
```

The idempotency key is regenerated only when the user starts a new submission, not when the client retries a failed request.

## Retry policy

| Operation | Retry | Conditions |
| --- | --- | --- |
| GET metadata | 2× | Network error or 5xx; not 4xx |
| GET analytics | 2× | Network error or 5xx |
| POST create | 1× | Network error only, same idempotency key |
| PATCH/DELETE | 1× | Network error or 5xx, only if the server returned no response |
| Any 401/403/404/410/422/429 | 0 | Show the appropriate state |

Backoff: 500 ms, then 1.5 s with jitter. Respect `Retry-After` for `429`.

## Error normalization

The API returns RFC 9457 Problem Details. Convert every failure into:

```ts
export type ApiProblem = {
  status: number;
  code: string;
  title: string;
  detail: string;
  requestId?: string;
  retryAfter?: number;
};
```

Mapping:

| Status | UI behavior |
| --- | --- |
| `400` / `422` | Field or form error with a specific message |
| `401` | Prompt for a management token |
| `404` | "Link not found or deleted" |
| `409` | "That alias is already taken" |
| `410` | "This link has expired" |
| `429` | "Too many requests"; show retry time |
| `503` | "Temporarily unavailable"; retry action |
| Network/timeout | Offline banner; preserve form state |

Every error surface includes the `request_id` in a collapsible details area for support.

## Management tokens and local storage

Anonymous ownership is stored locally:

```ts
type ManagedLink = {
  code: string;
  token: string;
  shortUrl: string;
  longUrl: string;
  createdAt: string;
};

const STORAGE_KEY = "urlshortner:managed-links:v1";
```

Rules:

- Store only links created on this browser.
- Never put the token in the URL or analytics.
- Provide "Forget this link" and "Clear all" actions.
- If the token is missing, the analytics route shows a paste-token form.
- If the token is rejected, allow the user to replace it.
- Local storage is not a security boundary; strict CSP and XSS prevention are mandatory.
- Future accounts replace this mechanism; do not build cross-device sync on it.

Use `useSyncExternalStore` or a small context-backed store so multiple components and browser tabs stay consistent via the `storage` event.

## Analytics fetching

- Default range: last 30 days.
- Range lives in search params: `/links/:code?from=2026-09-23&to=2026-10-23`.
- `staleTime`: 60 s.
- Poll every 60 s only while the analytics tab is visible (`refetchIntervalInBackground: false`).
- Provide a manual refresh button.
- Show "analytics can take up to a minute to appear" for fresh links.
- Lazy-load the chart library with the analytics route.

## Offline and degraded behavior

- Detect offline with `navigator.onLine`; show a non-blocking banner.
- Do not queue create requests for later replay in v1; the user may be confused by a delayed link.
- Preserve form values and idempotency key while offline so a manual retry is safe.
- If the API is down, show a retry state rather than a blank page.
- Recent links remain visible from local storage, but metadata may be stale.

## Security notes

- `VITE_API_BASE_URL` is public; never place secrets in Vite env vars.
- Sanitize URLs before rendering as text; React escapes strings, but never use `innerHTML`.
- Use `noopener noreferrer` on outbound links.
- Do not log tokens or full destination URLs to console, Sentry, or analytics.
- Query cache is in memory; tokens are not placed in query keys.

## Test plan

- Unit: `toApiProblem`, retry classification, storage migrations.
- Component: create success, alias conflict, rate limit, expired link, missing token.
- Contract: generated types compile against the current OpenAPI schema.
- E2E: create → copy → follow redirect → open analytics with token.
- Network: MSW scenarios for 409, 429, 500, timeout, and offline.
