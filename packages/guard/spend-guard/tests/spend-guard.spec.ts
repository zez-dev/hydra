import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import CommandRuntime, { CommandId } from '@deepseek-ai/dsh-commands'
import GoalService from '@deepseek-ai/dsh-goal'
import * as Notify from '@deepseek-ai/dsh-notify'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as SpendGuard from '@deepseek-ai/dsh-spend-guard'
import type { Config } from '@deepseek-ai/dsh-spend-guard'
import { localDateKey } from '@deepseek-ai/dsh-util-time'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

let storages: string | undefined
let context: Context | undefined
/** The spend guard's own plugin fiber in the current test's context. */
let guard: { dispose(): Promise<void> } | undefined
/** Local webhook endpoints opened by the current test. */
const servers: Server[] = []

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  guard = undefined
  if (storages !== undefined) await rm(storages, { recursive: true, force: true })
  storages = undefined
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve) => { server.close(() => { resolve() }) })))
})

const signal = new AbortController().signal

async function setup(adapter: MockAdapter, config: Partial<Config> = {}): Promise<Context> {
  storages = await mkdtemp(join(tmpdir(), 'dsh-spend-storages-'))
  const ctx = new Context()
  context = ctx
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['mock'], adapter)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(GoalService)
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: storages })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  guard = await ctx.plugin(SpendGuard, { action: 'pause-goal', ...config })
  return ctx
}

function say(text: string) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('condition not met in time')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/** The text `/spend` prints for an agent. */
async function spendReport(ctx: Context, agent: Agent): Promise<string> {
  const result = await ctx.commands.find(agent, 'spend')!.handler({ commandId: CommandId('c'), agent, rawInput: '', attachments: [], signal })
  return (result as { text: string }).text
}

/** One notification body a webhook channel received. */
interface Posted {
  readonly event: string
  readonly title: string
  readonly text: string
  readonly sessionId?: string
}

/**
 * Mount the notify plugin with one webhook channel served on a local port.
 * @returns the bodies the channel receives, in arrival order.
 */
