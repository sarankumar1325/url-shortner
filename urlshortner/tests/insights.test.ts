import { describe, expect, test } from 'bun:test'
import type { DashboardLink, RedirectTrace } from '../src/api'
import {
  filterHealth,
  formatChange,
  limitUsage,
  relativeTime,
  sortHealth,
  statusShares,
  toChartPoints,
} from '../src/linkHealth'
import { buildPdf, pdfLayout, pdfPixels, pdfString } from '../src/pdf'
import { cacheOutcome, formatMs, outcomeTone, responseLabel, speedup, waterfall } from '../src/trace'

function link(patch: Partial<DashboardLink>): DashboardLink {
  return {
    short_code: 'abc12',
    short_url: 'https://sho.rt/abc12',
    long_url: 'https://example.com/',
    status: 'active',
    issues: [],
    clicks: 0,
    previous_clicks: 0,
    change: null,
    last_click_at: null,
    created_at: '2026-01-01T00:00:00Z',
    expires_at: null,
    max_clicks: null,
    clicks_used: 0,
    fallback_url: null,
    ...patch,
  }
}

describe('link health', () => {
  test('formats period-over-period change', () => {
    expect(formatChange(null, 0)).toEqual({ text: '—', tone: 'none' })
    expect(formatChange(null, 4)).toEqual({ text: 'New', tone: 'new' })
    expect(formatChange(0, 4).tone).toBe('flat')
    expect(formatChange(0.256, 4)).toEqual({ text: '+26%', tone: 'up' })
    expect(formatChange(-0.5, 4)).toEqual({ text: '−50%', tone: 'down' })
  })

  test('relative times', () => {
    const now = new Date('2026-03-10T12:00:00Z')
    expect(relativeTime(null, now)).toBe('Never')
    expect(relativeTime('2026-03-10T11:59:30Z', now)).toBe('Just now')
    expect(relativeTime('2026-03-10T11:15:00Z', now)).toBe('45m ago')
    expect(relativeTime('2026-03-10T07:00:00Z', now)).toBe('5h ago')
    expect(relativeTime('2026-03-07T12:00:00Z', now)).toBe('3d ago')
  })

  test('maps series and limit usage', () => {
    expect(toChartPoints([{ day: '2026-03-01', clicks: 3, human_clicks: 2, bot_clicks: 1 }])).toEqual([
      { day: '2026-03-01', clicks: 3, humans: 2, bots: 1 },
    ])
    expect(limitUsage({ max_clicks: null, clicks_used: 9 })).toBeNull()
    expect(limitUsage({ max_clicks: 10, clicks_used: 8 })).toBe(0.8)
    expect(limitUsage({ max_clicks: 10, clicks_used: 12 })).toBe(1)
  })

  test('filters by status, issue, attention and text', () => {
    const links = [
      link({ short_code: 'aaaaa' }),
      link({ short_code: 'bbbbb', status: 'expired', issues: ['expired'] }),
      link({ short_code: 'ccccc', issues: ['near_limit'], long_url: 'https://shop.example/' }),
    ]
    const codes = (items: DashboardLink[]) => items.map((item) => item.short_code)
    expect(codes(filterHealth(links, 'all', ''))).toEqual(['aaaaa', 'bbbbb', 'ccccc'])
    expect(codes(filterHealth(links, 'attention', ''))).toEqual(['bbbbb', 'ccccc'])
    expect(codes(filterHealth(links, 'expired', ''))).toEqual(['bbbbb'])
    expect(codes(filterHealth(links, 'near_limit', ''))).toEqual(['ccccc'])
    expect(codes(filterHealth(links, 'all', 'SHOP'))).toEqual(['ccccc'])
  })

  test('sorts with a stable tie-break on the code', () => {
    const links = [
      link({ short_code: 'bbbbb', clicks: 5, previous_clicks: 5, last_click_at: '2026-03-02T00:00:00Z' }),
      link({ short_code: 'aaaaa', clicks: 5, previous_clicks: 1 }),
      link({ short_code: 'ccccc', clicks: 9, previous_clicks: 10, created_at: '2026-02-01T00:00:00Z' }),
    ]
    const codes = (items: DashboardLink[]) => items.map((item) => item.short_code)
    expect(codes(sortHealth(links, 'clicks'))).toEqual(['ccccc', 'aaaaa', 'bbbbb'])
    expect(codes(sortHealth(links, 'change'))).toEqual(['aaaaa', 'bbbbb', 'ccccc'])
    expect(codes(sortHealth(links, 'last_click'))[0]).toBe('bbbbb')
    expect(codes(sortHealth(links, 'newest'))[0]).toBe('ccccc')
    expect(codes(links)).toEqual(['bbbbb', 'aaaaa', 'ccccc'])
  })

  test('status shares skip empty statuses', () => {
    const shares = statusShares({ active: 3, paused: 0, expired: 1, used_up: 0, blocked: 0 })
    expect(shares).toEqual([
      { status: 'active', count: 3, share: 0.75 },
      { status: 'expired', count: 1, share: 0.25 },
    ])
    expect(statusShares({ active: 0, paused: 0, expired: 0, used_up: 0, blocked: 0 })).toEqual([])
  })
})

