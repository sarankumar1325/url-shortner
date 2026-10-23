# Security and Abuse Prevention

Status: target design; release controls are not yet implemented · [API](api.md) · [Deployment](deployment.md)

## Threat model

| Threat | Control | Remaining limitation |
| --- | --- | --- |
| Malicious destinations | Scheme/authority validation, create limits, reporting and operator block | Validation is not malware detection |
| Enumeration | Random codes, limits, no public listing | Short links are public; randomness is not authorization |
| Link takeover | Per-link 256-bit token, HMAC at rest, HTTPS, no-store | Browser XSS can steal accessible capabilities |
| Retry creates duplicate/unmanageable link | Same-transaction Postgres replay record | Replay key is also a secret capability, valid 24 hours |
| Cache serves deleted/malicious target | 60-second max age, invalidation, edge deny for urgent takedown | Invalidation alone is not strict revocation |
| Database injection | Parameterized SQL, narrow DML role | Operators and migration credentials remain sensitive |
| SSRF from future previews | No server-side destination fetching in v1 | Future fetcher needs DNS/egress/hop controls |
| Resource exhaustion | Edge controls, atomic limits, size/time/concurrency budgets | Provider plan limits and abuse costs still require monitoring |
| Secret/PII telemetry leak | Redaction at source, sanitized exception handling | Vendor logs/backups need separate retention review |

## URL boundary

