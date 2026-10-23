# ADR 0005: Per-Link Anonymous Management Tokens

- Status: Accepted
- Date: 2026-10-23

## Context

V1 has no user accounts, but anonymous users still need to:

- View analytics for a link they created.
- Change its destination or expiry.
- Delete it.

Requiring accounts would expand scope substantially. Making links immutable would make them hard to correct and would remove the management experience.

## Decision

Issue a **per-link management token** at creation:

- 32 random bytes, URL-safe base64 (256 bits).
- Returned exactly once in the `201` response.
- Stored as `HMAC-SHA256(pepper, token)`; the raw token is never stored or logged.
- Sent on management requests via `X-Management-Token`.
- Authorizes only that link.
- Stored by the web app in `localStorage` for convenience.

`urls.owner_id` remains nullable so future accounts can own links without a destructive migration.

## Consequences

**Positive**

- Anonymous users get full management without an account system.
- Tokens are high-entropy, unguessable, and revocable by deleting the link or rotating the pepper (with a maintenance impact).
- One token cannot access another link, limiting blast radius.
- Accounts can be added later without changing the anonymous path.
- No email, password, or identity infrastructure in v1.

**Negative**

- The user must save the token; losing it means losing management access.
- `localStorage` is readable by any script on the origin, so XSS becomes a token-theft vector.
- No cross-device access or recovery.
- Token rotation requires a pepper versioning strategy.
- Users may not understand that the management link/token is sensitive.

**Mitigations**

- Show the token once with a clear explanation and a copy action.
- Store only the hash server-side.
- Strict CSP, no HTML injection, and no third-party scripts on the app origin.
- Provide "paste token" recovery when local storage is empty.
- Provide "forget token" and "clear all" controls.
- Rate-limit management endpoints.
- Plan `token_hash_version` before rotating the pepper.

## Alternatives considered

### Immutable links

No token or ownership model, but users cannot fix typos, change destinations, or delete links. Poor product experience and worse abuse remediation. Rejected.

### Email magic links

Creates an email dependency and account-like flows without a full identity system. More scope than v1 needs. Rejected.

### Full accounts now

Solves recovery and cross-device access but adds auth UI, sessions, password/OAuth, email verification, and account data protection. The user chose an anonymous v1; accounts remain the documented next step.

### Signed stateless token (JWT)

Could carry the link ID and permissions without database storage. However, revocation is harder, tokens can be replayed until expiry, and the token would still need secure client storage. A random opaque token with a stored hash is simpler and revocable.

### Store the token in the URL fragment

Fragments are not sent to the server and avoid access logs, but sharing the URL would leak management authority and browser history still contains it. Rejected for management; acceptable only as an explicit export flow with warnings in a future version.

## Future path

When accounts ship:

- Authenticated creates set `owner_id`.
- Account users can list and manage all their links without per-link tokens.
- Anonymous links keep working with their tokens.
- Offer a one-time "claim this link" flow that attaches `owner_id` when the token is presented.
- Add token rotation and revocation endpoints.

## References

- [API contract](../backend/api.md)
- [Security](../backend/security.md)
- [Frontend data fetching](../frontend/data-fetching.md)
- [Data model](../backend/data-model.md)
