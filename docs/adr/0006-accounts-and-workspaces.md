# ADR 0006: Accounts, Cookie Sessions, and Multi-Tenant Workspaces

Status: Accepted and implemented · Reviewed: 2026-10-24 · Supersedes the account-less scope in [ADR 0005](0005-anonymous-management-tokens.md) for new links while retaining its legacy token path

## Context

The product needed sign-up, sign-in, role-based permissions, and shared spaces for teams. Per-link capabilities alone cannot express membership, listing, invitations, or organization-level analytics. The constraints were a free Vercel deployment, one Postgres database, no email provider, and a same-origin static SPA.

## Decision

### Identity

- First-party email/password accounts. Emails are normalized to lowercase; display names default to the email local part.
- Passwords are 10–128 characters and stored only as Argon2id hashes (`argon2-cffi` defaults).
- Signup creates the account and a personal workspace owned by that user in one transaction.
- No email verification, password reset, SSO/OAuth, or MFA in v1. These are explicitly deferred, not implied by the account UI.

### Sessions

- Signup/login issue a 256-bit opaque `shrs_` token. Only its SHA-256 digest is stored in `user_sessions`; the raw token is returned once in the `shortly_session` cookie.
- Cookie flags: `HttpOnly`, `SameSite=Lax`, `Path=/`, 30-day max age, and `Secure` when `ENVIRONMENT` is `production` or `preview`.
- Logout deletes the server-side session row and clears the cookie. Expired rows are rejected and deleted on lookup.
- Login uses a dummy Argon2 verification for unknown emails so timing does not reveal account existence. Login failures are deliberately indistinguishable.

### CSRF and origins

- Browser writes (`POST`, `PATCH`, `DELETE`) must carry an `Origin` (or `Referer`) listed in `CORS_ORIGINS`; otherwise the API returns `403 csrf_rejected`.
- Requests without either header are treated as non-browser clients, which cannot be tricked into attaching a victim's cookie.
- Production CORS allows credentials for the exact web origin only. The frontend proxies `/api` through Vercel so the cookie stays first-party; the proxy does not relax the backend origin check.

### Workspaces and RBAC

- `workspaces` are personal (exactly one owner) or shared. `workspace_members` carries `owner`, `admin`, `member`, or `viewer`.
- Role order is `viewer < member < admin < owner`. Link reads are available to all roles; create/update/delete require `member`; people, role changes, and invitations require `admin`.
- Only the owner can manage admins. The owner cannot be removed, users cannot change their own role, and no flow creates a second owner or demotes the sole owner.
- `X-Workspace-Id` selects a workspace; omitting it selects the caller's personal workspace. A workspace the caller does not belong to is `404 workspace_not_found`, not `403`, to avoid membership disclosure.

### Invitations

- Invitations are opaque `shri_` tokens, stored only as digests, with a seven-day TTL, optional bound email, and explicit acceptance.
- Admins/owners create and revoke them. Anyone who holds the link may preview it; acceptance requires a signed-in account.
- Accepting is idempotent for an existing member: membership is not duplicated and the invitation is marked accepted.

### Link ownership

- New links created with a session and `X-Workspace-Id` belong to that workspace, record `created_by_user_id`, and have no management token.
- The legacy token path remains for unowned links created before accounts. A supplied `X-Management-Token` takes precedence and is never combined with workspace access.
- Deleting a workspace/user hard-deletes its links; analytics and create-replay rows cascade. Normal link deletion remains a soft delete.

## Consequences

- Every new link requires membership; there is no anonymous creation path for browser sessions. The legacy token API is retained for compatibility.
- Account deletion is not exposed yet. Database-level user deletion cascades personal workspaces, sessions, memberships, and invitations; shared workspaces must be transferred or removed separately.
- Because there is no email delivery, invitation links are copied and shared by the inviter. Anyone with an unbound link can join, so teams should bind an email when that matters.
- Session expiry is 30 days with no refresh rotation; a stolen cookie is valid until logout or expiry. Revocation is server-side by deleting the session row.
- The UI must treat the cookie as opaque, send `credentials: 'include'`, and never try to read or store the session token.

## Alternatives rejected

- Stateless JWT sessions: harder revocation and more sensitive material in the browser.
- localStorage session tokens: exposed to XSS; cookies with HttpOnly are safer for this same-origin deployment.
- Magic links/OAuth: require an email provider or external identity service beyond the current scope.
- Per-link tokens for team links: no listing, membership, or central revocation; retained only for legacy links.

## References

[API](../backend/api.md) · [Data model](../backend/data-model.md) · [Security](../backend/security.md) · [Frontend architecture](../frontend/architecture.md)
