import { cp, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SqliteSessionQueryEngine from '@deepseek-ai/dsh-session-query-sqlite'
import CommandRuntime, { CommandId } from '@deepseek-ai/dsh-commands'
import GoalService, { GoalId } from '@deepseek-ai/dsh-goal'
import type { GoalChangeMeta, GoalRef } from '@deepseek-ai/dsh-goal'
import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'
import { MockAdapter } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as Supervisor from '@deepseek-ai/dsh-goal-supervisor'
import { activeGoalOf, localMidnight, planSupervision, roundsSince } from '@deepseek-ai/dsh-goal-supervisor'

const dirs: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

function goalCreate(objective: string): GoalChangeMeta {
  return {
    kind: 'goal/change',
    version: 1,
    operation: 'create',
    goal: { id: GoalId('g1'), revision: 1, objective, phase: 'active', maxGoalRounds: 64 },
    roundsStarted: 0,
    createdAt: 1,
    updatedAt: 1,
  }
}

function goalPause(objective: string, roundsStarted: number, time: number): GoalChangeMeta {
  return {
    kind: 'goal/change',
    version: 1,
    operation: 'pause',
    goal: { id: GoalId('g1'), revision: 2, objective, phase: 'paused', maxGoalRounds: 64 },
    roundsStarted,
    createdAt: 1,
    updatedAt: time,
  }
}

/** One stored goal round of goal `g1` revision 1 in its own turn, starting at `seq`. */
function storedRound(seq: number, time: number, round: number): SessionEvent[] {
  const turn = round + 1
  return [
    { type: 'turn/start', seq: SessionSeq(seq), time, data: { turn } },
    {
      type: 'user/message',
      seq: SessionSeq(seq + 1),
      time,
      surfaceOp: 'append',
      data: createUserMessage({ content: [{ type: 'text', text: `round ${round}` }], source: { kind: 'goal', goalId: GoalId('g1'), revision: 1, round } }),
    },
    { type: 'turn/end', seq: SessionSeq(seq + 2), time, data: { turn, reason: { kind: 'completed' } } },
  ]
}

/** A stored log: one balanced turn, the goal, then `rounds` goal rounds at `time`. */
function storedLog(objective: string, rounds = 0, time = Date.now(), phase: 'active' | 'paused' = 'active'): SessionEvent[] {
  const events: SessionEvent[] = [
    { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
    { type: 'turn/end', seq: SessionSeq(1), time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
    { type: 'goal/change', seq: SessionSeq(2), time: 3, data: goalCreate(objective) },
  ]
  for (let round = 1; round <= rounds; round += 1) events.push(...storedRound(events.length, time, round))
  if (phase === 'paused') {
    events.push({ type: 'goal/change', seq: SessionSeq(events.length), time, data: goalPause(objective, rounds, time) })
  }
  return events
}

/** A stored log whose only goal round claims round 2, which the goal replay rules reject. */
function unreplayableLog(objective: string): SessionEvent[] {
  const events = storedLog(objective)
  return [...events, ...storedRound(events.length, Date.now(), 2)]
}

const DAY_MS = 24 * 60 * 60 * 1000

async function mount(root: string, config?: Supervisor.Config): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SqliteSessionQueryEngine, { path: ':memory:', openAt: 'never' })
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(GoalService)
  ctx.llm.registerAdapter(['mock'], new MockAdapter([]))
  if (config !== undefined) await ctx.plugin(Supervisor, config)
  return ctx
}

async function seed(ctx: Context, rawId: string, events: readonly SessionEvent[], agentPreset?: string): Promise<SessionId> {
  const id = SessionId(rawId)
  const detached = ctx.sessions.prepare(id, agentPreset === undefined ? undefined : { meta: { agentPreset } })
  const handle = await ctx.sessionPersistence.create(detached.header)
  await handle.append(events)
  await handle.close()
  return id
}

async function until(check: () => boolean, ms = 10_000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('condition not met in time')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

async function settled(): Promise<void> {
  for (let index = 0; index < 30; index += 1) await new Promise(resolve => setTimeout(resolve, 5))
}

describe('pure helpers', () => {
  it('folds the active goal out of a stored log and ignores paused or absent goals', () => {
    expect(activeGoalOf(storedLog('ship it'))).toMatchObject({ objective: 'ship it', id: 'g1', revision: 1 })
    expect(activeGoalOf(storedLog('ship it', 0, Date.now(), 'paused'))).toBeUndefined()
    expect(activeGoalOf(storedLog('ship it').slice(0, 2))).toBeUndefined()
  })

  it('counts goal rounds admitted since a point in time', () => {
    const now = Date.now()
    const log = storedLog('ship it', 3, now)
    expect(roundsSince(log, now - 1000)).toBe(3)
    expect(roundsSince(log, now + 1000)).toBe(0)
    expect(localMidnight(now)).toBeLessThanOrEqual(now)
    expect(now - localMidnight(now)).toBeLessThan(24 * 60 * 60 * 1000)
  })

  it('does not count a message the human sent as a goal round', () => {
    const now = Date.now()
    const log: SessionEvent[] = [...storedLog('ship it', 1, now), {
      type: 'user/message',
      seq: SessionSeq(6),
      time: now,
      surfaceOp: 'append',
      data: createUserMessage({ content: [{ type: 'text', text: 'how is it going?' }], source: { kind: 'user' } }),
    }]
    expect(roundsSince(log, now - 1000)).toBe(1)
  })

  it('plans resumes up to the concurrency cap and sets aside goals over the daily budget', () => {
    const plan = planSupervision([
      { sessionId: SessionId('a'), objective: 'a', roundsToday: 0 },
      { sessionId: SessionId('b'), objective: 'b', roundsToday: 5 },
      { sessionId: SessionId('c'), objective: 'c', roundsToday: 1 },
      { sessionId: SessionId('d'), objective: 'd', roundsToday: 0 },
    ], { maxConcurrent: 2, dailyRoundBudget: 3 })
    expect(plan.resume.map(entry => entry.sessionId)).toEqual([SessionId('a'), SessionId('c')])
    expect(plan.overBudget.map(entry => entry.sessionId)).toEqual([SessionId('b')])
    expect(plan.deferred.map(entry => entry.sessionId)).toEqual([SessionId('d')])
  })
})

describe('boot-time supervision', () => {
  it('resumes stored sessions with active goals up to maxConcurrent and skips over-budget ones', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-goal-supervisor-'))
    dirs.push(root)
    const seeder = await mount(root)
    const first = await seed(seeder, 'stored-a', storedLog('finish a'))
    const second = await seed(seeder, 'stored-b', storedLog('finish b'))
    const exhausted = await seed(seeder, 'stored-c', storedLog('finish c', 3))
    await seed(seeder, 'stored-d', storedLog('paused d', 0, Date.now(), 'paused'))
    await seeder.fiber.dispose()
    contexts.pop()

    const ctx = await mount(root, { maxConcurrent: 1, dailyRoundBudget: 2 })
    await until(() => ctx.agents.list().length === 1)
    await settled()
    const live = ctx.agents.list().map(agent => agent.id)
    expect(live).toHaveLength(1)
    expect([first, second]).toContain(live[0])
    expect(ctx.agents.get(exhausted)).toBeUndefined()
    const goal = ctx.goals.get(ctx.agents.get(live[0]!)!)
    expect(goal).toMatchObject({ phase: 'active' })

    const listed = await ctx.commands.find(ctx.agents.get(live[0]!)!, 'goals')!.handler({
      commandId: CommandId('cmd-1'), agent: ctx.agents.get(live[0]!)!, rawInput: '', attachments: [], signal: new AbortController().signal,
    })
    expect(listed.kind).toBe('success')
    expect(listed.kind === 'success' ? listed.text : '').toContain('finish')
    expect(listed.kind === 'success' ? listed.text : '').toContain('0/2')
  }, 20_000)
})

describe('daily round budget on live sessions', () => {
  it('pauses the goal once rounds admitted today exceed the budget, not when they reach it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-goal-supervisor-live-'))
    dirs.push(root)
    const ctx = await mount(root, { maxConcurrent: 1, dailyRoundBudget: 2 })
    const { agent, appendRound } = await liveGoalAgent(ctx, 'live-budget')
    appendRound(1)
    await settled()
    appendRound(2)
    await settled()
    expect(ctx.goals.get(agent)).toMatchObject({ phase: 'active' })
    appendRound(3)
    await settled()
    expect(ctx.goals.get(agent)).toMatchObject({ phase: 'paused' })
    expect(await goalsListing(ctx, agent)).toBe('live-budget: [paused] keep going — rounds today 3/2, total 3/256')
  })

  it('does not pause a session whose agent closed before the enforcement tick', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-goal-supervisor-closed-'))
    dirs.push(root)
    const ctx = await mount(root, { maxConcurrent: 1, dailyRoundBudget: 1 })
    const { agent, appendRound, close } = await liveGoalAgent(ctx, 'live-closed')
    appendRound(1)
    appendRound(2)
    await close()
    await settled()
    expect(goalOperations(agent.session)).toEqual(['create'])
  })

  it('withdraws /goals and pauses nothing once the supervisor is disposed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-goal-supervisor-disposed-'))
    dirs.push(root)
    const ctx = await mount(root)
    const warn = vi.spyOn(ctx.logger, 'warn')
    const supervisor = await ctx.plugin(Supervisor, { maxConcurrent: 1, dailyRoundBudget: 1 })
    const { agent, appendRound } = await liveGoalAgent(ctx, 'live-outlives-supervisor')
    expect(ctx.commands.find(agent, 'goals')).toBeDefined()
    appendRound(1)
    appendRound(2)
    await supervisor.dispose()
    await settled()
    expect(ctx.goals.get(agent)).toMatchObject({ phase: 'active' })
    expect(ctx.commands.find(agent, 'goals')).toBeUndefined()
    expect(warn).not.toHaveBeenCalled()
  })

  it('never pauses when no daily budget is configured', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-goal-supervisor-nobudget-'))
    dirs.push(root)
    const ctx = await mount(root, { maxConcurrent: 1 })
    const { agent, appendRound } = await liveGoalAgent(ctx, 'live-unbounded')
    for (let round = 1; round <= 12; round += 1) appendRound(round)
    await settled()
    expect(ctx.goals.get(agent)).toMatchObject({ phase: 'active' })
  })

  it('resumes a budget-paused goal at the next local midnight without a human', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const root = await mkdtemp(join(tmpdir(), 'dsh-goal-supervisor-midnight-'))
      dirs.push(root)
      const ctx = await mount(root, { maxConcurrent: 1, dailyRoundBudget: 1 })
      const { agent, appendRound } = await liveGoalAgent(ctx, 'live-midnight')
      appendRound(1)
      appendRound(2)
      await settled()
      expect(ctx.goals.get(agent)).toMatchObject({ phase: 'paused' })

      await passMidnight()
      await settled()
      expect(ctx.goals.get(agent)).toMatchObject({ phase: 'active', activation: 'armed' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaves a budget-paused session that closed before midnight paused', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const root = await mkdtemp(join(tmpdir(), 'dsh-goal-supervisor-closed-midnight-'))
      dirs.push(root)
      const ctx = await mount(root, { maxConcurrent: 1, dailyRoundBudget: 1 })
      const { agent, appendRound, close } = await liveGoalAgent(ctx, 'live-closed-before-midnight')
      appendRound(1)
      appendRound(2)
      await settled()
      expect(ctx.goals.get(agent)).toMatchObject({ phase: 'paused' })
      await close()
      await passMidnight()
      await settled()
      expect(goalOperations(agent.session)).toEqual(['create', 'pause'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaves alone a budget-paused goal a human resumed before midnight', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const root = await mkdtemp(join(tmpdir(), 'dsh-goal-supervisor-human-resume-'))
      dirs.push(root)
      const ctx = await mount(root, { maxConcurrent: 1, dailyRoundBudget: 1 })
      const { agent, appendRound } = await liveGoalAgent(ctx, 'live-resumed-by-hand')
      appendRound(1)
      appendRound(2)
      await settled()
      const paused = ctx.goals.get(agent)!
      expect(paused).toMatchObject({ phase: 'paused' })
      ctx.goals.resume(agent, { id: paused.id, revision: paused.revision })
      await passMidnight()
      await settled()
      expect(goalOperations(agent.session)).toEqual(['create', 'pause', 'resume'])
      expect(ctx.goals.get(agent)).toMatchObject({ phase: 'active', activation: 'armed' })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('/goals', () => {
  it('lists each live goal with its phase, activation, and rounds against the budget and cap', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-goal-supervisor-listing-'))
    dirs.push(root)
    const ctx = await mount(root, { maxConcurrent: 1 })
    const { agent: bare } = await liveAgent(ctx, 'live-without-goal')
    expect(await goalsListing(ctx, bare)).toBe('No live sessions carry a goal.')

    const { agent: uncapped } = await liveAgent(ctx, 'live-uncapped')
    ctx.goals.create(uncapped, { objective: 'run without a cap', maxGoalRounds: 0 })
    expect(await goalsListing(ctx, bare)).toBe('live-uncapped: [active, armed] run without a cap — rounds today 0/unlimited, total 0/unlimited')
  })
})

describe('resuming stored goals', () => {
  it('resumes with the deployment default model under the recorded agent preset', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-goal-supervisor-preset-'))
    dirs.push(root)
    const seeder = await mount(root)
    const stored = await seed(seeder, 'stored-reviewer', storedLog('finish review'), 'reviewer')
    await seeder.fiber.dispose()
    contexts.pop()

    const ctx = await mount(root)
    const resolved: (string | undefined)[] = []
    const mounted: string[] = []
    ctx.provide('agentPresets', {
      resolve: async (id?: string) => {
        resolved.push(id)
        return { id: id ?? 'standard' }
      },
      mount: async (_agentCtx: Context, id: string) => { mounted.push(id) },
    } as never)
    ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'mock', model: 'mock-default' }) } as never)
    await ctx.plugin(Supervisor, { maxConcurrent: 1 })
    await until(() => ctx.agents.get(stored) !== undefined)
    expect(resolved).toEqual(['reviewer'])
    expect(mounted).toEqual(['reviewer'])
    expect(ctx.agents.get(stored)!.options).toMatchObject({ provider: 'mock', model: 'mock-default' })
  }, 20_000)

  it('logs a stored goal it could not resume and resumes the others', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-goal-supervisor-retired-'))
    dirs.push(root)
    const seeder = await mount(root)
    const retired = await seed(seeder, 'stored-retired', storedLog('finish retired'), 'retired')
    const current = await seed(seeder, 'stored-current', storedLog('finish current'), 'standard')
    await seeder.fiber.dispose()
    contexts.pop()

    const ctx = await mount(root)
    const warn = vi.spyOn(ctx.logger, 'warn')
    ctx.provide('agentPresets', {
      resolve: async (id?: string) => {
        // A roster that rejects with a bare string rather than an Error.
        if (id === 'retired') throw 'preset "retired" is no longer in the roster'
        return { id }
      },
      mount: async () => {},
    } as never)
    await ctx.plugin(Supervisor, { maxConcurrent: 2 })
    const refusal = `goal-supervisor: could not resume "${retired}": preset "retired" is no longer in the roster`
    await until(() => ctx.agents.get(current) !== undefined && warn.mock.calls.some(call => call[0] === refusal))
    expect(ctx.agents.get(retired)).toBeUndefined()
  }, 20_000)

  it('counts a round seen both live and in a resumed session log once', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-goal-supervisor-reopened-'))
    dirs.push(root)
    const seeder = await mount(root)
    const reopened = await seed(seeder, 'stored-reopened', storedLog('finish reopened', 1))
    await seeder.fiber.dispose()
    contexts.pop()

    const ctx = await mount(root)
    // Registered before the supervisor, so round 2 is admitted before the
    // supervisor reads the resumed log, and the log it reads contains it.
    ctx.on('agent/created', ({ agent, source }) => {
      if (source === 'resume') appendGoalRound(agent.session, { id: GoalId('g1'), revision: 1 }, 2, 3)
    })
    await ctx.plugin(Supervisor, { maxConcurrent: 1, dailyRoundBudget: 5 })
    await until(() => ctx.agents.get(reopened) !== undefined)
    await settled()
    expect(await goalsListing(ctx, ctx.agents.get(reopened)!)).toBe('stored-reopened: [active] finish reopened — rounds today 2/5, total 2/64')
  }, 20_000)

  it('logs a resumed agent whose session log cannot be read', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-goal-supervisor-unread-'))
    dirs.push(root)
    const ctx = await mount(root, { maxConcurrent: 1 })
    const warn = vi.spyOn(ctx.logger, 'warn')
    // Announced as resumed, but its session is neither live in the store nor stored.
    const agent = stubAgent(ctx, ctx.sessions.prepare(SessionId('never-stored')))
    const detach = ctx.agents.enter(agent, undefined)
    try {
      await ctx.agents.announce(agent, 'resume')
      await until(() => warn.mock.calls.length > 0)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('goal-supervisor: could not seed rounds for "never-stored":'))
    } finally {
      detach()
    }
  }, 20_000)
})

