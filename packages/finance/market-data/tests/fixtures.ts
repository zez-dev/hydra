/**
 * Recorded response shapes from the two keyless sources, trimmed to the fields
 * this package reads. No test contacts the network.
 * @module
 */

/** Stooq's daily CSV for a US listing. */
export const STOOQ_AAPL = `Date,Open,High,Low,Close,Volume
2026-09-15,225.10,227.40,224.05,226.80,41203100
2026-09-16,226.95,229.80,226.10,229.35,38122400
2026-09-17,229.50,231.20,228.15,230.10,35004900`

/** Stooq's answer for a symbol it does not carry. */
export const STOOQ_MISSING = 'No data'

/** A well-formed header with no sessions beneath it. */
export const STOOQ_EMPTY = 'Date,Open,High,Low,Close,Volume'

/** A row with a blank volume column, which Stooq emits for some listings. */
export const STOOQ_BLANK_VOLUME = `Date,Open,High,Low,Close,Volume
2026-09-17,10.00,10.50,9.90,10.25,`

/** EDGAR's symbol map, keyed by an index string. */
export const EDGAR_TICKERS = JSON.stringify({
  '0': { cik_str: 320193, ticker: 'AAPL', title: 'Apple Inc.' },
  '1': { cik_str: 789019, ticker: 'MSFT', title: 'MICROSOFT CORP' },
})

/** EDGAR's submissions document, with its column-oriented recent filings. */
export const EDGAR_SUBMISSIONS = JSON.stringify({
  name: 'Apple Inc.',
  exchanges: ['Nasdaq'],
  sicDescription: 'Electronic Computers',
  filings: {
    recent: {
      accessionNumber: ['0000320193-26-000081', '0000320193-26-000070', '0000320193-26-000062'],
      filingDate: ['2026-08-01', '2026-05-02', '2026-02-01'],
      reportDate: ['2026-06-27', '2026-03-28', '2025-12-27'],
      form: ['10-Q', '10-Q', '10-K'],
      primaryDocument: ['aapl-20260627.htm', 'aapl-20260328.htm', ''],
    },
  },
})
