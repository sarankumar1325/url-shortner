# ADR 0003: Random Base62 Codes with Collision Retry

- Status: Accepted
- Date: 2026-10-23

## Context

Every link needs a unique, short, URL-safe code. The service runs on stateless serverless functions, so there is no long-lived process to own an in-memory counter. The code should be hard to enumerate and should not require coordination between instances.

Options:

1. Random code with a database uniqueness check.
2. Key-generation service (KGS) using a database sequence, encoded to Base62.
3. Hash of the destination (deterministic).
4. UUID or NanoID.

## Decision

Generate **7-character Base62 codes** using a CSPRNG (`secrets`), relying on a **unique database constraint** and a **bounded retry** on conflict.

- Alphabet: `0-9A-Za-z` (62 symbols).
- Namespace: `62^7 ≈ 3.52 × 10^12`.
- Retries: 5 attempts per create.
- Custom aliases share the same namespace and are validated separately.
- If scale approaches one billion links, move to 8 characters or a KGS.

## Consequences

**Positive**

- No central counter or coordination; any function instance can generate a code.
- Enumeration requires guessing in a 3.5-trillion space.
- Codes are short and copy-friendly.
- The database unique index is the single source of truth; no race-prone pre-check.
- Custom aliases fit naturally into the same namespace.

**Negative**

- Collisions are possible and require handling.
- Codes are not deterministic; retrying a create without an idempotency key can produce a different link.
- Case-sensitive codes can be mistyped (`a` vs `A`).
- At extreme scale, the 7-character space becomes crowded.

**Mitigations**

- `ON CONFLICT`/unique-violation handling with a fresh code each retry.
- `Idempotency-Key` on create prevents accidental duplicates.
- Custom aliases are lowercase and validated; generated codes are copied, not typed.
- Capacity thresholds and a documented 8-character/KGS migration.

## Why not deterministic hashing?

Hashing the destination would make the same URL produce the same code, which leaks that two links share a destination and makes custom aliases and analytics separation awkward. It also does not remove collision handling.

## Why not a KGS now?

A KGS (for example, a Postgres sequence encoded to Base62) guarantees uniqueness without retries, but:

- It introduces a central write hotspot or sequence contention.
- It requires a database round trip before the insert unless batched.
- Random generation is simpler, fully stateless, and collision-free at v1 scale.

A database sequence is a reasonable upgrade if retry rates or code length become a problem. It can be introduced behind the existing `CodeGenerator` interface.

## Why not UUID / NanoID?

- UUIDs are too long for a short link.
- NanoID is functionally similar to the chosen approach; its default alphabet may include `-` and `_`, which are also valid in custom aliases. The project standardizes on Base62 for generated codes and a constrained alias grammar.
- Hashids is reversible and not a security mechanism; it also needs a numeric input.

## Capacity trigger

Move from 7 to 8 characters when expected active links exceed approximately **100 million**, or when collision retries exceed 0.1% of creates. Re-evaluate at one billion links.

## References

- [Short-link strategy](../backend/short-links.md)
- [Data model](../backend/data-model.md)
- [API contract](../backend/api.md)
