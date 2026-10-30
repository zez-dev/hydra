import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { executeModelToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import CommandRuntime, { CommandId } from '@deepseek-ai/dsh-commands'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import MarketDataRuntime, { MarketDataError } from '@deepseek-ai/dsh-market-data'
import type { Bar, MarketDataProvider } from '@deepseek-ai/dsh-market-data'
import * as ToolMarket from '@deepseek-ai/dsh-tool-market'

const signal = new AbortController().signal

const BARS: Bar[] = Array.from({ length: 120 }, (_unused, index) => ({
  date: `2026-01-${String((index % 28) + 1).padStart(2, '0')}`,
  open: 100 + index,
  high: 101 + index,
  low: 99 + index,
  close: 100.5 + index,
  volume: 1000 + index,
}))

/** A provider answering from fixed records, counting what it was asked. */
function stubProvider(): MarketDataProvider & { asked: { history?: number | undefined; filingsLimit?: number | undefined } } {
  const asked: { history?: number | undefined; filingsLimit?: number | undefined } = {}
  return {
    asked,
    id: 'stub',
    available: () => true,
    quote: async symbols => symbols.map(symbol => ({ symbol, close: 230.1, asOf: '2026-09-17' })),
    history: async (symbol, request) => {
      asked.history = request.limit
      const limit = request.limit ?? BARS.length
      return { symbol, bars: BARS.slice(-limit), truncated: BARS.length > limit }
    },
    profile: async symbol => ({ symbol, name: 'Stub Inc.', exchange: 'Nasdaq' }),
    filings: async (_symbol, request) => {
      asked.filingsLimit = request.limit
      return [{ form: '10-K', filedAt: '2026-02-01', url: 'https://www.sec.gov/x' }]
    },
  }
}

async function setup(config: Partial<ToolMarket.Config> = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(MarketDataRuntime, {
    secUserAgent: 'Jane Roe jane@example.com',
    timeoutMs: 1000,
    cacheTtlMs: 0,
    minRequestGapMs: 0,
    maxBodyBytes: 1024,
    builtinProvider: false,
  }).await()
  const provider = stubProvider()
  ctx.marketData.register(provider)
  await ctx.plugin(ToolMarket, { maxSymbols: 2, maxBars: 5, maxFilings: 3, summaryBars: 30, ...config })
  return { ctx, provider }
}

describe('the market tools', () => {
  it('registers all four on the model-visible registry', async () => {
    const { ctx } = await setup()
    const names = ctx.tools.schemas().map(schema => schema.name).sort()
    expect(names).toEqual(['market_filings', 'market_history', 'market_profile', 'market_quote'])
  })

  it('tells the model these are not investment advice', async () => {
    const { ctx } = await setup()
    for (const schema of ctx.tools.schemas()) {
      expect(schema.description).toContain('not investment advice')
    }
  })

  it('quotes and renders the close with its session date', async () => {
    const { ctx } = await setup()
    const result = await executeModelToolFixture(ctx, {
      signal, callId: ToolCallId('c1'), name: 'market_quote', arguments: { symbols: ['AAPL'] },
    })
    expect(result.isError).toBe(false)
    expect(text(result)).toContain('AAPL 230.10 as of 2026-09-17')
  })

  it('caps the symbols one quote call may name and says how many it dropped', async () => {
    const { ctx } = await setup()
    const result = await executeModelToolFixture(ctx, {
      signal, callId: ToolCallId('c1'), name: 'market_quote', arguments: { symbols: ['A', 'B', 'C', 'D'] },
    })
    const lines = text(result).split('\n')
    expect(lines).toHaveLength(3)
    expect(lines[2]).toContain('2 more requested symbols were not quoted')
  })

  it('caps history at the configured bar limit and says it truncated', async () => {
    const { ctx, provider } = await setup()
    const result = await executeModelToolFixture(ctx, {
      signal, callId: ToolCallId('c1'), name: 'market_history', arguments: { symbol: 'AAPL', limit: 500 },
    })
    expect(provider.asked.history).toBe(5)
    expect(text(result)).toContain('older ones omitted')
  })

  it('passes a date window through to the source', async () => {
    const { ctx } = await setup()
    const result = await executeModelToolFixture(ctx, {
      signal, callId: ToolCallId('c1'), name: 'market_history', arguments: { symbol: 'AAPL', from: '2026-01-01', to: '2026-01-05' },
    })
    expect(result.isError).toBe(false)
  })

  it('renders an issuer profile', async () => {
    const { ctx } = await setup()
    const result = await executeModelToolFixture(ctx, {
      signal, callId: ToolCallId('c1'), name: 'market_profile', arguments: { symbol: 'AAPL' },
    })
    expect(text(result)).toContain('Stub Inc.')
  })

  it('caps filings at the configured limit and says it capped them', async () => {
    const { ctx, provider } = await setup()
    const result = await executeModelToolFixture(ctx, {
      signal, callId: ToolCallId('c1'), name: 'market_filings', arguments: { symbol: 'AAPL', limit: 99 },
    })
    expect(provider.asked.filingsLimit).toBe(3)
    expect(text(result)).toContain('older ones omitted')
  })

  it('surfaces an unknown symbol as a tool error naming the symbol', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeToolExecutor)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(MarketDataRuntime, {
      secUserAgent: 'Jane Roe jane@example.com', builtinProvider: false,
      timeoutMs: 10_000, cacheTtlMs: 60_000, minRequestGapMs: 100, maxBodyBytes: 1_000_000,
    }).await()
    ctx.marketData.register({
      ...stubProvider(),
      id: 'unknown-symbols',
      quote: () => Promise.reject(new MarketDataError('the source carries no symbol "ZZZZ"', 'MARKET_SYMBOL_UNKNOWN')),
    })
    await ctx.plugin(ToolMarket, { maxSymbols: 2, maxBars: 5, maxFilings: 3, summaryBars: 30 })
    const result = await executeModelToolFixture(ctx, {
      signal, callId: ToolCallId('c1'), name: 'market_quote', arguments: { symbols: ['ZZZZ'] },
    })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('ZZZZ')
  })

  it('removes every tool and the command when its fiber is disposed', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(MarketDataRuntime, {
      secUserAgent: 'Jane Roe jane@example.com', builtinProvider: false,
      timeoutMs: 10_000, cacheTtlMs: 60_000, minRequestGapMs: 100, maxBodyBytes: 1_000_000,
    }).await()
    ctx.marketData.register(stubProvider())
    const fiber = ctx.plugin(ToolMarket, { maxSymbols: 2, maxBars: 5, maxFilings: 3, summaryBars: 30 })
    await fiber.await()
    expect(ctx.tools.schemas()).toHaveLength(4)
    expect(ctx.commands.find(fakeAgent(), 'market')).toBeDefined()
    await fiber.dispose()
    expect(ctx.tools.schemas()).toHaveLength(0)
    expect(ctx.commands.find(fakeAgent(), 'market')).toBeUndefined()
  })
})

