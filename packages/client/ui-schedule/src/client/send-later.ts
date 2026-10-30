/**
 * Send later timing, the creation request a scheduled draft sends, and the
 * reasons a draft cannot be scheduled.
 *
 * "In 5 hours" is an elapsed delay. "Tomorrow" and "In 2 days" keep the
 * current wall-clock minute on a later calendar day of one zone, so a
 * daylight-saving change in between lengthens or shortens the delay instead of
 * moving the clock time. A custom choice sends its local date and time with
 * the zone, and the Host resolves them.
 */
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { InputState } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {
  AtInput, ScheduleCreateRequest, ScheduleCreateResult, ScheduleRecord,
} from '@deepseek-ai/dsh-schedule/client'
import { TITLE_MAX_LENGTH, zoneOffset } from './schedule-format.ts'
import { timingError, zonedWallClock } from './task-timing.ts'
import type { TaskManagerKey } from './task-manager-locales.ts'

/** Presets in menu order. */
export const SEND_LATER_PRESETS = ['hours5', 'tomorrow', 'days2'] as const

/** One preset the menu offers. */
export type SendLaterPreset = typeof SEND_LATER_PRESETS[number]

/** Delay of the "In 5 hours" preset, in seconds. */
const HOURS5_SECONDS = 5 * 60 * 60

/** Calendar days each wall-clock preset moves forward. */
const PRESET_DAYS = { tomorrow: 1, days2: 2 } as const satisfies Record<Exclude<SendLaterPreset, 'hours5'>, number>

const DAY_MS = 86_400_000
const MINUTE_MS = 60_000

/** Timing selector of one creation request. */
export type SendLaterTiming = { readonly after_seconds: number } | { readonly at: AtInput }

/** One preset resolved against a clock reading. */
export interface PresetTarget {
  /** Selector the creation request carries. */
  readonly timing: SendLaterTiming
  /** Epoch milliseconds the selector names. */
  readonly at: number
}

/** A local calendar date and whole-second clock time. */
export interface LocalDateTime {
  /** ISO calendar date. */
  readonly date: string
  /** `HH:MM:SS` clock time. */
  readonly time: string
}

/**
 * The instant one local date and time names in one zone.
 *
 * A time an overlap repeats names its earlier instant, and a time a gap skips
 * moves forward by the gap's length, so every local time names one instant.
 * A zone the runtime cannot resolve counts as UTC.
 * @param date - ISO calendar date.
 * @param time - `HH:MM:SS` clock time.
 * @param zone - IANA zone the fields are read in.
 * @returns epoch milliseconds.
 */
export function zonedInstant(date: string, time: string, zone: string): number {
  const local = Date.parse(`${date}T${time}Z`)
  const offset = (at: number): number => (zoneOffset(zone, at) ?? 0) * MINUTE_MS
  // Offset changes are far more than a day apart, so the offsets one day
  // before and after the local time are the only two it can resolve with.
  const before = offset(local - DAY_MS)
  const candidates = [local - before, local - offset(local + DAY_MS)]
    .filter(instant => instant + offset(instant) === local)
  // No candidate reproduces a time inside a gap; the offset in force before
  // the gap places it after the gap instead.
  return candidates.length === 0 ? local - before : Math.min(...candidates)
}

/**
 * The current wall-clock minute some calendar days later, in one zone.
 * @param now - clock reading in epoch milliseconds.
 * @param zone - IANA zone the wall clock is read in; an unresolvable zone counts as UTC.
 * @param days - calendar days to move forward.
 * @returns the later date and its time with seconds set to zero.
 */