describe('failed and cancelled passes', () => {
  it('logs why the boot pass failed when stored sessions cannot be listed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-goal-supervisor-unlisted-'))
    dirs.push(root)
    const seeder = await mount(root)
    await seed(seeder, 'stored-copied', storedLog('finish copied'))
    await seeder.fiber.dispose()
    contexts.pop()
    await copyProjectFolder(root)

    const ctx = await mount(root)
    const warn = vi.spyOn(ctx.logger, 'warn')
    await ctx.plugin(Supervisor, { maxConcurrent: 1 })
    await until(() => warn.mock.calls.length > 0)
    const failure = /^goal-supervisor: supervision failed: session persistence listing failed: corrupt session log /
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(failure))
    expect(ctx.agents.list()).toEqual([])
  }, 20_000)

  it('logs why a midnight pass failed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const root = await mkdtemp(join(tmpdir(), 'dsh-goal-supervisor-unlisted-midnight-'))
      dirs.push(root)
      const ctx = await mount(root, { maxConcurrent: 1, dailyRoundBudget: 1 })
      await settled()
      const warn = vi.spyOn(ctx.logger, 'warn')
      await seed(ctx, 'stored-copied-later', storedLog('finish later'))
      await copyProjectFolder(root)
      await passMidnight()
      await until(() => warn.mock.calls.length > 0)
      const failure = /^goal-supervisor: midnight supervision failed: session persistence listing failed: corrupt session log /
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(failure))
    } finally {
      vi.useRealTimers()
    }
  }, 20_000)

  it('drops a boot pass cut short by disposal without resuming or logging', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-goal-supervisor-abandoned-'))
    dirs.push(root)
    const seeder = await mount(root)
    const stored = await seed(seeder, 'stored-abandoned', storedLog('finish abandoned'))
    await seeder.fiber.dispose()
    contexts.pop()

    const ctx = await mount(root)
    const warn = vi.spyOn(ctx.logger, 'warn')
    const supervisor = await ctx.plugin(Supervisor, { maxConcurrent: 1 })
    await supervisor.dispose()
    await settled()
    expect(ctx.agents.get(stored)).toBeUndefined()
    expect(warn).not.toHaveBeenCalled()
  }, 20_000)
})

