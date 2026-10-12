import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as WorkflowJournal from '@deepseek-ai/dsh-workflow-journal'
import { WorkflowRunId } from '@deepseek-ai/dsh-workflow'
import type { WorkflowResult, WorkflowRunId as RunId } from '@deepseek-ai/dsh-workflow'
import PtcWorkflowEngine from '../src/index.ts'
import { ScriptedRuntime, scriptedProvider } from './scripted-runtime.ts'
import type { ScriptedCall } from './scripted-runtime.ts'
import { fakeParent } from './setup.ts'

const META = { name: 'review', description: 'review changed files' }

const contexts: Context[] = []
let root: string | undefined

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(context => context.fiber.dispose()))
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function harness(options: { journal?: boolean } = {}) {
  root ??= await mkdtemp(join(tmpdir(), 'dsh-workflow-replay-'))
  const ctx = new Context()
  contexts.push(ctx)
  const starts: string[] = []
  const answers = new Map<string, string>()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjections)
  await ctx.plugin(SandboxPolicy, { mode: 'read-only' })
  await ctx.plugin(SubagentRuntime)
  ctx.subagents.registerProvider(scriptedProvider({ starts, answers }) as never)
  await ctx.plugin(ScriptedRuntime)
  if (options.journal !== false) {
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(Storage)
    await ctx.plugin(StorageJson, { root: join(root, 'storages') })
    await ctx.plugin(StorageDomain, { backend: 'json' })
    await ctx.plugin(WorkflowJournal, { retainRuns: 50, listLimit: 10 })
  }
  await ctx.plugin(PtcWorkflowEngine, { provider: 'stub' })
  const runtime = ctx.ptcRuntime as ScriptedRuntime
  const parent = fakeParent(ctx)

  async function run(script: string, calls: ScriptedCall[], resumeRunId?: RunId): Promise<{ id: RunId; result: WorkflowResult }> {
    runtime.calls = calls
    const live = ctx.workflowEngine.start({
      script, meta: META, parent,
      ...resumeRunId === undefined ? {} : { resumeRunId },
    })
    const result = await live.result
    await live.dispose()
    return { id: live.id, result }
  }

  return { ctx, runtime, parent, run, starts, answers }
}

describe('workflow journal recording', () => {
  it('records every settled call and closes the run before its result resolves', async () => {
    const { ctx, run } = await harness()
    const { id, result } = await run('return null', [{ prompt: 'a' }, { prompt: 'b' }])
    expect(result.stopReason).toBe('completed')

    // No settling wait: closing the journal is part of the run's completion,
    // so a one-shot process that exits here still leaves a `done` record.
    const record = ctx.workflowJournal.get(id)
    expect(record?.state).toBe('done')
    expect(record?.calls.map(call => call.ordinal)).toEqual([1, 2])
    expect(record?.calls.every(call => call.outcome.ok)).toBe(true)
  })

  it('records a child that did not complete as not replayable', async () => {
    const { ctx, run, answers } = await harness()
    answers.set('b', 'error')
    const { id } = await run('return null', [{ prompt: 'a' }, { prompt: 'b' }])

    const calls = ctx.workflowJournal.get(id)?.calls ?? []
    expect(calls.map(call => call.outcome.ok)).toEqual([true, false])
    expect(calls[1]?.outcome.error).toContain('error')
    expect(ctx.workflowJournal.plan(id, ctx.workflowJournal.get(id)!.scriptHash)?.replayable).toBe(1)
  })

  it('assigns ordinals in call order when every call starts before any settles', async () => {
    const { ctx, runtime, run } = await harness()
    runtime.concurrent = true
    const { id } = await run('return null', [{ prompt: 'a' }, { prompt: 'b' }, { prompt: 'c' }])

    const calls = [...ctx.workflowJournal.get(id)?.calls ?? []].sort((left, right) => left.ordinal - right.ordinal)
    expect(calls.map(call => call.ordinal)).toEqual([1, 2, 3])
    // Ordinal 1 is the first call the script issued, not the first to settle.
    expect(calls[0]?.childId).toBe('child-1')
  })
})

