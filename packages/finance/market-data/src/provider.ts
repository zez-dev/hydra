/**
 * The keyless provider: Stooq for prices, EDGAR for issuers and filings.
 * @module
 */

import { parseFilings, parseProfile, parseStooqCsv, parseTickerMap } from './parse.ts'
import type { Transport } from './transport.ts'
import { MarketDataError } from './types.ts'
import type {
  Bar, Filing, FilingsRequest, History, HistoryRequest, MarketDataProvider, MarketProfile, Quote,
} from './types.ts'

/** EDGAR's symbol-to-CIK map. */
const TICKER_MAP_URL = 'https://www.sec.gov/files/company_tickers.json'

/** Registry id of the shipped provider, named for the sources it reads. */
export const STOOQ_EDGAR_PROVIDER_ID = 'stooq-edgar'

/**
 * Daily prices from Stooq and issuer data from SEC EDGAR, neither of which
 * needs an account. Both are free for personal use; the operator accepts each
 * source's terms by configuring this provider, and EDGAR additionally requires
 * a declaring `User-Agent`, which the plugin makes a required field.
 *
 * Stooq quotes the last settled session, so a quote during market hours is the
 * previous close, not a live price. Intraday intervals are not offered at all
 * rather than silently approximated.
 */
export class StooqEdgarProvider implements MarketDataProvider {
  readonly id = STOOQ_EDGAR_PROVIDER_ID

  /**
   * @param transport - the paced, cached network edge.
   */
  constructor(private readonly transport: Transport) {}

  /**
   * Whether the provider can serve requests; it needs no credential, so always.
   * @returns true.
   */
  available(): boolean {
    return true
  }

  /**
   * Latest settled close per symbol, from each symbol's daily series.
   * @param symbols - symbols to quote.
   * @param signal - optional cancellation signal.
   * @returns one quote per symbol, in request order.
   */
  async quote(symbols: readonly string[], signal?: AbortSignal): Promise<readonly Quote[]> {
    const quotes: Quote[] = []
    for (const symbol of symbols) {
      const bars = await this.bars(symbol, signal)
      const last = bars.at(-1)
      const previous = bars.at(-2)
      if (last === undefined) continue
      const change = previous === undefined ? undefined : round(last.close - previous.close)
      const changePercent = previous === undefined || previous.close === 0
        ? undefined
        : round(((last.close - previous.close) / previous.close) * 100)
      quotes.push({
        symbol,
        close: last.close,
        asOf: last.date,
        ...change === undefined ? {} : { change },
        ...changePercent === undefined ? {} : { changePercent },
      })
    }
    return quotes
  }

  /**
   * Daily bars for one symbol, filtered to the requested window.
   * @param symbol - the symbol to read.
   * @param request - date bounds and bar cap.
   * @param signal - optional cancellation signal.
   * @returns the series, oldest bar first.
   */
  async history(symbol: string, request: HistoryRequest, signal?: AbortSignal): Promise<History> {
    const all = await this.bars(symbol, signal)
    const windowed = all.filter(bar =>
      (request.from === undefined || bar.date >= request.from)
      && (request.to === undefined || bar.date <= request.to))
    const limit = request.limit
    if (limit === undefined || windowed.length <= limit) {
      return { symbol, bars: windowed, truncated: false }
    }
    return { symbol, bars: windowed.slice(-limit), truncated: true }
  }

  /**
   * The issuer EDGAR lists for a symbol.
   * @param symbol - the symbol to describe.
   * @param signal - optional cancellation signal.
   * @returns the profile.
   * @throws MarketDataError when EDGAR does not list the symbol.
   */
  async profile(symbol: string, signal?: AbortSignal): Promise<MarketProfile> {
    const { cik } = await this.resolveCik(symbol, signal)
    const submissions = await this.transport.text(submissionsUrl(cik), signal)
    return parseProfile(symbol, cik, submissions)
  }

  /**
   * Recent filings for a symbol, newest first.
   * @param symbol - the symbol to read.
   * @param request - form filter and count cap.
   * @param signal - optional cancellation signal.
   * @returns the filings.
   * @throws MarketDataError when EDGAR does not list the symbol.
   */
  async filings(symbol: string, request: FilingsRequest, signal?: AbortSignal): Promise<readonly Filing[]> {
    const { cik } = await this.resolveCik(symbol, signal)
    const submissions = await this.transport.text(submissionsUrl(cik), signal)
    return parseFilings(cik, submissions, request.forms ?? [], request.limit ?? 10)
  }

  /** Read and parse one symbol's complete daily series. */
  private async bars(symbol: string, signal?: AbortSignal): Promise<readonly Bar[]> {
    const csv = await this.transport.text(stooqUrl(symbol), signal)
    return parseStooqCsv(symbol, csv)
  }

  /** Resolve a symbol to its zero-padded CIK through EDGAR's ticker map. */
  private async resolveCik(symbol: string, signal?: AbortSignal): Promise<{ cik: string; name?: string }> {
    const map = await this.transport.text(TICKER_MAP_URL, signal)
    const found = parseTickerMap(symbol, map)
    if (found === undefined) {
      throw new MarketDataError(`EDGAR does not list a US issuer for "${symbol}"`, 'MARKET_SYMBOL_UNKNOWN')
    }
    return found
  }
}

/**
 * Stooq's daily CSV URL for a symbol.
 *
 * Stooq expects a lowercase symbol and, for US listings, a `.us` suffix, which
 * a caller writing `AAPL` will not have supplied.
 * @param symbol - the caller's symbol.
 * @returns the absolute CSV URL.
 */
export function stooqUrl(symbol: string): string {
  const trimmed = symbol.trim().toLowerCase()
  const qualified = trimmed.includes('.') ? trimmed : `${trimmed}.us`
  return `https://stooq.com/q/d/l/?s=${encodeURIComponent(qualified)}&i=d`
}

/**
 * EDGAR's submissions URL for a zero-padded CIK.
 * @param cik - the zero-padded CIK.
 * @returns the absolute submissions URL.
 */
export function submissionsUrl(cik: string): string {
  return `https://data.sec.gov/submissions/CIK${cik}.json`
}

/** Round to two decimals, the precision these sources quote. */
function round(value: number): number {
  return Math.round(value * 100) / 100
}
