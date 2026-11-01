# Short-Link Strategy

Status: implemented; ownership now workspace-based for new links, with legacy token access retained · Related: [API](api.md) · [Data model](data-model.md) · [ADR 0003](../adr/0003-short-code-strategy.md) · [ADR 0006](../adr/0006-accounts-and-workspaces.md)

## Generated codes

- Generate 5 case-sensitive Base62 characters using `secrets.choice`.
- Namespace: `62^5 = 916,132,832`; entropy: about 29.8 bits. Existing 7-character codes remain valid.
- Enforce uniqueness in Postgres, including soft-deleted codes. Never recycle codes.
- Reserve service routes for generated codes as well as custom aliases.
- Randomness discourages sequential enumeration; a short code is public, NOT an authorization secret.

```python
import secrets
import string

ALPHABET = string.ascii_letters + string.digits


def generate_code() -> str:
    return "".join(secrets.choice(ALPHABET) for _ in range(5))
```

### Collision handling

Use `INSERT ... ON CONFLICT (short_code) DO NOTHING RETURNING ...`. Retry a generated-code conflict up to five times; a custom alias conflict returns `409 alias_taken`. Do not catch every integrity error as a collision: token, foreign-key, or schema failures are different faults. If using exceptions, roll back to a savepoint before retrying inside the create transaction.