function laterWallClock(now: number, zone: string, days: number): LocalDateTime {
  const instant = new Date(now).toISOString()
  const wall = zonedWallClock(instant, zone) || zonedWallClock(instant, 'UTC')
  const date = new Date(Date.parse(`${wall.slice(0, 10)}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10)
  return { date, time: `${wall.slice(11, 16)}:00` }
}

/**
 * Resolve one preset against a clock reading.
 * @param preset - menu preset.
 * @param now - clock reading in epoch milliseconds.
 * @param zone - IANA zone of the wall-clock presets; an unresolvable zone counts as UTC.
 * @returns the delay or absolute instant to send, and the instant it names.
 */
export function presetTarget(preset: SendLaterPreset, now: number, zone: string): PresetTarget {
  if (preset === 'hours5') return { timing: { after_seconds: HOURS5_SECONDS }, at: now + HOURS5_SECONDS * 1_000 }
  const later = laterWallClock(now, zone, PRESET_DAYS[preset])
  const at = zonedInstant(later.date, later.time, zone)
  return { timing: { at: new Date(at).toISOString() }, at }
}

/**
 * Date and time a custom choice starts from: the "Tomorrow" preset's.
 * @param now - clock reading in epoch milliseconds.
 * @param zone - IANA zone the fields are read in; an unresolvable zone counts as UTC.
 * @returns tomorrow's date with the current wall-clock minute.
 */
export function customDefaults(now: number, zone: string): LocalDateTime {
  return laterWallClock(now, zone, PRESET_DAYS.tomorrow)
}

/**
 * Selector of a custom choice; the Host resolves the fields in the zone and
 * refuses a past or skipped local time.
 * @param local - chosen date and time.
 * @param zone - IANA zone the fields are read in.
 * @returns the local `at` selector.
 */
export function customTiming(local: LocalDateTime, zone: string): SendLaterTiming {
  return { at: { date: local.date, time: local.time, time_zone: zone } }
}

/**
 * Name one scheduled draft after its first line.
 *
 * Whitespace runs collapse to one space. A line longer than the Host's limit is
 * cut on a code-point boundary and ends with an ellipsis.
 * @param prompt - draft text with non-whitespace content.
 * @returns a trimmed title of at most {@link TITLE_MAX_LENGTH} UTF-16 code units.
 */
export function sendLaterTitle(prompt: string): string {
  const line = prompt.trim().replace(/\n[\s\S]*$/, '').replace(/\s+/g, ' ').trimEnd()
  if (line.length <= TITLE_MAX_LENGTH) return line
  let cut = ''
  for (const char of line) {
    if (cut.length + char.length > TITLE_MAX_LENGTH - 1) break
    cut += char
  }
  return `${cut.trimEnd()}…`
}

/**
 * The creation request one scheduled draft sends.
 * @param draft - composer text with non-whitespace content.
 * @param timing - preset or custom selector.
 * @returns the trimmed prompt, its title, and the selector.
 */
export function sendLaterRequest(draft: string, timing: SendLaterTiming): ScheduleCreateRequest {
  const prompt = draft.trim()
  return { prompt, title: sendLaterTitle(prompt), ...timing }
}

/** Why a draft with text cannot be scheduled. */
export type SendLaterBlock = 'blank' | 'busy' | 'command' | 'attachments' | 'references'

/** Composer and Session facts that decide whether a draft can be scheduled. */
export interface SendLaterDraft {
  /** Clipboard-text projection of the draft. */
  readonly draft: string
  /** Submit-plane phase of the composer. */
  readonly phase: InputState['phase']
  /** Draft attachments. */
  readonly attachments: number
  /** Reference chips in the draft. */
  readonly references: number
  /** Whether the Session has not started a turn. */
  readonly blank: boolean
}

/**
 * Decide whether a draft can be scheduled.
 *
 * A scheduled prompt is plain text. A command, an attachment, or a reference
 * chip has no faithful text form, so such a draft is refused rather than
 * scheduled as its clipboard text. A blank Session is refused because New
 * Session reuses it for the next conversation.
 * @param facts - composer and Session facts.
 * @returns the first reason the draft cannot be scheduled, or undefined when it can.
 */
export function sendLaterBlock(facts: SendLaterDraft): SendLaterBlock | undefined {
  if (facts.blank) return 'blank'
  if (facts.phase === 'adjudicating' || facts.phase === 'submitting' || facts.phase === 'sending') return 'busy'
  if (facts.phase === 'claimed' || facts.draft.trimStart().startsWith('/')) return 'command'
  if (facts.attachments > 0) return 'attachments'
  if (facts.references > 0) return 'references'
  return undefined
}

/** Settled creation: the stored record, or the copy that explains the failure. */
export type SendLaterOutcome = { readonly record: ScheduleRecord } | { readonly error: TaskManagerKey }

/**
 * Read one creation result.
 * @param result - Remote result of `schedule.create`.
 * @returns the stored record, the copy of a Host input refusal, or the copy of a failed call.
 */
export function sendLaterOutcome(result: RemoteResult<ScheduleCreateResult>): SendLaterOutcome {
  if (!result.ok) return { error: 'sendLater.failed' }
  if ('code' in result.value) return { error: timingError(result.value.code) }
  return { record: result.value }
}
