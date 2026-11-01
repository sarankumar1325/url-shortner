import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import { deleteAccount, newAccount } from './account'

const account = newAccount()
const destination = `https://example.com/e2e/${Date.now()}?from=playwright`
const remote = Boolean(process.env.E2E_BASE_URL)

test.describe.configure({ mode: 'serial' })

async function readClipboard(page: Page): Promise<string> {
  return page.evaluate(() => navigator.clipboard.readText())
}

async function writeClipboard(page: Page, value: string): Promise<void> {
  await page.evaluate((text) => navigator.clipboard.writeText(text), value)
}

async function signIn(page: Page, remember: boolean): Promise<void> {
  // The journey signs in more often than the per-account login limit allows
  // in one minute, so wait out a 429 instead of failing.
  for (let attempt = 0; ; attempt += 1) {
    await page.goto('/login')
    await page.getByLabel('Email').fill(account.email)
    await page.getByLabel('Password', { exact: true }).fill(account.password)
    await page.getByLabel(/Stay signed in/).setChecked(remember)
    const login = page.waitForResponse((response) => response.url().includes('/api/v1/auth/login'))
    await page.getByRole('button', { name: 'Sign in' }).click()
    const response = await login
    if (response.status() === 429 && attempt < 2) {
      const wait = Math.min(Number(response.headers()['retry-after'] ?? '60'), 70) + 1
      test.setTimeout(test.info().timeout + wait * 1000)
      await page.waitForTimeout(wait * 1000)
      continue
    }
    await expect(page.locator('#destination')).toBeVisible()
    return
  }
}

async function shorten(page: Page, url: string, password?: string): Promise<string> {
  await page.goto('/')
  await page.locator('#destination').fill(url)
  if (password) {
    await page.getByRole('button', { name: /Customize your link/ }).click()
    await page.getByLabel('Require a password').check()
    await page.getByLabel('Link password').fill(password)
  }
  await page.getByRole('button', { name: /Shorten link/ }).click()
  await expect(page.getByRole('button', { name: 'Copy short link', exact: true })).toBeVisible()
  return page.locator('.result-url').inputValue()
}

const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
const DESKTOP =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

/** A browser restart keeps persistent cookies and storage, and drops session cookies. */
async function restart(context: BrowserContext): Promise<BrowserContext> {
  const state = await context.storageState()
  const browser = context.browser()
  if (!browser) throw new Error('No browser to restart')
  await context.close()
  return browser.newContext({
    storageState: { ...state, cookies: state.cookies.filter((cookie) => cookie.expires > 0) },
    permissions: ['clipboard-read', 'clipboard-write'],
  })
}

test.afterAll(async ({ baseURL }) => {
  test.setTimeout(240_000)
  const outcome = await deleteAccount(baseURL ?? 'http://localhost:5173', account)
  console.log(`Cleanup for ${account.email}: ${outcome}`)
})

