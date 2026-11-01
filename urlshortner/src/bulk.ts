import type { BulkAction, BulkResponse } from './api'
import { isProblem } from './api'
import type { LinkRecord } from './links'

export const MAX_BULK_CODES = 200

export type SelectionState = 'none' | 'some' | 'all'

export function toggleCode(selected: ReadonlySet<string>, code: string): Set<string> {
  const next = new Set(selected)
  if (next.has(code)) next.delete(code)
  else next.add(code)
  return next
}

/** Selected codes that are still on screen; hidden or removed ones drop out. */
export function visibleSelection(selected: ReadonlySet<string>, visible: readonly string[]): string[] {
  return visible.filter((code) => selected.has(code))
}

export function selectionState(selected: ReadonlySet<string>, visible: readonly string[]): SelectionState {
  const count = visibleSelection(selected, visible).length
  if (count === 0) return 'none'
  return count === visible.length ? 'all' : 'some'
}

/** Select every visible link, or clear them when all are already selected. */
export function toggleAllVisible(selected: ReadonlySet<string>, visible: readonly string[]): Set<string> {
  if (selectionState(selected, visible) === 'all') return new Set()
  return new Set(visible)
}

export function chunk<T>(items: readonly T[], size = MAX_BULK_CODES): T[][] {
  const chunks: T[][] = []
  for (let start = 0; start < items.length; start += size) chunks.push(items.slice(start, start + size))
  return chunks
}

/** Mirror a bulk response in the local list without refetching it. */
export function applyBulkResult(
  links: LinkRecord[],
  response: Pick<BulkResponse, 'action' | 'results'>,
  tags: readonly string[] = [],
): LinkRecord[] {
  const changed = new Set(
    response.results.filter((item) => item.status === 'ok').map((item) => item.short_code),
  )
  const action = response.action
  if (action === 'delete') return links.filter((link) => !changed.has(link.code))
  return links.map((link) => {
    if (!changed.has(link.code)) return link
    if (action === 'pause' || action === 'resume') return { ...link, active: action === 'resume' }
    if (action === 'add_tags') {
      return { ...link, tags: [...link.tags, ...tags.filter((tag) => !link.tags.includes(tag))].sort() }
    }
    return { ...link, tags: link.tags.filter((tag) => !tags.includes(tag)) }
  })
}

const DONE: Record<BulkAction, string> = {
  pause: 'Paused',
  resume: 'Resumed',
  delete: 'Deleted',
  add_tags: 'Tagged',
  remove_tags: 'Untagged',
}

export function bulkSummary(response: Pick<BulkResponse, 'action' | 'results'>): string {
  const count = (status: string) => response.results.filter((item) => item.status === status).length
  const ok = count('ok')
  const parts = [`${DONE[response.action]} ${ok} link${ok === 1 ? '' : 's'}.`]
  const missing = count('not_found')
  if (missing) parts.push(`${missing} ${missing === 1 ? 'was' : 'were'} not found.`)
  const full = count('too_many_tags')
  if (full) parts.push(`${full} already ${full === 1 ? 'has' : 'have'} 5 tags.`)
  return parts.join(' ')
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Retry a request that was rate limited, waiting as long as Retry-After asks
 * (one second when absent, at most a minute per wait).
 */
export async function withRateLimitRetry<T>(
  run: () => Promise<T>,
  { retries = 3, wait = sleep }: { retries?: number; wait?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run()
    } catch (error) {
      if (attempt >= retries || !isProblem(error) || error.problem.status !== 429) throw error
      const seconds = Math.min(60, Math.max(1, error.problem.retryAfterSeconds ?? 1))
      await wait(seconds * 1000)
    }
  }
}

/** Run at most `limit` workers at a time; results keep the input order. */
export async function runPool<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  async function lane() {
    while (next < items.length) {
      const index = next
      next += 1
      results[index] = await worker(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane))
  return results
}
