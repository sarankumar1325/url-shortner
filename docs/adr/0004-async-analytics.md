# ADR 0004: Asynchronous Click Analytics via Redis Stream

- Status: Accepted
- Date: 2026-10-23

## Context

The redirect is the hottest path in the system. Click analytics should not add a database write or an external API call to that path. The product also wants rich events (referrer, device, country, bot flag), not just a counter.

Vercel Functions are short-lived and shutdown is limited, so in-process background work after the response is unreliable.

## Decision

Capture clicks as **events appended to a Redis Stream** during the redirect, then process them asynchronously:

1. `XADD clicks:stream` with a JSON payload and an `event_id`.
2. A scheduler calls `GET /internal/analytics/drain` every minute.
3. The drain reads batches with a consumer group, inserts into Postgres with `ON CONFLICT (event_id) DO NOTHING`, recomputes daily rollups, and acknowledges.
4. The analytics API reads rollups.

Vercel Cron is the default scheduler; Upstash QStash is the fallback when the Vercel plan limits cron frequency.

## Consequences

**Positive**

- Redirect latency stays independent of Postgres analytics writes and event parsing.
- Rich events can be added without changing the redirect response time.
- Redis Streams provide a buffer during traffic spikes and database maintenance.
- Consumer groups and `event_id` uniqueness make ingestion idempotent.
- Rollups keep analytics queries cheap.

**Negative**

- Analytics are eventually consistent, typically within one drain interval.
- The pipeline adds operational surface: stream length, pending entries, cron health, poison messages.
- Events can be lost if the stream append fails or the stream is trimmed under extreme backlog.
- At-least-once delivery requires idempotent processing.
- Vercel Cron frequency depends on the plan; QStash may be needed.
- Upstash costs scale with commands, including one `XADD` per redirect.

**Mitigations**

- Best-effort append with a 200 ms timeout; never block the redirect.
- `MAXLEN ~ 1,000,000` as a safety cap plus alerts on stream length.
- `event_id` uniqueness and recomputed rollups for idempotency.
- Dead-letter handling for malformed events.
- Alerts on pending age and time since last successful drain.
- Switch to QStash or Vercel Queues if cron frequency or volume grows.

## Alternatives considered

### Synchronous insert on redirect

Simplest to reason about and immediately consistent, but adds database latency and failure modes to the hot path. At high traffic, it couples redirect availability to analytics write capacity. Rejected.

### Vercel Queues + Celery/Dramatiq

A robust worker model, and a natural fit if the architecture already uses queues. It adds worker deployment, broker configuration, and more moving parts than v1 needs. Revisit if analytics workloads become long-running or multi-step.

### QStash per event

Each redirect publishes a message to QStash, which calls the drain. This is serverless-friendly and near-real-time, but adds one HTTP publish per click and another vendor call. The Redis Stream keeps the hot path to one Redis command.

### Kafka / Kinesis

Excellent for very high volume and replay, but operationally heavy and unnecessary at this scale.

### ClickHouse

Ideal for large-scale analytical queries, but a second database and ingestion pipeline are not justified in v1. Postgres rollups are sufficient for per-link daily totals.

## References

- [Analytics pipeline](../backend/analytics.md)
- [Caching and scaling](../backend/caching-and-scale.md)
- [Data model](../backend/data-model.md)
- [Backend deployment](../backend/deployment.md)
