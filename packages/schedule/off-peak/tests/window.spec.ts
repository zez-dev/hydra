import { describe, expect, it } from 'vitest'
import { inWindow, nextClose, nextOpen, parseWindows } from '@deepseek-ai/dsh-off-peak'

/** Local-time date builder so the expectations read as wall clock. */
function at(hour: number, minute: number, day = 10): Date {
  return new Date(2026, 8, day, hour, minute, 0, 0)
}

describe('parseWindows', () => {
  it('accepts HH:MM pairs and reports their local-time minute bounds', () => {
    expect(parseWindows([{ start: '00:30', end: '06:00' }])).toEqual([{ startMinute: 30, endMinute: 360 }])
  })

  it('rejects a malformed time, an out-of-range time, and an empty window', () => {
    expect(() => parseWindows([{ start: '24:00', end: '01:00' }])).toThrow(/24:00/)
    expect(() => parseWindows([{ start: '1:00', end: '02:00' }])).toThrow(/1:00/)
    expect(() => parseWindows([{ start: '02:00', end: '02:00' }])).toThrow(/empty/)
  })
})

describe('inWindow', () => {
  const plain = parseWindows([{ start: '01:00', end: '05:00' }])
  const wrapping = parseWindows([{ start: '22:30', end: '06:00' }])

  it('is true inside a plain window and false outside it', () => {
    expect(inWindow(plain, at(1, 0))).toBe(true)
    expect(inWindow(plain, at(3, 30))).toBe(true)
    expect(inWindow(plain, at(0, 59))).toBe(false)
    expect(inWindow(plain, at(5, 0))).toBe(false)
  })

  it('spans midnight when the window wraps', () => {
    expect(inWindow(wrapping, at(23, 0))).toBe(true)
    expect(inWindow(wrapping, at(0, 30))).toBe(true)
    expect(inWindow(wrapping, at(5, 59))).toBe(true)
    expect(inWindow(wrapping, at(6, 0))).toBe(false)
    expect(inWindow(wrapping, at(12, 0))).toBe(false)
  })

  it('is false when no window is configured', () => {
    expect(inWindow([], at(3, 0))).toBe(false)
  })
})

describe('nextOpen', () => {
  const plain = parseWindows([{ start: '01:00', end: '05:00' }])
  const wrapping = parseWindows([{ start: '22:30', end: '06:00' }])

  it('returns today when the window is still ahead', () => {
    expect(nextOpen(plain, at(0, 0))).toEqual(at(1, 0))
  })

  it('rolls to tomorrow once the window has passed', () => {
    expect(nextOpen(plain, at(6, 0))).toEqual(at(1, 0, 11))
  })

  it('returns the current instant while a window is open', () => {
    const now = at(2, 0)
    expect(nextOpen(plain, now)).toEqual(now)
    expect(nextOpen(wrapping, at(23, 0))).toEqual(at(23, 0))
  })

  it('picks the earliest of several windows in either configured order', () => {
    const morning = { start: '09:00', end: '10:00' }
    const afternoon = { start: '14:00', end: '15:00' }
    expect(nextOpen(parseWindows([afternoon, morning]), at(8, 0))).toEqual(at(9, 0))
    expect(nextOpen(parseWindows([morning, afternoon]), at(8, 0))).toEqual(at(9, 0))
  })

  it('is undefined when no window is configured', () => {
    expect(nextOpen([], at(3, 0))).toBeUndefined()
  })
})

describe('nextClose', () => {
  const plain = parseWindows([{ start: '01:00', end: '05:00' }])
  const wrapping = parseWindows([{ start: '22:30', end: '06:00' }])

  it('returns the end of the open window', () => {
    expect(nextClose(plain, at(2, 0))).toEqual(at(5, 0))
  })

  it('crosses midnight for a wrapping window', () => {
    expect(nextClose(wrapping, at(23, 0))).toEqual(at(6, 0, 11))
    expect(nextClose(wrapping, at(1, 0))).toEqual(at(6, 0))
  })

  it('is undefined when no window is open', () => {
    expect(nextClose(plain, at(12, 0))).toBeUndefined()
  })

  it('returns the earliest end among overlapping open windows in either configured order', () => {
    const early = { start: '01:00', end: '05:00' }
    const late = { start: '03:00', end: '06:00' }
    expect(nextClose(parseWindows([early, late]), at(4, 0))).toEqual(at(5, 0))
    expect(nextClose(parseWindows([late, early]), at(4, 0))).toEqual(at(5, 0))
  })
})
