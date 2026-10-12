/**
 * Pure rendering of market records into the compact text a model and a command
 * both read. A series is a small table, never a thousand rows.
 * @module
 */

import type { Bar, Filing, History, MarketProfile, Quote } from '@deepseek-ai/dsh-market-data'

/**
 * One line per quote, with the change when a prior session exists.
 * @param quotes - the quotes to render.
 * @param omitted - requested symbols the per-call cap dropped.
 * @returns the lines, or a sentence when the source knew no symbol.
 */
export function renderQuotes(quotes: readonly Quote[], omitted = 0): string {
  if (quotes.length === 0) return 'No quotes; the source carries none of those symbols.'
  const lines = quotes.map((quote) => {
    const change = quote.change === undefined || quote.changePercent === undefined
      ? ''
      : ` ${quote.change >= 0 ? '+' : ''}${quote.change.toFixed(2)} (${quote.changePercent.toFixed(2)}%)`
    return `${quote.symbol} ${quote.close.toFixed(2)}${change} as of ${quote.asOf}`
  })
  if (omitted > 0) {
    lines.push(`${String(omitted)} more requested symbols were not quoted; ask for them in another call.`)
  }
  return lines.join('\n')
}

/**
 * A daily series as a fixed-width table, newest last, with a truncation note.
 * @param history - the series to render.
 * @returns the table, or a sentence when the window held no sessions.
 */
export function renderHistory(history: History): string {
  if (history.bars.length === 0) return `No sessions for ${history.symbol} in that window.`
  const head = history.truncated
    ? `${history.symbol}: newest ${String(history.bars.length)} sessions (older ones omitted)`
    : `${history.symbol}: ${String(history.bars.length)} sessions`
  const rows = history.bars.map(bar =>
    `${bar.date}  ${column(bar.open)} ${column(bar.high)} ${column(bar.low)} ${column(bar.close)}${volume(bar)}`)
  return [head, 'date         open   high    low  close  volume', ...rows].join('\n')
}

/** Right-align a price in the table's numeric column. */
function column(value: number): string {
  return value.toFixed(2).padStart(6)
}

/** The volume column, blank when the source omitted it. */
function volume(bar: Bar): string {
  return bar.volume === undefined ? '' : `  ${String(bar.volume)}`
}

/**
 * An issuer profile as labelled lines, omitting fields the source did not state.
 * @param profile - the profile to render.
 * @returns the lines.
 */
export function renderProfile(profile: MarketProfile): string {
  const lines = [`${profile.symbol}${profile.name === undefined ? '' : ` — ${profile.name}`}`]
  if (profile.exchange !== undefined) lines.push(`exchange: ${profile.exchange}`)
  if (profile.sector !== undefined) lines.push(`sector: ${profile.sector}`)
  if (profile.cik !== undefined) lines.push(`CIK: ${profile.cik}`)
  return lines.join('\n')
}

/**
 * Filings as one line each, newest first.
 * @param filings - the filings to render.
 * @param truncated - the per-call cap kept only the newest ones.
 * @returns the lines, or a sentence when there are none.
 */
export function renderFilings(filings: readonly Filing[], truncated = false): string {
  if (filings.length === 0) return 'No filings of those forms.'
  const rows = filings.map((filing) => {
    const period = filing.reportDate === undefined ? '' : ` for ${filing.reportDate}`
    return `${filing.filedAt}  ${filing.form}${period}  ${filing.url}`
  })
  const head = `Newest ${String(filings.length)} filings (older ones omitted)`
  return (truncated ? [head, ...rows] : rows).join('\n')
}

/**
 * The one-screen summary `/market` prints: quote, recent range, latest filings.
 * @param quote - the latest quote, when the source had one.
 * @param history - the recent series backing the range.
 * @param profile - the issuer, when EDGAR lists one.
 * @param filings - the most recent filings.
 * @returns the summary text.
 */
export function renderSummary(
  quote: Quote | undefined,
  history: History,
  profile: MarketProfile | undefined,
  filings: readonly Filing[],
): string {
  const parts: string[] = []
  parts.push(profile === undefined ? history.symbol : renderProfile(profile))
  if (quote !== undefined) parts.push(renderQuotes([quote]))
  const closes = history.bars.map(bar => bar.close)
  if (closes.length > 0) {
    const low = Math.min(...closes)
    const high = Math.max(...closes)
    parts.push(`${String(history.bars.length)}-session range ${low.toFixed(2)} to ${high.toFixed(2)}`)
  }
  if (filings.length > 0) parts.push(`Recent filings:\n${renderFilings(filings)}`)
  parts.push('Historical data for research, not investment advice.')
  return parts.join('\n\n')
}
