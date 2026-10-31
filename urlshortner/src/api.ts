const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '')

export type ValidationIssue = {
  field: string
  code: string
  message: string
}

export type ApiProblem = {
  kind: 'http' | 'network' | 'timeout' | 'cancelled' | 'protocol'
  status?: number
  code: string
  title?: string
  detail: string
  requestId?: string
  retryAfterSeconds?: number
  errors: readonly ValidationIssue[]
}

export class ApiError extends Error {
  readonly problem: ApiProblem

  constructor(problem: ApiProblem) {
    super(problem.detail)
    this.name = 'ApiError'
    this.problem = problem
  }
}

export type WorkspaceRole = 'owner' | 'admin' | 'member' | 'viewer'

export type AuthUser = {
  id: string
  email: string
  display_name: string
  created_at: string
}

export type WorkspaceSummary = {
  id: string
  name: string
  role: WorkspaceRole
  is_personal: boolean
}

export type Session = {
  user: AuthUser
  workspaces: WorkspaceSummary[]
}

export type ActiveSession = {
  id: string
  created_at: string
  expires_at: string
  current: boolean
}

export type Member = {
  user_id: string
  email: string
  display_name: string
  role: WorkspaceRole
  joined_at: string
}

export type Invitation = {
  id: string
  role: Exclude<WorkspaceRole, 'owner'>
  invited_email: string | null
  created_at: string
  expires_at: string
  token?: string
}

export type InvitationPreview = {
  workspace_id: string
  workspace_name: string
  role: Exclude<WorkspaceRole, 'owner'>
  invited_email: string | null
  invited_by: string | null
  expires_at: string
}

export type LinkMetadata = {
  short_code: string
  short_url: string
  long_url: string
  is_custom_alias: boolean
  is_active: boolean
  expires_at: string | null
  created_at: string
  updated_at: string
  tags: string[]
  clicks_30d?: number
  fallback_url?: string | null
  max_clicks?: number | null
  clicks_used?: number
}

export type CreatedLink = LinkMetadata & { management_token?: string }

export type ListLinks = {
  links: LinkMetadata[]
  total: number
  workspace_id: string
  role: WorkspaceRole
}

export type DailyPoint = {
  day: string
  clicks: number
  human_clicks: number
  bot_clicks: number
}

export type IngestionFreshness = {
  redis_ok: boolean
  pending_events: number | null
  lag_events: number | null
  oldest_pending_seconds: number | null
  dead_letter_events: number | null
  captured_at: string
}

export type Analytics = {
  short_code: string
  from: string
  to: string
  totals: { clicks: number; human_clicks: number; bot_clicks: number }
  series: DailyPoint[]
  breakdowns: {
    from: string | null
    to: string | null
    truncated: boolean
    top_referers: { value: string | null; clicks: number }[]
    top_countries: { value: string | null; clicks: number }[]
    devices: { value: string; clicks: number }[]
  }
  last_processed_at: string | null
  data_through: string | null
  freshness: IngestionFreshness
}

export type CreateBody = {
  long_url: string
  custom_alias?: string | null
  expires_at?: string | null
  tags?: string[] | null
  fallback_url?: string | null
  max_clicks?: number | null
}

export type AbuseReason =
  | 'spam'
  | 'phishing'
  | 'malware'
  | 'impersonation'
  | 'other'

export type AbuseReportBody = {
  short_code: string
  reason: AbuseReason
  details?: string | null
  reporter_email?: string | null
}

export type AbuseReportReceipt = {
  id: string
  short_code: string
  status: 'open'
  created_at: string | null
}

export type Access = {
  workspaceId?: string | null
  token?: string | null
}

function normalize(signal: AbortSignal): AbortSignal {
  if (typeof AbortSignal.any === 'function' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.any([signal, AbortSignal.timeout(10_000)])
  }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10_000)
  signal.addEventListener('abort', () => controller.abort(), { once: true })
  controller.signal.addEventListener('abort', () => clearTimeout(timeout), {
    once: true,
  })
  return controller.signal
}

