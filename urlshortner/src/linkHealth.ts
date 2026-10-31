import type { DailyPoint, DashboardIssue, DashboardLink, DashboardStatus } from './api'
import type { ChartPoint } from './links'

export const STATUS_LABEL: Record<DashboardStatus, string> = {
  active: 'Active',
  paused: 'Paused',
  expired: 'Expired',
  used_up: 'Used up',
  blocked: 'Blocked',
}

export const STATUS_ORDER: DashboardStatus[] = ['active', 'paused', 'expired', 'used_up', 'blocked']

export const ISSUE_LABEL: Record<DashboardIssue, string> = {
  active: 'Active',
  paused: 'Paused',
  expired: 'Expired',
  used_up: 'Used up',
  blocked: 'Blocked',
  serving_fallback: 'Serving fallback',
  expiring_soon: 'Expiring soon',
  near_limit: 'Near visit limit',
  no_recent_clicks: 'No recent clicks',
}

/** Issues worth surfacing as filters; plain statuses already have their own. */
export const WATCH_ISSUES: DashboardIssue[] = [
  'expiring_soon',
  'near_limit',
  'no_recent_clicks',
  'serving_fallback',
]

export type Trend = { text: string; tone: 'up' | 'down' | 'flat' | 'new' | 'none' }

export function formatChange(change: number | null, current: number): Trend {
  if (change === null) return current > 0 ? { text: 'New', tone: 'new' } : { text: '—', tone: 'none' }
  if (change === 0) return { text: '0%', tone: 'flat' }
  const percent = Math.round(Math.abs(change) * 100)
  return change > 0 ? { text: `+${percent}%`, tone: 'up' } : { text: `−${percent}%`, tone: 'down' }
}

export function relativeTime(iso: string | null, now = new Date()): string {
  if (!iso) return 'Never'
  const seconds = Math.max(0, (now.getTime() - new Date(iso).getTime()) / 1000)
  if (seconds < 60) return 'Just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`
  if (seconds < 86_400 * 30) return `${Math.floor(seconds / 86_400)}d ago`
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

export function toChartPoints(series: DailyPoint[]): ChartPoint[] {
  return series.map((point) => ({
    day: point.day,
    clicks: point.clicks,
    humans: point.human_clicks,
    bots: point.bot_clicks,
  }))
}

export function limitUsage(link: Pick<DashboardLink, 'max_clicks' | 'clicks_used'>): number | null {
  if (!link.max_clicks) return null
  return Math.min(1, link.clicks_used / link.max_clicks)
}

export type HealthFilter = 'all' | 'attention' | DashboardStatus | DashboardIssue
export type HealthSort = 'clicks' | 'change' | 'last_click' | 'newest'

export function needsAttention(link: Pick<DashboardLink, 'issues'>): boolean {
  return link.issues.length > 0
}

export function filterHealth(
  links: DashboardLink[],
  filter: HealthFilter,
  query: string,
): DashboardLink[] {
  const needle = query.trim().toLowerCase()
  return links.filter((link) => {
    const matchesFilter =
      filter === 'all' ||
      (filter === 'attention' ? needsAttention(link) : link.status === filter || link.issues.includes(filter))
    const matchesQuery =
      !needle ||
      link.short_code.toLowerCase().includes(needle) ||
      link.long_url.toLowerCase().includes(needle)
    return matchesFilter && matchesQuery
  })
}

const time = (iso: string | null) => (iso ? new Date(iso).getTime() : -Infinity)

export function sortHealth(links: DashboardLink[], sort: HealthSort): DashboardLink[] {
  const ranked = [...links]
  ranked.sort((a, b) => {
    let delta = 0
    if (sort === 'clicks') delta = b.clicks - a.clicks
    else if (sort === 'change') delta = (b.clicks - b.previous_clicks) - (a.clicks - a.previous_clicks)
    else if (sort === 'last_click') delta = time(b.last_click_at) - time(a.last_click_at)
    else delta = time(b.created_at) - time(a.created_at)
    return delta || a.short_code.localeCompare(b.short_code)
  })
  return ranked
}

export function statusShares(
  counts: Record<DashboardStatus, number>,
): { status: DashboardStatus; count: number; share: number }[] {
  const total = STATUS_ORDER.reduce((sum, status) => sum + counts[status], 0)
  return STATUS_ORDER.filter((status) => counts[status] > 0).map((status) => ({
    status,
    count: counts[status],
    share: total ? counts[status] / total : 0,
  }))
}
