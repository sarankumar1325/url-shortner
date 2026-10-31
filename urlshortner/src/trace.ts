import type { RedirectTrace, TraceStep } from './api'

export type Tone = 'good' | 'warn' | 'bad' | 'idle'

const GOOD = new Set(['allowed', 'hit', 'leader', 'loaded', 'written', 'live', 'remaining', 'done'])
const BAD = new Set(['not_found', 'expired', 'exhausted'])

export function outcomeTone(outcome: string): Tone {
  if (GOOD.has(outcome)) return 'good'
  if (BAD.has(outcome)) return 'bad'
  if (outcome === 'skipped') return 'idle'
  return 'warn'
}

export function outcomeLabel(outcome: string): string {
  return outcome.replace(/_/g, ' ')
}

export type WaterfallRow = TraceStep & { offset: number; width: number }

/** Lays steps end to end on one time axis, as fractions of the slowest of the two totals. */
export function waterfall(trace: RedirectTrace): WaterfallRow[] {
  const sum = trace.steps.reduce((total, step) => total + step.ms, 0)
  const scale = Math.max(trace.total_ms, sum, 0.001)
  let cursor = 0
  return trace.steps.map((step) => {
    const row = { ...step, offset: cursor / scale, width: step.ms / scale }
    cursor += step.ms
    return row
  })
}

export function formatMs(ms: number): string {
  if (ms === 0) return '0 ms'
  if (ms < 1) return `${Math.round(ms * 1000)} µs`
  if (ms < 100) return `${ms.toFixed(1)} ms`
  return `${Math.round(ms)} ms`
}

export function cacheOutcome(trace: RedirectTrace): string {
  return trace.steps.find((step) => step.step === 'cache')?.outcome ?? 'unknown'
}

/** How many times faster the warm run was, or null without a cold and a warm hit. */
export function speedup(cold: RedirectTrace | null, warm: RedirectTrace | null): number | null {
  if (!cold || !warm || cacheOutcome(warm) !== 'hit' || warm.total_ms <= 0) return null
  return Math.round((cold.total_ms / warm.total_ms) * 10) / 10
}

export function responseLabel(trace: RedirectTrace): string {
  const { status, reason } = trace.response
  if (status === 302) return reason === 'fallback' ? '302 to the fallback' : '302 redirect'
  if (status === 404) return '404 not found'
  if (status === 410) return reason === 'link_exhausted' ? '410 visit limit reached' : '410 expired'
  return String(status)
}
