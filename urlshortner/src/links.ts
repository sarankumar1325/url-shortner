import type {
  AbuseReason,
  Analytics,
  IngestionFreshness,
  LinkMetadata,
} from './api'

export const number = new Intl.NumberFormat('en-US')

export function queueLabel(freshness: IngestionFreshness): string {
  if (!freshness.redis_ok) return 'Queue health is unavailable right now.'
  const queued = (freshness.pending_events ?? 0) + (freshness.lag_events ?? 0)
  if (queued === 0) return 'Ingestion queue is clear.'
  const oldest =
    freshness.oldest_pending_seconds != null && freshness.oldest_pending_seconds > 0
      ? ` (oldest ${Math.max(1, Math.round(freshness.oldest_pending_seconds / 60))} min)`
      : ''
  return `${number.format(queued)} click${queued === 1 ? '' : 's'} queued${oldest}.`
}

export type ChartPoint = {
  day: string
  clicks: number
  humans: number
  bots: number
}

export type LinkRecord = {
  code: string
  shortUrl: string
  destination: string
  isCustomAlias: boolean
  createdAt: string
  expiresAt: string | null
  active: boolean
  tags: string[]
  clicks30d: number | null
  fallbackUrl: string | null
  maxClicks: number | null
  clicksUsed: number
  analytics: Analytics | null
  analyticsLoading: boolean
  analyticsError: string | null
  loading: boolean
  error: string | null
}

export function titleFor(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

export function displayShortUrl(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '')
}

/** A trailing "+" opens the destination preview instead of redirecting. */
export function previewUrl(shortUrl: string): string {
  return shortUrl ? `${shortUrl.replace(/\/$/, '')}+` : ''
}

