# ADR 0003: Random Base62 Codes with Collision Retry

Status: Accepted; numerical/capacity guidance corrected · Reviewed: 2026-10-23

## Decision

Use CSPRNG-generated 7-character case-sensitive Base62 codes, a case-sensitive unique Postgres constraint, and up to five generated-code retries. Custom aliases are lowercase, 3–32 characters, sharing the same namespace. Both allocation paths reject reserved service routes; codes are never recycled.

## Correctness and capacity

`62^7 = 3,521,614,606,208`, about 41.7 bits. Per-attempt collision probability at one billion occupied codes is **0.0284%**, not 28%. Birthday collisions can occur much earlier over a population of allocations; database retry logic is required from the first release.

The same occupancy ratio measures the chance of guessing *any* occupied generated code. Random codes reduce sequential enumeration but are not private capabilities. Management uses a separate 256-bit token.

Review code length when measured collision retries exceed 0.1% or abuse analysis requires additional entropy; do not require a KGS just because the catalogue hits an arbitrary row count. Longer future generated codes can coexist with existing ones after a compatible validator/schema change.

## Alternatives and tradeoffs

A sequence can return its ID in the same insert; it does not inherently require a second network call or imply an immediate bottleneck. However, directly Base62-encoding a sequence leaks ordering and eases enumeration. A separate KGS adds operational coordination with no demonstrated need.

Deterministically hashing destinations couples links with the same target and still requires collision handling. UUID text is longer than desired. NanoID with a chosen alphabet could implement a similar design; standard-library `secrets` is sufficient here. Reversible obfuscation is not authorization.

Atomic [creation replay](../backend/api.md#idempotent-creation), rather than deterministic codes, handles client retries. Only conflicts on the code constraint should trigger allocation retry; other integrity failures must not be swallowed.

## References

[Calculations and alias grammar](../backend/short-links.md) · [Data model](../backend/data-model.md)
