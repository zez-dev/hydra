/**
 * Service Definition for the market-data capability seam (`ctx.marketData`),
 * plus the keyless Stooq and EDGAR provider it mounts by default. Consumers ask
 * for quotes, daily history, issuer profiles and filings without naming a
 * source; a keyed vendor registers here later without touching them.
 * @module @deepseek-ai/dsh-market-data
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { StooqEdgarProvider } from './provider.ts'
import { Transport } from './transport.ts'
import type { TransportInternals } from './transport.ts'
import { MarketDataError } from './types.ts'
import type {
  Filing, FilingsRequest, History, HistoryRequest, MarketDataProvider, MarketProfile, Quote,
} from './types.ts'

export { MarketDataError } from './types.ts'
export type {
  Bar, Filing, FilingsRequest, History, HistoryRequest, MarketDataErrorCode,
  MarketDataProvider, MarketProfile, Quote,
} from './types.ts'
export { StooqEdgarProvider, STOOQ_EDGAR_PROVIDER_ID, stooqUrl, submissionsUrl } from './provider.ts'
export { ALLOWED_HOSTS, isAllowed, Transport } from './transport.ts'
export type { FetchLike, TransportInternals, TransportLimits } from './transport.ts'
export { parseFilings, parseProfile, parseStooqCsv, parseTickerMap } from './parse.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    marketData: MarketDataRuntime
  }
}

/** Plugin config for the market-data seam and its built-in provider. */
export interface Config {
  /**
   * Contact string sent as `User-Agent` to SEC EDGAR, which requires a
   * declaring name and email and refuses anonymous traffic. Supply your own,
   * for example `Jane Roe jane@example.com`; activation fails without it.
   */
  secUserAgent: string
  /** Deadline for one source request, in milliseconds; schema default 15000. */
  timeoutMs?: number
  /** How long a source response stays reusable, in milliseconds; schema default 300000. */
  cacheTtlMs?: number
  /** Minimum gap between two requests to one host, in milliseconds; schema default 120. */
  minRequestGapMs?: number
  /** Cap on one response body, in bytes; schema default 1048576. */
  maxBodyBytes?: number
  /** Provider id to use; omitted auto-selects when exactly one is usable. */
  provider?: string
  /** Register the built-in keyless provider; schema default true. Set false only when supplying another. */
  builtinProvider?: boolean
}

/** Schemastery configuration for the market-data seam. */
export const Config: z<Config> = z.object({
  secUserAgent: z.string().required(),
  timeoutMs: z.natural().min(1000).default(15_000),
  cacheTtlMs: z.natural().default(300_000),
  minRequestGapMs: z.natural().default(120),
  maxBodyBytes: z.natural().min(1024).default(8 * 1024 * 1024),
  provider: z.string(),
  builtinProvider: z.boolean().default(true),
})

/**
 * The market-data service. Registered as `ctx.marketData`.
 *
 * Every operation resolves its provider at call time: a configured id that is
 * registered and usable wins; otherwise exactly one usable provider is
 * required, so selection never depends on registration order. Data is
 * informational and historical, delayed to the last settled session for the
 * built-in source, and is not investment advice.
 */
export class MarketDataRuntime extends Service {
  static Config = Config

  /**
   * Replaceable fetch and clock. The Loader supplies only config, so a test
   * mounting this plugin assigns here before its first call; the built-in
   * provider is built on that first call, not in the constructor.
   */
  internals: TransportInternals = {}

  private readonly providers = new Map<string, MarketDataProvider>()
  private readonly configuredId: string | undefined
  private readonly contact: string
  private builtinPending: boolean