function trace(patch: Partial<RedirectTrace>): RedirectTrace {
  return {
    code: 'abc12',
    cold: false,
    steps: [
      { step: 'rate_limit', label: 'Rate limit', ms: 1, outcome: 'allowed', detail: '' },
      { step: 'cache', label: 'Cache', ms: 3, outcome: 'hit', detail: '' },
    ],
    total_ms: 5,
    response: { status: 302, location: 'https://example.com/', reason: null },
    breaker_state: 'closed',
    traced_at: '2026-03-10T12:00:00Z',
    ...patch,
  }
}

describe('request tracer', () => {
  test('lays steps end to end on the slower of total and sum', () => {
    const rows = waterfall(trace({}))
    expect(rows.map((row) => [row.offset, row.width])).toEqual([
      [0, 0.2],
      [0.2, 0.6],
    ])
    const over = waterfall(trace({ total_ms: 2 }))
    expect(over[1].offset + over[1].width).toBe(1)
  })

  test('tones, labels and durations', () => {
    expect(outcomeTone('hit')).toBe('good')
    expect(outcomeTone('miss')).toBe('warn')
    expect(outcomeTone('expired')).toBe('bad')
    expect(outcomeTone('skipped')).toBe('idle')
    expect(formatMs(0)).toBe('0 ms')
    expect(formatMs(0.25)).toBe('250 µs')
    expect(formatMs(12.34)).toBe('12.3 ms')
    expect(formatMs(1234.5)).toBe('1235 ms')
  })

  test('speedup needs a cold run and a warm cache hit', () => {
    const cold = trace({ cold: true, total_ms: 50, steps: [{ step: 'cache', label: '', ms: 1, outcome: 'miss', detail: '' }] })
    const warm = trace({ total_ms: 5 })
    expect(cacheOutcome(cold)).toBe('miss')
    expect(speedup(cold, warm)).toBe(10)
    expect(speedup(cold, cold)).toBeNull()
    expect(speedup(null, warm)).toBeNull()
  })

  test('response labels', () => {
    expect(responseLabel(trace({}))).toBe('302 redirect')
    expect(responseLabel(trace({ response: { status: 302, location: 'x', reason: 'fallback' } }))).toBe('302 to the fallback')
    expect(responseLabel(trace({ response: { status: 410, location: null, reason: 'link_exhausted' } }))).toBe('410 visit limit reached')
    expect(responseLabel(trace({ response: { status: 410, location: null, reason: 'expired' } }))).toBe('410 expired')
    expect(responseLabel(trace({ response: { status: 404, location: null, reason: null } }))).toBe('404 not found')
  })
})

describe('pdf export', () => {
  test('pixels for print at 600 DPI, capped', () => {
    expect(pdfPixels(2.54)).toBe(600)
    expect(pdfPixels(50)).toBe(4096)
  })

  test('fit pages wrap the code with a margin and caption', () => {
    const layout = pdfLayout(2.54, 'fit', 'sho.rt/abc12')
    expect(layout.image.size).toBe(72)
    expect(layout.width).toBe(144)
    expect(layout.image.x).toBe(36)
    expect(layout.height).toBeGreaterThan(144)
    expect(layout.caption!.y).toBeLessThan(layout.image.y)
    expect(pdfLayout(2.54, 'fit', null).height).toBe(144)
  })

  test('paper sizes center the code', () => {
    const layout = pdfLayout(5, 'a4', null)
    expect(layout.width).toBe(595.28)
    expect(layout.image.x * 2 + layout.image.size).toBeCloseTo(layout.width, 1)
    expect(layout.image.y * 2 + layout.image.size).toBeCloseTo(layout.height, 1)
  })

  test('escapes strings and replaces characters Courier cannot show', () => {
    expect(pdfString('a(b)\\c')).toBe('(a\\(b\\)\\\\c)')
    expect(pdfString('café→')).toBe('(caf??)')
  })

  test('writes a valid xref pointing at each object', () => {
    const bytes = buildPdf({
      layout: pdfLayout(3, 'fit', 'sho.rt/abc12'),
      image: { width: 1, height: 1, data: new Uint8Array([1, 2, 3]), filter: 'FlateDecode' },
      title: 'abc12',
    })
    const text = new TextDecoder('latin1').decode(bytes)
    expect(text.startsWith('%PDF-1.4')).toBe(true)
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true)
    const xref = Number(/startxref\n(\d+)/.exec(text)![1])
    expect(text.slice(xref, xref + 4)).toBe('xref')
    const offsets = [...text.slice(xref).matchAll(/^(\d{10}) 00000 n $/gm)].map((match) => Number(match[1]))
    expect(offsets).toHaveLength(7)
    offsets.forEach((offset, index) => expect(text.slice(offset).startsWith(`${index + 1} 0 obj`)).toBe(true))
  })
})
