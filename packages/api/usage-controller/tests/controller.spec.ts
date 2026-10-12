// Real composition: session storage, the JSONL persistence backend, the
// session-query engine, the storage domain and the usage plugin, so the
// controller projects figures the service really folded from durable logs.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import LlmRuntime, { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SqliteSessionQueryEngine from '@deepseek-ai/dsh-session-query-sqlite'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as SessionUsage from '@deepseek-ai/dsh-session-usage'
import UsageController, { usageTotalsValue } from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function setup(): Promise<{ ctx: Context; controller: UsageController }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-usage-controller-'))
  const ctx = new Context()
  context = ctx
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'none' })
  await ctx.plugin(SqliteSessionQueryEngine, { path: ':memory:', openAt: 'never' })
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: join(root, 'storages') })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(SessionUsage)
  await ctx.plugin(UsageController)
  const controller = ctx.get('usageController') as UsageController
  return { ctx, controller }
}

/** Local noon of a day, so no zone offset can move the day key. */
const noon = (year: number, month: number, day: number): number =>
  new Date(year, month - 1, day, 12, 0, 0).getTime()

const usage = (input: number, output: number, extra: Partial<TokenUsage> = {}): TokenUsage =>
  ({ inputTokens: input, outputTokens: output, ...extra })

interface Turn {
  readonly at: number
  readonly provider: string
  readonly model: string
  readonly usage: TokenUsage
}

/** One well-formed turn: the boundary events plus the settled assistant message. */
function turnEvents(turn: number, entry: Turn): Omit<SessionEvent, 'seq'>[] {
  return [
    { type: 'turn/start', time: entry.at, data: { turn } },
    {
      type: 'user/message',
      time: entry.at,
      surfaceOp: 'append',
      data: createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }),
    },
    { type: 'step/start', time: entry.at, data: { turn, step: 1 } },
    {
      type: 'assistant/message',
      time: entry.at,
      surfaceOp: 'append',
      data: {
        turn,
        step: 1,
        message: createAssistantMessage({
          content: [{ type: 'text', text: 'done' }],
          source: { provider: entry.provider, model: entry.model },
        }),
        stream: [],
        usage: entry.usage,
      },
    },
    { type: 'step/end', time: entry.at, data: { turn, step: 1 } },
    { type: 'turn/end', time: entry.at, data: { turn, reason: { kind: 'complete' } } },
  ] as unknown as Omit<SessionEvent, 'seq'>[]
}

/** Write one durable session log made of the given turns. */
async function writeSession(ctx: Context, id: string, turns: readonly Turn[]): Promise<void> {
  const writer = await ctx.sessionPersistence.create({
    version: SESSION_FORMAT_VERSION,
    id: SessionId(id),
    createdAt: turns[0]?.at ?? 1,
    cwd: '/work',
    isSeeded: false,
  })
  let seq = 0
  const events: SessionEvent[] = []
  turns.forEach((entry, index) => {
    for (const event of turnEvents(index + 1, entry)) {
      events.push({ ...event, seq: SessionSeq(seq) } as SessionEvent)
      seq += 1
    }
  })
  await writer.append(events)
  await writer.close()
}

async function seedCorpus(ctx: Context): Promise<void> {
  await writeSession(ctx, 'usage-alpha', [
    { at: noon(2026, 9, 14), provider: 'deepseek', model: 'deepseek-chat', usage: usage(1000, 100, { cacheReadTokens: 400, cacheWriteTokens: 30 }) },
    { at: noon(2026, 9, 16), provider: 'deepseek', model: 'deepseek-chat', usage: usage(2000, 200) },
  ])
  await writeSession(ctx, 'usage-beta', [
    { at: noon(2026, 9, 16), provider: 'zhipu', model: 'glm-4.6', usage: usage(500, 50, { reasoningTokens: 20 }) },
  ])
}

describe('UsageController', () => {
  it('publishes the usage namespace with one direct report method', async () => {
    const { controller } = await setup()
    expect(controller.typertRemote).toMatchObject({ serviceKey: 'usageController', namespace: 'usage' })
    expect(remoteMethods(controller)).toEqual([{ method: 'report', invocation: { kind: 'direct' } }])
  })

  it('projects the whole report: overall totals, ascending days, and models by size', async () => {
    const { ctx, controller } = await setup()
    await seedCorpus(ctx)
    const value = await controller.report({})
    expect(value.overall).toEqual({
      inputTokens: 3500, outputTokens: 350, cacheReadTokens: 400, cacheWriteTokens: 30, reasoningTokens: 20,
      totalTokens: 4280, messages: 3, sessions: 2,
    })
    expect(value.days.map(day => [day.day, day.totals.totalTokens])).toEqual([
      ['2026-09-14', 1530],
      ['2026-09-16', 2750],
    ])
    expect(value.byModel.map(entry => [`${entry.provider}/${entry.model}`, entry.totals.totalTokens])).toEqual([
      ['deepseek/deepseek-chat', 3730],
      ['zhipu/glm-4.6', 550],
    ])
  })

  it('sums the billable buckets and never adds reasoning on top of output', () => {
    expect(usageTotalsValue({
      inputTokens: 10, outputTokens: 7, cacheReadTokens: 3, cacheWriteTokens: 1, reasoningTokens: 5,
      messages: 1, sessions: 1,
    })).toMatchObject({ totalTokens: 21, reasoningTokens: 5 })
  })

  it('omits a day with no usage from the series rather than reporting it as zero', async () => {
    const { ctx, controller } = await setup()
    await seedCorpus(ctx)
    expect((await controller.report({})).days.map(day => day.day)).not.toContain('2026-09-15')
  })

  it('bounds a slice by since and until', async () => {
    const { ctx, controller } = await setup()
    await seedCorpus(ctx)
    expect((await controller.report({ since: '2026-09-16' })).overall)
      .toMatchObject({ inputTokens: 2500, totalTokens: 2750, messages: 2, sessions: 2 })
    expect((await controller.report({ until: '2026-09-15' })).overall)
      .toMatchObject({ inputTokens: 1000, totalTokens: 1530, messages: 1, sessions: 1 })
  })

  it('rejects a bound that is not a calendar day instead of answering an empty slice', async () => {
    const { ctx, controller } = await setup()
    await seedCorpus(ctx)
    await expect(controller.report({ since: 'yesterday' })).rejects.toThrow(/since must be a local calendar day/)
    await expect(controller.report({ until: '9/16/2026' })).rejects.toThrow(/until must be a local calendar day/)
  })

  it('answers empty totals for a corpus with no recorded usage', async () => {
    const { controller } = await setup()
    const value = await controller.report({})
    expect(value.overall).toMatchObject({ totalTokens: 0, messages: 0, sessions: 0 })
    expect(value.days).toEqual([])
    expect(value.byModel).toEqual([])
  })
})
