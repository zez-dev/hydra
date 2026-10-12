import { chmod, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import CommandRuntime, { CommandId } from '@deepseek-ai/dsh-commands'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import { WorkflowRunId } from '@deepseek-ai/dsh-workflow'
import type { WorkflowMeta } from '@deepseek-ai/dsh-workflow'
import * as journal from '@deepseek-ai/dsh-workflow-journal'
import type { JournalCall } from '@deepseek-ai/dsh-workflow'

const contexts: Context[] = []
let root: string | undefined

const META: WorkflowMeta = { name: 'review', description: 'review changed files' }
const SESSION = brandString<SessionId>('session-a')

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(context => context.fiber.dispose()))
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/**
 * Yield the real event loop as well as microtasks: the domain writes through
 * real filesystem I/O, so a wait that only flushes microtasks passes on an
 * idle machine and fails under load.
 */
async function settle(): Promise<void> {
  await new Promise((resolve) => { setImmediate(resolve) })
}

/** Everything the journal needs, without the journal itself. */
async function baseContext(): Promise<Context> {
  root ??= await mkdtemp(join(tmpdir(), 'dsh-workflow-journal-'))
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: join(root, 'storages') })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  return ctx
}

async function harness(config: Partial<journal.Config> = {}): Promise<Context> {
  const ctx = await baseContext()
  await ctx.plugin(journal, { retainRuns: 200, listLimit: 20, ...config })
  return ctx
}

function call(ordinal: number, keyHash: string, ok = true): JournalCall {
  return {
    ordinal,
    kind: 'agent',
    keyHash,
    childId: `child-${String(ordinal)}`,
    label: `call ${String(ordinal)}`,
    settledAt: new Date().toISOString(),
    outcome: ok ? { ok: true, value: { text: `result ${String(ordinal)}` } } : { ok: false, error: 'boom' },
  }
}

async function fakeAgent(ctx: Context, id = 'session-a'): Promise<Agent> {
  const scope = ctx.plugin(() => {})
  const session = ctx.sessions.create(SessionId(id), { meta: {} })
  const agent = { id: SessionId(id), session, ctx: scope.ctx } as unknown as Agent
  ctx.agents.register(agent)
  return agent
}

/** Run `/workflows` with the given argument text as the agent. */
function workflowsCommand(ctx: Context, agent: Agent) {
  const command = ctx.commands.find(agent, 'workflows')!
  return async (rawInput: string) => await command.handler({
    commandId: CommandId('c1'),
    agent,
    rawInput,
    attachments: [],
    signal: new AbortController().signal,
  }) as { kind: string; text?: string }
}

