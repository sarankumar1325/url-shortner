import { useEffect, useId, useRef, useState } from 'react'
import { ArrowUpRight, ArrowRight, MousePointer2 } from 'lucide-react'
import { Link } from 'react-router-dom'
import {
  getSeries,
  number,
  seriesTotals,
  type ChartPoint,
  type LinkRecord,
} from './links'

export function ClickChart({
  series,
  previous,
  compact = false,
}: {
  series: ChartPoint[]
  /** The comparison period, drawn as a dashed line aligned day by day. */
  previous?: ChartPoint[]
  compact?: boolean
}) {
  const id = useId()
  const container = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(320)
  const [highlight, setHighlight] = useState<number | null>(null)
  useEffect(() => {
    const element = container.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) =>
      setWidth(Math.max(100, entry.contentRect.width)),
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const height = compact ? 130 : 220
  const left = compact ? 24 : 32
  const bottom = height - 24
  const step = (width - left - 6) / series.length
  const peak = Math.max(
    0,
    ...series.map((point) => point.clicks),
    ...(previous ?? []).map((point) => point.clicks),
  )
  const max = Math.max(4, Math.ceil((peak + 1) / 4) * 4)
  const total = seriesTotals(series).clicks
  const previousTotal = previous ? seriesTotals(previous).clicks : null
  const selected = highlight === null ? null : series[highlight]
  const selectedPrevious = highlight === null ? undefined : previous?.[highlight]
  const overlay = previous
    ?.slice(0, series.length)
    .map((point, index) => {
      const x = left + index * step + step * 0.5
      const y = bottom - (point.clicks / max) * (bottom - 8)
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
  const formatDay = (day: string) =>
    new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    })

  return (
    <div className={`click-chart ${compact ? 'compact' : ''}`} ref={container}>
      <div className="chart-readout" aria-live="polite">
        {selected
          ? `${formatDay(selected.day)} · ${number.format(selected.clicks)} clicks${
              selectedPrevious
                ? ` · ${formatDay(selectedPrevious.day)}: ${number.format(selectedPrevious.clicks)}`
                : ''
            }`
          : `${number.format(total)} clicks${
              previousTotal === null ? '' : ` · ${number.format(previousTotal)} in the previous period (dashed)`
            } · all dates UTC`}
      </div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-labelledby={`${id}-title ${id}-desc`}
      >
        <title id={`${id}-title`}>Daily clicks</title>
        <desc id={`${id}-desc`}>
          {number.format(total)} clicks over {series.length} days.
          {previousTotal !== null &&
            ` A dashed line shows the previous ${series.length} days, with ${number.format(previousTotal)} clicks.`}{' '}
          An equivalent daily data table is available in the full analytics view.
        </desc>
        {[0, 1, 2, 3, 4].map((tick) => {
          const y = bottom - ((bottom - 8) * tick) / 4
          return (
            <g key={tick}>
              <line
                x1={left}
                x2={width - 2}
                y1={y}
                y2={y}
                className="chart-grid"
              />
              <text
                x={left - 7}
                y={y + 4}
                textAnchor="end"
                className="chart-label"
              >
                {(max * tick) / 4}
              </text>
            </g>
          )
        })}
        {series.map((point, index) => {
          const barHeight = (point.clicks / max) * (bottom - 8)
          const x = left + index * step + step * 0.2
          const showMiddle =
            width >= 250 && index === Math.floor((series.length - 1) / 2)
          return (
            <g
              key={point.day}
              onPointerEnter={() => setHighlight(index)}
              onPointerLeave={() => setHighlight(null)}
            >
              <rect
                x={x}
                y={8}
                width={step * 0.6}
                height={bottom - 8}
                fill="transparent"
              />
              <rect
                x={x}
                y={bottom - barHeight}
                width={step * 0.6}
                height={barHeight}
                rx="2"
                className={`chart-bar ${highlight === index ? 'highlighted' : ''}`}
              >
                <title>
                  {formatDay(point.day)}: {point.clicks} clicks
                </title>
              </rect>
              {(index === 0 || index === series.length - 1 || showMiddle) && (
                <text
                  x={
                    index === 0
                      ? left
                      : index === series.length - 1
                        ? width - 2
                        : x + step * 0.3
                  }
                  y={height - 4}
                  textAnchor={
                    index === 0
                      ? 'start'
                      : index === series.length - 1
                        ? 'end'
                        : 'middle'
                  }
                  className="chart-label"
                >
                  {formatDay(point.day)}
                </text>
              )}
            </g>
          )
        })}
        {overlay && (
          <polyline points={overlay} className="chart-previous" aria-hidden="true" />
        )}
      </svg>
    </div>
  )
}

export function AnalyticsTeaser({ link }: { link: LinkRecord | undefined }) {
  if (!link || !link.analytics)
    return (
      <aside className="analytics-teaser panel">
        <MousePointer2 size={20} strokeWidth={1.5} />
        <h2>There’s a story in every click.</h2>
        <p>
          {link?.analyticsLoading
            ? 'Loading the last 30 days of clicks…'
            : link?.analyticsError
              ? 'Analytics are unavailable for this link right now.'
              : 'Create a link and its first clicks will show up here.'}
        </p>
        <span className="meta">
          Analytics appear as soon as this workspace has a click.
        </span>
      </aside>
    )
  const series = getSeries(link, 7)
  const total = seriesTotals(series).clicks
  return (
    <aside className="analytics-teaser panel">
      <div className="section-heading">
        <h2>A little perspective</h2>
        <ArrowUpRight size={18} />
      </div>
      <div className="teaser-metric">
        <span className="big-number">{number.format(total)}</span>
        <span>
          clicks
          <br />
          <span className="meta">Last 7 days</span>
        </span>
      </div>
      <ClickChart series={series} compact />
      <Link className="text-link teaser-link" to={`/links/${link.code}`}>
        Explore link analytics <ArrowRight size={15} />
      </Link>
    </aside>
  )
}
