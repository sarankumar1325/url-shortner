# Observability and SLOs

Status: target design · Related: [Caching and scaling](caching-and-scale.md) · [Deployment](deployment.md)

## Principles

- Every request is traceable by `request_id`.
- Logs are structured and safe to retain: no tokens, raw IPs, or full URLs.
- Metrics answer "is the redirect path healthy?" before "is the database busy?".
- Alerts are tied to user-visible symptoms, not raw resource usage.
- Dashboards exist for both the redirect hot path and the analytics pipeline.

## Structured logs

Emit one JSON object per request and per significant background action.

```json
{
  "ts": "2026-10-23T12:00:00.123Z",
  "level": "info",
  "service": "urlshortner-api",
  "env": "production",
  "version": "2026.10.23-1",
  "request_id": "01JQ9Z3K4M8YV2R6T0W7X1N5B8",
  "method": "GET",
  "path": "/{code}",
  "route": "redirect",
  "status": 302,
  "duration_ms": 12,
  "cache": "hit",
  "short_code": "sysdesign",
  "country": "US",
  "rate_limited": false,
  "error_code": null
}
```

Rules:

- Use the platform request ID when present; otherwise generate a ULID.
- Return `X-Request-ID` to the caller and include it in every error response.
- Never log `Authorization`, `X-Management-Token`, raw management tokens, raw IPs, or full destination URLs.
- Destination URLs may contain sensitive query parameters; log only the short code.
- Errors log `error_code`, exception class, and stack trace at `error` level, but the client receives only a generic Problem Details response.
- Stream drain logs include batch size, inserted count, duplicate count, duration, and lag.

## Metrics

Use Vercel Observability, the Upstash and Neon dashboards, and application counters emitted through OpenTelemetry or structured logs.

### Request metrics

| Metric | Type | Labels |
| --- | --- | --- |
| `http_requests_total` | counter | `route`, `method`, `status` |
| `http_request_duration_ms` | histogram | `route`, `cache` |
| `redirect_cache_total` | counter | `result=hit\|miss\|negative\|error` |
| `rate_limit_total` | counter | `scope`, `result=allow\|deny\|degraded` |
| `db_errors_total` | counter | `operation` |
| `redis_errors_total` | counter | `operation` |

### Analytics metrics

| Metric | Type | Meaning |
| --- | --- | --- |
| `analytics_enqueue_total` | counter | `result=ok\|timeout\|error` |
| `analytics_stream_length` | gauge | Entries waiting to drain |
| `analytics_pending_age_seconds` | gauge | Age of the oldest pending entry |
| `analytics_drain_duration_ms` | histogram | Drain invocation duration |
| `analytics_events_total` | counter | `result=inserted\|duplicate\|malformed` |
| `analytics_last_success_timestamp` | gauge | Freshness |

### Database and cache metrics

Use Neon for connections, CPU, IOPS, slow queries, and storage; use Upstash for command latency, errors, and memory.

- Neon active connections vs pool limit.
- Neon p95 query latency for redirect lookups.
- Upstash p95 command latency and error rate.
- Cache evictions and memory usage.

## Service level objectives

| SLO | Target | Measurement |
| --- | --- | --- |
| Redirect availability | 99.9% monthly | Non-5xx responses / valid redirect requests |
| Redirect latency | p95 < 100 ms, p99 < 250 ms | Server duration, cache hit or miss |
| Redirect cache hit ratio | > 95% | Hits / (hits + misses) for existing codes |
| Create availability | 99.5% monthly | Non-5xx create responses |
| Create latency | p95 < 400 ms | Server duration |
| Analytics API latency | p95 < 800 ms | Server duration |
| Analytics freshness | 95% of events within 2 minutes | Event time to rollup commit |
| Error rate | < 0.1% of redirects | 5xx / total |

The 99.9% monthly error budget is about **43 minutes**. Exhausting it pauses non-critical changes until the cause is addressed.

## Distributed tracing

- OpenTelemetry SDK with OTLP export where supported by the platform.
- Propagate `traceparent` and `X-Request-ID`.
- Spans: HTTP request → rate limit → Redis GET → Postgres SELECT (only on miss) → stream append.
- Sample 10% in production and 100% in preview; always sample errors.
- Do not attach full destination URLs, tokens, or IPs as span attributes.

