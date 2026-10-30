// Real composition: session storage, the JSONL persistence backend, the
// session-query engine, the storage domain and the usage plugin booted from a
// cordis.yml through the Loader. The reports below are derived from logs the
// plugin never watched being written, which is the property the package
// exists for.
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime, { ToolCallId, createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SqliteSessionQueryEngine from '@deepseek-ai/dsh-session-query-sqlite'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { executeModelToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import CommandRuntime, { CommandId } from '@deepseek-ai/dsh-commands'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as SessionUsage from '@deepseek-ai/dsh-session-usage'
import { sessionUsageCacheDomainSpec } from '@deepseek-ai/dsh-session-usage'
import * as SessionUsageTools from '@deepseek-ai/dsh-session-usage/tools'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

const directories: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

interface Home {
  /** Harness home holding the cordis.yml, the storage root, and the session logs. */
  readonly home: string
}

async function makeHome(label: string): Promise<Home> {
  const home = await mkdtemp(join(tmpdir(), `dsh-session-usage-${label}-`))
  directories.push(home)
  return { home }
}

/**
 * Boot the stack from a cordis.yml. `persistence` false leaves the durable
 * backend out, which is how the report behaves with live sessions only.
 */
async function boot(home: string, options: { persistence?: boolean } = {}): Promise<Context> {
  const persistence = options.persistence ?? true
  const configPath = join(home, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-llm'",
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-session-projection'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-tool-executor-native'",
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-agent-loop'",
    '  config:',
    '    agents: []',
    "- name: '@deepseek-ai/dsh-commands'",
    ...persistence
      ? [
        "- name: '@deepseek-ai/dsh-session-persistence-jsonl'",
        '  config:',
        `    root: ${JSON.stringify(join(home, 'sessions'))}`,
        '    compression: none',
      ]
      : [],
    "- name: '@deepseek-ai/dsh-session-query-sqlite'",
    '  config:',
    "    path: ':memory:'",
    '    openAt: never',
    "- name: '@deepseek-ai/dsh-storage'",
    "- name: '@deepseek-ai/dsh-storage-json'",
    '  config:',
    `    root: ${JSON.stringify(join(home, 'storages'))}`,
    "- name: '@deepseek-ai/dsh-storage-domain'",
    '  config:',
    '    backend: json',
    "- name: '@deepseek-ai/dsh-session-usage'",
    "- name: '@deepseek-ai/dsh-session-usage/tools'",
    '',
  ].join('\n'))

  const ctx = new Context()
  contexts.push(ctx)
  ctx.baseUrl = pathToFileURL(home).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-tool-executor-native', NativeToolExecutor],
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-agent-loop', AgentLoop],
    ['@deepseek-ai/dsh-commands', CommandRuntime],
    ['@deepseek-ai/dsh-session-persistence-jsonl', JsonlSessionPersistence],
    ['@deepseek-ai/dsh-session-query-sqlite', SqliteSessionQueryEngine],
    ['@deepseek-ai/dsh-storage', Storage],
    ['@deepseek-ai/dsh-storage-json', StorageJson],
    ['@deepseek-ai/dsh-storage-domain', StorageDomain],
    ['@deepseek-ai/dsh-session-usage', SessionUsage],
    ['@deepseek-ai/dsh-session-usage/tools', SessionUsageTools],
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
  return ctx
}

/** Local noon of a day, so no zone offset can move the day key. */
const noon = (year: number, month: number, day: number): number =>
  new Date(year, month - 1, day, 12, 0, 0).getTime()

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
async function writeSession(ctx: Context, id: string, turns: readonly Turn[]): Promise<SessionId> {
  const sessionId = SessionId(id)
  const writer = await ctx.sessionPersistence.create({
    version: SESSION_FORMAT_VERSION,
    id: sessionId,
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
  return sessionId
}

const usage = (input: number, output: number, extra: Partial<TokenUsage> = {}): TokenUsage =>
  ({ inputTokens: input, outputTokens: output, ...extra })

async function seedCorpus(ctx: Context): Promise<void> {
  await writeSession(ctx, 'usage-alpha', [
    { at: noon(2026, 9, 14), provider: 'deepseek', model: 'deepseek-chat', usage: usage(1000, 100, { cacheReadTokens: 400 }) },
    { at: noon(2026, 9, 16), provider: 'deepseek', model: 'deepseek-chat', usage: usage(2000, 200) },
  ])
  await writeSession(ctx, 'usage-beta', [
    { at: noon(2026, 9, 16), provider: 'zhipu', model: 'glm-4.6', usage: usage(500, 50, { reasoningTokens: 20 }) },
  ])
}

/** The live cache table, reached through the facility's diagnostic lookup. */
function cacheTable(ctx: Context): { put(key: string, value: unknown): Promise<void> } {
  const domain = ctx.storageDomain.get(sessionUsageCacheDomainSpec.name)
  expect(domain).toBeDefined()
  return domain!.table('sessions')
}

function commandText(result: unknown): string {
  return (result as { text?: string }).text ?? ''
}

async function runUsageCommand(ctx: Context): Promise<string> {
  const agent = await ctx.agentLoop.create(SessionId(`usage-caller-${Math.random().toString(36).slice(2)}`), {
    provider: 'mock', model: 'mock',
  })
  const signal = new AbortController().signal
  const command = ctx.commands.find(agent, 'usage')
  expect(command).toBeDefined()
  const result = await command!.handler({ commandId: CommandId('u'), agent, rawInput: '', attachments: [], signal })
  expect(result.kind).toBe('success')
  return commandText(result)
}

describe('session-usage real Loader composition through cordis.yml', () => {
  it('derives totals from durable logs the plugin never watched being written', async () => {
    const { home } = await makeHome('derive')
    const seeder = await boot(home)
    await seedCorpus(seeder)
    await seeder.fiber.dispose()
    contexts.splice(contexts.indexOf(seeder), 1)

    // A second process over the same home: nothing in memory, only the logs.
    const ctx = await boot(home)
    const report = await ctx.sessionUsage.report()
    expect(report.overall).toMatchObject({
      inputTokens: 3500, outputTokens: 350, cacheReadTokens: 400, cacheWriteTokens: 0, reasoningTokens: 20,
      messages: 3, sessions: 2,
    })
    expect(report.days.map(day => [day.day, day.totals.messages, day.totals.sessions])).toEqual([
      ['2026-09-14', 1, 1],
      ['2026-09-16', 2, 2],
    ])
    expect(report.byModel.map(entry => `${entry.provider}/${entry.model}`))
      .toEqual(['deepseek/deepseek-chat', 'zhipu/glm-4.6'])
  })

  it('answers a bounded slice with since and until', async () => {
    const { home } = await makeHome('slice')
    const ctx = await boot(home)
    await seedCorpus(ctx)
    expect((await ctx.sessionUsage.report({ since: '2026-09-16' })).overall)
      .toMatchObject({ inputTokens: 2500, messages: 2, sessions: 2 })
    expect((await ctx.sessionUsage.report({ until: '2026-09-15' })).overall)
      .toMatchObject({ inputTokens: 1000, messages: 1, sessions: 1 })
    expect((await ctx.sessionUsage.report({ since: '2026-10-01' })).overall.messages).toBe(0)
  })

  it('reuses cached folds and re-reads only the session whose log changed', async () => {
    const { home } = await makeHome('cache')
    const ctx = await boot(home)
    await seedCorpus(ctx)
    const first = await ctx.sessionUsage.report()

    const observe = vi.spyOn(ctx.sessionQuery, 'observeSession')
    const second = await ctx.sessionUsage.report()
    expect(second).toEqual(first)
    expect(observe).not.toHaveBeenCalled()

    // Append to one log; only that session is folded again.
    await writeSession(ctx, 'usage-gamma', [
      { at: noon(2026, 9, 17), provider: 'deepseek', model: 'deepseek-chat', usage: usage(11, 2) },
    ])
    const third = await ctx.sessionUsage.report()
    expect(observe.mock.calls.map(call => call[0])).toEqual([SessionId('usage-gamma')])
    expect(third.overall.messages).toBe(4)
    observe.mockRestore()
  })

  it('answers the same figures with an empty cache, only slower', async () => {
    const { home } = await makeHome('cold')
    const warm = await boot(home)
    await seedCorpus(warm)
    const warmed = await warm.sessionUsage.report()
    await warm.fiber.dispose()
    contexts.splice(contexts.indexOf(warm), 1)

    await rm(join(home, 'storages'), { recursive: true, force: true })
    const ctx = await boot(home)
    expect(await ctx.sessionUsage.report()).toEqual(warmed)
  })

  it('stops counting a session that has left the corpus', async () => {
    const { home } = await makeHome('delete')
    const ctx = await boot(home)
    await seedCorpus(ctx)
    expect((await ctx.sessionUsage.report()).overall.sessions).toBe(2)
    await ctx.sessionPersistence.delete(SessionId('usage-beta'))
    const after = await ctx.sessionUsage.report()
    expect(after.overall).toMatchObject({ messages: 2, sessions: 1, reasoningTokens: 0 })
    expect(after.byModel.map(entry => entry.model)).toEqual(['deepseek-chat'])
  })

  it('counts a live session with no durable log yet', async () => {
    const { home } = await makeHome('live')
    const ctx = await boot(home, { persistence: false })
    ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('hi')]))
    const agent = await ctx.agentLoop.create(SessionId('usage-live'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'start' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    const report = await ctx.sessionUsage.report()
    expect(report.overall.messages).toBe(1)
    expect(report.overall.sessions).toBe(1)
    expect(report.byModel[0]).toMatchObject({ provider: 'mock', model: 'mock' })
  })

  it('carries a live signal through the listing and every source read', async () => {
    const { home } = await makeHome('signal')
    const ctx = await boot(home)
    await seedCorpus(ctx)
    const controller = new AbortController()
    const report = await ctx.sessionUsage.report({ signal: controller.signal })
    expect(report.overall.messages).toBe(3)
  })

  it('refuses a bound that is not a calendar day instead of answering an empty slice', async () => {
    const { home } = await makeHome('bounds')
    const ctx = await boot(home)
    await seedCorpus(ctx)
    await expect(ctx.sessionUsage.report({ since: 'yesterday' })).rejects.toThrow(/since must be a local calendar day/)
    await expect(ctx.sessionUsage.report({ until: '9/16/2026' })).rejects.toThrow(/until must be a local calendar day/)
    const refused = await executeModelToolFixture(ctx, {
      name: 'usage',
      arguments: { since: 'last week' },
      callId: ToolCallId('usage-bad'),
      signal: new AbortController().signal,
    })
    expect(refused.isError).toBe(true)
  })

  it('still answers when the cache cannot be written', async () => {
    const { home } = await makeHome('unwritable')
    const ctx = await boot(home)
    await seedCorpus(ctx)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const put = vi.spyOn(cacheTable(ctx), 'put').mockRejectedValue(new Error('disk is full'))
    const report = await ctx.sessionUsage.report()
    expect(report.overall.messages).toBe(3)
    expect(warn.mock.calls.flat().join(' ')).toContain('could not cache')
    expect(warn.mock.calls.flat().join(' ')).toContain('disk is full')

    // A backend may reject with something that is not an Error.
    warn.mockClear()
    put.mockRejectedValue('storage offline')
    expect((await ctx.sessionUsage.report()).overall.messages).toBe(3)
    expect(warn.mock.calls.flat().join(' ')).toContain('storage offline')
    put.mockRestore()
    warn.mockRestore()
  })

  it('stops a scan on an aborted signal', async () => {
    const { home } = await makeHome('abort')
    const ctx = await boot(home)
    await seedCorpus(ctx)
    const controller = new AbortController()
    controller.abort()
    await expect(ctx.sessionUsage.report({ signal: controller.signal })).rejects.toThrow()
  })

  it('/usage prints totals, the model table and the day grid', async () => {
    const { home } = await makeHome('command')
    const ctx = await boot(home)
    await seedCorpus(ctx)
    const text = await runUsageCommand(ctx)
    expect(text).toContain('Total')
    expect(text).toContain('deepseek/deepseek-chat')
    expect(text).toContain('zhipu/glm-4.6')
    expect(text).toContain('Messages')
    expect(text).toMatch(/Last 12 weeks {2}\d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2}/)
    expect(text.split('\n').filter(line => /^ {2}(Sun|Mon|Tue|Wed|Thu|Fri|Sat) {2}/.test(line))).toHaveLength(7)
  })

  it('says plainly when nothing has been recorded', async () => {
    const { home } = await makeHome('empty')
    const ctx = await boot(home)
    expect(await runUsageCommand(ctx)).toBe('No token usage recorded in the session history.')
  })

  it('gives the model the same figures through the usage tool', async () => {
    const { home } = await makeHome('tool')
    const ctx = await boot(home)
    await seedCorpus(ctx)
    const result = await executeModelToolFixture(ctx, {
      name: 'usage',
      arguments: { since: '2026-09-16' },
      callId: ToolCallId('usage-1'),
      signal: new AbortController().signal,
    })
    expect(result.isError).toBe(false)
    const text = result.content.map(block => block.type === 'text' ? block.text : '').join('\n')
    expect(text).toContain('zhipu/glm-4.6')
    // The bound drops 2026-09-14 entirely: 2,000 + 500 input, 200 + 50 output.
    expect(text).toContain('Total          2,750  tokens')
    expect(text).toContain('Messages           2  across 2 sessions')

    const unbounded = await executeModelToolFixture(ctx, {
      name: 'usage',
      arguments: {},
      callId: ToolCallId('usage-2'),
      signal: new AbortController().signal,
    })
    expect(unbounded.isError).toBe(false)
    expect(unbounded.content.map(block => block.type === 'text' ? block.text : '').join('\n'))
      .toContain('Messages           3  across 2 sessions')

    const ended = await executeModelToolFixture(ctx, {
      name: 'usage',
      arguments: { until: '2026-09-15' },
      callId: ToolCallId('usage-3'),
      signal: new AbortController().signal,
    })
    expect(ended.content.map(block => block.type === 'text' ? block.text : '').join('\n'))
      .toContain('Messages           1  across 1 session')
  })

  it('takes /usage and the usage tool away with the fiber', async () => {
    const { home } = await makeHome('dispose')
    const ctx = await boot(home)
    const agent = await ctx.agentLoop.create(SessionId('usage-dispose'), { provider: 'mock', model: 'mock' })
    expect(ctx.commands.find(agent, 'usage')).toBeDefined()
    expect(ctx.tools.get('usage')).toBeDefined()
    const entry = [...ctx.loader.entries()].find(row => row.options.name === '@deepseek-ai/dsh-session-usage')
    await entry?.fiber?.dispose()
    expect(ctx.commands.find(agent, 'usage')).toBeUndefined()
    expect(ctx.tools.get('usage')).toBeUndefined()
  })

  it('names the damaged session rather than quietly dropping it from the totals', async () => {
    const { home } = await makeHome('corrupt')
    const seeder = await boot(home)
    await seedCorpus(seeder)
    await seeder.fiber.dispose()
    contexts.splice(contexts.indexOf(seeder), 1)

    // Replace one committed event line with an unparsable one, the shape a
    // crash mid-append leaves behind.
    const entries = await readdir(join(home, 'sessions'), { recursive: true, withFileTypes: true })
    const log = entries
      .filter(entry => entry.isFile() && entry.name.endsWith('.jsonl') && entry.parentPath.includes('usage-beta'))
      .map(entry => join(entry.parentPath, entry.name))[0]
    expect(log).toBeDefined()
    const lines = (await readFile(log!, 'utf8')).split('\n').filter(line => line.length > 0)
    lines[3] = '{"type":"assistant/message","seq":99,"time":"nope"'
    await writeFile(log!, lines.join('\n') + '\n')

    const ctx = await boot(home)
    // Omitting the session would understate spend with nothing to show it, so
    // the report fails and names the session and its file instead.
    await expect(ctx.sessionUsage.report()).rejects.toThrow(/usage-beta.*corrupt/s)
  })
})
