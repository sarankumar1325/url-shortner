import { describe, expect, test } from 'bun:test'
import { aliasCheckable } from '../src/aliasAvailability'
import type { SystemConfig } from '../src/api'
import {
  CATEGORIES,
  CONCEPTS,
  conceptValues,
  fillTemplate,
  filterConcepts,
  formatRatio,
  formatUptime,
  formatWindow,
  humanCount,
} from '../src/concepts'

const CONFIG: SystemConfig = {
  short_codes: { length: 5, alphabet: 62, space: 916_132_832, retry_limit: 5 },
  rate_limits: [
    { name: 'Redirects', limit: 600, window_seconds: 60, scope: 'ip', fail_open: true },
    { name: 'Alias checks', limit: 120, window_seconds: 3600, scope: 'user', fail_open: true },
  ],
  redirect_cache_seconds: 300,
  leaderboard_cache_seconds: 30,
  breaker: { failure_threshold: 3, reset_after_seconds: 10 },
  analytics: {
    drain_batch: 100,
    max_events_per_drain: 1000,
    read_drain_limit: 500,
    drain_on_read: true,
    claim_min_idle_seconds: 60,
    max_attempts: 5,
  },
  retention: { raw_click_days: 90, daily_rollup_days: 730, cleanup_batch: 5000 },
  replay_ttl_seconds: 86_400,
  session_ttl_seconds: 1_209_600,
}
import { readSidebarCollapsed, writeSidebarCollapsed } from '../src/layout'

describe('alias availability', () => {
  test('only checks well-formed aliases', () => {
    expect(aliasCheckable('spring-sale')).toBe(true)
    expect(aliasCheckable('ab')).toBe(false)
    expect(aliasCheckable('Promo')).toBe(false)
    expect(aliasCheckable('-bad')).toBe(false)
    expect(aliasCheckable('')).toBe(false)
  })
})

describe('concept catalog', () => {
  test('ids are unique and every category is used', () => {
    expect(new Set(CONCEPTS.map((concept) => concept.id)).size).toBe(CONCEPTS.length)
    for (const category of CATEGORIES) {
      expect(CONCEPTS.some((concept) => concept.category === category)).toBe(true)
    }
  })

  test('every concept points at code', () => {
    for (const concept of CONCEPTS) {
      expect(concept.code.length).toBeGreaterThan(0)
      for (const path of concept.code) expect(path.startsWith('backend/') || path.startsWith('docs/')).toBe(true)
    }
  })

  test('filters by category and free text', () => {
    const reliability = filterConcepts(CONCEPTS, 'Reliability', '')
    expect(reliability.every((concept) => concept.category === 'Reliability')).toBe(true)
    expect(filterConcepts(CONCEPTS, 'All', 'stampede').map((concept) => concept.id)).toContain('single-flight')
    expect(filterConcepts(CONCEPTS, 'Security', 'stampede')).toEqual([])
  })

  test('every placeholder is filled from the live config', () => {
    const values = conceptValues(CONFIG)
    for (const concept of CONCEPTS) {
      for (const text of [concept.summary, concept.how, concept.tradeoff]) {
        for (const [, key] of text.matchAll(/\{([a-z_]+)\}/g)) expect(values[key]).toBeTruthy()
      }
    }
    expect(values.redirect_limit).toBe('600 per minute')
    expect(values.alias_limit).toBe('120 per hour')
    expect(values.code_space).toBe('916 million')
    expect(fillTemplate('{cache_ttl}s and {missing}', values)).toBe('300s and …')
  })

  test('searches the filled text', () => {
    const values = conceptValues(CONFIG)
    const matches = filterConcepts(CONCEPTS, 'All', '300 second', values)
    expect(matches.length).toBeGreaterThan(0)
    expect(matches.every((concept) => !concept.how.includes('{'))).toBe(true)
  })

  test('formats counts and windows', () => {
    expect(humanCount(916_132_832)).toBe('916 million')
    expect(humanCount(56_800_235_584)).toBe('56.8 billion')
    expect(humanCount(4200)).toBe('4,200')
    expect(formatWindow(60)).toBe('minute')
    expect(formatWindow(7200)).toBe('2 hours')
    expect(formatWindow(45)).toBe('45 seconds')
  })

  test('formats live numbers', () => {
    expect(formatRatio(null)).toBe('—')
    expect(formatRatio(0.756)).toBe('76%')
    expect(formatUptime(42)).toBe('42s')
    expect(formatUptime(600)).toBe('10m')
    expect(formatUptime(7260)).toBe('2h 1m')
  })
})

describe('sidebar preference', () => {
  test('round-trips through storage and tolerates failures', () => {
    const store = new Map<string, string>()
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    }
    expect(readSidebarCollapsed(storage)).toBe(false)
    writeSidebarCollapsed(storage, true)
    expect(readSidebarCollapsed(storage)).toBe(true)
    const broken = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      },
    }
    expect(readSidebarCollapsed(broken)).toBe(false)
    expect(() => writeSidebarCollapsed(broken, true)).not.toThrow()
    expect(readSidebarCollapsed(null)).toBe(false)
  })
})
