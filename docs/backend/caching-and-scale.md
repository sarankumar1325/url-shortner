# Caching, Rate Limiting, and Capacity

Status: positive cache and per-IP fixed-window limits implemented; capacity unmeasured, and several hardening targets remain · [Architecture](architecture.md) · [Analytics](analytics.md)

## Workload assumptions

Start with one region and a read-heavy workload; use 100 redirects per create as a **test scenario**, not observed demand. Establish the launch RPS and purchased service budgets from measurements before claiming production capacity.

A successful warm GET normally needs **four Redis commands** in two HTTP calls: `INCR` + `EXPIRE` for the limiter, `GET` for the cache, and `XADD` for the click event. Cache misses add an indexed Postgres read and a `SETEX` fill. At 100 redirects/s that is roughly 34.56 million baseline commands/day, before ingestion, cleanup and provider-specific billing. Drain additionally costs `XREADGROUP`, `XACK`/`XDEL`, periodic `XPENDING`/`XAUTOCLAIM`, and a status pipeline per analytics read; size plans against measured backlog growth, not only redirect volume.

## Cache-aside

```text
redir:{code} -> {"url_id": 42, "long_url": "https://…", "expires_at": null}
```

Only live, nondeleted, nonblocked links are cached, and writes happen only after a successful database read. The payload contains no tokens, users or workspace identifiers. Malformed JSON is a miss, not a redirect to an arbitrary value. `expires_at` is re-checked on every cache hit so an expired entry returns `410` even if cleanup lagged.

Do not cache missing/inactive/deleted results in v1. A read racing with creation could otherwise publish a negative entry after invalidation and hide a freshly created alias. Abuse limits and indexed lookups handle unknown-code traffic; add negative caching only with a tested invalidation protocol.

### Freshness and mutation races

Current implementation:

- TTL is the configured `REDIRECT_CACHE_SECONDS` (default **60**) measured from the fill, via `SETEX`.
- The TTL is **not** anchored to the database read start and is not capped by remaining link lifetime in the cache key. A slow read therefore adds its duration to the stale window. Worst-case staleness is bounded only approximately by TTL plus read/commit timing.
- After a create/update/delete transaction commits, the route best-effort `DEL`s the positive key. A pre-mutation reader can repopulate old state **after** that `DEL`; invalidation is not linearizable and does not provide strict read-your-writes on redirects.
- If a cached entry carries a past `expires_at`, the redirect returns `410` without a database read. If Redis is unavailable, the route reads Postgres directly.
- Authenticated metadata and analytics read the database and show committed state immediately; only public redirects may lag.
- During a database outage, existing cache hits continue until their TTL. Do not extend them or serve stale indefinitely.

Target hardening: compute an absolute `cache_deadline` from the DB read start, cap it by `expires_at`, skip fills for stale reads, and add subtractive jitter within the 60-second maximum. Measure clock skew and refill races before claiming a tight bound.

For urgent malicious-link takedowns, first apply and verify an edge deny rule for the code on **every public backend hostname**, then set `is_blocked` and invalidate. If the chosen plan cannot support this and strict revocation is required, uncached DB authorization per redirect is the safer launch alternative. Do not claim instant revocation from cache deletion alone.

## Limiter

The limiter is a fixed-window counter using `INCR` plus `EXPIRE … NX` on `rl:{scope}`. The window starts on the first request and is not aligned to wall-clock boundaries. The raw scope identity (client IP or account/workspace identifier) is part of the Redis key and is not HMAC'd; keys expire with the window.

| Scope | Implemented limit | Failure policy |
| --- | --- | --- |
| Signup | 10/hour/client IP | `503` if limiter unavailable |
| Login | 30/minute/client IP **and** 10/minute/email | `503` if limiter unavailable |
| Password change | 10/hour/user | `503` if limiter unavailable |
| Link create, authenticated | 60/minute/workspace | `503` if limiter unavailable |
| Link create, legacy anonymous | 20/minute/client IP | `503` if limiter unavailable |
| Workspace create | 10/hour/user | `503` if limiter unavailable |
| Invitation preview | 60/minute/client IP | `503` if limiter unavailable |
| Redirect GET | 600/minute/client IP | Fail open |

Implementation notes and remaining gaps:

