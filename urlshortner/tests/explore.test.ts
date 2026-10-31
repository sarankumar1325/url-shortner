import { describe, expect, test } from 'bun:test'
import { aliasCheckable } from '../src/aliasAvailability'
import { CATEGORIES, CONCEPTS, filterConcepts, formatRatio, formatUptime } from '../src/concepts'
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
