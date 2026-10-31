import { describe, expect, test } from 'bun:test'
import { shortcutFor, type ShortcutEvent } from '../src/shortcuts'
import { previewUrl } from '../src/links'

function press(key: string, overrides: Partial<ShortcutEvent> = {}): ShortcutEvent {
  return { key, metaKey: false, ctrlKey: false, altKey: false, target: { tagName: 'BODY' }, ...overrides }
}

describe('keyboard shortcuts', () => {
  test('maps single keys to actions', () => {
    expect(shortcutFor(press('n'))).toBe('new-link')
    expect(shortcutFor(press('N'))).toBe('new-link')
    expect(shortcutFor(press('/'))).toBe('search')
    expect(shortcutFor(press('?'))).toBe('help')
    expect(shortcutFor(press('x'))).toBeNull()
  })

  test('stays out of the way while typing', () => {
    for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) {
      expect(shortcutFor(press('n', { target: { tagName } }))).toBeNull()
    }
    expect(shortcutFor(press('/', { target: { tagName: 'DIV', isContentEditable: true } }))).toBeNull()
  })

  test('ignores modifier combinations and open dialogs', () => {
    expect(shortcutFor(press('n', { metaKey: true }))).toBeNull()
    expect(shortcutFor(press('n', { ctrlKey: true }))).toBeNull()
    expect(shortcutFor(press('n', { altKey: true }))).toBeNull()
    expect(shortcutFor(press('n'), true)).toBeNull()
  })
})

describe('preview links', () => {
  test('appends a plus to the short link', () => {
    expect(previewUrl('https://short.example/abc12')).toBe('https://short.example/abc12+')
    expect(previewUrl('https://short.example/abc12/')).toBe('https://short.example/abc12+')
  })

  test('returns an empty string when there is no short link yet', () => {
    expect(previewUrl('')).toBe('')
  })
})
