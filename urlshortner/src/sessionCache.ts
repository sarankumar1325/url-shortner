import type { Session, WorkspaceRole, WorkspaceSummary } from './api'

/**
 * The last signed-in account summary (name, email, workspace list; never a
 * token) so the app shell can draw and load links while /auth/me is still in
 * flight. The cookie stays the only credential: a 401 clears this copy.
 */
export const SESSION_CACHE_KEY = 'shortly.session.v1'

export type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export type AuthStatus = 'loading' | 'authenticated' | 'anonymous'

export type AuthState = {
  status: AuthStatus
  session: Session | null
  /** True once the server confirmed the session in this page load. */
  verified: boolean
}

const ROLES = new Set<WorkspaceRole>(['owner', 'admin', 'member', 'viewer'])

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function workspaceFrom(value: unknown): WorkspaceSummary | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Record<string, unknown>
  if (!isString(item.id) || !isString(item.name) || typeof item.is_personal !== 'boolean')
    return null
  if (!ROLES.has(item.role as WorkspaceRole)) return null
  return {
    id: item.id,
    name: item.name,
    role: item.role as WorkspaceRole,
    is_personal: item.is_personal,
  }
}

function sessionFrom(value: unknown): Session | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const user = record.user as Record<string, unknown> | undefined
  if (
    !user ||
    !isString(user.id) ||
    !isString(user.email) ||
    !isString(user.display_name) ||
    !isString(user.created_at) ||
    !Array.isArray(record.workspaces)
  )
    return null
  const workspaces = record.workspaces.map(workspaceFrom)
  if (workspaces.some((item) => item === null)) return null
  return {
    user: {
      id: user.id,
      email: user.email,
      display_name: user.display_name,
      created_at: user.created_at,
    },
    workspaces: workspaces as WorkspaceSummary[],
  }
}

export function readCachedSession(storage: StorageLike | null): Session | null {
  if (!storage) return null
  try {
    const raw = storage.getItem(SESSION_CACHE_KEY)
    return raw ? sessionFrom(JSON.parse(raw)) : null
  } catch {
    return null
  }
}

export function writeCachedSession(storage: StorageLike | null, session: Session): void {
  const clean = sessionFrom(session)
  if (!storage || !clean) return
  try {
    storage.setItem(SESSION_CACHE_KEY, JSON.stringify(clean))
  } catch {
    // Without storage the app still works; it just waits for /auth/me.
  }
}

export function clearCachedSession(storage: StorageLike | null): void {
  try {
    storage?.removeItem(SESSION_CACHE_KEY)
  } catch {
    // Nothing to clear.
  }
}

export function initialAuthState(storage: StorageLike | null): AuthState {
  const cached = readCachedSession(storage)
  return cached
    ? { status: 'authenticated', session: cached, verified: false }
    : { status: 'loading', session: null, verified: false }
}

export type SessionCheck =
  | { kind: 'ok'; session: Session }
  | { kind: 'unauthorized' }
  | { kind: 'failed' }

/** The state after /auth/me answers, given what was drawn from the cache. */
export function settleSession(
  storage: StorageLike | null,
  current: AuthState,
  check: SessionCheck,
): AuthState {
  if (check.kind === 'ok') {
    writeCachedSession(storage, check.session)
    return { status: 'authenticated', session: check.session, verified: true }
  }
  if (check.kind === 'unauthorized') {
    clearCachedSession(storage)
    return { status: 'anonymous', session: null, verified: false }
  }
  // Offline or a server error: keep a cached shell rather than signing out.
  if (current.session) return { ...current, status: 'authenticated' }
  return { status: 'anonymous', session: null, verified: false }
}

export function browserStorage(): StorageLike | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null
  } catch {
    return null
  }
}
