import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import CommandRuntime, { CommandId } from '@deepseek-ai/dsh-commands'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import type { Notification } from '@deepseek-ai/dsh-notify'
import Storage, { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import type { StorageBackend } from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import type { TableValueOf } from '@deepseek-ai/dsh-storage-domain'
import * as CronSessions from '@deepseek-ai/dsh-cron-sessions'
import type { Config, CronSessionsChange } from '@deepseek-ai/dsh-cron-sessions'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'

/** Scripted model whose requests wait after arriving until a hold is released or their turn is cancelled. */
class HeldAdapter extends MockAdapter {
  /** Requests that reached the model, including held ones. */
  arrived = 0
  private held: Promise<undefined> | undefined

  /**
   * Hold every later request until the returned release runs.
   * @returns the release.
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
    this.arrived += 1
    const held = this.held
    if (held !== undefined) {
      await new Promise<void>((resolve, reject) => {
        const abort = (): void => { reject(new Error('aborted')) }
        if (options.signal?.aborted) { abort(); return }
        options.signal?.addEventListener('abort', abort, { once: true })
        void held.then(() => { resolve() })
      })
    }
    yield* super.stream(options)
  }
}

let root: string | undefined
let storages: string | undefined
let context: Context | undefined
/** The cron plugin's fiber from the latest {@link setup}. */
let cronFiber: Fiber | undefined

afterEach(async () => {
  vi.useRealTimers()
  await context?.fiber.dispose()
  context = undefined
  cronFiber = undefined
  for (const dir of [root, storages]) if (dir !== undefined) await rm(dir, { recursive: true, force: true })
  root = undefined
  storages = undefined
})

const signal = new AbortController().signal

/** What `/cron` answers to input it cannot parse. */
const USAGE = 'Usage: /cron list | add <name> "<cron>" <prompt> | enable <id> | disable <id> | run <id> | remove <id>'

/** One stored schedule record, as the plugin writes it. */
type StoredSchedule = TableValueOf<typeof CronSessions.cronSessionsDomainSpec, 'schedules'>

/** How {@link setup} composes the harness around the cron plugin. */
interface SetupOptions {
  /** Storage for the schedule domain; the JSON backend under a temporary root when omitted. */
  readonly backend?: StorageBackend
  /** Records the schedule domain holds before the plugin opens it, as an earlier process or a hand edit leaves them. */
  readonly stored?: readonly StoredSchedule[]
  /** Whether the deployment mounts a default model; without one a run's agent has no provider or model. */
  readonly defaultModel?: boolean
}

async function setup(adapter: MockAdapter, config: Partial<Config> = {}, options: SetupOptions = {}): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-cron-ws-'))
  storages = await mkdtemp(join(tmpdir(), 'dsh-cron-storages-'))
  const ctx = new Context()
  context = ctx
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['mock'], adapter)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(Storage)
  if (options.backend === undefined) {
    await ctx.plugin(StorageJson, { root: storages })
    await ctx.plugin(StorageDomain, { backend: 'json' })
  } else {
    ctx.storage.backend.register('memory', options.backend)
    ctx.provide(storageBackendServiceKey('memory'), options.backend)
    await ctx.plugin(StorageDomain, { backend: 'memory' })
  }
  if (options.stored !== undefined) {
    const seed = await ctx.storageDomain.open(CronSessions.cronSessionsDomainSpec)
    for (const row of options.stored) await seed.table('schedules').put(row.id, row)
    await seed.close()
  }
  if (options.defaultModel !== false) {
    ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'mock', model: 'mock' }) } as never)
  }
  cronFiber = await ctx.plugin(CronSessions, { tickMs: 1000, maxConcurrent: 1, catchUp: false, ...config })
  return ctx
}

