# Observability, SLOs and Recovery

Status: safe JSON access logging and per-response `Server-Timing` are implemented; SLOs, metrics, tracing and alerts remain proposed targets, not measured results · [Capacity](caching-and-scale.md) · [Deployment](deployment.md)

## Measurement definitions

SLOs must measure user outcomes rather than treating every non-5xx response as success. Separate public redirects, create/manage, background ingestion and frontend availability.

| Objective | Initial target | Definition |
| --- | --- | --- |
| Redirect availability | 99.9% over rolling 30 days | Eligible active/nonexpired requests returning correct 302; unexpected 404/410/429, timeouts and 5xx count as failure |
| Redirect warm latency | p95 <100 ms, p99 <250 ms | End-to-end handler time including limiter/cache/enqueue, not just SQL |
| Create availability | 99.5% over rolling 30 days | Valid within-policy submissions with a successful create/replay; infrastructure failures count |
| Create warm latency | p95 <400 ms | Includes rate limit, transaction, encryption and response |
| Analytics warm query latency | p95 <800 ms | Includes auth, rollups and clipped breakdowns |
| Captured-event freshness | 95% ingested within 2 minutes | Accepted events' `ingested_at - clicked_at`; excludes known failed capture, reported separately |

Include cold starts in availability and overall latency dashboards; report warm/cold and client-observed latency separately, not by dropping cold traffic from reports. Invalid/expired requests and intentional policy denials are excluded from eligibility, not labelled successful redirects. Maintain known-active canary links and synthetic GET/HEAD probes to detect incorrect 404s that status counters alone cannot classify.

These targets need load/deployed-region validation. An accepted-event freshness SLO does not prove capture completeness. Report enqueue failures/unknown outcomes independently. A 99.9% time-based 30-day budget is 43.2 minutes; a **request-based** budget is 0.1% of eligible requests, not a fixed amount of downtime.

## Safe structured logging

Implemented now: every request emits one JSON line to stdout through the `shortly.access` logger with `event`, `service`, `environment`, validated `request_id`, `method`, matched route template (or `unmatched`), `status`, `duration_ms` and problem `error_code`. Raw paths, query strings, short codes, headers, cookies, tokens, IPs and user agents are never logged. Unhandled exceptions log `status=500` and `error_code=internal_error` before the generic response is produced.

Not yet implemented: log shipping/retention policy, metrics, tracing, dashboards and alerts. The remaining requirements below are targets, not deployed behavior.

Generate/validate bounded UUID request IDs and echo `X-Request-ID`. Log JSON with service, environment, commit SHA, route template, method, status, duration, cache outcome and error code. Avoid raw request paths/query strings and per-link logs by default.

Never log destinations, bodies, `Authorization`, `X-Management-Token`, `Idempotency-Key`, cookies, IPs, UA/referrer strings, encryption material or validation input. SQL exception parameters can contain URLs/tokens; configure scrubbing rather than blindly dumping exceptions. Audit platform access logs and tracing integrations too.

Use route/status/error enums as metric labels. Never label metrics with short codes, IP hashes, token values, request IDs or URLs. Sampled controlled diagnostic logs may use a short code only when operationally necessary and covered by access/retention policy.

## Server-Timing

Implemented now: `ServerTimingMiddleware` (`core/timing.py`) adds one header to every response:

```text
Server-Timing: db;dur=12.4;desc="Postgres x2", redis;dur=3.1;desc="Redis x1", total;dur=18.9
```

A per-request accumulator lives in a context variable. Postgres time comes from SQLAlchemy `before_cursor_execute`/`after_cursor_execute` listeners (`core/db.py` `instrument`), Redis time from the REST command and pipeline helpers (`core/redis.py`). The header is written when the response starts, so it covers all work done by then; background work after the response is not included. CORS exposes the header, and the browser's Network panel shows it for requests through the `/api` rewrite. It carries only durations and counts, never queries, keys or codes. It is a per-request diagnostic, not a metric or trace pipeline.

## Metrics and dashboards

**Requests and dependencies**

- Request counts, eligible success/failure and duration by route/method/status.
- Cache hits/misses/errors/expired deadlines, separately for known existing-code traffic.
- Limiter allow/deny/degraded results by scope; create budget usage and rejected unauthenticated management attempts.
- Redis command latency/errors, DB pool wait/active connections, query latency, transaction aborts, collision retries.
- Cold starts and function concurrency; edge denials and client timeouts where measurable.

**Pipeline**

- Enqueue attempts: acknowledged, timed-out/uncertain, failed, intentionally skipped.
- Unread count/age, pending count/oldest age, stream bytes/entries, capacity percentage, trimmed-pending IDs.
- Committed inserted/duplicate/rejected events, drain time/throughput, successful drain time, capture-to-ingest latency.
- ACK/delete failures, retention backlog, redacted poison-event reasons.
- `GET /internal/analytics/status` returns the current snapshot: stream depth, group lag, pending count and oldest age, dead-letter depth, legacy list depth, and Redis availability. The analytics response embeds the same data as `freshness`.
- Remember: acknowledged entries are deleted, so `XLEN` approximates pending plus not-yet-read entries; `XPENDING` excludes never-read entries. Neither alone measures backlog. Dead-letter depth is the count requiring human follow-up.

