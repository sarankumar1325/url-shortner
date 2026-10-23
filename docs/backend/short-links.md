# Short-Link Strategy

Status: target design · Related: [API](api.md) · [Data model](data-model.md) · [ADR 0003](../adr/0003-short-code-strategy.md)

## Generated codes

- Generate 7 case-sensitive Base62 characters using `secrets.choice`.
- Namespace: `62^7 = 3,521,614,606,208`; entropy: about 41.7 bits.
- Enforce uniqueness in Postgres, including soft-deleted codes. Never recycle codes.
- Reserve service routes for generated codes as well as custom aliases.
- Randomness discourages sequential enumeration; a short code is public, NOT an authorization secret.

```python
import secrets
import string

ALPHABET = string.ascii_letters + string.digits


def generate_code() -> str:
    return "".join(secrets.choice(ALPHABET) for _ in range(7))
```

### Collision handling

Use `INSERT ... ON CONFLICT (short_code) DO NOTHING RETURNING ...`. Retry a generated-code conflict up to five times; a custom alias conflict returns `409 alias_taken`. Do not catch every integrity error as a collision: token, foreign-key, or schema failures are different faults. If using exceptions, roll back to a savepoint before retrying inside the create transaction.

No pre-flight existence query guarantees uniqueness. The create transaction also persists the idempotency result described in [api.md](api.md#idempotent-creation).

### Capacity and enumeration

For `n` occupied generated-format codes, per-attempt collision probability is `n / 62^7`.

| Occupied codes | Collision probability | Approximate creates per retry |
| --- | --- | --- |
| 1 million | 0.0000284% | 3,521,615 |
| 100 million | 0.00284% | 35,216 |
| 1 billion | 0.0284% | 3,522 |

The probability of *any* collision over many allocations is much higher (birthday effect); retries are required from day one. At one million allocations, that probability is about 13.2%. This is not namespace exhaustion.

For enumeration, a guess hits *any* occupied code with probability `n / 62^7`, not `1 / 62^7`. Never market random links as private. Restrict sensitive content at the destination; protect management with the separate 256-bit token.

Review code length when measured retries exceed 0.1%, or abuse analysis warrants more entropy; one billion rows alone does not require a KGS. Moving future generated codes to 8 characters can preserve all existing codes. A database sequence could allocate an ID in the same insert, but publicly encoding it would reveal ordering and aid enumeration.

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

Implement `HEAD /{code}` explicitly: same status and headers as GET, empty body, **no click event**. Invalid codes must never fall through to the frontend SPA. Error responses also use `no-store` so a missing code is not cached by clients before creation.

## Management tokens

Use `secrets.token_urlsafe(32)` and a constant-time comparison of HMAC-SHA256 digests. Store a hash version alongside the digest; current/previous peppers allow controlled rotation without invalidating everyone at once. Tokens authorize a single link, not a user or a listing endpoint.

The token is revealed during creation and replayed only for that same creation key within 24 hours. This requires the short-lived encrypted replay record in [data-model.md](data-model.md); it is not hash-only storage across the whole system. Tokens, replay keys, and decrypted responses never enter logs, URLs, metrics, or traces.

## Cache contract and tests

[Cache policy](caching-and-scale.md) is authoritative: no negative cache in v1, positive cache age at most 60 seconds, best-effort invalidation after mutation. This is bounded staleness, not immediate revocation.

Required tests: exact alias boundaries (1/2/3/32/33 characters), reserved generated codes, forced collisions, simultaneous creates, expiry at the boundary, disable/delete precedence, HEAD without analytics, IPv4/IPv6/IDNA/control-character validation, and token replay/rotation. Use deterministic randomness in tests rather than flaky distribution assertions.
