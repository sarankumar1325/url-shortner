import { useEffect, useMemo, useState } from 'react'
import {
  Activity,
  ArrowRight,
  CircleGauge,
  Database,
  ExternalLink,
  Layers,
  Pause,
  Play,
  RadioTower,
  Search,
  ShieldAlert,
  Trophy,
  Zap,
  type LucideIcon,
} from 'lucide-react'
import { getSystemStatus, isProblem, type SystemStatus } from './api'
import {
  CATEGORIES,
  CONCEPTS,
  filterConcepts,
  formatRatio,
  formatUptime,
  type ConceptCategory,
  type LiveSignal,
} from './concepts'
import './explore.css'

const REPO = 'https://github.com/sarankumar1325/url-shortner/blob/main/'
const POLL_MS = 5000

const PIPELINE: { title: string; detail: string; concept: string }[] = [
  { title: 'Rate limit', detail: '600 / min per IP, fail-open', concept: 'rate-limits' },
  { title: 'Redis cache', detail: 'cache-aside, 60 s TTL', concept: 'cache-aside' },
  { title: 'Single-flight', detail: 'one load per hot miss', concept: 'single-flight' },
  { title: 'Postgres', detail: 'source of truth', concept: 'multi-tenancy' },
  { title: 'Visit guard', detail: 'atomic, never over limit', concept: 'guarded-counters' },
  { title: '302 + XADD', detail: 'click queued, not awaited', concept: 'async-analytics' },
  { title: 'Consumer group', detail: 'ACK after commit', concept: 'consumer-group' },
  { title: 'Daily rollups', detail: 'charts read these', concept: 'rollups' },
]

function useSystemStatus(paused: boolean) {
  const [status, setStatus] = useState<SystemStatus | null>(null)
  const [error, setError] = useState('')
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null)

  useEffect(() => {
    if (paused) return
    let controller: AbortController | null = null
    let timer = 0
    let stopped = false

    async function tick() {
      if (document.visibilityState === 'visible') {
        controller = new AbortController()
        try {
          const next = await getSystemStatus(controller.signal)
          if (stopped) return
          setStatus(next)
          setError('')
          setUpdatedAt(new Date())
        } catch (failure) {
          if (stopped) return
          if (isProblem(failure) && failure.problem.kind === 'cancelled') return
          setError(
            isProblem(failure)
              ? failure.problem.detail
              : 'Live status is unavailable.',
          )
        }
      }
      if (!stopped) timer = window.setTimeout(tick, POLL_MS)
    }

    void tick()
    return () => {
      stopped = true
      window.clearTimeout(timer)
      controller?.abort()
    }
  }, [paused])

  return { status, error, updatedAt }
}

type Tone = 'good' | 'warn' | 'bad' | 'idle'

function Metric({
  icon: Icon,
  label,
  value,
  detail,
  tone = 'idle',
}: {
  icon: LucideIcon
  label: string
  value: string
  detail: string
  tone?: Tone
}) {
  return (
    <div className={`live-metric tone-${tone}`}>
      <div className="live-metric-label">
        <Icon size={15} strokeWidth={1.8} />
        <span>{label}</span>
      </div>
      <strong className="numeric">{value}</strong>
      <span className="live-metric-detail">{detail}</span>
    </div>
  )
}

function liveValue(signal: LiveSignal, status: SystemStatus | null): string | null {
  if (!status) return null
  switch (signal) {
    case 'redirect-cache':
      return status.redirect_cache.hit_ratio === null
        ? 'no traffic yet'
        : `${formatRatio(status.redirect_cache.hit_ratio)} hit ratio`
    case 'single-flight':
      return `${status.redirect_cache.single_flight.shared} coalesced`
    case 'breaker':
      return status.circuit_breaker.state.replace('_', '-')
    case 'rate-limits':
      return `${status.rate_limits.allowed} allowed · ${status.rate_limits.blocked} blocked`
    case 'stream':
      return status.analytics_stream.stream_depth === null
        ? 'stream unavailable'
        : `${status.analytics_stream.pending ?? 0} pending`
    case 'leaderboard':
      return `${status.leaderboard_cache.hits} hits · ${status.leaderboard_cache.misses} misses`
    case 'readiness':
      return status.dependencies.postgres.ok && status.dependencies.redis.ok
        ? 'ready'
        : 'degraded'
  }
}