async function until(check: () => boolean, ms = 10_000): Promise<void> {
  // performance.now keeps the deadline real while a test fakes Date.
  const start = performance.now()
  while (!check()) {
    if (performance.now() - start > ms) throw new Error('condition not met in time')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

/** Fake the clock and the ticker's interval, starting at `start`; the loop's own timers stay real. */
function fakeClock(start: Date): void {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
  vi.setSystemTime(start)
}

/** A session to run `/cron` from, in `cwd` when given. */
async function owner(ctx: Context, cwd?: string): Promise<Agent> {
  return await ctx.agentLoop.create(SessionId(`cron-owner-${Math.random()}`), { provider: 'mock', model: 'mock' }, cwd === undefined ? {} : { cwd })
}

/** Invoke `/cron` from `agent`. */
async function cron(ctx: Context, agent: Agent, rawInput: string): Promise<CommandResult> {
  return await ctx.commands.find(agent, 'cron')!.handler({ commandId: CommandId('c'), agent, rawInput, attachments: [], signal })
}

/** Record every `cron-sessions/change` from now on. */
function changes(ctx: Context): CronSessionsChange[] {
  const seen: CronSessionsChange[] = []
  ctx.on('cron-sessions/change', (change) => { seen.push(change) })
  return seen
}

/** A preset roster that knows no preset: every lookup rejects with `reason`. */
function missingPresets(reason: unknown): never {
  return { resolve: async () => { throw reason } } as never
}

describe('cron sessions', () => {
  it('stores schedules durably and lists them', async () => {
    const ctx = await setup(new MockAdapter([]))
    const added = await ctx.cronSessions.add({ name: 'nightly', cron: '0 2 * * *', cwd: root!, prompt: 'run the checks' })
    expect(added).toMatchObject({ name: 'nightly', cron: '0 2 * * *', enabled: true })
    expect(ctx.cronSessions.list()).toHaveLength(1)
    await ctx.cronSessions.setEnabled(added.id, false)
    expect(ctx.cronSessions.list()[0]).toMatchObject({ enabled: false })
    await ctx.cronSessions.remove(added.id)
    expect(ctx.cronSessions.list()).toHaveLength(0)
  })

  it('reopens its stored schedules when the plugin reloads', async () => {
    const config = { tickMs: 3_600_000, maxConcurrent: 1, catchUp: false }
    const ctx = await setup(new MockAdapter([]), config)
    const added = await ctx.cronSessions.add({ name: 'nightly', cron: '0 2 * * *', cwd: root!, prompt: 'run the checks' })

    await cronFiber!.dispose()
    cronFiber = await ctx.plugin(CronSessions, config)

    expect(ctx.cronSessions.list()).toEqual([added])
  })

  it('keeps schedules added just before an unload when the plugin reloads', async () => {
    const config = { tickMs: 3_600_000, maxConcurrent: 1, catchUp: false }
    const ctx = await setup(new MockAdapter([]), config)
    const first = ctx.cronSessions.add({ name: 'first', cron: '0 2 * * *', cwd: root!, prompt: 'one' })
    const second = ctx.cronSessions.add({ name: 'second', cron: '0 3 * * *', cwd: root!, prompt: 'two' })

    await cronFiber!.dispose()
    cronFiber = await ctx.plugin(CronSessions, config)

    expect(ctx.cronSessions.list().map(schedule => schedule.name).sort()).toEqual(['first', 'second'])
    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
  })

  it('rejects an invalid cron expression', async () => {
    const ctx = await setup(new MockAdapter([]))
    await expect(ctx.cronSessions.add({ name: 'bad', cron: '99 * * * *', cwd: root!, prompt: 'x' })).rejects.toThrow('minute')
  })

  it('runs a due schedule in a fresh session and records the outcome', async () => {
    const adapter = new MockAdapter([textResponse('checked')])
    const ctx = await setup(adapter)
    const seen: { sessionId: string; cwd: string | undefined; text: string }[] = []
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'user/message') return
      seen.push({ sessionId: session.id, cwd: session.header.cwd, text: event.data.content.map(block => block.type === 'text' ? block.text : '').join('') })
    })
    const added = await ctx.cronSessions.add({ name: 'every-minute', cron: '* * * * *', cwd: root!, prompt: 'run the checks' })
    await until(() => ctx.cronSessions.list()[0]?.lastOutcome !== undefined)
    const after = ctx.cronSessions.list()[0]!
    expect(after).toMatchObject({ id: added.id, lastOutcome: 'completed' })
    expect(after.lastSessionId).toBeDefined()
    expect(after.lastRunAt).toBeDefined()
    expect(seen).toContainEqual({ sessionId: after.lastSessionId, cwd: root, text: 'run the checks' })
    // The run's agent is disposed once the outcome is recorded.
    expect(ctx.agents.get(SessionId(after.lastSessionId!))).toBeUndefined()
  })

  it('does not run the same schedule twice within one minute', async () => {
    const adapter = new MockAdapter([textResponse('once'), textResponse('twice')])
    const ctx = await setup(adapter, { tickMs: 1000 })
    await ctx.cronSessions.add({ name: 'every-minute', cron: '* * * * *', cwd: root!, prompt: 'go' })
    await until(() => ctx.cronSessions.list()[0]?.lastOutcome !== undefined)
    const first = ctx.cronSessions.list()[0]!
    await new Promise(resolve => setTimeout(resolve, 1300))
    const sameMinute = Math.floor(first.lastRunAt! / 60_000) === Math.floor(Date.now() / 60_000)
    // A minute boundary during the wait legitimately allows a second run.
    if (sameMinute) expect(ctx.cronSessions.list()[0]!.lastSessionId).toBe(first.lastSessionId)
  })

  it('finishes a run whose schedule is removed while it runs', async () => {
    const adapter = new HeldAdapter([textResponse('reported')])
    const ctx = await setup(adapter, { tickMs: 3_600_000 })
    const added = await ctx.cronSessions.add({ name: 'weekly', cron: '0 0 * * 1', cwd: root!, prompt: 'report' })
    const kinds: string[] = []
    ctx.on('cron-sessions/change', ({ kind }) => { kinds.push(kind) })
    const release = adapter.hold()

    const run = ctx.cronSessions.runNow(added.id)
    await until(() => adapter.arrived === 1)
    await ctx.cronSessions.remove(added.id)
    release()

    await expect(run).resolves.toBe('completed')
    expect(ctx.cronSessions.list()).toEqual([])
    expect(kinds).toEqual(['run-started', 'removed', 'run-finished'])
  })

  it('lists a run an unload cut short as interrupted, not with the outcome before it', async () => {
    const config = { tickMs: 3_600_000, maxConcurrent: 1, catchUp: false }
    const adapter = new HeldAdapter([textResponse('reported'), textResponse('reported again')])
    const ctx = await setup(adapter, config)
    const added = await ctx.cronSessions.add({ name: 'weekly', cron: '0 0 * * 1', cwd: root!, prompt: 'report' })
    await expect(ctx.cronSessions.runNow(added.id)).resolves.toBe('completed')
    adapter.hold()

    const run = ctx.cronSessions.runNow(added.id)
    await until(() => adapter.arrived === 2)
    await cronFiber!.dispose()
    await expect(run).rejects.toThrow("domain 'cron_sessions' is closed")
    cronFiber = await ctx.plugin(CronSessions, config)
    const owner = await ctx.agentLoop.create(SessionId('cron-owner-cut'), { provider: 'mock', model: 'mock' }, { cwd: root! })
    const listed = await ctx.commands.find(owner, 'cron')!.handler({ commandId: CommandId('c'), agent: owner, rawInput: 'list', attachments: [], signal })

    expect(ctx.cronSessions.list()[0]).not.toHaveProperty('lastOutcome')
    expect(listed).toMatchObject({ kind: 'success', text: expect.stringContaining('interrupted') as unknown })
  })

  it('rejects runNow when the outcome cannot be stored', async () => {
    const pool = new MemoryMediaPool()
    const ctx = await setup(new MockAdapter([textResponse('reported')]), { tickMs: 3_600_000 }, { backend: new MemoryStorageBackend(pool) })
    const added = await ctx.cronSessions.add({ name: 'weekly', cron: '0 0 * * 1', cwd: root!, prompt: 'report' })
    ctx.on('cron-sessions/change', ({ kind }) => {
      if (kind === 'run-started') pool.failNextWrites = 1
    })

    await expect(ctx.cronSessions.runNow(added.id)).rejects.toThrow('injected write failure')
    expect(ctx.cronSessions.list()[0]).not.toHaveProperty('lastOutcome')
  })

  it('runs on demand through /cron run and reports through /cron list', async () => {
    const adapter = new MockAdapter([textResponse('manual')])
    const ctx = await setup(adapter, { tickMs: 3_600_000 })
    const added = await ctx.cronSessions.add({ name: 'weekly', cron: '0 0 * * 1', cwd: root!, prompt: 'report' })
    const owner = await ctx.agentLoop.create(SessionId('cron-owner'), { provider: 'mock', model: 'mock' }, { cwd: root! })
    const command = ctx.commands.find(owner, 'cron')!
    const invoke = (rawInput: string) => command.handler({ commandId: CommandId('c'), agent: owner, rawInput, attachments: [], signal })
    expect((await invoke(`run ${added.id}`)).kind).toBe('success')
    await until(() => ctx.cronSessions.list()[0]?.lastOutcome !== undefined)
    const listed = await invoke('list') as { kind: string; text?: string }
    expect(listed.kind).toBe('success')
    expect(listed.text).toContain('weekly')
    expect(listed.text).toContain('completed')
  })

  it('lists the schedules when no verb is given', async () => {
    const ctx = await setup(new MockAdapter([]), { tickMs: 3_600_000 })
    const owner = await ctx.agentLoop.create(SessionId('cron-owner-bare'), { provider: 'mock', model: 'mock' }, { cwd: root! })
    const command = ctx.commands.find(owner, 'cron')!

    const listed = await command.handler({ commandId: CommandId('c'), agent: owner, rawInput: '', attachments: [], signal })

    expect(listed).toEqual({ kind: 'success', text: 'No schedules.' })
  })

  it('adds a schedule through /cron add with the session cwd as default', async () => {
    const ctx = await setup(new MockAdapter([]), { tickMs: 3_600_000 })
    const owner = await ctx.agentLoop.create(SessionId('cron-owner-2'), { provider: 'mock', model: 'mock' }, { cwd: root! })
    const command = ctx.commands.find(owner, 'cron')!
    const invoke = (rawInput: string) => command.handler({ commandId: CommandId('c'), agent: owner, rawInput, attachments: [], signal })
    expect((await invoke('add nightly "0 2 * * *" run the full test suite')).kind).toBe('success')
    expect(ctx.cronSessions.list()[0]).toMatchObject({ name: 'nightly', cron: '0 2 * * *', cwd: root, prompt: 'run the full test suite' })
    expect((await invoke('add broken "x y" nope')).kind).toBe('error')
    expect((await invoke('nonsense')).kind).toBe('error')
  })
})

