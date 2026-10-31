# Security and Abuse Prevention

Status: accounts, sessions, password rotation, workspace RBAC and lifecycle controls implemented and production-smoke-tested 2026-10-25; several broader hardening gates remain open · [API](api.md) · [Deployment](deployment.md) · [ADR 0006](../adr/0006-accounts-and-workspaces.md)

## Threat model

| Threat | Control | Remaining limitation |
| --- | --- | --- |
| Malicious destinations | Scheme/authority validation, create limits, reporting and operator block | Validation is not malware detection |
| Enumeration | Random codes, limits, no public listing | Short links are public; randomness is not authorization |
| Link takeover | Workspace membership on every request, or a 256-bit legacy token hashed with HMAC | Browser XSS can act with the victim's session |
| Credential stuffing / brute force | Argon2id, per-IP and per-account limits, uniform login failures | No MFA or breached-password check in v1 |
| Account enumeration | Uniform `401 invalid_credentials`, dummy hash verification | Signup still reveals that an email is taken |
| CSRF on cookie writes | `SameSite=Lax`, exact-Origin/Referer check, JSON-only bodies | Misconfigured allowed origin would weaken it |
| Session theft | Opaque token in `HttpOnly` cookie, digest at rest, 30-day expiry, server-side listing/revoke | No rotation, theft detection or automatic role-change revocation |
| Cross-tenant access | Membership lookup, `404` for non-members, workspace-scoped queries | Broken query scoping would bypass it; tests are the guard |
| Retry creates duplicate/unmanageable link | Same-transaction Postgres replay record | Replay key is a capability, valid 24 hours |
| Cache serves deleted/malicious target | Bounded positive TTL, invalidation, edge deny for urgent takedown | Invalidation alone is not strict revocation |
| Database injection | Parameterized SQL, narrow DML role | Operators and migration credentials remain sensitive |
| Resource exhaustion | Atomic limits, body cap and bounded drain batches | Provider plan limits and abuse costs still require monitoring |
| Secret/PII telemetry leak | Redaction at source, sanitized exception handling | Vendor logs/backups need separate retention review |

## URL boundary

