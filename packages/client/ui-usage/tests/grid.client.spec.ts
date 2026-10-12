// The heatmap's calendar model, and the agreement between it and the day grid
// `/usage` prints. `renderUsageReport` is a Host module the client bundle may
// not import a value from, so `src/client/grid.ts` restates its arithmetic;
// these tests are what keep the two restatements one calendar.
import { describe, expect, it } from 'vitest'
import { localDateKey } from '@deepseek-ai/dsh-util-time'
import { renderUsageReport } from '@deepseek-ai/dsh-session-usage/src/render.ts'
import type { UsageReport } from '@deepseek-ai/dsh-session-usage/src/types.ts'
import type { UsageDayValue } from '@deepseek-ai/dsh-api-usage-controller/types'
import { addDays, buildHeatmap, dayKey, heatmapLevel, HEATMAP_SPAN_DAYS } from '../src/client/grid.ts'

/** One day of the wire series; only the billable total reaches the grid. */
function day(key: string, tokens: number): UsageDayValue {
  return {
    day: key,
    totals: {
      inputTokens: tokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
      totalTokens: tokens, messages: 1, sessions: 1,
    },
  }
}

/** The same series as the Host report `renderUsageReport` consumes. */
function hostReport(days: readonly UsageDayValue[]): UsageReport {
  return {
    overall: {
      inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
      messages: 1, sessions: 1,
    },
    days: days.map(entry => ({
      day: entry.day,
      totals: {
        inputTokens: entry.totals.totalTokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
        reasoningTokens: 0, messages: 1, sessions: 1,
      },
    })),
    byModel: [{
      provider: 'deepseek',
      model: 'deepseek-chat',
      totals: {
        inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
        messages: 1, sessions: 1,
      },
    }],
  }
}

/** Every `day` square of the grid, oldest first. */
function squares(weeks: ReturnType<typeof buildHeatmap>['weeks']) {
  return weeks.flatMap(week => week.cells.filter(cell => cell.kind === 'day'))
}

describe('addDays and dayKey', () => {
  it('steps the calendar date rather than the instant, so no day is 23 or 25 hours long', () => {
    const start = new Date(2026, 2, 8, 12, 30, 0)
    const next = addDays(start, 1)
    expect([next.getFullYear(), next.getMonth(), next.getDate()]).toEqual([2026, 2, 9])
    expect(next.getHours()).toBe(0)
  })

  it('rolls months, years and a leap day', () => {
    expect(dayKey(addDays(new Date(2026, 0, 31), 1))).toBe('2026-02-01')
    expect(dayKey(addDays(new Date(2026, 11, 31), 1))).toBe('2027-01-01')
    expect(dayKey(addDays(new Date(2027, 0, 1), -1))).toBe('2026-12-31')
    expect(dayKey(addDays(new Date(2028, 1, 28), 1))).toBe('2028-02-29')
  })

  it('places a day exactly as the Host does', () => {
    for (let offset = -400; offset <= 400; offset += 1) {
      const date = addDays(new Date(2026, 8, 22), offset)
      expect(dayKey(date)).toBe(localDateKey(date))
    }
  })
})

describe('heatmapLevel', () => {
  it('reserves level 0 for no usage and splits the rest into quarters of the busiest day', () => {
    expect(heatmapLevel(0, 100)).toBe(0)
    expect(heatmapLevel(1, 100)).toBe(1)
    expect(heatmapLevel(25, 100)).toBe(1)
    expect(heatmapLevel(26, 100)).toBe(2)
    expect(heatmapLevel(50, 100)).toBe(2)
    expect(heatmapLevel(51, 100)).toBe(3)
    expect(heatmapLevel(75, 100)).toBe(3)
    expect(heatmapLevel(76, 100)).toBe(4)
    expect(heatmapLevel(100, 100)).toBe(4)
  })
})

