import { describe, expect, test } from 'bun:test'
import {
  applyMetadata,
  campaignDestination,
  displayShortUrl,
  expiryInstant,
  getLinkStatus,
  getSeries,
  isExpiringSoon,
  normalizeDestination,
  queueLabel,
  recordFromMetadata,
  seriesTotals,
  sortLinks,
  validateDraft,
  type LinkRecord,
} from '../src/links'
import type { Analytics, IngestionFreshness, LinkMetadata } from '../src/api'

const now = new Date('2026-10-15T12:34:56.789Z')
const destination = 'https://react.dev/learn'

describe('campaign tracking', () => {
  const fields = { source: ' news letter ', medium: 'email', campaign: 'launch & go' }
  test('adds encoded tracking before the fragment without rewriting existing query', () => {
    expect(campaignDestination('https://example.com/?token=a%20b#part', fields)).toEqual({
      url: 'https://example.com/?token=a%20b&utm_source=news+letter&utm_medium=email&utm_campaign=launch+%26+go#part',
      error: null,
    })
  })
  test('does not duplicate an existing tracking parameter', () => {
    expect(campaignDestination('https://example.com/?utm_source=old', fields).error).toContain('utm_source')
  })
  test('leaves the URL untouched when tracking is empty', () => {
    expect(campaignDestination('https://example.com/?a=b#top', { source: '', medium: '', campaign: '' }).url).toBe('https://example.com/?a=b#top')
  })
})

function metadata(overrides: Partial<LinkMetadata> = {}): LinkMetadata {
  return {
    short_code: 'react-notes',
    short_url: 'https://short.test/react-notes',
    long_url: 'https://react.dev/learn',
    is_custom_alias: true,
    is_active: true,
    expires_at: null,
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-01T00:00:00Z',
    ...overrides,
  }
}

function analytics(series: Analytics['series']): Analytics {
  return {
    short_code: 'react-notes',
    from: '2026-09-16',
    to: '2026-10-16',
    totals: { clicks: 0, human_clicks: 0, bot_clicks: 0 },
    series,
    breakdowns: {
      from: '2026-09-16',
      to: '2026-10-16',
      truncated: false,
      top_referers: [],
      top_countries: [],
      devices: [],
    },
    last_processed_at: null,
    data_through: null,
    freshness: {
      redis_ok: true,
      pending_events: 0,
      lag_events: 0,
      oldest_pending_seconds: null,
      dead_letter_events: 0,
      captured_at: '2026-10-16T12:00:00Z',
    },
  }
}

function record(overrides: Partial<LinkRecord> = {}): LinkRecord {
  return {
    ...recordFromMetadata(metadata()),
    ...overrides,
  }
}

describe('link organization', () => {
  test('sorts by clicks and puts unavailable counts after known zeroes', () => {
    const links = [record({ code: 'unknown', clicks30d: null }), record({ code: 'zero', clicks30d: 0 }), record({ code: 'popular', clicks30d: 12 })]
    expect(sortLinks(links, 'clicks', now).map((link) => link.code)).toEqual(['popular', 'zero', 'unknown'])
    expect(links.map((link) => link.code)).toEqual(['unknown', 'zero', 'popular'])
  })
  test('sorts upcoming active expiries first, ahead of paused and expired links', () => {
    const links = [record({ code: 'none' }), record({ code: 'paused', active: false, expiresAt: '2026-10-16T00:00:00Z' }), record({ code: 'later', expiresAt: '2026-11-01T00:00:00Z' }), record({ code: 'soon', expiresAt: '2026-10-16T00:00:00Z' }), record({ code: 'past', expiresAt: '2026-10-01T00:00:00Z' })]
    expect(sortLinks(links, 'expiry', now).map((link) => link.code)).toEqual(['soon', 'later', 'none', 'paused', 'past'])
    expect(isExpiringSoon(links[3], now)).toBe(true)
    expect(isExpiringSoon(links[1], now)).toBe(false)
    expect(isExpiringSoon(links[4], now)).toBe(false)
  })
})

