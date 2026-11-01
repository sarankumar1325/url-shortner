import { useEffect, useMemo, useState } from 'react'
import {
  AlertCircle,
  ArrowDownRight,
  ArrowUpRight,
  BarChart3,
  Copy,
  ExternalLink,
  QrCode,
  RefreshCw,
  Search,
} from 'lucide-react'
import { Link } from 'react-router-dom'
import { getDashboard, isProblem, type Dashboard as DashboardData } from './api'
import { ClickChart } from './ClickChart'
import { Breakdown } from './LinkAnalytics'
import { fullUrl } from './clipboard'
import { useCopy } from './copyContext'
import {
  ISSUE_LABEL,
  STATUS_LABEL,
  WATCH_ISSUES,
  filterHealth,
  formatChange,
  limitUsage,
  needsAttention,
  relativeTime,
  sortHealth,
  statusShares,
  toChartPoints,
  type HealthFilter,
  type HealthSort,
} from './linkHealth'
import { displayShortUrl, number, queueLabel, titleFor } from './links'
import './explore.css'
import './dashboard.css'

type Period = 7 | 30 | 90

function useDashboard(workspaceId: string, days: Period, reload: number) {
  const [data, setData] = useState<DashboardData | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!workspaceId) return
    const controller = new AbortController()
    setLoading(true)
    setError('')
    getDashboard(workspaceId, days, controller.signal)
      .then((next) => setData(next))
      .catch((failure) => {
        if (isProblem(failure) && failure.problem.kind === 'cancelled') return
        setError(isProblem(failure) ? failure.problem.detail : 'The dashboard could not be loaded.')
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [workspaceId, days, reload])

  return { data, error, loading }
}

function TrendBadge({ change, current }: { change: number | null; current: number }) {
  const trend = formatChange(change, current)
  return (
    <span className={`trend trend-${trend.tone}`}>
      {trend.tone === 'up' && <ArrowUpRight size={12} aria-hidden="true" />}
      {trend.tone === 'down' && <ArrowDownRight size={12} aria-hidden="true" />}
      {trend.text}
    </span>
  )
}

