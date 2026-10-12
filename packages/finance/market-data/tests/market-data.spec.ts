import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import MarketDataRuntime, { MarketDataError, StooqEdgarProvider, Transport } from '@deepseek-ai/dsh-market-data'
import type { FetchLike, MarketDataProvider, TransportLimits } from '@deepseek-ai/dsh-market-data'
import { EDGAR_SUBMISSIONS, EDGAR_TICKERS, STOOQ_AAPL } from './fixtures.ts'

const LIMITS: TransportLimits = { timeoutMs: 1000, cacheTtlMs: 0, minRequestGapMs: 0, maxBodyBytes: 1024 * 1024 }
const CONTACT = 'Jane Roe jane@example.com'

/** Route each allowed URL to its recorded body. */
const routes: FetchLike = async (url) => {
  const body = url.startsWith('https://stooq.com/') ? STOOQ_AAPL
    : url === 'https://www.sec.gov/files/company_tickers.json' ? EDGAR_TICKERS
      : url.startsWith('https://data.sec.gov/submissions/') ? EDGAR_SUBMISSIONS
        : undefined
  if (body === undefined) return { ok: false, status: 404, text: async () => '' }
  return { ok: true, status: 200, text: async () => body }
}

function provider(fetch: FetchLike = routes): StooqEdgarProvider {
  return new StooqEdgarProvider(new Transport(LIMITS, CONTACT, { fetch }))
}

describe('the keyless provider', () => {
  it('quotes the last settled close with its change from the prior session', async () => {
    const [quote] = await provider().quote(['AAPL'])
    expect(quote).toEqual({
      symbol: 'AAPL',
      close: 230.1,
      asOf: '2026-09-17',
      change: 0.75,
      changePercent: 0.33,
    })
  })

  it('returns the whole series untruncated when no cap is given', async () => {
    const history = await provider().history('AAPL', {})
    expect(history.bars).toHaveLength(3)
    expect(history.truncated).toBe(false)
  })

  it('keeps the newest bars and flags truncation when capped', async () => {
    const history = await provider().history('AAPL', { limit: 2 })
    expect(history.bars.map(bar => bar.date)).toEqual(['2026-09-16', '2026-09-17'])
    expect(history.truncated).toBe(true)
  })

  it('filters the series to the requested window', async () => {
    const history = await provider().history('AAPL', { from: '2026-09-16', to: '2026-09-16' })
    expect(history.bars.map(bar => bar.date)).toEqual(['2026-09-16'])
  })

  it('reads the issuer profile and its filings through EDGAR', async () => {
    expect(await provider().profile('AAPL')).toMatchObject({ name: 'Apple Inc.', exchange: 'Nasdaq', cik: '0000320193' })
    const filings = await provider().filings('AAPL', { forms: ['10-K'], limit: 5 })
    expect(filings).toHaveLength(1)
    expect(filings[0]?.form).toBe('10-K')
  })

  it('reports a symbol EDGAR does not list as an unknown symbol', async () => {
    await expect(provider().profile('BMW')).rejects.toMatchObject({ code: 'MARKET_SYMBOL_UNKNOWN' })
  })
})

describe('the seam', () => {
  it('refuses to activate without a declared SEC contact', async () => {
    const ctx = new Context()
    await expect(ctx.plugin(MarketDataRuntime, { secUserAgent: '   ' }).await()).rejects.toThrow(/secUserAgent/)
  })

  it('serves quotes through the built-in provider it mounts', async () => {
    const ctx = new Context()
    await ctx.plugin(MarketDataRuntime, {
      secUserAgent: CONTACT, timeoutMs: 1000, cacheTtlMs: 0, minRequestGapMs: 0,
      maxBodyBytes: 1024 * 1024, builtinProvider: true,
    }).await()
    ctx.marketData.internals = { fetch: routes }
    const [quote] = await ctx.marketData.quote(['AAPL'])
    expect(quote?.close).toBe(230.1)
  })

  it('reports no usable provider when the built-in one is not mounted', async () => {
    const ctx = new Context()
    await ctx.plugin(MarketDataRuntime, {
      secUserAgent: CONTACT, timeoutMs: 1000, cacheTtlMs: 0, minRequestGapMs: 0,
      maxBodyBytes: 1024 * 1024, builtinProvider: false,
    }).await()
    await expect(ctx.marketData.quote(['AAPL'])).rejects.toMatchObject({ code: 'MARKET_PROVIDER_UNAVAILABLE' })
  })

  it('refuses to choose between two usable providers', async () => {
    const ctx = new Context()
    await ctx.plugin(MarketDataRuntime, {
      secUserAgent: CONTACT, timeoutMs: 1000, cacheTtlMs: 0, minRequestGapMs: 0,
      maxBodyBytes: 1024 * 1024, builtinProvider: true,
    }).await()
    ctx.marketData.internals = { fetch: routes }
    ctx.marketData.register(stubProvider('other'))
    await expect(ctx.marketData.quote(['AAPL'])).rejects.toMatchObject({ code: 'MARKET_PROVIDER_AMBIGUOUS' })
  })

  it('uses the configured provider when one is named', async () => {
    const ctx = new Context()
    await ctx.plugin(MarketDataRuntime, {
      secUserAgent: CONTACT, timeoutMs: 1000, cacheTtlMs: 0, minRequestGapMs: 0,
      maxBodyBytes: 1024 * 1024, builtinProvider: true, provider: 'other',
    }).await()
    ctx.marketData.internals = { fetch: routes }
    ctx.marketData.register(stubProvider('other'))
    const [quote] = await ctx.marketData.quote(['ZZZ'])
    expect(quote?.symbol).toBe('stub')
  })

  it('unregisters a provider through the disposer it returned', async () => {
    const ctx = new Context()
    await ctx.plugin(MarketDataRuntime, {
      secUserAgent: CONTACT, timeoutMs: 1000, cacheTtlMs: 0, minRequestGapMs: 0,
      maxBodyBytes: 1024 * 1024, builtinProvider: false,
    }).await()
    const dispose = ctx.marketData.register(stubProvider('only'))
    expect((await ctx.marketData.quote(['ZZZ']))[0]?.symbol).toBe('stub')
    dispose()
    await expect(ctx.marketData.quote(['ZZZ'])).rejects.toMatchObject({ code: 'MARKET_PROVIDER_UNAVAILABLE' })
    expect(() => ctx.marketData.register(stubProvider('only'))).not.toThrow()
  })

  it('rejects a second provider registered under one id', async () => {
    const ctx = new Context()
    await ctx.plugin(MarketDataRuntime, {
      secUserAgent: CONTACT, timeoutMs: 1000, cacheTtlMs: 0, minRequestGapMs: 0,
      maxBodyBytes: 1024 * 1024, builtinProvider: false,
    }).await()
    ctx.marketData.register(stubProvider('dup'))
    expect(() => ctx.marketData.register(stubProvider('dup'))).toThrow(/already registered/)
  })
})

/** A provider that answers with a fixed quote, for selection tests. */
function stubProvider(id: string): MarketDataProvider {
  return {
    id,
    available: () => true,
    quote: async () => [{ symbol: 'stub', close: 1, asOf: '2026-09-17' }],
    history: async () => ({ symbol: 'stub', bars: [], truncated: false }),
    profile: async () => ({ symbol: 'stub' }),
    filings: async () => { throw new MarketDataError('no filings', 'MARKET_UNSUPPORTED') },
  }
}
