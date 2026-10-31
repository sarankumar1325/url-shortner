import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Activity,
  ArrowRight,
  CircleGauge,
  Database,
  ExternalLink,
  FlaskConical,
  Gauge,
  Layers,
  LoaderCircle,
  Pause,
  Play,
  RadioTower,
  Search,
  ShieldAlert,
  Snowflake,
  Trophy,
  Zap,
  type LucideIcon,
} from 'lucide-react'
import { Link } from 'react-router-dom'
import {
  getSystemStatus,
  isProblem,
  traceRedirect,
  type RedirectTrace,
  type SystemConfig,
  type SystemStatus,
  type TraceStep,
} from './api'
import {
  CATEGORIES,
  CONCEPTS,
  conceptValues,
  filterConcepts,
  formatRatio,
  formatUptime,
  formatWindow,
  humanCount,
  type ConceptCategory,
  type LiveSignal,
} from './concepts'
import { displayShortUrl, number, titleFor, type LinkRecord } from './links'
import {
  cacheOutcome,
  formatMs,
  outcomeLabel,
  outcomeTone,
  responseLabel,
  speedup,
  waterfall,
  type Tone,
} from './trace'
import './explore.css'

const REPO = 'https://github.com/sarankumar1325/url-shortner/blob/main/'
const POLL_MS = 5000
const HISTORY = 24
const MAX_RUNS = 6

type Sample = { postgres: number | null; redis: number | null }

function useSystemStatus(paused: boolean) {
  const [status, setStatus] = useState<SystemStatus | null>(null)
  const [history, setHistory] = useState<Sample[]>([])
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
          setHistory((current) =>
            [
              ...current,
              {
                postgres: next.dependencies.postgres.ok ? next.dependencies.postgres.latency_ms : null,
                redis: next.dependencies.redis.ok ? next.dependencies.redis.latency_ms : null,
              },
            ].slice(-HISTORY),
          )
          setError('')
          setUpdatedAt(new Date())
        } catch (failure) {
          if (stopped) return
          if (isProblem(failure) && failure.problem.kind === 'cancelled') return
          setError(isProblem(failure) ? failure.problem.detail : 'Live status is unavailable.')
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

  return { status, history, error, updatedAt }
}

function Sparkline({ values, label }: { values: (number | null)[]; label: string }) {
  const points = values.map((value, index) => ({ value, index })).filter((p) => p.value !== null)
  if (points.length < 2) return null
  const max = Math.max(...points.map((p) => p.value as number), 1)
  const width = 100
  const height = 28
  const step = width / Math.max(1, values.length - 1)
  const d = points
    .map((p, i) => `${i ? 'L' : 'M'}${(p.index * step).toFixed(1)} ${(height - ((p.value as number) / max) * (height - 4) - 2).toFixed(1)}`)
    .join('')
  return (
    <svg className="sparkline" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={label}>
      <path d={d} />
    </svg>
  )
}

function Metric({
  icon: Icon,
  label,
  value,
  detail,
  tone = 'idle',
  spark,
}: {
  icon: LucideIcon
  label: string
  value: string
  detail: string
  tone?: Tone
  spark?: ReactNode
}) {
  return (
    <div className={`live-metric tone-${tone}`}>
      <div className="live-metric-label">
        <Icon size={15} strokeWidth={1.8} />
        <span>{label}</span>
      </div>
      <strong className="numeric">{value}</strong>
      <span className="live-metric-detail">{detail}</span>
      {spark}
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
      return status.dependencies.postgres.ok && status.dependencies.redis.ok ? 'ready' : 'degraded'
  }
}

function latencyTone(ok: boolean, ms: number): Tone {
  if (!ok) return 'bad'
  return ms > 400 ? 'warn' : 'good'
}

