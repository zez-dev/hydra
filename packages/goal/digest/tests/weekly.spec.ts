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
import {
  aggregateWeek, breakthroughsOn, isoWeekLabel, msUntilWeekly, parseDigestFooter, parseWeeklyOn, renderDigest, renderWeekly,
  sparkline, weekDates,
} from '@deepseek-ai/dsh-digest'

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

async function setup(config: Digest.Config = {}): Promise<{ ctx: Context; cwd: string }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-digest-week-'))
  storages = await mkdtemp(join(tmpdir(), 'dsh-digest-week-storages-'))
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
  ctx.provide('tickets', fakeTickets() as never)
  await ctx.plugin(Digest, config)
  return { ctx, cwd: root }
}

function fakeStore(ctx: Context, cwd: string): FakeTicketStore {
  return (ctx.get('tickets') as ReturnType<typeof fakeTickets>).storeFor(cwd)
}

async function fakeAgent(ctx: Context, cwd: string, id = 'digest-week-agent'): Promise<Agent> {
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

function footerFor(date: string, totals: Partial<Digest.DailyTotals>): string {
  const full: Digest.DailyTotals = {
    date, ticketsOpened: 0, ticketsClosed: 0, checkpoints: 0, breakthroughs: 0, memoryCandidates: 0, memoryApproved: 0,
    spendTokens: null, cronRuns: 0, ...totals,
  }
  return `# Hydra digest ${date}\n\nbody\n\n<!-- hydra-digest ${JSON.stringify(full)} -->\n`
}

describe('weekly helpers', () => {
  it('parses "<weekday> HH:MM" and computes the delay to the next occurrence', () => {
    expect(parseWeeklyOn('mon 07:30')).toEqual({ weekday: 1, hour: 7, minute: 30 })
    expect(parseWeeklyOn('Sunday 23:00')).toEqual({ weekday: 0, hour: 23, minute: 0 })
    expect(() => parseWeeklyOn('someday 07:30')).toThrow(/weeklyOn/)
    expect(() => parseWeeklyOn('mon 25:00')).toThrow(/weeklyOn/)
    // 2026-09-20 is a Sunday.
    const now = new Date(2026, 8, 20, 10, 0, 0)
    expect(msUntilWeekly({ weekday: 0, hour: 10, minute: 30 }, now)).toBe(30 * 60_000)
    expect(msUntilWeekly({ weekday: 1, hour: 9, minute: 0 }, now)).toBe(23 * 60 * 60_000)
    expect(msUntilWeekly({ weekday: 0, hour: 9, minute: 0 }, now)).toBe(7 * 24 * 60 * 60_000 - 60 * 60_000)
  })

  it('names ISO weeks and lists the seven local dates ending on a day', () => {
    expect(isoWeekLabel(new Date(2026, 8, 20))).toBe('2026-W38')
    expect(isoWeekLabel(new Date(2026, 0, 1))).toBe('2026-W01')
    expect(isoWeekLabel(new Date(2027, 0, 1))).toBe('2026-W53')
    expect(weekDates(new Date(2026, 8, 20))).toEqual([
      '2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18', '2026-09-19', '2026-09-20',
    ])
  })

  it('embeds and parses the machine-readable footer of a daily report', () => {
    const text = renderDigest({
      date: '2026-09-20',
      goals: [],
      tickets: { counts: { open: 2 }, changedToday: [], openedToday: 2, closedToday: 1 },
      checkpoints: [{ commit: 'abc', role: 'fixer', round: 1 }],
      memory: { candidates: 3, approved: 1 },
      spend: { dayTokens: 500 },
      cronRuns: [{ name: 'n', outcome: 'completed' }],
      breakthroughs: ['b'],
    })
    expect(text).toContain('# Hydra digest 2026-09-20')
    expect(parseDigestFooter(text)).toEqual({
      date: '2026-09-20', ticketsOpened: 2, ticketsClosed: 1, checkpoints: 1, breakthroughs: 1,
      memoryCandidates: 3, memoryApproved: 1, spendTokens: 500, cronRuns: 1,
    })
    expect(parseDigestFooter('# no footer\n')).toBeUndefined()
    expect(parseDigestFooter('<!-- hydra-digest {not json} -->')).toBeUndefined()
  })

  it('draws a sparkline over the value range and blanks for no data', () => {
    expect(sparkline([0, 1, 2, 3, 4, 5, 6, 7])).toBe('▁▂▃▄▅▆▇█')
    expect(sparkline([3, 3, 3])).toBe('▁▁▁')
    expect(sparkline([null, 2, null])).toBe(' █ ')
    expect(sparkline([])).toBe('')
  })

  it('aggregates seven days of footers, filling missing days and computing spend per outcome', () => {
    const dates = weekDates(new Date(2026, 8, 20))
    const series = aggregateWeek(dates, [
      footerFor('2026-09-14', { ticketsOpened: 2, ticketsClosed: 1, spendTokens: 1000, breakthroughs: 1 }),
      footerFor('2026-09-16', { ticketsOpened: 1, ticketsClosed: 2, spendTokens: 3000, checkpoints: 2 }),
      footerFor('2026-09-20', { ticketsClosed: 1, spendTokens: null }),
    ].map(text => parseDigestFooter(text)!))
    expect(series.days.map(day => day.date)).toEqual(dates)
    expect(series.days.map(day => day.reported)).toEqual([true, false, true, false, false, false, true])
    expect(series.days.map(day => day.totals.ticketsOpened)).toEqual([2, 0, 1, 0, 0, 0, 0])
    expect(series.totals).toMatchObject({ ticketsOpened: 3, ticketsClosed: 4, checkpoints: 2, breakthroughs: 1, spendTokens: 4000 })
    expect(series.spendPerOutcome).toBe(800)
    expect(aggregateWeek(dates, []).spendPerOutcome).toBeUndefined()
  })

  it('renders the weekly report with sparklines, what moved, and still open', () => {
    const dates = weekDates(new Date(2026, 8, 20))
    const series = aggregateWeek(dates, [footerFor('2026-09-18', { ticketsOpened: 3, ticketsClosed: 1, spendTokens: 2000 })].map(text => parseDigestFooter(text)!))
    const text = renderWeekly({
      week: '2026-W38',
      from: dates[0]!,
      to: dates[6]!,
      series,
      moved: {
        tickets: [{ id: 't1', title: 'login crashes', status: 'closed', severity: 'high' }],
        breakthroughs: ['the leak is in the pool'],
        goals: [{ sessionId: 's1', objective: 'ship', phase: 'complete', roundsStarted: 9 }],
      },
      stillOpen: {
        needsHuman: [{ id: 't2', title: 'flaky build', status: 'needs-human', severity: 'medium' }],
        openHypotheses: [{ slug: 'leak', open: 2 }],
      },
      spendSource: 'daily reports',
    })
    for (const heading of ['# Hydra weekly review 2026-W38', '## Trends', '## What moved', '## Still open']) expect(text).toContain(heading)
    expect(text).toContain('2026-09-14 to 2026-09-20')
    expect(text).toContain('Tickets opened')
    expect(text).toContain('Spend per outcome')
    expect(text).toContain('login crashes')
    expect(text).toContain('the leak is in the pool')
    expect(text).toContain('ship')
    expect(text).toContain('flaky build')
    expect(text).toContain('leak: 2 open')
    expect(text).toContain('1 of 7 days reported')
  })

  it('reads research journal entries in the journal store format as well as dated bullets', () => {
    const journal = [
      '## Breakthroughs', '', '- [b-1a2b 2026-09-20T10:00:00.000Z model] the leak is in the pool', '- [2026-09-20] dated bullet',
      '- [b-3c4d 2026-09-19T10:00:00.000Z auto] yesterday', '', '## Hypotheses', '',
    ].join('\n')
    expect(breakthroughsOn(journal, '2026-09-20')).toEqual(['the leak is in the pool', 'dated bullet'])
  })
})

describe('/report week', () => {
  it('writes week-<label>.md from the daily footers plus live moved and open items', async () => {
    const { ctx, cwd } = await setup()
    const agent = await fakeAgent(ctx, cwd)
    const goal = ctx.goals.create(agent, { objective: 'ship it' })
    ctx.goals.complete(agent, { id: goal.id, revision: goal.revision })
    const store = fakeStore(ctx, cwd)
    await store.whenReady()
    const ticket = await store.create({ title: 'login crashes', severity: 'critical' })
    await store.transition(ticket.id, 'needs-human')
    const reports = join(cwd, '.dsh', 'reports')
    await mkdir(reports, { recursive: true })
    const dates = weekDates(new Date())
    await writeFile(join(reports, `${dates[2]}.md`), footerFor(dates[2]!, { ticketsOpened: 2, ticketsClosed: 2, spendTokens: 1500, breakthroughs: 1 }))
    await writeFile(join(reports, 'not-a-report.md'), 'hello')
    ctx.provide('research', { dir: '.dsh/research' } as never)
    await mkdir(join(cwd, '.dsh', 'research', 'leak'), { recursive: true })
    await writeFile(join(cwd, '.dsh', 'research', 'leak', 'journal.md'), [
      '# Journal', '', '## Breakthroughs', '', `- [b-1a2b ${new Date().toISOString()} model] the leak is in the pool`, '',
      '## Hypotheses', '', '- [h-1 2026-09-01T00:00:00.000Z model open] pool leaks', '- [h-2 2026-09-01T00:00:00.000Z model refuted] gc', '',
    ].join('\n'))
    const result = await ctx.commands.find(agent, 'report')!.handler({ commandId: CommandId('c1'), agent, rawInput: 'week', attachments: [], signal })
    expect(result.kind).toBe('success')
    const path = join(reports, `week-${isoWeekLabel(new Date())}.md`)
    expect(result.kind === 'success' ? result.text : '').toContain(path)
    const text = await readFile(path, 'utf8')
    expect(text).toContain('Tickets opened')
    expect(text).toContain('login crashes')
    expect(text).toContain('the leak is in the pool')
    expect(text).toContain('ship it')
    expect(text).toContain('leak: 1 open')
    // One daily footer plus today's totals derived live.
    expect(text).toContain('2 of 7 days reported')
  })

  it('writes and notifies at weeklyOn for every live workspace', async () => {
    vi.useFakeTimers()
    // 2026-09-20 is a Sunday; the timer fires at Monday 00:00.
    vi.setSystemTime(new Date(2026, 8, 20, 23, 59, 30))
    const { ctx, cwd } = await setup({ weeklyOn: 'mon 00:00' })
    const sent: unknown[] = []
    ctx.provide('notify', { send: async (notification: unknown) => { sent.push(notification) }, channels: () => [] } as never)
    await fakeAgent(ctx, cwd)
    await vi.advanceTimersByTimeAsync(31_000)
    await vi.waitFor(async () => {
      await readFile(join(cwd, '.dsh', 'reports', 'week-2026-W39.md'), 'utf8')
    })
    expect(sent).toEqual([expect.objectContaining({ event: 'weeklyDigest' })])
  })

  it('rejects a malformed weeklyOn at activation', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-digest-week-bad-'))
    storages = await mkdtemp(join(tmpdir(), 'dsh-digest-week-bad-storages-'))
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
    ctx.provide('tickets', fakeTickets() as never)
    await expect(ctx.plugin(Digest, { weeklyOn: 'monday' })).rejects.toThrow(/weeklyOn/)
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
