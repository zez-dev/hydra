/**
 * Weekly review helpers: the `<weekday> HH:MM` grammar, ISO week naming, the
 * machine-readable footer of daily reports, aggregation of seven daily
 * footers into trends, sparklines, and the weekly Markdown renderer.
 * @module
 */

import { localDateKey } from '@deepseek-ai/dsh-util-time'
import { FOOTER_MARK } from './report.ts'
import type { DailyTotals, WeekDay, WeeklyInput, WeeklyTime, WeekSeries } from './types.ts'

/** Weekday names accepted by `weeklyOn`, index = JavaScript `getDay()`. */
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const

/** Sparkline glyphs from lowest to highest. */
const BARS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const

/** Ticket statuses that count as a closed outcome. */
const CLOSED_STATUSES: ReadonlySet<string> = new Set(['verified', 'closed', 'wontfix'])

/** Numeric footer fields, every one required in a valid footer. */
const NUMERIC_FIELDS = ['ticketsOpened', 'ticketsClosed', 'checkpoints', 'breakthroughs', 'memoryCandidates', 'memoryApproved', 'cronRuns'] as const

/**
 * Whether a ticket status is a closed outcome for the weekly counts.
 * @param status - the ticket status.
 * @returns true for `verified`, `closed`, and `wontfix`.
 */
export function isClosedOutcome(status: string): boolean {
  return CLOSED_STATUSES.has(status)
}

/**
 * Parse a `<weekday> HH:MM` local time; the weekday accepts full names or
 * three-letter prefixes in any case.
 * @param text - the configured value.
 * @returns the weekday (0 = Sunday), hour, and minute.
 * @throws when the text is not a weekday followed by `HH:MM` within the day.
 */
export function parseWeeklyOn(text: string): WeeklyTime {
  const match = /^(?<day>[a-z]+)\s+(?<hour>\d{1,2}):(?<minute>\d{2})$/iu.exec(text.trim())?.groups
  const day = (match?.['day'] ?? '').toLowerCase()
  const weekday = WEEKDAYS.findIndex(name => name === day || (day.length === 3 && name.startsWith(day)))
  const hour = match === undefined ? NaN : Number(match['hour'])
  const minute = match === undefined ? NaN : Number(match['minute'])
  if (weekday < 0 || !Number.isInteger(hour) || !Number.isInteger(minute) || hour > 23 || minute > 59) {
    throw new Error(`digest: weeklyOn must be "<weekday> HH:MM" in local time, got ${JSON.stringify(text)}`)
  }
  return { weekday, hour, minute }
}

/**
 * Milliseconds from `now` to the next occurrence of a weekday and local time.
 * @param time - the target weekday and time.
 * @param now - the reference moment.
 * @returns a positive delay; a target equal to `now` counts as next week.
 */
export function msUntilWeekly(time: WeeklyTime, now: Date): number {
  const target = new Date(now)
  target.setHours(time.hour, time.minute, 0, 0)
  target.setDate(target.getDate() + ((time.weekday - target.getDay() + 7) % 7))
  if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 7)
  return target.getTime() - now.getTime()
}

/**
 * The ISO-8601 week label of a local moment.
 * @param at - the moment.
 * @returns `YYYY-Www`, where the year is the ISO week-numbering year.
 */
export function isoWeekLabel(at: Date): string {
  const date = new Date(Date.UTC(at.getFullYear(), at.getMonth(), at.getDate()))
  const weekday = date.getUTCDay() || 7
  date.setUTCDate(date.getUTCDate() + 4 - weekday)
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1)
  const week = Math.ceil(((date.getTime() - yearStart) / 86_400_000 + 1) / 7)
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

/**
 * The seven local calendar dates ending on a day, oldest first.
 * @param end - the last day of the range.
 * @returns seven `YYYY-MM-DD` strings.
 */
export function weekDates(end: Date): string[] {
  const dates: string[] = []
  for (let back = 6; back >= 0; back--) {
    const day = new Date(end)
    day.setDate(day.getDate() - back)
    dates.push(localDateKey(day))
  }
  return dates
}

/**
 * Read the totals footer of a daily report.
 * @param text - the report Markdown.
 * @returns the totals, or `undefined` when the report has no valid footer.
 */
export function parseDigestFooter(text: string): DailyTotals | undefined {
  const json = new RegExp(`<!-- ${FOOTER_MARK} (?<json>\\{.*?\\}) -->`, 'u').exec(text)?.groups?.['json']
  if (json === undefined) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    // A hand-edited footer is not data.
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const record = parsed as Record<string, unknown>
  if (typeof record['date'] !== 'string') return undefined
  for (const field of NUMERIC_FIELDS) if (typeof record[field] !== 'number') return undefined
  const spend = record['spendTokens']
  if (spend !== null && typeof spend !== 'number') return undefined
  return {
    date: record['date'],
    ticketsOpened: record['ticketsOpened'] as number,
    ticketsClosed: record['ticketsClosed'] as number,
    checkpoints: record['checkpoints'] as number,
    breakthroughs: record['breakthroughs'] as number,
    memoryCandidates: record['memoryCandidates'] as number,
    memoryApproved: record['memoryApproved'] as number,
    spendTokens: spend,
    cronRuns: record['cronRuns'] as number,
  }
}

/**
 * Draw one glyph per value scaled over the series range; `null` draws a space.
 * @param values - the series, oldest first.
 * @returns the sparkline text.
 */
