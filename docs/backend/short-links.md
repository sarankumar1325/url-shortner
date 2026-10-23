# Short-Link Strategy

Status: target design · Related: [Data model](data-model.md) · [API](api.md) · [ADR 0003](../adr/0003-short-code-strategy.md)

## Goals

- Allocate a unique code for every link without a central counter or coordination between serverless instances.
- Keep the redirect lookup to a single indexed equality match.
- Make link enumeration impractical.
- Allow human-readable custom aliases without weakening uniqueness.
- Keep the namespace safe from collisions and reserved routes.

## Generated codes

| Property | Value |
| --- | --- |
| Alphabet | Base62: `0-9A-Za-z` |
| Length | 7 characters |
| Namespace size | `62^7 = 3,521,614,606,208` (about 3.5 trillion) |
| Case sensitivity | Yes |
| Source of randomness | `secrets` (CSPRNG) |
| Uniqueness mechanism | Unique constraint on `urls.short_code` + bounded retry |

```python
import secrets
import string

ALPHABET = string.ascii_letters + string.digits
CODE_LENGTH = 7


def generate_code() -> str:
    return "".join(secrets.choice(ALPHABET) for _ in range(CODE_LENGTH))
```

`secrets.choice` uses rejection sampling internally, so the distribution over the 62 symbols is uniform. Do not use `random`.

### Collision handling

Uniqueness is enforced by the database, not by a pre-flight `SELECT`, which would race.

```python
for attempt in range(1, MAX_ATTEMPTS + 1):
    code = generate_code()
    try:
        async with transaction():
            link = await repository.insert_link(code=code, ...)
        return link
    except UniqueViolation:
        metrics.increment("link.code_collision", tags={"attempt": attempt})
        continue

raise CodeSpaceExhausted()
```

Behavior:

- Generated codes retry up to 5 times with a fresh code.
- Custom aliases never retry; a conflict is a `409 alias_taken`.
- Exhausting retries is effectively impossible at v1 scale and returns `503 dependency_unavailable` with an alert.
- The raw unique-violation error is never exposed to the client.

### Capacity planning

Per-attempt collision probability is approximately `n / 62^7`, where `n` is the number of existing links.

| Existing links | Collision chance per attempt | Expected behavior |
| --- | --- | --- |
| 1 million | ~0.00003% | Effectively none |
| 100 million | ~0.0028% | About 1 retry per 35,000 creates |
| 1 billion | ~28% | Move to 8 characters or a key-generation service |

At 1 billion links, switch to 8 characters (`62^8 ≈ 2.18 × 10^14`) or a dedicated key-generation service (KGS). Both are described in ADR 0003.

## Custom aliases

Custom aliases are user-chosen codes such as `launch` or `system-design`.

| Rule | Value |
| --- | --- |
| Length | 3–32 characters |
| Alphabet | Lowercase `a-z`, digits `0-9`, `-`, `_` |
| Boundaries | Must start and end with a letter or digit |
| Regex | `^[a-z0-9](?:[a-z0-9_-]{1,30}[a-z0-9])?$` |
| Reserved words | Rejected; see below |
| Case | Must be supplied lowercase; uppercase is rejected rather than silently changed |
| Reuse | Never reused, even after delete |

Custom aliases share the `urls.short_code` namespace with generated codes. A generated code that happens to match an existing alias is treated as a collision and retried.

### Reserved aliases

```text
api, health, ready, docs, redoc, openapi.json, admin, login, logout, signup,
static, assets, favicon.ico, robots.txt, sitemap.xml, well-known, internal,
metrics, _next, graphql
```

Keep this list in one code-owned module and expose it to tests. New top-level routes must add their first path segment here before deployment.

## URL validation and normalization

Validation happens before code allocation.

**MUST**

- Accept only absolute `http` and `https` URLs.
- Reject credentials in the authority (`https://user:pass@host`).
- Reject control characters and leading/trailing whitespace (trim outer whitespace).
- Reject empty hosts.
- Enforce a maximum length of 8192 characters.
- Reject IP literals and hostnames that resolve to private, loopback, link-local, or reserved ranges by default (`ALLOW_PRIVATE_TARGETS=false`), including `localhost`, `.local`, and `.internal`.
- Normalize the scheme and host to lowercase and remove default ports.

**MAY**

- Preserve path case, query string order, and fragment exactly.
- Store the IDNA/punycode form of internationalized hostnames.

**MUST NOT**

- Fetch the destination in v1. No previews, screenshots, or metadata extraction.
- Rewrite the destination beyond the normalization above.
- Accept `javascript:`, `data:`, `file:`, `ftp:`, or other schemes.

The client may prepend `https://` when a user omits the scheme. The API does not guess; it rejects a scheme-less value with `400 invalid_url`.

## Expiry semantics

- Omitted or `null` means the link does not expire.
- `expires_at` must be in the future and at most 5 years ahead.
- Expiry is enforced on every redirect, even when a cached entry exists.
- Expired links return `410 Gone`; they are not deleted immediately.
- A daily cleanup may mark long-expired links inactive after a grace period, but the alias stays reserved.
- Updating `expires_at` invalidates the cache.

## Management tokens

Every link gets an independent token at creation.

| Property | Value |
| --- | --- |
| Raw token | 32 random bytes, URL-safe base64 (`secrets.token_urlsafe(32)`) |
| Entropy | 256 bits |
| Storage | `HMAC-SHA256(MANAGEMENT_TOKEN_PEPPER, token)` as 32 bytes |
| Returned | Once, in the `201` create response |
| Transport | `X-Management-Token` header over HTTPS |
| Comparison | Constant-time compare after lookup |
| Logging | Never logged, never included in URLs, never stored client-side by the server |

The token authorizes one link. It does not identify a user and cannot list other links. Future account auth is orthogonal: an authenticated owner may manage links without a per-link token.

## Redirect lookup

```sql
SELECT id, long_url, is_active, expires_at, deleted_at
FROM urls
WHERE short_code = $1;
```

- The unique index makes this a single index lookup.
- The cached representation carries `is_active` and `expires_at`, so expiry can be evaluated without a database round trip.
- A missing row is negatively cached for 30 seconds to absorb scans without letting alias creation be invisible for long.
- The code is case-sensitive; `/Sysdesign` and `/sysdesign` are different paths. Custom aliases are always lowercase to reduce confusion.

## Future extensions

- **QR codes** render the short URL; no schema change.
- **Custom domains** add a `domains` table and make uniqueness `(domain_id, short_code)`.
- **Bulk creation** reuses the same allocation path with a batch transaction and per-item results.
- **Link-in-bio pages** become a new target type rather than a special code format.
- **Accounts** populate `owner_id` and add listing indexes; the token model remains valid for anonymous links.

## Test checklist

- Generated codes are 7 Base62 characters and pass the database check.
- All 62 symbols are reachable in distribution tests.
- Collisions retry and eventually succeed; exhaustion is mapped to a controlled error.
- Alias conflicts return `409` and do not consume a generated code.
- Reserved aliases are rejected in every case.
- Uppercase aliases are rejected.
- Private targets are rejected by default and allowed only when configured.
- Token hashes are stable, 32 bytes, and never equal the raw token.
- Expired cached links are not redirected.