describe('a goal log that stops replaying', () => {
  it('skips that stored session at boot and resumes the others', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-goal-supervisor-unreplayable-'))
    dirs.push(root)
    const seeder = await mount(root)
    const broken = await seed(seeder, 'stored-broken', unreplayableLog('broken'))
    const intact = await seed(seeder, 'stored-intact', storedLog('intact'))
    await seeder.fiber.dispose()
    contexts.pop()

    const ctx = await mount(root)
    const warn = vi.spyOn(ctx.logger, 'warn')
    await ctx.plugin(Supervisor, { maxConcurrent: 2 })
    await until(() => ctx.agents.get(intact) !== undefined)
    expect(ctx.agents.get(broken)).toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`skipping unreadable session "${broken}": goal round at session event 4`))
  }, 20_000)

  it('reports an unreplayable round over budget instead of throwing from the enforcement timer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-goal-supervisor-unreplayable-live-'))
    dirs.push(root)
    const ctx = await mount(root, { maxConcurrent: 1, dailyRoundBudget: 1 })
    const warn = vi.spyOn(ctx.logger, 'warn')
    const { appendRound } = await liveGoalAgent(ctx, 'live-unreplayable')
    appendRound(1)
    appendRound(3)
    await settled()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not pause the goal of "live-unreplayable": goal replay failed'))
  })

  it('reports a budget-paused goal that stopped replaying at midnight and still runs the midnight pass', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const root = await mkdtemp(join(tmpdir(), 'dsh-goal-supervisor-unreplayable-midnight-'))
      dirs.push(root)
      const ctx = await mount(root, { maxConcurrent: 1, dailyRoundBudget: 1 })
      const warn = vi.spyOn(ctx.logger, 'warn')
      const { agent, appendRound } = await liveGoalAgent(ctx, 'live-unreplayable-midnight')
      appendRound(1)
      appendRound(2)
      await settled()
      expect(ctx.goals.get(agent)).toMatchObject({ phase: 'paused' })
      // A round of the paused goal: the goal log no longer replays.
      appendRound(3)
      await settled()
      const late = await seed(ctx, 'stored-late', storedLog('finish late'))

      const now = Date.now()
      await vi.advanceTimersByTimeAsync(localMidnight(now) + DAY_MS - now + 1000)
      await until(() => ctx.agents.get(late) !== undefined)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not resume the goal of "live-unreplayable-midnight": goal replay failed'))
    } finally {
      vi.useRealTimers()
    }
  }, 20_000)
})

