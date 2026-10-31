# ADR 0004: Bounded Capture and Asynchronous Analytics

Status: Accepted direction; delivery/rollup semantics refined · Reviewed: 2026-10-23 · Amended 2026-10-25: the shipped implementation now uses a Redis Stream consumer group (`XADD`/`XREADGROUP`), acknowledges only after commit, reclaims stale messages with `XAUTOCLAIM`, dead-letters poison/exhausted events, and migrates the legacy list. Live smoke verified enqueue → drain → committed row → queue clear.

## Decision

Successful GET redirects await one best-effort, deadline-bounded Redis Stream enqueue. A scheduled worker ingests batches into Postgres and serves daily totals plus v1 referrer-origin/country/device breakdowns. HEAD/OPTIONS/errors never count as clicks.

This is **asynchronous database processing**, not zero redirect overhead. The initial enqueue deadline is 50 ms including connection acquisition; timeout can mean accepted-or-lost. Never rely on a detached serverless task surviving after response.

## Correctness protocol

Insert raw events with `ON CONFLICT (event_id) DO NOTHING RETURNING ...`, aggregate only newly inserted rows, and atomically **increment** rollups in the same transaction. ACK/delete after commit. Duplicate/concurrent workers add no duplicate counts; a lease is an efficiency measure, not the correctness boundary.

Do not recompute and overwrite whole-day totals from overlapping snapshots. Do not assume XACK frees payload storage. Single-consumer-group ACK/delete/reclaim behavior must be tested with the chosen Upstash service.

## Delivery, retention and scheduler

Capture is best-effort; accepted retained events are processed with at-least-once retry, stale-message reclaim and DB deduplication. Malformed and repeatedly failing events go to a bounded dead-letter stream. Enqueue failures, provider data loss, retaining metadata and outages can still lose data. No end-to-end exactly-once or lossless guarantee.

Accept events up to 24 hours old, retain raw IDs/events for 90 UTC days, and totals for two years. The shorter acceptance horizon prevents replays beyond dedupe retention from double-counting totals. Retain no persistent IP/hash or raw UA in Postgres; rich dimensions do not need unique-visitor tracking.

Vercel minute-level cron requires a supporting plan; Hobby daily cron cannot meet the two-minute healthy-operation freshness goal. Confirm plan, credentials, method and production-only invocation before release. An alternative scheduler needs its own authentication/retry validation.

## Alternatives

Synchronous Postgres writes on every redirect simplify capture but couple redirect latency/availability to analytical persistence. Durable per-request messaging can improve guarantees at extra latency/cost. A transactional outbox would require a durable write on the redirect path, changing the chosen availability tradeoff.

Kafka, ClickHouse and independent workers may suit measured larger workloads, not initial v1. Do not describe a queue as unbounded storage or a batch size as proof of throughput: measure consumption rate, byte budget and outage recovery headroom.

## References

[Pipeline and failure tests](../backend/analytics.md) · [Data model](../backend/data-model.md) · [Deployment](../backend/deployment.md)