function LiveDashboard({ status }: { status: SystemStatus }) {
  const { postgres, redis } = status.dependencies
  const breaker = status.circuit_breaker
  const cache = status.redirect_cache
  const flight = cache.single_flight
  const stream = status.analytics_stream
  const limits = status.rate_limits
  return (
    <div className="live-grid">
      <Metric
        icon={Database}
        label="Postgres"
        value={postgres.ok ? `${postgres.latency_ms} ms` : 'Down'}
        detail={postgres.ok ? 'SELECT 1 round trip' : (postgres.error ?? 'unreachable')}
        tone={postgres.ok ? (postgres.latency_ms > 400 ? 'warn' : 'good') : 'bad'}
      />
      <Metric
        icon={Zap}
        label="Redis"
        value={redis.ok ? `${redis.latency_ms} ms` : redis.error === 'circuit_open' ? 'Skipped' : 'Down'}
        detail={redis.ok ? 'PING over REST' : redis.error === 'circuit_open' ? 'circuit is open' : 'unreachable'}
        tone={redis.ok ? (redis.latency_ms > 400 ? 'warn' : 'good') : 'bad'}
      />
      <Metric
        icon={ShieldAlert}
        label="Circuit breaker"
        value={breaker.state === 'half_open' ? 'Half-open' : breaker.state === 'open' ? 'Open' : 'Closed'}
        detail={
          breaker.state === 'open'
            ? `retry in ${breaker.retry_in_seconds ?? 0}s`
            : `${breaker.consecutive_failures}/${breaker.failure_threshold} failures · opened ${breaker.times_opened}×`
        }
        tone={breaker.state === 'closed' ? 'good' : breaker.state === 'open' ? 'bad' : 'warn'}
      />
      <Metric
        icon={CircleGauge}
        label="Redirect cache"
        value={formatRatio(cache.hit_ratio)}
        detail={`${cache.hits} hits · ${cache.misses} misses · ${cache.ttl_seconds}s TTL`}
        tone={cache.hit_ratio === null ? 'idle' : cache.hit_ratio >= 0.5 ? 'good' : 'warn'}
      />
      <Metric
        icon={Layers}
        label="Single-flight"
        value={`${flight.shared}`}
        detail={`requests coalesced into ${flight.leaders} loads`}
        tone={flight.shared > 0 ? 'good' : 'idle'}
      />
      <Metric
        icon={RadioTower}
        label="Analytics stream"
        value={stream.stream_depth === null ? '—' : `${stream.pending ?? 0}`}
        detail={
          stream.stream_depth === null
            ? 'stream unavailable'
            : `pending · ${stream.lag ?? 0} unread · ${stream.dead_letter_depth ?? 0} dead`
        }
        tone={
          stream.stream_depth === null
            ? 'bad'
            : (stream.dead_letter_depth ?? 0) > 0
              ? 'warn'
              : 'good'
        }
      />
      <Metric
        icon={Trophy}
        label="Leaderboard cache"
        value={`${status.leaderboard_cache.hits}`}
        detail={`hits · ${status.leaderboard_cache.misses} misses · ${status.leaderboard_cache.ttl_seconds}s TTL`}
        tone={status.leaderboard_cache.hits > 0 ? 'good' : 'idle'}
      />
      <Metric
        icon={Activity}
        label="Rate limiter"
        value={`${limits.allowed}`}
        detail={`allowed · ${limits.blocked} blocked · ${limits.fail_open} fail-open`}
        tone={limits.fail_open + limits.fail_closed > 0 ? 'warn' : 'good'}
      />
    </div>
  )
}

