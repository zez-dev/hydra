/**
 * Model-facing market tools over `ctx.marketData`, plus the `/market` summary
 * command. This package owns schemas, caps and presentation; it never names a
 * source. Results are historical data for research, not investment advice, and
 * every tool description says so to the model.
 * @module @deepseek-ai/dsh-tool-market
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-market-data'
import type {} from '@deepseek-ai/dsh-commands'
// Type-only: resolves the optional `ctx.research` service declaration.
import type {} from '@deepseek-ai/dsh-research'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { renderFilings, renderHistory, renderProfile, renderQuotes, renderSummary } from './render.ts'

export { renderFilings, renderHistory, renderProfile, renderQuotes, renderSummary } from './render.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-market'

/** Services this plugin requires. */
export const inject = ['tools', 'marketData', 'commands']

/** Plugin config for the market tools. */
export interface Config {
  /** Symbols one `market_quote` call may name. */
  maxSymbols: number
  /** Bars one `market_history` call may return. */
  maxBars: number
  /** Filings one `market_filings` call may return. */
  maxFilings: number
  /** Sessions the `/market` summary reads for its range. */
  summaryBars: number
}

/** Schemastery configuration for the market tools. */
export const Config: z<Config> = z.object({
  maxSymbols: z.natural().min(1).default(10),
  maxBars: z.natural().min(1).default(60),
  maxFilings: z.natural().min(1).default(10),
  summaryBars: z.natural().min(1).default(30),
})

/** Shared closing sentence so every tool tells the model what the data is not. */
const NOT_ADVICE = 'Historical market data for research; not investment advice.'

/**
 * Register the market tools and the `/market` command.
 * @param ctx - the mounting context.
 * @param config - validated tool configuration.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.tools.register(defineTool({
    name: 'market_quote',
    description: 'Latest settled daily close for one or more listed symbols. A symbol is a ticker such as `AAPL`, '
      + 'or `TICKER.EXCHANGE` for a non-US listing such as `bmw.de`. The close is the last completed session, '
      + `so during market hours it is the previous close rather than a live price. ${NOT_ADVICE}`,
    parameters: {
      symbols: {
        type: 'array',
        required: true,
        items: { type: 'string' },
        description: `The symbols to quote; at most ${String(config.maxSymbols)}.`,
      },
    },
    output: {
      schema: { type: 'json' },
      render: (args, value) => [{
        type: 'text',
        text: renderQuotes(value as never, Math.max(args.symbols.length - config.maxSymbols, 0)),
      }],
    },
    execute: async (args, exec) => {
      const symbols = args.symbols.slice(0, config.maxSymbols)
      return await ctx.marketData.quote(symbols, exec.signal) as never
    },
  }))

  ctx.tools.register(defineTool({
    name: 'market_history',
    description: 'Daily open, high, low, close and volume for one symbol, oldest session first. '
      + 'Bound the window with `from` and `to` as `YYYY-MM-DD`; without them the whole available series is read '
      + `and the newest ${String(config.maxBars)} sessions are returned. ${NOT_ADVICE}`,
    parameters: {
      symbol: { type: 'string', required: true, description: 'The symbol to read.' },
      from: { type: 'string', description: 'Earliest session date, `YYYY-MM-DD`.' },
      to: { type: 'string', description: 'Latest session date, `YYYY-MM-DD`.' },
      limit: { type: 'integer', description: `Newest sessions to return; capped at ${String(config.maxBars)}.` },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: renderHistory(value as never) }],
    },
    execute: async (args, exec) => {
      const limit = Math.min(args.limit ?? config.maxBars, config.maxBars)
      return await ctx.marketData.history(args.symbol, {
        limit,
        ...args.from === undefined ? {} : { from: args.from },
        ...args.to === undefined ? {} : { to: args.to },
      }, exec.signal) as never
    },
  }))

  ctx.tools.register(defineTool({
    name: 'market_profile',
    description: 'The issuer behind a symbol as the securities regulator lists it: registered name, listing venue '
      + `and industry description. Only issuers that file with the SEC are known. ${NOT_ADVICE}`,
    parameters: {
      symbol: { type: 'string', required: true, description: 'The symbol to describe.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: renderProfile(value as never) }],
    },
    execute: async (args, exec) => await ctx.marketData.profile(args.symbol, exec.signal) as never,
  }))

  ctx.tools.register(defineTool({
    name: 'market_filings',
    description: 'Recent regulatory filings for a symbol, newest first, each with its form type, filing date and a '
      + 'document URL. Filter by form with `forms`, such as `["10-K", "10-Q"]`; omit it for every form. '
      + `Read a filing's contents with the web fetch tool. ${NOT_ADVICE}`,
    parameters: {
      symbol: { type: 'string', required: true, description: 'The symbol to read.' },
      forms: { type: 'array', items: { type: 'string' }, description: 'Form types to keep; omitted keeps every form.' },
      limit: { type: 'integer', description: `Filings to return; capped at ${String(config.maxFilings)}.` },
    },
    output: {
      schema: { type: 'json' },
      // A full list at the cap may be hiding older filings, and a `limit` above
      // the cap definitely was cut; the model is told in both cases.
      render: (args, value) => [{
        type: 'text',
        text: renderFilings(value as never, (value as readonly unknown[]).length >= config.maxFilings
          || (args.limit ?? 0) > config.maxFilings),
      }],
    },
    execute: async (args, exec) => {
      const limit = Math.min(args.limit ?? config.maxFilings, config.maxFilings)
      return await ctx.marketData.filings(args.symbol, {
        limit,
        ...args.forms === undefined ? {} : { forms: args.forms },
      }, exec.signal) as never
    },
  }))

  ctx.effect(() => ctx.commands.register({
    name: 'market',
    description: 'One-screen summary for a symbol: quote, recent range, and latest filings',
    input: { hint: '<symbol>' },
    handler: async (invocation) => {
      const symbol = invocation.rawInput.trim().split(/\s+/)[0] ?? ''
      if (symbol === '') return { kind: 'error', text: 'Usage: /market <symbol>' }
      const summary = await summarize(ctx, symbol, config, invocation.signal)
      await recordMarketFinding(ctx, invocation.agent, symbol, summary)
      return { kind: 'success', text: summary }
    },
  }))
}

/**
 * Build the `/market` summary, tolerating sources that do not know the symbol.
 * @param ctx - the mounting context.
 * @param symbol - the symbol to summarize.
 * @param config - validated tool configuration.
 * @param signal - the invocation's cancellation signal.
 * @returns the summary text.
 */