describe('schedules', () => {
  it('lists schedules oldest first', async () => {
    fakeClock(new Date(2026, 8, 20, 10, 0, 0))
    const ctx = await setup(new MockAdapter([]), { tickMs: 3_600_000 })
    await ctx.cronSessions.add({ name: 'older', cron: '0 2 * * *', cwd: root!, prompt: 'one' })
    vi.setSystemTime(new Date(2026, 8, 20, 11, 0, 0))
    await ctx.cronSessions.add({ name: 'newer', cron: '0 3 * * *', cwd: root!, prompt: 'two' })

    expect(ctx.cronSessions.list().map(schedule => schedule.name)).toEqual(['older', 'newer'])
  })

  it('rejects a schedule without a name or a prompt', async () => {
    const ctx = await setup(new MockAdapter([]), { tickMs: 3_600_000 })

    await expect(ctx.cronSessions.add({ name: '  ', cron: '0 2 * * *', cwd: root!, prompt: 'run' })).rejects.toThrow('a schedule needs a name')
    await expect(ctx.cronSessions.add({ name: 'nightly', cron: '0 2 * * *', cwd: root!, prompt: '  ' })).rejects.toThrow('a schedule needs a prompt')
    expect(ctx.cronSessions.list()).toEqual([])
  })

  it('refuses to change, run, or remove a schedule it does not have', async () => {
    const ctx = await setup(new MockAdapter([]), { tickMs: 3_600_000 })

    await expect(ctx.cronSessions.setEnabled('missing', false)).rejects.toThrow('no schedule "missing"')
    await expect(ctx.cronSessions.runNow('missing')).rejects.toThrow('no schedule "missing"')
    await expect(ctx.cronSessions.remove('missing')).rejects.toThrow('no schedule "missing"')
  })
})

