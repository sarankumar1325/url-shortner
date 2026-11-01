import { describe, expect, test } from 'bun:test'
import type { Analytics } from '../src/api'
import { getSeries } from '../src/links'
import {
  MAX_RANGE_DAYS,
  addDays,
  analyticsCsv,
  analyticsCsvName,
  changeLabel,
  changeTrend,
  customRange,
  lastDay,
  percentChange,
  presetRange,
  previousRange,
  rangeCaption,
  rangeDays,
} from '../src/ranges'

const now = new Date('2026-03-10T15:30:00Z')

describe('date ranges', () => {
  test('presets end today and include it', () => {
    expect(presetRange(7, now)).toEqual({ from: '2026-03-04', to: '2026-03-11' })
    expect(rangeDays(presetRange(90, now))).toBe(90)
    expect(rangeDays(presetRange(365, now))).toBe(365)
    expect(lastDay(presetRange(30, now))).toBe('2026-03-10')
  })

  test('day arithmetic crosses months and leap days', () => {
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29')
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
  })

  test('the previous period has the same length and ends where the range starts', () => {
    const range = presetRange(30, now)
    const previous = previousRange(range)
    expect(previous.to).toBe(range.from)
    expect(rangeDays(previous)).toBe(30)
    expect(previous).toEqual({ from: '2026-01-10', to: '2026-02-09' })
  })

  test('custom ranges are inclusive and validated', () => {
    expect(customRange('2026-03-01', '2026-03-01', now)).toEqual({
      range: { from: '2026-03-01', to: '2026-03-02' },
      error: null,
    })
    expect(customRange('', '2026-03-01', now).error).toMatch(/start and an end/)
    expect(customRange('2026-02-30', '2026-03-01', now).error).toMatch(/valid calendar/)
    expect(customRange('2026-03-05', '2026-03-01', now).error).toMatch(/on or before/)
    expect(customRange('2026-03-01', '2026-03-11', now).error).toMatch(/after today/)
  })

  test('custom ranges allow at most 366 days', () => {
    const longest = customRange(addDays('2026-03-10', -(MAX_RANGE_DAYS - 1)), '2026-03-10', now)
    expect(longest.error).toBeNull()
    expect(rangeDays(longest.range!)).toBe(366)
    const tooLong = customRange(addDays('2026-03-10', -MAX_RANGE_DAYS), '2026-03-10', now)
    expect(tooLong.range).toBeNull()
    expect(tooLong.error).toMatch(/366/)
  })

  test('captions name presets or the inclusive dates', () => {
    expect(rangeCaption(presetRange(90, now), 90)).toBe('In the last 90 UTC days')
    expect(rangeCaption({ from: '2026-01-01', to: '2026-02-01' }, null)).toBe(
      '2026-01-01 to 2026-01-31, UTC',
    )
  })
})

describe('comparison', () => {
  test('percent change rounds and needs a non-zero baseline', () => {
    expect(percentChange(112, 100)).toBe(12)
    expect(percentChange(50, 200)).toBe(-75)
    expect(percentChange(10, 0)).toBeNull()
  })

  test('labels read like a sentence', () => {
    expect(changeLabel(112, 100, 30)).toBe('+12% vs previous 30 days')
    expect(changeLabel(88, 100, 30)).toBe('−12% vs previous 30 days')
    expect(changeLabel(100, 100, 7)).toBe('No change vs previous 7 days')
    expect(changeLabel(5, 0, 1)).toBe('None in the previous 1 day')
    expect(changeLabel(0, 0, 30)).toBe('No clicks in the previous 30 days either')
  })

  test('trend follows the raw numbers', () => {
    expect(changeTrend(3, 1)).toBe('up')
    expect(changeTrend(1, 3)).toBe('down')
    expect(changeTrend(2, 2)).toBe('flat')
  })
})

describe('series for a range', () => {
  test('zero-fills every day in [from, to)', () => {
    const analytics = {
      series: [{ day: '2026-01-02', clicks: 4, human_clicks: 3, bot_clicks: 1 }],
    } as unknown as Analytics
    const series = getSeries({ analytics }, { from: '2026-01-01', to: '2026-01-04' }, now)
    expect(series.map((point) => point.day)).toEqual(['2026-01-01', '2026-01-02', '2026-01-03'])
    expect(series[1]).toMatchObject({ clicks: 4, humans: 3, bots: 1 })
    expect(series[0].clicks).toBe(0)
  })
})

describe('analytics CSV', () => {
  const breakdowns = {
    from: '2026-03-01',
    to: '2026-03-03',
    truncated: false,
    top_referers: [{ value: 'https://news.example, "quoted"', clicks: 2 }, { value: null, clicks: 1 }],
    top_countries: [{ value: 'IN', clicks: 3 }],
    devices: [{ value: 'mobile', clicks: 3 }],
  } as unknown as Analytics['breakdowns']

  test('writes the series then each breakdown with escaping', () => {
    const csv = analyticsCsv(
      [
        { day: '2026-03-01', clicks: 2, humans: 2, bots: 0 },
        { day: '2026-03-02', clicks: 1, humans: 0, bots: 1 },
      ],
      breakdowns,
    )
    expect(csv.split('\r\n')).toEqual([
      'section,value,clicks,human_clicks,bot_clicks',
      'day,2026-03-01,2,2,0',
      'day,2026-03-02,1,0,1',
      'referrer,"https://news.example, ""quoted""",2,,',
      'referrer,unknown,1,,',
      'country,IN,3,,',
      'device,mobile,3,,',
      '',
    ])
  })

  test('names the file after the code and inclusive dates', () => {
    expect(analyticsCsvName('abc', { from: '2026-03-01', to: '2026-03-08' })).toBe(
      'shortly-abc-2026-03-01-to-2026-03-07.csv',
    )
  })
})
