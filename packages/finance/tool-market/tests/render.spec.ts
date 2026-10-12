import { describe, expect, it } from 'vitest'
import { renderFilings, renderHistory, renderProfile, renderQuotes, renderSummary } from '@deepseek-ai/dsh-tool-market'
import type { Filing, History, MarketProfile, Quote } from '@deepseek-ai/dsh-market-data'

const QUOTE: Quote = { symbol: 'AAPL', close: 230.1, asOf: '2026-09-17', change: 0.75, changePercent: 0.33 }

const HISTORY: History = {
  symbol: 'AAPL',
  truncated: false,
  bars: [
    { date: '2026-09-16', open: 226.95, high: 229.8, low: 226.1, close: 229.35, volume: 38122400 },
    { date: '2026-09-17', open: 229.5, high: 231.2, low: 228.15, close: 230.1 },
  ],
}

const PROFILE: MarketProfile = { symbol: 'AAPL', name: 'Apple Inc.', exchange: 'Nasdaq', sector: 'Electronic Computers', cik: '0000320193' }

const FILING: Filing = { form: '10-K', filedAt: '2026-02-01', reportDate: '2025-12-27', url: 'https://www.sec.gov/x' }

describe('quotes', () => {
  it('shows the close, its signed change and the session date', () => {
    expect(renderQuotes([QUOTE])).toBe('AAPL 230.10 +0.75 (0.33%) as of 2026-09-17')
  })

  it('omits the change when the source had no prior session', () => {
    expect(renderQuotes([{ symbol: 'X', close: 1, asOf: '2026-09-17' }])).toBe('X 1.00 as of 2026-09-17')
  })

  it('says so plainly when no symbol was known', () => {
    expect(renderQuotes([])).toMatch(/No quotes/)
  })
})

describe('history', () => {
  it('renders a table with a header and one row per session', () => {
    const text = renderHistory(HISTORY)
    expect(text.split('\n')).toHaveLength(4)
    expect(text).toContain('AAPL: 2 sessions')
    expect(text).toContain('2026-09-17')
    expect(text).toContain('38122400')
  })

  it('says older sessions were omitted when the series was capped', () => {
    expect(renderHistory({ ...HISTORY, truncated: true })).toContain('older ones omitted')
  })

  it('says so when the window held no sessions', () => {
    expect(renderHistory({ symbol: 'AAPL', bars: [], truncated: false })).toMatch(/No sessions/)
  })
})

describe('profile and filings', () => {
  it('labels each stated field and omits the rest', () => {
    expect(renderProfile(PROFILE)).toBe('AAPL — Apple Inc.\nexchange: Nasdaq\nsector: Electronic Computers\nCIK: 0000320193')
    expect(renderProfile({ symbol: 'X' })).toBe('X')
  })

  it('renders one line per filing and says so when there are none', () => {
    expect(renderFilings([FILING])).toBe('2026-02-01  10-K for 2025-12-27  https://www.sec.gov/x')
    expect(renderFilings([])).toMatch(/No filings/)
  })
})

describe('the command summary', () => {
  it('carries the issuer, the quote, the range and the disclaimer', () => {
    const text = renderSummary(QUOTE, HISTORY, PROFILE, [FILING])
    expect(text).toContain('Apple Inc.')
    expect(text).toContain('AAPL 230.10')
    expect(text).toContain('2-session range 229.35 to 230.10')
    expect(text).toContain('10-K')
    expect(text).toContain('not investment advice')
  })

  it('still summarizes a symbol the regulator does not list', () => {
    const text = renderSummary(QUOTE, HISTORY, undefined, [])
    expect(text).toContain('AAPL')
    expect(text).not.toContain('Recent filings')
  })
})
