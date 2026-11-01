import { describe, expect, test } from 'bun:test'
import type { Session } from '../src/api'
import {
  SESSION_CACHE_KEY,
  initialAuthState,
  readCachedSession,
  settleSession,
  writeCachedSession,
  type StorageLike,
} from '../src/sessionCache'

function memoryStorage(initial: Record<string, string> = {}): StorageLike & {
  data: Map<string, string>
} {
  const data = new Map(Object.entries(initial))
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value)
    },
    removeItem: (key) => {
      data.delete(key)
    },
  }
}

const session: Session = {
  user: {
    id: 'u1',
    email: 'ada@example.com',
    display_name: 'Ada',
    created_at: '2026-01-01T00:00:00Z',
  },
  workspaces: [{ id: 'w1', name: 'Ada', role: 'owner', is_personal: true }],
}

describe('cached session startup', () => {
  test('draws the shell from the cache before /auth/me answers', () => {
    const storage = memoryStorage()
    writeCachedSession(storage, session)
    const state = initialAuthState(storage)
    expect(state.status).toBe('authenticated')
    expect(state.verified).toBe(false)
    expect(state.session?.user.email).toBe('ada@example.com')
    expect(state.session?.workspaces[0].id).toBe('w1')
  })

  test('waits for /auth/me when nothing is cached', () => {
    expect(initialAuthState(memoryStorage())).toEqual({
      status: 'loading',
      session: null,
      verified: false,
    })
    expect(initialAuthState(null).status).toBe('loading')
  })

  test('ignores corrupt or tampered cache entries', () => {
    for (const raw of [
      'not json',
      '{}',
      JSON.stringify({ user: { id: 'u1' }, workspaces: [] }),
      JSON.stringify({ ...session, workspaces: [{ id: 'w1', name: 'x', role: 'god', is_personal: true }] }),
    ]) {
      expect(readCachedSession(memoryStorage({ [SESSION_CACHE_KEY]: raw }))).toBeNull()
    }
  })

  test('never stores anything beyond the account summary', () => {
    const storage = memoryStorage()
    writeCachedSession(storage, { ...session, token: 'secret' } as unknown as Session)
    const stored = storage.data.get(SESSION_CACHE_KEY) ?? ''
    expect(stored).not.toContain('secret')
    expect(JSON.parse(stored)).toEqual(session)
  })

  test('a 401 clears the cache and signs out', () => {
    const storage = memoryStorage()
    writeCachedSession(storage, session)
    const next = settleSession(storage, initialAuthState(storage), { kind: 'unauthorized' })
    expect(next).toEqual({ status: 'anonymous', session: null, verified: false })
    expect(storage.data.has(SESSION_CACHE_KEY)).toBe(false)
  })

  test('a confirmed session is verified and refreshes the cache', () => {
    const storage = memoryStorage()
    writeCachedSession(storage, session)
    const renamed: Session = { ...session, user: { ...session.user, display_name: 'Ada L.' } }
    const next = settleSession(storage, initialAuthState(storage), { kind: 'ok', session: renamed })
    expect(next.status).toBe('authenticated')
    expect(next.verified).toBe(true)
    expect(readCachedSession(storage)?.user.display_name).toBe('Ada L.')
  })

  test('a network failure keeps the cached shell', () => {
    const storage = memoryStorage()
    writeCachedSession(storage, session)
    const next = settleSession(storage, initialAuthState(storage), { kind: 'failed' })
    expect(next.status).toBe('authenticated')
    expect(next.verified).toBe(false)
    expect(storage.data.has(SESSION_CACHE_KEY)).toBe(true)
  })

  test('a network failure without a cache shows the sign-in page', () => {
    const storage = memoryStorage()
    const next = settleSession(storage, initialAuthState(storage), { kind: 'failed' })
    expect(next.status).toBe('anonymous')
  })

  test('works when storage throws', () => {
    const broken: StorageLike = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
      removeItem: () => {
        throw new Error('blocked')
      },
    }
    expect(initialAuthState(broken).status).toBe('loading')
    expect(() => writeCachedSession(broken, session)).not.toThrow()
    expect(settleSession(broken, initialAuthState(broken), { kind: 'unauthorized' }).status).toBe(
      'anonymous',
    )
  })
})
