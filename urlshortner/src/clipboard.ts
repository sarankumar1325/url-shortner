export type CopyOutcome = 'clipboard' | 'legacy' | 'manual'

export type CopyEnvironment = {
  writeText?: (value: string) => Promise<void>
  legacyCopy: (value: string) => boolean
}

/** Copies with execCommand, which still works where the async API is blocked. */
export function legacyCopy(value: string): boolean {
  if (typeof document === 'undefined') return false
  const previous = document.activeElement as HTMLElement | null
  const area = document.createElement('textarea')
  area.value = value
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.top = '0'
  area.style.opacity = '0'
  document.body.appendChild(area)
  area.select()
  let copied = false
  try {
    copied = document.execCommand('copy')
  } catch {
    copied = false
  }
  area.remove()
  previous?.focus?.({ preventScroll: true })
  return copied
}

function browserEnvironment(): CopyEnvironment {
  const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined
  return {
    writeText: clipboard?.writeText ? (value) => clipboard.writeText(value) : undefined,
    legacyCopy,
  }
}

/**
 * Tries the Clipboard API, then execCommand('copy'). 'manual' means both were
 * blocked (embedded browsers, plain-http pages) and the caller should show the
 * value for the user to copy themselves.
 */
export async function copyText(
  value: string,
  environment: CopyEnvironment = browserEnvironment(),
): Promise<CopyOutcome> {
  if (environment.writeText) {
    try {
      await environment.writeText(value)
      return 'clipboard'
    } catch {
      // Fall through to the older method.
    }
  }
  return environment.legacyCopy(value) ? 'legacy' : 'manual'
}

/** Short links are always shared as full https:// URLs. */
export function fullUrl(value: string): string {
  const trimmed = value.trim()
  if (!trimmed || /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed
  return `https://${trimmed.replace(/^\/+/, '')}`
}

const BARE_HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(?::\d{1,5})?(?:[/?#]\S*)?$/i

/**
 * The link to shorten when someone pastes outside a text box, or null when
 * the clipboard holds something else. Bare domains get https://.
 */
export function urlFromPaste(text: string): string | null {
  const value = text.trim()
  if (!value || value.length > 8192 || /\s/.test(value)) return null
  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value)
      return url.hostname ? value : null
    } catch {
      return null
    }
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^[^:/]+:\d/.test(value)) return null
  return BARE_HOST.test(value) ? `https://${value}` : null
}

type PasteTarget = { tagName?: string; isContentEditable?: boolean } | null

const EDITABLE_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT'])

/** Paste-to-shorten only applies when the paste would not land in a field. */
export function pasteIsForPage(target: PasteTarget, dialogOpen: boolean): boolean {
  if (dialogOpen) return false
  if (!target) return true
  return !target.isContentEditable && !EDITABLE_TAGS.has(target.tagName ?? '')
}