[Short-link validation](short-links.md#destination-validation) is authoritative: HTTP(S) only, no credentials/control characters/backslashes, constrained size, normalized hosts, private/noncanonical IP rejection and local-name blocking. No DNS lookup or destination fetch in v1. Domains can change resolution; do not advertise DNS-rebinding prevention or a safety verdict.

Reject self-shortening to configured API/redirect hosts. Preserve path/query semantics for signed URLs. Tests must cover IDNA, IPv4-mapped IPv6, trailing dots, numeric host variants and browser/parser disagreements. Client validation never replaces API validation.

## Identity and sessions

- Passwords are 10–128 characters and stored only as Argon2id hashes (`argon2-cffi` defaults). Unknown-email logins run a dummy verification so response timing does not disclose account existence.
- Emails are trimmed and lowercased before lookup and uniqueness checks. Signup/Login errors must not echo passwords or hash details.
- No email verification, password reset, MFA or OAuth exists. Treat these as unsupported, not as implied safety. Users who know their password can rotate it; an attacker with the old password loses access immediately after that change.
- Sessions use a random 256-bit `shrs_` token; only its SHA-256 digest is stored. The raw value travels solely in the `shortly_session` cookie.
- Each session row also carries a non-secret public UUID used for listing and targeted revocation. List responses include `created_at`, `expires_at` and a `current` flag; they never include the token or digest.
- Cookie flags: `HttpOnly`, `SameSite=Lax`, `Path=/`, 30-day `Max-Age`, and `Secure` when `ENVIRONMENT` is `production` or `preview`. Do not expose the token to JavaScript or persist it in localStorage.
- Logout deletes the server session row and clears the cookie. Expired rows are rejected and deleted on lookup. Changing a password deletes every other session in the same commit while preserving the caller's session; changing a role does not revoke sessions, so removal/role limits are enforced on every request.
- Revoking a session is scoped by `user_id`; another user's session ID returns `404 session_not_found`. Revoking other sessions never deletes the current one.
- Session tokens are independent of `SECRET_KEY`; rotating the application secret invalidates legacy management tokens and replay ciphertexts but not active sessions. Revocation is explicit session-row deletion.

### CSRF and CORS

- `SameSite=Lax` blocks most cross-site writes, but it is not the only control. Mutating browser requests must also carry an `Origin` (or parseable `Referer`) present in `CORS_ORIGINS`; otherwise the API returns `403 csrf_rejected`.
- Requests with no `Origin`/`Referer` are treated as non-browser clients. They cannot be induced by a third-party page to carry a victim's cookie, so they are allowed; this must not be loosened into "skip CSRF if the header is absent" for browser-reachable flows without review.
- Production CORS lists the exact frontend origin with credentials enabled. Wildcards, `*.vercel.app` patterns and broad preview regexes are forbidden; a regex that admits arbitrary deployments would let those deployments issue credentialed requests.
- The same-origin `/api` rewrite keeps the cookie first-party. The proxy does not relax backend origin checks.
- Cookies are not accepted as API credentials for cross-origin third-party clients; v1 has no OAuth/token API for accounts.

## Workspace authorization (RBAC)

Role order is `viewer < member < admin < owner`.

| Action | Viewer | Member | Admin | Owner |
| --- | --- | --- | --- | --- |
| List/read links, analytics | yes | yes | yes | yes |
| Create, update, activate/deactivate, delete links | no | yes | yes | yes |
| View members | yes | yes | yes | yes |
| View pending invitations | no | no | yes | yes |
| Invite, revoke invitations | no | no | yes | yes |
| Change roles, remove members | no | no | yes, except admins/owner | yes |
| Rename the workspace | no | no | yes | yes |
| Manage admins | no | no | no | yes |
| Delete the workspace, transfer ownership | no | no | no | yes, non-personal only |

- Authorization resolves membership from Postgres on every request; a workspace the caller does not belong to returns `404 workspace_not_found` rather than `403`, avoiding membership disclosure.
- `X-Workspace-Id` selects the workspace. The client cannot gain access by inventing an ID; the membership join is the boundary.
- The owner is not removable, self role changes are rejected, and no flow removes the last owner. Admins cannot manage owners or other admins. Ownership transfer is owner-only, requires an existing non-owner member, locks both memberships with `FOR UPDATE`, and atomically promotes the target while demoting the actor to `admin`.
- Workspace deletion is owner-only and refuses personal workspaces. It requires an exact trimmed-name confirmation, then hard-deletes links, clicks, invitations and memberships; the UI removes the workspace locally and falls back to another membership.
- Link queries always include the active workspace (or the legacy token digest). Never fetch by code first and check membership afterward in application code.
- `is_blocked` is operator-owned and not writable through any public API, regardless of role.

## Invitations

- Invitations are `shri_` capabilities. Only a SHA-256 digest is stored; the raw token appears once in the create response and must be copied by the inviter because there is no email delivery.
- TTL is 7 days. Expired, revoked or accepted invitations return `404 invitation_not_found`. Acceptance locks the row and is idempotent for an existing member.
- Acceptance requires a signed-in account. An optional `invited_email` is recorded for the inviter's reference but is **not enforced** on acceptance in v1; whoever holds the token can join. Bind and share accordingly, and treat the invite link as a secret.
- Preview is intentionally available to anyone holding the token and reveals workspace name, role, inviter and expiry. Do not add private metadata to that payload.
- Admins/owners can revoke pending invitations. Removing a member takes effect on their next request because authorization is not cached.

## Legacy anonymous capabilities

- Legacy links created before accounts have `workspace_id IS NULL` and a 32-byte management token; only HMAC-SHA256 plus a key version is stored. New links always belong to a workspace and have no management token.
- Verify tokens against Postgres in constant time; fail closed on database/auth failure. Never authorize from a cached redirect payload.
- Require `X-Management-Token` over HTTPS; never put tokens in routes, query strings, browser history, query keys, logs or traces.
- Default legacy frontend storage is memory. Explicit opt-in may remember on this device; show/reveal/copy during creation and warn that losing all copies loses management.
- No silent auto-save of credentials; storage failure cannot hide a successful response. Clear private query data on token replacement/rejection/forget, including cross-tab events.
- A supplied workspace session or legacy token selects the authorization path. Never combine both, and never fall back from an invalid credential to public or workspace access.

### Replay storage exception

An idempotency key can replay a creation response for 24 hours. Require random UUIDv4, redact it, store its digest only, and encrypt the complete replay response with AEAD and a separate versioned key. Commit replay and link in the same DB transaction. For legacy links, the encrypted response contains the management token; workspace responses contain no reusable credential. The replay row cascades with its link.

Enforce TTL on reads, purge rows in bounded jobs, and retire old replay keys after their live windows. Document backup retention; deleting a live row does not erase all backups. Keep old decryption keys only as long as needed for permitted replays. An exposed replay key can disclose a legacy token even if no link-management call has occurred.

## Abuse and urgent takedown

Implemented limits are per-IP or per-account and fail closed when Redis is unavailable:

| Operation | Limit |
| --- | --- |
| Signup | 10 per hour per IP |
| Login | 30 per minute per IP and 10 per minute per email |
| Password change | 10 per hour per user |
| Invite preview | 60 per minute per IP |
| Workspace creation | 10 per hour per user |
| Link creation, authenticated | 60 per minute per workspace |
| Link creation, legacy anonymous | 20 per minute per IP |
| Redirect | 600 per minute per IP |

- These are burst limits, not durable abuse protection. Add durable global/per-code daily create caps and per-code management-attempt caps before broad public launch.
- Apply limits to failed management attempts, not only successful ones, so tokens cannot be brute-forced.
- Trust only platform-overwritten IP metadata; arbitrary forwarded headers are attacker input. Per-IP budgets are not identity/authentication, and shared NAT can affect multiple users.
- Publish reporting/security contact details before public creation opens. Do not publish placeholder contact addresses.
- For immediate malicious-code revocation, apply and verify a deny rule across every backend hostname, then commit `is_blocked` and invalidate. Without a suitable edge control, document the redirect-cache TTL of stale risk or use authoritative DB checks; do not claim zero delay.
- Maintain an auditable erasure procedure for accounts, destinations and events, retaining only a code tombstone where necessary to prevent reuse. Account deletion is not exposed in v1; any operator procedure must handle shared workspaces deliberately.
- Automated reputation scanning is deferred, not a release control already present.

## HTTP and browser security

- All API/private/redirect/error responses: `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`.
- Redirects: `Referrer-Policy: no-referrer`; HTML errors escape output and prohibit framing.
- Exact CORS origins with credentials. Distinguish approved preview origins from arbitrary `*.vercel.app` deployments. CORS does not authenticate an API client.
- Enforce a 64 KiB body cap before processing; return `413` for oversized declared bodies. Validate schema lengths, unknown fields, date bounds and request IDs.
- No debug mode or interactive docs in production. OpenAPI remains public; security never depends on hiding it.
- Start HSTS only after HTTPS validation; `includeSubDomains` and preload require domain-owner review and must not be copied blindly.
- The SPA uses a reviewed CSP, no unsafe HTML injection, no unapproved third-party scripts and `noopener noreferrer` for external links. Inline style allowance does not justify inline script execution. An XSS that runs on the web origin can issue authenticated requests even though it cannot read the `HttpOnly` cookie.
- Framework validation errors must remove raw `input` values before logging/responding; request bodies, destinations, passwords, cookies, session tokens and replay headers are always redacted.

## Privacy and retention

Accounts add durable personal data: email, display name, password hash, memberships and sessions. Collect only what the product needs; document the launch jurisdiction's notice, lawful basis and deletion rights. Password hashes and session digests are sensitive even though the raw secrets are absent.

Rich analytics need event time, country, referrer origin, device category and bot classification—not persistent IP hashes. Raw IP is transient limiter input only; rate-limit keys expire and are not logged or correlated with analytics. Store no raw UA in Postgres and no referrer path/query/fragment anywhere in durable events.

Stream UA is bounded and short-lived; malformed diagnostics contain only IDs/reasons. Proposed retention: raw events 90 UTC days, totals two years, replay responses 24 hours, sessions 30 days, invitations 7 days or until consumed, and redacted diagnostics at most seven days. Aggregate or pseudonymous data may still be personal data; hashing alone does not make information anonymous.

Review destination URLs too: they can contain personal data or access credentials. Limit database/backup access, prohibit logging full targets, and define retention after deletion. Do not assert that first-party cookies are exempt from privacy obligations.

## Secrets and software supply chain

[Deployment](deployment.md#environment-settings) defines exact names, including unprefixed `CRON_SECRET`. Separate runtime DML and migration DDL roles, isolated preview data, TLS certificate verification, versioned pepper/encryption keys and a dedicated limiter key. A telemetry DSN may be a public ingestion identifier; do not confuse it with privileged API credentials.

Use frozen lockfile installs, dependency audits and secret scanning. Ruff `B` is **flake8-bugbear**, not Bandit; security rules use the `S` family and require an intentional configuration/test review. Verify the current Ruff selection in `backend/pyproject.toml` before claiming which rules are active; no lint rule substitutes for a threat model.

## Release security gates

- [x] Argon2id password hashing, uniform login failures, opaque hashed sessions and cookie flags implemented.
- [x] Cookie CSRF origin check, exact credentialed CORS and workspace RBAC implemented and browser-tested locally.
- [x] Invitation tokens hashed at rest with TTL and revocation; acceptance requires a session.
- [x] Legacy management tokens remain HMAC-verified, workspace links store no token, and authorization paths are exclusive.
- [ ] URL/parser adversarial tests, reserved generated codes and HEAD no-event behavior.
- [ ] Token isolation, encrypted replay concurrency/crash tests and key rotation.
- [x] Password change revokes every other session while preserving the current one; session listing, per-session revoke and revoke-others verified.
- [x] Workspace rename/delete/transfer RBAC, cross-tenant `404`s, exact-name confirmation and ownership swap verified in production.
- [ ] Role-change revocation policy, brute-force alerting and durable per-code caps.
- [ ] No sensitive content in application/validation/access/error telemetry; vendor log settings reviewed.
- [ ] Private-cache clearing on workspace/session change, logout and cross-tab events verified end to end.
- [ ] Fail-closed auth/management and bounded fail-open redirect overload tests.
- [ ] Operator takedown on all hosts, account-erasure procedure and backup restore drill.
- [ ] Retention and scheduler auth active before collecting production events.
- [ ] Dependency/secret scans and privacy review complete; documented exceptions accepted explicitly.
