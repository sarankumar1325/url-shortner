export type Shortcut = 'new-link' | 'search' | 'help' | 'toggle-sidebar' | 'copy' | 'palette'

export type ShortcutEvent = {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  target: { tagName?: string; isContentEditable?: boolean } | null
}

const TYPING_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT'])

/**
 * Single-key shortcuts are ignored while typing or with modifier keys held.
 * ⌘K / Ctrl+K opens the command palette from anywhere, even a text field.
 * Nothing fires while a dialog is open.
 */
export function shortcutFor(event: ShortcutEvent, dialogOpen = false): Shortcut | null {
  if (dialogOpen) return null
  if (
    (event.metaKey || event.ctrlKey) &&
    !event.altKey &&
    event.key.toLowerCase() === 'k'
  ) {
    return 'palette'
  }
  if (event.metaKey || event.ctrlKey || event.altKey) return null
  const target = event.target
  if (target && (target.isContentEditable || TYPING_TAGS.has(target.tagName ?? ''))) {
    return null
  }
  if (event.key === 'n' || event.key === 'N') return 'new-link'
  if (event.key === '/') return 'search'
  if (event.key === '?') return 'help'
  if (event.key === '[') return 'toggle-sidebar'
  if (event.key === 'c' || event.key === 'C') return 'copy'
  return null
}
