# ADR 0002: Neon Postgres + Upstash Redis

Status: Accepted stack; service configuration/benchmarks pending · Reviewed 2026-10-23 · Amended 2026-10-24: accounts/workspaces shipped per ADR 0006, and the event buffer is a Redis list rather than a consumer-group stream

## Decision

Neon Postgres is authoritative for users, sessions, workspaces, memberships, invitations, links, token hashes, atomic create-replay records, raw clicks and daily totals. Upstash Redis holds positive redirect cache entries, fixed-window limiter counters and a bounded click-event list. Co-locate with the Vercel function region.

Keep one database schema and modular services. The original plan deferred account tables; [ADR 0006](0006-accounts-and-workspaces.md) supersedes that for the shipped multi-tenant model. Do not add speculative tables beyond implemented features.

## Reasons and constraints

Postgres provides transactions and unique constraints for concurrent allocation, replay and deduplication. Neon pooled endpoints suit ephemeral clients, but pooler client limits are not database throughput. Validate SQLAlchemy/asyncpg TLS, prepared statements and small client pools on the pinned versions.

Upstash provides shared cache/limiter/buffer state, but verify actual command, list/stream and quota support. Four baseline Redis commands per warm GET (limit increment/expiry, cache read, event append) plus drain commands have real cost. Avoid eviction of buffered events/limiter data; enforce byte/count budgets or isolate cache eviction.

Redis is not authoritative for create replay: a DB commit followed by a failed Redis write would lose the original response. Use a single DB transaction with short-lived AEAD-encrypted replay data instead.

## Failure and privacy tradeoffs

Redirects can use valid cache during DB outages only until the 60-second cache deadline. Cache outages require bounded DB fallback, not unlimited connection growth. Creation/management limiter failure is fail-closed; captured analytics may be lost on enqueue/overflow.

Rich events dominate storage at sustained traffic. Measure 90-day raw retention and two-year rollup costs before scaling. Never clone production personal data into publicly accessible preview branches; prefixes alone do not enforce Redis authorization.

## Alternatives

Postgres alone is operationally simpler but increases redirect/limiter database load. Supabase offers identity/storage that this first-party account design does not need. NoSQL can be viable at scale but changes transaction/query modelling; it is not categorically incapable of uniqueness or atomic operations.

A Marketplace Redis integration is a provisioning channel, not necessarily another vendor or reduced vendor count. Self-hosting shifts availability, upgrades and backup responsibilities to this project; not warranted for v1.

## References

[Data model](../backend/data-model.md) · [Cache/capacity](../backend/caching-and-scale.md) · [Analytics](../backend/analytics.md) · [Deployment](../backend/deployment.md)
