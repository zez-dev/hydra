// Real composition: the market-data seam and its tools booted from a cordis.yml
// through the Loader, with the source's HTTP edge stubbed. A `market_quote`
// call reaches the model as rendered text, and `/market` summarizes a symbol.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { executeModelToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import CommandRuntime, { CommandId } from '@deepseek-ai/dsh-commands'
import MarketDataRuntime from '@deepseek-ai/dsh-market-data'
import type { FetchLike } from '@deepseek-ai/dsh-market-data'
import * as ToolMarket from '@deepseek-ai/dsh-tool-market'
import { EDGAR_SUBMISSIONS, EDGAR_TICKERS, STOOQ_AAPL } from '../../market-data/tests/fixtures.ts'

let home: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (home !== undefined) await rm(home, { recursive: true, force: true })
  home = undefined
})

/** Answer each allowed URL from its recorded body; no socket is opened. */
const routes: FetchLike = async (url) => {
  const body = url.startsWith('https://stooq.com/') ? STOOQ_AAPL
    : url === 'https://www.sec.gov/files/company_tickers.json' ? EDGAR_TICKERS
      : url.startsWith('https://data.sec.gov/submissions/') ? EDGAR_SUBMISSIONS
        : undefined
  if (body === undefined) return { ok: false, status: 404, text: async () => '' }
  return { ok: true, status: 200, text: async () => body }
}

async function boot(): Promise<Context> {
  home = await mkdtemp(join(tmpdir(), 'dsh-market-loader-'))
  const configPath = join(home, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-tool-executor-native'",
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-commands'",
    "- name: '@deepseek-ai/dsh-market-data'",
    '  config:',
    '    secUserAgent: Jane Roe jane@example.com',
    "- name: '@deepseek-ai/dsh-tool-market'",
    '  config:',
    '    maxSymbols: 5',
    '    maxBars: 10',
    '    maxFilings: 3',
    '    summaryBars: 30',
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(home).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-tool-executor-native', NativeToolExecutor],
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-commands', CommandRuntime],
    ['@deepseek-ai/dsh-market-data', MarketDataRuntime],
    ['@deepseek-ai/dsh-tool-market', ToolMarket],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  // The Loader passes only config, so the stub transport is installed here,
  // before the first call builds the built-in provider.
  ctx.marketData.internals = { fetch: routes }
  return ctx
}

describe('market tools through a real Loader composition', () => {
  it('serves a quote to the model as rendered text', async () => {
    const ctx = await boot()
    const result = await executeModelToolFixture(ctx, {
      signal: new AbortController().signal,
      callId: ToolCallId('c1'),
      name: 'market_quote',
      arguments: { symbols: ['AAPL'] },
    })
    expect(result.isError).toBe(false)
    const text = result.content.map(block => block.type === 'text' ? block.text : '').join('')
    expect(text).toContain('AAPL 230.10')
    expect(text).toContain('2026-09-17')
  })

  it('summarizes a symbol through /market with its filings', async () => {
    const ctx = await boot()
    const agent = { id: 'market-loader' } as never
    const command = ctx.commands.find(agent, 'market')
    const result = await command!.handler({
      commandId: CommandId('c1'), agent, rawInput: 'AAPL', attachments: [], signal: new AbortController().signal,
    })
    const summary = (result as { text: string }).text
    expect(summary).toContain('Apple Inc.')
    expect(summary).toContain('10-Q')
    expect(summary).toContain('not investment advice')
  })
})
