import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import CommandRuntime, { CommandId } from '@deepseek-ai/dsh-commands'
import GoalService from '@deepseek-ai/dsh-goal'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as BashEnvPlugin from '@deepseek-ai/dsh-shell-env'
import * as Research from '@deepseek-ai/dsh-research'
import * as ResearchTools from '@deepseek-ai/dsh-research/tools'
import { extractMetrics, metricDeltas, previousExperiment, renderExperimentResult, truncateOutput } from '@deepseek-ai/dsh-research'
import type { Journal } from '@deepseek-ai/dsh-research'

let root: string | undefined
let spill: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  if (spill !== undefined) await rm(spill, { recursive: true, force: true })
  root = undefined
  spill = undefined
})

const signal = new AbortController().signal

async function setup(overrides: Partial<Research.Config> = {}, withShell = true): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-research-experiment-'))
  spill = await mkdtemp(join(tmpdir(), 'dsh-research-spill-'))
  const ctx = new Context()
  context = ctx
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(GoalService)
  if (withShell) {
    await ctx.plugin(LocalSubprocessRuntime)
    ;(ctx.subprocess as LocalSubprocessRuntime).internals = { spillDir: spill }
    await ctx.plugin(BashEnvPlugin)
    await ctx.plugin(LocalBashExecutor, { timeoutMs: 10_000, graceMs: 200 })
  }
  await ctx.plugin(Research, {
    dir: '.dsh/research',
    maxRecallBytes: 8000,
    recentExperiments: 3,
    scoring: { enabled: false, maxOutputTokens: 256, timeoutMs: 5000 },
    maxExperimentMs: 60_000,
    maxOutputBytes: 400,
    ...overrides,
  })
  await ctx.plugin(ResearchTools)
  return ctx
}