async function summarize(ctx: Context, symbol: string, config: Config, signal: AbortSignal): Promise<string> {
  const history = await ctx.marketData.history(symbol, { limit: config.summaryBars }, signal)
  const [quote] = await ctx.marketData.quote([symbol], signal)
  // EDGAR lists only SEC filers, so a foreign or delisted symbol has prices but
  // no issuer; that is an ordinary outcome, not a failed summary.
  const profile = await ctx.marketData.profile(symbol, signal).catch(() => undefined)
  const filings = profile === undefined
    ? []
    : await ctx.marketData.filings(symbol, { limit: 3 }, signal).catch(() => [])
  return renderSummary(quote, history, profile, filings)
}

/**
 * Record one symbol's summary into the session's research journal, when one is
 * open, so a market reading survives compaction and the session itself.
 *
 * Read through `ctx.get('research')` so this package never requires the
 * research plugin; without it, or without an active research goal, nothing is
 * recorded and the caller carries on.
 * @param ctx - the mounting context.
 * @param agent - the agent whose session may hold a research goal.
 * @param symbol - the symbol that was read.
 * @param summary - the rendered summary to keep.
 * @returns true when a journal took the finding.
 */
export async function recordMarketFinding(
  ctx: Context,
  agent: Agent,
  symbol: string,
  summary: string,
): Promise<boolean> {
  const research = ctx.get('research')
  if (research === undefined) return false
  const active = research.activeFor(agent.id)
  if (active === undefined) return false
  await research.record({
    cwd: active.cwd,
    slug: active.slug,
    kind: 'result',
    text: `Read market data for ${symbol}`,
    result: summary,
  }, 'auto')
  return true
}
