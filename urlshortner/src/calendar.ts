import { addDays, utcDay } from './ranges'

/** UTC calendar math for the date picker. Days are `YYYY-MM-DD` strings. */

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const DAY_MS = 86_400_000

export function isDay(value: string): boolean {
  if (!DAY_PATTERN.test(value)) return false
  const time = Date.parse(`${value}T00:00:00Z`)
  return Number.isFinite(time) && utcDay(new Date(time)) === value
}

function parts(day: string): { year: number; month: number; date: number } {
  return {
    year: Number(day.slice(0, 4)),
    month: Number(day.slice(5, 7)) - 1,
    date: Number(day.slice(8, 10)),
  }
}

function fromParts(year: number, month: number, date: number): string {
  return utcDay(new Date(Date.UTC(year, month, date)))
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
}

export function monthOf(day: string): { year: number; month: number } {
  const { year, month } = parts(day)
  return { year, month }
}

export function firstOfMonth(day: string): string {
  const { year, month } = parts(day)
  return fromParts(year, month, 1)
}

/** Move by whole months, keeping the day of month where that month allows. */
export function shiftMonth(day: string, months: number): string {
  const { year, month, date } = parts(day)
  const target = new Date(Date.UTC(year, month + months, 1))
  const targetYear = target.getUTCFullYear()
  const targetMonth = target.getUTCMonth()
  return fromParts(targetYear, targetMonth, Math.min(date, daysInMonth(targetYear, targetMonth)))
}

/** Six weeks covering the month of `day`, starting on `weekStart` (0 = Sunday). */
export function monthGrid(day: string, weekStart = 0): string[][] {
  const first = firstOfMonth(day)
  const offset = (new Date(`${first}T00:00:00Z`).getUTCDay() - weekStart + 7) % 7
  const start = addDays(first, -offset)
  return Array.from({ length: 6 }, (_, week) =>
    Array.from({ length: 7 }, (_, weekday) => addDays(start, week * 7 + weekday)),
  )
}

export function weekEdge(day: string, edge: 'start' | 'end', weekStart = 0): string {
  const offset = (new Date(`${day}T00:00:00Z`).getUTCDay() - weekStart + 7) % 7
  return edge === 'start' ? addDays(day, -offset) : addDays(day, 6 - offset)
}

export function isWithin(day: string, min?: string, max?: string): boolean {
  return (!min || day >= min) && (!max || day <= max)
}

export function clampDay(day: string, min?: string, max?: string): string {
  if (min && day < min) return min
  if (max && day > max) return max
  return day
}

/** Whether moving one month in `direction` still reaches an allowed day. */
export function canShiftMonth(
  day: string,
  direction: -1 | 1,
  min?: string,
  max?: string,
): boolean {
  if (direction < 0) return !min || addDays(firstOfMonth(day), -1) >= min
  return !max || firstOfMonth(shiftMonth(firstOfMonth(day), 1)) <= max
}

function format(day: string, options: Intl.DateTimeFormatOptions): string {
  return new Date(Date.parse(`${day}T00:00:00Z`)).toLocaleDateString('en-US', {
    ...options,
    timeZone: 'UTC',
  })
}

export function shortDayLabel(day: string): string {
  return format(day, { month: 'short', day: 'numeric', year: 'numeric' })
}

export function longDayLabel(day: string): string {
  return format(day, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
}

export function monthTitle(day: string): string {
  return format(firstOfMonth(day), { month: 'long', year: 'numeric' })
}

export function weekdayNames(weekStart = 0): { short: string; long: string }[] {
  // 2023-01-01 was a Sunday.
  const sunday = Date.UTC(2023, 0, 1)
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(sunday + ((index + weekStart) % 7) * DAY_MS)
    return {
      short: date.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' }).slice(0, 2),
      long: date.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' }),
    }
  })
}
