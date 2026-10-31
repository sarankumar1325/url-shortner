import { useEffect, useState } from 'react'
import { Database, Trophy, Zap } from 'lucide-react'
import { Link } from 'react-router-dom'
import { getTopLinks, isProblem, type TopLinks as TopLinksData } from './api'
import { displayShortUrl, titleFor } from './links'

type Days = 1 | 7 | 30
const RANGES: { value: Days; label: string }[] = [
  { value: 1, label: 'Today' },
  { value: 7, label: '7 days' },
  { value: 30, label: '30 days' },
]

export default function TopLinks({ workspaceId }: { workspaceId: string }) {
  const [days, setDays] = useState<Days>(7)
  const [state, setState] = useState<{
    key: string
    data: TopLinksData | null
    error: string
  } | null>(null)
  const key = `${workspaceId}:${days}`

  useEffect(() => {
    const controller = new AbortController()
    getTopLinks(workspaceId, days, controller.signal)
      .then((data) => setState({ key, data, error: '' }))
      .catch((failure) => {
        if (isProblem(failure) && failure.problem.kind === 'cancelled') return
        setState({
          key,
          data: null,
          error: isProblem(failure) ? failure.problem.detail : 'Top links are unavailable.',
        })
      })
    return () => controller.abort()
  }, [workspaceId, days, key])

  const current = state?.key === key ? state : null
  const links = current?.data?.links ?? []
  const max = Math.max(1, ...links.map((item) => item.clicks))

  return (
    <section className="panel top-links" aria-labelledby="top-links-heading">
      <div className="section-heading">
        <h2 id="top-links-heading">
          <Trophy size={16} strokeWidth={1.7} /> Top links
        </h2>
        <div className="top-range" role="radiogroup" aria-label="Time range">
          {RANGES.map((range) => (
            <button
              key={range.value}
              type="button"
              role="radio"
              aria-checked={days === range.value}
              className={days === range.value ? 'active' : ''}
              onClick={() => setDays(range.value)}
            >
              {range.label}
            </button>
          ))}
        </div>
      </div>
      {!current ? (
        <p className="meta top-empty" role="status" aria-busy="true">
          Ranking links…
        </p>
      ) : current.error ? (
        <p className="meta top-empty" role="status">
          {current.error}
        </p>
      ) : links.length === 0 ? (
        <p className="meta top-empty">
          No clicks in this range yet. Share a link and it will show up here.
        </p>
      ) : (
        <ol className="top-list">
          {links.map((item, index) => (
            <li key={item.short_code}>
              <span className="top-rank numeric">{index + 1}</span>
              <Link to={`/links/${encodeURIComponent(item.short_code)}`} className="top-link">
                <strong>{displayShortUrl(item.short_url)}</strong>
                <span>{titleFor(item.long_url)}</span>
                <span className="top-bar" aria-hidden="true">
                  <span style={{ width: `${(item.clicks / max) * 100}%` }} />
                </span>
              </Link>
              <span className="top-clicks numeric">
                {item.clicks.toLocaleString()}
                <span className="sr-only"> clicks</span>
              </span>
            </li>
          ))}
        </ol>
      )}
      {current?.data && (
        <p
          className="meta top-source"
          title="Rankings are cached in Redis per workspace and recomputed from daily rollups at most once a minute."
        >
          {current.data.cached ? <Zap size={12} /> : <Database size={12} />}
          {current.data.cached
            ? `Served from cache · refreshes every ${current.data.ttl_seconds}s`
            : 'Fresh from daily rollups · now cached'}
        </p>
      )}
    </section>
  )
}