function issues(value: unknown): ValidationIssue[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (
      item &&
      typeof item === 'object' &&
      typeof (item as ValidationIssue).field === 'string' &&
      typeof (item as ValidationIssue).code === 'string' &&
      typeof (item as ValidationIssue).message === 'string'
    ) {
      return [item as ValidationIssue]
    }
    return []
  })
}

async function failure(response: Response): Promise<ApiError> {
  let body: Record<string, unknown> = {}
  try {
    const parsed: unknown = await response.json()
    if (parsed && typeof parsed === 'object') {
      body = parsed as Record<string, unknown>
    }
  } catch {
    // Keep the HTTP status even when the body is unreadable.
  }
  const retryHeader = response.headers.get('retry-after')
  const parsedRetry = retryHeader ? Number(retryHeader) : Number.NaN
  return new ApiError({
    kind: 'http',
    status: response.status,
    code: typeof body.code === 'string' ? body.code : 'http_error',
    title: typeof body.title === 'string' ? body.title : undefined,
    detail:
      typeof body.detail === 'string'
        ? body.detail
        : `The request failed with status ${response.status}.`,
    requestId:
      typeof body.request_id === 'string'
        ? body.request_id
        : response.headers.get('x-request-id') ?? undefined,
    retryAfterSeconds: Number.isFinite(parsedRetry) ? parsedRetry : undefined,
    errors: issues(body.errors),
  })
}

async function request<T>(
  path: string,
  options: {
    method?: string
    body?: unknown
    access?: Access
    idempotencyKey?: string
    signal: AbortSignal
  },
): Promise<T> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'X-Request-ID': crypto.randomUUID(),
  }
  if (options.body !== undefined) headers['Content-Type'] = 'application/json'
  if (options.access?.token) {
    headers['X-Management-Token'] = options.access.token
  }
  if (options.access?.workspaceId) {
    headers['X-Workspace-Id'] = options.access.workspaceId
  }
  if (options.idempotencyKey) {
    headers['Idempotency-Key'] = options.idempotencyKey
  }

  let response: Response
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      cache: 'no-store',
      credentials: 'include',
      signal: normalize(options.signal),
    })
  } catch (error) {
    if (options.signal.aborted) {
      throw new ApiError({
        kind: 'cancelled',
        code: 'cancelled',
        detail: 'The request was cancelled.',
        errors: [],
      })
    }
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      throw new ApiError({
        kind: 'timeout',
        code: 'timeout',
        detail: 'The request timed out. Check your connection and try again.',
        errors: [],
      })
    }
    throw new ApiError({
      kind: 'network',
      code: 'network',
      detail: 'The server could not be reached. Check your connection.',
      errors: [],
    })
  }

  if (!response.ok) throw await failure(response)
  if (response.status === 204) return undefined as T
  try {
    return (await response.json()) as T
  } catch {
    throw new ApiError({
      kind: 'protocol',
      code: 'invalid_response',
      detail: 'The server returned an unreadable response.',
      errors: [],
    })
  }
}

export function signup(
  body: { email: string; password: string; display_name?: string },
  signal: AbortSignal,
): Promise<Session> {
  return request<Session>('/api/v1/auth/signup', {
    method: 'POST',
    body,
    signal,
  })
}

export function login(
  body: { email: string; password: string },
  signal: AbortSignal,
): Promise<Session> {
  return request<Session>('/api/v1/auth/login', {
    method: 'POST',
    body,
    signal,
  })
}

export function logout(signal: AbortSignal): Promise<void> {
  return request<void>('/api/v1/auth/logout', { method: 'POST', signal })
}

export function getSession(signal: AbortSignal): Promise<Session> {
  return request<Session>('/api/v1/auth/me', { signal })
}

export function changePassword(
  body: { current_password: string; new_password: string },
  signal: AbortSignal,
): Promise<void> {
  return request<void>('/api/v1/auth/password', {
    method: 'POST',
    body,
    signal,
  })
}

export function listSessions(signal: AbortSignal): Promise<ActiveSession[]> {
  return request<ActiveSession[]>('/api/v1/auth/sessions', { signal })
}