export default function SystemDesign() {
  const [paused, setPaused] = useState(false)
  const [category, setCategory] = useState<ConceptCategory | 'All'>('All')
  const [query, setQuery] = useState('')
  const { status, error, updatedAt } = useSystemStatus(paused)
  const concepts = useMemo(
    () => filterConcepts(CONCEPTS, category, query),
    [category, query],
  )

  function focusConcept(id: string) {
    setCategory('All')
    setQuery('')
    window.requestAnimationFrame(() => {
      const card = document.getElementById(`concept-${id}`)
      card?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      card?.focus({ preventScroll: true })
    })
  }

  return (
    <div className="explore-page">
      <div className="page-heading">
        <span className="eyebrow">Under the hood</span>
        <h1 tabIndex={-1}>More than a short link.</h1>
        <p>
          Shortly is a small product built like a large system. Here is what
          runs behind every redirect, with live numbers from the API instance
          serving you right now.
        </p>
      </div>

      <section className="panel live-panel" aria-labelledby="live-heading">
        <div className="section-heading">
          <div>
            <h2 id="live-heading">
              <span
                className={`live-dot ${paused || !status ? 'idle' : error ? 'bad' : ''}`}
                aria-hidden="true"
              />
              Live system signals
            </h2>
            <p className="meta">
              {status
                ? `Instance up ${formatUptime(status.instance.uptime_seconds)} · ${status.instance.environment}`
                : 'Connecting to the API…'}
              {updatedAt && ` · updated ${updatedAt.toLocaleTimeString()}`}
            </p>
          </div>
          <button
            type="button"
            className="secondary-button"
            onClick={() => setPaused((value) => !value)}
            aria-pressed={paused}
          >
            {paused ? <Play size={15} /> : <Pause size={15} />}
            {paused ? 'Resume' : 'Pause'}
          </button>
        </div>
        {error && (
          <p className="inline-note" role="status">
            {error}
          </p>
        )}
        {status ? (
          <LiveDashboard status={status} />
        ) : (
          !error && (
            <div className="live-grid" aria-busy="true">
              {Array.from({ length: 8 }, (_, index) => (
                <div key={index} className="live-metric skeleton" />
              ))}
            </div>
          )
        )}
        <p className="meta live-footnote">
          Counters belong to this one serverless instance and reset on a cold
          start. Open a few short links in another tab and watch them move.
        </p>
      </section>

      <section className="pipeline-section" aria-labelledby="pipeline-heading">
        <h2 id="pipeline-heading">The life of one click</h2>
        <ol className="pipeline">
          {PIPELINE.map((step, index) => (
            <li key={step.title}>
              <button type="button" onClick={() => focusConcept(step.concept)}>
                <span className="pipeline-index numeric">{index + 1}</span>
                <strong>{step.title}</strong>
                <span>{step.detail}</span>
              </button>
              {index < PIPELINE.length - 1 && (
                <ArrowRight className="pipeline-arrow" size={14} aria-hidden="true" />
              )}
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="catalog-heading">
        <div className="catalog-toolbar">
          <div>
            <h2 id="catalog-heading">Concept catalog</h2>
            <p className="meta">
              {concepts.length} of {CONCEPTS.length} patterns, each linked to
              the code that implements it.
            </p>
          </div>
          <label className="search-field catalog-search">
            <Search size={15} aria-hidden="true" />
            <span className="sr-only">Search concepts</span>
            <input
              type="search"
              placeholder="Search concepts…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
        </div>
        <div className="chip-row" role="group" aria-label="Filter by category">
          {(['All', ...CATEGORIES] as const).map((item) => (
            <button
              key={item}
              type="button"
              className={`chip ${category === item ? 'active' : ''}`}
              aria-pressed={category === item}
              onClick={() => setCategory(item)}
            >
              {item}
            </button>
          ))}
        </div>
        {concepts.length === 0 ? (
          <div className="panel empty-catalog">
            <p>No concepts match “{query}”.</p>
          </div>
        ) : (
          <div className="concept-grid">
            {concepts.map((concept) => {
              const live = concept.live ? liveValue(concept.live, status) : null
              return (
                <article
                  key={concept.id}
                  id={`concept-${concept.id}`}
                  className="concept-card"
                  tabIndex={-1}
                >
                  <div className="concept-head">
                    <span className={`concept-category cat-${concept.category.replace(' ', '-').toLowerCase()}`}>
                      {concept.category}
                    </span>
                    {concept.live && (
                      <span className="concept-live">
                        <span className="live-dot" aria-hidden="true" />
                        {live ?? 'live'}
                      </span>
                    )}
                  </div>
                  <h3>{concept.title}</h3>
                  <p className="concept-summary">{concept.summary}</p>
                  <dl>
                    <dt>How it works</dt>
                    <dd>{concept.how}</dd>
                    <dt>Trade-off</dt>
                    <dd>{concept.tradeoff}</dd>
                  </dl>
                  <div className="concept-code">
                    {concept.code.map((path) => (
                      <a
                        key={path}
                        href={`${REPO}${path}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <code>{path.split('/').at(-1)}</code>
                        <ExternalLink size={11} aria-hidden="true" />
                      </a>
                    ))}
                  </div>
                </article>
              )
            })}
          </div>
        )}
      </section>
    </div>
  )
}