function LiveDashboard({ status, history }: { status: SystemStatus; history: Sample[] }) {
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
        value={postgres.ok ? formatMs(postgres.latency_ms) : 'Down'}
        detail={postgres.ok ? 'SELECT 1 round trip' : (postgres.error ?? 'unreachable')}
        tone={latencyTone(postgres.ok, postgres.latency_ms)}
        spark={<Sparkline values={history.map((s) => s.postgres)} label="Postgres latency history" />}
      />
      <Metric
        icon={Zap}
        label="Redis"
        value={redis.ok ? formatMs(redis.latency_ms) : redis.error === 'circuit_open' ? 'Skipped' : 'Down'}
        detail={redis.ok ? 'PING over REST' : redis.error === 'circuit_open' ? 'circuit is open' : 'unreachable'}
        tone={latencyTone(redis.ok, redis.latency_ms)}
        spark={<Sparkline values={history.map((s) => s.redis)} label="Redis latency history" />}
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
        tone={stream.stream_depth === null ? 'bad' : (stream.dead_letter_depth ?? 0) > 0 ? 'warn' : 'good'}
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

function Waterfall({ trace }: { trace: RedirectTrace }) {
  const rows = waterfall(trace)
  return (
    <ol className="waterfall" key={trace.traced_at}>
      {rows.map((row, index) => (
        <li key={`${row.step}-${index}`} style={{ animationDelay: `${index * 70}ms` }}>
          <div className="wf-label">
            <strong>{row.label}</strong>
            <span className={`wf-outcome tone-${outcomeTone(row.outcome)}`}>{outcomeLabel(row.outcome)}</span>
          </div>
          <div className="wf-track" aria-hidden="true">
            <span
              className={`wf-bar tone-${outcomeTone(row.outcome)}`}
              style={{ left: `${row.offset * 100}%`, width: `max(3px, ${row.width * 100}%)` }}
            />
          </div>
          <span className="wf-ms numeric">{formatMs(row.ms)}</span>
          <p className="wf-detail">{row.detail}</p>
        </li>
      ))}
    </ol>
  )
}

function Tracer({
  links,
  loading,
  workspaceId,
  onTrace,
}: {
  links: LinkRecord[]
  loading: boolean
  workspaceId: string
  onTrace: (trace: RedirectTrace) => void
}) {
  const traceable = links.filter((link) => link.code && !link.loading)
  const [code, setCode] = useState('')
  const [cold, setCold] = useState(true)
  const [running, setRunning] = useState<'single' | 'compare' | null>(null)
  const [error, setError] = useState('')
  const [trace, setTrace] = useState<RedirectTrace | null>(null)
  const [runs, setRuns] = useState<RedirectTrace[]>([])
  const [comparison, setComparison] = useState<{ cold: RedirectTrace; warm: RedirectTrace } | null>(null)
  const controller = useRef<AbortController | null>(null)
  const selected = traceable.find((link) => link.code === code) ?? traceable[0]

  useEffect(() => () => controller.current?.abort(), [])

  async function run(mode: 'single' | 'compare') {
    if (!selected) return
    controller.current?.abort()
    const current = new AbortController()
    controller.current = current
    setRunning(mode)
    setError('')
    try {
      const record = (next: RedirectTrace) => {
        setTrace(next)
        setRuns((previous) => [next, ...previous].slice(0, MAX_RUNS))
        onTrace(next)
      }
      if (mode === 'single') {
        record(await traceRedirect(selected.code, cold, workspaceId, current.signal))
        setComparison(null)
      } else {
        const first = await traceRedirect(selected.code, true, workspaceId, current.signal)
        record(first)
        const second = await traceRedirect(selected.code, false, workspaceId, current.signal)
        record(second)
        setComparison({ cold: first, warm: second })
      }
    } catch (failure) {
      if (isProblem(failure) && failure.problem.kind === 'cancelled') return
      setError(isProblem(failure) ? failure.problem.detail : 'The trace failed.')
    } finally {
      if (controller.current === current) setRunning(null)
    }
  }

  if (traceable.length === 0 && loading) {
    return (
      <section className="panel tracer-panel" aria-labelledby="tracer-heading" aria-busy="true">
        <h2 id="tracer-heading">
          <FlaskConical size={17} /> Trace a real redirect
        </h2>
        <p className="meta">Loading your links…</p>
      </section>
    )
  }

  if (traceable.length === 0) {
    return (
      <section className="panel tracer-panel" aria-labelledby="tracer-heading">
        <h2 id="tracer-heading">
          <FlaskConical size={17} /> Trace a real redirect
        </h2>
        <p className="meta">Create a link first. The tracer runs one of your links through the live pipeline.</p>
        <Link className="primary-button tracer-empty-cta" to="/">
          Create a link
        </Link>
      </section>
    )
  }

  const ratio = comparison ? speedup(comparison.cold, comparison.warm) : null

  return (
    <section className="panel tracer-panel" aria-labelledby="tracer-heading">
      <div className="section-heading">
        <div>
          <h2 id="tracer-heading">
            <FlaskConical size={17} /> Trace a real redirect
          </h2>
          <p className="meta">
            The API runs your link through the same rate limiter, cache, single-flight, Postgres
            and guard code a visitor hits, and times every step. No click is recorded.
          </p>
        </div>
      </div>
      <div className="tracer-controls">
        <label className="tracer-select">
          <span className="sr-only">Link to trace</span>
          <select value={selected?.code ?? ''} onChange={(event) => setCode(event.target.value)}>
            {traceable.map((link) => (
              <option key={link.code} value={link.code}>
                {displayShortUrl(link.shortUrl) || link.code} → {titleFor(link.destination)}
              </option>
            ))}
          </select>
        </label>
        <label className="check-row tracer-cold">
          <input type="checkbox" checked={cold} onChange={(event) => setCold(event.target.checked)} />
          <span>
            <Snowflake size={13} aria-hidden="true" /> Start cold (evict the cache first)
          </span>
        </label>
        <div className="tracer-buttons">
          <button type="button" className="primary-button" disabled={running !== null} onClick={() => void run('single')}>
            {running === 'single' ? <LoaderCircle size={15} className="spin" /> : <Play size={15} />}
            Trace
          </button>
          <button type="button" className="secondary-button" disabled={running !== null} onClick={() => void run('compare')}>
            {running === 'compare' ? <LoaderCircle size={15} className="spin" /> : <Gauge size={15} />}
            Cold vs warm
          </button>
        </div>
      </div>
      {error && (
        <p className="inline-note" role="alert">
          {error}
        </p>
      )}
      {trace ? (
        <div className="tracer-result" aria-live="polite">
          <div className="tracer-summary">
            <span className={`trace-response status-${trace.response.status === 302 ? 'ok' : 'bad'}`}>
              {responseLabel(trace)}
            </span>
            <strong className="numeric">{formatMs(trace.total_ms)}</strong>
            <span className="meta">
              total · cache {cacheOutcome(trace)} · breaker {trace.breaker_state.replace('_', '-')}
              {trace.response.location && (
                <>
                  {' '}
                  · to <code>{titleFor(trace.response.location)}</code>
                </>
              )}
            </span>
          </div>
          {comparison && (
            <p className="tracer-compare">
              Cold path {formatMs(comparison.cold.total_ms)}, warm path {formatMs(comparison.warm.total_ms)}
              {ratio !== null ? (
                <>
                  : the cache made this redirect <strong>{ratio}× faster</strong>.
                </>
              ) : (
                '. The warm run did not hit the cache, so there is no speedup to report.'
              )}
            </p>
          )}
          <Waterfall trace={trace} />
        </div>
      ) : (
        <div className="tracer-placeholder">
          <p>Pick a link and press Trace to see every step with its real timing.</p>
        </div>
      )}
      {runs.length > 1 && (
        <div className="trace-runs">
          <h3 className="dash-subhead">Recent runs</h3>
          <ul>
            {runs.map((item) => (
              <li key={item.traced_at}>
                <span className={`wf-outcome tone-${outcomeTone(cacheOutcome(item))}`}>{cacheOutcome(item)}</span>
                <code>{item.code}</code>
                <span className="numeric">{formatMs(item.total_ms)}</span>
                <span className="meta">{new Date(item.traced_at).toLocaleTimeString()}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}

type PipelineStep = {
  title: string
  detail: string
  concept: string
  step?: TraceStep['step']
}

function pipelineSteps(config: SystemConfig): PipelineStep[] {
  const redirect = config.rate_limits.find((limit) => limit.name === 'Redirects')
  return [
    {
      title: 'Rate limit',
      detail: redirect
        ? `${number.format(redirect.limit)} per ${formatWindow(redirect.window_seconds)} ${redirect.scope}, ${redirect.fail_open ? 'fail-open' : 'fail-closed'}`
        : 'per IP',
      concept: 'rate-limits',
      step: 'rate_limit',
    },
    { title: 'Redis cache', detail: `cache-aside, ${config.redirect_cache_seconds}s TTL`, concept: 'cache-aside', step: 'cache' },
    { title: 'Single-flight', detail: 'one load per hot miss', concept: 'single-flight', step: 'single_flight' },
    { title: 'Postgres', detail: 'source of truth', concept: 'soft-delete', step: 'postgres' },
    { title: 'Visit guard', detail: 'atomic, never over the limit', concept: 'guarded-counters', step: 'visit_guard' },
    { title: '302 + XADD', detail: 'click queued, not awaited', concept: 'async-analytics', step: 'enqueue' },
    {
      title: 'Consumer group',
      detail: `batches of ${number.format(config.analytics.drain_batch)}, ACK after commit`,
      concept: 'consumer-group',
    },
    {
      title: 'Daily rollups',
      detail: `kept ${number.format(config.retention.daily_rollup_days)} days`,
      concept: 'rollups',
    },
  ]
}

function ConfigPanel({ config }: { config: SystemConfig }) {
  const days = (seconds: number) => `${Math.round(seconds / 86_400)} days`
  const groups: { title: string; rows: [string, string][] }[] = [
    {
      title: 'Caching',
      rows: [
        ['Redirect cache TTL', `${config.redirect_cache_seconds}s`],
        ['Leaderboard cache TTL', `${config.leaderboard_cache_seconds}s`],
      ],
    },
    {
      title: 'Circuit breaker',
      rows: [
        ['Opens after', `${config.breaker.failure_threshold} failures in a row`],
        ['Retries after', `${config.breaker.reset_after_seconds}s`],
      ],
    },
    {
      title: 'Analytics pipeline',
      rows: [
        ['Drain batch', number.format(config.analytics.drain_batch)],
        ['Max events per drain', number.format(config.analytics.max_events_per_drain)],
        ['Drain on read', config.analytics.drain_on_read ? `on, up to ${number.format(config.analytics.read_drain_limit)}` : 'off'],
        ['Reclaim idle after', `${config.analytics.claim_min_idle_seconds}s`],
        ['Dead-letter after', `${config.analytics.max_attempts} attempts`],
      ],
    },
    {
      title: 'Retention',
      rows: [
        ['Raw clicks', `${config.retention.raw_click_days} days`],
        ['Daily rollups', `${number.format(config.retention.daily_rollup_days)} days`],
        ['Cleanup batch', number.format(config.retention.cleanup_batch)],
      ],
    },
    {
      title: 'Short codes',
      rows: [
        ['Length', `${config.short_codes.length} characters`],
        ['Alphabet', `base${config.short_codes.alphabet}`],
        ['Code space', humanCount(config.short_codes.space)],
        ['Collision retries', String(config.short_codes.retry_limit)],
      ],
    },
    {
      title: 'Sessions and retries',
      rows: [
        ['Session lifetime', days(config.session_ttl_seconds)],
        ['Idempotent replay', `${Math.round(config.replay_ttl_seconds / 3600)} hours`],
      ],
    },
  ]
  return (
    <section className="panel config-panel" aria-labelledby="config-heading">
      <div className="section-heading">
        <div>
          <h2 id="config-heading">Running configuration</h2>
          <p className="meta">Read from the API that answered this page, not from the docs.</p>
        </div>
      </div>
      <div className="config-limits">
        <h3 className="dash-subhead">Rate limits</h3>
        <table>
          <thead>
            <tr>
              <th scope="col">Endpoint</th>
              <th scope="col">Budget</th>
              <th scope="col">Scope</th>
              <th scope="col">If Redis is down</th>
            </tr>
          </thead>
          <tbody>
            {config.rate_limits.map((limit) => (
              <tr key={limit.name}>
                <th scope="row">{limit.name}</th>
                <td className="numeric">
                  {number.format(limit.limit)} / {formatWindow(limit.window_seconds)}
                </td>
                <td>{limit.scope}</td>
                <td>
                  <span className={`fail-mode ${limit.fail_open ? 'open' : 'closed'}`}>
                    {limit.fail_open ? 'Let through' : 'Reject'}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="config-grid">
        {groups.map((group) => (
          <div key={group.title} className="config-card">
            <h3 className="dash-subhead">{group.title}</h3>
            <dl>
              {group.rows.map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd className="numeric">{value}</dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>
    </section>
  )
}

export default function SystemDesign({
  workspaceId,
  links,
  loading,
}: {
  workspaceId: string
  links: LinkRecord[]
  loading: boolean
}) {
  const [paused, setPaused] = useState(false)
  const [category, setCategory] = useState<ConceptCategory | 'All'>('All')
  const [query, setQuery] = useState('')
  const [lastTrace, setLastTrace] = useState<RedirectTrace | null>(null)
  const { status, history, error, updatedAt } = useSystemStatus(paused)
  const values = useMemo(() => (status ? conceptValues(status.config) : {}), [status])
  const concepts = useMemo(() => filterConcepts(CONCEPTS, category, query, values), [category, query, values])
  const pipeline = status ? pipelineSteps(status.config) : []

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
    <div className="explore-page system-page">
      <div className="page-heading system-hero">
        <span className="eyebrow">Under the hood</span>
        <h1 tabIndex={-1}>More than a short link.</h1>
        <p>
          Every number on this page comes from the API instance serving you right now: its live
          counters, its configuration, and real traces of your own links.
        </p>
        {status && (
          <ul className="instance-strip" aria-label="Instance">
            <li>
              <span className={`live-dot ${paused ? 'idle' : error ? 'bad' : ''}`} aria-hidden="true" />
              {status.instance.environment}
            </li>
            <li>up {formatUptime(status.instance.uptime_seconds)}</li>
            <li>
              consumer <code>{status.instance.consumer}</code>
            </li>
          </ul>
        )}
      </div>

      <Tracer links={links} loading={loading} workspaceId={workspaceId} onTrace={setLastTrace} />

      <section className="panel live-panel" aria-labelledby="live-heading">
        <div className="section-heading">
          <div>
            <h2 id="live-heading">
              <span className={`live-dot ${paused || !status ? 'idle' : error ? 'bad' : ''}`} aria-hidden="true" />
              Live system signals
            </h2>
            <p className="meta">
              {status ? `Polling every ${POLL_MS / 1000}s` : 'Connecting to the API…'}
              {updatedAt && ` · updated ${updatedAt.toLocaleTimeString()}`}
            </p>
          </div>
          <button type="button" className="secondary-button" onClick={() => setPaused((value) => !value)} aria-pressed={paused}>
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
          <LiveDashboard status={status} history={history} />
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
          Counters belong to this one instance and reset on a cold start. Open a few short links in
          another tab and watch them move.
        </p>
      </section>

      {status && (
        <section className="pipeline-section" aria-labelledby="pipeline-heading">
          <h2 id="pipeline-heading">The life of one click</h2>
          <p className="meta pipeline-note">
            {lastTrace
              ? `Timings from your last trace of ${lastTrace.code}. Steps it skipped are dimmed.`
              : 'Run a trace above to fill these steps with measured timings.'}
          </p>
          <ol className="pipeline">
            {pipeline.map((item, index) => {
              const measured = item.step ? lastTrace?.steps.find((step) => step.step === item.step) : undefined
              const dim = Boolean(lastTrace && item.step && !measured)
              return (
                <li key={item.title} className={dim ? 'dim' : undefined}>
                  <button type="button" onClick={() => focusConcept(item.concept)}>
                    <span className="pipeline-index numeric">{index + 1}</span>
                    <strong>{item.title}</strong>
                    <span>{item.detail}</span>
                    {measured && (
                      <span className={`pipeline-measure tone-${outcomeTone(measured.outcome)}`}>
                        {formatMs(measured.ms)} · {outcomeLabel(measured.outcome)}
                      </span>
                    )}
                  </button>
                  {index < pipeline.length - 1 && <ArrowRight className="pipeline-arrow" size={14} aria-hidden="true" />}
                </li>
              )
            })}
          </ol>
        </section>
      )}

      {status && <ConfigPanel config={status.config} />}

      <section aria-labelledby="catalog-heading">
        <div className="catalog-toolbar">
          <div>
            <h2 id="catalog-heading">Concept catalog</h2>
            <p className="meta">
              {concepts.length} of {CONCEPTS.length} patterns, each linked to the code that
              implements it. Numbers in the text come from the running configuration.
            </p>
          </div>
          <label className="search-field catalog-search">
            <Search size={15} aria-hidden="true" />
            <span className="sr-only">Search concepts</span>
            <input type="search" placeholder="Search concepts…" value={query} onChange={(event) => setQuery(event.target.value)} />
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
                <article key={concept.id} id={`concept-${concept.id}`} className="concept-card" tabIndex={-1}>
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
                      <a key={path} href={`${REPO}${path}`} target="_blank" rel="noreferrer">
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
