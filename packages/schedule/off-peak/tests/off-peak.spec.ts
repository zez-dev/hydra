import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import CommandRuntime, { CommandId } from '@deepseek-ai/dsh-commands'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import GoalService, { GoalId } from '@deepseek-ai/dsh-goal'
import type { GoalView } from '@deepseek-ai/dsh-goal'
import * as driver from '@deepseek-ai/dsh-goal-round-driver'
import { LlmAdapter, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Notification } from '@deepseek-ai/dsh-notify'
import { SessionId } from '@deepseek-ai/dsh-session'
import Storage, { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import type { KvFacet, StorageBackend } from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import type { TableValueOf } from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as offPeak from '@deepseek-ai/dsh-off-peak'
import * as offPeakTools from '@deepseek-ai/dsh-off-peak/tools'
import { executeModelToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'

/** One window covering the small hours, so the tests drive the clock across it. */
const NIGHT = {
  enabled: true,
  windows: [{ start: '01:00', end: '05:00' }],
  maxConcurrent: 1,
  finishRoundInFlight: false,
} satisfies offPeak.Config

const HOUR = 60 * 60 * 1000

class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  private held: Promise<undefined> | undefined

  /**
   * Hold every later request until the returned release runs; a held request
   * whose turn is cancelled first ends with that abort.
   */
  hold(): () => void {
    const gate = Promise.withResolvers<undefined>()
    this.held = gate.promise
    return () => {
      this.held = undefined
      gate.resolve(undefined)
    }
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const held = this.held
    if (held !== undefined) {
      await new Promise<void>((resolve, reject) => {
        void held.then(resolve)
        options.signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
      })
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** In-memory storage for the queue domain whose writes can be made to reject. */
class FailingStorage implements StorageBackend {
  private readonly inner = new MemoryStorageBackend()
  private readonly failures: unknown[] = []
  readonly kv: KvFacet = {
    open: async (descriptor) => {
      const unit = await this.inner.kv.open(descriptor)
      const write = async (run: () => Promise<void>): Promise<void> => {
        if (this.failures.length > 0) throw this.failures.shift()
        await run()
      }
      return {
        loadAll: () => unit.loadAll(),
        putRecord: (table, key, value) => write(() => unit.putRecord(table, key, value)),
        deleteRecord: (table, key) => write(() => unit.deleteRecord(table, key)),
        deleteRecords: (table, keys) => write(() => unit.deleteRecords(table, keys)),
        setGlobal: value => write(() => unit.setGlobal(value)),
        close: () => unit.close(),
      }
    },
  }

  /**
   * Make one more upcoming write reject with `reason`; writes fail in the order the reasons were added.
   * @param reason - the rejection value, which need not be an Error.
   */
  failNextWrite(reason: unknown): void {
    this.failures.push(reason)
  }

  close(): Promise<void> {
    return this.inner.close()
  }
}

const contexts: Context[] = []
let root: string | undefined
const signal = new AbortController().signal

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-off-peak-'))
  // Only the clock and this package's own timers are faked: the agent loop
  // drives rounds through promises, and faking every timer stalls it.
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  // 22:00 is outside the 01:00-05:00 window on every case's first tick.
  vi.setSystemTime(new Date(2026, 8, 10, 22, 0, 0, 0))
})

afterEach(async () => {
  vi.useRealTimers()
  await Promise.allSettled(contexts.splice(0).map(context => context.fiber.dispose()))
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** One stored queue record, as the plugin writes it. */
type StoredEntry = TableValueOf<typeof offPeak.offPeakDomainSpec, 'entries'>

/** How {@link harness} composes the session and storage around the plugin. */
interface HarnessOptions {
  /** Storage for the queue domain; the JSON backend under the test root when omitted. */
  readonly backend?: StorageBackend
  /** Records the queue domain holds before the plugin opens it, as an earlier process or a hand edit leaves them. */
  readonly stored?: readonly StoredEntry[]
  /** Whether the goal round driver is mounted; without it nothing arms goal rounds. */
  readonly driver?: boolean
  /** The harness session's id; a fresh one when omitted. */
  readonly sessionId?: SessionId
  /** The harness session's workspace directory. */
  readonly cwd?: string
}

async function harness(config: offPeak.Config = NIGHT, options: HarnessOptions = {}): Promise<{
  ctx: Context
  adapter: ScriptedAdapter
  agent: Agent
  offPeakFiber: Fiber
}> {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(Storage)
  if (options.backend === undefined) {
    await ctx.plugin(StorageJson, { root: join(root ?? '', 'storages') })
    await ctx.plugin(StorageDomain, { backend: 'json' })
  } else {
    ctx.storage.backend.register('memory', options.backend)
    ctx.provide(storageBackendServiceKey('memory'), options.backend)
    await ctx.plugin(StorageDomain, { backend: 'memory' })
  }
  if (options.stored !== undefined) {
    const seed = await ctx.storageDomain.open(offPeak.offPeakDomainSpec)
    for (const row of options.stored) await seed.table('entries').put(row.id, row)
    await seed.close()
  }
  await ctx.plugin(GoalService)
  if (options.driver !== false) await ctx.plugin(driver, {})
  const offPeakFiber = await ctx.plugin(offPeak, config)
  await ctx.plugin(offPeakTools)
  await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new ScriptedAdapter()
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await ctx.agentLoop.create(
    options.sessionId ?? SessionId(`off-peak-${Math.random()}`),
    { provider: 'mock', model: 'mock' },
    options.cwd === undefined ? {} : { cwd: options.cwd },
  )
  return { ctx, adapter, agent, offPeakFiber }
}

/** Advance the fake clock and let queued microtasks and timers settle. */
async function settle(ms = 20): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
  // The durable queue writes through real filesystem I/O, which fake time does
  // not advance. `setImmediate` is not faked here, so awaiting it yields the
  // event loop and lets a pending write land; without it these waits pass only
  // when the machine is idle.
  await new Promise((resolve) => { setImmediate(resolve) })
}

/** Wait until the durable queue reaches an expected state. */
async function waitForQueue(ctx: Context, predicate: (entries: offPeak.OffPeakEntry[]) => boolean): Promise<offPeak.OffPeakEntry[]> {
  // A drained round runs a real turn through the loop, so the budget is
  // generous and a miss throws: returning the last state would assert against
  // stale data and read as an unrelated failure.
  for (let attempt = 0; attempt < 2000; attempt++) {
    if (predicate(ctx.offPeak.list())) return ctx.offPeak.list()
    await settle(10)
  }
  throw new Error(`off-peak queue never satisfied the predicate; last state ${JSON.stringify(ctx.offPeak.list())}`)
}

/** Wait until the model has received at least `count` requests. */
async function waitForRequests(adapter: ScriptedAdapter, count: number): Promise<void> {
  for (let attempt = 0; attempt < 2000; attempt++) {
    if (adapter.requests.length >= count) return
    await settle(10)
  }
  throw new Error(`the model received ${String(adapter.requests.length)} requests, expected ${String(count)}`)
}

async function waitForGoal(
  ctx: Context,
  agent: Agent,
  predicate: (goal: GoalView | undefined) => boolean,
): Promise<GoalView | undefined> {
  for (let attempt = 0; attempt < 2000; attempt++) {
    if (predicate(ctx.goals.get(agent))) return ctx.goals.get(agent)
    await settle(10)
  }
  throw new Error(`goal never satisfied the predicate; last phase ${String(ctx.goals.get(agent)?.phase)}`)
}

/** Wait until `check` holds, advancing the fake clock in small steps. */
async function waitUntil(check: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 2000; attempt++) {
    if (check()) return
    await settle(10)
  }
  throw new Error(`never happened: ${what}`)
}

/** How each of the session's turns ended, in order. */
function turnEnds(agent: Agent): string[] {
  return agent.session.snapshotEvents().flatMap(event => event.type === 'turn/end' ? [event.data.reason.kind] : [])
}

/** A person's message, as the chat sends it. */
function userMessage(text: string): ReturnType<typeof createUserMessage> {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

/** Invoke `/offpeak` from the harness session. */
async function offpeak(test: { ctx: Context; agent: Agent }, rawInput: string): Promise<CommandResult> {
  const command = test.ctx.commands.find(test.agent, 'offpeak')!
  return await command.handler({ commandId: CommandId('c1'), agent: test.agent, rawInput, attachments: [], signal })
}

describe('activation', () => {
  it('refuses an enabled row with no window', async () => {
    await expect(harness({ ...NIGHT, windows: [] })).rejects.toThrow('off-peak: enabled with no windows')
  })

  it('logs a drain it starts inside a window when the queue cannot be written', async () => {
    const storage = new FailingStorage()
    const test = await harness(NIGHT, { backend: storage })
    const entry = await test.ctx.offPeak.queue({ sessionId: test.agent.id, objective: 'reindex the archive' })
    await test.offPeakFiber.dispose()
    const warn = vi.spyOn(test.ctx.logger, 'warn')
    storage.failNextWrite(new Error('disk full'))

    // Loading again at 02:00, inside the window, drains at once.
    vi.setSystemTime(new Date(2026, 8, 11, 2, 0, 0, 0))
    await test.ctx.plugin(offPeak, NIGHT)

    await waitUntil(() => warn.mock.calls.length > 0, 'a warning')
    expect(warn).toHaveBeenCalledWith('off-peak: drain at activation failed: disk full')
    expect(test.ctx.offPeak.list()).toEqual([entry])
  })
})

describe('the stored queue', () => {
  it('reopens when the plugin reloads', async () => {
    const test = await harness()
    const entry = await test.ctx.offPeak.queue({ sessionId: test.agent.id, objective: 'reindex the archive' })

    await test.offPeakFiber.dispose()
    await test.ctx.plugin(offPeak, NIGHT)

    expect(test.ctx.offPeak.list()).toEqual([entry])
  })

  it('keeps entries queued just before an unload when the plugin reloads', async () => {
    const test = await harness()
    const first = test.ctx.offPeak.queue({ sessionId: test.agent.id, objective: 'first' })
    const second = test.ctx.offPeak.queue({ sessionId: test.agent.id, objective: 'second' })

    await test.offPeakFiber.dispose()
    await test.ctx.plugin(offPeak, NIGHT)

    expect(test.ctx.offPeak.list().map(entry => entry.objective).sort()).toEqual(['first', 'second'])
    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
  })

  it('lists entries queued in the same millisecond in id order', async () => {
    const test = await harness()
    const first = await test.ctx.offPeak.queue({ sessionId: test.agent.id, objective: 'first' })
    const second = await test.ctx.offPeak.queue({ sessionId: test.agent.id, objective: 'second' })

    expect(second.queuedAt).toBe(first.queuedAt)
    expect(test.ctx.offPeak.list().map(entry => entry.id)).toEqual([first.id, second.id].sort((a, b) => a.localeCompare(b)))
  })

  it('lists a stored entry that has no objective without one', async () => {
    const stored: StoredEntry = { id: 'hand-edited', sessionId: 'off-peak-elsewhere', kind: 'goal-round', queuedAt: Date.now(), state: 'queued' }
    const test = await harness(NIGHT, { stored: [stored] })

    expect(test.ctx.offPeak.list()).toEqual([stored])
    expect(await offpeak(test, 'list')).toEqual({
      kind: 'success',
      text: `Window closed; 01:00-05:00.\nhand-edited goal-round queued ${new Date(stored.queuedAt).toISOString()} `,
    })
  })
})

describe('deferral outside a window', () => {
  it('rejects the goal round, pauses the goal, and records one queue entry', async () => {
    const test = await harness()
    test.ctx.goals.create(test.agent, { objective: 'index the corpus', maxGoalRounds: 4 })

    const goal = await waitForGoal(test.ctx, test.agent, current => current?.phase === 'paused')
    expect(goal?.phase).toBe('paused')
    const queued = await waitForQueue(test.ctx, entries => entries.length === 1)
    expect(queued).toHaveLength(1)
    expect(queued[0]).toMatchObject({ kind: 'goal-round', state: 'queued', objective: 'index the corpus' })
    expect(test.adapter.requests).toHaveLength(0)
  })

  it('queues one entry per session however many rounds the driver attempts', async () => {
    const test = await harness()
    test.ctx.goals.create(test.agent, { objective: 'once only', maxGoalRounds: 4 })
    await waitForGoal(test.ctx, test.agent, current => current?.phase === 'paused')

    await waitForQueue(test.ctx, entries => entries.length === 1)
    const goal = test.ctx.goals.get(test.agent)
    if (goal !== undefined) test.ctx.goals.resume(test.agent, { id: goal.id, revision: goal.revision })
    await waitForGoal(test.ctx, test.agent, current => current?.phase === 'paused')
    await settle(50)

    expect(test.ctx.offPeak.list()).toHaveLength(1)
  })

  it('leaves rounds alone while a window is open', async () => {
    vi.setSystemTime(new Date(2026, 8, 10, 2, 0, 0, 0))
    const test = await harness()
    test.ctx.goals.create(test.agent, { objective: 'run now', maxGoalRounds: 1 })

    await waitForGoal(test.ctx, test.agent, current => current?.phase === 'blocked')
    expect(test.ctx.offPeak.list()).toHaveLength(0)
    expect(test.adapter.requests.length).toBeGreaterThan(0)
  })

  it("lets a person's message through while the window is closed", async () => {
    const test = await harness()

    test.agent.followup(userMessage('are you there?'))
    await test.agent.whenIdle()

    expect(turnEnds(test.agent)).toEqual(['completed'])
    expect(test.adapter.requests).toHaveLength(1)
    expect(test.ctx.offPeak.list()).toHaveLength(0)
  })

  it("lets a step through that carries a person's message beside a goal round", async () => {
    const test = await harness(NIGHT, { driver: false })
    const goal = test.ctx.goals.create(test.agent, { objective: 'tidy the docs', maxGoalRounds: 4 })
    // A person's message waits for the next step, as the round driver leaves one when it drops a stale round,
    // so the turn the goal round starts admits both in its first step.
    test.agent.inbox.append('next-step', userMessage('and check the links'))

    test.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'continue the goal' }],
      source: { kind: 'goal', goalId: goal.id, revision: goal.revision, round: 1 },
    }))
    await test.agent.whenIdle()

    expect(turnEnds(test.agent)).toEqual(['completed'])
    expect(test.adapter.requests).toHaveLength(1)
    expect(test.ctx.offPeak.list()).toHaveLength(0)
    expect(test.ctx.goals.get(test.agent)).toMatchObject({ phase: 'active', roundsStarted: 1 })
  })

  it('drops a goal round whose session has no goal, without queueing it', async () => {
    const test = await harness(NIGHT, { driver: false })

    test.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'continue the goal' }],
      source: { kind: 'goal', goalId: GoalId('goal-cleared'), revision: 1, round: 1 },
    }))
    await test.agent.whenIdle()

    expect(turnEnds(test.agent)).toEqual(['blocked'])
    expect(test.adapter.requests).toHaveLength(0)
    expect(test.ctx.offPeak.list()).toHaveLength(0)
  })

  it('logs a deferral whose queue entry cannot be written', async () => {
    const storage = new FailingStorage()
    const test = await harness(NIGHT, { backend: storage })
    const warn = vi.spyOn(test.ctx.logger, 'warn')
    storage.failNextWrite(new Error('disk full'))

    test.ctx.goals.create(test.agent, { objective: 'index the corpus', maxGoalRounds: 4 })

    await waitForGoal(test.ctx, test.agent, current => current?.phase === 'paused')
    await waitUntil(() => warn.mock.calls.length > 0, 'a warning')
    expect(warn).toHaveBeenCalledWith('off-peak: could not record a deferral: disk full')
    expect(test.ctx.offPeak.list()).toHaveLength(0)
  })

  it('queues a deferred goal round even when the session already has a manual task waiting', async () => {
    const test = await harness()
    await test.ctx.offPeak.queue({ sessionId: test.agent.id, objective: 'summarize the logs' })
    test.ctx.goals.create(test.agent, { objective: 'wait for cheap hours', maxGoalRounds: 4 })
    await waitForGoal(test.ctx, test.agent, current => current?.phase === 'paused')
    await waitForQueue(test.ctx, entries => entries.length === 2)
    expect(test.ctx.offPeak.list().map(entry => entry.kind).sort()).toEqual(['goal-round', 'manual'])
  })

  it('does not defer when the plugin is disabled', async () => {
    const test = await harness({ ...NIGHT, enabled: false })
    test.ctx.goals.create(test.agent, { objective: 'peak work', maxGoalRounds: 1 })

    await waitForGoal(test.ctx, test.agent, current => current?.phase === 'blocked')
    expect(test.ctx.offPeak.list()).toHaveLength(0)
    expect(test.ctx.offPeak.isOpen()).toBe(true)
  })
})