describe('buildHeatmap', () => {
  it('spans one year of days ending today, seven rows per column', () => {
    const heatmap = buildHeatmap([], new Date(2026, 8, 22))
    expect([heatmap.from, heatmap.to]).toEqual(['2025-09-23', '2026-09-22'])
    expect(squares(heatmap.weeks)).toHaveLength(HEATMAP_SPAN_DAYS)
    expect(heatmap.weeks).toHaveLength(53)
    for (const week of heatmap.weeks) expect(week.cells).toHaveLength(7)
  })

  it('renders a day with no usage as an empty square rather than leaving it out', () => {
    // The report omits idle days entirely, so every zero below is one the grid filled in.
    const heatmap = buildHeatmap([day('2026-09-20', 900)], new Date(2026, 8, 22))
    const cells = squares(heatmap.weeks)
    expect(cells).toHaveLength(HEATMAP_SPAN_DAYS)
    expect(cells.filter(cell => cell.tokens === 0)).toHaveLength(HEATMAP_SPAN_DAYS - 1)
    const idle = cells.find(cell => cell.day === '2026-09-21')
    expect(idle).toEqual({ kind: 'day', day: '2026-09-21', tokens: 0, level: 0 })
    expect(cells.find(cell => cell.day === '2026-09-20')).toMatchObject({ tokens: 900, level: 4 })
    expect(heatmap).toMatchObject({ busiest: 900, total: 900, activeDays: 1 })
  })

  it('pads the first and last columns, because the window starts and ends mid-week', () => {
    // Both ends fall on a Tuesday: the first column opens two squares early
    // and the last one runs four squares past today.
    const heatmap = buildHeatmap([], new Date(2026, 8, 22))
    const first = heatmap.weeks[0]
    const last = heatmap.weeks.at(-1)
    expect(first?.start).toBe('2025-09-21')
    expect(first?.cells.map(cell => cell.kind)).toEqual([
      'padding', 'padding', 'day', 'day', 'day', 'day', 'day',
    ])
    expect(last?.start).toBe('2026-09-20')
    expect(last?.cells.map(cell => cell.kind)).toEqual([
      'day', 'day', 'day', 'padding', 'padding', 'padding', 'padding',
    ])
  })

  it('pads no square of the first column when the window opens on a Sunday', () => {
    // A window ending on a Sunday opens on one, so only the last column is partial.
    const heatmap = buildHeatmap([], new Date(2026, 8, 20))
    expect(heatmap.from).toBe('2025-09-21')
    expect(heatmap.weeks[0]?.cells.every(cell => cell.kind === 'day')).toBe(true)
    expect(heatmap.weeks.at(-1)?.cells.map(cell => cell.kind)).toEqual([
      'day', 'padding', 'padding', 'padding', 'padding', 'padding', 'padding',
    ])
  })

  it('carries columns across a year boundary and labels each month once', () => {
    const heatmap = buildHeatmap([day('2025-12-31', 10), day('2026-01-01', 20)], new Date(2026, 0, 6))
    expect([heatmap.from, heatmap.to]).toEqual(['2025-01-07', '2026-01-06'])
    const cells = squares(heatmap.weeks)
    expect(cells.find(cell => cell.day === '2025-12-31')).toMatchObject({ tokens: 10, level: 2 })
    expect(cells.find(cell => cell.day === '2026-01-01')).toMatchObject({ tokens: 20, level: 4 })
    // Consecutive squares straddle the year end with no gap.
    const keys = cells.map(cell => cell.day)
    const end = keys.indexOf('2025-12-31')
    expect(keys.slice(end - 1, end + 3)).toEqual(['2025-12-30', '2025-12-31', '2026-01-01', '2026-01-02'])
    // Thirteen columns open a month between 2025-01 and 2026-01, each labelled once in order.
    const labels = heatmap.weeks.flatMap(week => week.monthLabel === undefined ? [] : [week.monthLabel])
    expect(labels).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 0])
  })

  it('leaves every square empty when nothing was recorded', () => {
    const heatmap = buildHeatmap([], new Date(2026, 8, 22))
    expect(heatmap).toMatchObject({ busiest: 0, total: 0, activeDays: 0 })
    expect(squares(heatmap.weeks).every(cell => cell.level === 0)).toBe(true)
  })

  it('ignores days outside the window', () => {
    const heatmap = buildHeatmap([day('2024-05-05', 10_000), day('2026-09-22', 5)], new Date(2026, 8, 22))
    expect(heatmap).toMatchObject({ busiest: 5, total: 5, activeDays: 1 })
  })
})

