import { describe, expect, it } from 'vitest'
import {
  MarketDataError, parseFilings, parseProfile, parseStooqCsv, parseTickerMap, stooqUrl, submissionsUrl,
} from '@deepseek-ai/dsh-market-data'
import {
  EDGAR_SUBMISSIONS, EDGAR_TICKERS, STOOQ_AAPL, STOOQ_BLANK_VOLUME, STOOQ_EMPTY, STOOQ_MISSING,
} from './fixtures.ts'

describe('Stooq daily CSV', () => {
  it('reads sessions oldest first', () => {
    const bars = parseStooqCsv('AAPL', STOOQ_AAPL)
    expect(bars).toHaveLength(3)
    expect(bars[0]).toEqual({ date: '2026-09-15', open: 225.1, high: 227.4, low: 224.05, close: 226.8, volume: 41203100 })
    expect(bars.at(-1)?.date).toBe('2026-09-17')
  })

  it('treats a symbol the source does not carry as an unknown symbol', () => {
    expect(() => parseStooqCsv('NOPE', STOOQ_MISSING)).toThrow(MarketDataError)
    try {
      parseStooqCsv('NOPE', STOOQ_MISSING)
    } catch (error) {
      expect((error as MarketDataError).code).toBe('MARKET_SYMBOL_UNKNOWN')
    }
  })

  it('treats a header with no sessions as an unknown symbol', () => {
    try {
      parseStooqCsv('AAPL', STOOQ_EMPTY)
      expect.unreachable('an empty series must throw')
    } catch (error) {
      expect((error as MarketDataError).code).toBe('MARKET_SYMBOL_UNKNOWN')
    }
  })

  it('rejects a body that is not a daily series', () => {
    try {
      parseStooqCsv('AAPL', '<html>rate limited</html>')
      expect.unreachable('a non-series body must throw')
    } catch (error) {
      expect((error as MarketDataError).code).toBe('MARKET_SOURCE_UNREADABLE')
    }
  })

  it('keeps a bar whose volume column is blank, without inventing a volume', () => {
    const [bar] = parseStooqCsv('X', STOOQ_BLANK_VOLUME)
    expect(bar).toEqual({ date: '2026-09-17', open: 10, high: 10.5, low: 9.9, close: 10.25 })
  })

  it('qualifies a bare symbol as a US listing and leaves a qualified one alone', () => {
    expect(stooqUrl('AAPL')).toContain('s=aapl.us')
    expect(stooqUrl('bmw.de')).toContain('s=bmw.de')
  })
})

describe('EDGAR documents', () => {
  it('finds a symbol case-insensitively and zero-pads its CIK', () => {
    expect(parseTickerMap('aapl', EDGAR_TICKERS)).toEqual({ cik: '0000320193', name: 'Apple Inc.' })
  })

  it('reports no match rather than throwing for a symbol EDGAR does not list', () => {
    expect(parseTickerMap('BMW', EDGAR_TICKERS)).toBeUndefined()
  })

  it('rejects a ticker map that is not JSON', () => {
    try {
      parseTickerMap('AAPL', 'not json')
      expect.unreachable('a non-JSON map must throw')
    } catch (error) {
      expect((error as MarketDataError).code).toBe('MARKET_SOURCE_UNREADABLE')
    }
  })

  it('reads the issuer profile', () => {
    expect(parseProfile('AAPL', '0000320193', EDGAR_SUBMISSIONS)).toEqual({
      symbol: 'AAPL',
      cik: '0000320193',
      name: 'Apple Inc.',
      exchange: 'Nasdaq',
      sector: 'Electronic Computers',
    })
  })

  it('reads filings newest first, builds document URLs, and honours the cap', () => {
    const filings = parseFilings('0000320193', EDGAR_SUBMISSIONS, [], 2)
    expect(filings).toHaveLength(2)
    expect(filings[0]).toEqual({
      form: '10-Q',
      filedAt: '2026-08-01',
      reportDate: '2026-06-27',
      url: 'https://www.sec.gov/Archives/edgar/data/320193/000032019326000081/aapl-20260627.htm',
    })
  })

  it('filters by form and falls back to the index page when no document is named', () => {
    const [filing] = parseFilings('0000320193', EDGAR_SUBMISSIONS, ['10-k'], 10)
    expect(filing?.form).toBe('10-K')
    expect(filing?.url).toBe('https://www.sec.gov/Archives/edgar/data/320193/000032019326000062/0000320193-26-000062-index.htm')
  })

  it('returns nothing when the document carries no recent filings', () => {
    expect(parseFilings('0000320193', JSON.stringify({ name: 'X' }), [], 10)).toEqual([])
  })

  it('builds the submissions URL from a padded CIK', () => {
    expect(submissionsUrl('0000320193')).toBe('https://data.sec.gov/submissions/CIK0000320193.json')
  })
})