No pre-flight existence query guarantees uniqueness. The create transaction also persists the idempotency result described in [api.md](api.md#idempotent-creation).

### Capacity and enumeration

For `n` occupied generated-format codes, per-attempt collision probability is `n / 62^5`.

| Occupied codes | Collision probability | Approximate creates per retry |
| --- | --- | --- |
| 100,000 | 0.0109% | 9,161 |
| 1 million | 0.109% | 916 |
| 10 million | 1.09% | 92 |
| 100 million | 10.9% | 9.2 |

The probability of *any* collision over many allocations is much higher (birthday effect); retries are required from day one. At one million allocations, the expected number of collisions is about 546. Each is absorbed by the unique constraint and retry, so the operational cost is close to one extra insert per collision — not a failed request. Five retries are ample well beyond this scale; revisit the length when single-attempt collisions approach 10%.

For enumeration, a guess hits *any* occupied code with probability `n / 62^5`, not `1 / 62^5`. Never market random links as private. Restrict sensitive content at the destination; protect management with workspace membership or, for legacy links, the separate 256-bit token.

Longer future generated codes can coexist with existing ones after a compatible validator/schema change; the database constraint accepts both the current 5-character and legacy 7-character formats. A database sequence could allocate an ID in the same insert, but publicly encoding it would reveal ordering and aid enumeration.

## Custom aliases

| Rule | Value |
| --- | --- |
| Length | 3–32 characters |
| Grammar | `^[a-z0-9][a-z0-9_-]{1,30}[a-z0-9]$` |
| Case | Lowercase only; reject uppercase rather than changing it |
| Ownership | Same unique namespace as generated codes |
| Reuse | Never, including deleted or expired links |

Reserved path segments (case-insensitive comparison):

```text
api, health, ready, docs, redoc, openapi.json, admin, login, logout, signup,
invite, invitations, workspaces, members, settings,
static, assets, favicon.ico, robots.txt, sitemap.xml, .well-known, well-known,
internal, metrics, _next, graphql
```

Some reserved segments already fail the alias grammar. Keep them in the route policy nonetheless. Register fixed routes before `/{code}` and apply reserved checks to both allocation paths.

## Destination validation

The backend owns canonical validation. The browser repeats it only for user feedback.

- Accept absolute `http`/`https` URLs only, maximum 8192 characters **after serialization**, within the 64 KiB JSON body limit.
- Reject userinfo, missing hosts, raw control characters (including CR/LF), backslashes, and outer whitespace. The UI may visibly trim before submission.
- Normalize scheme/host case, IDNA hostname encoding, and default ports. Preserve path case, query ordering, and fragment semantics; test signed URLs to avoid breaking them.
- Reject loopback, private, link-local, multicast, unspecified, and reserved IP literals, including IPv4-mapped IPv6 and ambiguous noncanonical numeric IP spellings.
- Reject `localhost`, its subdomains, and `.local`/`.internal` names; normalize trailing dots before hostname checks.
- Reject targets on the configured redirect/API hosts to avoid self-shortening loops. Other redirect chains are not crawled.
- Do not resolve DNS or fetch destinations in v1. Arbitrary public-looking hostnames may later resolve to private addresses: syntactic filtering is abuse reduction, **not DNS-rebinding protection or a malware verdict**.

A future preview/scanner must validate every resolved address and redirect hop, constrain egress, and enforce response/time/size limits. That is a separate security review, not a reason to add DNS/network work to v1 creation.

## Link state and redirect semantics

Evaluate current/cached state in this order:

1. Missing, deleted, blocked, or manually inactive → `404`.
2. Otherwise expired (`expires_at <= now`) → `410`.
3. Otherwise → `302` with `Location`, `Cache-Control: no-store`, and `Referrer-Policy: no-referrer`.

Expiry is independent of active state; cleanup MUST NOT turn expired rows inactive and silently change `410` to `404`. Future expiry is at most five years away; `null` clears expiry. Authorized management can inspect or extend an expired link.

Before step 3, two optional link features apply:

- **Password:** a link with `password_hash` redirects only with a valid `shortly_unlock` cookie; otherwise GET shows a password page or `401 password_required`, and HEAD returns `401`. The visit limit is checked but not spent while locked. If the link is expired or used up and has a fallback, the visitor goes to the fallback without a password.
- **Smart redirects:** the `302` target is the first matching `redirect_rules` entry for the visitor's device traits and `x-vercel-ip-country`, else `long_url`. Link previewers always get `long_url`, and fallbacks skip the rules.

See [API](api.md#password-protected-links) for the unlock flow and rule format.

Implement `HEAD /{code}` explicitly: same status and headers as GET, empty body, **no click event**. Invalid codes must never fall through to the frontend SPA. Error responses also use `no-store` so a missing code is not cached by clients before creation.

## Management and ownership

New links are created by an authenticated workspace member and store `workspace_id` plus `created_by_user_id`; they have no management token. Authorization is membership resolved from Postgres on every request, using `X-Workspace-Id` (or the caller's personal workspace when omitted). Roles: `viewer` reads, `member` creates/updates/deletes, `admin` also manages people, `owner` manages admins. A non-member workspace is `404`, not `403`.

Legacy links created before accounts have `workspace_id IS NULL` and retain the per-link capability:

- Generate `secrets.token_urlsafe(32)` and compare HMAC-SHA256 digests in constant time. Store a hash version alongside the digest; current/previous peppers allow controlled rotation without invalidating every token at once.
- Tokens authorize a single link, not a user or a listing endpoint, and are never combined with workspace access.
- The token is revealed during creation and replayed only for that same creation key within 24 hours. This requires the short-lived encrypted replay record in [data-model.md](data-model.md); it is not hash-only storage across the whole system.
- Tokens, replay keys, and decrypted responses never enter logs, URLs, metrics, or traces.

List endpoints are workspace-scoped only; there is no public listing.

## Cache contract and tests

[Cache policy](caching-and-scale.md) is authoritative: no negative cache in v1, positive cache age at most 60 seconds, best-effort invalidation after mutation. This is bounded staleness, not immediate revocation.

Required tests: exact alias boundaries (1/2/3/32/33 characters), reserved generated codes, forced collisions, simultaneous creates, expiry at the boundary, disable/delete precedence, HEAD without analytics, IPv4/IPv6/IDNA/control-character validation, workspace membership/RBAC denial, and legacy token replay/rotation. Use deterministic randomness in tests rather than flaky distribution assertions.
