/**
 * The provider's network edge: the injectable fetch, the host allowlist, the
 * per-request deadline, the response cache, and the request pacer. Everything
 * that touches the network lives here so the provider itself is pure enough to
 * test from recorded fixtures.
 * @module
 */

import { MarketDataError } from './types.ts'

/** The subset of `fetch` this package uses, so tests can supply their own. */
export type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal; redirect: 'error' }) => Promise<{
  readonly ok: boolean
  readonly status: number
  text(): Promise<string>
}>

/** Hosts this package will contact. Anything else is refused before a socket opens. */
export const ALLOWED_HOSTS: readonly string[] = ['stooq.com', 'data.sec.gov', 'www.sec.gov']

/** Replaceable collaborators; production leaves them at their defaults. */
export interface TransportInternals {
  /** The fetch implementation; defaults to the global one. */
  readonly fetch?: FetchLike
  /** Millisecond clock; defaults to `Date.now`. */
  readonly now?: () => number
}

/** Transport limits, all supplied by the plugin's validated config. */
export interface TransportLimits {
  /** Deadline for one request, in milliseconds. */
  readonly timeoutMs: number
  /** How long a response stays reusable, in milliseconds. */
  readonly cacheTtlMs: number
  /** Minimum gap between two requests to the same host, in milliseconds. */
  readonly minRequestGapMs: number
  /** Cap on one response body, in bytes, to bound memory. */
  readonly maxBodyBytes: number
}

interface CacheEntry {
  readonly body: string
  readonly storedAt: number
}

/**
 * Whether a URL names a host this package may contact.
 * @param url - the absolute URL to check.
 * @returns true when the host is on the allowlist.
 */
export function isAllowed(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    // Not a URL at all: refuse it the same way as a disallowed host.
    return false
  }
  return parsed.protocol === 'https:' && ALLOWED_HOSTS.includes(parsed.hostname)
}

/**
 * Serialized, paced, cached text retrieval from the allowed hosts.
 *
 * One pacer queue per host honours the source's rate guidance (SEC asks for no
 * more than ten requests a second). Bodies are cached by URL for the configured
 * TTL so a research loop asking the same question repeatedly hits the source
 * once. A non-2xx status, a disallowed host, a cross-host redirect, and a
 * timeout each raise {@link MarketDataError}; no response body is ever logged.
 */
export class Transport {
  private readonly cache = new Map<string, CacheEntry>()
  private readonly lastRequestAt = new Map<string, number>()
  private readonly queues = new Map<string, Promise<unknown>>()
  private readonly fetchImpl: FetchLike
  private readonly now: () => number

  /**
   * @param limits - deadline, cache TTL, pacing gap, and body cap.
   * @param userAgent - the `User-Agent` every request declares.
   * @param internals - replaceable fetch and clock, for tests.
   */
  constructor(
    private readonly limits: TransportLimits,
    private readonly userAgent: string,
    internals: TransportInternals = {},
  ) {
    this.fetchImpl = internals.fetch ?? globalThis.fetch
    this.now = internals.now ?? (() => Date.now())
  }

  /**
   * Retrieve one URL's body as text, through the cache and the host's pacer.
   * @param url - absolute https URL on an allowed host.
   * @param signal - optional caller cancellation.
   * @returns the response body.
   * @throws MarketDataError when the host is disallowed, the request times out, or the source refuses.
   */
  async text(url: string, signal?: AbortSignal): Promise<string> {
    if (!isAllowed(url)) {
      throw new MarketDataError(`market-data will not contact ${safeHost(url)}`, 'MARKET_SOURCE_REFUSED')
    }
    const cached = this.cache.get(url)
    if (cached !== undefined && this.now() - cached.storedAt < this.limits.cacheTtlMs) return cached.body
    const host = new URL(url).hostname
    const body = await this.enqueue(host, () => this.send(url, signal))
    this.cache.set(url, { body, storedAt: this.now() })
    return body
  }

  /** Run `task` after the host's previous request and its minimum gap. */
  private enqueue<T>(host: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(host) ?? Promise.resolve()
    const run = previous.then(async () => {
      const since = this.now() - (this.lastRequestAt.get(host) ?? -Infinity)
      if (since < this.limits.minRequestGapMs) await delay(this.limits.minRequestGapMs - since)
      this.lastRequestAt.set(host, this.now())
      return task()
    })
    // Keep the chain alive past a failure so one refused request does not wedge
    // the host's queue; the rejection still reaches this call's caller.
    this.queues.set(host, run.catch(() => undefined))
    return run
  }

  private async send(url: string, signal?: AbortSignal): Promise<string> {
    const deadline = new AbortController()
    const timer = setTimeout(() => { deadline.abort() }, this.limits.timeoutMs)
    const onAbort = (): void => { deadline.abort() }
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const response = await this.fetchImpl(url, {
        headers: { 'User-Agent': this.userAgent, Accept: '*/*' },
        signal: deadline.signal,
        redirect: 'error',
      })
      if (!response.ok) {
        throw new MarketDataError(
          `${safeHost(url)} refused the request with status ${String(response.status)}`,
          response.status === 404 ? 'MARKET_SYMBOL_UNKNOWN' : 'MARKET_SOURCE_REFUSED',
        )
      }
      const body = await response.text()
      if (body.length > this.limits.maxBodyBytes) {
        throw new MarketDataError(`${safeHost(url)} returned more than the configured body cap`, 'MARKET_SOURCE_UNREADABLE')
      }
      return body
    } catch (error) {
      if (error instanceof MarketDataError) throw error
      if (signal?.aborted === true) throw error
      if (deadline.signal.aborted) {
        throw new MarketDataError(`${safeHost(url)} did not answer within the request budget`, 'MARKET_SOURCE_TIMEOUT')
      }
      throw new MarketDataError(`${safeHost(url)} could not be reached`, 'MARKET_SOURCE_REFUSED')
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }
}

/**
 * The host of a URL, for a message that must not echo a full URL with its query.
 * @param url - the URL to describe.
 * @returns the hostname, or a fixed placeholder when it does not parse.
 */
function safeHost(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    // An unparsable URL has no host to name; the caller only needs a subject.
    return 'the requested host'
  }
}

/**
 * Resolve after `ms` milliseconds.
 * @param ms - delay in milliseconds.
 * @returns a promise resolving after the delay.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}