- `check_rate_limit` raises `503 dependency_unavailable` on Redis failure unless the caller opts into `fail_open`; only redirects do. This fail-closed default is tested.
- There is no limit yet on public metadata reads, failed management attempts, analytics reads or PATCH/DELETE. Add per-code attempt budgets and a global daily creation budget before broad public launch.
- Fixed windows permit bursts across boundaries. A token bucket can replace them if measurements justify it.
- `Retry-After` is the current key TTL when available, otherwise the window length.
- Client identity currently prefers the first `X-Forwarded-For` value, then the direct peer. Treat this as **unverified until the platform trust chain is confirmed**; a spoofable header weakens per-IP limits. The target is a platform-overwritten address header (or explicit trusted-proxy parsing), never an arbitrary chain position.
- Do not log limiter keys or reuse them as analytics visitor identifiers.

Protect cron with its bearer secret, not a public-IP limiter. CORS is a browser policy, not protection from non-browser abuse.

## Timeout and overload budgets

The current code uses an HTTP client timeout of 5 seconds for Upstash and a bounded SQLAlchemy pool (`pool_size=5`, `max_overflow=2`, `pool_timeout=10`, `pool_recycle=300`). It does **not** yet apply the finer per-operation deadlines below; treat them as proposed measurements, not implemented values.

| Operation | Proposed deadline | Intended outcome |
| --- | --- | --- |
| Redis limiter | 50 ms | Policy above |
| Cache read/fill | 50 ms each | Miss/skip fill |
| Event enqueue | 50 ms | Potential event loss; still redirect |
| Runtime DB pool wait | 250 ms | `503` if no slot |
| Redirect DB query | 500 ms | `503` on miss |
| Create/manage DB work | 3 s | Controlled error; same-key create retry safe |
| Analytics query | 5 s | Controlled error |
| Drain invocation | bounded batch | Leave headroom under the function ceiling |

A timed-out enqueue might have succeeded: count it as an uncertain outcome, not proof that the event is absent. Do not automatically retry Redis on redirects.

When Redis is known unhealthy, optional fill/enqueue attempts may be skipped. Bounded per-instance backoff may reduce retry pressure but is only an optimization. Cap DB fallback concurrency and pool waiting so cache failure cannot open unlimited Postgres connections. Return `503` under overload instead of hiding it behind long queues.

No distributed single-flight lock initially: add one only after observing a miss stampede and testing its lease/recovery behavior. Avoid hot in-process caches as correctness dependencies.

## Connection management

- Runtime uses Neon's pooled endpoint; migration/administration uses a direct connection.
- The current engine uses `pool_size=5`, `max_overflow=2`, `pool_timeout=10`, `pool_pre_ping=True`, `pool_recycle=300`, asyncpg TLS and a 10-second command timeout. Validate these against measured concurrency rather than treating them as universal.
- Client connection budget is live engine instances × their pool caps, plus workers/migration headroom. Pooler client capacity is not backend transaction throughput.
- Validate pinned asyncpg prepared-statement behavior against Neon; do not apply generic PgBouncer tuning blindly. Consider `NullPool` only with bounded request concurrency and measured TLS/reconnect cost.
- No shared AsyncSession; never hold a SQL transaction across a Redis call. Transactions roll back on cancellation.
- Upstash is accessed through its REST API with a reusable `httpx.AsyncClient` and a 5-second timeout, not a TCP `redis.asyncio` pool. Verify command behavior against the selected service; REST and TCP transports are not interchangeable.
- Keep limiter/queue keys from being evicted under pressure; cap positive-cache memory or isolate it if the service policy requires.

## Scaling triggers

- Compare p95/p99 latency to [SLO targets](observability.md), including cold starts and queue waits.
- Measure hit ratio for existing-code traffic separately from scans; 95% is a diagnostic aspiration, not a guaranteed short-TTL result.
- Drain sustained throughput must exceed capture rate with catch-up headroom. Measure both under overlap and backlog.
- Size queue capacity in bytes and minutes of outage, not just entry count. Alert well before provider limits or loss.
- Measure raw-event retention size and analytics query cost; evaluate shorter retention or an analytics store before blindly sharding links.
- Do not add multi-region caches, replicas, edge redirect caching or a KGS without a measured bottleneck and an explicit consistency/analytics tradeoff.

All API responses are HTTP `no-store`; Redis server-side caching is independent. Static frontend assets use the CDN. Edge-cached redirects would bypass capture and require a new analytics contract.