describe('runs', () => {
  it('reports a live run and joins a second run request to it', async () => {
    const adapter = new HeldAdapter([textResponse('reported')])
    const ctx = await setup(adapter, { tickMs: 3_600_000 })
    const added = await ctx.cronSessions.add({ name: 'weekly', cron: '0 0 * * 1', cwd: root!, prompt: 'report' })
    const release = adapter.hold()

    const first = ctx.cronSessions.runNow(added.id)
    const second = ctx.cronSessions.runNow(added.id)
    expect(ctx.cronSessions.isRunning(added.id)).toBe(true)
    await until(() => adapter.arrived === 1)
    release()

    expect(await Promise.all([first, second])).toEqual(['completed', 'completed'])
    expect(adapter.arrived).toBe(1)
    expect(ctx.cronSessions.isRunning(added.id)).toBe(false)
  })

  it('records an error outcome when the run fails in its session', async () => {
    const ctx = await setup(new MockAdapter([]), { tickMs: 3_600_000 }, { defaultModel: false })
    const added = await ctx.cronSessions.add({ name: 'weekly', cron: '0 0 * * 1', cwd: root!, prompt: 'report' })

    // With no default model the run's agent has no route, so its first step fails.
    expect(await ctx.cronSessions.runNow(added.id)).toBe('error')
    expect(ctx.cronSessions.list()[0]).toMatchObject({ lastOutcome: 'error' })
    expect(typeof ctx.cronSessions.list()[0]?.lastSessionId).toBe('string')
  })

  it('keeps a run completed when another session fails meanwhile', async () => {
    const adapter = new HeldAdapter([textResponse('reported')])
    const ctx = await setup(adapter, { tickMs: 3_600_000 })
    const added = await ctx.cronSessions.add({ name: 'weekly', cron: '0 0 * * 1', cwd: root!, prompt: 'report' })
    const release = adapter.hold()
    const run = ctx.cronSessions.runNow(added.id)
    await until(() => adapter.arrived === 1)

    // A session with no route fails its first step while the run is live.
    const other = await ctx.agentLoop.create(SessionId('cron-other'), {})
    other.followup(createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }))
    await other.whenIdle()
    release()

    expect(await run).toBe('completed')
  })

  it("composes each run from the schedule's agent preset, or the default one", async () => {
    const ctx = await setup(new MockAdapter([textResponse('one'), textResponse('two')]), { tickMs: 3_600_000 })
    const mounted: (string | undefined)[] = []
    ctx.provide('agentPresets', {
      resolve: async (id?: string) => ({ id: id ?? 'general' }),
      mount: async (_agentCtx: Context, id?: string) => { mounted.push(id) },
    } as never)
    const headers: (string | undefined)[] = []
    ctx.on('session/event', (session, event) => {
      if (event.type === 'user/message') headers.push(session.header.agentPreset)
    })
    const reviewer = await ctx.cronSessions.add({ name: 'review', cron: '0 0 * * 1', cwd: root!, prompt: 'review', agentPreset: 'reviewer' })
    const plain = await ctx.cronSessions.add({ name: 'plain', cron: '0 0 * * 1', cwd: root!, prompt: 'look' })

    await ctx.cronSessions.runNow(reviewer.id)
    await ctx.cronSessions.runNow(plain.id)

    expect(ctx.cronSessions.list().find(schedule => schedule.id === reviewer.id)).toMatchObject({ agentPreset: 'reviewer' })
    expect(mounted).toEqual(['reviewer', 'general'])
    expect(headers).toEqual(['reviewer', 'general'])
  })

  it('fails a run whose preset cannot be resolved, before any session opens', async () => {
    const ctx = await setup(new MockAdapter([]), { tickMs: 3_600_000 })
    ctx.provide('agentPresets', missingPresets(new Error('preset "ghost" not found')))
    const warn = vi.spyOn(ctx.logger, 'warn')
    const seen = changes(ctx)
    const added = await ctx.cronSessions.add({ name: 'haunted', cron: '0 0 * * 1', cwd: root!, prompt: 'boo', agentPreset: 'ghost' })

    expect(await ctx.cronSessions.runNow(added.id)).toBe('error')

    expect(warn).toHaveBeenCalledWith('cron-sessions: run of "haunted" failed: preset "ghost" not found')
    expect(seen).toEqual([{ id: added.id, kind: 'added' }, { id: added.id, kind: 'run-finished' }])
    expect(ctx.cronSessions.list()[0]).toMatchObject({ lastOutcome: 'error' })
    expect(ctx.cronSessions.list()[0]).not.toHaveProperty('lastSessionId')
  })

  it('logs a preset rejection that is not an Error by its text', async () => {
    const ctx = await setup(new MockAdapter([]), { tickMs: 3_600_000 })
    ctx.provide('agentPresets', missingPresets('presets offline'))
    const warn = vi.spyOn(ctx.logger, 'warn')
    const added = await ctx.cronSessions.add({ name: 'haunted', cron: '0 0 * * 1', cwd: root!, prompt: 'boo' })

    expect(await ctx.cronSessions.runNow(added.id)).toBe('error')
    expect(warn).toHaveBeenCalledWith('cron-sessions: run of "haunted" failed: presets offline')
  })

  it('announces each finished run through notify', async () => {
    const ctx = await setup(new MockAdapter([textResponse('reported')]), { tickMs: 3_600_000 })
    const sent: Notification[] = []
    ctx.provide('notify', { send: async (notification: Notification) => { sent.push(notification) } } as never)
    const weekly = await ctx.cronSessions.add({ name: 'weekly', cron: '0 0 * * 1', cwd: root!, prompt: 'report' })
    await ctx.cronSessions.runNow(weekly.id)
    ctx.provide('agentPresets', missingPresets(new Error('preset "ghost" not found')))
    const haunted = await ctx.cronSessions.add({ name: 'haunted', cron: '0 0 * * 1', cwd: root!, prompt: 'boo', agentPreset: 'ghost' })
    await ctx.cronSessions.runNow(haunted.id)

    const sessionId = ctx.cronSessions.list().find(schedule => schedule.id === weekly.id)?.lastSessionId
    expect(sent).toEqual([
      { event: 'cronRun', title: 'Scheduled run completed: weekly', text: 'report', sessionId },
      { event: 'cronRun', title: 'Scheduled run error: haunted', text: 'boo' },
    ])
  })

  it("records the outcome even when disposing the run's agent fails", async () => {
    const ctx = await setup(new MockAdapter([textResponse('reported')]), { tickMs: 3_600_000 })
    const added = await ctx.cronSessions.add({ name: 'weekly', cron: '0 0 * * 1', cwd: root!, prompt: 'report' })
    ctx.on('cron-sessions/change', ({ kind, sessionId }) => {
      if (kind !== 'run-started' || sessionId === undefined) return
      // A contribution in the run's agent scope fails its teardown after the scope is torn down.
      const { scope } = ctx.agents.get(sessionId) as unknown as { scope: { dispose: () => Promise<void> } }
      const dispose = scope.dispose.bind(scope)
      vi.spyOn(scope, 'dispose').mockImplementation(async () => {
        await dispose()
        throw new Error('scope teardown failed')
      })
    })

    expect(await ctx.cronSessions.runNow(added.id)).toBe('completed')
    expect(ctx.cronSessions.list()[0]).toMatchObject({ lastOutcome: 'completed' })
  })
})

