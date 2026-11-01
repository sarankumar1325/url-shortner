import { describe, expect, test } from 'bun:test'
import {
  MAX_RULES,
  countryName,
  draftsFromRules,
  emptyRule,
  moveRule,
  parseCountries,
  ruleFieldErrors,
  ruleSummary,
  sameRules,
  toggleDevice,
  validateRules,
  type RuleDraft,
} from '../src/smartRules'
import { applyMetadata, recordFromMetadata } from '../src/links'
import type { LinkMetadata } from '../src/api'

function draft(patch: Partial<RuleDraft>): RuleDraft {
  return { ...emptyRule(), ...patch }
}

describe('smart redirect rules', () => {
  test('parse countries into sorted, unique codes', () => {
    expect(parseCountries('de, AT  fr;de')).toEqual({ codes: ['AT', 'DE', 'FR'], error: null })
    expect(parseCountries('')).toEqual({ codes: [], error: null })
    expect(parseCountries('DE, Germany').error).toContain('“GERMANY” is not a two-letter')
    expect(parseCountries('D1').error).toContain('two-letter')
    expect(countryName('DE')).toBe('Germany')
  })

  test('validate each rule and build the API payload', () => {
    const ok = validateRules([
      draft({ devices: ['ios'], url: 'https://apps.apple.com/app/id1' }),
      draft({ countries: 'at, de', url: 'https://example.de/' }),
    ])
    expect(ok.valid).toBe(true)
    expect(ok.rules[0]).toEqual({ url: 'https://apps.apple.com/app/id1', devices: ['ios'] })
    expect(ok.rules[1].countries).toEqual(['AT', 'DE'])
    expect(ok.rules[1].devices).toBeUndefined()
  })

  test('flag missing conditions, bad countries and bad URLs per rule', () => {
    const none = draft({ url: 'https://example.com/' })
    const country = draft({ countries: 'XYZ', url: 'https://example.com/' })
    const url = draft({ devices: ['desktop'], url: 'javascript:alert(1)' })
    const empty = draft({ devices: ['android'] })
    const fine = draft({ devices: ['mobile'], url: 'https://example.com/m' })
    const result = validateRules([none, country, url, empty, fine])
    expect(result.valid).toBe(false)
    expect(result.rules).toEqual([])
    expect(result.errors[none.id].conditions).toBe('Choose at least one device or country.')
    expect(result.errors[country.id].countries).toContain('two-letter')
    expect(result.errors[country.id].conditions).toBeUndefined()
    expect(result.errors[url.id].url).toBeTruthy()
    expect(result.errors[empty.id].url).toBe('Add the URL these visitors should go to.')
    expect(result.errors[fine.id]).toBeUndefined()
  })

  test('cap the number of rules', () => {
    const many = Array.from({ length: MAX_RULES + 1 }, () =>
      draft({ devices: ['ios'], url: 'https://example.com/' }),
    )
    const result = validateRules(many)
    expect(result.valid).toBe(false)
    expect(result.errors[many[MAX_RULES].id].conditions).toContain(`at most ${MAX_RULES}`)
  })

  test('move, toggle and compare rules', () => {
    expect(moveRule(['a', 'b', 'c'], 0, 1)).toEqual(['b', 'a', 'c'])
    expect(moveRule(['a', 'b', 'c'], 2, -1)).toEqual(['a', 'c', 'b'])
    expect(moveRule(['a', 'b'], 0, -1)).toEqual(['a', 'b'])
    expect(toggleDevice(['desktop'], 'ios')).toEqual(['ios', 'desktop'])
    expect(toggleDevice(['ios', 'desktop'], 'ios')).toEqual(['desktop'])
    const stored = [{ countries: ['DE'], devices: ['ios' as const], url: 'https://x.test/' }]
    expect(sameRules([{ url: 'https://x.test/', devices: ['ios'], countries: ['DE'] }], stored)).toBe(true)
    expect(sameRules([], stored)).toBe(false)
  })

  test('round-trip stored rules through drafts', () => {
    const rules = [{ url: 'https://x.test/', devices: ['android' as const], countries: ['AT', 'DE'] }]
    const drafts = draftsFromRules(rules)
    expect(drafts[0]).toMatchObject({ devices: ['android'], countries: 'AT, DE', url: 'https://x.test/' })
    expect(validateRules(drafts).rules).toEqual(rules)
    expect(new Set(drafts.concat(draftsFromRules(rules)).map((item) => item.id)).size).toBe(2)
  })

  test('map API field errors back to their rule', () => {
    const drafts = [emptyRule(), emptyRule()]
    const mapped = ruleFieldErrors(drafts, [
      { field: 'redirect_rules.1.url', message: 'Rule 2: bad host' },
      { field: 'redirect_rules.0', message: 'Rule 1: choose' },
      { field: 'redirect_rules.0.countries', message: 'Rule 1: bad country' },
      { field: 'redirect_rules.9.url', message: 'ignored' },
      { field: 'long_url', message: 'ignored' },
    ])
    expect(mapped).toEqual({
      [drafts[0].id]: { conditions: 'Rule 1: choose', countries: 'Rule 1: bad country' },
      [drafts[1].id]: { url: 'Rule 2: bad host' },
    })
  })

  test('summarize a rule for the list badge', () => {
    expect(ruleSummary({ devices: ['ios', 'android'], countries: ['DE'], url: 'https://www.example.de/x' })).toBe(
      'iPhone and iPad or Android in DE → example.de',
    )
    expect(ruleSummary({ countries: ['AT', 'DE'], url: 'https://example.at/' })).toBe('AT, DE → example.at')
  })

  test('link records carry their rules', () => {
    const metadata: LinkMetadata = {
      short_code: 'smart1',
      short_url: 'https://short.example/smart1',
      long_url: 'https://example.com/',
      is_custom_alias: false,
      is_active: true,
      expires_at: null,
      created_at: '2026-10-01T00:00:00Z',
      updated_at: '2026-10-01T00:00:00Z',
      tags: [],
      redirect_rules: [{ devices: ['ios'], url: 'https://apps.apple.com/' }],
    }
    const record = recordFromMetadata(metadata)
    expect(record.redirectRules).toHaveLength(1)
    expect(recordFromMetadata({ ...metadata, redirect_rules: undefined }).redirectRules).toEqual([])
    expect(applyMetadata(record, { ...metadata, redirect_rules: [] }).redirectRules).toEqual([])
    expect(applyMetadata(record, { ...metadata, redirect_rules: undefined }).redirectRules).toHaveLength(1)
  })
})
