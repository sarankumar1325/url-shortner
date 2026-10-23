# ADR 0005: Per-Link Anonymous Management Capabilities

Status: Accepted direction; replay/storage/security semantics refined · Reviewed: 2026-10-23

## Decision

Issue a random 256-bit URL-safe token per link. Store HMAC-SHA256 plus key version on the link row, verify in constant time, and transport it in `X-Management-Token` over HTTPS. It authorizes metadata, mutation and analytics for that link, never a global listing.

Keep the token in browser memory by default. Explicit opt-in can remember it on this device. During creation, provide an accessible reveal/copy step and warn that losing every copy loses management access. Storage failure must not hide the successful result; paste-token UX restores possession, not a server recovery service.

## Explicit replay exception

The original token can be returned again with the **same required UUIDv4 creation key** for 24 hours. Therefore "shown once" means creation flow only, not literally one network response, and the system is not wholly hash-only at rest.

Commit link and AEAD-encrypted replay response in one Postgres transaction. The key is another sensitive capability; store its digest, redact it, bind ciphertext to request/key digests, and use a separate versioned encryption key. Enforce expiry at read time and clean up rows/keys with backup-retention consequences documented.

## Consequences and controls

- Anonymous management avoids identity infrastructure but has no account recovery or automatic cross-device sync.
- LocalStorage is exposed to XSS; opt-in does not make it secure against scripts. Enforce CSP, no unsafe HTML, no unapproved third-party code, no tokens in URLs/logs/query keys.
- Private Query caches must be scoped by a non-secret credential generation and canceled/removed when a token changes, is rejected or forgotten, including cross-tab changes. Never show old authorized data after credentials disappear.
- All API responses use `no-store`; custom auth headers alone do not stop shared caching.
- Hash versions permit transitional pepper rotation and rehash on successful authentication. Retiring a compromised pepper can invalidate remaining tokens; that is an explicit incident decision, not routine cleanup.
- Deleted links lose management/analytics access; valid-token repeated DELETE alone remains `204`. Operators can block independently, and token holders cannot unblock.

## Alternatives and future identity

Full accounts/magic links add identity/recovery infrastructure beyond v1. Immutable links omit needed corrections/deletion. Stateless JWTs complicate revocation without eliminating browser storage risks. Tokens in fragments still leak via sharing/history and are not the default UX.

When accounts ship, add a users table and nullable owner FK in an additive migration, then a token-proven claim flow if needed. No unused user table/column is required now. Per-link token rotation can be designed alongside authenticated recovery; do not imply it already exists.

## References

[API replay/auth](../backend/api.md) · [Security](../backend/security.md) · [Frontend storage](../frontend/data-fetching.md) · [Data model](../backend/data-model.md)
