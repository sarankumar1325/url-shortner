export type ListItem = { label: string; disabled?: boolean }

export function edgeIndex(items: readonly ListItem[], edge: 'first' | 'last'): number {
  if (edge === 'first') return items.findIndex((item) => !item.disabled)
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (!items[index].disabled) return index
  }
  return -1
}

/**
 * Move `delta` places without wrapping, landing on the nearest enabled item
 * past the target, or before it when the rest of the list is disabled.
 */
export function stepIndex(items: readonly ListItem[], from: number, delta: number): number {
  if (items.length === 0) return -1
  if (from < 0) return edgeIndex(items, delta > 0 ? 'first' : 'last')
  const target = Math.max(0, Math.min(items.length - 1, from + delta))
  const direction = delta > 0 ? 1 : -1
  for (let index = target; index >= 0 && index < items.length; index += direction) {
    if (!items[index].disabled) return index
  }
  for (let index = target; index >= 0 && index < items.length; index -= direction) {
    if (!items[index].disabled) return index
  }
  return from
}

/** Like stepIndex by one, but past either end it wraps to the other. */
export function wrapIndex(items: readonly ListItem[], from: number, direction: 1 | -1): number {
  const count = items.length
  for (let offset = 1; offset <= count; offset += 1) {
    const index = (((from + direction * offset) % count) + count) % count
    if (!items[index].disabled) return index
  }
  return -1
}

/**
 * The item a typed prefix points at, searching after `from`. Typing one
 * letter again and again cycles through the items that start with it.
 */
export function typeaheadIndex(items: readonly ListItem[], query: string, from: number): number {
  const typed = query.toLowerCase()
  if (!typed || items.length === 0) return -1
  const repeated = [...typed].every((char) => char === typed[0])
  const needle = repeated ? typed[0] : typed
  const start = repeated ? from + 1 : Math.max(from, 0)
  for (let offset = 0; offset < items.length; offset += 1) {
    const index = (((start + offset) % items.length) + items.length) % items.length
    const item = items[index]
    if (!item.disabled && item.label.toLowerCase().startsWith(needle)) return index
  }
  return -1
}

export type Rect = { top: number; bottom: number; left: number; right: number }
export type Placement = { top: number; left: number; maxHeight: number; side: 'below' | 'above' }

/**
 * Where a dropdown panel goes: below its trigger when it fits (or when there
 * is more room below than above), aligned to the trigger's start or end edge
 * and kept inside the viewport.
 */
export function placePanel(
  anchor: Rect,
  panel: { width: number; height: number },
  viewport: { width: number; height: number },
  align: 'start' | 'end' = 'start',
  gap = 4,
  margin = 8,
): Placement {
  const below = viewport.height - anchor.bottom - gap - margin
  const above = anchor.top - gap - margin
  const side = panel.height <= below || below >= above ? 'below' : 'above'
  const maxHeight = Math.max(0, side === 'below' ? below : above)
  const height = Math.min(panel.height, maxHeight)
  const top = side === 'below' ? anchor.bottom + gap : anchor.top - gap - height
  const preferred = align === 'start' ? anchor.left : anchor.right - panel.width
  const left = Math.max(margin, Math.min(preferred, viewport.width - panel.width - margin))
  return { top, left, maxHeight, side }
}