describe('the ticker', () => {
  it('skips a disabled schedule', async () => {
    fakeClock(new Date(2026, 8, 20, 10, 0, 0))
    const ctx = await setup(new MockAdapter([]))
    const added = await ctx.cronSessions.add({ name: 'every-minute', cron: '* * * * *', cwd: root!, prompt: 'go' })
    await ctx.cronSessions.setEnabled(added.id, false)

    await vi.advanceTimersByTimeAsync(1000)

    expect(ctx.cronSessions.isRunning(added.id)).toBe(false)
    expect(ctx.cronSessions.list()[0]).not.toHaveProperty('lastRunAt')
  })

  it('starts no more than maxConcurrent due schedules at once', async () => {
    fakeClock(new Date(2026, 8, 20, 10, 0, 0))
    const adapter = new HeldAdapter([textResponse('first'), textResponse('second')])
    const ctx = await setup(adapter)
    const first = await ctx.cronSessions.add({ name: 'first', cron: '* * * * *', cwd: root!, prompt: 'one' })
    vi.setSystemTime(new Date(2026, 8, 20, 10, 0, 1))
    const second = await ctx.cronSessions.add({ name: 'second', cron: '* * * * *', cwd: root!, prompt: 'two' })
    const release = adapter.hold()

    await vi.advanceTimersByTimeAsync(1000)
    await until(() => adapter.arrived === 1)
    await vi.advanceTimersByTimeAsync(1000)
    expect([ctx.cronSessions.isRunning(first.id), ctx.cronSessions.isRunning(second.id)]).toEqual([true, false])

    release()
    await until(() => !ctx.cronSessions.isRunning(first.id))
    await vi.advanceTimersByTimeAsync(1000)
    expect(ctx.cronSessions.isRunning(second.id)).toBe(true)
    await until(() => !ctx.cronSessions.isRunning(second.id))
    expect(adapter.arrived).toBe(2)
  })

  it('lists a stored schedule with an unparsable expression but never runs it', async () => {
    fakeClock(new Date(2026, 8, 20, 10, 0, 0))
    const stored: StoredSchedule = { id: 'hand-edited', name: 'broken', cron: 'every night', cwd: '/srv/app', prompt: 'go', enabled: true }
    const ctx = await setup(new MockAdapter([]), {}, { stored: [stored] })

    await vi.advanceTimersByTimeAsync(1000)

    expect(ctx.cronSessions.isRunning('hand-edited')).toBe(false)
    expect(ctx.cronSessions.list()).toEqual([stored])
  })

  it('starts no run for a schedule removed just before its tick', async () => {
    fakeClock(new Date(2026, 8, 20, 10, 0, 0))
    const adapter = new MockAdapter([])
    const ctx = await setup(adapter)
    const added = await ctx.cronSessions.add({ name: 'every-minute', cron: '* * * * *', cwd: root!, prompt: 'go' })
    const seen = changes(ctx)

    const removed = ctx.cronSessions.remove(added.id)
    // The tick runs before the removal lands, so it still sees the schedule.
    vi.advanceTimersByTime(1000)
    await removed
    await until(() => !ctx.cronSessions.isRunning(added.id))

    expect(seen.map(change => change.kind)).toEqual(['removed'])
    expect(adapter.requests).toHaveLength(0)
    expect(ctx.cronSessions.list()).toEqual([])
  })

  it('catches up once on a schedule whose minute passed while the plugin was unloaded', async () => {
    fakeClock(new Date(2026, 8, 20, 1, 59, 30))
    const adapter = new MockAdapter([textResponse('before'), textResponse('caught up')])
    const ctx = await setup(adapter)
    const added = await ctx.cronSessions.add({ name: 'nightly', cron: '0 2 * * *', cwd: root!, prompt: 'run the checks' })
    await ctx.cronSessions.runNow(added.id)
    await cronFiber!.dispose()

    // Unloaded across 02:00, the plugin loads again at 03:30 with catch-up on.
    vi.setSystemTime(new Date(2026, 8, 20, 3, 30, 0))
    cronFiber = await ctx.plugin(CronSessions, { tickMs: 1000, maxConcurrent: 1, catchUp: true })
    await vi.advanceTimersByTimeAsync(1000)
    await until(() => !ctx.cronSessions.isRunning(added.id))
    await vi.advanceTimersByTimeAsync(1000)

    expect(ctx.cronSessions.isRunning(added.id)).toBe(false)
    expect(adapter.requests).toHaveLength(2)
    expect(ctx.cronSessions.list()[0]).toMatchObject({ lastOutcome: 'completed', lastRunAt: new Date(2026, 8, 20, 3, 30, 1).getTime() })
  })
})

