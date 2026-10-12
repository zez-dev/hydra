import { describe, expect, it } from 'vitest'
import { canonicalClientTimeZone, localDateKey } from '@deepseek-ai/dsh-util-time'

describe('canonicalClientTimeZone', () => {
  it('accepts UTC and Area/Location names unchanged', () => {
    expect(canonicalClientTimeZone('UTC')).toBe('UTC')
    expect(canonicalClientTimeZone('Asia/Shanghai')).toBe('Asia/Shanghai')
    expect(canonicalClientTimeZone('Europe/London')).toBe('Europe/London')
  })

  it('answers the platform-canonical name rather than the alias asked for', () => {
    // A durable record is compared against the zone a later reader derives, so
    // an alias must not survive the boundary. Which name each alias group
    // resolves to is the runtime's ICU data, not this library's choice.
    const canonical = canonicalClientTimeZone('Asia/Chongqing')
    expect(canonical).not.toBe('Asia/Chongqing')
    expect(canonicalClientTimeZone(canonical ?? '')).toBe(canonical)
  })

  it('refuses blank, padded, abbreviated, and single-segment names', () => {
    for (const value of ['', ' ', ' UTC', 'UTC ', 'CST', 'GMT+8', 'Asia', 'utc']) {
      expect(canonicalClientTimeZone(value)).toBeUndefined()
    }
  })

  it('refuses a well-formed name the platform does not support', () => {
    expect(canonicalClientTimeZone('Not/A_Real_Zone')).toBeUndefined()
  })
})

describe('localDateKey', () => {
  it('places an instant on its own local calendar day', () => {
    expect(localDateKey(new Date(2026, 8, 20, 23, 59))).toBe('2026-09-20')
    expect(localDateKey(new Date(2026, 0, 5, 0, 0))).toBe('2026-01-05')
  })

  it('zero-pads both fields, so keys sort as dates', () => {
    expect(localDateKey(new Date(2026, 0, 2, 12))).toBe('2026-01-02')
    const days = [new Date(2026, 9, 1, 12), new Date(2026, 0, 2, 12), new Date(2025, 11, 31, 12)]
    expect(days.map(localDateKey).sort()).toEqual(['2025-12-31', '2026-01-02', '2026-10-01'])
  })
})
