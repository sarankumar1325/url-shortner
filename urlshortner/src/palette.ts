export type PaletteGroup = 'Links' | 'Pages' | 'Actions' | 'Workspaces'

export const PALETTE_GROUPS: readonly PaletteGroup[] = ['Links', 'Pages', 'Actions', 'Workspaces']

export type PaletteItem = {
  id: string
  group: PaletteGroup
  label: string
  hint?: string
  /** Extra text that matches but is not shown, such as a destination or tags. */
  keywords?: readonly string[]
}

export type PaletteSection<T extends PaletteItem = PaletteItem> = {
  group: PaletteGroup
  items: T[]
}

/** Links shown before anything is typed, and at most after. */
export const IDLE_LINKS = 5
export const MAX_LINKS = 8

function subsequenceScore(query: string, text: string): number {
  let from = 0
  let previous = -1
  let gaps = 0
  for (const char of query) {
    const found = text.indexOf(char, from)
    if (found === -1) return 0
    if (previous !== -1) gaps += found - previous - 1
    previous = found
    from = found + 1
  }
  return Math.max(1, 20 - gaps)
}

/**
 * 0 means no match. Exact beats prefix, prefix beats a word start, a word
 * start beats any substring, and a loose in-order match scores lowest.
 */
export function scoreText(query: string, text: string): number {
  const needle = query.trim().toLowerCase()
  if (!needle) return 1
  const haystack = text.toLowerCase()
  if (haystack === needle) return 100
  if (haystack.startsWith(needle)) return 80
  const index = haystack.indexOf(needle)
  if (index > 0 && /[^\p{L}\p{N}]/u.test(haystack[index - 1])) return 60
  if (index !== -1) return 40
  return subsequenceScore(needle.replace(/\s+/g, ''), haystack)
}

/** Best score across the label and keywords; every typed word must match. */
export function scoreItem(query: string, item: PaletteItem): number {
  const fields = [item.label, item.hint ?? '', ...(item.keywords ?? [])].filter(Boolean)
  const best = (needle: string) =>
    fields.reduce((top, field, index) => {
      // The label counts a little more than hidden keywords.
      const weight = index === 0 ? 1 : 0.9
      return Math.max(top, scoreText(needle, field) * weight)
    }, 0)
  const whole = best(query)
  if (whole > 0) return whole
  const words = query.trim().split(/\s+/).filter(Boolean)
  if (words.length < 2) return 0
  const scores = words.map(best)
  return scores.every((score) => score > 0) ? Math.min(...scores) * 0.8 : 0
}

/**
 * Groups matching items. With no query, groups keep their fixed order and
 * items keep the order given; otherwise both sort by best score.
 */
export function searchPalette<T extends PaletteItem>(
  items: readonly T[],
  query: string,
): PaletteSection<T>[] {
  const typed = query.trim().length > 0
  const scored = items
    .map((item, index) => ({ item, index, score: scoreItem(query, item) }))
    .filter((entry) => entry.score > 0)
  const sections = PALETTE_GROUPS.map((group) => {
    const entries = scored
      .filter((entry) => entry.item.group === group)
      .sort((a, b) => (typed ? b.score - a.score : 0) || a.index - b.index)
    const limit = group === 'Links' ? (typed ? MAX_LINKS : IDLE_LINKS) : Infinity
    const kept = entries.slice(0, limit)
    return { group, items: kept.map((entry) => entry.item), top: kept[0]?.score ?? 0 }
  }).filter((section) => section.items.length > 0)
  if (typed) sections.sort((a, b) => b.top - a.top)
  return sections.map(({ group, items: grouped }) => ({ group, items: grouped }))
}

/** Items in display order, for keyboard navigation across groups. */
export function flattenSections<T extends PaletteItem>(sections: PaletteSection<T>[]): T[] {
  return sections.flatMap((section) => section.items)
}

/** Next highlighted index for ArrowUp/ArrowDown/Home/End, wrapping at the ends. */
export function moveActive(current: number, count: number, key: string): number {
  if (count === 0) return -1
  if (key === 'Home') return 0
  if (key === 'End') return count - 1
  if (key === 'ArrowDown') return current < 0 ? 0 : (current + 1) % count
  if (key === 'ArrowUp') return current <= 0 ? count - 1 : current - 1
  return current
}
