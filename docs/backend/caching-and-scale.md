# Caching, Rate Limiting, and Capacity

Status: target design, not measured capacity · [Architecture](architecture.md) · [Analytics](analytics.md)

## Workload assumptions

Start with one region and a read-heavy workload; use 100 redirects per create as a **test scenario**, not observed demand. Establish the launch RPS and purchased service budgets from measurements before claiming production capacity.

A successful warm GET normally needs **three Redis operations**: limiter script, cache GET, event XADD. Cache misses add an indexed Postgres read and cache fill. At 100 redirects/s that is roughly 25.92 million baseline Redis operations/day, before ingestion, cleanup and provider-specific Lua billing. Cloud cost scales with commands and retained events, not just link count.

## Cache-aside

```text
env:url:v1:{code} -> {id, long_url, expires_at, cache_deadline}
```

Only cache a currently active, nondeleted, nonblocked link. Cache payloads never include token hashes. Validate the payload shape/version and deadline; a malformed entry is a miss, not a redirect to an arbitrary value.

Do not cache missing/inactive/deleted results in v1. A read racing with creation could otherwise publish a negative entry after invalidation and hide a freshly created alias. Abuse limits and indexed lookups handle unknown-code traffic; add negative caching only with a tested invalidation protocol.

### Freshness and mutation races

- Hard positive cache-age maximum: **60 seconds**, with subtractive jitter (e.g. 45–60 seconds), never additive jitter beyond the maximum.
- Compute `cache_deadline` from the DB read's start, capped by `expires_at`. Set Redis absolute expiry to that deadline; do not reset its age when serving or refilling.
- If the read is too old by cache-write time, skip the fill. Keep queries short and use a fresh read transaction; expiry checks use UTC clocks with monitored skew.
- After a create/update/delete/block transaction commits, best-effort `DEL` its positive key.
- A pre-mutation reader can repopulate old state **after** that DEL. Therefore invalidation is not linearizable and does not provide strict read-your-writes on redirects. Its old deadline bounds staleness under the stated clock/transaction assumptions.
- Authenticated metadata reads the DB and shows the committed result immediately; redirect changes may lag by the remaining cache-age window.
- During a DB outage, existing cache hits last only to their deadline; do not extend them or serve stale indefinitely. This bounds resilience as well as staleness.

For urgent malicious-link takedowns, first apply and verify an edge deny rule for the code on **every public backend hostname**, then set `is_blocked` and invalidate. If the chosen plan cannot support this and strict revocation is required, uncached DB authorization per redirect is the safer launch alternative. Do not claim instant revocation from cache deletion alone.

## Limiter

| Scope | Initial limit | Failure policy |
| --- | --- | --- |
| Create | 20/minute/client + configurable global daily budget | `503` if limiter unavailable |
| Redirect GET/HEAD | 600/minute/client | Fail open, bounded DB fallback |
| Public metadata | 120/minute/client | `503` |
| All management/analytics attempts | 60/minute/client + configurable per-code attempt budget | `503` |

Set the global create and per-code attempt budgets before public launch based on expected use/cost. Do not deploy an unlimited default. Per-IP limits can affect shared NAT users; monitor false positives and tune rather than claiming they identify a person.

Use a fixed-window Lua script with **the window number in the key**:

```text
env:rl:{scope}:{window_number}:{client_hmac}
```

The atomic script increments and assigns expiry through the end of the window plus cleanup grace. Calculate Retry-After from the window boundary, not the grace period. Fixed windows permit bursts across boundaries; a token bucket can replace them if measurements justify it. Daily budget checks must also be atomic, and code/IP identities are normalized before hashing.

Client identity comes only from a verified platform-overwritten IP header on Vercel, or the direct peer locally. Test the trust chain; never accept an arbitrary X-Forwarded-For value or chain position. HMAC client IPs with a dedicated secret, retain only TTL-bound limiter keys, and do not log them or reuse them as analytics visitor IDs.

Protect cron with its bearer secret, not a public-IP limiter. CORS is a browser policy, not protection from nonbrowser abuse.

## Timeout and overload budgets

Starting budgets, to be validated in the deployed region:

| Operation | Deadline | Outcome |
| --- | --- | --- |
| Redis limiter | 50 ms | Policy above |
| Cache read/fill | 50 ms each | Miss/skip fill |
| Event enqueue | 50 ms | Potential event loss; still redirect |
| Runtime DB pool wait | 250 ms | `503` if no slot |
| Redirect DB query | 500 ms | `503` on miss |
| Create/manage DB work | 3 s | Controlled error; same-key create retry safe |
| Analytics query | 5 s | Controlled error |
| Worker | 20 s work, 30 s function ceiling | Stop taking batches with cleanup headroom |

Wrap the whole dependency operation in an application deadline (pool wait, DNS/connect, TLS and command), not only a socket timeout. Do not automatically retry Redis on redirects. A timed-out enqueue might have succeeded: count it as an uncertain outcome, not proof that the event is absent.

When Redis is known unhealthy, skip optional fill/enqueue attempts for that request. Bounded per-instance backoff may reduce retry pressure; it is only an optimization. Cap DB fallback concurrency and pool waiting so cache failure cannot open unlimited Postgres connections. Return `503` under overload instead of hiding it behind long queues.

No distributed single-flight lock initially: add one only after observing a miss stampede and testing its lease/recovery behavior. Avoid hot in-process caches as correctness dependencies.

## Connection management

- Runtime uses Neon's pooled endpoint; migration/administration uses a direct connection.
- Start with a small bounded SQLAlchemy async pool (`pool_size=2`, `max_overflow=0`, short pool timeout) and benchmark warm reuse, cold starts and Neon transaction-pool compatibility. This is a candidate, not a universal PgBouncer recipe.
- Client connection budget is live engine instances × their pool caps, plus workers/migration headroom. Pooler client capacity is not backend transaction throughput.
- Validate pinned asyncpg prepared-statement behavior against Neon; do not apply generic PgBouncer tuning blindly. Consider `NullPool` only with bounded request concurrency and measured TLS/reconnect cost.
- No shared AsyncSession; never hold a SQL transaction across a Redis call. Transactions roll back on cancellation.
- Use certificate-verified TLS and explicit asyncpg SSL configuration; see [deployment](deployment.md).

Use a reusable, bounded `redis.asyncio` TLS pool. Verify Upstash command, script, stream, consumer-group and reclamation support against the exact selected service before implementation. REST and TCP transports are not automatically interchangeable. Keep stream/limiter keys non-evictable; cap positive cache memory explicitly or isolate it if the service policy requires.

## Scaling triggers

- Compare p95/p99 latency to [SLO targets](observability.md), including cold starts and queue waits.
- Measure hit ratio for existing-code traffic separately from scans; 95% is a diagnostic aspiration, not a guaranteed short-TTL result.
- Worker sustained throughput must exceed capture rate with catch-up headroom. Measure both under overlap and backlog.
- Size stream capacity in bytes and minutes of outage, not just entry count. Alert well before provider limits or trim losses.
- Measure raw-event retention size and analytics query cost; evaluate shorter retention or an analytics store before blindly sharding links.
- Do not add multi-region caches, replicas, edge redirect caching or a KGS without a measured bottleneck and an explicit consistency/analytics tradeoff.

All API responses are HTTP `no-store`; Redis server-side caching is independent. Static frontend assets use the CDN. Edge-cached redirects would bypass capture and require a new analytics contract.
