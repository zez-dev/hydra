import { describe, expect, it } from 'vitest'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import type { ScheduleRecord } from '@deepseek-ai/dsh-schedule/client'
import { ScheduleId } from '@deepseek-ai/dsh-schedule'
import {
  customDefaults, customTiming, presetTarget, sendLaterBlock, sendLaterOutcome, sendLaterRequest, sendLaterTitle,
  zonedInstant, type SendLaterDraft,
} from '../src/client/send-later.ts'

const HOUR_MS = 3_600_000
const NEW_YORK = 'America/New_York'

/** ISO target of one preset, for readable assertions. */
function presetAt(preset: Parameters<typeof presetTarget>[0], now: string, zone: string): string {
  return new Date(presetTarget(preset, Date.parse(now), zone).at).toISOString()
}

describe('presetTarget', () => {
  it('sends "In 5 hours" as an elapsed delay, whatever the zone', () => {
    const now = Date.parse('2026-10-31T18:32:00.000Z')
    for (const zone of ['UTC', NEW_YORK, 'Asia/Tokyo']) {
      expect(presetTarget('hours5', now, zone)).toEqual({ timing: { after_seconds: 18_000 }, at: now + 5 * HOUR_MS })
    }
  })

  it('keeps the current wall-clock minute on the next calendar days and sends that instant', () => {
    const now = Date.parse('2026-10-31T14:32:45.123Z')
    expect(presetTarget('tomorrow', now, 'UTC')).toEqual({
      timing: { at: '2026-11-01T14:32:00.000Z' }, at: Date.parse('2026-11-01T14:32:00.000Z'),
    })
    expect(presetAt('days2', '2026-10-31T14:32:45.123Z', 'UTC')).toBe('2026-11-02T14:32:00.000Z')
  })

  it('reads the calendar day in the chosen zone, not in UTC', () => {
    // 23:30 UTC on October 31 is already 08:30 on November 1 in Tokyo and 05:00 in Kolkata.
    expect(presetAt('tomorrow', '2026-10-31T23:30:10.000Z', 'Asia/Tokyo')).toBe('2026-11-01T23:30:00.000Z')
    expect(presetAt('days2', '2026-10-31T23:30:10.000Z', 'Asia/Tokyo')).toBe('2026-11-02T23:30:00.000Z')
    expect(presetAt('tomorrow', '2026-10-31T23:30:10.000Z', 'Asia/Kolkata')).toBe('2026-11-01T23:30:00.000Z')
    expect(presetAt('tomorrow', '2026-10-31T23:30:10.000Z', NEW_YORK)).toBe('2026-11-02T00:30:00.000Z')
  })

  it('keeps the clock time across a daylight-saving change, so the delay is 25 or 23 hours', () => {
    // New York leaves daylight time on 2026-11-01 and enters it on 2026-03-08.
    const autumn = Date.parse('2026-10-31T18:32:00.000Z')
    expect(presetTarget('tomorrow', autumn, NEW_YORK).at - autumn).toBe(25 * HOUR_MS)
    expect(presetAt('days2', '2026-10-31T18:32:00.000Z', NEW_YORK)).toBe('2026-11-02T19:32:00.000Z')
    const spring = Date.parse('2026-03-07T19:32:00.000Z')
    expect(presetTarget('tomorrow', spring, NEW_YORK).at - spring).toBe(23 * HOUR_MS)
  })

  it('moves a clock time the change skips forward, and takes the earlier of a repeated one', () => {
    // 02:30 on 2026-03-08 does not exist in New York; 01:30 on 2026-11-01 happens twice.
    expect(presetAt('tomorrow', '2026-03-07T07:30:00.000Z', NEW_YORK)).toBe('2026-03-08T07:30:00.000Z')
    expect(presetAt('tomorrow', '2026-10-31T05:30:00.000Z', NEW_YORK)).toBe('2026-11-01T05:30:00.000Z')
  })

  it('counts a zone the runtime cannot resolve as UTC', () => {
    expect(presetAt('tomorrow', '2026-10-31T14:32:45.123Z', 'Not/A_Zone')).toBe('2026-11-01T14:32:00.000Z')
  })
})

describe('zonedInstant', () => {
  it('names one instant for every local time', () => {
    expect(new Date(zonedInstant('2026-09-17', '09:30:00', NEW_YORK)).toISOString()).toBe('2026-09-17T13:30:00.000Z')
    // On the change day itself, either side of the change resolves with its own offset.
    expect(new Date(zonedInstant('2026-03-08', '01:00:00', NEW_YORK)).toISOString()).toBe('2026-03-08T06:00:00.000Z')
    expect(new Date(zonedInstant('2026-03-08', '05:00:00', NEW_YORK)).toISOString()).toBe('2026-03-08T09:00:00.000Z')
    expect(new Date(zonedInstant('2026-03-08', '02:30:00', NEW_YORK)).toISOString()).toBe('2026-03-08T07:30:00.000Z')
    expect(new Date(zonedInstant('2026-11-01', '01:30:00', NEW_YORK)).toISOString()).toBe('2026-11-01T05:30:00.000Z')
    expect(new Date(zonedInstant('2026-11-01', '01:30:00', 'Not/A_Zone')).toISOString()).toBe('2026-11-01T01:30:00.000Z')
  })
})

