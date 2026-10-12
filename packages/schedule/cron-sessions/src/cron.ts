/**
 * Five-field cron matching (`minute hour day-of-month month day-of-week`)
 * evaluated against local time. Supports `*`, lists, ranges, and `/step` on
 * every field; day-of-week uses 0-6 with 0 = Sunday. When both day fields are
 * restricted, a date matches when either does, as classic cron does.
 * @module
 */

import type { ParsedCron } from './types.ts'

/** Inclusive bounds of each field, in expression order. */
const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day of week', min: 0, max: 6 },
] as const

function parseInteger(text: string, field: string): number {
  if (!/^\d+$/.test(text)) throw new Error(`cron ${field}: "${text}" is not a number`)
  return Number(text)
}

type CronField = (typeof FIELDS)[number]

function parseField(expression: string, field: CronField): { restricted: boolean; values: Set<number> } {
  const values = new Set<number>()
  let restricted = false
  for (const part of expression.split(',')) {
    const [rangeText, stepText] = part.split('/')
    if (rangeText === undefined || rangeText.length === 0) throw new Error(`cron ${field.name}: empty term in "${expression}"`)
    const step = stepText === undefined ? 1 : parseInteger(stepText, field.name)
    if (step < 1) throw new Error(`cron ${field.name}: step must be at least 1`)
    let low: number
    let high: number
    if (rangeText === '*') {
      low = field.min
      high = field.max
      if (stepText !== undefined) restricted = true
    } else {
      restricted = true
      const [fromText = '', toText] = rangeText.split('-')
      low = parseInteger(fromText, field.name)
      high = toText === undefined ? (stepText === undefined ? low : field.max) : parseInteger(toText, field.name)
    }
    if (low < field.min || high > field.max || low > high) {
      throw new Error(`cron ${field.name}: "${part}" is outside ${field.min}-${field.max}`)
    }
    for (let value = low; value <= high; value += step) values.add(value)
  }
  return { restricted, values }
}

/**
 * Parse a five-field cron expression.
 * @param expression - whitespace-separated `minute hour dom month dow`.
 * @returns the parsed matcher.
 * @throws when the expression does not have five fields or a field is out of range.
 */
export function parseCron(expression: string): ParsedCron {
  const parts = expression.trim().split(/\s+/)
  if (parts.length !== 5 || parts[0] === '') throw new Error(`cron expression needs five fields, got "${expression}"`)
  const [minuteText, hourText, domText, monthText, dowText] = parts as [string, string, string, string, string]
  const minute = parseField(minuteText, FIELDS[0])
  const hour = parseField(hourText, FIELDS[1])
  const dom = parseField(domText, FIELDS[2])
  const month = parseField(monthText, FIELDS[3])
  const dow = parseField(dowText, FIELDS[4])
  return {
    expression: parts.join(' '),
    minutes: minute.values,
    hours: hour.values,
    daysOfMonth: dom.values,
    months: month.values,
    daysOfWeek: dow.values,
    domRestricted: dom.restricted,
    dowRestricted: dow.restricted,
  }
}

/**
 * Whether the parsed expression matches the local minute of `date`.
 * @param cron - a parsed expression.
 * @param date - the instant to test; seconds are ignored.
 * @returns true when every field admits the date.
 */
export function cronMatches(cron: ParsedCron, date: Date): boolean {
  if (!cron.minutes.has(date.getMinutes())) return false
  if (!cron.hours.has(date.getHours())) return false
  if (!cron.months.has(date.getMonth() + 1)) return false
  const domOk = cron.daysOfMonth.has(date.getDate())
  const dowOk = cron.daysOfWeek.has(date.getDay())
  if (cron.domRestricted && cron.dowRestricted) return domOk || dowOk
  return domOk && dowOk
}

/**
 * Whether a schedule should run at `now`: its expression matches this minute
 * and the last run did not already start in this minute.
 * @param cron - a parsed expression.
 * @param now - the current instant.
 * @param lastRunAt - epoch milliseconds of the last run start, or `undefined`.
 * @returns true when a run is due.
 */
export function isDue(cron: ParsedCron, now: Date, lastRunAt: number | undefined): boolean {
  if (!cronMatches(cron, now)) return false
  if (lastRunAt === undefined) return true
  return Math.floor(lastRunAt / 60_000) !== Math.floor(now.getTime() / 60_000)
}
