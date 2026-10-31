import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, ToolCallId, type UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import AgentRegistry, { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox, unsupportedModel } from '@deepseek-ai/dsh-agent-loop-testkit'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import CommandRuntime, { CommandId } from '@deepseek-ai/dsh-commands'
import GoalService from '@deepseek-ai/dsh-goal'
import * as Research from '@deepseek-ai/dsh-research'
import * as ResearchTools from '@deepseek-ai/dsh-research/tools'
import { parseResearchInput, renderJournalRecall, renderResearchInstruction, RESEARCH_PREFIX, researchSlugOf } from '@deepseek-ai/dsh-research'
import type { Journal } from '@deepseek-ai/dsh-research'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

const signal = new AbortController().signal

async function setup(overrides: Partial<Research.Config> = {}): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-research-plugin-'))
  const ctx = new Context()
  context = ctx
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(GoalService)
  await ctx.plugin(Research, {
    dir: '.dsh/research', maxRecallBytes: 8000, recentExperiments: 3,
    scoring: { enabled: false, maxOutputTokens: 256, timeoutMs: 5000 }, maxExperimentMs: 60_000, maxOutputBytes: 400,
    ...overrides,
  })
  await ctx.plugin(ResearchTools)
  return ctx
}

async function fakeAgent(ctx: Context, cwd: string, id = 'research-agent'): Promise<Agent> {
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

async function preStep(ctx: Context, agent: Agent, messages: UserMessage[]): Promise<PreStepDecision> {
  return agentEvents(ctx, agent).waterfall(
    'agent/pre-step',
    { modelSelection: { provider: 'mock', model: 'mock' }, messages, prompt: { systemPrompt: '', tools: [] }, turn: 1, step: 1, signal },
    () => Promise.resolve({ kind: 'enter' as const, messages }),
  )
}

function text(decision: PreStepDecision): string {
  if (decision.kind !== 'enter') return ''
  return decision.messages.map(message => message.content.map(block => block.type === 'text' ? block.text : '').join('')).join('\n')
}

async function research(ctx: Context, agent: Agent, rawInput: string) {
  return ctx.commands.find(agent, 'research')!.handler({ commandId: CommandId('c'), agent, rawInput, attachments: [], signal })
}

function journalFixture(overrides: Partial<Journal> = {}): Journal {
  return {
    slug: 'demo', objective: 'Find the optimum', criteria: ['error below 1%'], status: 'active',
    createdAt: '2026-09-20T10:00:00.000Z', updatedAt: '2026-09-20T10:00:00.000Z', sessions: [],
    breakthroughs: [], hypotheses: [], experiments: [], deadEnds: [], nextSteps: [],
    ...overrides,
  }
}

describe('/research input', () => {
  it('parses the objective, criteria, and slug', () => {
    expect(parseResearchInput('Find the optimum --criteria "error below 1%; reproducible twice" --slug opt')).toEqual({
      kind: 'start', objective: 'Find the optimum', criteria: ['error below 1%', 'reproducible twice'], slug: 'opt',
    })
    expect(parseResearchInput('status')).toEqual({ kind: 'status' })
    expect(parseResearchInput('pause')).toEqual({ kind: 'pause' })
    expect(parseResearchInput('resume')).toEqual({ kind: 'resume' })
    expect(parseResearchInput('')).toEqual({ kind: 'usage' })
  })

  it('parses list, continue with or without a name, resume with a name, and a slug given before any objective word', () => {
    expect(parseResearchInput('list')).toEqual({ kind: 'list' })
    expect(parseResearchInput('continue')).toEqual({ kind: 'continue' })
    expect(parseResearchInput('continue opt')).toEqual({ kind: 'continue', slug: 'opt' })
    expect(parseResearchInput('resume opt')).toEqual({ kind: 'continue', slug: 'opt' })
    expect(parseResearchInput('--slug opt')).toEqual({ kind: 'continue', slug: 'opt' })
    expect(parseResearchInput('--criteria "x" --slug opt')).toEqual({ kind: 'continue', slug: 'opt' })
    expect(parseResearchInput('--criteria "x"')).toEqual({ kind: 'usage' })
  })

  it('derives the slug from a research goal objective', () => {
    expect(researchSlugOf(`${RESEARCH_PREFIX}demo] Find the optimum`)).toBe('demo')
    expect(researchSlugOf('[qa] something')).toBeUndefined()
  })
})

describe('rendering', () => {
  it('renders the recall block with breakthroughs, open hypotheses, recent experiments, and next steps under a byte cap', () => {
    const journal = journalFixture({
      breakthroughs: [{ id: 'b-1', at: '2026-09-20T10:30:00.000Z', source: 'model', text: 'Scaling law holds' }],
      hypotheses: [
        { id: 'h-1', at: 'x', source: 'model', text: 'Depth matters', status: 'open' },
        { id: 'h-2', at: 'x', source: 'model', text: 'Width matters', status: 'refuted' },
      ],
      experiments: Array.from({ length: 5 }, (_, index) => ({ id: `e-${index}`, at: 'x', source: 'model' as const, what: `run ${index}`, result: 'ok' })),
      nextSteps: ['Try 5 layers'],
    })
    const block = renderJournalRecall(journal, { maxRecallBytes: 8000, recentExperiments: 2 })
    expect(block.startsWith('<research_journal>')).toBe(true)
    expect(block).toContain('Scaling law holds')
    expect(block).toContain('Depth matters')
    expect(block).not.toContain('Width matters')
    expect(block).toContain('run 4')
    expect(block).not.toContain('run 0')
    expect(block).toContain('Try 5 layers')
    const capped = renderJournalRecall(journal, { maxRecallBytes: 120, recentExperiments: 2 })
    expect(Buffer.byteLength(capped)).toBeLessThanOrEqual(120)
    expect(capped.endsWith('</research_journal>')).toBe(true)
  })

  it('keeps next steps, dead ends, hypotheses, and experiments when breakthroughs outgrow the cap, then the newest breakthroughs', () => {
    const journal = journalFixture({
      breakthroughs: Array.from({ length: 30 }, (_, index) => ({ id: `b-${index}`, at: 'x', source: 'model' as const, text: `finding ${index} ${'detail '.repeat(30)}` })),
      hypotheses: [{ id: 'h-1', at: 'x', source: 'model', text: 'Depth matters', status: 'open' }],
      experiments: [{ id: 'e-1', at: 'x', source: 'model', what: 'run 1', result: 'ok' }],
      deadEnds: [{ id: 'd-1', at: 'x', source: 'model', text: 'Dropout above 0.5 diverges' }],
      nextSteps: ['Try 5 layers'],
    })
    const block = renderJournalRecall(journal, { maxRecallBytes: 3000, recentExperiments: 2 })
    expect(Buffer.byteLength(block)).toBeLessThanOrEqual(3000)
    for (const kept of ['Try 5 layers', 'Dropout above 0.5 diverges', 'Depth matters', 'run 1 => ok', 'error below 1%', '[b-29]', '[b-28]']) expect(block).toContain(kept)
    expect(block).not.toContain('[b-0]')
    expect(block).toMatch(/Breakthroughs:\n- \(\d+ older in the journal file\)\n- \[b-\d+\]/u)
    expect(block.indexOf('[b-28]')).toBeLessThan(block.indexOf('[b-29]'))
    expect(block.indexOf('Breakthroughs:')).toBeLessThan(block.indexOf('Next steps:'))
  })

  it('renders a self-contained research round instruction', () => {
    const instruction = renderResearchInstruction(journalFixture({ nextSteps: ['Try 5 layers'] }))
    expect(instruction).toContain('Role: researcher')
    expect(instruction).toContain('journal')
    expect(instruction).toContain('Try 5 layers')
    expect(instruction).toContain('breakthrough')
  })
})

describe('/research command and goal', () => {
  it('creates the journal and a research goal, and status reports both', async () => {
    const ctx = await setup()
    const agent = await fakeAgent(ctx, root!)
    const result = await research(ctx, agent, 'Find the optimum --criteria "error below 1%"')
    expect(result.kind).toBe('success')
    expect(ctx.goals.get(agent)).toMatchObject({ phase: 'active', objective: `${RESEARCH_PREFIX}find-the-optimum] Find the optimum` })
    const store = ctx.research.storeFor(root!)
    expect(store.get('find-the-optimum')).toMatchObject({ objective: 'Find the optimum', criteria: ['error below 1%'], sessions: [agent.id] })
    expect(ctx.research.activeFor(agent.id)).toMatchObject({ slug: 'find-the-optimum', cwd: root })
    const status = await research(ctx, agent, 'status')
    expect(status.kind === 'success' ? status.text : '').toContain('find-the-optimum')
  })

  it('resumes an existing journal for the same slug from a new session and re-arms the goal', async () => {
    const ctx = await setup()
    const first = await fakeAgent(ctx, root!, 'first')
    await research(ctx, first, 'Find the optimum --slug opt')
    await ctx.research.storeFor(root!).addBreakthrough('opt', 'Scaling law holds', 'model')
    const second = await fakeAgent(ctx, root!, 'second')
    const result = await research(ctx, second, 'anything --slug opt')
    expect(result.kind).toBe('success')
    expect(result.kind === 'success' ? result.text : '').toContain('Resumed')
    expect(ctx.research.storeFor(root!).get('opt')?.sessions).toEqual(['first', 'second'])
    expect(ctx.goals.get(second)).toMatchObject({ phase: 'active' })
    const paused = await research(ctx, second, 'pause')
    expect(paused.kind).toBe('success')
    expect(ctx.goals.get(second)?.phase).toBe('paused')
    const resumed = await research(ctx, second, 'resume')
    expect(resumed.kind).toBe('success')
    expect(ctx.goals.get(second)?.phase).toBe('active')
  })

  it('lists this workspace\'s journals newest first and continues one by name from a new session', async () => {
    const ctx = await setup()
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date('2026-10-01T10:00:00.000Z'))
      await research(ctx, await fakeAgent(ctx, root!, 'first'), 'Find the optimum --slug opt')
      vi.setSystemTime(new Date('2026-10-01T11:00:00.000Z'))
      await research(ctx, await fakeAgent(ctx, root!, 'other'), 'Measure the cache --slug cache')
      vi.setSystemTime(new Date('2026-10-01T12:00:00.000Z'))
      await ctx.research.storeFor(root!).addBreakthrough('opt', 'Scaling law holds', 'model')
      // A journal written in the same moment as another lists after it by name.
      await research(ctx, await fakeAgent(ctx, root!, 'third'), 'Tune the batch --slug batch')
      await ctx.research.storeFor(root!).addHypothesis('batch', 'Larger batches converge faster', 'model')
    } finally {
      vi.useRealTimers()
    }
    const second = await fakeAgent(ctx, root!, 'second')
    const status = await research(ctx, second, 'status')
    expect(status.kind === 'success' ? status.text : '').toContain('/research continue <name>')
    const listed = await research(ctx, second, 'list')
    const lines = (listed.kind === 'success' ? listed.text ?? '' : '').split('\n')
    expect(lines[0]).toBe(`Research journals in ${root!}/.dsh/research, newest first:`)
    expect(lines.slice(1, 4)).toEqual([
      '  batch [active] Tune the batch: 0 breakthrough(s), 1 open hypothesis(es), 0 experiment(s); updated 2026-10-01T12:00:00.000Z',
      '  opt [active] Find the optimum: 1 breakthrough(s), 0 open hypothesis(es), 0 experiment(s); updated 2026-10-01T12:00:00.000Z',
      '  cache [active] Measure the cache: 0 breakthrough(s), 0 open hypothesis(es), 0 experiment(s); updated 2026-10-01T11:00:00.000Z',
    ])
    expect(lines[4]).toBe('/research continue <name> picks one up in this session.')
    const continued = await research(ctx, second, 'continue opt')
    expect(continued.kind === 'success' ? continued.text : '').toMatch(/^Resumed research "opt" \(1 breakthrough\(s\)/u)
    expect(ctx.research.storeFor(root!).get('opt')?.sessions).toEqual(['first', 'second'])
    expect(ctx.goals.get(second)).toMatchObject({ phase: 'active', objective: `${RESEARCH_PREFIX}opt] Find the optimum` })
  })

  it('continues the only journal when no name is given, asks for a name among several, and refuses an unknown one', async () => {
    const ctx = await setup()
    const none = await research(ctx, await fakeAgent(ctx, root!, 'empty'), 'list')
    expect(none).toEqual({ kind: 'success', text: `No research journals in ${root!}/.dsh/research yet. /research <objective> starts one.` })
    await research(ctx, await fakeAgent(ctx, root!, 'first'), 'Find the optimum --slug opt')
    const only = await research(ctx, await fakeAgent(ctx, root!, 'second'), 'continue')
    expect(only.kind === 'success' ? only.text : '').toMatch(/^Resumed research "opt"/u)
    await research(ctx, await fakeAgent(ctx, root!, 'third'), 'Measure the cache --slug cache')
    const several = await research(ctx, await fakeAgent(ctx, root!, 'fourth'), 'continue')
    expect(several.kind === 'success' ? several.text : '').toMatch(/^Research journals in .*\n {2}cache .*\n {2}opt /u)
    const unknown = await research(ctx, await fakeAgent(ctx, root!, 'fifth'), 'continue nope')
    expect(unknown).toEqual({ kind: 'error', text: `No research journal "nope" in ${root!}/.dsh/research. Journals here: cache, opt.` })
    const bySlug = await research(ctx, await fakeAgent(ctx, root!, 'sixth'), '--slug opt')
    expect(bySlug.kind === 'success' ? bySlug.text : '').toMatch(/^Resumed research "opt"/u)
    expect(ctx.research.storeFor(root!).get('slug-opt')).toBeUndefined()
  })

  it('refuses to continue in a workspace without journals and in a session without a workspace', async () => {
    const ctx = await setup()
    const bare = await research(ctx, await fakeAgent(ctx, root!, 'bare'), 'continue')
    expect(bare).toEqual({ kind: 'success', text: `No research journals in ${root!}/.dsh/research yet. /research <objective> starts one.` })
    const missing = await research(ctx, await fakeAgent(ctx, root!, 'first'), 'continue opt')
    expect(missing).toEqual({ kind: 'error', text: `No research journal "opt" in ${root!}/.dsh/research. This workspace has none yet; /research <objective> starts one.` })
    const scope = ctx.plugin(() => {})
    const session = ctx.sessions.create(SessionId('no-cwd'), {})
    const agent: Agent = {
      id: SessionId('no-cwd'), options: {}, session, model: unsupportedModel(), inbox: unsupportedInbox(), status: 'idle', ctx: scope.ctx,
      followup: () => {}, steer: () => {}, inject: () => {}, send: () => {}, cancel() {},
      runMaintenance: task => task(new AbortController().signal), whenIdle: () => Promise.resolve(),
    }
    await ctx.agents.register(agent)
    for (const input of ['list', 'continue opt', 'Find the optimum']) {
      expect(await research(ctx, agent, input)).toEqual({ kind: 'error', text: 'This session has no workspace directory for a research journal.' })
    }
  })

  it('injects the journal recall while none is in view and on a step that starts work after a change, and appends the round instruction on goal rounds', async () => {
    const ctx = await setup()
    const agent = await fakeAgent(ctx, root!)
    await research(ctx, agent, 'Find the optimum --slug opt')
    const store = ctx.research.storeFor(root!)
    await store.addBreakthrough('opt', 'Scaling law holds', 'model')
    const first = await preStep(ctx, agent, [])
    expect(text(first)).toContain('<research_journal>')
    expect(text(first)).toContain('Scaling law holds')
    // The recall message enters the log as the loop would append it.
    if (first.kind === 'enter') for (const message of first.messages) agent.session.append('user/message', message, { surfaceOp: 'append' })
    const again = await preStep(ctx, agent, [])
    expect(text(again)).not.toContain('<research_journal>')
    // A change made within the turn reached the model through the tool result that made it.
    await store.addBreakthrough('opt', 'Second law', 'model')
    expect(text(await preStep(ctx, agent, []))).not.toContain('<research_journal>')
    const ask = createUserMessage({ content: [{ type: 'text', text: 'what next?' }], source: { kind: 'user' } })
    const changed = await preStep(ctx, agent, [ask])
    expect(text(changed)).toContain('Second law')
    const goal = ctx.goals.get(agent)!
    const round = createUserMessage({ content: [{ type: 'text', text: 'continue' }], source: { kind: 'goal', goalId: goal.id, revision: goal.revision, round: 1 } })
    const withRound = text(await preStep(ctx, agent, [round]))
    expect(withRound).toContain('Role: researcher')
  })

  it('records entries through the journal tool against the session\'s active research', async () => {
    const ctx = await setup()
    const agent = await fakeAgent(ctx, root!)
    await research(ctx, agent, 'Find the optimum --slug opt')
    const run = (args: Record<string, unknown>) => executeToolFixture(ctx, { signal, callId: ToolCallId('c1'), name: 'journal', agent, arguments: args })
    const breakthrough = await run({ action: 'breakthrough', text: 'Scaling law holds' })
    expect(breakthrough.isError).toBe(false)
    const hypothesis = await run({ action: 'hypothesis', text: 'Depth matters' })
    const id = (hypothesis.value as { id: string }).id
    expect((await run({ action: 'hypothesis', id, status: 'supported' })).isError).toBe(false)
    expect((await run({ action: 'experiment', what: 'Train 3 layers', result: 'error 4%' })).isError).toBe(false)
    expect((await run({ action: 'dead_end', text: 'Dropout above 0.5' })).isError).toBe(false)
    expect((await run({ action: 'next', steps: ['Try 5 layers'] })).isError).toBe(false)
    const read = await run({ action: 'read' })
    expect(read.isError).toBe(false)
    const file = await readFile(join(root!, '.dsh', 'research', 'opt', 'journal.md'), 'utf8')
    expect(file).toContain('Scaling law holds')
    expect(file).toContain('supported] Depth matters')
    expect(file).toContain('Try 5 layers')
    const missing = await run({ action: 'breakthrough', text: 'x', slug: 'nope' })
    expect(missing.isError).toBe(true)
  })

  it('announces a breakthrough through the notify service when mounted', async () => {
    const ctx = await setup()
    const sent: { event: string; text: string }[] = []
    ctx.provide('notify', { send: async (notification: { event: string; text: string }) => { sent.push(notification) }, channels: () => ['x'] } as never)
    const agent = await fakeAgent(ctx, root!)
    await research(ctx, agent, 'Find the optimum --slug opt')
    await ctx.research.record({ cwd: root!, slug: 'opt', kind: 'breakthrough', text: 'Scaling law holds' }, 'auto')
    expect(sent).toHaveLength(1)
    expect(sent[0]?.event).toBe('researchBreakthrough')
    expect(sent[0]?.text).toContain('Scaling law holds')
  })
})
