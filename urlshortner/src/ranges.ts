import type { Analytics, DateRange } from './api'
import type { ChartPoint } from './links'

export const RANGE_PRESETS = [7, 30, 90, 365] as const
export type RangePreset = (typeof RANGE_PRESETS)[number]
/** The API accepts at most 366 days per request. */
export const MAX_RANGE_DAYS = 366
const DAY_MS = 86_400_000
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/

export function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10)
}

export function addDays(day: string, offset: number): string {
  return utcDay(new Date(Date.parse(`${day}T00:00:00Z`) + offset * DAY_MS))
}

function isCalendarDay(value: string): boolean {
  return DAY_PATTERN.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && addDays(value, 0) === value
}

/** The last `days` UTC days including today, as a half-open [from, to) range. */
export function presetRange(days: number, now = new Date()): DateRange {
  const today = utcDay(now)
  return { from: addDays(today, -(days - 1)), to: addDays(today, 1) }
}

export function rangeDays(range: DateRange): number {
  return Math.round((Date.parse(`${range.to}T00:00:00Z`) - Date.parse(`${range.from}T00:00:00Z`)) / DAY_MS)
}

/** The final day inside the range (to is exclusive). */
export function lastDay(range: DateRange): string {
  return addDays(range.to, -1)
}

/** The period of the same length that ends where this one starts. */
export function previousRange(range: DateRange): DateRange {
  return { from: addDays(range.from, -rangeDays(range)), to: range.from }
}

/** Validate inclusive From/To dates from the picker and convert them to a range. */
export function customRange(
  fromInput: string,
  toInput: string,
  now = new Date(),
): { range: DateRange | null; error: string | null } {
  if (!fromInput || !toInput) return { range: null, error: 'Choose a start and an end date.' }
  if (!isCalendarDay(fromInput) || !isCalendarDay(toInput)) {
    return { range: null, error: 'Choose valid calendar dates.' }
  }
  if (fromInput > toInput) {
    return { range: null, error: 'The start date must be on or before the end date.' }
  }
  if (toInput > utcDay(now)) return { range: null, error: 'The end date cannot be after today (UTC).' }
  const range = { from: fromInput, to: addDays(toInput, 1) }
  if (rangeDays(range) > MAX_RANGE_DAYS) {
    return { range: null, error: `Choose at most ${MAX_RANGE_DAYS} days.` }
  }
  return { range, error: null }
}

/** Whole-number percent change, or null when there is nothing to compare against. */
export function percentChange(current: number, previous: number): number | null {
  if (previous === 0) return null
  return Math.round(((current - previous) / previous) * 100)
}

export function changeTrend(current: number, previous: number): 'up' | 'down' | 'flat' {
  if (current === previous) return 'flat'
  return current > previous ? 'up' : 'down'
}

export function changeLabel(current: number, previous: number, days: number): string {
  const period = `previous ${days} day${days === 1 ? '' : 's'}`
  if (previous === 0) {
    return current === 0 ? `No clicks in the ${period} either` : `None in the ${period}`
  }
  const change = percentChange(current, previous) ?? 0
  if (change === 0) return `No change vs ${period}`
  return `${change > 0 ? '+' : '−'}${Math.abs(change)}% vs ${period}`
}

export function rangeCaption(range: DateRange, preset: RangePreset | null): string {
  if (preset !== null) return `In the last ${preset} UTC days`
  return `${range.from} to ${lastDay(range)}, UTC`
}

function csvField(value: string | number | null): string {
  const text = value === null ? '' : String(value)
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** Daily series followed by the breakdowns, in one table with a section column. */
export function analyticsCsv(series: ChartPoint[], breakdowns: Analytics['breakdowns']): string {
  const rows: (string | number | null)[][] = [
    ['section', 'value', 'clicks', 'human_clicks', 'bot_clicks'],
    ...series.map((point) => ['day', point.day, point.clicks, point.humans, point.bots]),
    ...breakdowns.top_referers.map((entry) => ['referrer', entry.value ?? 'unknown', entry.clicks, null, null]),
    ...breakdowns.top_countries.map((entry) => ['country', entry.value ?? 'unknown', entry.clicks, null, null]),
    ...breakdowns.devices.map((entry) => ['device', entry.value, entry.clicks, null, null]),
  ]
  return rows.map((row) => row.map(csvField).join(',')).join('\r\n') + '\r\n'
}

export function analyticsCsvName(code: string, range: DateRange): string {
  return `shortly-${code}-${range.from}-to-${lastDay(range)}.csv`
}
