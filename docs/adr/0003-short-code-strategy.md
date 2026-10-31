# ADR 0003: Random Base62 Codes with Collision Retry

Status: Accepted; shortened to 5 characters on 2026-10-24; numerical guidance corrected · Reviewed: 2026-10-24

## Decision

Use CSPRNG-generated 5-character case-sensitive Base62 codes, a case-sensitive unique Postgres constraint, and up to five generated-code retries. Existing 7-character codes remain valid. Custom aliases are lowercase, 3–32 characters, sharing the same namespace. Both allocation paths reject reserved service routes; codes are never recycled.

## Correctness and capacity

`62^5 = 916,132,832`, about 29.8 bits. Per-attempt collision probability at one million occupied codes is **0.109%** (about one retry per 916 creates), and about 10.9% at one hundred million. Birthday collisions occur earlier over a population of allocations; database retry logic is required from the first release and absorbs them.

The shorter code was chosen for copy-paste usability. Because the namespace is about 3,840× smaller than the previous 7-character one, retry rates grow sooner. Revisit the length if single-attempt collisions approach 10% (roughly 90 million occupied codes) or if allocation retries become operationally significant. Longer future generated codes can coexist with existing ones after a compatible validator/schema change.

The same occupancy ratio measures the chance of guessing *any* occupied generated code. Random codes reduce sequential enumeration but are not private capabilities. New links are protected by workspace membership; legacy unowned links use a separate 256-bit token (see [ADR 0006](0006-accounts-and-workspaces.md)).

## Alternatives and tradeoffs

A sequence can return its ID in the same insert; it does not inherently require a second network call or imply an immediate bottleneck. However, directly Base62-encoding a sequence leaks ordering and eases enumeration. A separate KGS adds operational coordination with no demonstrated need.

Deterministically hashing destinations couples links with the same target and still requires collision handling. UUID text is longer than desired. NanoID with a chosen alphabet could implement a similar design; standard-library `secrets` is sufficient here. Reversible obfuscation is not authorization.

Atomic [creation replay](../backend/api.md#idempotent-creation), rather than deterministic codes, handles client retries. Only conflicts on the code constraint should trigger allocation retry; other integrity failures must not be swallowed.

## References

[Calculations and alias grammar](../backend/short-links.md) · [Data model](../backend/data-model.md)
