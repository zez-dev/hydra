/**
 * Pure readers for the two keyless sources: Stooq's daily CSV and EDGAR's JSON.
 * No I/O, so every case is driven from a recorded fixture.
 * @module
 */

import { MarketDataError } from './types.ts'
import type { Bar, Filing, MarketProfile } from './types.ts'

/** Stooq's header for a daily series; anything else is a refusal page. */
const STOOQ_HEADER = 'Date,Open,High,Low,Close,Volume'

/**
 * Read Stooq's daily CSV into bars, oldest first.
 *
 * Stooq answers an unknown symbol with the body `No data` and HTTP 200, so an
 * absent series is a symbol failure rather than an unreadable one.
 * @param symbol - the symbol requested, for the error message.
 * @param csv - the response body.
 * @returns the bars, oldest first.
 * @throws MarketDataError when the symbol is unknown or the body is not a series.
 */
export function parseStooqCsv(symbol: string, csv: string): Bar[] {
  const lines = csv.trim().split(/\r?\n/).filter(line => line.length > 0)
  const [header, ...rows] = lines
  if (header === undefined || /^no data/i.test(header)) {
    throw new MarketDataError(`no daily series for "${symbol}"`, 'MARKET_SYMBOL_UNKNOWN')
  }
  if (!header.startsWith(STOOQ_HEADER)) {
    throw new MarketDataError(`the daily series for "${symbol}" was not readable`, 'MARKET_SOURCE_UNREADABLE')
  }
  const bars: Bar[] = []
  for (const row of rows) {
    const [date, open, high, low, close, volume] = row.split(',')
    if (date === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
    const numbers = [open, high, low, close].map(toNumber)
    const [o, h, l, c] = numbers
    if (o === undefined || h === undefined || l === undefined || c === undefined) continue
    const parsedVolume = toNumber(volume)
    bars.push({ date, open: o, high: h, low: l, close: c, ...parsedVolume === undefined ? {} : { volume: parsedVolume } })
  }
  if (bars.length === 0) {
    throw new MarketDataError(`the daily series for "${symbol}" held no sessions`, 'MARKET_SYMBOL_UNKNOWN')
  }
  return bars
}

/**
 * Parse a finite number, or `undefined` for a blank or non-numeric field.
 * @param text - the raw field.
 * @returns the number, or undefined.
 */
function toNumber(text: string | undefined): number | undefined {
  if (text === undefined || text.trim() === '') return undefined
  const value = Number(text)
  return Number.isFinite(value) ? value : undefined
}

/** One row of EDGAR's company_tickers.json, which is keyed by an index string. */
interface TickerRow {
  readonly cik_str?: unknown
  readonly ticker?: unknown
  readonly title?: unknown
}

/**
 * Find a symbol's zero-padded CIK and registered name in EDGAR's ticker map.
 * @param symbol - the symbol to look up, case-insensitively.
 * @param json - the `company_tickers.json` body.
 * @returns the CIK and name, or undefined when EDGAR does not list the symbol.
 * @throws MarketDataError when the body is not the expected map.
 */
export function parseTickerMap(symbol: string, json: string): { cik: string; name?: string } | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    // EDGAR served something other than the ticker map; the caller reports it.
    throw new MarketDataError('the EDGAR ticker map was not readable', 'MARKET_SOURCE_UNREADABLE')
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new MarketDataError('the EDGAR ticker map was not readable', 'MARKET_SOURCE_UNREADABLE')
  }
  const wanted = symbol.trim().toUpperCase()
  for (const value of Object.values(parsed as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) continue
    const { cik_str: number, ticker, title } = value as TickerRow
    if (typeof ticker !== 'string' || ticker.toUpperCase() !== wanted) continue
    const cik = typeof number === 'number' ? String(number) : typeof number === 'string' ? number : ''
    if (cik === '') continue
    return { cik: cik.padStart(10, '0'), ...typeof title === 'string' ? { name: title } : {} }
  }
  return undefined
}

/** The slice of EDGAR's submissions document this package reads. */
interface Submissions {
  readonly name?: unknown
  readonly exchanges?: unknown
  readonly sicDescription?: unknown
  readonly filings?: { readonly recent?: Record<string, unknown> }
}

/**
 * Read an issuer's profile from EDGAR's submissions document.
 * @param symbol - the symbol requested, echoed into the profile.
 * @param cik - the zero-padded CIK the document belongs to.
 * @param json - the submissions body.
 * @returns the profile, with absent fields omitted.
 * @throws MarketDataError when the body is not a submissions document.
 */
export function parseProfile(symbol: string, cik: string, json: string): MarketProfile {
  const document = readSubmissions(json)
  const exchanges = Array.isArray(document.exchanges) ? document.exchanges.filter(item => typeof item === 'string') : []
  const [exchange] = exchanges
  return {
    symbol,
    cik,
    ...typeof document.name === 'string' ? { name: document.name } : {},
    ...exchange === undefined ? {} : { exchange },
    ...typeof document.sicDescription === 'string' ? { sector: document.sicDescription } : {},
  }
}

/**
 * Read recent filings from EDGAR's submissions document, newest first.
 *
 * `filings.recent` is column-oriented: parallel arrays sharing one index.
 * @param cik - the zero-padded CIK, used to build document URLs.
 * @param json - the submissions body.
 * @param forms - form types to keep; empty keeps every form.
 * @param limit - maximum filings to return.
 * @returns the filings, newest first.
 * @throws MarketDataError when the body is not a submissions document.
 */
export function parseFilings(cik: string, json: string, forms: readonly string[], limit: number): Filing[] {
  const recent = readSubmissions(json).filings?.recent
  if (recent === undefined) return []
  const formColumn = stringColumn(recent['form'])
  const dateColumn = stringColumn(recent['filingDate'])
  const accessionColumn = stringColumn(recent['accessionNumber'])
  const documentColumn = stringColumn(recent['primaryDocument'])
  const reportColumn = stringColumn(recent['reportDate'])
  const wanted = new Set(forms.map(form => form.toUpperCase()))
  const filings: Filing[] = []
  for (let index = 0; index < formColumn.length && filings.length < limit; index++) {
    const form = formColumn[index]
    const filedAt = dateColumn[index]
    const accession = accessionColumn[index]
    if (form === undefined || filedAt === undefined || accession === undefined) continue
    if (wanted.size > 0 && !wanted.has(form.toUpperCase())) continue
    const bare = accession.replaceAll('-', '')
    const document = documentColumn[index]
    const trimmedCik = String(Number(cik))
    const url = document === undefined || document === ''
      ? `https://www.sec.gov/Archives/edgar/data/${trimmedCik}/${bare}/${accession}-index.htm`
      : `https://www.sec.gov/Archives/edgar/data/${trimmedCik}/${bare}/${document}`
    const reportDate = reportColumn[index]
    filings.push({
      form,
      filedAt,
      url,
      ...reportDate === undefined || reportDate === '' ? {} : { reportDate },
    })
  }
  return filings
}

/** Parse a submissions body, rejecting anything that is not an object. */
function readSubmissions(json: string): Submissions {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    // Not JSON: EDGAR served an error page or a truncated body.
    throw new MarketDataError('the EDGAR submissions document was not readable', 'MARKET_SOURCE_UNREADABLE')
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new MarketDataError('the EDGAR submissions document was not readable', 'MARKET_SOURCE_UNREADABLE')
  }
  return parsed
}

/** Read one column of EDGAR's parallel arrays as strings. */
function stringColumn(value: unknown): readonly (string | undefined)[] {
  if (!Array.isArray(value)) return []
  return value.map(item => typeof item === 'string' ? item : undefined)
}