  /**
   * @param ctx - the mounting context.
   * @param config - validated seam configuration.
   */
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'marketData')
    const contact = config.secUserAgent.trim()
    if (contact === '') {
      throw new Error(
        'market-data: secUserAgent must name a contact (for example "Jane Roe jane@example.com"); '
        + 'SEC EDGAR refuses requests that do not declare one',
      )
    }
    this.contact = contact
    this.configuredId = config.provider
    // The schema defaulted every omitted field; the ?? narrows the optional
    // input type for direct (non-Loader) construction in tests and generators.
    this.builtinPending = config.builtinProvider ?? true
  }

  /** Build and register the built-in provider the first time one is needed. */
  private ensureBuiltin(): void {
    if (!this.builtinPending) return
    this.builtinPending = false
    const transport = new Transport({
      timeoutMs: this.config.timeoutMs ?? 15_000,
      cacheTtlMs: this.config.cacheTtlMs ?? 300_000,
      minRequestGapMs: this.config.minRequestGapMs ?? 120,
      maxBodyBytes: this.config.maxBodyBytes ?? 1_048_576,
    }, this.contact, this.internals)
    this.register(new StooqEdgarProvider(transport))
  }

  /**
   * Register a market-data provider under its own id.
   * @param provider - the provider; its `id` is the registry key.
   * @returns a disposer that unregisters it.
   * @throws Error when the id is already registered.
   */
  register(provider: MarketDataProvider): () => void {
    if (this.providers.has(provider.id)) {
      throw new Error(`market-data: a provider with id "${provider.id}" is already registered`)
    }
    const store = this.providers
    const dispose = this.ctx.effect(function* () {
      store.set(provider.id, provider)
      yield () => store.delete(provider.id)
    }, 'marketData.register()')
    return () => void dispose()
  }

  /**
   * Latest settled close for each symbol.
   * @param symbols - symbols to quote.
   * @param signal - optional cancellation signal.
   * @returns one quote per symbol the source knows.
   */
  async quote(symbols: readonly string[], signal?: AbortSignal): Promise<readonly Quote[]> {
    return this.resolve().quote(symbols, signal)
  }

  /**
   * Daily bars for one symbol.
   * @param symbol - the symbol to read.
   * @param request - date bounds and bar cap.
   * @param signal - optional cancellation signal.
   * @returns the series, oldest bar first.
   */
  async history(symbol: string, request: HistoryRequest = {}, signal?: AbortSignal): Promise<History> {
    return this.resolve().history(symbol, request, signal)
  }

  /**
   * The issuer behind a symbol.
   * @param symbol - the symbol to describe.
   * @param signal - optional cancellation signal.
   * @returns the profile.
   */
  async profile(symbol: string, signal?: AbortSignal): Promise<MarketProfile> {
    return this.resolve().profile(symbol, signal)
  }

  /**
   * Recent regulatory filings for a symbol.
   * @param symbol - the symbol to read.
   * @param request - form filter and count cap.
   * @param signal - optional cancellation signal.
   * @returns the filings, newest first.
   */
  async filings(symbol: string, request: FilingsRequest = {}, signal?: AbortSignal): Promise<readonly Filing[]> {
    return this.resolve().filings(symbol, request, signal)
  }

  /** Resolve the provider for this call, or throw the matching failure. */
  private resolve(): MarketDataProvider {
    this.ensureBuiltin()
    if (this.configuredId !== undefined) {
      const provider = this.providers.get(this.configuredId)
      if (provider === undefined || !provider.available()) {
        throw new MarketDataError(
          `configured market-data provider "${this.configuredId}" is not available`,
          'MARKET_PROVIDER_UNAVAILABLE',
        )
      }
      return provider
    }
    const usable = [...this.providers.values()].filter(provider => provider.available())
    const [single] = usable
    if (single === undefined) {
      throw new MarketDataError('no usable market-data provider is registered', 'MARKET_PROVIDER_UNAVAILABLE')
    }
    if (usable.length > 1) {
      const ids = usable.map(provider => provider.id).join(', ')
      throw new MarketDataError(
        `multiple market-data providers are registered (${ids}); configure one explicitly`,
        'MARKET_PROVIDER_AMBIGUOUS',
      )
    }
    return single
  }
}

export default MarketDataRuntime
