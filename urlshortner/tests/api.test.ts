import { describe, expect, spyOn, test } from 'bun:test'
import {
  ApiError,
  analyticsRange,
  changePassword,
  createLink,
  deleteLink,
  deleteWorkspace,
  getAnalytics,
  getLink,
  isProblem,
  listLinks,
  listSessions,
  login,
  renameWorkspace,
  revokeOtherSessions,
  revokeSession,
  signup,
  transferOwnership,
  updateLink,
  type ApiProblem,
} from '../src/api'

type Call = { url: string; init: RequestInit }

const workspaceId = '11111111-1111-4111-8111-111111111111'

function mockFetch(
  handler: (call: Call) => Response | Promise<Response>,
): { calls: Call[]; restore: () => void } {
  const calls: Call[] = []
  const spy = spyOn(globalThis, 'fetch').mockImplementation(((
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const call = { url: String(input), init: init ?? {} }
    calls.push(call)
    try {
      return Promise.resolve(handler(call))
    } catch (error) {
      return Promise.reject(error)
    }
  }) as unknown as typeof fetch)
  return { calls, restore: () => spy.mockRestore() }
}

function json(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

async function captured(
  promise: Promise<unknown>,
): Promise<ApiProblem> {
  try {
    await promise
  } catch (error) {
    expect(isProblem(error)).toBe(true)
    return (error as ApiError).problem
  }
  throw new Error('Expected the request to fail')
}

describe('create requests', () => {
  test('omits empty tags for compatibility with older API deployments', async () => {
    const { calls, restore } = mockFetch(() => json({ short_code: 'abc' }, 201))
    try {
      await createLink({ long_url: 'https://example.com/', tags: [] }, '00000000-0000-4000-8000-000000000000', workspaceId, new AbortController().signal)
      expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ long_url: 'https://example.com/' })
      await createLink({ long_url: 'https://example.com/', tags: ['launch'] }, '00000000-0000-4000-8000-000000000001', workspaceId, new AbortController().signal)
      expect(JSON.parse(String(calls[1]!.init.body)).tags).toEqual(['launch'])
    } finally { restore() }
  })
  test('sends the idempotency key, workspace, body and cookie credentials', async () => {
    const { calls, restore } = mockFetch(() =>
      json(
        {
          short_code: 'abc',
          short_url: 'https://short.test/abc',
          long_url: 'https://example.com/',
          is_custom_alias: true,
          is_active: true,
          expires_at: null,
          created_at: '2026-10-15T00:00:00Z',
          updated_at: '2026-10-15T00:00:00Z',
        },
        201,
      ),
    )
    try {
      const created = await createLink(
        {
          long_url: 'https://example.com/',
          custom_alias: 'abc',
          expires_at: null,
        },
        '00000000-0000-4000-8000-000000000000',
        workspaceId,
        new AbortController().signal,
      )
      expect(created.short_code).toBe('abc')
      expect(calls).toHaveLength(1)
      const { url, init } = calls[0]!
      expect(url).toBe('/api/v1/links')
      expect(init.method).toBe('POST')
      expect(init.cache).toBe('no-store')
      expect(init.credentials).toBe('include')
      const headers = new Headers(init.headers)
      expect(headers.get('Idempotency-Key')).toBe(
        '00000000-0000-4000-8000-000000000000',
      )
      expect(headers.get('X-Workspace-Id')).toBe(workspaceId)
      expect(headers.get('X-Management-Token')).toBeNull()
      expect(headers.get('X-Request-ID')).toMatch(/^[0-9a-f-]{36}$/)
      expect(headers.get('Content-Type')).toBe('application/json')
      expect(JSON.parse(String(init.body))).toEqual({
        long_url: 'https://example.com/',
        custom_alias: 'abc',
        expires_at: null,
      })
    } finally {
      restore()
    }
  })

  test('sends workspace or management-token access, never both', async () => {
    const { calls, restore } = mockFetch(() =>
      json({
        short_code: 'abc',
        short_url: 'https://short.test/abc',
        long_url: 'https://example.com/',
        is_custom_alias: false,
        is_active: true,
        expires_at: null,
        created_at: '2026-10-15T00:00:00Z',
        updated_at: '2026-10-15T00:00:00Z',
      }),
    )
    try {
      await getLink('abc', { workspaceId }, new AbortController().signal)
      await getLink('abc', { token: 'shrm_secret' }, new AbortController().signal)
      expect(new Headers(calls[0]!.init.headers).get('X-Workspace-Id')).toBe(
        workspaceId,
      )
      expect(
        new Headers(calls[0]!.init.headers).get('X-Management-Token'),
      ).toBeNull()
      expect(
        new Headers(calls[1]!.init.headers).get('X-Management-Token'),
      ).toBe('shrm_secret')
      expect(new Headers(calls[1]!.init.headers).get('X-Workspace-Id')).toBeNull()
      expect(calls[0]!.url).toBe('/api/v1/links/abc')
    } finally {
      restore()
    }
  })

  test('lists links for the active workspace', async () => {
    const { calls, restore } = mockFetch(() =>
      json({ links: [], total: 0, workspace_id: workspaceId, role: 'owner' }),
    )
    try {
      const result = await listLinks(workspaceId, new AbortController().signal)
      expect(result.role).toBe('owner')
      expect(calls[0]!.url).toBe('/api/v1/links?limit=200')
      expect(new Headers(calls[0]!.init.headers).get('X-Workspace-Id')).toBe(
        workspaceId,
      )
    } finally {
      restore()
    }
  })
})

