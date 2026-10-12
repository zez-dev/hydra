/**
 * The heatmap's calendar model: which local day sits in each column and row,
 * and how busy that day was.
 *
 * This MIRRORS the day grid `/usage` prints from `dsh-session-usage`'s
 * `renderUsageReport`. That renderer is a Host module and the client bundle may
 * not import a value from it, so the arithmetic is restated here and
 * `tests/grid.spec.ts` asserts the two agree cell for cell. Keep the two in
 * step: days advance through the date field, never through milliseconds, so a
 * daylight-saving transition cannot shift a column; and the intensity
 * thresholds are quarters of the busiest day in the window.
 */

import type { UsageDayValue } from '@deepseek-ai/dsh-api-remotes/client'

/** Days in the heatmap window, ending on the day it is drawn: one year. */
export const HEATMAP_SPAN_DAYS = 365

/** Intensity step of one cell, from no usage to the busiest quarter. */
export type HeatmapLevel = 0 | 1 | 2 | 3 | 4

/**
 * One square of the grid.
 *
 * A column always holds seven squares, so a day outside the window — before it
 * starts or after the day the grid is drawn — is a `padding` square that
 * occupies the row without standing for a date. A day inside the window that
 * recorded nothing is an ordinary `day` square at level 0; the report omits
 * such days entirely, and filling them back in is this module's job.
 */
export type HeatmapCell =
  | { readonly kind: 'padding' }
  | {
    readonly kind: 'day'
    /** Local calendar day, `YYYY-MM-DD`. */
    readonly day: string
    /** Billable tokens the Host summed for this day. */
    readonly tokens: number
    readonly level: HeatmapLevel
  }

/** One column: a calendar week, Sunday first. */
export interface HeatmapWeek {
  /** The column's Sunday, `YYYY-MM-DD`, whether or not it is inside the window. */
  readonly start: string
  /** Seven squares, Sunday first, matching `Date.getDay()`. */
  readonly cells: readonly HeatmapCell[]
  /** Zero-based month this column opens, absent when it opens no new month. */
  readonly monthLabel?: number
}

/** The whole grid and the figures its legend needs. */
export interface Heatmap {
  /** Columns oldest to newest. */
  readonly weeks: readonly HeatmapWeek[]
  /** First day of the window, `YYYY-MM-DD`. */
  readonly from: string
  /** Last day of the window, `YYYY-MM-DD`; the day the grid is drawn. */
  readonly to: string
  /** Billable tokens of the busiest day in the window, 0 when no day recorded any. */
  readonly busiest: number
  /** Billable tokens over the whole window. */
  readonly total: number
  /** Days in the window that recorded usage. */
  readonly activeDays: number
}

/**
 * The day `offset` days after `from`, by calendar arithmetic.
 *
 * Adding days to the date field rather than milliseconds to the instant keeps
 * every step one calendar day across a daylight-saving transition.
 * @param from - the starting day.
 * @param offset - whole days to add, which may be negative.
 * @returns the shifted local day.
 */
export function addDays(from: Date, offset: number): Date {
  return new Date(from.getFullYear(), from.getMonth(), from.getDate() + offset)
}

/**
 * The local calendar day one instant falls on.
 * @param date - the instant to place.
 * @returns the local day key, `YYYY-MM-DD`.
 */
export function dayKey(date: Date): string {
  const pad = (value: number): string => value.toString().padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * Pick the intensity step for one day against the window's busiest day.
 * @param tokens - the day's billable tokens.
 * @param busiest - billable tokens of the busiest day in the window.
 * @returns the intensity step.
 */
export function heatmapLevel(tokens: number, busiest: number): HeatmapLevel {
  if (tokens <= 0) return 0
  const share = tokens / busiest
  if (share <= 0.25) return 1
  if (share <= 0.5) return 2
  if (share <= 0.75) return 3
  return 4
}

/**
 * Build the heatmap for a window of days ending on `today`.
 *
 * Columns run from the Sunday on or before the first day of the window to the
 * Saturday on or after `today`, so the first and last columns are partial
 * unless the window happens to start on a Sunday or end on a Saturday. Days the
 * report omitted are filled in at zero, which is what makes an idle day read as
 * an empty square rather than a hole in the calendar.
 * @param days - the report's day series, ascending, with idle days omitted.
 * @param today - the local day the window ends on.
 * @param span - days in the window, including `today`.
 * @returns the grid and the figures its legend needs.
 */
export function buildHeatmap(
  days: readonly UsageDayValue[],
  today: Date,
  span: number = HEATMAP_SPAN_DAYS,
): Heatmap {
  const tokensByDay = new Map(days.map(day => [day.day, day.totals.totalTokens]))
  const windowStart = addDays(today, -(span - 1))
  const windowEnd = today
  const from = dayKey(windowStart)
  const to = dayKey(windowEnd)

  let busiest = 0
  let total = 0
  let activeDays = 0
  for (let cursor = windowStart; dayKey(cursor) <= to; cursor = addDays(cursor, 1)) {
    const tokens = tokensByDay.get(dayKey(cursor)) ?? 0
    if (tokens > 0) activeDays += 1
    total += tokens
    busiest = Math.max(busiest, tokens)
  }

  const weeks: HeatmapWeek[] = []
  const lastColumnStart = addDays(windowEnd, -windowEnd.getDay())
  const lastColumnKey = dayKey(lastColumnStart)
  let labelled: number | undefined
  for (
    let columnStart = addDays(windowStart, -windowStart.getDay());
    dayKey(columnStart) <= lastColumnKey;
    columnStart = addDays(columnStart, 7)
  ) {
    const cells: HeatmapCell[] = []
    let opens: number | undefined
    for (let weekday = 0; weekday < 7; weekday += 1) {
      const date = addDays(columnStart, weekday)
      const key = dayKey(date)
      if (key < from || key > to) {
        cells.push({ kind: 'padding' })
        continue
      }
      if (opens === undefined) opens = date.getMonth()
      const tokens = tokensByDay.get(key) ?? 0
      cells.push({ kind: 'day', day: key, tokens, level: heatmapLevel(tokens, busiest) })
    }
    // A column is labelled with the month it opens, and only when that month
    // is not the one the previous label already named.
    const monthLabel = opens !== undefined && opens !== labelled ? opens : undefined
    if (monthLabel !== undefined) labelled = monthLabel
    weeks.push({ start: dayKey(columnStart), cells, ...monthLabel === undefined ? {} : { monthLabel } })
  }
  return { weeks, from, to, busiest, total, activeDays }
}
