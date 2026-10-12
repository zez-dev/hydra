import { describe, expect, it } from 'vitest'
import { cronMatches, isDue, missedSince, parseCron } from '@deepseek-ai/dsh-cron-sessions'

/** Local-time date builder: year, month (1-12), day, hour, minute. */
function at(year: number, month: number, day: number, hour: number, minute: number): Date {
  return new Date(year, month - 1, day, hour, minute, 0, 0)
}

describe('parseCron', () => {
  it('accepts wildcards, lists, ranges, and steps in every field', () => {
    expect(() => parseCron('* * * * *')).not.toThrow()
    expect(() => parseCron('0,30 9-17 1-15/2 */3 1-5')).not.toThrow()
  })

  it.each([
    ['', 'five fields'],
    ['* * * *', 'five fields'],
    ['60 * * * *', 'minute'],
    ['* 24 * * *', 'hour'],
    ['* * 0 * *', 'day of month'],
    ['* * * 13 *', 'month'],
    ['* * * * 7', 'day of week'],
    ['*/0 * * * *', 'step'],
    ['a * * * *', 'minute'],
    ['1,,2 * * * *', 'empty term'],
  ])('rejects %j', (expression, fragment) => {
    expect(() => parseCron(expression)).toThrow(fragment)
  })
})

describe('cronMatches', () => {
  it.each([
    ['* * * * *', at(2026, 9, 20, 10, 15), true],
    ['15 10 * * *', at(2026, 9, 20, 10, 15), true],
    ['16 10 * * *', at(2026, 9, 20, 10, 15), false],
    ['*/15 * * * *', at(2026, 9, 20, 10, 30), true],
    ['*/15 * * * *', at(2026, 9, 20, 10, 31), false],
    ['0 9-17 * * *', at(2026, 9, 20, 17, 0), true],
    ['0 9-17 * * *', at(2026, 9, 20, 18, 0), false],
    // 2026-09-20 is a Sunday (0) and the 20th.
    ['0 0 * * 0', at(2026, 9, 20, 0, 0), true],
    ['0 0 * * 1-5', at(2026, 9, 20, 0, 0), false],
    ['0 0 20 9 *', at(2026, 9, 20, 0, 0), true],
    ['0 0 21 9 *', at(2026, 9, 20, 0, 0), false],
    ['0 0 1,20 * *', at(2026, 9, 20, 0, 0), true],
    ['0 0 20 10 *', at(2026, 9, 20, 0, 0), false],
    // A single start with a step runs to the end of the field: 5, 25, 45.
    ['5/20 * * * *', at(2026, 9, 20, 10, 45), true],
    ['5/20 * * * *', at(2026, 9, 20, 10, 50), false],
    // Both day fields restricted: either one admits the date.
    ['0 0 20 * 1', at(2026, 9, 20, 0, 0), true],
    ['0 0 1 * 0', at(2026, 9, 20, 0, 0), true],
    ['0 0 1 * 1', at(2026, 9, 20, 0, 0), false],
  ])('%s at %s -> %s', (expression, date, expected) => {
    expect(cronMatches(parseCron(expression), date)).toBe(expected)
  })
})

describe('isDue', () => {
  const schedule = parseCron('*/5 * * * *')

  it('is due on a matching minute that has not run yet', () => {
    expect(isDue(schedule, at(2026, 9, 20, 10, 5), undefined)).toBe(true)
  })

  it('is not due twice within the same minute', () => {
    const now = new Date(2026, 8, 20, 10, 5, 30, 0)
    expect(isDue(schedule, now, now.getTime() - 20_000)).toBe(false)
  })

  it('is not due on a non-matching minute', () => {
    expect(isDue(schedule, at(2026, 9, 20, 10, 6), undefined)).toBe(false)
  })

  it('is due again on the next matching minute', () => {
    expect(isDue(schedule, at(2026, 9, 20, 10, 10), at(2026, 9, 20, 10, 5).getTime())).toBe(true)
  })
})

describe('missedSince', () => {
  const nightly = parseCron('0 2 * * *')

  it('finds a matching minute between the last run and now', () => {
    expect(missedSince(nightly, at(2026, 9, 20, 1, 59).getTime(), at(2026, 9, 20, 3, 30))).toBe(true)
  })

  it('does not count the minute the last run started in', () => {
    expect(missedSince(nightly, at(2026, 9, 20, 2, 0).getTime(), at(2026, 9, 20, 3, 30))).toBe(false)
  })

  it('looks back no further than 24 hours', () => {
    const once = parseCron('0 2 20 9 *')
    expect(missedSince(once, at(2026, 9, 19, 0, 0).getTime(), at(2026, 9, 22, 12, 0))).toBe(false)
  })
})
