import { request, type APIRequestContext } from '@playwright/test'

export type TestAccount = { email: string; password: string; name: string }

export function newAccount(): TestAccount {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`
  return {
    email: `qa-droid-${stamp}@example.com`,
    password: `Correct-Horse-${stamp}`,
    name: 'QA Droid',
  }
}

function sessionCookie(setCookie: string | undefined): string | null {
  const first = setCookie?.split(';')[0]?.trim()
  return first && first.includes('=') ? first : null
}

/**
 * Deletes the account through the API. Safe to call when the account was
 * never created or is already gone; returns what happened for the log.
 */
export async function deleteAccount(baseURL: string, account: TestAccount): Promise<string> {
  const api: APIRequestContext = await request.newContext({ baseURL })
  try {
    const login = await api.post('/api/v1/auth/login', {
      data: { email: account.email, password: account.password, remember: false },
    })
    if (login.status() === 401) return 'not found (already deleted or never created)'
    if (!login.ok()) return `login failed with ${login.status()}`
    const cookie = sessionCookie(login.headers()['set-cookie'])
    const removed = await api.delete('/api/v1/auth/account', {
      data: { password: account.password, confirm_email: account.email },
      headers: cookie ? { Cookie: cookie } : undefined,
    })
    return removed.status() === 204 ? 'deleted' : `delete failed with ${removed.status()}`
  } finally {
    await api.dispose()
  }
}
