import { describe, expect, test } from 'bun:test'
import { ApiError } from '../src/api'
import {
  applyBulkResult,
  bulkSummary,
  chunk,
  runPool,
  selectionState,
  toggleAllVisible,
  toggleCode,
  visibleSelection,
  withRateLimitRetry,
} from '../src/bulk'
import { parseLinkCsv, recordFromMetadata, type LinkRecord } from '../src/links'

function link(code: string, overrides: Partial<LinkRecord> = {}): LinkRecord {
  return {
    ...recordFromMetadata({
      short_code: code,
      short_url: `https://short.test/${code}`,
      long_url: 'https://example.com/',
      is_custom_alias: true,
      is_active: true,
      expires_at: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      tags: [],
    }),
    ...overrides,
  }
}

describe('selection', () => {
  const visible = ['a', 'b', 'c']

  test('toggling one code adds then removes it', () => {
    const once = toggleCode(new Set(), 'a')
    expect([...once]).toEqual(['a'])
    expect([...toggleCode(once, 'a')]).toEqual([])
  })

  test('select all covers the visible links and clears when all are chosen', () => {
    expect(selectionState(new Set(), visible)).toBe('none')
    expect(selectionState(new Set(['b']), visible)).toBe('some')
    const all = toggleAllVisible(new Set(['b']), visible)
    expect(selectionState(all, visible)).toBe('all')
    expect([...toggleAllVisible(all, visible)]).toEqual([])
  })

  test('hidden or removed links drop out of the selection', () => {
    expect(visibleSelection(new Set(['a', 'gone', 'c']), visible)).toEqual(['a', 'c'])
    expect(selectionState(new Set(['gone']), visible)).toBe('none')
  })

  test('requests are split into batches of 200', () => {
    const codes = Array.from({ length: 450 }, (_, index) => `c${index}`)
    expect(chunk(codes).map((part) => part.length)).toEqual([200, 200, 50])
  })
})

describe('applying results', () => {
  const links = [link('a'), link('b', { tags: ['old'] }), link('c')]
  const results = (codes: string[]) =>
    codes.map((code) => ({ short_code: code, status: code === 'c' ? 'not_found' : 'ok' }) as const)

  test('pause and resume only change the links that succeeded', () => {
    const paused = applyBulkResult(links, { action: 'pause', results: results(['a', 'c']) })
    expect(paused.map((item) => item.active)).toEqual([false, true, true])
    const resumed = applyBulkResult(paused, { action: 'resume', results: results(['a']) })
    expect(resumed[0].active).toBe(true)
  })

  test('delete removes the links', () => {
    const left = applyBulkResult(links, { action: 'delete', results: results(['a', 'b']) })
    expect(left.map((item) => item.code)).toEqual(['c'])
  })

  test('tags are merged without duplicates and removed', () => {
    const tagged = applyBulkResult(links, { action: 'add_tags', results: results(['a', 'b']) }, ['old', 'new'])
    expect(tagged[0].tags).toEqual(['new', 'old'])
    expect(tagged[1].tags).toEqual(['new', 'old'])
    const untagged = applyBulkResult(tagged, { action: 'remove_tags', results: results(['b']) }, ['old'])
    expect(untagged[1].tags).toEqual(['new'])
  })

  test('links at the tag limit are left alone', () => {
    const full = applyBulkResult(
      links,
      { action: 'add_tags', results: [{ short_code: 'b', status: 'too_many_tags' }] },
      ['new'],
    )
    expect(full[1].tags).toEqual(['old'])
  })

  test('the summary counts each outcome', () => {
    expect(
      bulkSummary({
        action: 'add_tags',
        results: [
          { short_code: 'a', status: 'ok' },
          { short_code: 'b', status: 'too_many_tags' },
          { short_code: 'c', status: 'not_found' },
          { short_code: 'd', status: 'not_found' },
        ],
      }),
    ).toBe('Tagged 1 link. 2 were not found. 1 already has 5 tags.')
    expect(bulkSummary({ action: 'pause', results: [] })).toBe('Paused 0 links.')
  })
})

function limited(retryAfterSeconds?: number) {
  return new ApiError({
    kind: 'http',
    status: 429,
    code: 'rate_limited',
    detail: 'Too many requests.',
    retryAfterSeconds,
  })
}

describe('import pacing', () => {
  test('waits for Retry-After and tries again', async () => {
    const waits: number[] = []
    let calls = 0
    const value = await withRateLimitRetry(
      async () => {
        calls += 1
        if (calls < 3) throw limited(calls === 1 ? 7 : undefined)
        return 'created'
      },
      { wait: async (ms) => void waits.push(ms) },
    )
    expect(value).toBe('created')
    expect(waits).toEqual([7000, 1000])
  })

  test('other errors and repeated limits are not retried forever', async () => {
    const other = new ApiError({ kind: 'http', status: 422, code: 'validation_error', detail: 'Bad.' })
    let calls = 0
    await expect(
      withRateLimitRetry(async () => {
        calls += 1
        throw other
      }),
    ).rejects.toBe(other)
    expect(calls).toBe(1)
    await expect(
      withRateLimitRetry(async () => Promise.reject(limited(1)), { retries: 2, wait: async () => {} }),
    ).rejects.toBeInstanceOf(ApiError)
  })

  test('runs at most three rows at once and keeps their order', async () => {
    let running = 0
    let peak = 0
    const results = await runPool([1, 2, 3, 4, 5, 6, 7], 3, async (item) => {
      running += 1
      peak = Math.max(peak, running)
      await new Promise((resolve) => setTimeout(resolve, 8 - item))
      running -= 1
      return item * 10
    })
    expect(peak).toBe(3)
    expect(results).toEqual([10, 20, 30, 40, 50, 60, 70])
  })
})

describe('import columns', () => {
  const now = new Date('2026-03-10T12:00:00Z')

  test('reads fallback and visit limit by header name', () => {
    const { rows } = parseLinkCsv(
      'long_url,max_clicks,fallback_url\nhttps://example.com/a,"1,000",https://example.com/next',
      [],
      now,
    )
    expect(rows[0]).toMatchObject({
      valid: true,
      maxClicks: 1000,
      fallbackUrl: 'https://example.com/next',
    })
  })

  test('reads them by position without a header', () => {
    const { rows } = parseLinkCsv('https://example.com/a,,,,https://example.com/b,5', [], now)
    expect(rows[0]).toMatchObject({ valid: true, fallbackUrl: 'https://example.com/b', maxClicks: 5 })
  })

  test('flags a bad fallback or limit on that row only', () => {
    const { rows } = parseLinkCsv(
      [
        'long_url,fallback_url,max_clicks',
        'https://example.com/a,ftp://example.com/,',
        'https://example.com/b,,0',
        'https://example.com/c,,',
      ].join('\n'),
      [],
      now,
    )
    expect(rows.map((row) => row.valid)).toEqual([false, false, true])
    expect(rows[0].errors[0]).toMatch(/^Fallback: /)
    expect(rows[1].errors[0]).toMatch(/between 1 and/)
    expect(rows[2]).toMatchObject({ fallbackUrl: null, maxClicks: null })
  })
})