describe('workflow journal labels and failures', () => {
  it('records the label and phase the script reported for a call', async () => {
    const { ctx, run } = await harness()
    const { id } = await run('return null', [{ prompt: 'a', label: 'Survey', phase: 'Research' }, { prompt: 'b' }])
    const calls = [...ctx.workflowJournal.get(id)?.calls ?? []].sort((left, right) => left.ordinal - right.ordinal)
    expect(calls.map(call => [call.label, call.phase])).toEqual([['Survey', 'Research'], [undefined, undefined]])
  })

  it('warns about a journal write that fails and still completes the run', async () => {
    const { ctx, run } = await harness()
    vi.spyOn(ctx.workflowJournal, 'record').mockRejectedValue(new Error('disk full'))
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => ctx.logger)
    const { result } = await run('return null', [{ prompt: 'a' }])
    expect(result.stopReason).toBe('completed')
    await vi.waitFor(() => { expect(warn).toHaveBeenCalledWith(expect.stringContaining('journal write failed: Error: disk full')) })
  })
})

describe('resuming a journaled run', () => {
  it('replays a matched call without starting a child and runs the rest for real', async () => {
    const { ctx, run, starts } = await harness()
    const first = await run('return null', [{ prompt: 'a' }, { prompt: 'b' }])
    expect(starts).toEqual(['a', 'b'])

    starts.length = 0
    const second = await run('return null', [{ prompt: 'a' }, { prompt: 'b' }, { prompt: 'c' }], first.id)
    expect(starts).toEqual(['c'])
    expect(second.result.stopReason).toBe('completed')

    const record = ctx.workflowJournal.get(second.id)
    expect(record?.resumedFrom).toBe(first.id)
    // The replayed calls name the children that produced the answers.
    expect(record?.calls.map(call => call.childId)).toEqual(['child-1', 'child-2', 'child-3'])
  })

  it('runs an edited call for real and leaves the unedited one replayed', async () => {
    const { run, starts } = await harness()
    const first = await run('return null', [{ prompt: 'a' }, { prompt: 'b' }])

    starts.length = 0
    await run('return null', [{ prompt: 'a' }, { prompt: 'b revised' }], first.id)
    expect(starts).toEqual(['b revised'])
  })

  it('runs a call again when only its model changed', async () => {
    const { run, starts } = await harness()
    const first = await run('return null', [{ prompt: 'a' }])

    starts.length = 0
    await run('return null', [{ prompt: 'a', model: 'other' }], first.id)
    expect(starts).toEqual(['a'])
  })

  it('runs a call that did not complete again instead of reproducing its failure', async () => {
    const { run, starts, answers } = await harness()
    answers.set('b', 'error')
    const first = await run('return null', [{ prompt: 'a' }, { prompt: 'b' }])

    answers.delete('b')
    starts.length = 0
    await run('return null', [{ prompt: 'a' }, { prompt: 'b' }], first.id)
    expect(starts).toEqual(['b'])
  })

  it('refuses to resume a run the journal never recorded', async () => {
    const { ctx, parent } = await harness()
    expect(() => ctx.workflowEngine.start({
      script: 'return null', meta: META, parent, resumeRunId: WorkflowRunId('never-ran'),
    })).toThrow(/no journaled workflow run/)
  })

  it('refuses to resume when no journal is mounted', async () => {
    const { ctx, parent } = await harness({ journal: false })
    expect(() => ctx.workflowEngine.start({
      script: 'return null', meta: META, parent, resumeRunId: WorkflowRunId('anything'),
    })).toThrow(/requires a mounted workflow journal/)
  })

  it('runs unjournaled when no journal is mounted and no resume is asked for', async () => {
    const { ctx, run, starts } = await harness({ journal: false })
    const { result } = await run('return null', [{ prompt: 'a' }])
    expect(result.stopReason).toBe('completed')
    expect(starts).toEqual(['a'])
    expect(ctx.get('workflowJournal')).toBeUndefined()
  })
})
