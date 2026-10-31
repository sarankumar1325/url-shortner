import type { RateLimitConfig, SystemConfig } from './api'

export type ConceptCategory =
  | 'Performance'
  | 'Reliability'
  | 'Data'
  | 'Security'
  | 'Product safety'

export type LiveSignal =
  | 'redirect-cache'
  | 'single-flight'
  | 'breaker'
  | 'rate-limits'
  | 'stream'
  | 'leaderboard'
  | 'readiness'

export type Concept = {
  id: string
  title: string
  category: ConceptCategory
  summary: string
  how: string
  tradeoff: string
  code: string[]
  live?: LiveSignal
}

export const CATEGORIES: ConceptCategory[] = [
  'Performance',
  'Reliability',
  'Data',
  'Security',
  'Product safety',
]

export const CONCEPTS: Concept[] = [
  {
    id: 'cache-aside',
    title: 'Cache-aside redirect cache',
    category: 'Performance',
    summary: 'Hot redirects are answered from Redis without touching Postgres.',
    how: 'On a miss the API loads the link from Postgres and writes a small JSON entry with a {cache_ttl} second TTL. Only live links are cached, and edits or deletes invalidate the key.',
    tradeoff: 'A change made from another instance can take up to one TTL to land everywhere.',
    code: ['backend/src/backend/api/routes/redirect.py'],
    live: 'redirect-cache',
  },
  {
    id: 'single-flight',
    title: 'Single-flight cache fills',
    category: 'Performance',
    summary: 'A burst of misses for one link triggers one database query, not hundreds, which prevents a cache stampede.',
    how: 'The first request for a missing key becomes the leader and runs the load. Concurrent requests for the same key await the leader’s result instead of querying Postgres themselves.',
    tradeoff: 'Coalescing is per process. Across many serverless instances each one still loads once.',
    code: ['backend/src/backend/core/singleflight.py'],
    live: 'single-flight',
  },
  {
    id: 'async-analytics',
    title: 'Analytics off the hot path',
    category: 'Performance',
    summary: 'The 302 goes out before the click is written to Postgres.',
    how: 'Each redirect appends one event to a Redis Stream with XADD. A consumer drains the stream in batches and upserts Postgres later.',
    tradeoff: 'Charts are eventually consistent; the page shows how fresh the data is.',
    code: ['backend/src/backend/services/analytics.py'],
    live: 'stream',
  },
  {
    id: 'rollups',
    title: 'Pre-aggregated daily rollups',
    category: 'Performance',
    summary: 'Analytics read one row per link per day instead of scanning every click.',
    how: 'Ingestion upserts click_daily counters keyed by (url_id, day) in a consistent order, so concurrent drains never deadlock.',
    tradeoff: 'Breakdowns finer than a day need the raw clicks table, which is kept for {raw_days} days.',
    code: ['backend/src/backend/services/analytics.py', 'backend/src/backend/models.py'],
  },
  {
    id: 'leaderboard',
    title: 'Cached top-links leaderboard',
    category: 'Performance',
    summary: 'The “top links” ranking is computed at most once every {leaderboard_ttl} seconds per workspace.',
    how: 'The aggregate over daily rollups is cached in Redis under a workspace-scoped key with a {leaderboard_ttl} second TTL, behind single-flight so a cold cache costs one query.',
    tradeoff: 'Rankings can lag by up to {leaderboard_ttl} seconds plus whatever is still queued in the stream.',
    code: ['backend/src/backend/services/leaderboard.py'],
    live: 'leaderboard',
  },
  {
    id: 'short-codes',
    title: 'Random base62 codes with collision retry',
    category: 'Performance',
    summary: '{code_length} random base{code_alphabet} characters give about {code_space} codes with no coordination.',
    how: 'Codes come from a CSPRNG. A unique index catches the rare collision and creation retries with a fresh code, up to {code_retries} times.',
    tradeoff: 'Random codes are not sequential, so they cannot be guessed but also cannot be ordered.',
    code: ['backend/src/backend/core/security.py', 'docs/adr/0003-short-code-strategy.md'],
  },
  {
    id: 'circuit-breaker',
    title: 'Circuit breaker on Redis',
    category: 'Reliability',
    summary: 'When Redis is down, calls fail in microseconds instead of waiting out timeouts.',
    how: '{breaker_threshold} consecutive transport failures open the circuit for {breaker_reset} seconds. Then a single trial call is allowed: success closes it, failure reopens it. Command errors do not count, because Redis answered.',
    tradeoff: 'While open, caching and rate limiting are skipped or fail closed until the trial succeeds.',
    code: ['backend/src/backend/core/breaker.py', 'backend/src/backend/core/redis.py'],
    live: 'breaker',
  },
  {
    id: 'rate-limits',
    title: 'Fail-open and fail-closed rate limits',
    category: 'Reliability',
    summary: 'Redirects keep working when the limiter is down; sign-ins do not.',
    how: 'A fixed-window counter uses INCR and EXPIRE NX in one pipeline. Each call site chooses what happens when Redis is unreachable; redirects allow {redirect_limit} per IP.',
    tradeoff: 'Fixed windows allow short bursts at window edges in exchange for one round trip.',
    code: ['backend/src/backend/services/ratelimit.py'],
    live: 'rate-limits',
  },
  {
    id: 'consumer-group',
    title: 'Durable stream consumer group',
    category: 'Reliability',
    summary: 'A crash mid-batch never loses or double-counts clicks.',
    how: 'Events are read with XREADGROUP and acknowledged only after the Postgres transaction commits. Stale pending messages are reclaimed with XAUTOCLAIM, and events that fail {max_attempts} times go to a dead-letter stream.',
    tradeoff: 'At-least-once delivery means persistence must be idempotent, which the event-id dedupe provides.',
    code: ['backend/src/backend/services/analytics.py', 'docs/adr/0004-async-analytics.md'],
    live: 'stream',
  },
  {
    id: 'idempotency',
    title: 'Idempotency keys with encrypted replay',
    category: 'Reliability',
    summary: 'Retrying a create request returns the original link instead of making a second one.',
    how: 'Each create carries an Idempotency-Key. The first response is stored encrypted, and a retry with the same key and body replays it. A different body with the same key is rejected.',
    tradeoff: 'Replays are kept for {replay_hours} hours, so very late retries create new links.',
    code: ['backend/src/backend/services/links.py'],
  },
  {
    id: 'guarded-counters',
    title: 'Atomic guarded counters',
    category: 'Reliability',
    summary: 'A link limited to 100 visits never serves visit 101, even under concurrency.',
    how: 'One UPDATE increments clicks_used only WHERE clicks_used < max_clicks. Postgres row locking makes the check and the increment a single step.',
    tradeoff: 'Limited links always hit Postgres, so they skip the cache for that check.',
    code: ['backend/src/backend/services/links.py'],
  },
  {
    id: 'drain-on-read',
    title: 'Drain on read',
    category: 'Reliability',
    summary: 'Charts stay fresh even though the free hosting plan only allows a daily cron.',
    how: 'Opening analytics drains up to {read_drain_limit} queued events first, so the reader pays a small, capped cost for fresh data.',
    tradeoff: 'The first analytics view after a busy period is a little slower.',
    code: ['backend/src/backend/api/routes/links.py'],
  },
  {
    id: 'probes',
    title: 'Liveness and readiness probes',
    category: 'Reliability',
    summary: '/health says the process is up; /ready says it can serve traffic.',
    how: 'Readiness runs SELECT 1 against Postgres and PING against Redis. Liveness does no I/O, so a slow dependency never gets a healthy process restarted.',
    tradeoff: 'Readiness reflects one instance at one moment, not the whole fleet.',
    code: ['backend/src/backend/api/routes/health.py'],
    live: 'readiness',
  },
  {
    id: 'multi-tenancy',
    title: 'Workspaces with role-based access',
    category: 'Data',
    summary: 'Every query is scoped to a workspace, and roles decide who may change what.',
    how: 'The X-Workspace-Id header is resolved against the caller’s membership on every request. Owners, admins, members, and viewers form a strict hierarchy.',
    tradeoff: 'Every request performs a membership lookup.',
    code: ['backend/src/backend/api/deps.py', 'backend/src/backend/services/workspaces.py'],
  },
  {
    id: 'soft-delete',
    title: 'Soft deletes; codes are never reissued',
    category: 'Data',
    summary: 'A deleted code can never start pointing somewhere new.',
    how: 'Deleting sets deleted_at and evicts the cache. The unique short_code index still holds the old row, and alias checks treat it as taken.',
    tradeoff: 'The code space shrinks a little with every deleted link.',
    code: ['backend/src/backend/services/links.py'],
  },
  {
    id: 'retention',
    title: 'Tiered retention',
    category: 'Data',
    summary: 'Raw clicks are kept for {raw_days} days; daily rollups for {rollup_days} days.',
    how: 'A scheduled cleanup deletes expired rows in batches of {cleanup_batch} so it never holds long locks.',
    tradeoff: 'Per-click detail older than {raw_days} days is gone for good.',
    code: ['backend/src/backend/services/analytics.py'],
  },
  {
    id: 'passwords',
    title: 'Argon2id and hashed tokens',
    category: 'Security',
    summary: 'A database leak exposes no usable passwords, sessions, or management tokens.',
    how: 'Passwords use Argon2id, and unknown emails burn the same hashing work so sign-in timing reveals nothing. Session tokens are stored as SHA-256 hashes, management tokens as HMACs with a derived pepper.',
    tradeoff: 'A lost management token cannot be recovered; the link must then be managed from a workspace.',
    code: ['backend/src/backend/core/security.py'],
  },
  {
    id: 'aead',
    title: 'HKDF-derived keys and AES-GCM',
    category: 'Security',
    summary: 'One secret is expanded into separate keys for separate jobs.',
    how: 'HKDF derives the management-token pepper and the replay-encryption key from SECRET_KEY. Stored replays are sealed with AES-GCM so tampering is detected.',
    tradeoff: 'Rotating the base secret invalidates stored replays and management tokens together.',
    code: ['backend/src/backend/core/security.py'],
  },
  {
    id: 'csrf',
    title: 'Origin checks for cookie writes',
    category: 'Security',
    summary: 'Another site cannot make your browser create or delete links.',
    how: 'State-changing requests compare Origin (or Referer) with the allowed web origins, on top of SameSite=Lax http-only cookies.',
    tradeoff: 'Clients without an Origin header are trusted, because they cannot carry a victim’s cookie.',
    code: ['backend/src/backend/api/deps.py'],
  },
  {
    id: 'url-validation',
    title: 'Destination validation',
    category: 'Security',
    summary: 'Links cannot target private networks, local hosts, or Shortly itself.',
    how: 'Destinations must be absolute http(s) URLs. Private and reserved IPs, .local and .internal names, blocked hosts, and the short domain (redirect loops) are rejected.',
    tradeoff: 'This is syntactic. A public hostname that later resolves privately is not caught here.',
    code: ['backend/src/backend/services/validation.py'],
  },
  {
    id: 'problems',
    title: 'Problem details, request IDs, and structured logs',
    category: 'Security',
    summary: 'Every error is machine-readable and traceable to one log line.',
    how: 'Errors follow RFC 9457 with stable codes. Each request carries an X-Request-ID that appears in the response and in JSON access logs.',
    tradeoff: 'Error bodies never include internals, so debugging relies on the request ID.',
    code: ['backend/src/backend/core/problems.py', 'backend/src/backend/core/access_log.py'],
  },
  {
    id: 'peek',
    title: 'Peek before you click',
    category: 'Product safety',
    summary: 'Adding + to any short link shows the destination without visiting it.',
    how: 'The preview page flags unencrypted, raw-IP, look-alike, and re-shortened destinations using offline checks only, and never counts as a click.',
    tradeoff: 'Offline checks catch common tricks, not every malicious site.',
    code: ['backend/src/backend/services/visitor_pages.py'],
  },
  {
    id: 'bots',
    title: 'Link-previewer classification',
    category: 'Product safety',
    summary: 'Chat apps unfurling a link do not burn its visit limit.',
    how: 'Known previewer user agents resolve the link without consuming a visit, and bots are tagged in analytics.',
    tradeoff: 'User agents can be spoofed; this is a courtesy, not a security boundary.',
    code: ['backend/src/backend/services/links.py', 'backend/src/backend/services/analytics.py'],
  },
  {
    id: 'alias-check',
    title: 'Live alias availability',
    category: 'Product safety',
    summary: 'You learn an alias is taken while typing, not after submitting.',
    how: 'The server checks syntax and reserved words first, then probes the redirect cache, and only then does one indexed Postgres lookup. Checks are limited to {alias_limit} per IP.',
    tradeoff: 'The answer can change between the check and the create, so creation still enforces uniqueness.',
    code: ['backend/src/backend/services/links.py'],
  },
  {
    id: 'privacy',
    title: 'Privacy-first analytics',
    category: 'Product safety',
    summary: 'Clicks record origin, country, and device class, never IP addresses.',
    how: 'Referrers are reduced to their origin, country comes from the edge header, and the user agent is reduced to a device category before storage.',
    tradeoff: 'There are no unique-visitor counts.',
    code: ['backend/src/backend/services/analytics.py'],
  },
]

