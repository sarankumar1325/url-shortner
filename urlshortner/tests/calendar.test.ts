import { describe, expect, test } from 'bun:test'
import {
  canShiftMonth,
  clampDay,
  isDay,
  longDayLabel,
  monthGrid,
  monthTitle,
  shiftMonth,
  shortDayLabel,
  weekEdge,
  weekdayNames,
} from '../src/calendar'

describe('calendar days', () => {
  test('accepts only real calendar days', () => {
    expect(isDay('2026-02-28')).toBe(true)
    expect(isDay('2028-02-29')).toBe(true)
    expect(isDay('2026-02-29')).toBe(false)
    expect(isDay('2026-13-01')).toBe(false)
    expect(isDay('')).toBe(false)
    expect(isDay('2026-1-01')).toBe(false)
  })

  test('shifting months keeps the day where the month allows', () => {
    expect(shiftMonth('2026-01-31', 1)).toBe('2026-02-28')
    expect(shiftMonth('2026-03-15', -1)).toBe('2026-02-15')
    expect(shiftMonth('2026-12-10', 1)).toBe('2027-01-10')
    expect(shiftMonth('2028-02-29', 12)).toBe('2029-02-28')
    expect(shiftMonth('2026-01-05', -13)).toBe('2024-12-05')
  })

  test('the month grid is six full weeks starting on Sunday', () => {
    const grid = monthGrid('2026-10-24')
    expect(grid).toHaveLength(6)
    expect(grid.every((week) => week.length === 7)).toBe(true)
    // October 1, 2026 is a Thursday.
    expect(grid[0][0]).toBe('2026-09-27')
    expect(grid[0][4]).toBe('2026-10-01')
    expect(grid[5][6]).toBe('2026-11-07')
  })

  test('a month that starts on the week start has no leading days', () => {
    // November 1, 2026 is a Sunday.
    expect(monthGrid('2026-11-20')[0][0]).toBe('2026-11-01')
    expect(monthGrid('2026-11-20', 1)[0][0]).toBe('2026-10-26')
  })

  test('week edges', () => {
    expect(weekEdge('2026-10-24', 'start')).toBe('2026-10-18')
    expect(weekEdge('2026-10-24', 'end')).toBe('2026-10-24')
    expect(weekEdge('2026-10-21', 'end')).toBe('2026-10-24')
  })

  test('clamping and month limits respect min and max', () => {
    expect(clampDay('2026-01-01', '2026-02-01')).toBe('2026-02-01')
    expect(clampDay('2026-05-01', undefined, '2026-04-30')).toBe('2026-04-30')
    expect(clampDay('2026-03-03', '2026-01-01', '2026-12-31')).toBe('2026-03-03')
    expect(canShiftMonth('2026-02-10', -1, '2026-02-01')).toBe(false)
    expect(canShiftMonth('2026-02-10', -1, '2026-01-31')).toBe(true)
    expect(canShiftMonth('2026-02-10', 1, undefined, '2026-02-28')).toBe(false)
    expect(canShiftMonth('2026-02-10', 1, undefined, '2026-03-01')).toBe(true)
    expect(canShiftMonth('2026-02-10', 1)).toBe(true)
  })

  test('labels read in UTC whatever the local zone', () => {
    expect(shortDayLabel('2026-10-24')).toBe('Oct 24, 2026')
    expect(longDayLabel('2026-10-24')).toBe('Saturday, October 24, 2026')
    expect(monthTitle('2026-10-24')).toBe('October 2026')
    expect(weekdayNames().map((day) => day.short)).toEqual(['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'])
    expect(weekdayNames(1)[0].long).toBe('Monday')
  })
})
