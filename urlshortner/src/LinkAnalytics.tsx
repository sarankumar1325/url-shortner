import { useEffect, useState, type FormEvent } from 'react'
import { AlertCircle, Download, GitCompareArrows, LoaderCircle, RefreshCw } from 'lucide-react'
import { getAnalytics, isProblem, type Analytics, type DateRange } from './api'
import {
  downloadTextFile,
  getSeries,
  number,
  queueLabel,
  type LinkRecord,
} from './links'
import {
  RANGE_PRESETS,
  analyticsCsv,
  analyticsCsvName,
  changeLabel,
  changeTrend,
  customRange,
  lastDay,
  presetRange,
  previousRange,
  rangeCaption,
  rangeDays,
  utcDay,
  type RangePreset,
} from './ranges'
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

type Selection = { preset: RangePreset } | { custom: DateRange }
type Loaded = { key: string; range: DateRange; data: Analytics }
type Failure = { key: string; message: string }

const DEFAULT_PRESET: RangePreset = 30

function rangeKey(range: DateRange, reload: number): string {
  return `${range.from}:${range.to}#${reload}`
}

function failureMessage(error: unknown): string {
  return isProblem(error) ? error.problem.detail : 'Analytics could not be loaded.'
}

/** Fetches analytics for one range whenever its key changes. */
function useRangeAnalytics(
  code: string,
  workspaceId: string,
  range: DateRange | null,
  key: string,
  initial: Loaded | null,
): { loaded: Loaded | null; failure: string | null } {
  const [loaded, setLoaded] = useState<Loaded | null>(initial)
  const [failure, setFailure] = useState<Failure | null>(null)
  useEffect(() => {
    if (!range || loaded?.key === key) return
    const controller = new AbortController()
    getAnalytics(code, range, { workspaceId }, controller.signal)
      .then((data) => setLoaded({ key, range, data }))
      .catch((error: unknown) => {
        if (isProblem(error) && error.problem.kind === 'cancelled') return
        setFailure({ key, message: failureMessage(error) })
      })
    return () => controller.abort()
    // The range object is rebuilt each render; its key captures its value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, workspaceId, key, loaded?.key])
  return { loaded, failure: failure?.key === key ? failure.message : null }
}

export default function LinkAnalytics({
  link,
  workspaceId,
}: {
  link: LinkRecord
  workspaceId: string
}) {
  const [selection, setSelection] = useState<Selection>({ preset: DEFAULT_PRESET })
  const [compare, setCompare] = useState(false)
  const [reload, setReload] = useState(0)
  const [table, setTable] = useState(false)
  const [customOpen, setCustomOpen] = useState(false)
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  const [customError, setCustomError] = useState<string | null>(null)
  const [today] = useState(() => utcDay(new Date()))

  const preset = 'preset' in selection ? selection.preset : null
  const range = 'preset' in selection ? presetRange(selection.preset) : selection.custom
  const key = rangeKey(range, reload)
  const initialRange = presetRange(DEFAULT_PRESET)
  const current = useRangeAnalytics(
    link.code,
    workspaceId,
    range,
    key,
    link.analytics
      ? { key: rangeKey(initialRange, 0), range: initialRange, data: link.analytics }
      : null,
  )
  const comparison = previousRange(range)
  const comparisonKey = rangeKey(comparison, reload)
  const previous = useRangeAnalytics(
    link.code,
    workspaceId,
    compare ? comparison : null,
    comparisonKey,
    null,
  )

  const shown = current.loaded
  const updating = shown?.key !== key && !current.failure
  const previousData =
    compare && previous.loaded?.key === comparisonKey ? previous.loaded.data : null
  const comparing = compare && !previousData && !previous.failure

  function chooseCustom(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const parsed = customRange(customFrom, customTo)
    setCustomError(parsed.error)
    if (parsed.range) {
      setSelection({ custom: parsed.range })
      setCustomOpen(false)
    }
  }

  function openCustom() {
    setCustomFrom(range.from)
    setCustomTo(lastDay(range))
    setCustomError(null)
    setCustomOpen(true)
  }

  const heading = (
    <div className="section-heading analytics-heading">
      <div>
        <h2 id="analytics-heading">The story behind the clicks</h2>
        <p className="meta">
          {shown ? (
            <>
              Last processed event:{' '}
              {shown.data.last_processed_at
                ? formatUtc(shown.data.last_processed_at)
                : 'none yet'}
              . {queueLabel(shown.data.freshness)} All dates UTC.
            </>
          ) : (
            'Analytics are visible to everyone in this workspace.'
          )}
        </p>
      </div>
      <div className="analytics-controls">
        <div className="segmented-control" role="group" aria-label="Analytics date range">
          {RANGE_PRESETS.map((days) => (
            <button
              type="button"
              key={days}
              aria-pressed={preset === days}
              onClick={() => {
                setSelection({ preset: days })
                setCustomOpen(false)
              }}
            >
              {days} days
            </button>
          ))}
          <button
            type="button"
            aria-pressed={preset === null}
            aria-expanded={customOpen}
            aria-controls="analytics-custom-range"
            onClick={() => (customOpen ? setCustomOpen(false) : openCustom())}
          >
            Custom
          </button>
        </div>
        <button
          type="button"
          className={`secondary-button compare-toggle${compare ? ' on' : ''}`}
          aria-pressed={compare}
          onClick={() => setCompare(!compare)}
        >
          {comparing ? <LoaderCircle size={14} className="spin" /> : <GitCompareArrows size={14} />}
          Compare to previous period
        </button>
      </div>
    </div>
  )

  const customForm = customOpen && (
    <form className="custom-range panel" id="analytics-custom-range" onSubmit={chooseCustom} noValidate>
      <div>
        <label htmlFor="analytics-from">From</label>
        <input
          id="analytics-from"
          type="date"
          value={customFrom}
          max={today}
          onChange={(event) => setCustomFrom(event.target.value)}
          aria-describedby="analytics-range-hint"
        />
      </div>
      <div>
        <label htmlFor="analytics-to">To</label>
        <input
          id="analytics-to"
          type="date"
          value={customTo}
          max={today}
          onChange={(event) => setCustomTo(event.target.value)}
          aria-describedby="analytics-range-hint"
        />
      </div>
      <button type="submit" className="primary-button">
        Apply
      </button>
      <p
        id="analytics-range-hint"
        className={customError ? 'field-error' : 'field-hint'}
        role={customError ? 'alert' : undefined}
      >
        {customError ?? 'Both days are included. Up to 366 days, in UTC.'}
      </p>
    </form>
  )

  if (!shown) {
    return (
      <section className="analytics-section" aria-labelledby="analytics-heading">
        {heading}
        {customForm}
        {current.failure ? (
          <div className="panel analytics-empty" role="alert">
            <AlertCircle size={22} strokeWidth={1.5} />
            <p>{current.failure}</p>
            <button type="button" className="secondary-button" onClick={() => setReload(reload + 1)}>
              <RefreshCw size={15} /> Try again
            </button>
          </div>
        ) : (
          <div className="loading-panel" role="status" aria-busy="true">
            Loading analytics…
          </div>
        )}
      </section>
    )
  }

  const analytics = shown.data
  const shownRange = shown.range
  const days = rangeDays(shownRange)
  const series = getSeries({ analytics }, shownRange)
  const previousSeries = previousData
    ? getSeries({ analytics: previousData }, previousRange(shownRange))
    : undefined
  const totals = analytics.totals
  const breakdowns = analytics.breakdowns
  const windowLabel =
    breakdowns.from && breakdowns.to
      ? `${breakdowns.from} to ${lastDay({ from: breakdowns.from, to: breakdowns.to })}`
      : 'no retained events in the window'
  const caption = rangeCaption(shownRange, shown.key === key ? preset : null)

  function change(currentValue: number, previousValue: number | undefined) {
    if (previousValue === undefined) return null
    return (
      <small className={`metric-change change-${changeTrend(currentValue, previousValue)}`}>
        {changeLabel(currentValue, previousValue, days)}
      </small>
    )
  }

  return (
    <section
      className="analytics-section"
      aria-labelledby="analytics-heading"
      aria-busy={updating || comparing}
    >
      {heading}
      {customForm}
      {(updating || current.failure || previous.failure) && (
        <p
          className={current.failure || previous.failure ? 'field-error' : 'meta analytics-status'}
          role={current.failure || previous.failure ? 'alert' : 'status'}
        >
          {current.failure
            ? `${current.failure} Showing the previous range.`
            : previous.failure
              ? `The previous period could not be loaded. ${previous.failure}`
              : 'Updating…'}
        </p>
      )}
      <div className={`metrics-strip${updating ? ' stale' : ''}`}>
        <div>
          <span>Total clicks</span>
          <strong>{number.format(totals.clicks)}</strong>
          <small>{caption}</small>
          {change(totals.clicks, previousData?.totals.clicks)}
        </div>
        <div>
          <span>Human clicks</span>
          <strong>{number.format(totals.human_clicks)}</strong>
          <small>Not unique people</small>
          {change(totals.human_clicks, previousData?.totals.human_clicks)}
        </div>
        <div>
          <span>Bot clicks</span>
          <strong>{number.format(totals.bot_clicks)}</strong>
          <small>Classified from the user agent</small>
          {change(totals.bot_clicks, previousData?.totals.bot_clicks)}
        </div>
      </div>
      <div className={`analytics-grid${updating ? ' stale' : ''}`}>
        <div className="panel traffic-panel">
          <div className="section-heading">
            <h3>Clicks over time</h3>
            <div className="traffic-actions">
              <button
                type="button"
                className="text-button"
                onClick={() => {
                  downloadTextFile(
                    analyticsCsvName(link.code, shownRange),
                    '\uFEFF' + analyticsCsv(series, breakdowns),
                  )
                }}
              >
                <Download size={14} /> Export CSV
              </button>
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
          </div>
          <ClickChart series={series} previous={previousSeries} />
          {totals.clicks === 0 && (
            <p className="empty-chart-note">No clicks recorded in this range yet.</p>
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
                  Daily clicks · UTC · {series[0]?.day} to {series.at(-1)?.day}, inclusive
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Date</th>
                    <th scope="col">Clicks</th>
                    <th scope="col">Human</th>
                    <th scope="col">Bot</th>
                    {previousSeries && <th scope="col">Previous period</th>}
                  </tr>
                </thead>
                <tbody>
                  {series.map((point, index) => (
                    <tr key={point.day}>
                      <th scope="row">{point.day}</th>
                      <td>{point.clicks}</td>
                      <td>{point.humans}</td>
                      <td>{point.bots}</td>
                      {previousSeries && <td>{previousSeries[index]?.clicks ?? 0}</td>}
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
              onClick={() => setReload(reload + 1)}
            >
              <RefreshCw size={15} />
            </button>
          </div>
          <p className="meta">
            Retained events · {windowLabel}
            {breakdowns.truncated ? ' · older raw events are no longer kept, so this covers part of the range' : ''}
          </p>
          <Breakdown
            title="Referrer origins"
            entries={breakdowns.top_referers}
            total={totals.clicks}
            empty="No referrer data in this window."
          />
          <Breakdown
            title="Countries"
            entries={breakdowns.top_countries}
            total={totals.clicks}
            empty="No country data in this window."
          />
          <Breakdown
            title="Devices"
            entries={breakdowns.devices}
            total={totals.clicks}
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
