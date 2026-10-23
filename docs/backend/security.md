# Security and Abuse Prevention

Status: target design · Related: [API](api.md) · [Deployment](deployment.md)

## Threat model

| Threat | Impact | Primary mitigation | Residual risk |
| --- | --- | --- | --- |
| Phishing or malware distribution through short links | Reputation, user harm | Rate limits, URL validation, abuse reporting, Safe Browsing integration later | Shorteners are attractive to abusers; monitoring is required |
| Enumeration of links | Privacy, scraping | Random 7-char codes, no public listing, rate limits, negative caching | Codes can be guessed at a low rate; 62^7 space makes it impractical |
| Denial of service | Outage, cost | Vercel WAF/firewall, per-scope rate limits, timeouts, bounded request sizes | Large volumetric attacks are handled upstream |
| Management token theft | Link takeover | 256-bit tokens, HTTPS only, hash at rest, no logging, rate limits | Client storage (localStorage) is exposed to XSS |
| Open-redirect misuse | Users redirected to malicious sites | Only `http`/`https`, no credentials, private-target blocking, abuse controls | The product is intentionally an open redirector |
| SQL injection | Data breach | SQLAlchemy parameterized queries, no string-built SQL | Low |
| XSS through URLs or aliases | Session/token theft | Output encoding, no `innerHTML`, strict CSP on the web app | Low |
| Cache poisoning | Redirect to attacker target | Cache keys from validated codes; values only from Postgres | Low |
| SSRF (future previews) | Internal network access | Do not fetch destinations in v1; block private ranges if fetching is added | Future feature must re-review |
| Secret leakage | Full compromise | Vercel env vars, least-privilege roles, no secrets in logs or client bundle | Operational discipline |
| Supply-chain compromise | Code execution | Lockfiles, dependency review, `pip-audit`, Dependabot | Ecosystem risk |

## URL validation

The API is an open redirector by design, but it MUST only redirect to well-formed public web URLs.

**MUST**

- Allow only `http` and `https`.
- Reject credentials in the URL authority.
- Reject control characters, embedded NULs, and whitespace around the value.
- Reject private, loopback, link-local, and reserved IP literals by default.
- Reject `.localhost`, `.local`, and `.internal` hostnames by default.
- Enforce 8192 characters maximum.
- Normalize scheme and host casing; remove default ports.
- Reject unsupported schemes before any code allocation.

**SHOULD**

- Reject URLs whose host is a bare IP literal unless the environment explicitly allows it.
- Log only the short code and error code, never the full rejected URL.
- Re-run validation on update, not only create.

Private-target blocking is controlled by `ALLOW_PRIVATE_TARGETS`, default `false`. Enabling it is intended only for internal deployments and must never be enabled on the public service.

## Abuse controls

1. **Rate limits** on create, redirect, metadata, and analytics (see [caching-and-scale.md](caching-and-scale.md)).
2. **Random codes** to resist enumeration.
3. **No public listing** of links or aliases.
4. **Reserved aliases** to protect service routes.
5. **Vercel WAF/firewall** for volumetric and signature-based attacks.
6. **Abuse contact** in `/.well-known/security.txt` and the site footer.
7. **Blocklist** maintained operationally; a future `is_blocked` status can quarantine destinations.
8. **Safe Browsing** integration as an asynchronous check after creation, with quarantine on a hit.

A blocked or quarantined link returns `410` without redirecting. Blocking must be possible without a deploy.

### What we deliberately do not do in v1

- Fetch or render destination pages. This avoids SSRF and preview-based data leakage.
- Scan every destination synchronously. It would add latency and an external dependency to creation.
- Require accounts for creation. Abuse is managed with rate limits and monitoring instead.

## Management tokens

- 256-bit entropy via `secrets.token_urlsafe(32)`.
- Stored as `HMAC-SHA256(pepper, token)`; the pepper is a Vercel secret.
- Compared with `hmac.compare_digest` after lookup.
- Sent only over HTTPS in the `X-Management-Token` header.
- Never placed in URLs, logs, analytics, or error responses.
- Returned once; there is no recovery mechanism in v1.
- Rate-limited through the analytics/metadata scopes to slow guessing.
- A future account system can rotate or revoke tokens; v1 has no rotation endpoint.

**Pepper rotation**: rotating `MANAGEMENT_TOKEN_PEPPER` invalidates every existing token. To rotate safely, store a `token_hash_version` on `urls`, keep the previous pepper during a transition, and re-hash on next successful use. V1 should treat pepper rotation as a breaking maintenance operation.

