/**
 * Plain-text rendering of a {@link UsageReport} for `/usage` and the `usage`
 * tool result. Both surfaces read the same text so a user and the model see
 * the same figures.
 * @module
 */

import { localDateKey } from '@deepseek-ai/dsh-util-time'
import { totalTokens } from './report.ts'
import type { UsageReport, UsageTotals } from './types.ts'

/** Weeks of history in the day grid. */
const GRID_WEEKS = 12

/** Weekday row labels, Sunday first, matching `Date.getDay()`. */
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const

/** Grid glyphs from no usage to the busiest quarter. */
const LEVELS = ['·', '░', '▒', '▓', '█'] as const

const group = (value: number): string => value.toLocaleString('en-US')

/**
 * The day `offset` days after `from`, by calendar arithmetic.
 *
 * Adding days to the date field rather than milliseconds to the instant keeps
 * every step one calendar day across a daylight-saving transition.
 * @param from - the starting day.
 * @param offset - whole days to add, which may be negative.
 * @returns the shifted local day.
 */
function addDays(from: Date, offset: number): Date {
  return new Date(from.getFullYear(), from.getMonth(), from.getDate() + offset)
}

/**
 * Pick the glyph for one day against the window's busiest day.
 * @param tokens - the day's billable tokens.
 * @param busiest - billable tokens of the busiest day in the window.
 * @returns the grid glyph.
 */
function level(tokens: number, busiest: number): string {
  if (tokens <= 0) return LEVELS[0]
  const share = tokens / busiest
  if (share <= 0.25) return LEVELS[1]
  if (share <= 0.5) return LEVELS[2]
  if (share <= 0.75) return LEVELS[3]
  return LEVELS[4]
}

function totalsBlock(totals: UsageTotals): string[] {
  const sessions = `across ${group(totals.sessions)} session${totals.sessions === 1 ? '' : 's'}`
  const rows: [label: string, value: string, note: string][] = [
    ['Total', group(totalTokens(totals)), 'tokens'],
    ['  input', group(totals.inputTokens), ''],
    ['  output', group(totals.outputTokens), ''],
    ['  cache read', group(totals.cacheReadTokens), ''],
    ['  cache write', group(totals.cacheWriteTokens), ''],
    ['  reasoning', group(totals.reasoningTokens), 'part of output'],
    ['Messages', group(totals.messages), sessions],
  ]
  const labelWidth = Math.max(...rows.map(([label]) => label.length))
  const valueWidth = Math.max(...rows.map(([, value]) => value.length))
  return rows.map(([label, value, note]) =>
    `${label.padEnd(labelWidth)}  ${value.padStart(valueWidth)}${note === '' ? '' : `  ${note}`}`)
}

/** Called only for a report with counted messages, so `byModel` is never empty. */
function modelTable(report: UsageReport): string[] {
  const rows = report.byModel.map(entry => ({
    route: `${entry.provider}/${entry.model}`,
    total: group(totalTokens(entry.totals)),
    input: group(entry.totals.inputTokens),
    output: group(entry.totals.outputTokens),
    messages: group(entry.totals.messages),
  }))
  const width = (pick: (row: typeof rows[number]) => string, head: string): number =>
    Math.max(head.length, ...rows.map(row => pick(row).length))
  const routeWidth = width(row => row.route, 'model')
  const totalWidth = width(row => row.total, 'total')
  const inputWidth = width(row => row.input, 'input')
  const outputWidth = width(row => row.output, 'output')
  const messageWidth = width(row => row.messages, 'messages')
  const line = (route: string, total: string, input: string, output: string, messages: string): string =>
    `  ${route.padEnd(routeWidth)}  ${total.padStart(totalWidth)}  ${input.padStart(inputWidth)}`
    + `  ${output.padStart(outputWidth)}  ${messages.padStart(messageWidth)}`
  return [
    'By model',
    line('model', 'total', 'input', 'output', 'messages'),
    ...rows.map(row => line(row.route, row.total, row.input, row.output, row.messages)),
  ]
}

/**
 * Render the trailing {@link GRID_WEEKS} weeks as one glyph per day.
 *
 * Columns are weeks oldest to newest and rows are weekdays, so the window ends
 * on the week containing `today` and starts on a Sunday.
 * @param report - the report whose day series fills the grid.
 * @param today - the local day the window ends in.
 * @returns the grid lines.
 */
function dayGrid(report: UsageReport, today: Date): string[] {
  const tokensByDay = new Map(report.days.map(day => [day.day, totalTokens(day.totals)]))
  const lastColumnStart = addDays(today, -today.getDay())
  const firstColumnStart = addDays(lastColumnStart, -7 * (GRID_WEEKS - 1))
  let busiest = 0
  const cells: string[][] = []
  for (let weekday = 0; weekday < 7; weekday += 1) {
    const row: string[] = []
    for (let week = 0; week < GRID_WEEKS; week += 1) {
      const day = localDateKey(addDays(firstColumnStart, week * 7 + weekday))
      const tokens = tokensByDay.get(day) ?? 0
      busiest = Math.max(busiest, tokens)
      row.push(day)
    }
    cells.push(row)
  }
  const windowEnd = localDateKey(addDays(lastColumnStart, 6))
  const scale = busiest === 0
    ? 'no usage in this window'
    : `${LEVELS.join(' ')} up to ${group(busiest)} tokens/day`
  return [
    `Last ${GRID_WEEKS} weeks  ${localDateKey(firstColumnStart)} to ${windowEnd}  (${scale})`,
    ...cells.map((row, weekday) =>
      `  ${WEEKDAYS[weekday]}  ${row.map(day => level(tokensByDay.get(day) ?? 0, busiest)).join(' ')}`),
  ]
}

/**
 * Render one report as the text `/usage` prints and the `usage` tool returns.
 * @param report - the folded report.
 * @param now - the instant whose local day ends the grid window.
 * @returns the rendered report.
 */
export function renderUsageReport(report: UsageReport, now: Date = new Date()): string {
  if (report.overall.messages === 0) {
    return 'No token usage recorded in the session history.'
  }
  return [
    ...totalsBlock(report.overall),
    '',
    ...modelTable(report),
    '',
    ...dayGrid(report, now),
  ].join('\n')
}