export type ConceptValues = Record<string, string>

const NUMBER = new Intl.NumberFormat('en-US')

export function humanCount(value: number): string {
  if (value >= 1e9) return `${Number((value / 1e9).toFixed(1))} billion`
  if (value >= 1e6) return `${Math.round(value / 1e6)} million`
  return NUMBER.format(value)
}

export function formatWindow(seconds: number): string {
  if (seconds % 3600 === 0) return seconds === 3600 ? 'hour' : `${seconds / 3600} hours`
  if (seconds % 60 === 0) return seconds === 60 ? 'minute' : `${seconds / 60} minutes`
  return `${seconds} seconds`
}

/** Placeholder values for the catalog, all read from the running API. */
export function conceptValues(config: SystemConfig): ConceptValues {
  const redirect = config.rate_limits.find((limit) => limit.name === 'Redirects')
  const alias = config.rate_limits.find((limit) => limit.name === 'Alias checks')
  const per = (limit?: RateLimitConfig) =>
    limit ? `${NUMBER.format(limit.limit)} per ${formatWindow(limit.window_seconds)}` : ''
  return {
    cache_ttl: String(config.redirect_cache_seconds),
    leaderboard_ttl: String(config.leaderboard_cache_seconds),
    code_length: String(config.short_codes.length),
    code_alphabet: String(config.short_codes.alphabet),
    code_space: humanCount(config.short_codes.space),
    code_retries: String(config.short_codes.retry_limit),
    breaker_threshold: String(config.breaker.failure_threshold),
    breaker_reset: String(config.breaker.reset_after_seconds),
    redirect_limit: per(redirect),
    alias_limit: per(alias),
    max_attempts: String(config.analytics.max_attempts),
    replay_hours: String(Math.round(config.replay_ttl_seconds / 3600)),
    read_drain_limit: NUMBER.format(config.analytics.read_drain_limit),
    raw_days: String(config.retention.raw_click_days),
    rollup_days: NUMBER.format(config.retention.daily_rollup_days),
    cleanup_batch: NUMBER.format(config.retention.cleanup_batch),
  }
}

