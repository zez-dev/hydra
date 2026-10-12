/**
 * Market-data vocabulary: the provider interface, its request and result
 * records, and the error every operation throws. Types only.
 * @module
 */

/** Stable failure codes callers may branch on. */
export type MarketDataErrorCode =
  /** No provider is registered, or the configured one is not. */
  | 'MARKET_PROVIDER_UNAVAILABLE'
  /** Several usable providers are registered and none is configured. */
  | 'MARKET_PROVIDER_AMBIGUOUS'
  /** The symbol is not known to the source. */
  | 'MARKET_SYMBOL_UNKNOWN'
  /** The source answered, but not with the data this operation needs. */
  | 'MARKET_SOURCE_UNREADABLE'
  /** The source did not answer inside the request budget. */
  | 'MARKET_SOURCE_TIMEOUT'
  /** The source refused, rate-limited, or failed. */
  | 'MARKET_SOURCE_REFUSED'
  /** The operation is not implemented by the selected provider. */
  | 'MARKET_UNSUPPORTED'

/** A market-data failure carrying a stable {@link MarketDataErrorCode}. */
export class MarketDataError extends Error {
  override readonly name = 'MarketDataError'

  /**
   * @param message - human-readable cause.
   * @param code - the stable failure code.
   */
  constructor(message: string, readonly code: MarketDataErrorCode) {
    super(message)
  }
}

/** One symbol's latest settled daily close. */
export interface Quote {
  /** The symbol as the caller wrote it. */
  readonly symbol: string
  /** Close of the most recent settled session. */
  readonly close: number
  /** Close minus the previous session's close; absent without a prior session. */
  readonly change?: number
  /** `change` as a percentage of the previous close; absent without a prior session. */
  readonly changePercent?: number
  /** Session date of `close`, as `YYYY-MM-DD`. */
  readonly asOf: string
  /** ISO currency code when the source states one. */
  readonly currency?: string
}

/** One daily bar. */
export interface Bar {
  /** Session date, as `YYYY-MM-DD`. */
  readonly date: string
  readonly open: number
  readonly high: number
  readonly low: number
  readonly close: number
  /** Shares traded; absent when the source omits it. */
  readonly volume?: number
}

/** A daily series for one symbol, oldest bar first. */
export interface History {
  readonly symbol: string
  readonly bars: readonly Bar[]
  /** Whether the provider dropped bars to honour the request's `limit`. */
  readonly truncated: boolean
}

/** What a source can say about the company behind a symbol. */
export interface MarketProfile {
  readonly symbol: string
  /** Registered or common name, when the source states one. */
  readonly name?: string
  /** Listing venue, when the source states one. */
  readonly exchange?: string
  /** Sector or industry description, when the source states one. */
  readonly sector?: string
  /** SEC Central Index Key, zero-padded, for issuers EDGAR knows. */
  readonly cik?: string
}

/** One regulatory filing. */
export interface Filing {
  /** Form type, such as `10-K` or `8-K`. */
  readonly form: string
  /** Filing date, as `YYYY-MM-DD`. */
  readonly filedAt: string
  /** Period the filing reports on, when stated. */
  readonly reportDate?: string
  /** Stable document URL. */
  readonly url: string
}

/** Options for {@link MarketDataProvider.history}. */
export interface HistoryRequest {
  /** Earliest session date to include, as `YYYY-MM-DD`. */
  readonly from?: string
  /** Latest session date to include, as `YYYY-MM-DD`. */
  readonly to?: string
  /** Maximum bars to return, counting back from the newest. */
  readonly limit?: number
}

/** Options for {@link MarketDataProvider.filings}. */
export interface FilingsRequest {
  /** Form types to keep, such as `['10-K', '10-Q']`; omitted keeps every form. */
  readonly forms?: readonly string[]
  /** Maximum filings to return, newest first. */
  readonly limit?: number
}

/**
 * One market-data source. A provider throws {@link MarketDataError} rather than
 * returning a partial record, and reports `available()` false when it cannot
 * run at all (a missing credential, say) so selection can skip it.
 */
export interface MarketDataProvider {
  /** Registry key, unique among market-data providers. */
  readonly id: string
  /**
   * Whether this provider can currently serve requests.
   * @returns true when the provider is usable.
   */
  available(): boolean
  /**
   * Latest settled close for each symbol.
   * @param symbols - symbols to quote.
   * @param signal - optional cancellation signal.
   * @returns one quote per symbol the source knows, in request order.
   */
  quote(symbols: readonly string[], signal?: AbortSignal): Promise<readonly Quote[]>
  /**
   * Daily bars for one symbol.
   * @param symbol - the symbol to read.
   * @param request - date bounds and bar cap.
   * @param signal - optional cancellation signal.
   * @returns the series, oldest bar first.
   */
  history(symbol: string, request: HistoryRequest, signal?: AbortSignal): Promise<History>
  /**
   * What the source knows about the issuer behind a symbol.
   * @param symbol - the symbol to describe.
   * @param signal - optional cancellation signal.
   * @returns the profile; fields the source omits are absent.
   */
  profile(symbol: string, signal?: AbortSignal): Promise<MarketProfile>
  /**
   * Recent regulatory filings for a symbol.
   * @param symbol - the symbol to read.
   * @param request - form filter and count cap.
   * @param signal - optional cancellation signal.
   * @returns filings, newest first.
   */
  filings(symbol: string, request: FilingsRequest, signal?: AbortSignal): Promise<readonly Filing[]>
}