export function revokeSession(
  sessionId: string,
  signal: AbortSignal,
): Promise<void> {
  return request<void>(
    `/api/v1/auth/sessions/${encodeURIComponent(sessionId)}`,
    { method: 'DELETE', signal },
  )
}

export function revokeOtherSessions(
  signal: AbortSignal,
): Promise<{ revoked: number }> {
  return request<{ revoked: number }>('/api/v1/auth/sessions/revoke-others', {
    method: 'POST',
    signal,
  })
}

export function createWorkspace(
  name: string,
  signal: AbortSignal,
): Promise<WorkspaceSummary> {
  return request<WorkspaceSummary>('/api/v1/workspaces', {
    method: 'POST',
    body: { name },
    signal,
  })
}

export function renameWorkspace(
  workspaceId: string,
  name: string,
  signal: AbortSignal,
): Promise<WorkspaceSummary> {
  return request<WorkspaceSummary>(
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}`,
    { method: 'PATCH', body: { name }, signal },
  )
}

export function deleteWorkspace(
  workspaceId: string,
  confirmName: string,
  signal: AbortSignal,
): Promise<void> {
  return request<void>(
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}`,
    { method: 'DELETE', body: { confirm_name: confirmName }, signal },
  )
}

export function transferOwnership(
  workspaceId: string,
  userId: string,
  signal: AbortSignal,
): Promise<void> {
  return request<void>(
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/transfer-ownership`,
    { method: 'POST', body: { user_id: userId }, signal },
  )
}

export function listMembers(
  workspaceId: string,
  signal: AbortSignal,
): Promise<Member[]> {
  return request<Member[]>(
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/members`,
    { access: { workspaceId }, signal },
  )
}

export function updateMemberRole(
  workspaceId: string,
  memberId: string,
  role: Exclude<WorkspaceRole, 'owner'>,
  signal: AbortSignal,
): Promise<{ user_id: string; role: WorkspaceRole }> {
  return request(
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(memberId)}`,
    { method: 'PATCH', body: { role }, access: { workspaceId }, signal },
  )
}

export function removeMember(
  workspaceId: string,
  memberId: string,
  signal: AbortSignal,
): Promise<void> {
  return request<void>(
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(memberId)}`,
    { method: 'DELETE', access: { workspaceId }, signal },
  )
}

export function listInvitations(
  workspaceId: string,
  signal: AbortSignal,
): Promise<Invitation[]> {
  return request<Invitation[]>(
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/invitations`,
    { access: { workspaceId }, signal },
  )
}

export function createInvitation(
  workspaceId: string,
  body: { role: Exclude<WorkspaceRole, 'owner'>; email?: string | null },
  signal: AbortSignal,
): Promise<Invitation & { token: string }> {
  return request(
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/invitations`,
    { method: 'POST', body, access: { workspaceId }, signal },
  )
}

