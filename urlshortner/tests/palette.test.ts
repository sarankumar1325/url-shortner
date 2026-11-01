import { describe, expect, test } from 'bun:test'
import {
  IDLE_LINKS,
  MAX_LINKS,
  flattenSections,
  moveActive,
  scoreItem,
  scoreText,
  searchPalette,
  type PaletteItem,
} from '../src/palette'

const items: PaletteItem[] = [
  { id: 'link:launch', group: 'Links', label: 'short.example/launch', hint: 'example.com', keywords: ['launch', 'https://example.com/spring', 'campaign'] },
  { id: 'link:docs', group: 'Links', label: 'short.example/docs', hint: 'docs.example.com', keywords: ['docs', 'https://docs.example.com/', 'product'] },
  { id: 'page:/', group: 'Pages', label: 'Overview' },
  { id: 'page:/links', group: 'Pages', label: 'Your links' },
  { id: 'page:/settings', group: 'Pages', label: 'Settings' },
  { id: 'action:theme', group: 'Actions', label: 'Switch to dark theme', keywords: ['dark mode'] },
  { id: 'action:sign-out', group: 'Actions', label: 'Sign out', keywords: ['log out'] },
  { id: 'workspace:team', group: 'Workspaces', label: 'Growth team', hint: 'admin', keywords: ['switch workspace'] },
]

describe('scoreText', () => {
  test('ranks exact, prefix, word start, substring and loose matches', () => {
    const exact = scoreText('settings', 'Settings')
    const prefix = scoreText('set', 'Settings')
    const word = scoreText('links', 'Your links')
    const inner = scoreText('ink', 'Your links')
    const loose = scoreText('yrlk', 'Your links')
    expect(exact).toBeGreaterThan(prefix)
    expect(prefix).toBeGreaterThan(word)
    expect(word).toBeGreaterThan(inner)
    expect(inner).toBeGreaterThan(loose)
    expect(loose).toBeGreaterThan(0)
  })

  test('returns 0 when letters are missing or out of order', () => {
    expect(scoreText('xyz', 'Settings')).toBe(0)
    expect(scoreText('gs', 'gas')).toBeGreaterThan(0)
    expect(scoreText('sg', 'gas')).toBe(0)
  })

  test('an empty query matches everything', () => {
    expect(scoreText('', 'anything')).toBe(1)
    expect(scoreText('   ', 'anything')).toBe(1)
  })
})

describe('scoreItem', () => {
  test('matches hidden keywords such as the destination and tags', () => {
    expect(scoreItem('spring', items[0])).toBeGreaterThan(0)
    expect(scoreItem('campaign', items[0])).toBeGreaterThan(0)
    expect(scoreItem('campaign', items[1])).toBe(0)
  })

  test('prefers the visible label over a keyword', () => {
    const label: PaletteItem = { id: 'a', group: 'Pages', label: 'docs' }
    const keyword: PaletteItem = { id: 'b', group: 'Pages', label: 'Other', keywords: ['docs'] }
    expect(scoreItem('docs', label)).toBeGreaterThan(scoreItem('docs', keyword))
  })

  test('every word of a multi-word query must match somewhere', () => {
    expect(scoreItem('growth admin', items[7])).toBeGreaterThan(0)
    expect(scoreItem('growth viewer', items[7])).toBe(0)
  })
})

describe('searchPalette', () => {
  test('with no query keeps the fixed group order and caps links', () => {
    const many: PaletteItem[] = Array.from({ length: 12 }, (_, index) => ({
      id: `link:${index}`,
      group: 'Links',
      label: `short.example/l${index}`,
    }))
    const sections = searchPalette([...items.slice(2), ...many], '')
    expect(sections.map((section) => section.group)).toEqual(['Links', 'Pages', 'Actions', 'Workspaces'])
    expect(sections[0].items).toHaveLength(IDLE_LINKS)
    expect(sections[0].items[0].id).toBe('link:0')
  })

  test('caps typed link results too', () => {
    const many: PaletteItem[] = Array.from({ length: 20 }, (_, index) => ({
      id: `link:${index}`,
      group: 'Links',
      label: `short.example/promo${index}`,
    }))
    expect(searchPalette(many, 'promo')[0].items).toHaveLength(MAX_LINKS)
  })

  test('puts the best-matching group first once you type', () => {
    const sections = searchPalette(items, 'sign out')
    expect(sections[0].group).toBe('Actions')
    expect(sections[0].items[0].id).toBe('action:sign-out')
  })

  test('finds a link by its destination and a workspace by name', () => {
    expect(flattenSections(searchPalette(items, 'docs.example'))[0].id).toBe('link:docs')
    expect(flattenSections(searchPalette(items, 'growth'))[0].id).toBe('workspace:team')
  })

  test('drops groups with no matches', () => {
    expect(searchPalette(items, 'qqqq')).toEqual([])
  })
})

describe('moveActive', () => {
  test('wraps around both ends', () => {
    expect(moveActive(0, 3, 'ArrowDown')).toBe(1)
    expect(moveActive(2, 3, 'ArrowDown')).toBe(0)
    expect(moveActive(0, 3, 'ArrowUp')).toBe(2)
    expect(moveActive(-1, 3, 'ArrowDown')).toBe(0)
    expect(moveActive(1, 3, 'Home')).toBe(0)
    expect(moveActive(1, 3, 'End')).toBe(2)
    expect(moveActive(1, 0, 'ArrowDown')).toBe(-1)
  })
})
