import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import AgentRegistry, { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import CommandRuntime, { CommandId } from '@deepseek-ai/dsh-commands'
import GoalService from '@deepseek-ai/dsh-goal'
import * as Notify from '@deepseek-ai/dsh-notify'
import { renderNotification, type NotifyConfig } from '@deepseek-ai/dsh-notify'

interface Received { path: string; headers: Record<string, string | string[] | undefined>; body: unknown }

let server: Server | undefined
let received: Received[] = []
let baseUrl = ''
let context: Context | undefined
let root: string | undefined

async function listen(): Promise<void> {
  received = []
  server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk: Buffer) => { raw += chunk.toString() })
    req.on('end', () => {
      received.push({ path: req.url ?? '', headers: req.headers, body: raw.length === 0 ? undefined : JSON.parse(raw) })
      res.statusCode = req.url?.includes('fail') ? 500 : 200
      res.end('{"ok":true}')
    })
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no address')
  baseUrl = `http://127.0.0.1:${address.port}`
}

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (server !== undefined) await new Promise<void>((resolve) => { server!.close(() => { resolve() }) })
  server = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('condition not met in time')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

function config(overrides: Partial<NotifyConfig> = {}): NotifyConfig {
  return {
    channels: [{ name: 'hook', kind: 'webhook', url: `${baseUrl}/hook`, headers: { 'x-token': 'abc' } }],
    events: {
      goalBlocked: true, goalCompleted: true, transientRetriesExhausted: true, sessionError: true,
      cronRun: false,
      spendBudgetReached: false, researchBreakthrough: false,
      dailyDigest: true, weeklyDigest: true, offPeakDrained: true,
    },
    minIntervalMs: 0,
    timeoutMs: 5000,
    ...overrides,
  }
}

async function setup(cfg: NotifyConfig, withCredentials?: Record<string, string>): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-notify-'))
  const ctx = new Context()
  context = ctx
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(GoalService)
  if (withCredentials !== undefined) {
    ctx.provide('credentials', {
      resolve: async (ref: string) => withCredentials[ref] === undefined ? undefined : { value: withCredentials[ref], source: 'test' },
    } as never)
  }
  await ctx.plugin(Notify, cfg)
  return ctx
}