**Product/operations**

- Create and redirect volume, daily analytics storage growth, projected vendor command/storage spend.
- No unique-visitor claim. Bot/human counts are estimates and diagnostic, not verified identity.
- A sparse link's `last_processed_at` does not indicate queue health; global pipeline telemetry does.

## Tracing

Use bounded OpenTelemetry spans for HTTP → limiter → cache → DB miss → enqueue, with sensitive attributes removed. A 10% head sample drops unsampled requests before an error is known: it cannot guarantee "all errors traced". Always capture redacted error logs; use tail sampling only if an actual collector is provisioned and its cost/retention reviewed. Tracing is optional until it demonstrably helps diagnose the service.

## Alerts

Tune thresholds against representative load; low-traffic services need canaries and minimum sample counts.

| Severity | Trigger | First action |
| --- | --- | --- |
| P1 | Sustained eligible redirect errors or active canary failure | Inspect recent deploy, edge policies, Redis/Neon health |
| P2 | Redirect p95 >200 ms for 10 minutes | Split cold starts, cache latency and DB pool waiting |
| P2 | No successful drain for 15 minutes, or oldest unprocessed age >10 minutes | Check cron/auth and bounded manual drain |
| P2 | Dead-letter depth >0 and increasing, or any `max_attempts_exceeded` event | Inspect `XRANGE clicks:dead`, fix the systemic cause before replaying |
| P2 | Group pending >1,000 or lag >5,000 for 15 minutes | Measure drain throughput, DB latency and producer rate; raise drain budget only after checking cost |
| P2 | Stream/DB/command budget near configured capacity | Measure backlog growth, throughput and spend; avoid blindly increasing caps |
| P2 | Create/management limiter degraded | Restore Redis; keep expensive routes fail-closed |
| P2 | Cache invalidation failure during takedown | Verify edge denial on all backend hosts |
| P3 | Retention lag, dependency audit issue, rising policy denials | Investigate before next release |

For availability, prefer multi-window error-budget burn alerts over single 4xx spikes. Pause nonessential releases when the agreed budget is exhausted; fixes/recovery remain allowed.

## Health versus readiness

- `/health`: process/app liveness, no dependency calls, safe for frequent probes.
- `/api/v1/health` and `/api/v1/ready` are the same handlers under the API prefix. The web app's login and signup pages call `/api/v1/ready` once on mount to warm the function and the database through the same-origin rewrite.
- `/ready`: bounded DB check and Redis check in parallel, detailed internal telemetry but only generic public ready/not-ready response. Redis failure may still allow some redirects but blocks readiness for full functionality.
- Vercel does not automatically route traffic using these endpoints. External health monitoring and deployment smoke tests must be configured explicitly.

## Runbooks

### Redis unavailable

Redirects fall back to bounded DB reads; creation, management and analytics fail closed. Monitor DB pool saturation and lost/uncertain enqueue counts. Suppress repeated optional Redis attempts per request, repair credentials/network/service health, and do not remove rate limits globally as a shortcut.

### Postgres unavailable

Valid cache hits survive only until the absolute 60-second deadline; misses and management return `503`. Do not flush remaining cache or extend stale TTLs. Inspect migrations, connections and provider health. Restore service before the cache-age window closes where possible; no promise of indefinite cache-only availability.

### Analytics backlog

Inspect unread and pending age, not just XLEN. Verify the plan supports the schedule, unprefixed CRON_SECRET matches, and jobs target production. A bounded authorized manual drain can recover; it must tolerate concurrency and duplicate delivery. Do not ACK/delete uncommitted batches or blindly trim the stream to clear an alert.

### Suspected malicious link

Verify the report without fetching the destination from privileged infrastructure. Apply edge denial for the code on both public backend hosts, then block in the DB and invalidate. Record the action without full target/token data. Validate public rejection and retain an authorized unblock/audit process.

### Bad deployment / data incident

Rollback code only if old code is compatible with migrated schema and secret versions. A rollback is not a data restore. Restore a backup into an isolated database, verify canary links/token hashes, reconcile deployment versions, and explicitly authorize switching data endpoints.

Provisional recovery objectives: durable link data RPO ≤24 hours, RTO ≤4 hours; verify plan capabilities and measure a restore drill before claiming them. Replays/live secrets and analytical aggregates have different retention/recovery constraints. Retest restore and operator access periodically.

## Release evidence

Record load assumptions, observed RPS/latency, cold starts, Redis operations/cost, worker catch-up capacity and measured restore time with the release. A green `/health` or unit test is not proof the URL shortener, privacy controls or deployment is production-ready.
