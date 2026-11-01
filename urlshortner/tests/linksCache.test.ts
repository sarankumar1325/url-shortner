import { describe, expect, test } from 'bun:test'
import type { LinkMetadata } from '../src/api'
import {
  LINKS_CACHE_MAX_AGE_MS,
  LINKS_CACHE_PREFIX,
  clearCachedLinks,
  readCachedLinks,
  writeCachedLinks,
  type LinksStorage,
} from '../src/linksCache'
import { recordFromMetadata, refreshRecords, type LinkRecord } from '../src/links'

function memoryStorage(initial: Record<string, string> = {}): LinksStorage & {
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
    key: (index) => [...data.keys()][index] ?? null,
    get length() {
      return data.size
    },
  }
}

function metadata(code: string, overrides: Partial<LinkMetadata> = {}): LinkMetadata {
  return {
    short_code: code,
    short_url: `https://sho.rt/${code}`,
    long_url: `https://example.com/${code}`,
    is_custom_alias: false,
    is_active: true,
    expires_at: null,
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-01T00:00:00Z',
    tags: ['launch'],
    clicks_30d: 4,
    ...overrides,
  }
}

const NOW = Date.UTC(2026, 9, 24, 12)

describe('saved links list', () => {
  test('round-trips link fields and drops analytics', () => {
    const storage = memoryStorage()
    const link: LinkRecord = {
      ...recordFromMetadata(metadata('abc', { max_clicks: 10, clicks_used: 2, has_password: true })),
      analytics: { totals: { clicks: 3 } } as LinkRecord['analytics'],
    }
    writeCachedLinks(storage, 'w1', [link], NOW)
    const raw = storage.data.get(`${LINKS_CACHE_PREFIX}w1`) ?? ''
    expect(raw).not.toContain('totals')
    const restored = readCachedLinks(storage, 'w1', NOW)
    expect(restored).toHaveLength(1)
    expect(restored?.[0]).toEqual({ ...link, analytics: null })
  })

  test('is kept per workspace', () => {
    const storage = memoryStorage()
    writeCachedLinks(storage, 'w1', [recordFromMetadata(metadata('one'))], NOW)
    expect(readCachedLinks(storage, 'w2', NOW)).toBeNull()
    expect(readCachedLinks(storage, 'w1', NOW)?.[0].code).toBe('one')
  })

  test('an empty saved list still counts as saved', () => {
    const storage = memoryStorage()
    writeCachedLinks(storage, 'w1', [], NOW)
    expect(readCachedLinks(storage, 'w1', NOW)).toEqual([])
  })

  test('ignores stale, future-dated, corrupt or malformed copies', () => {
    const storage = memoryStorage()
    writeCachedLinks(storage, 'w1', [recordFromMetadata(metadata('one'))], NOW)
    expect(readCachedLinks(storage, 'w1', NOW + LINKS_CACHE_MAX_AGE_MS + 1)).toBeNull()
    expect(readCachedLinks(storage, 'w1', NOW - 1)).toBeNull()
    storage.setItem(`${LINKS_CACHE_PREFIX}w1`, '{not json')
    expect(readCachedLinks(storage, 'w1', NOW)).toBeNull()
    storage.setItem(
      `${LINKS_CACHE_PREFIX}w1`,
      JSON.stringify({ savedAt: NOW, links: [{ code: 'x', shortUrl: 1 }] }),
    )
    expect(readCachedLinks(storage, 'w1', NOW)).toBeNull()
  })

  test('skips records that are still saving or failed', () => {
    const storage = memoryStorage()
    writeCachedLinks(
      storage,
      'w1',
      [
        recordFromMetadata(metadata('ok')),
        { ...recordFromMetadata(metadata('busy')), loading: true },
        { ...recordFromMetadata(metadata('bad')), error: 'Nope' },
      ],
      NOW,
    )
    expect(readCachedLinks(storage, 'w1', NOW)?.map((item) => item.code)).toEqual(['ok'])
  })

  test('survives blocked or full storage', () => {
    const broken: LinksStorage = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('full')
      },
      removeItem: () => {},
      key: () => null,
      length: 0,
    }
    expect(() => writeCachedLinks(broken, 'w1', [], NOW)).not.toThrow()
    expect(readCachedLinks(broken, 'w1', NOW)).toBeNull()
    expect(readCachedLinks(null, 'w1', NOW)).toBeNull()
  })

  test('clearing removes every saved list and nothing else', () => {
    const storage = memoryStorage({ 'shortly.sidebar': '1' })
    writeCachedLinks(storage, 'w1', [], NOW)
    writeCachedLinks(storage, 'w2', [], NOW)
    clearCachedLinks(storage)
    expect([...storage.data.keys()]).toEqual(['shortly.sidebar'])
  })
})

describe('refreshing the list', () => {
  test('takes server fields and order but keeps loaded analytics', () => {
    const analytics = { totals: { clicks: 9 } } as LinkRecord['analytics']
    const current: LinkRecord[] = [
      { ...recordFromMetadata(metadata('a')), analytics },
      { ...recordFromMetadata(metadata('b')), analyticsLoading: true },
      recordFromMetadata(metadata('gone')),
    ]
    const next = refreshRecords(current, [
      metadata('b', { is_active: false }),
      metadata('a', { clicks_30d: 12 }),
      metadata('new'),
    ])
    expect(next.map((item) => item.code)).toEqual(['b', 'a', 'new'])
    expect(next[0].active).toBe(false)
    expect(next[0].analyticsLoading).toBe(true)
    expect(next[1].analytics).toBe(analytics)
    expect(next[1].clicks30d).toBe(12)
    expect(next[2].analytics).toBeNull()
  })
})