describe('the journal', () => {
  it('can be unloaded and mounted again, keeping a call recorded just before the unload', async () => {
    const ctx = await baseContext()
    const first = await ctx.plugin(journal, { retainRuns: 200, listLimit: 20 })
    const settled = WorkflowRunId('run-settled')
    await ctx.workflowJournal.open({ id: settled, sessionId: SESSION, scriptHash: 'abc', meta: META })
    await ctx.workflowJournal.close(settled, { value: null, stopReason: 'completed', agentsStarted: 0 })
    const id = WorkflowRunId('run-remount')
    await ctx.workflowJournal.open({ id, sessionId: SESSION, scriptHash: 'abc', meta: META })
    // Not awaited: unloading must let a queued write land before it closes the domain.
    void ctx.workflowJournal.record(id, call(1, 'k1'))
    await first.dispose()
    await ctx.plugin(journal, { retainRuns: 200, listLimit: 20 })
    expect(ctx.workflowJournal.get(id)?.calls.map(recorded => recorded.ordinal)).toEqual([1])
    // Only a run still marked running is reconciled; a settled one keeps its state.
    expect(ctx.workflowJournal.get(settled)?.state).toBe('done')
    expect(ctx.workflowJournal.get(id)?.state).toBe('interrupted')
  })

  it('keeps writing a run after one of its writes fails', async () => {
    const ctx = await harness()
    const id = WorkflowRunId('run-unwritable')
    await ctx.workflowJournal.open({ id, sessionId: SESSION, scriptHash: 'abc', meta: META })
    const storages = join(root!, 'storages')
    const lock = async (mode: number): Promise<void> => {
      for (const entry of await readdir(storages, { recursive: true, withFileTypes: true })) {
        if (entry.isDirectory()) await chmod(join(entry.parentPath, entry.name), mode)
      }
      await chmod(storages, mode)
    }
    await lock(0o500)
    try {
      await expect(ctx.workflowJournal.record(id, call(1, 'k1'))).rejects.toThrow()
    } finally {
      await lock(0o700)
    }
    await ctx.workflowJournal.record(id, call(2, 'k2'))
    expect(ctx.workflowJournal.get(id)?.calls.map(recorded => recorded.ordinal)).toEqual([2])
  })

  it('uses its default retention and list limit when mounted without them', async () => {
    const ctx = await baseContext()
    await ctx.plugin(journal, {})
    const id = WorkflowRunId('run-defaults')
    await ctx.workflowJournal.open({ id, sessionId: SESSION, scriptHash: 'abc', meta: META })
    await ctx.workflowJournal.close(id, { value: null, stopReason: 'completed', agentsStarted: 0 })
    expect(ctx.workflowJournal.list().map(record => record.id)).toEqual([id])
  })

  it('records a run, its settled calls, and its terminal result', async () => {
    const ctx = await harness()
    const id = WorkflowRunId('run-1')
    await ctx.workflowJournal.open({ id, sessionId: SESSION, scriptHash: 'abc', meta: META })
    await ctx.workflowJournal.record(id, call(1, 'k1'))
    await ctx.workflowJournal.record(id, call(2, 'k2'))
    await ctx.workflowJournal.close(id, { value: 'done', stopReason: 'completed', agentsStarted: 2 })
    await settle()

    const record = ctx.workflowJournal.get(id)
    expect(record).toMatchObject({ id, sessionId: SESSION, scriptHash: 'abc', state: 'done' })
    expect(record?.calls.map(entry => entry.ordinal)).toEqual([1, 2])
    expect(record?.result).toMatchObject({ stopReason: 'completed' })
  })

  it('marks a failed run failed, not done', async () => {
    const ctx = await harness()
    const id = WorkflowRunId('run-fail')
    await ctx.workflowJournal.open({ id, sessionId: SESSION, scriptHash: 'abc', meta: META })
    await ctx.workflowJournal.close(id, { value: null, stopReason: 'error', error: 'nope', agentsStarted: 0 })
    expect(ctx.workflowJournal.get(id)?.state).toBe('failed')
  })

  it('reconciles a run whose process died to interrupted at the next activation', async () => {
    const first = await harness()
    const id = WorkflowRunId('run-crash')
    await first.workflowJournal.open({ id, sessionId: SESSION, scriptHash: 'abc', meta: META })
    await first.workflowJournal.record(id, call(1, 'k1'))
    await settle()
    expect(first.workflowJournal.get(id)?.state).toBe('running')
    await first.fiber.dispose()
    contexts.splice(contexts.indexOf(first), 1)

    // A second activation over the same storage root is what a restart looks like.
    const second = await harness()
    const record = second.workflowJournal.get(id)
    expect(record).toMatchObject({ state: 'interrupted' })
    expect(record?.finishedAt).toBeDefined()
    expect(record?.calls).toHaveLength(1)
  })

  it('plans a resume: what replays, and whether the script changed', async () => {
    const ctx = await harness()
    const id = WorkflowRunId('run-plan')
    await ctx.workflowJournal.open({ id, sessionId: SESSION, scriptHash: 'script-v1', meta: META })
    await ctx.workflowJournal.record(id, call(1, 'k1'))
    await ctx.workflowJournal.record(id, call(2, 'k2', false))
    await settle()

    expect(ctx.workflowJournal.plan(id, 'script-v1')).toMatchObject({ replayable: 1, scriptChanged: false })
    expect(ctx.workflowJournal.plan(id, 'script-v2')).toMatchObject({ replayable: 1, scriptChanged: true })
    expect(ctx.workflowJournal.plan(WorkflowRunId('never'), 'script-v1')).toBeUndefined()
  })

  it('lists runs newest first and prunes settled runs past the retention', async () => {
    const ctx = await harness({ retainRuns: 2 })
    for (const index of [1, 2, 3]) {
      const id = WorkflowRunId(`run-${String(index)}`)
      await ctx.workflowJournal.open({ id, sessionId: SESSION, scriptHash: 'abc', meta: META })
      await ctx.workflowJournal.close(id, { value: null, stopReason: 'completed', agentsStarted: 0 })
      // Distinct start times so the ordering assertion is not clock-resolution bound.
      await new Promise((resolve) => { setTimeout(resolve, 2) })
    }
    await settle()
    const listed = ctx.workflowJournal.list()
    expect(listed).toHaveLength(2)
    expect(listed[0]?.id).toBe(WorkflowRunId('run-3'))
  })

  it('drops a call for a run it never opened rather than inventing one', async () => {
    const ctx = await harness()
    await ctx.workflowJournal.record(WorkflowRunId('ghost'), call(1, 'k1'))
    await ctx.workflowJournal.close(WorkflowRunId('ghost'), { value: null, stopReason: 'completed', agentsStarted: 0 })
    expect(ctx.workflowJournal.get(WorkflowRunId('ghost'))).toBeUndefined()
  })

  it('/workflows lists runs and details one', async () => {
    const ctx = await harness()
    const agent = await fakeAgent(ctx)
    const id = WorkflowRunId('run-cmd')
    await ctx.workflowJournal.open({ id, sessionId: SESSION, scriptHash: 'abc', meta: META })
    await ctx.workflowJournal.record(id, call(1, 'k1'))
    await settle()

    const invoke = workflowsCommand(ctx, agent)

    const listed = await invoke('')
    expect(listed.kind).toBe('success')
    expect(listed.text).toContain('review')

    const detailed = await invoke('run-cmd')
    expect(detailed.text).toContain('#1')
    expect(detailed.text).toContain('k1')

    const missing = await invoke('nope')
    expect(missing.kind).toBe('error')
  })

  it('/workflows says when nothing is journaled, and details a resumed run\'s failures, phases, and unlabelled calls', async () => {
    const ctx = await harness()
    const agent = await fakeAgent(ctx)
    const invoke = workflowsCommand(ctx, agent)
    expect(await invoke('')).toEqual({ kind: 'success', text: 'no workflow runs journaled yet' })

    const earlier = WorkflowRunId('run-earlier')
    await ctx.workflowJournal.open({ id: earlier, sessionId: SESSION, scriptHash: 'abc', meta: META })
    const id = WorkflowRunId('run-resumed')
    await ctx.workflowJournal.open({ id, sessionId: SESSION, scriptHash: 'abc', meta: META, resumedFrom: earlier })
    await ctx.workflowJournal.record(id, { ...call(1, 'k1'), phase: 'survey' })
    const { label: _label, ...unlabelled } = call(2, 'k2', false)
    await ctx.workflowJournal.record(id, unlabelled)
    await settle()

    const detailed = (await invoke('run-resumed')).text ?? ''
    expect(detailed).toContain('1 not replayable')
    expect(detailed).toContain('1 phase(s)')
    expect(detailed).toContain('resumed from run-earlier')
    expect(detailed).toContain('#2 runs again k2  (unlabelled)')
  })
})
