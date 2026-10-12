import { describe, expect, it, vi } from 'vitest'
import { isAllowed, MarketDataError, Transport } from '@deepseek-ai/dsh-market-data'
import type { FetchLike, TransportLimits } from '@deepseek-ai/dsh-market-data'

const LIMITS: TransportLimits = { timeoutMs: 1000, cacheTtlMs: 5000, minRequestGapMs: 0, maxBodyBytes: 1024 }
const STOOQ = 'https://stooq.com/q/d/l/?s=aapl.us&i=d'

/** A fetch stub answering every call with one body, counting its calls. */
function stubFetch(body: string, status = 200): { fetch: FetchLike; calls: () => number } {
  let calls = 0
  const fetch: FetchLike = async () => {
    calls += 1
    return { ok: status >= 200 && status < 300, status, text: async () => body }
  }
  return { fetch, calls: () => calls }
}

describe('host allowlist', () => {
  it('admits the two sources over https and nothing else', () => {
    expect(isAllowed(STOOQ)).toBe(true)
    expect(isAllowed('https://data.sec.gov/submissions/CIK0000320193.json')).toBe(true)
    expect(isAllowed('https://evil.example/q')).toBe(false)
    expect(isAllowed('http://stooq.com/q')).toBe(false)
    expect(isAllowed('not a url')).toBe(false)
  })

  it('refuses a disallowed host before any request is made', async () => {
    const stub = stubFetch('never')
    const transport = new Transport(LIMITS, 'Test test@example.com', { fetch: stub.fetch })
    await expect(transport.text('https://evil.example/q')).rejects.toThrow(MarketDataError)
    expect(stub.calls()).toBe(0)
  })
})

describe('response cache', () => {
  it('serves a repeated URL from memory inside the TTL', async () => {
    const stub = stubFetch('body')
    let now = 0
    const transport = new Transport(LIMITS, 'Test test@example.com', { fetch: stub.fetch, now: () => now })
    expect(await transport.text(STOOQ)).toBe('body')
    now = 4999
    expect(await transport.text(STOOQ)).toBe('body')
    expect(stub.calls()).toBe(1)
  })

  it('asks the source again once the TTL has passed', async () => {
    const stub = stubFetch('body')
    let now = 0
    const transport = new Transport(LIMITS, 'Test test@example.com', { fetch: stub.fetch, now: () => now })
    await transport.text(STOOQ)
    now = 5001
    await transport.text(STOOQ)
    expect(stub.calls()).toBe(2)
  })
})

describe('request pacing', () => {
  it('leaves the configured gap between two requests to one host', async () => {
    vi.useFakeTimers()
    try {
      const stub = stubFetch('body')
      let now = 0
      const paced = new Transport({ ...LIMITS, cacheTtlMs: 0, minRequestGapMs: 100 }, 'Test test@example.com', {
        fetch: stub.fetch,
        now: () => now,
      })
      const first = paced.text(STOOQ)
      await vi.advanceTimersByTimeAsync(0)
      expect(stub.calls()).toBe(1)
      now = 10
      const second = paced.text(STOOQ)
      await vi.advanceTimersByTimeAsync(0)
      expect(stub.calls()).toBe(1)
      await vi.advanceTimersByTimeAsync(90)
      await Promise.all([first, second])
      expect(stub.calls()).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('failures', () => {
  it('reports a 404 as an unknown symbol', async () => {
    const stub = stubFetch('', 404)
    const transport = new Transport(LIMITS, 'Test test@example.com', { fetch: stub.fetch })
    await expect(transport.text(STOOQ)).rejects.toMatchObject({ code: 'MARKET_SYMBOL_UNKNOWN' })
  })

  it('reports any other non-2xx as a refusal', async () => {
    const stub = stubFetch('', 429)
    const transport = new Transport(LIMITS, 'Test test@example.com', { fetch: stub.fetch })
    await expect(transport.text(STOOQ)).rejects.toMatchObject({ code: 'MARKET_SOURCE_REFUSED' })
  })

  it('reports a source that never answers as a timeout', async () => {
    const fetch: FetchLike = (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
    })
    const transport = new Transport({ ...LIMITS, timeoutMs: 5 }, 'Test test@example.com', { fetch })
    await expect(transport.text(STOOQ)).rejects.toMatchObject({ code: 'MARKET_SOURCE_TIMEOUT' })
  })

  it('refuses a body larger than the configured cap', async () => {
    const stub = stubFetch('x'.repeat(2048))
    const transport = new Transport(LIMITS, 'Test test@example.com', { fetch: stub.fetch })
    await expect(transport.text(STOOQ)).rejects.toMatchObject({ code: 'MARKET_SOURCE_UNREADABLE' })
  })

  it('names only the host, never the full URL with its query', async () => {
    const stub = stubFetch('', 500)
    const transport = new Transport(LIMITS, 'Test test@example.com', { fetch: stub.fetch })
    await expect(transport.text(STOOQ)).rejects.toThrow(/stooq\.com/)
    await expect(transport.text(STOOQ)).rejects.not.toThrow(/aapl\.us/)
  })

  it('declares the configured contact as the User-Agent', async () => {
    let seen: Record<string, string> | undefined
    const fetch: FetchLike = async (_url, init) => {
      seen = init.headers
      return { ok: true, status: 200, text: async () => 'body' }
    }
    const transport = new Transport(LIMITS, 'Jane Roe jane@example.com', { fetch })
    await transport.text(STOOQ)
    expect(seen?.['User-Agent']).toBe('Jane Roe jane@example.com')
  })
})
