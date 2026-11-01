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
  await page.goto('/login')
  await page.getByLabel('Email').fill(account.email)
  await page.getByLabel('Password', { exact: true }).fill(account.password)
  await page.getByLabel(/Stay signed in/).setChecked(remember)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.locator('#destination')).toBeVisible()
}

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
