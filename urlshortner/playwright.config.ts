import { defineConfig, devices } from '@playwright/test'

const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:5173'
const local = !process.env.E2E_BASE_URL

export default defineConfig({
  testDir: './e2e',
  // *.spec.ts would also be picked up by `bun test`.
  testMatch: '**/*.e2e.ts',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        permissions: ['clipboard-read', 'clipboard-write'],
      },
    },
  ],
  // Locally, start the web app if it is not already running. The API must be
  // running separately at http://127.0.0.1:8000.
  webServer: local
    ? {
        command: 'bun run dev --port 5173 --strictPort',
        url: baseURL,
        reuseExistingServer: true,
        timeout: 60_000,
      }
    : undefined,
})
