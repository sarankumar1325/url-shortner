# ADR 0002: Neon Postgres + Upstash Redis

- Status: Accepted
- Date: 2026-10-23

## Context

The service is read-heavy, serverless, and needs:

- Durable relational storage for links, tokens, and analytics.
- A shared cache for redirect lookups.
- Distributed rate limiting.
- A lightweight event buffer for asynchronous click analytics.
- Minimal connection management friction from Vercel Functions.

Candidates were evaluated on serverless fit, operational burden, latency, and cost.

## Decision

Use:

- **Neon Postgres** with the pooled connection string for durable data.
- **Upstash Redis** (TLS) for cache, rate limits, and the analytics stream.

Both run in the same region as the Vercel functions. Production and preview use separate databases/branches and key prefixes.

## Consequences

**Positive**

- Postgres provides strong constraints, transactions, and a familiar relational model for links and clicks.
- Neon's pooler handles many short-lived serverless connections.
- Upstash provides a managed Redis with low-latency shared state and serverless-friendly billing.
- Redis Streams cover the analytics buffer without adding a fourth vendor.
- Both services integrate well with Vercel and support separate preview environments.

**Negative**

- Three vendors to monitor (Vercel, Neon, Upstash).
- Network hops to two data services from each function invocation.
- Redis is not the system of record; analytics events can be lost if the stream append fails.
- Serverless connection limits require conservative pools and monitoring.
- Cross-region latency if regions are mismatched.
- Cost scales with request volume, especially Redis commands per redirect.

**Mitigations**

- Place Neon and Upstash in the same region as the functions.
- Use one Redis GET per redirect and fail over to Postgres on cache errors.
- Keep the DB pool small (`pool_size=5`) and use the Neon pooler.
- Monitor cache hit ratio, Redis latency, and Neon connections.
- Separate cache and stream/limit databases if eviction becomes a risk.

## Alternatives considered

### Neon Postgres only

Simpler vendor count, but every redirect would hit Postgres and rate limiting would need a database or in-memory approach. At read-heavy traffic this increases latency and connection pressure. Rejected.

### Supabase

Provides Postgres, auth, storage, and realtime. Attractive if accounts arrive soon, but v1 does not need auth/storage and the additional platform surface is not justified. Could be revisited when accounts ship.

### DynamoDB / serverless NoSQL

Excellent scale and latency, but weaker relational constraints, migrations, and analytics queries. The link/click model benefits from SQL and unique constraints. Rejected.

### Vercel KV / Marketplace Redis

Vercel KV is Redis-compatible and would reduce vendor count. Upstash is explicitly chosen for control over Streams, persistence, regions, and pricing. If the platform's KV offering matches the needed features, the Redis adapter can be pointed at it.

### Self-hosted Postgres/Redis

More control and potentially lower cost at high scale, but significant operational burden for a small project. Rejected for v1.

## References

- [Data model](../backend/data-model.md)
- [Caching and scaling](../backend/caching-and-scale.md)
- [Analytics pipeline](../backend/analytics.md)
- [Backend deployment](../backend/deployment.md)
