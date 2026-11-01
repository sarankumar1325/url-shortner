export const UTM_KEYS = ['source', 'medium', 'campaign', 'term', 'content'] as const
export type UtmKey = (typeof UTM_KEYS)[number]

export const UTM_LABELS: Record<UtmKey, string> = {
  source: 'Source',
  medium: 'Medium',
  campaign: 'Campaign',
  term: 'Term',
  content: 'Content',
}

/** Term and content are optional, so older callers can pass three fields. */
export type CampaignFields = {
  source: string
  medium: string
  campaign: string
  term?: string
  content?: string
}

export const EMPTY_CAMPAIGN: Required<CampaignFields> = {
  source: '',
  medium: '',
  campaign: '',
  term: '',
  content: '',
}

function fieldValue(fields: CampaignFields, key: UtmKey): string {
  return (fields[key] ?? '').trim()
}

/** UTM values already in a URL; null when the URL cannot be parsed. */
export function parseCampaign(
  destination: string,
): { fields: Required<CampaignFields>; found: boolean } | null {
  let parsed: URL
  try {
    parsed = new URL(destination.trim())
  } catch {
    return null
  }
  const fields = { ...EMPTY_CAMPAIGN }
  let found = false
  for (const key of UTM_KEYS) {
    const value = parsed.searchParams.get(`utm_${key}`)
    if (value !== null) {
      fields[key] = value
      found = true
    }
  }
  return { fields, found }
}

export function sameCampaign(first: CampaignFields, second: CampaignFields): boolean {
  return UTM_KEYS.every((key) => fieldValue(first, key) === fieldValue(second, key))
}

function decodeKey(part: string): string {
  const raw = part.split('=', 1)[0].replace(/\+/g, ' ')
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

const UTM_PARAM = new Set(UTM_KEYS.map((key) => `utm_${key}`))

/** Remove utm_* parameters while leaving every other byte of the query alone. */
export function stripCampaign(destination: string): string {
  const value = destination.trim()
  const hashIndex = value.indexOf('#')
  const beforeHash = hashIndex < 0 ? value : value.slice(0, hashIndex)
  const hash = hashIndex < 0 ? '' : value.slice(hashIndex)
  const queryIndex = beforeHash.indexOf('?')
  if (queryIndex < 0) return value
  const path = beforeHash.slice(0, queryIndex)
  const kept = beforeHash
    .slice(queryIndex + 1)
    .split('&')
    .filter((part) => part !== '' && !UTM_PARAM.has(decodeKey(part)))
  return `${path}${kept.length ? `?${kept.join('&')}` : ''}${hash}`
}

function appendCampaign(value: string, additions: [UtmKey, string][]): string {
  const hashIndex = value.indexOf('#')
  const base = hashIndex < 0 ? value : value.slice(0, hashIndex)
  const hash = hashIndex < 0 ? '' : value.slice(hashIndex)
  const separator = base.includes('?') ? (/[?&]$/.test(base) ? '' : '&') : '?'
  const params = new URLSearchParams(additions.map(([key, field]) => [`utm_${key}`, field]))
  return `${base}${separator}${params.toString()}${hash}`
}

/**
 * Add tracking parameters without rewriting the destination's existing query.
 * With replace, the URL's own utm_* values are dropped first, so the fields
 * become the whole campaign; leaving them all blank removes tracking.
 */
export function campaignDestination(
  destination: string,
  fields: CampaignFields,
  replace = false,
): { url: string; error: string | null } {
  const value = destination.trim()
  const additions = UTM_KEYS.map((key): [UtmKey, string] => [key, fieldValue(fields, key)]).filter(
    ([, field]) => field,
  )
  const current = parseCampaign(value)
  if (current === null) return { url: value, error: null } // Destination validation supplies the error.
  if (replace && current.found) {
    if (sameCampaign(current.fields, fields)) return { url: value, error: null }
    const stripped = stripCampaign(value)
    return { url: additions.length ? appendCampaign(stripped, additions) : stripped, error: null }
  }
  if (!additions.length) return { url: value, error: null }
  const present = new URL(value).searchParams
  const duplicate = additions.find(([key]) => present.has(`utm_${key}`))
  if (duplicate) {
    return {
      url: value,
      error: `This URL already has utm_${duplicate[0]}. Choose “Replace existing” or leave that field blank.`,
    }
  }
  return { url: appendCampaign(value, additions), error: null }
}

/** Chips for the campaign values in a destination, in UTM order. */
export function campaignChips(destination: string): { key: UtmKey; label: string; value: string }[] {
  const parsed = parseCampaign(destination)
  if (!parsed?.found) return []
  return UTM_KEYS.filter((key) => parsed.fields[key].trim()).map((key) => ({
    key,
    label: UTM_LABELS[key],
    value: parsed.fields[key],
  }))
}

export type UtmRecents = Record<UtmKey, string[]>
export const MAX_RECENT_UTM = 8
const MAX_RECENT_LENGTH = 100
const RECENT_PREFIX = 'shortly.utm.v1:'

function emptyRecents(): UtmRecents {
  return { source: [], medium: [], campaign: [], term: [], content: [] }
}

/** Most recent first, case-insensitively de-duplicated, capped per field. */
export function mergeRecents(current: UtmRecents, fields: CampaignFields): UtmRecents {
  const next = emptyRecents()
  for (const key of UTM_KEYS) {
    const value = fieldValue(fields, key).slice(0, MAX_RECENT_LENGTH)
    const previous = current[key].filter((item) => item.toLowerCase() !== value.toLowerCase())
    next[key] = (value ? [value, ...previous] : previous).slice(0, MAX_RECENT_UTM)
  }
  return next
}

export function readUtmRecents(
  storage: Pick<Storage, 'getItem'> | null,
  workspaceId: string,
): UtmRecents {
  const recents = emptyRecents()
  try {
    const raw = storage?.getItem(`${RECENT_PREFIX}${workspaceId}`)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    if (!parsed || typeof parsed !== 'object') return recents
    for (const key of UTM_KEYS) {
      const values = (parsed as Record<string, unknown>)[key]
      if (!Array.isArray(values)) continue
      recents[key] = values
        .filter((item): item is string => typeof item === 'string' && item.trim() !== '')
        .map((item) => item.slice(0, MAX_RECENT_LENGTH))
        .slice(0, MAX_RECENT_UTM)
    }
  } catch {
    // Unreadable or blocked storage just means no suggestions.
  }
  return recents
}

export function rememberUtm(
  storage: Pick<Storage, 'getItem' | 'setItem'> | null,
  workspaceId: string,
  fields: CampaignFields,
): UtmRecents {
  const next = mergeRecents(readUtmRecents(storage, workspaceId), fields)
  try {
    storage?.setItem(`${RECENT_PREFIX}${workspaceId}`, JSON.stringify(next))
  } catch {
    // Private browsing can refuse storage; suggestions just won't persist.
  }
  return next
}
