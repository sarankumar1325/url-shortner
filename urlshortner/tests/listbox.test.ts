import { describe, expect, test } from 'bun:test'
import { edgeIndex, placePanel, stepIndex, typeaheadIndex, wrapIndex } from '../src/listbox'

const items = [
  { label: 'Apple' },
  { label: 'Apricot', disabled: true },
  { label: 'Banana' },
  { label: 'Blueberry' },
  { label: 'Cherry', disabled: true },
]

describe('edgeIndex', () => {
  test('skips disabled items at either end', () => {
    expect(edgeIndex(items, 'first')).toBe(0)
    expect(edgeIndex(items, 'last')).toBe(3)
    expect(edgeIndex([{ label: 'x', disabled: true }], 'first')).toBe(-1)
  })
})

describe('stepIndex', () => {
  test('moves past disabled items without wrapping', () => {
    expect(stepIndex(items, 0, 1)).toBe(2)
    expect(stepIndex(items, 2, -1)).toBe(0)
    expect(stepIndex(items, 3, 1)).toBe(3)
    expect(stepIndex(items, 0, -1)).toBe(0)
  })
  test('pages clamp to the nearest enabled item', () => {
    expect(stepIndex(items, 0, 8)).toBe(3)
    expect(stepIndex(items, 3, -8)).toBe(0)
  })
  test('starts at an edge when nothing is active', () => {
    expect(stepIndex(items, -1, 1)).toBe(0)
    expect(stepIndex(items, -1, -1)).toBe(3)
    expect(stepIndex([], -1, 1)).toBe(-1)
  })
})

describe('wrapIndex', () => {
  test('wraps around and skips disabled items', () => {
    expect(wrapIndex(items, 3, 1)).toBe(0)
    expect(wrapIndex(items, 0, -1)).toBe(3)
    expect(wrapIndex(items, 0, 1)).toBe(2)
  })
})

describe('typeaheadIndex', () => {
  test('matches a typed prefix, ignoring case and disabled items', () => {
    expect(typeaheadIndex(items, 'bl', 0)).toBe(3)
    expect(typeaheadIndex(items, 'APR', 0)).toBe(-1)
    expect(typeaheadIndex(items, 'z', 0)).toBe(-1)
  })
  test('the same letter again cycles through its matches', () => {
    expect(typeaheadIndex(items, 'b', 0)).toBe(2)
    expect(typeaheadIndex(items, 'b', 2)).toBe(3)
    expect(typeaheadIndex(items, 'bb', 3)).toBe(2)
  })
  test('a longer prefix keeps the current match when it still fits', () => {
    expect(typeaheadIndex(items, 'ban', 2)).toBe(2)
  })
})

describe('placePanel', () => {
  const viewport = { width: 1000, height: 800 }
  const anchor = { top: 100, bottom: 140, left: 200, right: 400 }

  test('opens below, aligned to the start edge', () => {
    expect(placePanel(anchor, { width: 240, height: 200 }, viewport)).toEqual({
      top: 144,
      left: 200,
      maxHeight: 648,
      side: 'below',
    })
  })
  test('aligns to the end edge for menus', () => {
    expect(placePanel(anchor, { width: 240, height: 200 }, viewport, 'end').left).toBe(160)
  })
  test('flips above when there is not enough room below', () => {
    const low = { top: 700, bottom: 740, left: 200, right: 400 }
    const spot = placePanel(low, { width: 240, height: 200 }, viewport)
    expect(spot.side).toBe('above')
    expect(spot.top).toBe(496)
  })
  test('stays below when it does not fit either way but below is roomier', () => {
    const spot = placePanel(anchor, { width: 240, height: 2000 }, viewport)
    expect(spot.side).toBe('below')
    expect(spot.maxHeight).toBe(648)
  })
  test('keeps the panel inside the viewport horizontally', () => {
    const edge = { top: 100, bottom: 140, left: 900, right: 990 }
    expect(placePanel(edge, { width: 240, height: 100 }, viewport).left).toBe(752)
    const tight = { top: 100, bottom: 140, left: 2, right: 40 }
    expect(placePanel(tight, { width: 240, height: 100 }, viewport, 'end').left).toBe(8)
  })
})