/** Fix a missing slash in an otherwise explicit HTTP(S) scheme. */
export function normalizeDestination(destination: string): string {
  // Do not normalize control characters or backslashes away before validation.
  // oxlint-disable-next-line no-control-regex -- Keep unsafe input intact for validation.
  if (/[\u0000-\u001f\u007f-\u009f\\]/.test(destination)) return destination
  return destination.trim().replace(/^(https?:)\/(?!\/)(?=[^/?#\s])/i, '$1//')
}

export { campaignDestination, type CampaignFields } from './utm'

export function recordFromMetadata(
  metadata: LinkMetadata,
  analytics: Analytics | null = null,
): LinkRecord {
  return {
    code: metadata.short_code,
    shortUrl: metadata.short_url,
    destination: metadata.long_url,
    isCustomAlias: metadata.is_custom_alias,
    createdAt: metadata.created_at,
    expiresAt: metadata.expires_at,
    active: metadata.is_active,
    tags: metadata.tags ?? [],
    clicks30d: metadata.clicks_30d ?? null,
    fallbackUrl: metadata.fallback_url ?? null,
    maxClicks: metadata.max_clicks ?? null,
    clicksUsed: metadata.clicks_used ?? 0,
    analytics,
    analyticsLoading: false,
    analyticsError: null,
    loading: false,
    error: null,
  }
}

export function applyMetadata(
  link: LinkRecord,
  metadata: LinkMetadata,
): LinkRecord {
  return {
    ...link,
    code: metadata.short_code,
    shortUrl: metadata.short_url,
    destination: metadata.long_url,
    isCustomAlias: metadata.is_custom_alias,
    createdAt: metadata.created_at,
    expiresAt: metadata.expires_at,
    active: metadata.is_active,
    tags: metadata.tags ?? link.tags,
    clicks30d: metadata.clicks_30d ?? link.clicks30d,
    fallbackUrl:
      metadata.fallback_url === undefined ? link.fallbackUrl : metadata.fallback_url,
    maxClicks: metadata.max_clicks === undefined ? link.maxClicks : metadata.max_clicks,
    clicksUsed: metadata.clicks_used ?? link.clicksUsed,
    loading: false,
    error: null,
  }
}

export type LinkStatus = 'Active' | 'Expired' | 'Used up' | 'Paused'

export function isUsedUp(
  link: Partial<Pick<LinkRecord, 'maxClicks' | 'clicksUsed'>>,
): boolean {
  return link.maxClicks != null && (link.clicksUsed ?? 0) >= link.maxClicks
}

export function getLinkStatus(
  link: Pick<LinkRecord, 'expiresAt' | 'active'> &
    Partial<Pick<LinkRecord, 'maxClicks' | 'clicksUsed'>>,
  now = new Date(),
): LinkStatus {
  if (
    link.expiresAt !== null &&
    new Date(link.expiresAt).getTime() <= now.getTime()
  ) {
    return 'Expired'
  }
  if (isUsedUp(link)) return 'Used up'
  return link.active ? 'Active' : 'Paused'
}

export function statusClass(status: LinkStatus | 'Loading'): string {
  return `status-${status.toLowerCase().replace(/\s+/g, '-')}`
}

export const MAX_VISIT_LIMIT = 1_000_000

/** Parse an optional visit limit; empty means no limit. */
export function parseVisitLimit(raw: string): { value: number | null; error: string | null } {
  const text = raw.trim().replace(/[,_\s]/g, '')
  if (!text) return { value: null, error: null }
  if (!/^\d+$/.test(text)) return { value: null, error: 'Use a whole number of visits.' }
  const value = Number(text)
  if (value < 1 || value > MAX_VISIT_LIMIT) {
    return { value: null, error: `Choose between 1 and ${number.format(MAX_VISIT_LIMIT)} visits.` }
  }
  return { value, error: null }
}

export type LimitErrors = { fallbackUrl?: string; maxClicks?: string }

export function validateLimits(fallback: string, visitLimit: string): {
  errors: LimitErrors
  fallbackUrl: string | null
  maxClicks: number | null
} {
  const errors: LimitErrors = {}
  const normalized = normalizeDestination(fallback)
  if (normalized) {
    const problem = validateDraft(normalized, '', '', []).destination
    if (problem) errors.fallbackUrl = problem
  }
  const limit = parseVisitLimit(visitLimit)
  if (limit.error) errors.maxClicks = limit.error
  return { errors, fallbackUrl: normalized || null, maxClicks: limit.value }
}

export function limitFieldErrors(
  errors: readonly { field: string; message: string }[],
): LimitErrors {
  const mapped: LimitErrors = {}
  for (const issue of errors) {
    if (issue.field === 'fallback_url') mapped.fallbackUrl = issue.message
    if (issue.field === 'max_clicks') mapped.maxClicks = issue.message
  }
  return mapped
}

export function visitsLabel(link: Pick<LinkRecord, 'maxClicks' | 'clicksUsed'>): string {
  if (link.maxClicks == null) return 'No visit limit.'
  const left = Math.max(0, link.maxClicks - link.clicksUsed)
  return `${number.format(link.clicksUsed)} of ${number.format(link.maxClicks)} visit${link.maxClicks === 1 ? '' : 's'} used · ${number.format(left)} left`
}

export type LinkSort = 'newest' | 'oldest' | 'clicks' | 'expiry'

export function isExpiringSoon(link: Pick<LinkRecord, 'active' | 'expiresAt'>, now = new Date()): boolean {
  if (!link.active || !link.expiresAt) return false
  const remaining = Date.parse(link.expiresAt) - now.getTime()
  return remaining > 0 && remaining <= 7 * 86_400_000
}

export function linkClicks(link: LinkRecord): number | null {
  return link.analytics ? seriesTotals(getSeries(link, 30)).clicks : link.clicks30d
}

export function sortLinks(links: LinkRecord[], sort: LinkSort, now = new Date()): LinkRecord[] {
  const date = (value: string | null): number | null => {
    if (!value) return null
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  const value = (link: LinkRecord): number | null => {
    if (sort === 'clicks') return linkClicks(link)
    if (sort === 'expiry') {
      const expiry = date(link.expiresAt)
      return link.active && expiry !== null && expiry > now.getTime() ? expiry : null
    }
    return date(link.createdAt)
  }
  return links.map((link) => ({ link, key: value(link) })).sort((a, b) => {
    const first = a.key
    const second = b.key
    if (first === null) return second === null ? 0 : 1
    if (second === null) return -1
    return sort === 'newest' || sort === 'clicks' ? second - first : first - second
  }).map(({ link }) => link)
}

/**
 * Zero-filled daily points. A number means the last that many UTC days
 * including today; a range covers [from, to).
 */
export function getSeries(
  link: Pick<LinkRecord, 'analytics'>,
  range: number | { from: string; to: string },
  now = new Date(),
): ChartPoint[] {
  const today = new Date(now)
  today.setUTCHours(0, 0, 0, 0)
  let start = today.getTime()
  let days = 1
  if (typeof range === 'number') {
    days = range
    start = today.getTime() - (days - 1) * 86_400_000
  } else {
    start = Date.parse(`${range.from}T00:00:00Z`)
    days = Math.max(0, Math.round((Date.parse(`${range.to}T00:00:00Z`) - start) / 86_400_000))
  }
  const points = new Map(
    (link.analytics?.series ?? []).map((point) => [
      point.day,
      {
        day: point.day,
        clicks: point.clicks,
        humans: point.human_clicks,
        bots: point.bot_clicks,
      },
    ]),
  )

  return Array.from({ length: days }, (_, index): ChartPoint => {
    const day = new Date(start + index * 86_400_000).toISOString().slice(0, 10)
    return points.get(day) ?? { day, clicks: 0, humans: 0, bots: 0 }
  })
}

export function seriesTotals(series: ChartPoint[]): {
  clicks: number
  humans: number
  bots: number
} {
  return series.reduce(
    (totals, point) => ({
      clicks: totals.clicks + point.clicks,
      humans: totals.humans + point.humans,
      bots: totals.bots + point.bots,
    }),
    { clicks: 0, humans: 0, bots: 0 },
  )
}

export function validateDraft(
  destination: string,
  alias: string,
  expiresAt: string,
  links: Pick<LinkRecord, 'code'>[],
  now = new Date(),
): { destination?: string; alias?: string; expiresAt?: string } {
  const errors: { destination?: string; alias?: string; expiresAt?: string } =
    {}
  const value = destination.trim()

  if (!value) {
    errors.destination = 'Enter a destination URL.'
  } else if (
    // oxlint-disable-next-line no-control-regex -- Reject controls before URL parsing silently strips them.
    /[\u0000-\u001f\u007f-\u009f\\]/.test(destination) ||
    /%(?:0[0-9a-f]|1[0-9a-f]|7f|5c)/i.test(destination)
  ) {
    errors.destination =
      'URLs cannot contain control characters or backslashes.'
  } else {
    try {
      const url = new URL(value)
      if (
        !/^https?:\/\/[^/?#\s]+/i.test(value) ||
        (url.protocol !== 'http:' && url.protocol !== 'https:') ||
        !url.hostname
      ) {
        errors.destination = 'Enter an absolute HTTP or HTTPS URL.'
      } else if (
        url.username ||
        url.password ||
        value.split(/[/?#]/)[2]?.includes('@')
      ) {
        errors.destination = 'URLs cannot contain credentials.'
      } else if (url.href.length > 8192) {
        errors.destination =
          'The normalized URL must be 8192 characters or fewer.'
      }
    } catch {
      errors.destination = 'Enter an absolute HTTP or HTTPS URL.'
    }
  }

  if (alias) {
    if (
      alias !== alias.trim() ||
      !/^[a-z0-9][a-z0-9_-]{1,30}[a-z0-9]$/.test(alias)
    ) {
      errors.alias =
        'Use 3–32 lowercase letters, numbers, hyphens or underscores; start and end with a letter or number.'
    } else if (
      [
        'api',
        'admin',
        'health',
        'ready',
        'docs',
        'openapi',
        'invite',
        'invitations',
        'workspaces',
        'members',
        'settings',
        'static',
        'assets',
        'links',
        'internal',
        'report',
      ].includes(alias)
    ) {
      errors.alias = 'This alias is reserved.'
    } else if (links.some((link) => link.code === alias)) {
      errors.alias = 'You already have a link with this alias.'
    }
  }

  if (expiresAt) {
    const date = new Date(`${expiresAt}T00:00:00.000Z`)
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(expiresAt) ||
      !Number.isFinite(date.getTime()) ||
      date.toISOString().slice(0, 10) !== expiresAt
    ) {
      errors.expiresAt = 'Choose a valid calendar date.'
    } else {
      const limit = new Date(now)
      limit.setUTCHours(0, 0, 0, 0)
      limit.setUTCFullYear(limit.getUTCFullYear() + 5)
      if (limit.getUTCMonth() !== now.getUTCMonth()) {
        limit.setUTCDate(0)
      }
      if (date.getTime() + 86_400_000 <= now.getTime()) {
        errors.expiresAt =
          'Choose today or a future date; links expire at the end of the UTC day.'
      } else if (date.getTime() > limit.getTime()) {
        errors.expiresAt = 'Choose a date no more than five years from today.'
      }
    }
  }

  return errors
}

export function expiryInstant(expiresAt: string): string {
  const expiry = new Date(`${expiresAt}T00:00:00.000Z`)
  expiry.setUTCDate(expiry.getUTCDate() + 1)
  return expiry.toISOString()
}

export function fieldErrors(
  errors: readonly { field: string; message: string }[],
): { destination?: string; alias?: string; expiresAt?: string } {
  const mapped: { destination?: string; alias?: string; expiresAt?: string } =
    {}
  for (const issue of errors) {
    if (issue.field === 'long_url') mapped.destination = issue.message
    if (issue.field === 'custom_alias') mapped.alias = issue.message
    if (issue.field === 'expires_at') mapped.expiresAt = issue.message
  }
  return mapped
}

const TAG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])?$/
export const MAX_TAGS = 5

export function normalizeTag(raw: string): string | null {
  const tag = raw
    .trim()
    .replace(/^#/, '')
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
  return tag && TAG_PATTERN.test(tag) ? tag : null
}

export function parseTags(input: string): {
  tags: string[]
  invalid: string[]
  error: string | null
} {
  const tags: string[] = []
  const invalid: string[] = []
  for (const raw of input.split(',')) {
    if (!raw.trim()) continue
    const tag = normalizeTag(raw)
    if (tag === null) invalid.push(raw.trim())
    else if (!tags.includes(tag)) tags.push(tag)
  }
  let error: string | null = null
  if (invalid.length > 0)
    error = 'Tags use 1–24 lowercase letters, numbers or hyphens.'
  else if (tags.length > MAX_TAGS) error = `Use at most ${MAX_TAGS} tags.`
  return { tags: tags.slice(0, MAX_TAGS), invalid, error }
}

function csvField(value: string | number | null): string {
  const text = value === null ? '' : String(value)
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function linksCsv(links: LinkRecord[]): string {
  const rows: (string | number | null)[][] = [
    [
      'short_code',
      'short_url',
      'long_url',
      'tags',
      'status',
      'created_at',
      'expires_at',
      'clicks_30d',
      'fallback_url',
      'max_clicks',
      'clicks_used',
    ],
    ...links.map((link) => [
      link.code,
      link.shortUrl,
      link.destination,
      link.tags.join(' '),
      getLinkStatus(link),
      link.createdAt,
      link.expiresAt,
      link.clicks30d,
      link.fallbackUrl,
      link.maxClicks,
      link.maxClicks == null ? null : link.clicksUsed,
    ]),
  ]
  return rows.map((row) => row.map(csvField).join(',')).join('\r\n') + '\r\n'
}

export function csvFileName(now = new Date()): string {
  return `shortly-links-${now.toISOString().slice(0, 10)}.csv`
}

export function downloadTextFile(
  name: string,
  content: string,
  type = 'text/csv;charset=utf-8',
): void {
  const url = URL.createObjectURL(new Blob([content], { type }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  anchor.click()
  URL.revokeObjectURL(url)
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"'
        index += 1
      } else if (char === '"') {
        quoted = false
      } else {
        field += char
      }
    } else if (char === '"' && field === '') {
      quoted = true
    } else if (char === ',') {
      row.push(field.trim())
      field = ''
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index += 1
      row.push(field.trim())
      if (row.some((value) => value !== '')) rows.push(row)
      row = []
      field = ''
    } else {
      field += char
    }
  }
  row.push(field.trim())
  if (row.some((value) => value !== '')) rows.push(row)
  return rows
}

export type ImportRow = {
  line: number
  destination: string
  alias: string
  expiresAt: string
  tags: string[]
  tagError: string | null
  fallbackUrl: string | null
  maxClicks: number | null
  errors: string[]
  valid: boolean
}

const URL_HEADERS = ['long_url', 'url', 'destination', 'link']
const ALIAS_HEADERS = ['custom_alias', 'alias', 'code']
const EXPIRY_HEADERS = ['expires_at', 'expiry', 'expires']
const TAGS_HEADERS = ['tags', 'tag', 'labels']
const FALLBACK_HEADERS = ['fallback_url', 'fallback']
const LIMIT_HEADERS = ['max_clicks', 'visit_limit', 'max_visits']

function headerIndex(
  header: string[],
  names: string[],
  fallback: number,
): number {
  const found = header.findIndex((value) => names.includes(value))
  return found === -1 ? fallback : found
}

export function parseLinkCsv(
  text: string,
  existingCodes: string[],
  now = new Date(),
): { rows: ImportRow[]; error: string | null } {
  const table = parseCsv(text)
  if (table.length === 0) return { rows: [], error: 'Paste at least one row.' }

  const first = table[0].map((value) => value.trim().toLowerCase())
  const hasHeader = URL_HEADERS.some((name) => first.includes(name))
  let urlIndex = 0
  let aliasIndex = 1
  let expiryIndex = 2
  let tagsIndex = 3
  let fallbackIndex = 4
  let limitIndex = 5
  let data = table

  if (hasHeader) {
    urlIndex = headerIndex(first, URL_HEADERS, -1)
    if (urlIndex === -1)
      return {
        rows: [],
        error: 'The header needs a long_url column.',
      }
    aliasIndex = headerIndex(first, ALIAS_HEADERS, -1)
    expiryIndex = headerIndex(first, EXPIRY_HEADERS, -1)
    tagsIndex = headerIndex(first, TAGS_HEADERS, -1)
    fallbackIndex = headerIndex(first, FALLBACK_HEADERS, -1)
    limitIndex = headerIndex(first, LIMIT_HEADERS, -1)
    data = table.slice(1)
  }

  if (data.length === 0)
    return { rows: [], error: 'Add at least one link row below the header.' }
  if (data.length > 50)
    return { rows: [], error: 'Import at most 50 rows at a time.' }

  const codes = new Set(existingCodes)
  const rows = data.map((cells, offset): ImportRow => {
    const cell = (index: number) => (index === -1 ? '' : (cells[index] ?? ''))
    const destination = cell(urlIndex)
    const alias = cell(aliasIndex)
    const expiresAt = cell(expiryIndex)
    const tagInput = cell(tagsIndex)
    const fields = validateDraft(
      destination,
      alias,
      expiresAt,
      Array.from(codes, (code) => ({ code })),
      now,
    )
    const parsedTags = parseTags(tagInput)
    const limits = validateLimits(cell(fallbackIndex), cell(limitIndex))
    const errors = [
      fields.destination,
      fields.alias,
      fields.expiresAt,
      parsedTags.error,
      limits.errors.fallbackUrl && `Fallback: ${limits.errors.fallbackUrl}`,
      limits.errors.maxClicks,
    ].filter((value): value is string => Boolean(value))
    if (alias && !fields.alias) codes.add(alias)
    return {
      line: offset + (hasHeader ? 2 : 1),
      destination,
      alias,
      expiresAt,
      tags: parsedTags.tags,
      tagError: parsedTags.error,
      fallbackUrl: limits.fallbackUrl,
      maxClicks: limits.maxClicks,
      errors,
      valid: errors.length === 0,
    }
  })
  return { rows, error: null }
}


const REPORT_CODE_PATTERN = /^[A-Za-z0-9_-]{1,32}$/
export const MAX_REPORT_DETAILS = 2000

export function normalizeReportCode(raw: string): string | null {
  let value = raw.trim()
  if (!value) return null
  if (/^https?:\/\//i.test(value)) {
    try {
      value = new URL(value).pathname
    } catch {
      return null
    }
  }
  value = value.split(/[?#]/, 1)[0] ?? value
  const segment = value.replace(/\/+$/, '').split('/').pop() ?? ''
  return REPORT_CODE_PATTERN.test(segment) ? segment : null
}

export type ReportFields = {
  shortCode: string
  details: string
  email: string
}

export type ReportFieldErrors = Partial<Record<keyof ReportFields, string>>

export function validateReport(fields: ReportFields): {
  errors: ReportFieldErrors
  code: string | null
  details: string | null
  email: string | null
} {
  const errors: ReportFieldErrors = {}
  const code = normalizeReportCode(fields.shortCode)
  if (!code) {
    errors.shortCode = fields.shortCode.trim()
      ? 'Use the short code or the full short link.'
      : 'Add the short link you want to report.'
  }
  const details = fields.details.trim()
  if (details.length > MAX_REPORT_DETAILS)
    errors.details = `Keep details under ${MAX_REPORT_DETAILS} characters.`
  const email = fields.email.trim().toLowerCase()
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    errors.email = 'Enter a valid email address, or leave it blank.'
  return {
    errors,
    code,
    details: details || null,
    email: email || null,
  }
}

export const ABUSE_REASONS: { value: AbuseReason; label: string }[] = [
  { value: 'phishing', label: 'Phishing or credential theft' },
  { value: 'malware', label: 'Malware or unwanted download' },
  { value: 'spam', label: 'Spam or misleading promotion' },
  { value: 'impersonation', label: 'Impersonation of a person or brand' },
  { value: 'other', label: 'Something else' },
]