## Dashboards

**Redirect health**

- Requests per second and status mix.
- p50/p95/p99 latency split by cache hit/miss.
- Cache hit ratio.
- 429 rate by scope.
- Redis and Postgres error rates.

**Write path**

- Create rate and error codes.
- Collision retry count.
- Alias conflict rate.
- DB pool wait time.

**Analytics pipeline**

- Stream length and oldest pending age.
- Drain duration and inserted/duplicate counts.
- Malformed event rate.
- Time since last successful drain.
- Analytics API latency.

**Business signals**

- Links created per hour.
- Redirects per hour.
- Expired-link 410 rate.
- Top error codes.

Avoid per-link dashboards by default; they can leak traffic patterns and create cardinality problems.

## Alerts

| Severity | Condition | First action |
| --- | --- | --- |
| P1 | Redirect 5xx > 1% for 5 minutes | Check Neon/Upstash status; roll back recent deploy |
| P1 | Redirect availability below 99.5% over 15 minutes | Page on-call; inspect dependency health |
| P1 | Drain has not succeeded for 30 minutes | Run drain manually; inspect Redis/Postgres |
| P2 | Redirect p95 > 200 ms for 10 minutes | Check cache hit ratio and DB latency |
| P2 | Cache hit ratio < 85% for 15 minutes | Inspect TTLs, invalidation, hot keys |
| P2 | Create 5xx > 2% for 10 minutes | Check DB writes and collision retries |
| P2 | Stream length > 100,000 or pending age > 10 minutes | Increase drain frequency or batch size |
| P3 | 429 rate doubles week over week | Review abuse and limits |
| P3 | Cleanup job fails twice | Inspect retention job logs |

Alerts must include a runbook link and the affected environment. Avoid alerting on single cold starts or isolated 4xx spikes.

## Health and readiness

| Endpoint | Checks | Use |
| --- | --- | --- |
| `/health` | Process is running; no dependencies | Liveness and uptime monitor |
| `/ready` | `SELECT 1` and Redis `PING`, 1 s timeout each | Deployment smoke test and external monitor |

`/ready` returns `503` when a required dependency is unavailable, with component status but no internal details. Vercel does not use these endpoints for routing; they are for operators and smoke tests.

## Release and error tracking

- Include the deployed commit SHA in `version`.
- Use Vercel deployment markers to correlate latency/error changes with releases.
- Sentry (optional) captures backend exceptions with `request_id`, `route`, and `release`; PII is scrubbed.
- Frontend Web Vitals and errors are covered in [frontend/performance.md](../frontend/performance.md).

## Runbooks

### Redis unavailable

1. Redirects fall back to Postgres; expect higher latency.
2. Rate limiting fails open; watch for abuse.
3. Check Upstash status and credentials.
4. If the outage is prolonged, consider temporarily increasing Neon capacity.

### Postgres unavailable

1. Cache hits continue to serve; cache misses and writes fail.
2. Check Neon status, connection limits, and recent migrations.
3. Do not flush the Redis cache; it is the only serving path.
4. Roll back a bad migration if that is the cause.

### Analytics backlog

1. Check `analytics_stream_length` and pending age.
2. Invoke the drain endpoint manually with the cron secret.
3. Verify the cron schedule is enabled and `CRON_SECRET` matches.
4. Increase batch size or schedule frequency if load has grown.

### Cache hit collapse

1. Confirm keys are being written with the expected prefix and TTL.
2. Check for mass invalidation or a key-format change in a recent deploy.
3. Inspect hot keys and Upstash eviction policy.
4. Warm critical links if needed by issuing redirects or a bounded job.

### Elevated 429s

1. Identify scope and whether denials concentrate on one hashed client.
2. Check for a scraper or a broken client retry loop.
3. Apply a WAF rule or adjust limits; avoid disabling limits globally.

### Bad release

1. Roll back in Vercel.
2. Confirm migrations are backward compatible.
3. Verify `/health`, `/ready`, and a canary redirect.
4. Add a regression test before redeploying.