describe('destination validation', () => {
  test('fixes one missing slash without hiding unsafe input', () => {
    expect(normalizeDestination('https:/www.linkedin.com/in/example/')).toBe('https://www.linkedin.com/in/example/')
    expect(normalizeDestination('HTTP:/example.com/path')).toBe('HTTP://example.com/path')
    expect(normalizeDestination('https:example.com')).toBe('https:example.com')
    expect(normalizeDestination('https:/example.com\\@evil.test')).toBe('https:/example.com\\@evil.test')
    expect(validateDraft(normalizeDestination('https:/example.com\n'), '', '', [], now).destination).toBeDefined()
  })
  test.each([
    'https://react.dev/learn',
    'http://example.com/path?query=value#section',
    'HTTPS://EXAMPLE.COM:443/a/../b',
    ' https://example.com/ ',
    'https://example.com/a%20b',
    'https://example.com/?email=person@example.com',
    'https://[::1]:8080/path',
  ])('accepts absolute HTTP(S) URL %j', (url) => {
    expect(validateDraft(url, '', '', [], now)).toEqual({})
  })

  test.each([
    '',
    '   ',
    'react.dev/learn',
    '/relative',
    '//example.com',
    'https:example.com',
    'https:/example.com',
    'https:///example.com',
    'https://',
    'https://?query',
    'https://example .com',
    'javascript:alert(1)',
    'data:text/html,hello',
    'ftp://example.com',
    'https://user:password@example.com',
    'https://user@example.com',
    'https://:password@example.com',
    'https://@example.com',
    'https://us%65r@example.com',
    'https://example.com\\@evil.example',
    'https:\\example.com',
    'https://example.com/\npath',
    '\thttps://example.com',
    'https://example.com\r',
    'https://example.com/\u0000',
    'https://example.com/\u001f',
    'https://example.com/\u007f',
    'https://example.com/\u0085',
    'https://example.com/%0Apath',
    'https://example.com/%00',
    'https://example.com/%5cpath',
  ])('rejects unsafe or invalid URL %j', (url) => {
    expect(validateDraft(url, '', '', [], now).destination).toBeDefined()
  })

  test('enforces 8192 characters on the serialized URL, not the input', () => {
    const prefix = 'https://example.com/'
    const boundary = prefix + 'a'.repeat(8192 - prefix.length)
    expect(validateDraft(boundary, '', '', [], now)).toEqual({})
    expect(
      validateDraft(`${boundary}a`, '', '', [], now).destination,
    ).toBeDefined()
    const encoded = prefix + 'é'.repeat(1400)
    expect(encoded.length).toBeLessThan(8192)
    expect(new URL(encoded).href.length).toBeGreaterThan(8192)
    expect(validateDraft(encoded, '', '', [], now).destination).toBeDefined()
  })

  test('collects all invalid fields rather than failing on the first', () => {
    expect(
      Object.keys(
        validateDraft('javascript:alert(1)', 'AB', '2026-02-30', [], now),
      ),
    ).toEqual(['destination', 'alias', 'expiresAt'])
  })
})

describe('draft aliases', () => {
  test.each(['', 'abc', '123', 'a-b', 'a_b', '0_-9', 'a'.repeat(32)])(
    'accepts %j',
    (alias) => {
      expect(validateDraft(destination, alias, '', [], now)).toEqual({})
    },
  )

  test.each([
    'a',
    'ab',
    'a'.repeat(33),
    '-abc',
    '_abc',
    'abc-',
    'abc_',
    'ABC',
    'aBc',
    'a.b',
    'a/b',
    'a b',
    ' abc',
    'abc ',
    'abc\n',
    'abc\r',
    'ébc',
  ])('rejects %j', (alias) => {
    expect(validateDraft(destination, alias, '', [], now).alias).toBeDefined()
  })

  test.each([
    'api',
    'admin',
    'health',
    'ready',
    'docs',
    'openapi',
    'static',
    'assets',
    'links',
    'internal',
    'invite',
    'invitations',
    'workspaces',
    'members',
    'settings',
  ])('reserves %s', (alias) => {
    expect(validateDraft(destination, alias, '', [], now).alias).toContain(
      'reserved',
    )
  })

  test('rejects duplicate codes without changing the list', () => {
    const links = [record(), record({ code: 'paused-link', active: false })]
    links.push(record({ code: 'expired-link', expiresAt: '2026-10-15T00:00:00Z' }))
    const original = structuredClone(links)
    for (const link of links) {
      expect(
        validateDraft(destination, link.code, '', links, now).alias,
      ).toContain('already have')
    }
    expect(validateDraft(destination, '', '', links, now)).toEqual({})
    expect(links).toEqual(original)
  })
})

describe('UTC expiry dates', () => {
  test('allows no expiry, today and the inclusive five-year calendar limit', () => {
    for (const date of [
      '',
      '2026-10-15',
      '2026-10-16',
      '2031-10-15',
      '2028-02-29',
    ]) {
      expect(validateDraft(destination, '', date, [], now)).toEqual({})
    }
    expect(
      validateDraft(destination, '', '2026-10-14', [], now).expiresAt,
    ).toBeDefined()
    expect(
      validateDraft(destination, '', '2031-10-16', [], now).expiresAt,
    ).toBeDefined()
  })

  test.each([
    '2026-02-29',
    '2028-02-30',
    '2026-04-31',
    '2026-1-5',
    '26-10-15',
    '10/15/2026',
    '2026-10-16T00:00:00Z',
    'not-a-date',
    ' ',
  ])('rejects non-calendar date %j', (date) => {
    expect(
      validateDraft(destination, '', date, [], now).expiresAt,
    ).toBeDefined()
  })

  test.each([
    ['2028-02-29', '2028-03-01T00:00:00.000Z'],
    ['2026-12-31', '2027-01-01T00:00:00.000Z'],
    ['2026-10-15', '2026-10-16T00:00:00.000Z'],
  ])('stores %s as the exclusive midnight %s', (date, expected) => {
    expect(expiryInstant(date)).toBe(expected)
  })
})

