import type { RedirectRule } from './api'
import type { LinkRecord } from './links'

/**
 * The last links list per workspace, kept in sessionStorage so a reload or a
 * new visit in the same tab draws the list at once while a fresh copy loads.
 * Only link fields are stored, never analytics or credentials, and signing
 * out clears every copy.
 */
export const LINKS_CACHE_PREFIX = 'shortly.links.v1:'
export const LINKS_CACHE_MAX_AGE_MS = 12 * 60 * 60 * 1000
export const LINKS_CACHE_LIMIT = 500

export type LinksStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>

type CachedLink = Pick<
  LinkRecord,
  | 'code'
  | 'shortUrl'
  | 'destination'
  | 'isCustomAlias'
  | 'createdAt'
  | 'expiresAt'
  | 'active'
  | 'tags'
  | 'clicks30d'
  | 'fallbackUrl'
  | 'maxClicks'
  | 'clicksUsed'
  | 'hasPassword'
  | 'redirectRules'
>

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function isNullable<T>(value: unknown, check: (item: unknown) => item is T): value is T | null {
  return value === null || check(value)
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function cachedFrom(value: unknown): CachedLink | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Record<string, unknown>
  if (
    !isString(item.code) ||
    item.code === '' ||
    !isString(item.shortUrl) ||
    !isString(item.destination) ||
    typeof item.isCustomAlias !== 'boolean' ||
    !isString(item.createdAt) ||
    !isNullable(item.expiresAt, isString) ||
    typeof item.active !== 'boolean' ||
    !Array.isArray(item.tags) ||
    !item.tags.every(isString) ||
    !isNullable(item.clicks30d, isNumber) ||
    !isNullable(item.fallbackUrl, isString) ||
    !isNullable(item.maxClicks, isNumber) ||
    !isNumber(item.clicksUsed) ||
    typeof item.hasPassword !== 'boolean' ||
    !Array.isArray(item.redirectRules)
  )
    return null
  return {
    code: item.code,
    shortUrl: item.shortUrl,
    destination: item.destination,
    isCustomAlias: item.isCustomAlias,
    createdAt: item.createdAt,
    expiresAt: item.expiresAt,
    active: item.active,
    tags: item.tags,
    clicks30d: item.clicks30d,
    fallbackUrl: item.fallbackUrl,
    maxClicks: item.maxClicks,
    clicksUsed: item.clicksUsed,
    hasPassword: item.hasPassword,
    redirectRules: item.redirectRules as RedirectRule[],
  }
}

function toCached(link: LinkRecord): CachedLink {
  return {
    code: link.code,
    shortUrl: link.shortUrl,
    destination: link.destination,
    isCustomAlias: link.isCustomAlias,
    createdAt: link.createdAt,
    expiresAt: link.expiresAt,
    active: link.active,
    tags: link.tags,
    clicks30d: link.clicks30d,
    fallbackUrl: link.fallbackUrl,
    maxClicks: link.maxClicks,
    clicksUsed: link.clicksUsed,
    hasPassword: link.hasPassword,
    redirectRules: link.redirectRules,
  }
}

function fromCached(link: CachedLink): LinkRecord {
  return {
    ...link,
    analytics: null,
    analyticsLoading: false,
    analyticsError: null,
    loading: false,
    error: null,
  }
}

export function readCachedLinks(
  storage: LinksStorage | null,
  workspaceId: string,
  now = Date.now(),
): LinkRecord[] | null {
  if (!storage || !workspaceId) return null
  try {
    const raw = storage.getItem(LINKS_CACHE_PREFIX + workspaceId)
    if (!raw) return null
    const entry = JSON.parse(raw) as { savedAt?: unknown; links?: unknown }
    if (!isNumber(entry.savedAt) || !Array.isArray(entry.links)) return null
    if (now - entry.savedAt > LINKS_CACHE_MAX_AGE_MS || entry.savedAt > now) return null
    const links = entry.links.map(cachedFrom)
    if (links.some((item) => item === null)) return null
    return (links as CachedLink[]).map(fromCached)
  } catch {
    return null
  }
}

export function writeCachedLinks(
  storage: LinksStorage | null,
  workspaceId: string,
  links: LinkRecord[],
  now = Date.now(),
): void {
  if (!storage || !workspaceId) return
  // Records still saving or that failed are not the server's list.
  const settled = links.filter((item) => item.code && !item.loading && !item.error)
  try {
    storage.setItem(
      LINKS_CACHE_PREFIX + workspaceId,
      JSON.stringify({ savedAt: now, links: settled.slice(0, LINKS_CACHE_LIMIT).map(toCached) }),
    )
  } catch {
    // Storage full or blocked: the list still loads from the server.
  }
}

export function clearCachedLinks(storage: LinksStorage | null): void {
  if (!storage) return
  try {
    const keys: string[] = []
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index)
      if (key?.startsWith(LINKS_CACHE_PREFIX)) keys.push(key)
    }
    for (const key of keys) storage.removeItem(key)
  } catch {
    // Nothing to clear.
  }
}

export function browserSessionStorage(): LinksStorage | null {
  try {
    return typeof window !== 'undefined' ? window.sessionStorage : null
  } catch {
    return null
  }
}