/** A stub agent on `session`; the caller registers it. */
function stubAgent(ctx: Context, session: Session): Agent {
  const scope = ctx.plugin(() => {})
  return {
    id: session.id, options: {}, session, inbox: createInboxStub(), ctx: scope.ctx, status: 'idle',
    send: () => {}, followup: () => {}, steer: () => {}, inject: () => {}, cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

/** Register a stub live agent on a new session; `close` unregisters it. */
async function liveAgent(ctx: Context, rawId: string): Promise<{ agent: Agent; close: () => Promise<void> }> {
  const agent = stubAgent(ctx, ctx.sessions.create(SessionId(rawId)))
  const registration = ctx.agents.register(agent)
  await registration
  return { agent, close: () => registration() }
}

/** Append goal round `round` of `ref` to `session` inside turn `turn`. */
function appendGoalRound(session: Session, ref: GoalRef, round: number, turn = round): void {
  session.append('turn/start', { turn })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: `round ${round}` }],
    source: { kind: 'goal', goalId: ref.id, revision: ref.revision, round },
  }), { surfaceOp: 'append' })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

/** Register a stub live agent with an active goal and return a round appender. */
async function liveGoalAgent(
  ctx: Context,
  rawId: string,
): Promise<{ agent: Agent; appendRound: (round: number) => void; close: () => Promise<void> }> {
  const { agent, close } = await liveAgent(ctx, rawId)
  const ref: GoalRef = ctx.goals.create(agent, { objective: 'keep going' })
  return { agent, appendRound: (round) => { appendGoalRound(agent.session, ref, round) }, close }
}

/** Run `/goals` as `agent` and return the listing. */
async function goalsListing(ctx: Context, agent: Agent): Promise<string> {
  const result = await ctx.commands.find(agent, 'goals')!.handler({
    commandId: CommandId('goals'), agent, rawInput: '', attachments: [], signal: new AbortController().signal,
  })
  return result.kind === 'success' ? result.text ?? '' : `unexpected ${result.kind}`
}

/** The goal operations a session log records, in order. */
function goalOperations(session: Session): string[] {
  return session.snapshotEvents().flatMap(event => event.type === 'goal/change' ? [event.data.operation] : [])
}

/**
 * Copy the persistence root's only project folder under a second name. The
 * copied logs sit where their headers do not place them, so listing refuses them.
 */
async function copyProjectFolder(root: string): Promise<void> {
  const projects = (await readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory())
  expect(projects).toHaveLength(1)
  await cp(join(root, projects[0]!.name), join(root, `${projects[0]!.name}-copy`), { recursive: true })
}

/** Advance fake timers past the next local midnight. */
async function passMidnight(): Promise<void> {
  const now = Date.now()
  await vi.advanceTimersByTimeAsync(localMidnight(now) + DAY_MS - now + 1000)
}