describe('status and formatting', () => {
  test('expires exactly at the exclusive UTC boundary, including paused links', () => {
    const link = record({ expiresAt: '2026-10-16T00:00:00.000Z' })
    expect(getLinkStatus(link, new Date('2026-10-15T23:59:59.999Z'))).toBe(
      'Active',
    )
    expect(getLinkStatus(link, new Date('2026-10-16T00:00:00.000Z'))).toBe(
      'Expired',
    )
    expect(getLinkStatus({ ...link, active: false }, now)).toBe('Paused')
    expect(
      getLinkStatus(
        { ...link, active: false },
        new Date('2026-10-16T00:00:00Z'),
      ),
    ).toBe('Expired')
  })

  test('strips the scheme for display and preserves unknown values', () => {
    expect(displayShortUrl('https://short.test/abc')).toBe('short.test/abc')
    expect(displayShortUrl('http://localhost:8000/abc')).toBe(
      'localhost:8000/abc',
    )
    expect(displayShortUrl('')).toBe('')
  })
})

describe('series mapping', () => {
  test('maps snake_case API points into the 7-day window and zero-fills', () => {
    const link = record({
      analytics: analytics([
        {
          day: '2026-10-09',
          clicks: 2,
          human_clicks: 2,
          bot_clicks: 0,
        },
        {
          day: '2026-10-15',
          clicks: 5,
          human_clicks: 4,
          bot_clicks: 1,
        },
        {
          day: '2026-10-16',
          clicks: 9,
          human_clicks: 9,
          bot_clicks: 0,
        },
      ]),
    })
    const series = getSeries(link, 7, now)
    expect(series.map((point) => point.day)).toEqual([
      '2026-10-09',
      '2026-10-10',
      '2026-10-11',
      '2026-10-12',
      '2026-10-13',
      '2026-10-14',
      '2026-10-15',
    ])
    expect(series.map((point) => point.clicks)).toEqual([2, 0, 0, 0, 0, 0, 5])
    expect(series[6]).toEqual({
      day: '2026-10-15',
      clicks: 5,
      humans: 4,
      bots: 1,
    })
    expect(seriesTotals(series)).toEqual({ clicks: 7, humans: 6, bots: 1 })
  })

  test('returns all-zero days when analytics have not loaded', () => {
    const series = getSeries(record(), 30, now)
    expect(series).toHaveLength(30)
    expect(series[0]?.day).toBe('2026-09-16')
    expect(series[29]?.day).toBe('2026-10-15')
    expect(seriesTotals(series)).toEqual({ clicks: 0, humans: 0, bots: 0 })
  })
})

function freshness(overrides: Partial<IngestionFreshness> = {}): IngestionFreshness {
  return {
    redis_ok: true,
    pending_events: 0,
    lag_events: 0,
    oldest_pending_seconds: null,
    dead_letter_events: 0,
    captured_at: '2026-10-16T12:00:00Z',
    ...overrides,
  }
}

describe('ingestion freshness labels', () => {
  test('counts both never-delivered lag and delivered-but-unacked pending', () => {
    expect(queueLabel(freshness())).toBe('Ingestion queue is clear.')
    expect(queueLabel(freshness({ lag_events: 1 }))).toBe('1 click queued.')
    expect(
      queueLabel(
        freshness({
          pending_events: 2,
          lag_events: 1,
          oldest_pending_seconds: 90,
        }),
      ),
    ).toBe('3 clicks queued (oldest 2 min).')
    expect(queueLabel(freshness({ pending_events: 1500 }))).toBe(
      '1,500 clicks queued.',
    )
  })

  test('does not claim the queue is clear when metrics are unavailable', () => {
    expect(queueLabel(freshness({ redis_ok: false }))).toBe(
      'Queue health is unavailable right now.',
    )
  })
})

describe('metadata projection', () => {
  test('applies workspace metadata without losing analytics or click totals', () => {
    const loaded = record({ analytics: analytics([]), clicks30d: 12 })
    const updated = applyMetadata(
      loaded,
      metadata({
        long_url: 'https://vite.dev/guide/',
        is_active: false,
        expires_at: '2026-11-01T00:00:00Z',
      }),
    )
    expect(updated).toMatchObject({
      code: 'react-notes',
      destination: 'https://vite.dev/guide/',
      active: false,
      expiresAt: '2026-11-01T00:00:00Z',
      clicks30d: 12,
      loading: false,
      error: null,
    })
    expect(updated.analytics).toBe(loaded.analytics)
  })

  test('takes newer click totals from freshly listed metadata', () => {
    const loaded = record({ clicks30d: 12 })
    const updated = applyMetadata(loaded, metadata({ clicks_30d: 30 }))
    expect(updated.clicks30d).toBe(30)
  })

  test('builds a fresh workspace record with its click total', () => {
    const created = recordFromMetadata(metadata({ clicks_30d: 5 }))
    expect(created.clicks30d).toBe(5)
    expect(created.analytics).toBeNull()
    expect(created.loading).toBe(false)
    expect(created.analyticsLoading).toBe(false)
  })

  test('accepts analytics supplied with the metadata', () => {
    const series = analytics([])
    const created = recordFromMetadata(metadata(), series)
    expect(created.analytics).toBe(series)
    expect(created.analyticsError).toBeNull()
  })
})