describe('auth requests', () => {
  test('signup and login use same-origin cookie requests', async () => {
    const session = {
      user: {
        id: '22222222-2222-4222-8222-222222222222',
        email: 'owner@example.com',
        display_name: 'Owner',
        created_at: '2026-10-15T00:00:00Z',
      },
      workspaces: [
        {
          id: workspaceId,
          name: 'Owner workspace',
          role: 'owner',
          is_personal: true,
        },
      ],
    }
    const { calls, restore } = mockFetch(() => json(session, 201))
    try {
      await signup(
        { email: 'owner@example.com', password: 'a-long-password' },
        new AbortController().signal,
      )
      await login(
        { email: 'owner@example.com', password: 'a-long-password' },
        new AbortController().signal,
      )
      expect(calls.map((call) => call.url)).toEqual([
        '/api/v1/auth/signup',
        '/api/v1/auth/login',
      ])
      expect(calls.every((call) => call.init.credentials === 'include')).toBe(true)
      expect(calls.every((call) => call.init.method === 'POST')).toBe(true)
    } finally {
      restore()
    }
  })
})

describe('account and workspace lifecycle', () => {
  test('password and session requests target the account endpoints', async () => {
    const session = {
      id: '33333333-3333-4333-8333-333333333333',
      created_at: '2026-10-15T00:00:00Z',
      expires_at: '2026-11-14T00:00:00Z',
      current: true,
    }
    const { calls, restore } = mockFetch(({ url }) => {
      if (url === '/api/v1/auth/sessions') return json([session])
      if (url === '/api/v1/auth/sessions/revoke-others') {
        return json({ revoked: 2 })
      }
      return new Response(null, { status: 204 })
    })
    try {
      await changePassword(
        {
          current_password: 'current-password',
          new_password: 'another-password',
        },
        new AbortController().signal,
      )
      expect(
        await listSessions(new AbortController().signal),
      ).toEqual([session])
      await revokeSession(session.id, new AbortController().signal)
      expect(
        await revokeOtherSessions(new AbortController().signal),
      ).toEqual({ revoked: 2 })

      expect(calls.map((call) => [call.init.method, call.url])).toEqual([
        ['POST', '/api/v1/auth/password'],
        ['GET', '/api/v1/auth/sessions'],
        [
          'DELETE',
          `/api/v1/auth/sessions/${session.id}`,
        ],
        ['POST', '/api/v1/auth/sessions/revoke-others'],
      ])
      expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
        current_password: 'current-password',
        new_password: 'another-password',
      })
      expect(calls.every((call) => call.init.credentials === 'include')).toBe(
        true,
      )
    } finally {
      restore()
    }
  })

  test('workspace rename, delete and transfer use the workspace endpoints', async () => {
    const { calls, restore } = mockFetch(({ init }) => {
      if (init.method === 'PATCH') {
        return json({
          id: workspaceId,
          name: 'Renamed',
          role: 'owner',
          is_personal: false,
        })
      }
      return new Response(null, { status: 204 })
    })
    try {
      const updated = await renameWorkspace(
        workspaceId,
        'Renamed',
        new AbortController().signal,
      )
      await deleteWorkspace(
        workspaceId,
        'Renamed',
        new AbortController().signal,
      )
      await transferOwnership(
        workspaceId,
        '44444444-4444-4444-8444-444444444444',
        new AbortController().signal,
      )

      expect(updated.name).toBe('Renamed')
      expect(calls.map((call) => [call.init.method, call.url])).toEqual([
        ['PATCH', `/api/v1/workspaces/${workspaceId}`],
        ['DELETE', `/api/v1/workspaces/${workspaceId}`],
        [
          'POST',
          `/api/v1/workspaces/${workspaceId}/transfer-ownership`,
        ],
      ])
      expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
        name: 'Renamed',
      })
      expect(JSON.parse(String(calls[1]!.init.body))).toEqual({
        confirm_name: 'Renamed',
      })
      expect(JSON.parse(String(calls[2]!.init.body))).toEqual({
        user_id: '44444444-4444-4444-8444-444444444444',
      })
      expect(calls.every((call) => call.init.credentials === 'include')).toBe(
        true,
      )
    } finally {
      restore()
    }
  })
})