## API hardening

- **CORS**: exact allowlist, no `*`, no credentials in v1.
- **Body limits**: reject request bodies above 16 KB at the edge/application boundary.
- **Timeouts**: Redis 200 ms, redirect DB 2 s, create DB 5 s, total function budget below the Vercel limit.
- **Error responses**: Problem Details with `request_id`; no stack traces, SQL, internal hostnames, or dependency details.
- **Validation**: Pydantic models for every input; query parameter ranges bounded.
- **Methods**: explicit methods per route; no catch-all handlers.
- **Docs**: `/docs` and `/redoc` disabled when `ENVIRONMENT=production`.
- **OpenAPI**: schema is public; it contains no secrets.
- **Headers** on API responses:
  - `X-Content-Type-Options: nosniff`
  - `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`
  - `Referrer-Policy: no-referrer` on redirects
  - `X-Frame-Options: DENY` or CSP `frame-ancestors 'none'` on HTML error pages
  - `Permissions-Policy: geolocation=(), microphone=(), camera=()`
- **Redirect responses**: `X-Robots-Tag: noindex, nofollow` and a minimal body.
- **Cron endpoint**: bearer secret, constant-time comparison, no data returned beyond counts.

## Data protection

- **In transit**: HTTPS everywhere; TLS to Neon and Upstash.
- **At rest**: Neon and Upstash encryption; no application-level encryption in v1.
- **PII minimization**: no raw IPs, no cookies, referrer query strings stripped, country-level geo only.
- **Logs**: no raw tokens, no long URLs, no IP addresses. Request logs include short codes and status codes only.
- **Retention**: raw clicks 90 days, rollups 2 years, idempotency responses 24 hours.
- **Deletion**: soft delete in v1; a future account-level deletion flow hard-deletes and cascades clicks.

## Secrets management

| Secret | Purpose | Rotation |
| --- | --- | --- |
| `DATABASE_URL` | Neon pooled connection | On credential compromise; Neon supports role rotation |
| `REDIS_URL` / Upstash token | Cache, limits, stream | On compromise; deploy new token |
| `MANAGEMENT_TOKEN_PEPPER` | Token hashing | Breaking; requires versioned hashes |
| `ANALYTICS_IP_SALT` | IP hashing | Quarterly; correlation resets |
| `CRON_SECRET` | Internal drain auth | Quarterly or on compromise |
| `SENTRY_DSN` (optional) | Error reporting | On compromise |

Rules:

- Secrets live only in Vercel environment variables, never in the repository.
- `.env` files are gitignored; `.env.example` contains placeholders only.
- Preview and production use separate credentials and databases.
- Database application roles have DML only; migrations use a separate role.
- Rotate any secret that appears in logs, screenshots, or a public artifact.

## Frontend security contract

- The web app never receives database or Redis credentials.
- `VITE_*` variables are public by definition; only the API base URL and public short domain are exposed.
- Management tokens are stored client-side by explicit user action and are vulnerable to XSS. The frontend therefore enforces a strict CSP and never injects URLs as HTML. See [ui-and-a11y.md](../frontend/ui-and-a11y.md).

## Secure development

- `ruff` with security-relevant rules (`B` bandit subset) in CI.
- `pip-audit` (or `uv audit` when available) on the lockfile.
- Dependabot/Renovate for Python and Bun dependencies.
- Integration tests for private-target rejection, token failures, rate limits, and expired links.
- Fuzz tests for URL parsing and custom alias validation.
- No `.env` or secret material in commits; secret scanning enabled on the repository.
- Threat-model review before adding URL fetching, previews, accounts, or custom domains.

## Incident response

1. Identify the abuse vector from logs and metrics without exposing user data.
2. Add a blocklist entry or tighten rate limits, ideally without a deploy.
3. Rotate affected secrets if credential exposure is suspected.
4. Notify stakeholders and, where required, affected users.
5. Write a short post-incident note with detection, impact, and prevention.

## Security checklist for release

- [ ] Private-target and scheme validation tests pass.
- [ ] Reserved aliases cannot be created.
- [ ] Management tokens are never logged or returned after creation.
- [ ] CORS allowlist contains only known origins.
- [ ] Rate limits are enabled on create and redirect.
- [ ] Security headers are present on API and redirect responses.
- [ ] `/docs` is disabled in production.
- [ ] Production secrets differ from preview secrets.
- [ ] Dependency audit is clean or exceptions are documented.
- [ ] Abuse contact is published.