describe('draining when the window opens', () => {
  it('resumes the deferred goal and marks the entry done', async () => {
    const test = await harness()
    test.ctx.goals.create(test.agent, { objective: 'wait for cheap hours', maxGoalRounds: 4 })
    await waitForGoal(test.ctx, test.agent, current => current?.phase === 'paused')
    await waitForQueue(test.ctx, entries => entries.length === 1)

    vi.setSystemTime(new Date(2026, 8, 11, 1, 0, 0, 0))
    await test.ctx.offPeak.drain()
    await waitForQueue(test.ctx, entries => entries[0]?.state === 'done')

    expect(test.ctx.offPeak.list()[0]).toMatchObject({ state: 'done' })
    expect(test.adapter.requests.length).toBeGreaterThan(0)
  })

  it('starts at most maxConcurrent entries, oldest first', async () => {
    const test = await harness()
    const first = await test.ctx.offPeak.queue({ sessionId: test.agent.id, objective: 'first' })
    vi.setSystemTime(new Date(2026, 8, 10, 22, 5, 0, 0))
    const second = await test.ctx.offPeak.queue({ sessionId: test.agent.id, objective: 'second' })

    const summary = await test.ctx.offPeak.drain()
    expect(summary).toMatchObject({ started: 1, remaining: 1 })
    const byId = new Map(test.ctx.offPeak.list().map(entry => [entry.id, entry.state]))
    expect(byId.get(first.id)).toBe('done')
    expect(byId.get(second.id)).toBe('queued')
  })

  it('exempts a drained session for one round only, so it defers again afterwards', async () => {
    const test = await harness()
    test.ctx.goals.create(test.agent, { objective: 'one exempt round', maxGoalRounds: 8 })
    await waitForGoal(test.ctx, test.agent, current => current?.phase === 'paused')
    await waitForQueue(test.ctx, entries => entries.length === 1)

    await test.ctx.offPeak.drain()
    // The resumed round runs off-window, then the session is deferrable again.
    await waitForGoal(test.ctx, test.agent, current => current?.phase === 'paused')
    await waitForQueue(test.ctx, entries => entries.length === 2)

    expect(test.ctx.offPeak.list()).toHaveLength(2)
    expect(test.adapter.requests.length).toBeGreaterThan(0)
  })

  it('fails a stored manual entry that has no task instead of sending an empty prompt', async () => {
    const sessionId = SessionId('off-peak-stored')
    const stored: StoredEntry = { id: 'hand-edited', sessionId, kind: 'manual', queuedAt: Date.now(), state: 'queued' }
    const test = await harness(NIGHT, { sessionId, stored: [stored] })

    const summary = await test.ctx.offPeak.drain()
    await test.agent.whenIdle()

    expect(summary).toMatchObject({ started: 1, done: 0, failed: 1 })
    expect(test.ctx.offPeak.list()).toMatchObject([{ id: 'hand-edited', state: 'failed', error: 'no task to send' }])
    expect(test.adapter.requests).toHaveLength(0)
  })

  it('fails a deferred round whose goal was cleared before the drain', async () => {
    const test = await harness()
    test.ctx.goals.create(test.agent, { objective: 'wait for cheap hours', maxGoalRounds: 4 })
    const goal = await waitForGoal(test.ctx, test.agent, current => current?.phase === 'paused')
    await waitForQueue(test.ctx, entries => entries.length === 1)
    test.ctx.goals.clear(test.agent, { id: goal!.id, revision: goal!.revision })

    const summary = await test.ctx.offPeak.drain()

    expect(summary).toMatchObject({ started: 1, done: 0, failed: 1 })
    expect(test.ctx.offPeak.list()).toMatchObject([{ state: 'failed', error: 'no goal to resume' }])
  })

  it('marks a deferred round done when someone already resumed its goal by hand', async () => {
    const sessionId = SessionId('off-peak-resumed-by-hand')
    const stored: StoredEntry = { id: 'deferred', sessionId, kind: 'goal-round', objective: 'wait for cheap hours', queuedAt: Date.now(), state: 'queued' }
    const test = await harness(NIGHT, { driver: false, sessionId, stored: [stored] })
    test.ctx.goals.create(test.agent, { objective: 'wait for cheap hours', maxGoalRounds: 4 })
    expect(test.ctx.goals.get(test.agent)).toMatchObject({ phase: 'active', activation: 'armed' })

    const summary = await test.ctx.offPeak.drain()

    expect(summary).toMatchObject({ started: 1, done: 1, failed: 0 })
    expect(test.ctx.offPeak.list()).toMatchObject([{ id: 'deferred', state: 'done' }])
    expect(test.ctx.goals.get(test.agent)).toMatchObject({ phase: 'active', activation: 'armed' })
  })

  it('announces a drain that started entries, and stays quiet for an empty one', async () => {
    const test = await harness()
    const sent: Notification[] = []
    test.ctx.provide('notify', { send: async (notification: Notification) => { sent.push(notification) } } as never)
    await test.ctx.offPeak.queue({ sessionId: test.agent.id, objective: 'first' })
    vi.setSystemTime(new Date(2026, 8, 10, 22, 5, 0, 0))
    await test.ctx.offPeak.queue({ sessionId: SessionId('off-peak-gone'), objective: 'second' })

    await test.ctx.offPeak.drain()
    await test.ctx.offPeak.drain()
    await test.ctx.offPeak.drain()

    expect(sent).toEqual([
      { event: 'offPeakDrained', title: 'Off-peak window drained 1 of 1', text: '1 still queued, 0 failed.' },
      { event: 'offPeakDrained', title: 'Off-peak window drained 0 of 1', text: '0 still queued, 1 failed.' },
    ])
  })

  it('logs a drain the window timer starts when the queue cannot be written', async () => {
    const storage = new FailingStorage()
    const test = await harness(NIGHT, { backend: storage })
    const entry = await test.ctx.offPeak.queue({ sessionId: test.agent.id, objective: 'reindex the archive' })
    const warn = vi.spyOn(test.ctx.logger, 'warn')
    storage.failNextWrite(new Error('disk full'))

    // 22:00 to 01:00: the window opens and the timer drains.
    await settle(3 * HOUR)

    await waitUntil(() => warn.mock.calls.length > 0, 'a warning')
    expect(warn).toHaveBeenCalledWith('off-peak: drain failed: disk full')
    expect(test.ctx.offPeak.list()).toEqual([entry])
  })

  it('reports a failure instead of throwing when the session is gone', async () => {
    const test = await harness()
    await test.ctx.offPeak.queue({ sessionId: SessionId('not-live'), objective: 'orphan' })

    const summary = await test.ctx.offPeak.drain()
    expect(summary).toMatchObject({ started: 1, done: 0, failed: 1 })
    expect(test.ctx.offPeak.list()[0]).toMatchObject({ state: 'failed' })
  })
})

