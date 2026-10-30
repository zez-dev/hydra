import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox, unsupportedModel } from '@deepseek-ai/dsh-agent-loop-testkit'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import CommandRuntime, { CommandId } from '@deepseek-ai/dsh-commands'
import GoalService from '@deepseek-ai/dsh-goal'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as Digest from '@deepseek-ai/dsh-digest'
import { msUntil, parseDailyAt, renderDigest } from '@deepseek-ai/dsh-digest'
import { localDateKey } from '@deepseek-ai/dsh-util-time'

let root: string | undefined
let storages: string | undefined
let context: Context | undefined

afterEach(async () => {
  vi.useRealTimers()
  await context?.fiber.dispose()
  context = undefined
  for (const dir of [root, storages]) if (dir !== undefined) await rm(dir, { recursive: true, force: true })
  root = undefined
  storages = undefined
})

const signal = new AbortController().signal

async function setup(config: Digest.Config = {}, withTickets = true): Promise<{ ctx: Context; cwd: string }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-digest-'))
  storages = await mkdtemp(join(tmpdir(), 'dsh-digest-storages-'))
  const ctx = new Context()
  context = ctx
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(GoalService)
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: storages })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  if (withTickets) ctx.provide('tickets', fakeTickets() as never)
  await ctx.plugin(Digest, config)
  return { ctx, cwd: root }
}

function fakeStore(ctx: Context, cwd: string): FakeTicketStore {
  return (ctx.get('tickets') as ReturnType<typeof fakeTickets>).storeFor(cwd)
}