describe('the /market command', () => {
  it('summarizes a symbol in one screen', async () => {
    const { ctx } = await setup()
    const command = ctx.commands.find(fakeAgent(), 'market')
    const result = await command!.handler({
      commandId: CommandId('c1'), agent: fakeAgent(), rawInput: 'AAPL', attachments: [], signal,
    })
    expect(result).toMatchObject({ kind: 'success' })
    const summary = (result as { text: string }).text
    expect(summary).toContain('Stub Inc.')
    expect(summary).toContain('range')
    expect(summary).toContain('not investment advice')
  })

  it('files the summary into an open research journal', async () => {
    const { ctx } = await setup()
    const recorded: { text: string; result?: string }[] = []
    ctx.provide('research', {
      storeFor: () => undefined,
      activeFor: () => ({ slug: 'markets', cwd: '/w' }),
      record: async (finding: { text: string; result?: string }) => void recorded.push(finding),
    } as never)
    const command = ctx.commands.find(fakeAgent(), 'market')
    await command!.handler({
      commandId: CommandId('c1'), agent: fakeAgent(), rawInput: 'AAPL', attachments: [], signal,
    })
    expect(recorded).toHaveLength(1)
    expect(recorded[0]?.text).toContain('AAPL')
    expect(recorded[0]?.result).toContain('Stub Inc.')
  })

  it('still summarizes when no research journal is open', async () => {
    const { ctx } = await setup()
    ctx.provide('research', {
      storeFor: () => undefined,
      activeFor: () => undefined,
      record: async () => { throw new Error('no journal is open; nothing should be recorded') },
    } as never)
    const command = ctx.commands.find(fakeAgent(), 'market')
    const result = await command!.handler({
      commandId: CommandId('c1'), agent: fakeAgent(), rawInput: 'AAPL', attachments: [], signal,
    })
    expect(result).toMatchObject({ kind: 'success' })
  })

  it('reports its usage when no symbol is given', async () => {
    const { ctx } = await setup()
    const command = ctx.commands.find(fakeAgent(), 'market')
    const result = await command!.handler({
      commandId: CommandId('c1'), agent: fakeAgent(), rawInput: '   ', attachments: [], signal,
    })
    expect(result).toMatchObject({ kind: 'error' })
  })
})

/** The command registry only reads identity here, so a bare object suffices. */
function fakeAgent() {
  return { id: 'market-agent' } as never
}

function text(result: { content: readonly { type: string; text?: string }[] }): string {
  return result.content.map(block => block.type === 'text' ? block.text ?? '' : '').join('')
}