test('signs up and lands in the personal workspace', async ({ page }) => {
  await page.goto('/signup')
  await page.getByLabel('Your name').fill(account.name)
  await page.getByLabel('Email').fill(`  ${account.email} `)
  await expect(page.getByLabel('Email')).toHaveValue(account.email)
  await page.getByLabel('Password', { exact: true }).fill(account.password)
  await page.getByRole('button', { name: 'Create account' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Less link, QA.')
  await expect(page.locator('#destination')).toBeVisible()
})

test('pastes into the destination field and anywhere on the page', async ({ page }) => {
  await signIn(page, true)
  await writeClipboard(page, destination)

  const field = page.locator('#destination')
  await field.click()
  await page.keyboard.press('ControlOrMeta+V')
  await expect(field).toHaveValue(destination)

  await field.fill('')
  await page.getByRole('heading', { level: 1 }).click()
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.keyboard.press('ControlOrMeta+V')
  await expect(field).toHaveValue(destination)
  await expect(page.getByRole('button', { name: /Shorten link/ })).toBeFocused()
})

test('creates a link, focuses Copy link, and copies the full URL', async ({ page }) => {
  await signIn(page, true)
  await page.locator('#destination').fill(destination)

  // The expiry date picker: keyboard opens on today, a week down picks it.
  await page.getByRole('button', { name: /Customize your link/ }).click()
  const expiry = page.locator('#expires-at')
  await expiry.click()
  await expect(page.getByRole('dialog', { name: /Choose Expires after/ })).toBeVisible()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await expect(expiry).toHaveAttribute('aria-expanded', 'false')
  await expect(expiry).toBeFocused()
  await expect(expiry).toHaveText(/[A-Z][a-z]{2} \d{1,2}, \d{4}/)

  await page.getByRole('button', { name: /Shorten link/ }).click()

  const copyButton = page.getByRole('button', { name: 'Copy short link', exact: true })
  await expect(copyButton).toBeFocused()
  const shortUrl = await page.locator('.result-url').inputValue()
  expect(shortUrl).toMatch(remote ? /^https:\/\/\S+\/\w+$/ : /^https?:\/\/\S+\/\w+$/)

  await writeClipboard(page, '')
  await copyButton.click()
  await expect.poll(() => readClipboard(page)).toBe(shortUrl)

  await page.locator('.result-url').click()
  const selected = await page.evaluate(() => window.getSelection()?.toString() || (() => {
    const input = document.querySelector<HTMLInputElement>('.result-url')
    return input ? input.value.slice(input.selectionStart ?? 0, input.selectionEnd ?? 0) : ''
  })())
  expect(selected).toBe(shortUrl)
})

test('copies the hovered row with the c key', async ({ page }) => {
  await signIn(page, true)
  await page.getByRole('link', { name: 'Your links' }).first().click()
  const row = page.locator('.link-row[data-copy-url]').first()
  await expect(row).toBeVisible()
  const expected = await row.getAttribute('data-copy-url')
  expect(expected).toMatch(/^https?:\/\//)

  await writeClipboard(page, '')
  await row.hover()
  await page.keyboard.press('c')
  await expect.poll(() => readClipboard(page)).toBe(expected)
})

test('API responses carry Server-Timing', async ({ page }) => {
  await signIn(page, true)
  const response = await page.request.get('/api/v1/auth/me')
  expect(response.status()).toBe(200)
  const timing = response.headers()['server-timing'] ?? ''
  expect(timing).toMatch(/total;dur=\d/)
  expect(timing).toMatch(/db;dur=\d/)
})

test('palette, password links, smart redirects and bulk pause', async ({ page, context }) => {
  test.setTimeout(180_000)
  // Visitors never leave for the real destination.
  await context.route('https://example.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>Arrived</h1>' }),
  )
  await signIn(page, true)

  await page.keyboard.press('ControlOrMeta+K')
  const search = page.getByRole('combobox', { name: 'Search links, pages and actions' })
  await search.fill('Your links')
  await search.press('Enter')
  await expect(page).toHaveURL(/\/links$/)

  const password = 'open-sesame-e2e'
  const lockedUrl = await shorten(page, `${destination}&case=locked`, password)
  const visitor = await context.newPage()
  await visitor.goto(lockedUrl)
  await expect(visitor.getByRole('heading', { name: 'This link is password protected' })).toBeVisible()
  await visitor.getByLabel('Password').fill('not-the-password')
  await visitor.getByRole('button', { name: 'Continue' }).click()
  await expect(visitor.getByRole('alert')).toHaveText('That password is not right.')
  await visitor.getByLabel('Password').fill(password)
  await visitor.getByRole('button', { name: 'Continue' }).click()
  await expect(visitor).toHaveURL(/example\.com\/e2e\/.*case=locked/)
  await visitor.close()

  const smartUrl = await shorten(page, `${destination}&case=smart`)
  const smartCode = smartUrl.split('/').pop() ?? ''
  await page.goto(`/links/${smartCode}`)
  await page.getByRole('button', { name: 'Add rule' }).click()
  await page.getByLabel('iPhone and iPad').check()
  await page.getByLabel('Send these visitors to').fill('https://example.com/ios-app')
  await page.getByRole('button', { name: 'Save rules' }).click()
  await expect(page.getByText('Smart redirect rules saved.')).toBeVisible()
  const asIphone = await page.request.get(smartUrl, { maxRedirects: 0, headers: { 'user-agent': IPHONE } })
  const asDesktop = await page.request.get(smartUrl, { maxRedirects: 0, headers: { 'user-agent': DESKTOP } })
  expect(asIphone.status()).toBe(302)
  expect(asIphone.headers().location).toBe('https://example.com/ios-app')
  expect(asDesktop.headers().location).toContain('case=smart')

  const lockedCode = lockedUrl.split('/').pop() ?? ''
  await page.goto('/links')
  const lockedRow = page.locator('.link-row').filter({ hasText: lockedCode })
  const smartRow = page.locator('.link-row').filter({ hasText: smartCode })
  await expect(lockedRow).toContainText('Password')
  await expect(smartRow).toContainText('Smart')
  await page.getByLabel(`Select ${lockedCode}`).check()
  await page.getByLabel(`Select ${smartCode}`).check()
  const bar = page.getByRole('region', { name: 'Actions for selected links' })
  await expect(bar).toContainText('2 selected')
  await bar.getByRole('button', { name: 'Pause' }).click()
  await expect(lockedRow).toContainText('Paused')
  await expect(smartRow).toContainText('Paused')
  const paused = await page.request.get(smartUrl, {
    maxRedirects: 0,
    headers: { 'user-agent': IPHONE, accept: 'application/json' },
  })
  expect(paused.status()).toBe(404)

  await smartRow.getByRole('button', { name: `More actions for ${smartCode}` }).click()
  const menu = page.getByRole('menu', { name: `More actions for ${smartCode}` })
  await expect(menu.getByRole('menuitem', { name: 'Resume link' })).toBeVisible()
  await menu.getByRole('menuitem', { name: 'Delete link…' }).click()
  const confirm = page.getByRole('dialog', { name: 'Delete this link?' })
  await confirm.getByRole('button', { name: 'Delete link' }).click()
  await expect(page.getByText('Deleted 1 link.')).toBeVisible()
  await expect(smartRow).toHaveCount(0)
  await expect(lockedRow).toBeVisible()
  const deleted = await page.request.get(smartUrl, {
    maxRedirects: 0,
    headers: { accept: 'application/json' },
  })
  expect([404, 410]).toContain(deleted.status())

  await page.getByLabel('Sort').click()
  await page.getByRole('option', { name: 'Oldest first' }).click()
  await expect(page.getByLabel('Sort')).toHaveText('Oldest first')
})

test('signs out, rejects a wrong password, and signs back in', async ({ page }) => {
  await signIn(page, true)
  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page).toHaveURL(/\/login/)

  await page.getByLabel('Email').fill(account.email)
  await page.getByLabel('Password', { exact: true }).fill(`${account.password}-wrong`)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.locator('.form-problem')).toBeVisible()
  await expect(page).toHaveURL(/\/login/)

  await page.getByLabel('Password', { exact: true }).fill(account.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.locator('#destination')).toBeVisible()
})

test('Stay signed in survives a browser restart; unchecked does not', async ({ context }) => {
  const page = await context.newPage()
  await signIn(page, true)

  const restarted = await restart(context)
  const after = await restarted.newPage()
  await after.goto('/')
  await expect(after.locator('#destination')).toBeVisible()
  await after.getByRole('button', { name: 'Sign out' }).click()
  await expect(after).toHaveURL(/\/login/)

  await signIn(after, false)
  const again = await restart(restarted)
  const last = await again.newPage()
  await last.goto('/')
  await expect(last).toHaveURL(/\/login/)
  await again.close()
})

test('deletes the account from Settings', async ({ page }) => {
  await signIn(page, true)
  await page.goto('/settings')
  await page.locator('#delete-account-password').fill(account.password)
  await page.locator('#delete-account-email').fill(account.email)
  await page.getByRole('button', { name: 'Delete my account' }).click()
  await expect(page).toHaveURL(/\/login/)
  await expect(page.getByText('Your account was deleted.')).toBeVisible()

  await page.getByLabel('Email').fill(account.email)
  await page.getByLabel('Password', { exact: true }).fill(account.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.locator('.form-problem')).toBeVisible()
})
