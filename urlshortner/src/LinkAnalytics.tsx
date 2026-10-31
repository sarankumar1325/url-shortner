import { useState } from 'react'
import { AlertCircle, RefreshCw } from 'lucide-react'
import {
  getSeries,
  number,
  queueLabel,
  seriesTotals,
  type LinkRecord,
} from './links'
import { ClickChart } from './ClickChart'

function formatUtc(value: string): string {
  return new Date(value).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
    timeZoneName: 'short',
  })
}

export function Breakdown({
  title,
  entries,
  total,
  empty,
}: {
  title: string
  entries: { value: string | null; clicks: number }[]
  total: number
  empty: string
}) {
  const max = Math.max(...entries.map((entry) => entry.clicks), 1)
  return (
    <div className="breakdown">
      <h4>{title}</h4>
      {entries.length === 0 ? (
        <p className="meta">{empty}</p>
      ) : (
        entries.map((entry) => (
          <div className="referrer" key={entry.value ?? 'unknown'}>
            <div>
              <span>{entry.value ?? 'Unknown'}</span>
              <span className="numeric">{number.format(entry.clicks)}</span>
            </div>
            <div className="bar-track">
              <div style={{ width: `${(entry.clicks / max) * 100}%` }} />
            </div>
          </div>
        ))
      )}
      {entries.length > 0 && total > 0 && (
        <p className="breakdown-note">
          {number.format(entries.reduce((sum, entry) => sum + entry.clicks, 0))}{' '}
          of {number.format(total)} clicks in the breakdown window.
        </p>
      )}
    </div>
  )
}

export default function LinkAnalytics({
  link,
  onRefresh,
}: {
  link: LinkRecord
  onRefresh: () => void
}) {
  const [days, setDays] = useState<7 | 30>(7)
  const [table, setTable] = useState(false)

  if (!link.analytics) {
    return (
      <section className="analytics-section" aria-labelledby="analytics-heading">
        <div className="section-heading analytics-heading">
          <div>
            <h2 id="analytics-heading">The story behind the clicks</h2>
            <p className="meta">
              Analytics are visible to everyone in this workspace.
            </p>
          </div>
        </div>
        {link.analyticsLoading ? (
          <div className="loading-panel" role="status" aria-busy="true">
            Loading analytics…
          </div>
        ) : (
          <div className="panel analytics-empty" role="alert">
            <AlertCircle size={22} strokeWidth={1.5} />
            <p>{link.analyticsError ?? 'Analytics could not be loaded.'}</p>
            <button
              type="button"
              className="secondary-button"
              onClick={onRefresh}
            >
              <RefreshCw size={15} /> Try again
            </button>
          </div>
        )}
      </section>
    )
  }

  const analytics = link.analytics
  const series = getSeries(link, days)
  const totals = seriesTotals(series)
  const breakdowns = analytics.breakdowns
  const breakdownTotal = analytics.totals.clicks
  const windowLabel =
    breakdowns.from && breakdowns.to
      ? `${breakdowns.from} to ${breakdowns.to}`
      : 'no retained events in the window'

  return (
    <section className="analytics-section" aria-labelledby="analytics-heading">
      <div className="section-heading analytics-heading">
        <div>
          <h2 id="analytics-heading">The story behind the clicks</h2>
          <p className="meta">
            Last processed event:{' '}
            {analytics.last_processed_at
              ? formatUtc(analytics.last_processed_at)
              : 'none yet'}
            . {queueLabel(analytics.freshness)} All dates UTC.
          </p>
        </div>
        <div
          className="segmented-control"
          role="group"
          aria-label="Analytics date range"
        >
          {([7, 30] as const).map((range) => (
            <button
              type="button"
              key={range}
              aria-pressed={days === range}
              onClick={() => setDays(range)}
            >
              {range} days
            </button>
          ))}
        </div>
      </div>
      <div className="metrics-strip">
        <div>
          <span>Total clicks</span>
          <strong>{number.format(totals.clicks)}</strong>
          <small>In the last {days} UTC days</small>
        </div>
        <div>
          <span>Human clicks</span>
          <strong>{number.format(totals.humans)}</strong>
          <small>Not unique people</small>
        </div>
        <div>
          <span>Bot clicks</span>
          <strong>{number.format(totals.bots)}</strong>
          <small>Classified from the user agent</small>
        </div>
      </div>
      <div className="analytics-grid">
        <div className="panel traffic-panel">
          <div className="section-heading">
            <h3>Clicks over time</h3>
            <button
              type="button"
              className="text-button"
              onClick={() => setTable(!table)}
              aria-expanded={table}
              aria-controls="daily-click-table"
            >
              {table ? 'Hide data table' : 'View data table'}
            </button>
          </div>
          <ClickChart series={series} />
          {totals.clicks === 0 && (
            <p className="empty-chart-note">
              No clicks recorded in this range yet.
            </p>
          )}
          {table && (
            <div
              className="daily-table-wrap"
              id="daily-click-table"
              tabIndex={0}
              aria-label="Scrollable daily click data"
            >
              <table className="daily-table">
                <caption>
                  Daily clicks · UTC · {series[0]?.day} to{' '}
                  {series.at(-1)?.day}, inclusive
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Date</th>
                    <th scope="col">Clicks</th>
                    <th scope="col">Human</th>
                    <th scope="col">Bot</th>
                  </tr>
                </thead>
                <tbody>
                  {series.map((point) => (
                    <tr key={point.day}>
                      <th scope="row">{point.day}</th>
                      <td>{point.clicks}</td>
                      <td>{point.humans}</td>
                      <td>{point.bots}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div className="panel referrers-panel">
          <div className="section-heading">
            <h3>Where clicks begin</h3>
            <button
              type="button"
              className="icon-button"
              aria-label="Refresh analytics"
              onClick={onRefresh}
            >
              <RefreshCw size={15} />
            </button>
          </div>
          <p className="meta">
            Retained events · {windowLabel}
            {breakdowns.truncated ? ' · top results shown' : ''}
          </p>
          <Breakdown
            title="Referrer origins"
            entries={breakdowns.top_referers}
            total={breakdownTotal}
            empty="No referrer data in this window."
          />
          <Breakdown
            title="Countries"
            entries={breakdowns.top_countries}
            total={breakdownTotal}
            empty="No country data in this window."
          />
          <Breakdown
            title="Devices"
            entries={breakdowns.devices}
            total={breakdownTotal}
            empty="No device data in this window."
          />
          <p className="meta referrer-note">
            “Unknown” means the value was not available, not necessarily direct
            traffic. Top lists need not add up to the total.
          </p>
        </div>
      </div>
      <p className="analytics-footnote">
        Clicks are queued durably and retried if processing fails, so a click
        can take a moment to appear. IP addresses are never stored.
      </p>
    </section>
  )
}