describe('agreement with the Host day grid', () => {
  // The text grid is 12 weeks wide and starts on the Sunday of its first
  // column, so a window of that many days ending today covers exactly it.
  const GRID_WEEKS = 12
  const GLYPHS = ['·', '░', '▒', '▓', '█'] as const

  /** The glyph rows of the text grid, oldest column first, Sunday row first. */
  function hostGrid(report: UsageReport, today: Date): { from: string; to: string; rows: string[][] } {
    const lines = renderUsageReport(report, today).split('\n')
    const header = lines.find(line => line.startsWith(`Last ${String(GRID_WEEKS)} weeks`))
    if (header === undefined) throw new Error('the Host grid header is missing')
    const range = header.match(/(\d{4}-\d{2}-\d{2}) to (\d{4}-\d{2}-\d{2})/)
    if (range === null) throw new Error('the Host grid header carries no range')
    const rows = lines
      .filter(line => /^ {2}(Sun|Mon|Tue|Wed|Thu|Fri|Sat) {2}/.test(line))
      .map(line => line.slice(7).trim().split(' '))
    return { from: range[1] as string, to: range[2] as string, rows }
  }

  const DAYS: UsageDayValue[] = [
    day('2026-03-06', 400),
    day('2026-03-08', 1000),
    day('2026-03-09', 250),
    day('2026-04-01', 500),
    day('2026-05-10', 751),
    day('2026-05-24', 26),
  ]

  // Dates chosen for the transitions the calendar arithmetic must survive: the
  // two daylight-saving Sundays, the turn of the year, and a leap day.
  it.each([
    ['spring transition', new Date(2026, 2, 12)],
    ['autumn transition', new Date(2026, 10, 5)],
    ['the last day of a year', new Date(2026, 11, 31)],
    ['the first day of a year', new Date(2027, 0, 1)],
    ['a leap day', new Date(2028, 1, 29)],
    ['a Sunday', new Date(2026, 4, 24)],
    ['a Saturday', new Date(2026, 4, 30)],
  ])('places the same days in the same squares as the text grid across %s', (_label, today) => {
    // The window that exactly covers the text grid: its 12 columns start on the
    // Sunday of today's week, 11 weeks back.
    const span = 7 * (GRID_WEEKS - 1) + today.getDay() + 1
    const heatmap = buildHeatmap(DAYS, today, span)
    const host = hostGrid(hostReport(DAYS), today)

    expect(heatmap.from).toBe(host.from)
    expect(heatmap.weeks).toHaveLength(GRID_WEEKS)
    expect(dayKey(addDays(new Date(
      Number(heatmap.weeks.at(-1)?.start.slice(0, 4)),
      Number(heatmap.weeks.at(-1)?.start.slice(5, 7)) - 1,
      Number(heatmap.weeks.at(-1)?.start.slice(8, 10)),
    ), 6))).toBe(host.to)

    for (const [column, week] of heatmap.weeks.entries()) {
      for (const [weekday, cell] of week.cells.entries()) {
        const glyph = host.rows[weekday]?.[column]
        // Squares after today are the rest of the current week: the text grid
        // paints them as empty, the dashboard leaves them blank.
        if (cell.kind === 'padding') {
          expect(glyph).toBe(GLYPHS[0])
          continue
        }
        expect(glyph).toBe(GLYPHS[cell.level])
      }
    }
  })
})