describe('/cron', () => {
  it('reports usage for an add whose expression is not quoted', async () => {
    const ctx = await setup(new MockAdapter([]), { tickMs: 3_600_000 })
    const agent = await owner(ctx, root)

    expect(await cron(ctx, agent, 'add nightly 0 2 * * * run the checks')).toEqual({ kind: 'error', text: USAGE })
    expect(ctx.cronSessions.list()).toEqual([])
  })

  it('refuses to add from a session with no workspace directory', async () => {
    const ctx = await setup(new MockAdapter([]), { tickMs: 3_600_000 })
    const agent = await owner(ctx)

    expect(await cron(ctx, agent, 'add nightly "0 2 * * *" run the checks')).toEqual({
      kind: 'error', text: 'this session has no workspace directory to schedule in',
    })
  })

  it('disables, enables, and removes a schedule by id', async () => {
    const ctx = await setup(new MockAdapter([]), { tickMs: 3_600_000 })
    const agent = await owner(ctx, root)
    const added = await ctx.cronSessions.add({ name: 'nightly', cron: '0 2 * * *', cwd: root!, prompt: 'run the checks' })

    expect(await cron(ctx, agent, `disable ${added.id}`)).toEqual({ kind: 'success', text: 'nightly is now disabled.' })
    expect(await cron(ctx, agent, `enable ${added.id}`)).toEqual({ kind: 'success', text: 'nightly is now enabled.' })
    expect(await cron(ctx, agent, `remove ${added.id}`)).toEqual({ kind: 'success', text: `Removed ${added.id}.` })
    expect(ctx.cronSessions.list()).toEqual([])
  })

  it('reports usage for enable, disable, run, and remove without an id', async () => {
    const ctx = await setup(new MockAdapter([]), { tickMs: 3_600_000 })
    const agent = await owner(ctx, root)

    for (const verb of ['enable', 'disable', 'run', 'remove']) {
      expect(await cron(ctx, agent, verb)).toEqual({ kind: 'error', text: USAGE })
    }
  })

  it('reports an unknown schedule id', async () => {
    const ctx = await setup(new MockAdapter([]), { tickMs: 3_600_000 })
    const agent = await owner(ctx, root)

    expect(await cron(ctx, agent, 'enable nope')).toEqual({ kind: 'error', text: 'no schedule "nope"' })
  })

  it('starts no session for a run requested as its schedule is removed', async () => {
    const adapter = new MockAdapter([])
    const ctx = await setup(adapter, { tickMs: 3_600_000 })
    const agent = await owner(ctx, root)
    const added = await ctx.cronSessions.add({ name: 'weekly', cron: '0 0 * * 1', cwd: root!, prompt: 'report' })
    const seen = changes(ctx)

    const removed = cron(ctx, agent, `remove ${added.id}`)
    expect(await cron(ctx, agent, `run ${added.id}`)).toMatchObject({ kind: 'success' })
    await removed
    await until(() => !ctx.cronSessions.isRunning(added.id))

    expect(seen.map(change => change.kind)).toEqual(['removed'])
    expect(adapter.requests).toHaveLength(0)
  })

  it('lists each schedule with its state, last outcome, and last run', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 8, 20, 10, 0, 0))
    const adapter = new HeldAdapter([textResponse('worked')])
    const ctx = await setup(adapter, { tickMs: 3_600_000 })
    const agent = await owner(ctx, root)
    const idle = await ctx.cronSessions.add({ name: 'idle', cron: '0 2 * * *', cwd: root!, prompt: 'rest' })
    await ctx.cronSessions.setEnabled(idle.id, false)
    vi.setSystemTime(new Date(2026, 8, 20, 10, 0, 1))
    const busy = await ctx.cronSessions.add({ name: 'busy', cron: '0 0 * * 1', cwd: root!, prompt: 'work' })
    const release = adapter.hold()
    const run = ctx.cronSessions.runNow(busy.id)
    await until(() => adapter.arrived === 1)

    expect(await cron(ctx, agent, 'list')).toEqual({
      kind: 'success',
      text: [
        `${idle.id} idle "0 2 * * *" disabled never ran ${root}`,
        `${busy.id} busy "0 0 * * 1" enabled running ${new Date(2026, 8, 20, 10, 0, 1).toISOString()} ${root}`,
      ].join('\n'),
    })
    release()
    await run
  })
})