/** Replaces {token} placeholders; unknown tokens show an ellipsis until config loads. */
export function fillTemplate(text: string, values: ConceptValues): string {
  return text.replace(/\{([a-z_]+)\}/g, (_, key: string) => values[key] || '…')
}

export function renderConcept(concept: Concept, values: ConceptValues): Concept {
  return {
    ...concept,
    summary: fillTemplate(concept.summary, values),
    how: fillTemplate(concept.how, values),
    tradeoff: fillTemplate(concept.tradeoff, values),
  }
}

export function filterConcepts(
  concepts: Concept[],
  category: ConceptCategory | 'All',
  query: string,
  values: ConceptValues = {},
): Concept[] {
  const needle = query.trim().toLowerCase()
  return concepts
    .map((concept) => renderConcept(concept, values))
    .filter(
      (concept) =>
        (category === 'All' || concept.category === category) &&
        (!needle ||
          [concept.title, concept.summary, concept.how, concept.tradeoff]
            .join(' ')
            .toLowerCase()
            .includes(needle)),
    )
}

export function formatRatio(ratio: number | null): string {
  return ratio === null ? '—' : `${Math.round(ratio * 100)}%`
}

export function formatUptime(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  return minutes ? `${hours}h ${minutes}m` : `${hours}h`
}