async function fakeAgent(ctx: Context, cwd: string, id = 'digest-agent'): Promise<Agent> {
  const scope = ctx.plugin(() => {})
  const session = ctx.sessions.create(SessionId(id), { meta: { cwd } })
  const agent: Agent = {
    id: SessionId(id), options: {}, session, model: unsupportedModel(), inbox: unsupportedInbox(),
    status: 'idle', ctx: scope.ctx,
    followup: () => {}, steer: () => {}, inject: () => {}, send: () => {}, cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  await ctx.agents.register(agent)
  return agent
}

describe('digest helpers', () => {
  it('parses HH:MM and computes the delay to the next occurrence', () => {
    expect(parseDailyAt('07:30')).toEqual({ hour: 7, minute: 30 })
    expect(() => parseDailyAt('25:00')).toThrow(/dailyAt/)
    expect(() => parseDailyAt('7')).toThrow(/dailyAt/)
    const now = new Date(2026, 8, 20, 10, 0, 0)
    expect(msUntil({ hour: 10, minute: 30 }, now)).toBe(30 * 60_000)
    expect(msUntil({ hour: 9, minute: 0 }, now)).toBe(23 * 60 * 60_000)
    expect(localDateKey(now)).toBe('2026-09-20')
  })

  it('renders every section, naming absent seams', () => {
    const text = renderDigest({
      date: '2026-09-20',
      goals: [{ sessionId: 's1', objective: 'ship', phase: 'active', roundsStarted: 4 }],
      tickets: {
        counts: { open: 1, fixed: 2 }, openedToday: 1, closedToday: 2,
        changedToday: [{ id: 'abc', title: 'bug', status: 'fixed', severity: 'high' }],
      },
      checkpoints: [{ commit: 'deadbeef1234', role: 'fixer', round: 2, ticketId: 'abc' }],
      memory: { candidates: 2, approved: 1 },
      spend: { dayTokens: 1234 },
      cronRuns: [{ name: 'nightly', outcome: 'completed' }],
      breakthroughs: ['found the leak'],
    })
    for (const heading of ['## Goals', '## Tickets', '## Checkpoints', '## Memory', '## Spend', '## Cron runs', '## Research breakthroughs']) {
      expect(text).toContain(heading)
    }
    expect(text).toContain('ship')
    expect(text).toContain('abc')
    expect(text).toContain('deadbee')
    expect(text).toContain('1234')
    expect(text).toContain('nightly')
    expect(text).toContain('found the leak')
    const bare = renderDigest({ date: '2026-09-20', goals: [], tickets: { counts: {}, openedToday: 0, closedToday: 0, changedToday: [] }, checkpoints: [] })
    expect(bare).toContain('not mounted')
  })
})

describe('/report', () => {
  it('writes the day report under .dsh/reports with goals, tickets, and optional seams', async () => {
    const { ctx, cwd } = await setup()
    const agent = await fakeAgent(ctx, cwd)
    ctx.goals.create(agent, { objective: 'make it production grade' })
    const store = fakeStore(ctx, cwd)
    await store.whenReady()
    const ticket = await store.create({ title: 'login crashes', severity: 'critical' })
    ctx.provide('checkpoints', { list: () => [{ commit: 'cafebabe0000', sessionId: agent.id, round: 1, role: 'fixer', ticketId: ticket.id, createdAt: new Date().toISOString(), rolledBack: false }] } as never)
    ctx.provide('memory', { list: () => [{ status: 'candidate', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, { status: 'approved', createdAt: '2020-01-01T00:00:00.000Z', updatedAt: new Date().toISOString() }] } as never)
    ctx.provide('spendGuard', { dayTokens: () => 4321 } as never)
    ctx.provide('cronSessions', { list: () => [{ name: 'nightly', lastRunAt: Date.now(), lastOutcome: 'completed' }] } as never)
    ctx.provide('research', { dir: '.dsh/research' } as never)
    await mkdir(join(cwd, '.dsh', 'research', 'leak'), { recursive: true })
    const today = localDateKey(new Date())
    await writeFile(join(cwd, '.dsh', 'research', 'leak', 'journal.md'), `# Journal\n\n## Breakthroughs\n\n- [${today}] the leak is in the pool\n- [2020-01-01] old news\n\n## Hypotheses\n`)
    const result = await ctx.commands.find(agent, 'report')!.handler({ commandId: CommandId('c1'), agent, rawInput: '', attachments: [], signal })
    expect(result.kind).toBe('success')
    const path = join(cwd, '.dsh', 'reports', `${today}.md`)
    expect(result.kind === 'success' ? result.text : '').toContain(path)
    const text = await readFile(path, 'utf8')
    expect(text).toContain('make it production grade')
    expect(text).toContain('login crashes')
    expect(text).toContain('cafebab')
    expect(text).toContain('4321')
    expect(text).toContain('nightly')
    expect(text).toContain('the leak is in the pool')
    expect(text).not.toContain('old news')
    expect(text).toContain('candidates: 1')
  })

  it('reports the tickets section as not mounted when no tickets service is present', async () => {
    const { ctx, cwd } = await setup({}, false)
    const agent = await fakeAgent(ctx, cwd)
    const result = await ctx.commands.find(agent, 'report')!.handler({ commandId: CommandId('c1'), agent, rawInput: '', attachments: [], signal })
    const text = result.kind === 'success' ? result.text : ''
    expect(text).toContain('## Tickets\n_not mounted_')
  })

  it('reads journals from the research service\'s configured directory and reports absence without the service', async () => {
    const { ctx, cwd } = await setup()
    const agent = await fakeAgent(ctx, cwd)
    const today = localDateKey(new Date())
    await mkdir(join(cwd, 'notes', 'journals', 'leak'), { recursive: true })
    await writeFile(join(cwd, 'notes', 'journals', 'leak', 'journal.md'), `# Journal\n\n## Breakthroughs\n\n- [${today}] found in the configured dir\n\n## Hypotheses\n\n- [h-1 x auto open] maybe\n`)
    const run = async () => {
      const result = await ctx.commands.find(agent, 'report')!.handler({ commandId: CommandId('c1'), agent, rawInput: '', attachments: [], signal })
      return result.kind === 'success' ? result.text : ''
    }
    const without = await run()
    expect(without).not.toContain('found in the configured dir')
    ctx.provide('research', { dir: 'notes/journals' } as never)
    const text = await run()
    expect(text).toContain('found in the configured dir')
  })

  it('writes and notifies at dailyAt for every live workspace', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 8, 20, 23, 59, 30))
    const { ctx, cwd } = await setup({ dailyAt: '00:00' })
    const sent: unknown[] = []
    ctx.provide('notify', { send: async (notification: unknown) => { sent.push(notification) }, channels: () => [] } as never)
    await fakeAgent(ctx, cwd)
    await vi.advanceTimersByTimeAsync(31_000)
    await vi.waitFor(async () => {
      await readFile(join(cwd, '.dsh', 'reports', '2026-09-21.md'), 'utf8')
    })
    expect(sent).toEqual([expect.objectContaining({ event: 'dailyDigest' })])
  })

  it('rejects a malformed dailyAt at activation', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-digest-bad-'))
    const ctx = new Context()
    context = ctx
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(GoalService)
    await ctx.plugin(Storage)
    storages = await mkdtemp(join(tmpdir(), 'dsh-digest-bad-storages-'))
    await ctx.plugin(StorageJson, { root: storages })
    await ctx.plugin(StorageDomain, { backend: 'json' })
    ctx.provide('tickets', fakeTickets() as never)
    await expect(ctx.plugin(Digest, { dailyAt: 'noon' })).rejects.toThrow(/dailyAt/)
  })
})

/** In-memory stand-in for the removed tickets plugin: the `storeFor` seam digest reads. */
interface FakeTicket { id: string; title: string; severity: string; status: string; createdAt: string; updatedAt: string }
interface FakeTicketStore {
  whenReady(): Promise<void>
  list(): FakeTicket[]
  create(input: { title: string; severity: string }): Promise<FakeTicket>
  transition(id: string, status: string): Promise<void>
}
function fakeTickets(): { storeFor(cwd: string): FakeTicketStore } {
  const stores = new Map<string, FakeTicket[]>()
  return {
    storeFor(cwd) {
      let rows = stores.get(cwd)
      if (rows === undefined) {
        rows = []
        stores.set(cwd, rows)
      }
      const list = rows
      return {
        whenReady: () => Promise.resolve(),
        list: () => list,
        create: async (input) => {
          const now = new Date().toISOString()
          const row = { id: `t${list.length + 1}`, title: input.title, severity: input.severity, status: 'open', createdAt: now, updatedAt: now }
          list.push(row)
          return row
        },
        transition: async (id, status) => {
          const row = list.find(entry => entry.id === id)
          if (row !== undefined) {
            row.status = status
            row.updatedAt = new Date().toISOString()
          }
        },
      }
    },
  }
}