async function fakeAgent(ctx: Context, cwd: string, id = 'experiment-agent'): Promise<Agent> {
  const scope = ctx.plugin(() => {})
  const session = ctx.sessions.create(SessionId(id), { meta: { cwd } })
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

async function research(ctx: Context, agent: Agent, rawInput: string) {
  return ctx.commands.find(agent, 'research')!.handler({ commandId: CommandId('c'), agent, rawInput, attachments: [], signal })
}

function journalFixture(overrides: Partial<Journal> = {}): Journal {
  return {
    slug: 'demo', objective: 'Find the optimum', criteria: [], status: 'active',
    createdAt: '2026-09-20T10:00:00.000Z', updatedAt: '2026-09-20T10:00:00.000Z', sessions: [],
    breakthroughs: [], hypotheses: [], experiments: [], deadEnds: [], nextSteps: [],
    ...overrides,
  }
}

describe('experiment helpers', () => {
  it('extracts named numeric metrics from output through capture groups or the whole match', () => {
    expect(extractMetrics('loss=0.25 acc: 91.5%\nsteps 40', [
      { name: 'loss', regex: 'loss=([0-9.]+)' },
      { name: 'acc', regex: 'acc: ([0-9.]+)' },
      { name: 'steps', regex: '[0-9]+$' },
      { name: 'missing', regex: 'nope=([0-9]+)' },
    ])).toEqual({ loss: 0.25, acc: 91.5, steps: 40 })
  })

  it('computes deltas only for metrics both runs share', () => {
    expect(metricDeltas({ loss: 0.5, acc: 90 }, { loss: 0.25, steps: 3 })).toEqual({ loss: -0.25 })
    expect(metricDeltas(undefined, { loss: 0.25 })).toEqual({})
  })

  it('truncates output to the byte cap and says so', () => {
    expect(truncateOutput('abcdef', 100)).toEqual({ text: 'abcdef', truncated: false })
    const cut = truncateOutput('x'.repeat(50), 10)
    expect(cut.truncated).toBe(true)
    expect(Buffer.byteLength(cut.text)).toBeLessThanOrEqual(10)
  })

  it('finds the previous experiment with the same title', () => {
    const journal = journalFixture({
      experiments: [
        { id: 'e-1', at: 't', source: 'model', what: 'a', result: 'r', title: 'baseline', metrics: { loss: 1 } },
        { id: 'e-2', at: 't', source: 'model', what: 'b', result: 'r', title: 'baseline', metrics: { loss: 0.5 } },
        { id: 'e-3', at: 't', source: 'model', what: 'c', result: 'r', title: 'other' },
      ],
    })
    expect(previousExperiment(journal, 'baseline')?.id).toBe('e-2')
    expect(previousExperiment(journal, 'unknown')).toBeUndefined()
  })

  it('renders the result line with exit, metrics, deltas, and an output excerpt', () => {
    const text = renderExperimentResult({ exitCode: 0, timedOut: false, metrics: { loss: 0.25 }, deltas: { loss: -0.25 }, output: 'done' })
    expect(text).toContain('exit 0')
    expect(text).toContain('loss=0.25 (Δ -0.25)')
    expect(text).toContain('done')
    expect(renderExperimentResult({ exitCode: null, timedOut: true, metrics: {}, deltas: {}, output: '' })).toContain('timed out')
  })
})

describe('run_experiment tool', () => {
  it('runs the command in the workspace, records the experiment with metrics, and adds deltas on a repeat', async () => {
    const ctx = await setup()
    const agent = await fakeAgent(ctx, root!)
    await research(ctx, agent, 'Find the optimum --slug opt')
    const run = (args: Record<string, unknown>) =>
      ctx.tools.execute({ signal, callId: ToolCallId('c1'), name: 'run_experiment', agent, arguments: args })
    const first = await run({
      title: 'baseline',
      command: 'node -e "console.log(\'loss=0.5 cwd=\' + process.cwd())"',
      metrics: [{ name: 'loss', regex: 'loss=([0-9.]+)' }],
    })
    expect(first.isError).toBe(false)
    const value = first.value as {
      id: string
      exitCode: number
      metrics: Record<string, number>
      deltas: Record<string, number>
      output: string
    }
    expect(value.exitCode).toBe(0)
    expect(value.metrics).toEqual({ loss: 0.5 })
    expect(value.deltas).toEqual({})
    expect(value.output).toContain(`cwd=${root!}`)
    const second = await run({
      title: 'baseline',
      command: 'node -e "console.log(\'loss=0.25\')"',
      metrics: [{ name: 'loss', regex: 'loss=([0-9.]+)' }],
    })
    expect((second.value as { deltas: Record<string, number> }).deltas).toEqual({ loss: -0.25 })
    const journal = ctx.research.storeFor(root!).get('opt')!
    expect(journal.experiments).toHaveLength(2)
    expect(journal.experiments[1]).toMatchObject({ title: 'baseline', metrics: { loss: 0.25 }, source: 'model' })
    expect(journal.experiments[1]!.result).toContain('Δ -0.25')
    const file = await readFile(join(root!, '.dsh', 'research', 'opt', 'journal.md'), 'utf8')
    expect(file).toContain('title: baseline')
    expect(file).toContain('loss=0.25')
  })

  it('reports a timed-out run and caps the timeout at maxExperimentMs', async () => {
    const ctx = await setup({ maxExperimentMs: 500 })
    const agent = await fakeAgent(ctx, root!)
    await research(ctx, agent, 'Find the optimum --slug opt')
    const result = await ctx.tools.execute({
      signal, callId: ToolCallId('c1'), name: 'run_experiment', agent,
      arguments: { title: 'slow', command: 'node -e "setTimeout(() => {}, 20000)"', timeoutMs: 60_000 },
    })
    expect(result.isError).toBe(false)
    expect((result.value as { timedOut: boolean }).timedOut).toBe(true)
    expect(ctx.research.storeFor(root!).get('opt')!.experiments[0]!.result).toContain('timed out')
  })

  it('links the experiment to a hypothesis and rejects unknown ids', async () => {
    const ctx = await setup()
    const agent = await fakeAgent(ctx, root!)
    await research(ctx, agent, 'Find the optimum --slug opt')
    const hypothesis = await ctx.tools.execute({ signal, callId: ToolCallId('h'), name: 'journal', agent, arguments: { action: 'hypothesis', text: 'Depth matters' } })
    const id = (hypothesis.value as { id: string }).id
    const ok = await ctx.tools.execute({ signal, callId: ToolCallId('c1'), name: 'run_experiment', agent, arguments: { title: 't', command: 'true', hypothesisId: id } })
    expect(ok.isError).toBe(false)
    expect(ctx.research.storeFor(root!).get('opt')!.experiments[0]).toMatchObject({ hypothesisId: id })
    const bad = await ctx.tools.execute({ signal, callId: ToolCallId('c2'), name: 'run_experiment', agent, arguments: { title: 't', command: 'true', hypothesisId: 'h-nope' } })
    expect(bad.isError).toBe(true)
  })

  it('fails clearly without an active research goal or without a shell executor', async () => {
    const ctx = await setup()
    const agent = await fakeAgent(ctx, root!)
    const noGoal = await ctx.tools.execute({ signal, callId: ToolCallId('c1'), name: 'run_experiment', agent, arguments: { title: 't', command: 'true' } })
    expect(noGoal.isError).toBe(true)
    expect(noGoal.content.map(block => block.type === 'text' ? block.text : '').join('')).toContain('/research')
    await context?.fiber.dispose()
    const bare = await setup({}, false)
    const agent2 = await fakeAgent(bare, root!)
    await research(bare, agent2, 'Find the optimum --slug opt')
    const noShell = await bare.tools.execute({ signal, callId: ToolCallId('c1'), name: 'run_experiment', agent: agent2, arguments: { title: 't', command: 'true' } })
    expect(noShell.isError).toBe(true)
    expect(noShell.content.map(block => block.type === 'text' ? block.text : '').join('')).toContain('shell')
  })
})