describe('error normalization', () => {
  test('keeps status, code, request id, retry-after and field issues', async () => {
    const { restore } = mockFetch(
      () =>
        new Response(
          JSON.stringify({
            code: 'alias_taken',
            title: 'Conflict',
            detail: 'That alias is already in use.',
            request_id: 'req-123',
            errors: [
              {
                field: 'custom_alias',
                code: 'taken',
                message: 'Choose another alias.',
              },
            ],
          }),
          {
            status: 409,
            headers: {
              'Content-Type': 'application/problem+json',
              'Retry-After': '7',
            },
          },
        ),
    )
    try {
      const problem = await captured(
        createLink(
          { long_url: 'https://example.com/' },
          '00000000-0000-4000-8000-000000000000',
          workspaceId,
          new AbortController().signal,
        ),
      )
      expect(problem).toMatchObject({
        kind: 'http',
        status: 409,
        code: 'alias_taken',
        detail: 'That alias is already in use.',
        requestId: 'req-123',
        retryAfterSeconds: 7,
      })
      expect(problem.errors).toHaveLength(1)
      expect(problem.errors[0]!.field).toBe('custom_alias')
    } finally {
      restore()
    }
  })

  test('uses the HTTP status even when the problem body is unreadable', async () => {
    const { restore } = mockFetch(
      () => new Response('<html>gateway</html>', { status: 502 }),
    )
    try {
      const problem = await captured(
        getLink('abc', { workspaceId }, new AbortController().signal),
      )
      expect(problem.kind).toBe('http')
      expect(problem.status).toBe(502)
      expect(problem.detail).toContain('502')
    } finally {
      restore()
    }
  })

  test('treats an unreadable success payload as a protocol failure', async () => {
    const { restore } = mockFetch(() => new Response('not json', { status: 200 }))
    try {
      const problem = await captured(
        getLink('abc', { workspaceId }, new AbortController().signal),
      )
      expect(problem.kind).toBe('protocol')
      expect(problem.code).toBe('invalid_response')
    } finally {
      restore()
    }
  })

  test('reports network failures and caller cancellation separately', async () => {
    const network = mockFetch(() => {
      throw new TypeError('Failed to fetch')
    })
    try {
      const problem = await captured(
        getLink('abc', { workspaceId }, new AbortController().signal),
      )
      expect(problem.kind).toBe('network')
    } finally {
      network.restore()
    }

    const aborted = mockFetch(({ init }) => {
      if (init.signal?.aborted) {
        throw new DOMException('Aborted', 'AbortError')
      }
      return json({})
    })
    try {
      const controller = new AbortController()
      controller.abort()
      const problem = await captured(
        getLink('abc', { workspaceId }, controller.signal),
      )
      expect(problem.kind).toBe('cancelled')
    } finally {
      aborted.restore()
    }
  })
})

describe('mutations and analytics', () => {
  test('a 204 delete resolves without parsing a body', async () => {
    const { restore } = mockFetch(() => new Response(null, { status: 204 }))
    try {
      await expect(
        deleteLink('abc', { workspaceId }, new AbortController().signal),
      ).resolves.toBeUndefined()
    } finally {
      restore()
    }
  })

  test('PATCH sends only the requested fields', async () => {
    const { calls, restore } = mockFetch(() =>
      json({
        short_code: 'abc',
        short_url: 'https://short.test/abc',
        long_url: 'https://example.com/',
        is_custom_alias: false,
        is_active: false,
        expires_at: null,
        created_at: '2026-10-15T00:00:00Z',
        updated_at: '2026-10-15T00:00:00Z',
      }),
    )
    try {
      await updateLink(
        'abc',
        { is_active: false },
        { workspaceId },
        new AbortController().signal,
      )
      expect(calls[0]!.init.method).toBe('PATCH')
      expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
        is_active: false,
      })
      expect(new Headers(calls[0]!.init.headers).get('X-Workspace-Id')).toBe(
        workspaceId,
      )
    } finally {
      restore()
    }
  })

  test('computes UTC half-open ranges and requests them as query params', async () => {
    const { from, to } = analyticsRange(7)
    expect(Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)).toBe(
      7 * 86_400_000,
    )
    const tomorrow = new Date()
    tomorrow.setUTCHours(0, 0, 0, 0)
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1)
    expect(to).toBe(tomorrow.toISOString().slice(0, 10))

    const { calls, restore } = mockFetch(() =>
      json({
        short_code: 'abc',
        from,
        to,
        totals: { clicks: 0, human_clicks: 0, bot_clicks: 0 },
        series: [],
        breakdowns: {
          from: null,
          to: null,
          truncated: false,
          top_referers: [],
          top_countries: [],
          devices: [],
        },
        last_processed_at: null,
        data_through: null,
        freshness: {
          redis_ok: true,
          pending_events: 0,
          lag_events: 0,
          oldest_pending_seconds: null,
          dead_letter_events: 0,
          captured_at: '2026-10-16T12:00:00Z',
        },
      }),
    )
    try {
      await getAnalytics(
        'abc',
        7,
        { workspaceId },
        new AbortController().signal,
      )
      const url = new URL(calls[0]!.url, 'https://shortly.test')
      expect(url.pathname).toBe('/api/v1/links/abc/analytics')
      expect(url.searchParams.get('from')).toBe(from)
      expect(url.searchParams.get('to')).toBe(to)
      expect(url.searchParams.get('interval')).toBe('day')
      expect(new Headers(calls[0]!.init.headers).get('X-Workspace-Id')).toBe(
        workspaceId,
      )
    } finally {
      restore()
    }
  })
})
