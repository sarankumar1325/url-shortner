# ADR 0002: Neon Postgres + Upstash Redis

Status: Accepted stack; service configuration/benchmarks pending · Reviewed: 2026-10-23

## Decision

Neon Postgres is authoritative for links, token hashes, atomic create-replay records, raw clicks and daily totals. Upstash Redis holds positive redirect cache entries, distributed limiter state and a bounded event stream. Co-locate with the Vercel function region.

Keep one database schema and modular services. Do not create unused user tables; account ownership can be added with a nullable foreign key in a later expand migration.

## Reasons and constraints

Postgres provides transactions and unique constraints for concurrent allocation, replay and deduplication. Neon pooled endpoints suit ephemeral clients, but pooler client limits are not database throughput. Validate SQLAlchemy/asyncpg TLS, prepared statements and small client pools on the pinned versions.

Upstash provides shared cache/limiter/buffer state, but verify actual script/Stream/claim support and quotas. Three baseline Redis operations per warm GET (limit/read/enqueue) plus worker commands have real cost. Avoid eviction of stream/limiter data; enforce byte/count budgets or isolate cache eviction.

Redis is not authoritative for create replay: a DB commit followed by a failed Redis write would lose the original token-bearing response. Use a single DB transaction with short-lived AEAD-encrypted replay data instead.

## Failure and privacy tradeoffs

Redirects can use valid cache during DB outages only until the 60-second cache deadline. Cache outages require bounded DB fallback, not unlimited connection growth. Creation/management limiter failure is fail-closed; captured analytics may be lost on enqueue/overflow.

Rich events dominate storage at sustained traffic. Measure 90-day raw retention and two-year rollup costs before scaling. Never clone production personal data into publicly accessible preview branches; prefixes alone do not enforce Redis authorization.

## Alternatives

Postgres alone is operationally simpler but increases redirect/limiter database load. Supabase offers identity/storage not needed for anonymous v1. NoSQL can be viable at scale but changes transaction/query modelling; it is not categorically incapable of uniqueness or atomic operations.

A Marketplace Redis integration is a provisioning channel, not necessarily another vendor or reduced vendor count. Self-hosting shifts availability, upgrades and backup responsibilities to this project; not warranted for v1.

## References

[Data model](../backend/data-model.md) · [Cache/capacity](../backend/caching-and-scale.md) · [Analytics](../backend/analytics.md) · [Deployment](../backend/deployment.md)