describe('window close', () => {
  it('pauses what the drainer resumed so work does not spill into peak hours', async () => {
    const test = await harness()
    test.ctx.goals.create(test.agent, { objective: 'spill guard', maxGoalRounds: 8 })
    await waitForGoal(test.ctx, test.agent, current => current?.phase === 'paused')

    vi.setSystemTime(new Date(2026, 8, 11, 1, 0, 0, 0))
    await settle(3 * 60 * 60 * 1000)
    vi.setSystemTime(new Date(2026, 8, 11, 5, 0, 0, 0))
    await settle(5 * 60 * 60 * 1000)

    expect(test.ctx.goals.get(test.agent)?.phase).toBe('paused')
  })

  it('queues a goal it pauses at the close, so the next window resumes it', async () => {
    const test = await harness()
    test.ctx.goals.create(test.agent, { objective: 'finish overnight', maxGoalRounds: 8 })
    await waitForGoal(test.ctx, test.agent, current => current?.phase === 'paused')
    await waitForQueue(test.ctx, entries => entries.length === 1)
    const release = test.adapter.hold()

    // 22:00 to 01:00: the window opens and the drained round waits on the model.
    await settle(3 * HOUR)
    await waitForRequests(test.adapter, 1)
    // 01:00 to 05:00: the window closes while that round is in flight.
    await settle(4 * HOUR)

    await waitForGoal(test.ctx, test.agent, current => current?.phase === 'paused')
    const queued = await waitForQueue(test.ctx, entries => entries.some(entry => entry.state === 'queued'))
    expect(queued.filter(entry => entry.state === 'queued')).toMatchObject([{ kind: 'goal-round', sessionId: test.agent.id }])

    // 05:00 to 01:00 the next night: the next window resumes the goal.
    release()
    await settle(20 * HOUR)
    await waitForQueue(test.ctx, entries => entries.every(entry => entry.state === 'done'))
    expect(test.adapter.requests.length).toBeGreaterThan(1)
  })

  it('lets a round in flight finish under finishRoundInFlight, then defers the next one', async () => {
    const test = await harness({ ...NIGHT, finishRoundInFlight: true })
    test.ctx.goals.create(test.agent, { objective: 'let it finish', maxGoalRounds: 8 })
    await waitForGoal(test.ctx, test.agent, current => current?.phase === 'paused')
    await waitForQueue(test.ctx, entries => entries.length === 1)
    const release = test.adapter.hold()

    // 22:00 to 01:00: the window opens and the drained round waits on the model.
    await settle(3 * HOUR)
    await waitForRequests(test.adapter, 1)
    // 01:00 to 05:00: the window closes while that round is in flight.
    await settle(4 * HOUR)
    expect(test.ctx.goals.get(test.agent)?.phase).toBe('active')

    release()
    await waitForGoal(test.ctx, test.agent, current => current?.phase === 'paused')
    expect(turnEnds(test.agent)).toEqual(['blocked', 'completed', 'blocked'])
    await waitForQueue(test.ctx, entries => entries.some(entry => entry.state === 'queued'))
  })

  it('skips a resumed session that closed before the window did', async () => {
    const closing = SessionId('off-peak-closing')
    const stored: StoredEntry = { id: 'resume-closing', sessionId: closing, kind: 'goal-round', objective: 'tidy up', queuedAt: Date.now(), state: 'queued' }
    // Without the round driver, resuming the goal starts no turn, so the session stays resumed until it closes.
    const test = await harness(NIGHT, { driver: false, stored: [stored] })
    const handle = await test.ctx.agents.create({ sessionId: closing, agentOptions: { provider: 'mock', model: 'mock' } })
    const goal = test.ctx.goals.create(handle.agent, { objective: 'tidy up', maxGoalRounds: 4 })
    test.ctx.goals.pause(handle.agent, { id: goal.id, revision: goal.revision })

    // 22:00 to 01:00: the window opens and the drainer resumes the goal.
    await settle(3 * HOUR)
    await waitForQueue(test.ctx, entries => entries[0]?.state === 'done')
    await handle.dispose()
    // 01:00 to 05:00: the window closes after the session did.
    await settle(4 * HOUR)

    // The timer keeps going: the next window drains a task queued after the close.
    await test.ctx.offPeak.queue({ sessionId: test.agent.id, objective: 'next night' })
    await settle(20 * HOUR)
    await waitForQueue(test.ctx, entries => entries.length === 2 && entries.every(entry => entry.state === 'done'))
  })

  it('never resumes a goal the human paused, because that goal has no queue entry', async () => {
    vi.setSystemTime(new Date(2026, 8, 10, 2, 0, 0, 0))
    const test = await harness()
    test.ctx.goals.create(test.agent, { objective: 'human stop', maxGoalRounds: 8 })
    const goal = await waitForGoal(test.ctx, test.agent, current => current !== undefined)
    if (goal !== undefined && goal.phase === 'active') {
      test.ctx.goals.pause(test.agent, { id: goal.id, revision: goal.revision })
    }

    await test.ctx.offPeak.drain()
    await settle(60 * 1000)

    expect(test.ctx.goals.get(test.agent)?.phase).toBe('paused')
    expect(test.ctx.offPeak.list()).toHaveLength(0)
  })
})