export function sparkline(values: readonly (number | null)[]): string {
  const known = values.filter((value): value is number => value !== null)
  const min = Math.min(...known)
  const max = Math.max(...known)
  return values.map((value) => {
    if (value === null) return ' '
    if (known.length === 1) return BARS[BARS.length - 1]
    if (max === min) return BARS[0]
    return BARS[Math.min(BARS.length - 1, Math.floor(((value - min) / (max - min)) * BARS.length))]
  }).join('')
}

/** Zero totals for a day without a report. */
function emptyTotals(date: string): DailyTotals {
  return {
    date, ticketsOpened: 0, ticketsClosed: 0, checkpoints: 0, breakthroughs: 0, memoryCandidates: 0, memoryApproved: 0,
    spendTokens: null, cronRuns: 0,
  }
}

/**
 * Line up daily totals against seven dates, filling the days without a
 * report with zeros, and sum the week.
 * @param dates - the seven dates, oldest first.
 * @param dailies - footers read from daily reports, in any order; dates outside the range are ignored.
 * @returns the per-day series, the week totals, and spend per outcome when both sides are known.
 */
export function aggregateWeek(dates: readonly string[], dailies: readonly DailyTotals[]): WeekSeries {
  const byDate = new Map(dailies.map(totals => [totals.date, totals]))
  const days: WeekDay[] = dates.map((date) => {
    const totals = byDate.get(date)
    return { date, reported: totals !== undefined, totals: totals ?? emptyTotals(date) }
  })
  const sum = (field: (typeof NUMERIC_FIELDS)[number]): number => days.reduce((acc, day) => acc + day.totals[field], 0)
  const spendKnown = days.filter(day => day.totals.spendTokens !== null)
  const spendTokens = spendKnown.length === 0 ? null : spendKnown.reduce((acc, day) => acc + (day.totals.spendTokens ?? 0), 0)
  const totals: DailyTotals = {
    date: `${dates[0] ?? ''}..${dates[dates.length - 1] ?? ''}`,
    ticketsOpened: sum('ticketsOpened'),
    ticketsClosed: sum('ticketsClosed'),
    checkpoints: sum('checkpoints'),
    breakthroughs: sum('breakthroughs'),
    memoryCandidates: sum('memoryCandidates'),
    memoryApproved: sum('memoryApproved'),
    spendTokens,
    cronRuns: sum('cronRuns'),
  }
  const outcomes = totals.ticketsClosed + totals.breakthroughs
  return {
    days,
    totals,
    reportedDays: days.filter(day => day.reported).length,
    ...spendTokens !== null && outcomes > 0 ? { spendPerOutcome: Math.round(spendTokens / outcomes) } : {},
  }
}

/**
 * Render the weekly review Markdown.
 * @param input - the aggregated week plus the live moved and open items.
 * @returns the report text.
 */
export function renderWeekly(input: WeeklyInput): string {
  const { series } = input
  const trend = (label: string, pick: (totals: DailyTotals) => number | null, total: number | null): string => {
    const values = series.days.map(day => day.reported ? pick(day.totals) : null)
    return `| ${label} | \`${sparkline(values)}\` | ${values.map(value => value === null ? '·' : String(value)).join(' ')} | ${total === null ? '—' : total} |`
  }
  const lines: string[] = [
    `# Hydra weekly review ${input.week}`,
    '',
    `${input.from} to ${input.to}; ${series.reportedDays} of ${series.days.length} days reported (spend from ${input.spendSource}).`,
    '',
    '## Trends',
    '',
    `| Series | Trend | ${series.days.map(day => day.date.slice(5)).join(' ')} | Week |`,
    '|---|---|---|---|',
    trend('Tickets opened', totals => totals.ticketsOpened, series.totals.ticketsOpened),
    trend('Tickets closed', totals => totals.ticketsClosed, series.totals.ticketsClosed),
    trend('Checkpoints', totals => totals.checkpoints, series.totals.checkpoints),
    trend('Breakthroughs', totals => totals.breakthroughs, series.totals.breakthroughs),
    trend('Memory approved', totals => totals.memoryApproved, series.totals.memoryApproved),
    trend('Spend tokens', totals => totals.spendTokens, series.totals.spendTokens),
    trend('Cron runs', totals => totals.cronRuns, series.totals.cronRuns),
    '',
    series.spendPerOutcome === undefined
      ? 'Spend per outcome: _not computable_ (needs recorded spend and at least one closed ticket or breakthrough).'
      : `Spend per outcome: ${series.spendPerOutcome} tokens per closed ticket or breakthrough (${series.totals.ticketsClosed} closed, ${series.totals.breakthroughs} breakthroughs).`,
    '',
    '## What moved',
    '',
  ]
  const { moved, stillOpen } = input
  if (moved.tickets.length === 0 && moved.breakthroughs.length === 0 && moved.goals.length === 0) lines.push('_nothing changed this week_')
  lines.push(...moved.tickets.map(ticket => `- ticket ${ticket.id} [${ticket.severity}] ${ticket.status} — ${ticket.title}`))
  lines.push(...moved.breakthroughs.map(entry => `- breakthrough: ${entry}`))
  lines.push(...moved.goals.map(goal => `- goal ${goal.phase}: ${goal.objective} (${goal.roundsStarted} rounds, session ${goal.sessionId})`))
  lines.push('', '## Still open', '')
  if (stillOpen.needsHuman.length === 0 && stillOpen.openHypotheses.length === 0) lines.push('_nothing waiting_')
  lines.push(...stillOpen.needsHuman.map(ticket => `- needs-human ${ticket.id} [${ticket.severity}] — ${ticket.title}`))
  lines.push(...stillOpen.openHypotheses.map(entry => `- hypotheses ${entry.slug}: ${entry.open} open`))
  lines.push('')
  return lines.join('\n')
}