async function notifyThroughWebhook(ctx: Context): Promise<Posted[]> {
  const posted: Posted[] = []
  const server = createServer((request, response) => {
    let raw = ''
    request.on('data', (chunk: Buffer) => { raw += chunk.toString() })
    request.on('end', () => {
      posted.push(JSON.parse(raw) as Posted)
      response.end()
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const { port } = server.address() as AddressInfo
  await ctx.plugin(Notify, {
    channels: [{ name: 'hook', kind: 'webhook', url: `http://127.0.0.1:${String(port)}/hook` }],
    events: {
      goalBlocked: false, goalCompleted: false, transientRetriesExhausted: false, sessionError: false, cronRun: false,
      spendBudgetReached: false, researchBreakthrough: false, dailyDigest: false, weeklyDigest: false, offPeakDrained: false,
    },
    minIntervalMs: 0,
    timeoutMs: 5000,
  })
  return posted
}

/** Append one model step reporting `usage` to a session, as the loop records it. */
function reportUsage(session: Session, usage: TokenUsage): void {
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: createAssistantMessage({ content: [{ type: 'text', text: 'ok' }], source: { provider: 'mock', model: 'mock' } }),
    stream: [],
    usage,
  }, { surfaceOp: 'append' })
}

describe('spend guard', () => {
  it('formats the local date key', () => {
    expect(localDateKey(new Date(2026, 8, 20, 23, 59))).toBe('2026-09-20')
    expect(localDateKey(new Date(2026, 0, 5, 0, 0))).toBe('2026-01-05')
  })

  it('accounts provider usage per session and per day', async () => {
    const ctx = await setup(new MockAdapter([textResponse('hello'), textResponse('again')]))
    const agent = await ctx.agentLoop.create(SessionId('spend-a'), { provider: 'mock', model: 'mock' })
    agent.followup(say('one'))
    await agent.whenIdle()
    agent.followup(say('two'))
    await agent.whenIdle()
    // textResponse reports 10 input tokens plus one output token per character.
    expect(ctx.spendGuard.sessionTokens(agent.id)).toBe(10 + 5 + 10 + 5)
    expect(ctx.spendGuard.dayTokens()).toBe(30)
  })

  it('pauses the goal and notifies the model when the session budget is crossed', async () => {
    const ctx = await setup(new MockAdapter([textResponse('working'), textResponse('more'), textResponse('more')]), { perSessionTokens: 20 })
    const agent = await ctx.agentLoop.create(SessionId('spend-b'), { provider: 'mock', model: 'mock' })
    const goal = ctx.goals.create(agent, { objective: 'never stop' })
    ctx.goals.disarm(agent)
    expect(goal.phase).toBe('active')
    agent.followup(say('go'))
    await agent.whenIdle()
    expect(ctx.goals.get(agent)?.phase).toBe('active')
    agent.followup(say('again'))
    await agent.whenIdle()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(ctx.goals.get(agent)?.phase).toBe('paused')
    // The notice waits in the inbox for the next request rather than being logged now.
    expect(agent.inbox.nextStep.some(message => message.source.kind === 'plugin:dsh-spend-guard')).toBe(true)
  })

  it('stops the turn under action: stop when the daily budget is crossed', async () => {
    const ctx = await setup(new MockAdapter([textResponse('a'), textResponse('b'), textResponse('c')]), { perDayTokens: 15, action: 'stop' })
    const agent = await ctx.agentLoop.create(SessionId('spend-c'), { provider: 'mock', model: 'mock' })
    agent.followup(say('one'))
    await agent.whenIdle()
    expect(ctx.spendGuard.dayTokens()).toBe(11)
    agent.followup(say('two'))
    await agent.whenIdle()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(ctx.spendGuard.dayTokens()).toBeGreaterThanOrEqual(22)
    expect(ctx.spendGuard.status(agent.id).dayExceeded).toBe(true)
  })

  it('keeps daily totals across a restart of the plugin', async () => {
    const ctx = await setup(new MockAdapter([textResponse('persist')]))
    const agent = await ctx.agentLoop.create(SessionId('spend-d'), { provider: 'mock', model: 'mock' })
    agent.followup(say('x'))
    await agent.whenIdle()
    const before = ctx.spendGuard.dayTokens()
    expect(before).toBe(17)
    await ctx.spendGuard.settled()
    await ctx.fiber.dispose()
    const again = new Context()
    context = again
    await again.plugin(LlmRuntime)
    await again.plugin(SystemPrompt)
    await again.plugin(ToolRuntime)
    await again.plugin(NativeToolExecutor)
    await again.plugin(SessionStore)
    await again.plugin(SessionProjectionRegistry)
    await again.plugin(AgentRegistry)
    await again.plugin(AgentLoop, { agents: [] })
    await again.plugin(CommandRuntime)
    await again.plugin(Storage)
    await again.plugin(StorageJson, { root: storages! })
    await again.plugin(StorageDomain, { backend: 'json' })
    await again.plugin(SpendGuard, { action: 'pause-goal' })
    expect(again.spendGuard.dayTokens()).toBe(17)
  })

  it('/spend reports totals against the budgets', async () => {
    const ctx = await setup(new MockAdapter([textResponse('hi')]), { perSessionTokens: 1000 })
    const agent = await ctx.agentLoop.create(SessionId('spend-e'), { provider: 'mock', model: 'mock' })
    agent.followup(say('x'))
    await agent.whenIdle()
    const command = ctx.commands.find(agent, 'spend')!
    const result = await command.handler({ commandId: CommandId('c'), agent, rawInput: '', attachments: [], signal }) as { kind: string; text?: string }
    expect(result.kind).toBe('success')
    expect(result.text).toContain('12 / 1000')
    expect(result.text).toContain('unlimited')
  })

  it('writes pending day totals and releases its storage when disposed, so a remount reopens them', async () => {
    const ctx = await setup(new MockAdapter([]))
    const session = ctx.sessions.create(SessionId('spend-remount'))
    reportUsage(session, { inputTokens: 10, outputTokens: 5 })
    reportUsage(session, { inputTokens: 20, outputTokens: 5 })
    await guard!.dispose()
    await ctx.plugin(SpendGuard, { action: 'pause-goal' })
    expect(ctx.spendGuard.dayTokens()).toBe(40)
  })

  it('does not activate without an action', () => {
    // The policy is self-contained, so misconfiguration fails at the schema and
    // no fiber reaches activation. Mounting the invalid config to observe this
    // leaves the fiber's own reload rejection unhandled, which vitest reports as
    // an error even though every assertion passes.
    expect(() => SpendGuard.Config({} as never)).toThrow('$.action missing required value')
  })
})

describe('spend guard enforcement edges', () => {
  it.each([
    [{ perSessionTokens: 12 }, 'Token budget reached (session)', 'Session 13 / 12, today 13. Action: pause-goal.'],
    [{ perDayTokens: 12, action: 'stop' as const }, 'Token budget reached (day)', 'Session 13, today 13 / 12. Action: stop.'],
  ])('announces a crossed budget through notify with %o', async (config, title, text) => {
    const ctx = await setup(new MockAdapter([textResponse('ok!')]), config)
    const posted = await notifyThroughWebhook(ctx)
    const agent = await ctx.agentLoop.create(SessionId('spend-notify'), { provider: 'mock', model: 'mock' })
    agent.followup(say('go'))
    await agent.whenIdle()
    await until(() => posted.length === 1)
    expect(posted[0]).toMatchObject({ event: 'spendBudgetReached', title, text, sessionId: 'spend-notify' })
  })

  it('/spend marks each crossed budget', async () => {
    const ctx = await setup(new MockAdapter([textResponse('ok!')]), { perSessionTokens: 12, perDayTokens: 12 })
    const agent = await ctx.agentLoop.create(SessionId('spend-over'), { provider: 'mock', model: 'mock' })
    agent.followup(say('go'))
    await agent.whenIdle()
    expect(await spendReport(ctx, agent)).toBe([
      'This session: 13 / 12 tokens (budget reached)',
      'Today: 13 / 12 tokens (budget reached)',
      'On budget: pause-goal',
    ].join('\n'))
  })

  it('counts a session that has no live agent without enforcing anything', async () => {
    const ctx = await setup(new MockAdapter([]), { perSessionTokens: 10 })
    const warn = vi.spyOn(ctx.logger, 'warn')
    const session = ctx.sessions.create(SessionId('spend-unowned'))
    reportUsage(session, { inputTokens: 30, outputTokens: 5 })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(ctx.spendGuard.status(session.id)).toMatchObject({ sessionTokens: 35, dayTokens: 35, sessionExceeded: true })
    expect(warn.mock.calls.flat().some(message => String(message).includes('budget reached'))).toBe(false)
  })

  it('drops an enforcement still waiting for its tick when the guard is disposed', async () => {
    const ctx = await setup(new MockAdapter([]), { perSessionTokens: 12 })
    const agent = await ctx.agentLoop.create(SessionId('spend-disposed'), { provider: 'mock', model: 'mock' })
    ctx.goals.create(agent, { objective: 'keep going' })
    ctx.goals.disarm(agent)
    reportUsage(agent.session, { inputTokens: 10, outputTokens: 3 })
    await guard!.dispose()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(ctx.goals.get(agent)?.phase).toBe('active')
    expect(agent.inbox.nextStep.some(message => message.source.kind === 'plugin:dsh-spend-guard')).toBe(false)
  })

  it('forgets a disposed agent\'s session total, so a new agent on that session is budgeted afresh', async () => {
    const ctx = await setup(new MockAdapter([textResponse('ok!'), textResponse('ok!')]), { perSessionTokens: 12 })
    const id = SessionId('spend-again')
    const first = await ctx.agents.create({ sessionId: id, agentOptions: { provider: 'mock', model: 'mock' } })
    first.agent.followup(say('one'))
    await first.agent.whenIdle()
    await until(() => first.agent.inbox.nextStep.some(message => message.source.kind === 'plugin:dsh-spend-guard'))
    await first.dispose()
    expect(ctx.spendGuard.sessionTokens(id)).toBe(0)
    expect(ctx.spendGuard.dayTokens()).toBe(13)
    const second = await ctx.agents.create({ sessionId: id, agentOptions: { provider: 'mock', model: 'mock' } })
    second.agent.followup(say('two'))
    await second.agent.whenIdle()
    await until(() => second.agent.inbox.nextStep.some(message => message.source.kind === 'plugin:dsh-spend-guard'))
    expect(ctx.spendGuard.sessionTokens(id)).toBe(13)
  })

  it('writes no day record for a step that reports zero tokens', async () => {
    const ctx = await setup(new MockAdapter([]))
    const session = ctx.sessions.create(SessionId('spend-zero'))
    reportUsage(session, { inputTokens: 0, outputTokens: 0 })
    expect(ctx.spendGuard.status(session.id)).toMatchObject({ sessionTokens: 0, dayTokens: 0 })
    await guard!.dispose()
    const domain = await ctx.storageDomain.open(SpendGuard.spendGuardDomainSpec)
    try {
      expect(domain.table('days').get(localDateKey(new Date()))).toBeUndefined()
    } finally {
      await domain.close()
    }
  })

  it('logs a day total it cannot write and keeps counting in memory', async () => {
    const ctx = await setup(new MockAdapter([]))
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    // A file where the storage directory was leaves the backend nowhere to write.
    await rm(storages!, { recursive: true, force: true })
    await writeFile(storages!, 'not a directory')
    const session = ctx.sessions.create(SessionId('spend-unwritable'))
    reportUsage(session, { inputTokens: 10, outputTokens: 5 })
    await ctx.spendGuard.settled()
    expect(ctx.spendGuard.dayTokens()).toBe(15)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('spend-guard: could not persist today\'s total: '))
  })
})