async function fakeAgent(ctx: Context, id = 'notify-agent'): Promise<Agent> {
  const scope = ctx.plugin(() => {})
  const session = ctx.sessions.create(SessionId(id), { meta: { cwd: root! } })
  const agent: Agent = {
    id: SessionId(id), options: {}, session, inbox: unsupportedInbox(),
    status: 'idle', ctx: scope.ctx,
    followup: () => {}, steer: () => {}, inject: () => {}, send: () => {}, cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  await ctx.agents.register(agent)
  return agent
}

const signal = new AbortController().signal

describe('notification rendering', () => {
  it('renders a title and text per event', () => {
    const rendered = renderNotification({ event: 'goalBlocked', sessionId: SessionId('s'), title: 'Goal blocked', text: 'round-limit: done', at: '2026-09-20T00:00:00.000Z' })
    expect(rendered).toContain('Goal blocked')
    expect(rendered).toContain('round-limit')
    expect(rendered).toContain('s')
  })
})

describe('channels', () => {
  it('posts the JSON payload with headers to a webhook channel', async () => {
    await listen()
    const ctx = await setup(config())
    await ctx.notify.send({ event: 'goalCompleted', title: 'Done', text: 'objective reached', sessionId: SessionId('s1') })
    await until(() => received.length === 1)
    expect(received[0]).toMatchObject({ path: '/hook', headers: { 'x-token': 'abc' }, body: { event: 'goalCompleted', title: 'Done', text: 'objective reached', sessionId: 's1' } })
  })

  it('sends a Telegram message with the token from the credential seam and a Discord content body', async () => {
    await listen()
    const ctx = await setup(config({
      channels: [
        { name: 'tg', kind: 'telegram', botTokenEnv: 'TG_TOKEN', chatId: '42', apiBaseUrl: `${baseUrl}/telegram` },
        { name: 'dc', kind: 'discord', url: `${baseUrl}/discord` },
      ],
    }), { TG_TOKEN: 'secret-token' })
    await ctx.notify.send({ event: 'goalCompleted', title: 'Ticket', text: 'high: crash', sessionId: SessionId('s1') })
    await ctx.notify.send({ event: 'researchBreakthrough', title: 'Needs a human', text: 'stuck after 3 attempts', sessionId: SessionId('s1') })
    await until(() => received.length === 4)
    const telegram = received.find(entry => entry.path.startsWith('/telegram'))!
    expect(telegram.path).toBe('/telegram/botsecret-token/sendMessage')
    expect(telegram.body).toMatchObject({ chat_id: '42' })
    expect((telegram.body as { text: string }).text).toContain('crash')
    const discord = received.find(entry => entry.path === '/discord')!
    expect((discord.body as { content: string }).content).toContain('Ticket')
  })

  it('drops a send inside the per-channel minimum interval and logs a failure without throwing', async () => {
    await listen()
    const ctx = await setup(config({ minIntervalMs: 60_000, channels: [{ name: 'hook', kind: 'webhook', url: `${baseUrl}/hook` }, { name: 'bad', kind: 'webhook', url: `${baseUrl}/fail` }] }))
    await ctx.notify.send({ event: 'goalCompleted', title: 'one', text: '', sessionId: SessionId('s1') })
    await ctx.notify.send({ event: 'goalCompleted', title: 'two', text: '', sessionId: SessionId('s1') })
    await until(() => received.length === 2)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(received.filter(entry => entry.path === '/hook')).toHaveLength(1)
    expect(received.filter(entry => entry.path === '/fail')).toHaveLength(1)
  })

  it('skips a telegram channel whose token is unresolved', async () => {
    await listen()
    const ctx = await setup(config({ channels: [{ name: 'tg', kind: 'telegram', botTokenEnv: 'MISSING', chatId: '1', apiBaseUrl: `${baseUrl}/telegram` }] }), {})
    await ctx.notify.send({ event: 'goalCompleted', title: 'x', text: '', sessionId: SessionId('s1') })
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(received).toHaveLength(0)
  })
})

describe('event listeners', () => {
  it('notifies on goal block, transient exhaustion, and completion with the right event names', async () => {
    await listen()
    const ctx = await setup(config())
    const agent = await fakeAgent(ctx)
    const goal = ctx.goals.create(agent, { objective: '[qa] ship it' })
    ctx.goals.block(agent, { id: goal.id, revision: goal.revision }, { code: 'transient-retries-exhausted', message: 'network' })
    await until(() => received.length === 1)
    expect(received[0]!.body).toMatchObject({ event: 'transientRetriesExhausted' })
    const resumed = ctx.goals.resume(agent, { id: goal.id, revision: ctx.goals.get(agent)!.revision })
    ctx.goals.block(agent, { id: resumed.id, revision: resumed.revision }, { code: 'round-limit', message: 'cap' })
    await until(() => received.length === 2)
    expect(received[1]!.body).toMatchObject({ event: 'goalBlocked' })
    const again = ctx.goals.resume(agent, { id: goal.id, revision: ctx.goals.get(agent)!.revision })
    ctx.goals.complete(agent, { id: again.id, revision: again.revision })
    await until(() => received.length === 3)
    expect(received[2]!.body).toMatchObject({ event: 'goalCompleted' })
  })

  it('notifies on agent errors and honors disabled events', async () => {
    await listen()
    const ctx = await setup(config({
      events: {
        goalBlocked: false, goalCompleted: false, transientRetriesExhausted: false, sessionError: true,
        cronRun: false,
        spendBudgetReached: false, researchBreakthrough: false,
        dailyDigest: false, weeklyDigest: false, offPeakDrained: false,
      },
    }))
    const agent = await fakeAgent(ctx)
    agentEvents(ctx, agent).emit('agent/error', { turn: 1, step: 1, error: new Error('boom') })
    await until(() => received.length === 1)
    expect(received[0]!.body).toMatchObject({ event: 'sessionError' })
    expect((received[0]!.body as { text: string }).text).toContain('boom')
    const goal = ctx.goals.create(agent, { objective: 'x' })
    ctx.goals.complete(agent, { id: goal.id, revision: goal.revision })
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(received).toHaveLength(1)
  })

  it('offers /notify test <channel>', async () => {
    await listen()
    const ctx = await setup(config())
    const agent = await fakeAgent(ctx)
    const command = ctx.commands.find(agent, 'notify')!
    const ok = await command.handler({ commandId: CommandId('n1'), agent, rawInput: 'test hook', attachments: [], signal })
    expect(ok.kind).toBe('success')
    await until(() => received.length === 1)
    expect(received[0]!.body).toMatchObject({ event: 'test' })
    const missing = await command.handler({ commandId: CommandId('n2'), agent, rawInput: 'test nope', attachments: [], signal })
    expect(missing.kind).toBe('error')
  })
})
