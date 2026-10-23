# Caching, Rate Limiting, and Scaling

Status: target design · Related: [Architecture](architecture.md) · [Analytics](analytics.md) · [Deployment](deployment.md)

## Workload shape

The system is extremely read-heavy. A typical ratio is 100 redirects for every link creation, and popular links can be hit thousands of times per minute.

| Path | Frequency | Latency target (server) | Consistency |
| --- | --- | --- | --- |
| Redirect `GET /{code}` | Very high | p95 < 50 ms | Read-your-writes after cache invalidation or TTL |
| Create `POST /api/v1/links` | Low | p95 < 400 ms | Strong |
| Metadata | Medium | p95 < 100 ms | Strong |
| Analytics | Low | p95 < 800 ms | Eventual (one drain interval) |

The design optimizes the redirect path and keeps writes simple.

## Redirect cache

### Pattern

Cache-aside with Redis:

```text
GET url:{code}
  hit  → validate active/expiry from the cached payload → redirect
  miss → SELECT from Postgres → SETEX → redirect
```

The cache is an optimization, never the source of truth. A Redis outage degrades latency, not correctness.

### Key and value

```text
key:   url:{short_code}
value: {"v":1,"id":42,"long_url":"https://example.com/x","is_active":true,"expires_at":null}
```

- `v` allows a future payload migration without guessing.
- `expires_at` is included so expiry is enforced without a database round trip.
- The value never contains the management token or its hash.
- Inactive or deleted links are not cached positively. A short negative marker may be cached.

### TTL policy

| Case | TTL |
| --- | --- |
| Active, no expiry | 900 s + random 0–300 s jitter |
| Active with expiry | `min(900 s, seconds_until_expiry)` |
| Missing code (negative) | 30 s |
| Inactive/deleted | 30 s negative marker |
| After update/delete | Key deleted immediately |

Jitter prevents large groups of keys from expiring at the same instant. A 15-minute default bounds staleness if invalidation fails.

### Invalidation

After a successful update or soft delete commit:

```text
DEL url:{code}
DEL url:miss:{code}
```

Invalidation is best-effort. If Redis is unavailable, the mutation still succeeds and the TTL bounds how long a stale entry can live. Freshness-critical changes should be rare; the API returns the updated representation immediately.

### Stampede control

- TTL jitter handles most synchronized-expiry cases.
- For a very hot missing key, an optional single-flight lock (`SET url:lock:{code} NX PX 200`) lets one request query Postgres while others wait briefly or fall back to the database.
- V1 may skip single-flight: a cache miss for a hot link is one indexed query, and Neon can absorb a short burst. Add the lock if database load shows a stampede pattern.

### Why not cache in process?

Vercel instances are ephemeral and horizontally scaled. An in-process cache would be inconsistent, hard to invalidate, and ineffective across cold starts. Redis is the shared tier.

## Rate limiting

### Defaults

| Scope | Limit | Window | Key |
| --- | --- | --- | --- |
| Create | 20 | 60 s | `rl:create:{ip_hash}` |
| Redirect | 600 | 60 s | `rl:redirect:{ip_hash}` |
| Metadata | 120 | 60 s | `rl:meta:{ip_hash}` |
| Analytics | 60 | 60 s | `rl:analytics:{ip_hash}` |

Limits are configuration, not constants, so production can tune them without a code change.

### Algorithm

V1 uses a fixed window with an atomic Lua script:

```lua
local current = redis.call("INCR", KEYS[1])
if current == 1 then
  redis.call("EXPIRE", KEYS[1], ARGV[1])
end
return { current, redis.call("TTL", KEYS[1]) }
```

Properties:

- One Redis round trip per request.
- Atomic increment and expiry.
- Allows a burst at a window boundary (up to 2× the limit across the boundary).
- Cheap and easy to reason about.

Upgrade to a sliding-window sorted set or token bucket when boundary bursts become a real abuse vector. The interface stays `allow(scope, identity) -> Decision`, so the algorithm can change without touching routes.

### Fail-open policy