export function revokeInvitation(
  workspaceId: string,
  invitationId: string,
  signal: AbortSignal,
): Promise<void> {
  return request<void>(
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/invitations/${encodeURIComponent(invitationId)}`,
    { method: 'DELETE', access: { workspaceId }, signal },
  )
}

export function previewInvitation(
  token: string,
  signal: AbortSignal,
): Promise<InvitationPreview> {
  return request<InvitationPreview>(
    `/api/v1/invitations/${encodeURIComponent(token)}`,
    { signal },
  )
}

export function acceptInvitation(
  token: string,
  signal: AbortSignal,
): Promise<WorkspaceSummary> {
  return request<WorkspaceSummary>(
    `/api/v1/invitations/${encodeURIComponent(token)}/accept`,
    { method: 'POST', signal },
  )
}

export function listLinks(
  workspaceId: string,
  signal: AbortSignal,
  limit = 200,
): Promise<ListLinks> {
  return request<ListLinks>(`/api/v1/links?limit=${limit}`, {
    access: { workspaceId },
    signal,
  })
}

export function createLink(
  body: CreateBody,
  idempotencyKey: string,
  workspaceId: string,
  signal: AbortSignal,
): Promise<CreatedLink> {
  // Older API deployments reject unknown fields, even when they are empty.
  const { tags, fallback_url, max_clicks, ...otherFields } = body
  const payload: Record<string, unknown> = { ...otherFields }
  if (tags?.length) payload.tags = tags
  if (fallback_url) payload.fallback_url = fallback_url
  if (max_clicks != null) payload.max_clicks = max_clicks
  return request<CreatedLink>('/api/v1/links', {
    method: 'POST',
    body: payload,
    idempotencyKey,
    access: { workspaceId },
    signal,
  })
}

export function getLink(
  code: string,
  access: Access,
  signal: AbortSignal,
): Promise<LinkMetadata> {
  return request<LinkMetadata>(`/api/v1/links/${encodeURIComponent(code)}`, {
    access,
    signal,
  })
}

export function updateLink(
  code: string,
  patch: {
    long_url?: string
    expires_at?: string | null
    is_active?: boolean
    tags?: string[] | null
    fallback_url?: string | null
    max_clicks?: number | null
  },
  access: Access,
  signal: AbortSignal,
): Promise<LinkMetadata> {
  return request<LinkMetadata>(`/api/v1/links/${encodeURIComponent(code)}`, {
    method: 'PATCH',
    body: patch,
    access,
    signal,
  })
}

export function deleteLink(
  code: string,
  access: Access,
  signal: AbortSignal,
): Promise<void> {
  return request<void>(`/api/v1/links/${encodeURIComponent(code)}`, {
    method: 'DELETE',
    access,
    signal,
  })
}

function utcDay(offsetDays = 0): string {
  const day = new Date()
  day.setUTCHours(0, 0, 0, 0)
  day.setUTCDate(day.getUTCDate() + offsetDays)
  return day.toISOString().slice(0, 10)
}

export function analyticsRange(days: number): { from: string; to: string } {
  return { from: utcDay(-(days - 1)), to: utcDay(1) }
}

export function getAnalytics(
  code: string,
  days: number,
  access: Access,
  signal: AbortSignal,
): Promise<Analytics> {
  const { from, to } = analyticsRange(days)
  const query = new URLSearchParams({ from, to, interval: 'day' })
  return request<Analytics>(
    `/api/v1/links/${encodeURIComponent(code)}/analytics?${query}`,
    { access, signal },
  )
}

export function createAbuseReport(
  body: AbuseReportBody,
  signal: AbortSignal,
): Promise<AbuseReportReceipt> {
  return request<AbuseReportReceipt>('/api/v1/abuse-reports', {
    method: 'POST',
    body,
    signal,
  })
}

export function isProblem(error: unknown): error is ApiError {
  return error instanceof ApiError
}

export type AliasAvailability = {
  alias: string
  available: boolean
  reason: 'taken' | 'reserved' | 'invalid' | null
  message: string
  source?: 'cache' | 'database'
}

export function checkAlias(
  alias: string,
  signal: AbortSignal,
): Promise<AliasAvailability> {
  return request<AliasAvailability>(
    `/api/v1/links/availability?alias=${encodeURIComponent(alias)}`,
    { signal },
  )
}

export type TopLink = {
  short_code: string
  short_url: string
  long_url: string
  clicks: number
}

export type TopLinks = {
  days: number
  links: TopLink[]
  generated_at: string
  cached: boolean
  ttl_seconds: number
}

export function getTopLinks(
  workspaceId: string,
  days: 1 | 7 | 30,
  signal: AbortSignal,
): Promise<TopLinks> {
  return request<TopLinks>(`/api/v1/links/top?days=${days}&limit=5`, {
    access: { workspaceId },
    signal,
  })
}

type Probe = { ok: boolean; latency_ms: number; error: string | null }
type Flight = { leaders: number; shared: number; in_flight: number }

export type SystemStatus = {
  instance: {
    started_at: string
    uptime_seconds: number
    consumer: string
    environment: string
  }
  dependencies: { postgres: Probe; redis: Probe }
  circuit_breaker: {
    name: string
    state: 'closed' | 'open' | 'half_open'
    consecutive_failures: number
    failure_threshold: number
    reset_after_seconds: number
    retry_in_seconds: number | null
    calls: number
    failures: number
    rejected: number
    times_opened: number
    last_failure: string | null
  }
  redirect_cache: {
    ttl_seconds: number
    hits: number
    misses: number
    hit_ratio: number | null
    single_flight: Flight
  }
  leaderboard_cache: {
    ttl_seconds: number
    hits: number
    misses: number
    single_flight: Flight
  }
  rate_limits: {
    allowed: number
    blocked: number
    fail_open: number
    fail_closed: number
  }
  analytics_stream: {
    redis_ok: boolean
    stream_depth: number | null
    pending: number | null
    lag: number | null
    oldest_pending_age_seconds: number | null
    dead_letter_depth: number | null
    generated_at: string
  }
  config: SystemConfig
}

export function getSystemStatus(signal: AbortSignal): Promise<SystemStatus> {
  return request<SystemStatus>('/api/v1/system/status', { signal })
}

export type RateLimitConfig = {
  name: string
  limit: number
  window_seconds: number
  scope: string
  fail_open: boolean
}

export type SystemConfig = {
  short_codes: { length: number; alphabet: number; space: number; retry_limit: number }
  rate_limits: RateLimitConfig[]
  redirect_cache_seconds: number
  leaderboard_cache_seconds: number
  breaker: { failure_threshold: number; reset_after_seconds: number }
  analytics: {
    drain_batch: number
    max_events_per_drain: number
    read_drain_limit: number
    drain_on_read: boolean
    claim_min_idle_seconds: number
    max_attempts: number
  }
  retention: { raw_click_days: number; daily_rollup_days: number; cleanup_batch: number }
  replay_ttl_seconds: number
  session_ttl_seconds: number
}

export type TraceStep = {
  step:
    | 'rate_limit'
    | 'evict'
    | 'cache'
    | 'single_flight'
    | 'postgres'
    | 'cache_fill'
    | 'expiry'
    | 'visit_guard'
    | 'enqueue'
  label: string
  ms: number
  outcome: string
  detail: string
}

export type RedirectTrace = {
  code: string
  cold: boolean
  steps: TraceStep[]
  total_ms: number
  response: { status: number; location: string | null; reason: string | null }
  breaker_state: 'closed' | 'open' | 'half_open'
  traced_at: string
}

export function traceRedirect(
  code: string,
  cold: boolean,
  workspaceId: string,
  signal: AbortSignal,
): Promise<RedirectTrace> {
  return request<RedirectTrace>('/api/v1/system/trace', {
    method: 'POST',
    body: { code, cold },
    access: { workspaceId },
    signal,
  })
}

export type DashboardStatus = 'active' | 'paused' | 'expired' | 'used_up' | 'blocked'
export type DashboardIssue =
  | DashboardStatus
  | 'serving_fallback'
  | 'expiring_soon'
  | 'near_limit'
  | 'no_recent_clicks'

export type DashboardLink = {
  short_code: string
  short_url: string
  long_url: string
  status: DashboardStatus
  issues: DashboardIssue[]
  clicks: number
  previous_clicks: number
  change: number | null
  last_click_at: string | null
  created_at: string | null
  expires_at: string | null
  max_clicks: number | null
  clicks_used: number
  fallback_url: string | null
}

export type Dashboard = {
  days: number
  from: string
  to: string
  totals: {
    clicks: number
    human_clicks: number
    bot_clicks: number
    previous_clicks: number
    change: number | null
  }
  series: DailyPoint[]
  breakdowns: Analytics['breakdowns']
  status_counts: Record<DashboardStatus, number> & { total: number }
  issue_counts: Partial<Record<DashboardIssue, number>>
  links: DashboardLink[]
  links_truncated: boolean
  freshness: IngestionFreshness
  thresholds: { expiring_soon_days: number; near_limit_ratio: number; quiet_after_days: number }
  generated_at: string
}

export function getDashboard(
  workspaceId: string,
  days: 7 | 30 | 90,
  signal: AbortSignal,
): Promise<Dashboard> {
  return request<Dashboard>(`/api/v1/dashboard?days=${days}`, {
    access: { workspaceId },
    signal,
  })
}