describe('/offpeak', () => {
  it('lists the window state, queues a task, and cancels it', async () => {
    const test = await harness()
    const command = test.ctx.commands.find(test.agent, 'offpeak')
    expect(command).toBeDefined()
    const invoke = async (rawInput: string) => command!.handler({
      commandId: CommandId('c1'), agent: test.agent, rawInput, attachments: [], signal,
    })

    const empty = await invoke('list') as { kind: string; text?: string }
    expect(empty.text).toContain('closed')
    expect(empty.text).toContain('Nothing queued')

    const queued = await invoke('queue reindex the archive') as { kind: string; text?: string }
    expect(queued.kind).toBe('success')
    const entry = test.ctx.offPeak.list()[0]
    expect(entry).toMatchObject({ kind: 'manual', objective: 'reindex the archive' })

    const cancelled = await invoke(`cancel ${entry?.id ?? ''}`) as { kind: string }
    expect(cancelled.kind).toBe('success')
    expect(test.ctx.offPeak.list()).toHaveLength(0)
  })

  it('lists the queue when no verb is given', async () => {
    const test = await harness()
    const command = test.ctx.commands.find(test.agent, 'offpeak')!

    const listed = await command.handler({ commandId: CommandId('c1'), agent: test.agent, rawInput: '', attachments: [], signal })

    expect(listed).toMatchObject({ kind: 'success', text: 'Window closed; 01:00-05:00.\nNothing queued.' })
  })

  it('lists queued entries under the open window', async () => {
    vi.setSystemTime(new Date(2026, 8, 11, 2, 0, 0, 0))
    const test = await harness()
    const entry = await test.ctx.offPeak.queue({ sessionId: SessionId('off-peak-elsewhere'), objective: 'reindex the archive' })

    expect(await offpeak(test, 'list')).toEqual({
      kind: 'success',
      text: `Window open; 01:00-05:00.\n${entry.id} manual queued ${new Date(entry.queuedAt).toISOString()} reindex the archive`,
    })
  })

  it('says when deferral is disabled', async () => {
    const test = await harness({ ...NIGHT, enabled: false })

    expect(await offpeak(test, 'list')).toEqual({ kind: 'success', text: 'Off-peak deferral is disabled.\nNothing queued.' })
  })

  it("queues a task in the session's workspace", async () => {
    const test = await harness(NIGHT, { cwd: root! })

    await offpeak(test, 'queue reindex the archive')

    expect(test.ctx.offPeak.list()).toMatchObject([{ kind: 'manual', objective: 'reindex the archive', cwd: root }])
  })

  it('drains the queue by hand', async () => {
    const test = await harness()
    await test.ctx.offPeak.queue({ sessionId: test.agent.id, objective: 'reindex the archive' })

    expect(await offpeak(test, 'drain')).toEqual({ kind: 'success', text: 'Started 1, 0 still queued.' })
    expect(test.ctx.offPeak.list()).toMatchObject([{ state: 'done' }])
  })

  it('reports usage for a cancel with no id, and the reason for an unknown one', async () => {
    const test = await harness()

    expect(await offpeak(test, 'cancel')).toEqual({ kind: 'error', text: 'Usage: /offpeak list | queue <task> | drain | cancel <id>' })
    expect(await offpeak(test, 'cancel nope')).toEqual({ kind: 'error', text: 'no queued entry "nope"' })
  })

  it('reports a storage failure that is not an Error by its text', async () => {
    const storage = new FailingStorage()
    const test = await harness(NIGHT, { backend: storage })
    storage.failNextWrite('storage offline')

    expect(await offpeak(test, 'queue reindex the archive')).toEqual({ kind: 'error', text: 'storage offline' })
    expect(test.ctx.offPeak.list()).toHaveLength(0)
  })

  it('reports usage for an unknown verb and a queue with no task', async () => {
    const test = await harness()
    const command = test.ctx.commands.find(test.agent, 'offpeak')!
    const invoke = async (rawInput: string) => command.handler({
      commandId: CommandId('c1'), agent: test.agent, rawInput, attachments: [], signal,
    })
    expect(await invoke('nonsense')).toMatchObject({ kind: 'error' })
    expect(await invoke('queue')).toMatchObject({ kind: 'error' })
  })
})