export default function Dashboard({
  workspaceId,
  workspaceName,
}: {
  workspaceId: string
  workspaceName: string
}) {
  const copy = useCopy()
  const [days, setDays] = useState<Period>(30)
  const [reload, setReload] = useState(0)
  const [filter, setFilter] = useState<HealthFilter>('all')
  const [sort, setSort] = useState<HealthSort>('clicks')
  const [query, setQuery] = useState('')
  const { data, error, loading } = useDashboard(workspaceId, days, reload)

  const rows = useMemo(
    () => (data ? sortHealth(filterHealth(data.links, filter, query), sort) : []),
    [data, filter, query, sort],
  )

  const heading = (
    <div className="page-heading dashboard-heading">
      <div>
        <span className="eyebrow">Dashboard</span>
        <h1 tabIndex={-1}>Every link at a glance.</h1>
        <p>Traffic, status, and health across all links in {workspaceName}.</p>
      </div>
      <div className="dashboard-controls">
        <div className="segmented-control" role="group" aria-label="Dashboard period">
          {([7, 30, 90] as const).map((range) => (
            <button
              key={range}
              type="button"
              aria-pressed={days === range}
              onClick={() => setDays(range)}
            >
              {range} days
            </button>
          ))}
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="Refresh dashboard"
          disabled={loading}
          onClick={() => setReload((value) => value + 1)}
        >
          <RefreshCw size={15} className={loading ? 'spin' : undefined} />
        </button>
      </div>
    </div>
  )

  if (!data) {
    return (
      <div className="explore-page">
        {heading}
        {error ? (
          <div className="panel analytics-empty" role="alert">
            <AlertCircle size={22} strokeWidth={1.5} />
            <p>{error}</p>
            <button type="button" className="secondary-button" onClick={() => setReload((v) => v + 1)}>
              <RefreshCw size={15} /> Try again
            </button>
          </div>
        ) : (
          <div className="dash-kpis" aria-busy="true">
            {Array.from({ length: 4 }, (_, index) => (
              <div key={index} className="live-metric skeleton" />
            ))}
          </div>
        )}
      </div>
    )
  }

  const { totals, status_counts: counts, issue_counts: issues } = data
  const humanShare = totals.clicks ? Math.round((totals.human_clicks / totals.clicks) * 100) : null
  const attention = data.links.filter(needsAttention).length
  const shares = statusShares(counts)

  if (counts.total === 0) {
    return (
      <div className="explore-page">
        {heading}
        <div className="panel empty-catalog">
          <BarChart3 size={28} strokeWidth={1.4} />
          <p>No links in this workspace yet. Create one and its traffic will show up here.</p>
          <Link className="primary-button" to="/">
            Create a link
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="explore-page" aria-busy={loading}>
      {heading}
      {error && (
        <p className="inline-note" role="status">
          {error} Showing the last loaded data.
        </p>
      )}

      <section className="dash-kpis" aria-label="Key numbers">
        <div className="dash-kpi">
          <span>Clicks</span>
          <strong className="numeric">{number.format(totals.clicks)}</strong>
          <small>
            <TrendBadge change={totals.change} current={totals.clicks} /> vs the previous {days} days (
            {number.format(totals.previous_clicks)})
          </small>
        </div>
        <div className="dash-kpi">
          <span>Human share</span>
          <strong className="numeric">{humanShare === null ? '—' : `${humanShare}%`}</strong>
          <small>
            {number.format(totals.human_clicks)} human · {number.format(totals.bot_clicks)} bot
          </small>
        </div>
        <div className="dash-kpi">
          <span>Links</span>
          <strong className="numeric">{number.format(counts.total)}</strong>
          <small>{number.format(counts.active)} active right now</small>
        </div>
        <button
          type="button"
          className={`dash-kpi dash-kpi-button ${attention ? 'has-attention' : ''}`}
          onClick={() => setFilter('attention')}
          aria-label={`${attention} links need attention. Show them in the table.`}
        >
          <span>Needs attention</span>
          <strong className="numeric">{number.format(attention)}</strong>
          <small>{attention ? 'Show them below' : 'Nothing to act on'}</small>
        </button>
      </section>

      <div className="dash-grid">
        <section className="panel dash-chart" aria-labelledby="dash-traffic">
          <div className="section-heading">
            <h2 id="dash-traffic">Clicks over time</h2>
            <span className="meta">
              {data.from} to {data.to} · UTC
            </span>
          </div>
          <ClickChart series={toChartPoints(data.series)} />
        </section>

        <section className="panel dash-status" aria-labelledby="dash-status">
          <div className="section-heading">
            <h2 id="dash-status">Link status</h2>
            <span className="meta">{number.format(counts.total)} links</span>
          </div>
          <div className="status-bar" role="img" aria-label={shares.map((s) => `${STATUS_LABEL[s.status]} ${s.count}`).join(', ')}>
            {shares.map((item) => (
              <span
                key={item.status}
                className={`seg seg-${item.status}`}
                style={{ flexGrow: item.count }}
                title={`${STATUS_LABEL[item.status]} · ${item.count}`}
              />
            ))}
          </div>
          <ul className="status-legend">
            {(['active', 'paused', 'expired', 'used_up', 'blocked'] as const)
              .filter((status) => status !== 'blocked' || counts.blocked > 0)
              .map((status) => (
                <li key={status}>
                  <button
                    type="button"
                    aria-pressed={filter === status}
                    onClick={() => setFilter(filter === status ? 'all' : status)}
                  >
                    <span className={`legend-dot seg-${status}`} aria-hidden="true" />
                    {STATUS_LABEL[status]}
                    <strong className="numeric">{counts[status]}</strong>
                  </button>
                </li>
              ))}
          </ul>
          <h3 className="dash-subhead">Watch list</h3>
          <ul className="watch-list">
            {WATCH_ISSUES.map((issue) => (
              <li key={issue}>
                <button
                  type="button"
                  aria-pressed={filter === issue}
                  disabled={!issues[issue]}
                  onClick={() => setFilter(filter === issue ? 'all' : issue)}
                >
                  <span>{ISSUE_LABEL[issue]}</span>
                  <strong className="numeric">{issues[issue] ?? 0}</strong>
                </button>
              </li>
            ))}
          </ul>
          <p className="meta">
            Expiring soon means within {data.thresholds.expiring_soon_days} days; near the limit
            means {Math.round(data.thresholds.near_limit_ratio * 100)}% of visits used; quiet means
            no clicks in this period for links older than {data.thresholds.quiet_after_days} days.
          </p>
        </section>
      </div>

      <section className="panel dash-breakdowns" aria-labelledby="dash-sources">
        <div className="section-heading">
          <h2 id="dash-sources">Where clicks come from</h2>
          <span className="meta">
            Retained events from {data.breakdowns.from}
            {data.breakdowns.truncated ? ' (older raw events have expired)' : ''}
          </span>
        </div>
        <div className="dash-breakdown-grid">
          <Breakdown
            title="Referrer origins"
            entries={data.breakdowns.top_referers}
            total={totals.clicks}
            empty="No referrer data yet."
          />
          <Breakdown
            title="Countries"
            entries={data.breakdowns.top_countries}
            total={totals.clicks}
            empty="No country data yet."
          />
          <Breakdown
            title="Devices"
            entries={data.breakdowns.devices}
            total={totals.clicks}
            empty="No device data yet."
          />
        </div>
      </section>

      <section className="panel health-panel" aria-labelledby="dash-health">
        <div className="health-toolbar">
          <div>
            <h2 id="dash-health">Link health</h2>
            <p className="meta">
              {rows.length} of {data.links.length} links
              {data.links_truncated ? ' (newest shown)' : ''}
            </p>
          </div>
          <div className="health-filters">
            <label className="search-field">
              <Search size={15} aria-hidden="true" />
              <span className="sr-only">Search links</span>
              <input
                type="search"
                placeholder="Search code or destination…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <label className="sr-only" htmlFor="health-filter">
              Filter
            </label>
            <select id="health-filter" value={filter} onChange={(e) => setFilter(e.target.value as HealthFilter)}>
              <option value="all">All links</option>
              <option value="attention">Needs attention</option>
              {(['active', 'paused', 'expired', 'used_up', 'blocked'] as const).map((status) => (
                <option key={status} value={status}>
                  {STATUS_LABEL[status]}
                </option>
              ))}
              {WATCH_ISSUES.map((issue) => (
                <option key={issue} value={issue}>
                  {ISSUE_LABEL[issue]}
                </option>
              ))}
            </select>
            <label className="sr-only" htmlFor="health-sort">
              Sort
            </label>
            <select id="health-sort" value={sort} onChange={(e) => setSort(e.target.value as HealthSort)}>
              <option value="clicks">Most clicks</option>
              <option value="change">Biggest change</option>
              <option value="last_click">Last clicked</option>
              <option value="newest">Newest</option>
            </select>
          </div>
        </div>
        {rows.length === 0 ? (
          <p className="meta health-empty">No links match these filters.</p>
        ) : (
          <div className="health-table-wrap">
            <table className="health-table">
              <thead>
                <tr>
                  <th scope="col">Link</th>
                  <th scope="col">Status</th>
                  <th scope="col" className="num">
                    Clicks
                  </th>
                  <th scope="col">Trend</th>
                  <th scope="col">Last click</th>
                  <th scope="col">Visits</th>
                  <th scope="col">Flags</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((link) => {
                  const usage = limitUsage(link)
                  const flags = link.issues.filter((issue) => issue !== link.status)
                  return (
                    <tr key={link.short_code} data-copy-url={fullUrl(link.short_url)}>
                      <td data-label="Link">
                        <Link to={`/links/${encodeURIComponent(link.short_code)}`} className="health-link">
                          <strong>{displayShortUrl(link.short_url)}</strong>
                          <span>{titleFor(link.long_url)}</span>
                        </Link>
                      </td>
                      <td data-label="Status">
                        <span className={`status status-${link.status.replace('_', '-')}`}>
                          <span className="status-dot" />
                          {STATUS_LABEL[link.status]}
                        </span>
                      </td>
                      <td data-label="Clicks" className="num numeric">
                        {number.format(link.clicks)}
                      </td>
                      <td data-label="Trend">
                        <TrendBadge change={link.change} current={link.clicks} />
                      </td>
                      <td data-label="Last click" title={link.last_click_at ?? undefined}>
                        {relativeTime(link.last_click_at)}
                      </td>
                      <td data-label="Visits">
                        {usage === null ? (
                          <span className="meta">No limit</span>
                        ) : (
                          <span className="usage">
                            <span className="usage-track">
                              <span
                                className={usage >= 1 ? 'full' : usage >= data.thresholds.near_limit_ratio ? 'near' : ''}
                                style={{ width: `${usage * 100}%` }}
                              />
                            </span>
                            <span className="numeric">
                              {number.format(link.clicks_used)}/{number.format(link.max_clicks ?? 0)}
                            </span>
                          </span>
                        )}
                      </td>
                      <td data-label="Flags">
                        {flags.length === 0 ? (
                          <span className="meta">—</span>
                        ) : (
                          <span className="flag-list">
                            {flags.map((issue) => (
                              <span key={issue} className={`flag flag-${issue}`}>
                                {ISSUE_LABEL[issue]}
                              </span>
                            ))}
                          </span>
                        )}
                      </td>
                      <td className="row-actions">
                        <button
                          type="button"
                          className="icon-button"
                          aria-label={`Copy short link for ${link.short_code}`}
                          title="Copy link"
                          onClick={() => void copy(fullUrl(link.short_url), 'Link copied to clipboard.')}
                        >
                          <Copy size={15} />
                        </button>
                        <Link
                          className="icon-button"
                          to={`/qr?code=${encodeURIComponent(link.short_code)}`}
                          aria-label={`QR code for ${link.short_code}`}
                          title="QR code"
                        >
                          <QrCode size={15} />
                        </Link>
                        <a
                          className="icon-button"
                          href={link.long_url}
                          target="_blank"
                          rel="noreferrer"
                          aria-label={`Open the destination of ${link.short_code}`}
                          title="Open destination"
                        >
                          <ExternalLink size={15} />
                        </a>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <p className="meta dash-footnote">
        {queueLabel(data.freshness)} Updated {relativeTime(data.generated_at).toLowerCase()}. Totals
        come from daily rollups; sources come from raw events, which are kept for a limited time.
      </p>
    </div>
  )
}
