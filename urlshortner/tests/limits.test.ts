import { describe, expect, test } from 'bun:test'
import {
  applyMetadata,
  getLinkStatus,
  limitFieldErrors,
  linksCsv,
  parseVisitLimit,
  recordFromMetadata,
  statusClass,
  validateLimits,
  visitsLabel,
} from '../src/links'
import { createLink } from '../src/api'
import type { LinkMetadata } from '../src/api'

const metadata: LinkMetadata = {
  short_code: 'drop1',
  short_url: 'https://short.example/drop1',
  long_url: 'https://example.com/drop',
  is_custom_alias: false,
  is_active: true,
  expires_at: null,
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
  tags: [],
  fallback_url: 'https://example.com/sold-out',
  max_clicks: 3,
  clicks_used: 1,
}

describe('visit limits', () => {
  test('parses optional limits', () => {
    expect(parseVisitLimit('')).toEqual({ value: null, error: null })
    expect(parseVisitLimit(' 1,000 ')).toEqual({ value: 1000, error: null })
    expect(parseVisitLimit('0').error).toContain('between 1 and')
    expect(parseVisitLimit('1000001').error).toContain('between 1 and')
    expect(parseVisitLimit('2.5').error).toBe('Use a whole number of visits.')
  })

  test('validates the fallback like a destination', () => {
    expect(validateLimits('https:/example.com/next', '5')).toEqual({
      errors: {},
      fallbackUrl: 'https://example.com/next',
      maxClicks: 5,
    })
    expect(validateLimits('example.com', '').errors.fallbackUrl).toBe(
      'Enter an absolute HTTP or HTTPS URL.',
    )
    expect(validateLimits('', '')).toEqual({ errors: {}, fallbackUrl: null, maxClicks: null })
  })

  test('maps server field errors', () => {
    expect(
      limitFieldErrors([
        { field: 'fallback_url', message: 'Bad fallback' },
        { field: 'max_clicks', message: 'Too many' },
        { field: 'long_url', message: 'ignored' },
      ]),
    ).toEqual({ fallbackUrl: 'Bad fallback', maxClicks: 'Too many' })
  })

  test('reads limit metadata and reports usage', () => {
    const record = recordFromMetadata(metadata)
    expect(record.fallbackUrl).toBe('https://example.com/sold-out')
    expect(visitsLabel(record)).toBe('1 of 3 visits used · 2 left')
    expect(visitsLabel({ maxClicks: null, clicksUsed: 0 })).toBe('No visit limit.')
    const cleared = applyMetadata(record, { ...metadata, fallback_url: null, max_clicks: null, clicks_used: 0 })
    expect(cleared.fallbackUrl).toBeNull()
    expect(cleared.maxClicks).toBeNull()
    const older = applyMetadata(record, { ...metadata, fallback_url: undefined, max_clicks: undefined, clicks_used: undefined })
    expect(older.maxClicks).toBe(3)
  })

  test('used-up links get their own status, after expiry', () => {
    const now = new Date('2026-10-15T00:00:00Z')
    const used = { expiresAt: null, active: true, maxClicks: 2, clicksUsed: 2 }
    expect(getLinkStatus(used, now)).toBe('Used up')
    expect(getLinkStatus({ ...used, clicksUsed: 1 }, now)).toBe('Active')
    expect(getLinkStatus({ ...used, expiresAt: '2026-10-01T00:00:00Z' }, now)).toBe('Expired')
    expect(statusClass('Used up')).toBe('status-used-up')
  })

  test('exports limit columns', () => {
    const csv = linksCsv([recordFromMetadata(metadata)])
    expect(csv.split('\r\n')[0]).toEndWith(',fallback_url,max_clicks,clicks_used,has_password')
    expect(csv.split('\r\n')[1]).toEndWith(',https://example.com/sold-out,3,1,no')
  })
})

describe('creating limited links', () => {
  test('sends limit fields only when set', async () => {
    const bodies: unknown[] = []
    const original = globalThis.fetch
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)))
      return new Response(JSON.stringify(metadata), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch
    try {
      const signal = new AbortController().signal
      await createLink({ long_url: 'https://example.com/', fallback_url: null, max_clicks: null }, '00000000-0000-4000-8000-000000000002', 'ws', signal)
      await createLink({ long_url: 'https://example.com/', fallback_url: 'https://example.com/next', max_clicks: 1 }, '00000000-0000-4000-8000-000000000003', 'ws', signal)
    } finally {
      globalThis.fetch = original
    }
    expect(bodies[0]).toEqual({ long_url: 'https://example.com/' })
    expect(bodies[1]).toEqual({ long_url: 'https://example.com/', fallback_url: 'https://example.com/next', max_clicks: 1 })
  })
})