describe('the off_peak tool', () => {
  it('is not offered while the row is disabled, since nothing would run what it parks', async () => {
    const test = await harness({ ...NIGHT, enabled: false })
    expect(test.ctx.offPeak.enabled).toBe(false)
    expect(test.ctx.tools.get('off_peak')).toBeUndefined()
  })

  it('queues a task for the model and lists what is waiting', async () => {
    const test = await harness()
    const queued = await executeModelToolFixture(test.ctx, {
      signal, callId: ToolCallId('t1'), name: 'off_peak', agent: test.agent,
      arguments: { action: 'queue', task: 'refresh the dependency audit' },
    })
    expect(queued.isError).toBe(false)
    expect(test.ctx.offPeak.list()).toHaveLength(1)

    const listed = await executeModelToolFixture(test.ctx, {
      signal, callId: ToolCallId('t2'), name: 'off_peak', agent: test.agent, arguments: { action: 'list' },
    })
    expect(listed.value).toMatchObject({ open: false })
  })

  it('reports an open window to the model', async () => {
    vi.setSystemTime(new Date(2026, 8, 11, 2, 0, 0, 0))
    const test = await harness()

    const listed = await executeModelToolFixture(test.ctx, {
      signal, callId: ToolCallId('t4'), name: 'off_peak', agent: test.agent, arguments: { action: 'list' },
    })

    expect(listed.content).toEqual([{ type: 'text', text: 'Off-peak window open; 0 queued.' }])
  })

  it('refuses to queue without an owning session', async () => {
    const test = await harness()

    const result = await executeModelToolFixture(test.ctx, {
      signal, callId: ToolCallId('t5'), name: 'off_peak', arguments: { action: 'queue', task: 'refresh the dependency audit' },
    })

    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('off_peak needs an owning session')
    expect(test.ctx.offPeak.list()).toHaveLength(0)
  })

  it("queues the task in the session's workspace", async () => {
    const test = await harness(NIGHT, { cwd: root! })

    await executeModelToolFixture(test.ctx, {
      signal, callId: ToolCallId('t6'), name: 'off_peak', agent: test.agent,
      arguments: { action: 'queue', task: 'refresh the dependency audit' },
    })

    expect(test.ctx.offPeak.list()).toMatchObject([{ objective: 'refresh the dependency audit', cwd: root }])
  })

  it('lists a stored entry that has no objective as an empty task', async () => {
    const stored: StoredEntry = { id: 'hand-edited', sessionId: 'off-peak-elsewhere', kind: 'goal-round', queuedAt: Date.now(), state: 'queued' }
    const test = await harness(NIGHT, { stored: [stored] })

    const listed = await executeModelToolFixture(test.ctx, {
      signal, callId: ToolCallId('t7'), name: 'off_peak', agent: test.agent, arguments: { action: 'list' },
    })

    expect(listed.value).toEqual({ open: false, entries: [{ id: 'hand-edited', state: 'queued', task: '' }] })
  })

  it('rejects a queue call with no task', async () => {
    const test = await harness()
    const result = await executeModelToolFixture(test.ctx, {
      signal, callId: ToolCallId('t3'), name: 'off_peak', agent: test.agent, arguments: { action: 'queue' },
    })
    expect(result.isError).toBe(true)
  })
})
