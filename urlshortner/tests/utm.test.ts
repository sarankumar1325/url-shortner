import { describe, expect, test } from 'bun:test'
import {
  MAX_RECENT_UTM,
  campaignChips,
  campaignDestination,
  mergeRecents,
  parseCampaign,
  readUtmRecents,
  rememberUtm,
  stripCampaign,
} from '../src/utm'

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  }
}

describe('parseCampaign', () => {
  test('reads all five UTM parameters', () => {
    const parsed = parseCampaign(
      'https://example.com/?utm_source=news&utm_medium=email&utm_campaign=launch&utm_term=shoes&utm_content=hero%20button',
    )
    expect(parsed).toEqual({
      found: true,
      fields: { source: 'news', medium: 'email', campaign: 'launch', term: 'shoes', content: 'hero button' },
    })
  })

  test('reports when there are none, and null for an unparseable URL', () => {
    expect(parseCampaign('https://example.com/?a=1')?.found).toBe(false)
    expect(parseCampaign('not a url')).toBeNull()
  })
})

describe('campaignDestination with term and content', () => {
  test('appends the optional fields in UTM order', () => {
    expect(
      campaignDestination('https://example.com/', {
        source: 'news',
        medium: '',
        campaign: 'launch',
        term: 'red shoes',
        content: 'cta',
      }).url,
    ).toBe('https://example.com/?utm_source=news&utm_campaign=launch&utm_term=red+shoes&utm_content=cta')
  })

  test('without replace, a repeated parameter is an error that points to Replace existing', () => {
    const result = campaignDestination('https://example.com/?utm_content=old', {
      source: '',
      medium: '',
      campaign: '',
      content: 'new',
    })
    expect(result.error).toContain('utm_content')
    expect(result.error).toContain('Replace existing')
  })

  test('replace swaps the URL’s own values and keeps every other parameter as written', () => {
    const result = campaignDestination(
      'https://example.com/p?token=a%20b&utm_source=old&x=1&utm_medium=web#top',
      { source: 'news', medium: '', campaign: 'launch' },
      true,
    )
    expect(result).toEqual({
      url: 'https://example.com/p?token=a%20b&x=1&utm_source=news&utm_campaign=launch#top',
      error: null,
    })
  })

  test('replace leaves the URL alone when the fields still match it', () => {
    const url = 'https://example.com/?utm_medium=email&utm_source=news'
    expect(campaignDestination(url, { source: 'news', medium: 'email', campaign: '' }, true).url).toBe(url)
  })

  test('replace with every field cleared removes tracking', () => {
    expect(
      campaignDestination('https://example.com/?utm_source=old', { source: '', medium: '', campaign: '' }, true).url,
    ).toBe('https://example.com/')
  })

  test('replace is ignored when the URL has no tracking yet', () => {
    expect(
      campaignDestination('https://example.com/?a=1', { source: 'news', medium: '', campaign: '' }, true).url,
    ).toBe('https://example.com/?a=1&utm_source=news')
  })
})

describe('stripCampaign', () => {
  test('only drops the five UTM keys, including encoded names', () => {
    expect(stripCampaign('https://e.com/?utm_id=7&utm%5Fsource=x&b=2')).toBe('https://e.com/?utm_id=7&b=2')
    expect(stripCampaign('https://e.com/#utm_source=x')).toBe('https://e.com/#utm_source=x')
  })
})

describe('campaignChips', () => {
  test('labels the values that are present', () => {
    expect(campaignChips('https://e.com/?utm_campaign=spring&utm_source=news&utm_term=')).toEqual([
      { key: 'source', label: 'Source', value: 'news' },
      { key: 'campaign', label: 'Campaign', value: 'spring' },
    ])
    expect(campaignChips('https://e.com/')).toEqual([])
  })
})

describe('recent UTM values', () => {
  test('keeps the newest first, without case-insensitive duplicates, capped per field', () => {
    let recents = readUtmRecents(null, 'w1')
    for (let index = 0; index < MAX_RECENT_UTM + 3; index += 1) {
      recents = mergeRecents(recents, { source: `s${index}`, medium: '', campaign: '' })
    }
    recents = mergeRecents(recents, { source: 'S5', medium: ' email ', campaign: '' })
    expect(recents.source[0]).toBe('S5')
    expect(recents.source.filter((value) => value.toLowerCase() === 's5')).toHaveLength(1)
    expect(recents.source).toHaveLength(MAX_RECENT_UTM)
    expect(recents.medium).toEqual(['email'])
  })

  test('are stored per workspace', () => {
    const storage = memoryStorage()
    rememberUtm(storage, 'w1', { source: 'news', medium: 'email', campaign: 'launch' })
    expect(readUtmRecents(storage, 'w1').source).toEqual(['news'])
    expect(readUtmRecents(storage, 'w2').source).toEqual([])
  })

  test('ignore corrupt or unexpected stored data', () => {
    const storage = memoryStorage({
      'shortly.utm.v1:w1': JSON.stringify({ source: ['ok', 5, ''], medium: 'nope' }),
      'shortly.utm.v1:w2': '{not json',
    })
    expect(readUtmRecents(storage, 'w1').source).toEqual(['ok'])
    expect(readUtmRecents(storage, 'w1').medium).toEqual([])
    expect(readUtmRecents(storage, 'w2').source).toEqual([])
  })
})