[Short-link validation](short-links.md#destination-validation) is authoritative: HTTP(S) only, no credentials/control characters/backslashes, constrained size, normalized hosts, private/noncanonical IP rejection and local-name blocking. No DNS lookup or destination fetch in v1. Domains can change resolution; do not advertise DNS-rebinding prevention or a safety verdict.

Reject self-shortening to configured API/redirect hosts. Preserve path/query semantics for signed URLs. Tests must cover IDNA, IPv4-mapped IPv6, trailing dots, numeric host variants and browser/parser disagreements. Client validation never replaces API validation.

## Anonymous capabilities

- Generate a token with 32 random bytes; use HMAC-SHA256 and constant-time digest comparisons.
- Version token hashes from the first schema. Read a current/previous pepper map; rehash atomically on successful use during rotation. Do not treat pepper rotation as a casual way to revoke every user's access.
- Require `X-Management-Token` over HTTPS; never put tokens in routes, query strings, browser history, query keys, logs or traces.
- Validate tokens against Postgres for metadata with auth, mutations and analytics. Fail closed on DB/auth failures; never use a cached redirect payload for authorization.
- Default frontend storage is memory. Explicit opt-in may remember on this device; show/reveal/copy during creation and warn that losing all copies loses management. A paste form restores possession, not a forgotten server secret.
- No silent auto-save of credentials; storage failure cannot hide a successful response. Clear private query data on token replacement/rejection/forget, including cross-tab events.

### Replay storage exception

An idempotency key can replay a creation response including its token for 24 hours. Require random UUIDv4, redact it, store its digest only, and encrypt the complete replay response with AEAD and a separate versioned key. Commit replay and link in the same DB transaction. Encrypting the replay is an intentional exception to the link row's hash-only token storage.

Enforce TTL on reads, purge rows in bounded jobs, and retire old replay keys after their live windows. Document backup retention; deleting a live row does not erase all backups. Keep old decryption keys only as long as needed for permitted replays. An exposed replay key can disclose a token even if no link-management call has occurred.

## Abuse and urgent takedown

- Fail closed for create, management and analytics when the shared limiter is unavailable. Redirect limits may fail open only with bounded DB fallback.
- Apply rate limits to unauthenticated management attempts, not only successful token checks. Require global daily creation and per-code attempt caps at launch.
- Trust only verified platform-overwritten IP metadata; arbitrary forwarded headers are attacker input. Per-IP budgets are not identity/authentication.
- Publish reporting/security contact details before public creation opens. Do not publish placeholder contact addresses.
- Provide an operator procedure using `is_blocked`, independent of `is_active`; the holder of a management token cannot unblock it.
- For immediate malicious-code revocation, apply and verify a deny rule across every backend hostname, then commit `is_blocked` and invalidate. Without a suitable edge control, document up to 60 seconds of stale redirect risk or use authoritative DB checks; do not claim zero delay.
- Maintain an auditable erasure procedure for destination/event data, retaining only a code tombstone where necessary to prevent reuse. Access, retention and backup expiry must be documented even without accounts.
- Automated reputation scanning is deferred, not a release control already present.

## HTTP and browser security

- All API/private/redirect/error responses: `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`.
- Redirects: `Referrer-Policy: no-referrer`; HTML errors escape output and prohibit framing.
- Exact CORS origins with credentials disabled. Distinguish approved preview origins from arbitrary `*.vercel.app` deployments. CORS does not authenticate an API client.
- Enforce a 64 KiB body cap while streaming input; return `413` before allocation. Validate schema lengths, unknown fields, date bounds and request IDs.
- No debug mode or interactive docs in production. OpenAPI remains public; security never depends on hiding it.
- Start HSTS only after HTTPS validation; `includeSubDomains` and preload require domain-owner review and must not be copied blindly.
- The SPA uses a reviewed CSP, no unsafe HTML injection, no unapproved third-party scripts and `noopener noreferrer` for external links. Inline style allowance does not justify inline script execution.
- Framework validation errors must remove raw `input` values before logging/responding; request bodies, destinations, auth/replay headers and cookies are always redacted.

## Privacy and retention

Rich analytics need event time, country, referrer origin, device category and bot classification—not persistent IP hashes. Raw IP is transient limiter input only; rate-limit HMAC keys expire and are not logged or correlated with analytics. Store no raw UA in Postgres and no referrer path/query/fragment anywhere in durable events.

Stream UA is bounded and short-lived; malformed/dead-letter diagnostics contain only IDs/reasons. Raw events retain 90 UTC days, totals two years, replay responses 24 hours, redacted diagnostics at most seven days. Aggregate or pseudonymous data may still be personal data; hashing alone does not make information anonymous.

Review destination URLs too: they can contain personal data or access credentials. Limit database/backup access, prohibit logging full targets, and define retention after deletion. Determine privacy notices, lawful basis and any GPC/consent obligations for the launch jurisdiction before collecting data. Do not assert that no cookies means no privacy obligations.

## Secrets and software supply chain

[Deployment](deployment.md#planned-environment-settings) defines exact names, including unprefixed `CRON_SECRET`. Separate runtime DML and migration DDL roles, isolated preview data, TLS certificate verification, versioned pepper/encryption keys and a dedicated limiter HMAC key. A telemetry DSN may be a public ingestion identifier; do not confuse it with privileged API credentials.

Use frozen lockfile installs, dependency audits and secret scanning. Ruff `B` is **flake8-bugbear**, not Bandit; security rules use the `S` family and require an intentional configuration/test review. No lint rule substitutes for a threat model. The scaffold currently enables `E,F,I,UP,B`; additional tooling is planned, not already enabled.

## Release security gates

- [ ] URL/parser adversarial tests, reserved generated codes and HEAD no-event behavior.
- [ ] Token isolation, invalid-token responses, encrypted replay concurrency/crash tests and key rotation.
- [ ] No sensitive content in application/validation/access/error telemetry; vendor log settings reviewed.
- [ ] Auth-cache clearing, storage failures, no-store, CSP and exact CORS verified in a browser.
- [ ] Fail-closed creation/management and bounded fail-open redirect overload tests.
- [ ] Operator takedown on all hosts, erasure request procedure and backup restore drill.
- [ ] Retention and scheduler auth active before collecting production events.
- [ ] Dependency/secret scans and privacy review complete; documented exceptions accepted explicitly.