- **Redirects**: if Redis is unavailable, allow the request and emit `rate_limit.degraded`. Availability of links is more important than perfect limiting.
- **Create**: allow but log; abuse can be contained with Vercel WAF and a global create budget.
- **Analytics**: allow; it is authenticated by token.
- Volumetric attacks are handled upstream by Vercel's firewall/WAF, not by application-level counters.

### Response metadata

`RateLimit-Limit`, `RateLimit-Remaining`, and `RateLimit-Reset` are returned on successful limited routes. `429` includes `Retry-After`.

## Redis client and timeouts

Use one async Redis client per function instance, created lazily:

```python
redis = Redis.from_url(
    settings.redis_url,
    decode_responses=True,
    socket_connect_timeout=0.5,
    socket_timeout=0.2,
    max_connections=10,
    health_check_interval=30,
)
```

- **Connection model**: `redis.asyncio` with TLS to Upstash. If Upstash connection limits become a problem, swap the adapter for Upstash's REST API behind the same `CacheClient` protocol.
- **Command timeout**: 200 ms. A redirect that waits longer for cache is slower than a direct Postgres lookup.
- **No retries on timeout** in the hot path; retrying multiplies tail latency.
- **Local development** uses Docker Redis; production uses Upstash with TLS.
- **Namespaces**: environment prefix (`prod:`, `preview:`) avoids collisions when sharing a database. Prefer separate Upstash databases per environment.

## Postgres connection management

- Use SQLAlchemy 2.x async with `asyncpg`.
- Use the Neon **pooled** connection string; direct connections are for migrations and admin tasks.
- Per-instance pool: `pool_size=5`, `max_overflow=0`, `pool_pre_ping=True`, `pool_recycle=300`.
- Connect timeout 3 s, statement timeout 2 s for redirect queries, 10 s for analytics queries.
- Never hold a transaction open across a network call to Redis or an external service.
- Vercel concurrency × pool size is the upper bound on database connections; Neon's pooler is sized for this.

## Browser and CDN caching

Redirects deliberately use:

```http
Cache-Control: no-store
```

Tradeoff:

- **No-store** preserves per-click analytics and immediate link updates.
- **Edge caching** with `s-maxage=30` would reduce origin traffic at very high scale, but clicks served from the edge are not observed and link edits take up to 30 s to propagate.
- V1 prioritizes correct analytics and freshness. Scale comes from Redis, which keeps origin work to one Redis GET per redirect.
- If edge caching becomes necessary, add it as an explicit mode with sampled analytics and document the accuracy change.

Static frontend assets are cached by Vercel's CDN with immutable hashes; that is unrelated to the redirect path.

## Scaling path

| Stage | Redirect load | Changes |
| --- | --- | --- |
| V1 | < 1k RPS | Single Vercel function, Redis cache, Neon pooled |
| Growth | 1k–10k RPS | Tune cache hit ratio, increase Upstash/Neon capacity, add read replicas if misses dominate |
| Large | 10k–100k RPS | Edge caching or multi-region Redis, partition `clicks`, consider KGS for codes |
| Very large | > 100k RPS | Global anycast edge, region-local data, sampled analytics |

Signals that trigger the next stage:

- Cache hit ratio below 95% for 15 minutes.
- Redirect p95 above 100 ms.
- Postgres connection saturation or read IOPS limits.
- Redis command latency above 20 ms p95.
- `clicks` table above 50 million rows.

## Backpressure and timeouts

| Operation | Timeout | On timeout |
| --- | --- | --- |
| Redis GET/SET | 200 ms | Fall back to Postgres |
| Redis rate limit | 100 ms | Fail open |
| Redis XADD | 200 ms | Drop event, increment metric |
| Postgres redirect read | 2 s | `503` on cache miss |
| Postgres create | 5 s | `503` |
| Analytics query | 10 s | `503` |

Timeouts are set below the Vercel function limit so the application can return a controlled response.

## Operational checks

- Cache hit ratio by route and code.
- Redis p50/p95 latency and error rate.
- Neon active connections, pool wait time, slow queries.
- Redirect p95 and 5xx rate.
- Rate-limit denials by scope.
- Negative cache hit rate (scans and abuse).
- Expired-link 410 rate.

See [observability.md](observability.md) for SLOs and alerts.
