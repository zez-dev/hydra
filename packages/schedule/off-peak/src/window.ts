/**
 * Local-time off-peak window arithmetic. A window is a pair of wall-clock
 * times; `start` later than `end` wraps past midnight. Every function here is
 * pure so the drainer's timing is testable against a fixed clock.
 * @module
 */

import type { OffPeakWindow, ParsedWindow } from './types.ts'

/**
 * Parse one `HH:MM` wall-clock time.
 * @param text - the configured time.
 * @returns minutes since local midnight.
 * @throws when the text is not a zero-padded 24-hour time.
 */
function parseTime(text: string): number {
  const match = /^(?<hour>[01]\d|2[0-3]):(?<minute>[0-5]\d)$/.exec(text)
  const hour = match?.groups?.hour
  const minute = match?.groups?.minute
  if (hour === undefined || minute === undefined) {
    throw new Error(`off-peak: "${text}" is not a zero-padded 24-hour HH:MM time`)
  }
  return Number(hour) * 60 + Number(minute)
}

/**
 * Validate configured windows once, at activation.
 * @param windows - the configured wall-clock pairs.
 * @returns each window's local-time minute bounds, in configuration order.
 * @throws when a time is malformed or a window covers no time at all.
 */
export function parseWindows(windows: readonly OffPeakWindow[]): ParsedWindow[] {
  return windows.map((window) => {
    const startMinute = parseTime(window.start)
    const endMinute = parseTime(window.end)
    if (startMinute === endMinute) {
      throw new Error(`off-peak: window ${window.start}-${window.end} is empty; a window needs a start before or after its end`)
    }
    return { startMinute, endMinute }
  })
}

/**
 * Minutes since local midnight for one instant.
 * @param at - the instant.
 * @returns the wall-clock minute of the day.
 */
function minuteOfDay(at: Date): number {
  return at.getHours() * 60 + at.getMinutes()
}

/**
 * Whether one window covers a wall-clock minute, wrapping past midnight when
 * its start is later than its end.
 * @param window - the parsed bounds.
 * @param minute - minutes since local midnight.
 * @returns true when the minute lies inside the window.
 */
function covers(window: ParsedWindow, minute: number): boolean {
  return window.startMinute < window.endMinute
    ? minute >= window.startMinute && minute < window.endMinute
    : minute >= window.startMinute || minute < window.endMinute
}

/**
 * Whether any configured window is open.
 * @param windows - the parsed windows.
 * @param at - the instant to test.
 * @returns true while at least one window covers the instant; false when none is configured.
 */
export function inWindow(windows: readonly ParsedWindow[], at: Date): boolean {
  const minute = minuteOfDay(at)
  return windows.some(window => covers(window, minute))
}

/**
 * Build a local-time instant on the same or following day.
 * @param from - the reference instant, supplying the calendar day.
 * @param minute - minutes since local midnight.
 * @param dayOffset - days to add to the reference day.
 * @returns the constructed instant, with seconds and milliseconds zeroed.
 */
function atMinute(from: Date, minute: number, dayOffset: number): Date {
  const built = new Date(from.getFullYear(), from.getMonth(), from.getDate() + dayOffset, 0, 0, 0, 0)
  built.setMinutes(minute)
  return built
}

/**
 * When the next window opens.
 * @param windows - the parsed windows.
 * @param at - the current instant.
 * @returns `at` itself while a window is open, the next opening instant otherwise,
 *   or `undefined` when no window is configured.
 */
export function nextOpen(windows: readonly ParsedWindow[], at: Date): Date | undefined {
  if (windows.length === 0) return undefined
  if (inWindow(windows, at)) return at
  const minute = minuteOfDay(at)
  let best: Date | undefined
  for (const window of windows) {
    const sameDay = window.startMinute > minute
    const candidate = atMinute(at, window.startMinute, sameDay ? 0 : 1)
    if (best === undefined || candidate.getTime() < best.getTime()) best = candidate
  }
  return best
}

/**
 * When the currently open window closes.
 * @param windows - the parsed windows.
 * @param at - the current instant.
 * @returns the closing instant of the open window, or `undefined` when none is open.
 */
export function nextClose(windows: readonly ParsedWindow[], at: Date): Date | undefined {
  const minute = minuteOfDay(at)
  let best: Date | undefined
  for (const window of windows) {
    if (!covers(window, minute)) continue
    // A wrapping window entered before midnight closes on the following day.
    const nextDay = window.startMinute > window.endMinute && minute >= window.startMinute
    const candidate = atMinute(at, window.endMinute, nextDay ? 1 : 0)
    if (best === undefined || candidate.getTime() < best.getTime()) best = candidate
  }
  return best
}