describe('custom choice', () => {
  it('starts from the "Tomorrow" date and minute, and sends local fields with their zone', () => {
    const local = customDefaults(Date.parse('2026-10-31T23:30:10.000Z'), 'Asia/Tokyo')
    expect(local).toEqual({ date: '2026-11-02', time: '08:30:00' })
    expect(customTiming(local, 'Asia/Tokyo')).toEqual({ at: { date: '2026-11-02', time: '08:30:00', time_zone: 'Asia/Tokyo' } })
  })
})

describe('sendLaterTitle', () => {
  it('names the task after the first line, with whitespace runs collapsed', () => {
    expect(sendLaterTitle('Summarize the open pull requests')).toBe('Summarize the open pull requests')
    expect(sendLaterTitle('\n\n  Review   the\tlogs  \nthen report back')).toBe('Review the logs')
  })

  it('keeps a 120-unit line and cuts a longer one to 119 units and an ellipsis', () => {
    expect(sendLaterTitle('x'.repeat(120))).toBe('x'.repeat(120))
    expect(sendLaterTitle('x'.repeat(121))).toBe(`${'x'.repeat(119)}…`)
    expect(sendLaterTitle('abcdef '.repeat(30))).toBe(`${'abcdef '.repeat(17).trimEnd()}…`)
  })

  it('cuts on a code-point boundary', () => {
    const title = sendLaterTitle(`${'x'.repeat(118)}😀 and more`)
    expect(title).toBe(`${'x'.repeat(118)}…`)
    expect(title.length).toBeLessThanOrEqual(120)
  })
})

describe('sendLaterRequest', () => {
  it('sends the trimmed draft, its title, and the selector', () => {
    expect(sendLaterRequest('  Do the thing\nwith details  ', { after_seconds: 18_000 })).toEqual({
      prompt: 'Do the thing\nwith details', title: 'Do the thing', after_seconds: 18_000,
    })
    expect(sendLaterRequest('Ship it', { at: '2026-11-01T14:32:00.000Z' })).toEqual({
      prompt: 'Ship it', title: 'Ship it', at: '2026-11-01T14:32:00.000Z',
    })
  })
})

describe('sendLaterBlock', () => {
  const ready: SendLaterDraft = { draft: 'Hello', phase: 'plain', attachments: 0, references: 0, blank: false }

  it('accepts a plain text draft', () => {
    expect(sendLaterBlock(ready)).toBeUndefined()
  })

  it('names the first reason a draft cannot be scheduled', () => {
    expect(sendLaterBlock({ ...ready, blank: true, attachments: 1 })).toBe('blank')
    for (const phase of ['adjudicating', 'submitting', 'sending'] as const) {
      expect(sendLaterBlock({ ...ready, phase })).toBe('busy')
    }
    expect(sendLaterBlock({ ...ready, phase: 'claimed', draft: '/goal ship it' })).toBe('command')
    expect(sendLaterBlock({ ...ready, draft: '  /compact' })).toBe('command')
    expect(sendLaterBlock({ ...ready, attachments: 1, references: 1 })).toBe('attachments')
    expect(sendLaterBlock({ ...ready, references: 2 })).toBe('references')
  })
})

describe('sendLaterOutcome', () => {
  it('returns the stored record, a Host refusal\'s copy, or the unknown-outcome copy', () => {
    const record: ScheduleRecord = {
      id: ScheduleId('schedule-1'), kind: 'after', title: 'Ship it', prompt: 'Ship it',
      afterSeconds: 18_000, scheduledAt: '2026-10-31T23:32:00.000Z',
    }
    expect(sendLaterOutcome({ ok: true, value: record })).toEqual({ record })
    expect(sendLaterOutcome({ ok: true, value: { code: 'not_future', message: 'past' } })).toEqual({ error: 'timing.notFuture' })
    expect(sendLaterOutcome({ ok: true, value: { code: 'subagent_session', message: 'child' } }))
      .toEqual({ error: 'timing.subagentSession' })
    expect(sendLaterOutcome({ ok: false, error: new RemoteError('gateway/internal', 'Unavailable', {}) }))
      .toEqual({ error: 'sendLater.failed' })
  })
})
