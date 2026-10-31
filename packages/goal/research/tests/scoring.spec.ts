import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { ReasoningEffortId, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, PreparedAdapterCall, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox, unsupportedModel } from '@deepseek-ai/dsh-agent-loop-testkit'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import CommandRuntime, { CommandId } from '@deepseek-ai/dsh-commands'
import GoalService from '@deepseek-ai/dsh-goal'
import * as Research from '@deepseek-ai/dsh-research'
import * as ResearchTools from '@deepseek-ai/dsh-research/tools'
import { parseScores, renderResearchInstruction, renderScoringRequest, SCORING_SYSTEM_PROMPT } from '@deepseek-ai/dsh-research'
import type { Journal } from '@deepseek-ai/dsh-research'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

const signal = new AbortController().signal

/** Answers every scoring request with the given text; other requests fall through to the script. */
class ScoringAdapter extends MockAdapter {
  scoringAnswers: string[] = []
  scoringRequests: GenerateOptions[] = []
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.purpose === 'research-score') {
      this.scoringRequests.push(options)
      yield* textResponse(this.scoringAnswers.shift() ?? '[]')
      return
    }
    yield* super.stream(options)
  }
}

/** A scoring route whose model lookup fails while its requests still dispatch. */
class UnresolvableScoringAdapter extends ScoringAdapter {
  override resolveModel(): Promise<LlmResolvedModelInfo> {
    return Promise.reject(new Error('model lookup unavailable'))
  }

  override prepareCall(provider: string, model: string): Promise<PreparedAdapterCall> {
    return Promise.resolve({ model: { provider, id: model, name: model }, stream: options => this.stream(options) })
  }
}

/** Offers the given reasoning efforts and answers each scoring request with `reply`; other requests fall through to the script. */
class ThinkingScoringAdapter extends MockAdapter {
  scoringRequests: GenerateOptions[] = []
  reply: (options: GenerateOptions) => StreamChunk[] = () => textResponse('[]')
  constructor(efforts: readonly string[]) {
    super([], { efforts: efforts.map(id => ({ id: ReasoningEffortId(id), name: id })) })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.purpose !== 'research-score') {
      yield* super.stream(options)
      return
    }
    this.scoringRequests.push(options)
    yield* this.reply(options)
  }
}

/** An answer filed entirely as reasoning, ending with the given finish. */
function reasoningOnly(text: string, kind: 'stop' | 'max-tokens'): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text },
    { type: 'finish', reason: { kind } },
  ]
}

function scoringEvents(agent: Agent) {
  return agent.session.snapshotEvents().flatMap(event => event.type === 'session/research-score' ? [event.data] : [])
}

/** Ends each scoring request with the next queued finish reason and no text; other requests fall through to the script. */
class UnansweredScoringAdapter extends MockAdapter {
  finishes: ('max-tokens' | 'tool-calls')[] = []
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.purpose === 'research-score') {
      yield { type: 'finish', reason: { kind: this.finishes.shift() ?? 'max-tokens' } }
      return
    }
    yield* super.stream(options)
  }
}

async function setup(adapter: MockAdapter, overrides: Partial<Research.Config> = {}): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-research-scoring-'))
  const ctx = new Context()
  context = ctx
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['mock'], adapter)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(GoalService)
  await ctx.plugin(Research, {
    dir: '.dsh/research',
    maxRecallBytes: 8000,
    recentExperiments: 3,
    scoring: { enabled: true, maxOutputTokens: 256, timeoutMs: 5000, provider: 'mock', model: 'mock' },
    maxExperimentMs: 60_000,
    maxOutputBytes: 400,
    ...overrides,
  })
  await ctx.plugin(ResearchTools)
  return ctx
}

async function fakeAgent(ctx: Context, cwd: string, id = 'scoring-agent'): Promise<Agent> {
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

describe('parseScores', () => {
  it('accepts a strict JSON array, also inside a fence, and clamps nothing', () => {
    const answer = '[{"hypothesisId":"h-1","score":0.8,"reason":"two experiments agree"},{"hypothesisId":"h-2","score":0.1,"reason":"refuted twice"}]'
    expect(parseScores(answer)).toEqual([
      { hypothesisId: 'h-1', score: 0.8, reason: 'two experiments agree' },
      { hypothesisId: 'h-2', score: 0.1, reason: 'refuted twice' },
    ])
    expect(parseScores('```json\n' + answer + '\n```')).toHaveLength(2)
  })

  it('rejects junk, non-arrays, and out-of-range scores', () => {
    expect(parseScores('I think h-1 is best')).toBeUndefined()
    expect(parseScores('{"hypothesisId":"h-1","score":0.5,"reason":"x"}')).toBeUndefined()
    expect(parseScores('[{"hypothesisId":"h-1","score":1.5,"reason":"x"}]')).toEqual([])
    expect(parseScores('[{"hypothesisId":"h-1","score":"0.5","reason":"x"}, {"hypothesisId":"h-2","score":0.5,"reason":"ok"}]'))
      .toEqual([{ hypothesisId: 'h-2', score: 0.5, reason: 'ok' }])
  })
})

describe('scoring request and instruction', () => {
  it('renders the journal digest with open hypotheses and recent experiments for the scorer', () => {
    const text = renderScoringRequest(journalFixture({
      hypotheses: [{ id: 'h-1', at: 't', source: 'model', text: 'Depth matters', status: 'open' }],
      experiments: [{ id: 'e-1', at: 't', source: 'model', what: 'train 5 layers', result: 'loss 0.25' }],
    }))
    expect(text).toContain('h-1')
    expect(text).toContain('Depth matters')
    expect(text).toContain('train 5 layers')
    expect(SCORING_SYSTEM_PROMPT).toContain('hypothesisId')
  })

  it('tells the round to take the highest-scored open hypothesis first', () => {
    const text = renderResearchInstruction(journalFixture({
      hypotheses: [
        { id: 'h-1', at: 't', source: 'model', text: 'Depth matters', status: 'open', score: 0.3, scoreReason: 'weak' },
        { id: 'h-2', at: 't', source: 'model', text: 'Width matters', status: 'open', score: 0.9, scoreReason: 'strong' },
        { id: 'h-3', at: 't', source: 'model', text: 'Done', status: 'supported', score: 1 },
      ],
    }))
    expect(text).toContain('h-2 (score 0.9: strong)')
    expect(text.indexOf('h-2')).toBeLessThan(text.indexOf('h-1'))
  })
})

describe('hypothesis scoring after an experiment', () => {
  it('logs the scoring request, applies scores to hypotheses, and the file keeps them', async () => {
    const adapter = new ScoringAdapter([])
    const ctx = await setup(adapter)
    const agent = await fakeAgent(ctx, root!)
    await research(ctx, agent, 'Find the optimum --slug opt')
    const run = (args: Record<string, unknown>) => executeToolFixture(ctx, { signal, callId: ToolCallId('c1'), name: 'journal', agent, arguments: args })
    const h1 = (await run({ action: 'hypothesis', text: 'Depth matters' })).value as { id: string }
    const h2 = (await run({ action: 'hypothesis', text: 'Width matters' })).value as { id: string }
    adapter.scoringAnswers.push(`[{"hypothesisId":"${h1.id}","score":0.2,"reason":"loss rose"},{"hypothesisId":"${h2.id}","score":0.7,"reason":"loss fell"},{"hypothesisId":"h-ghost","score":0.5,"reason":"unknown"}]`)
    const result = await run({ action: 'experiment', what: 'train wider', result: 'loss 0.2' })
    expect(result.isError).toBe(false)
    expect(adapter.scoringRequests).toHaveLength(1)
    expect(adapter.scoringRequests[0]).toMatchObject({ provider: 'mock', model: 'mock', purpose: 'research-score', sessionId: agent.id })
    const logged = agent.session.snapshotEvents().filter(event => event.type === 'session/research-score')
    expect(logged).toHaveLength(1)
    const journal = ctx.research.storeFor(root!).get('opt')!
    expect(journal.hypotheses.find(entry => entry.id === h1.id)).toMatchObject({ score: 0.2, scoreReason: 'loss rose' })
    expect(journal.hypotheses.find(entry => entry.id === h2.id)).toMatchObject({ score: 0.7, scoreReason: 'loss fell' })
    const reloaded = Research.parseJournalFile(Research.renderJournalFile(journal))
    expect(reloaded.hypotheses.find(entry => entry.id === h2.id)).toMatchObject({ score: 0.7, scoreReason: 'loss fell', text: 'Width matters' })
  })

  it('ignores an unreadable scoring answer and keeps existing scores', async () => {
    const adapter = new ScoringAdapter([])
    const ctx = await setup(adapter)
    const warnings: string[] = []
    const warn = ctx.logger.warn.bind(ctx.logger)
    ctx.logger.warn = ((...args: unknown[]) => { warnings.push(String(args[0])); warn(...args as [string]) }) as typeof ctx.logger.warn
    const agent = await fakeAgent(ctx, root!)
    await research(ctx, agent, 'Find the optimum --slug opt')
    const run = (args: Record<string, unknown>) => executeToolFixture(ctx, { signal, callId: ToolCallId('c1'), name: 'journal', agent, arguments: args })
    const h1 = (await run({ action: 'hypothesis', text: 'Depth matters' })).value as { id: string }
    adapter.scoringAnswers.push(`[{"hypothesisId":"${h1.id}","score":0.6,"reason":"promising"}]`)
    await run({ action: 'experiment', what: 'a', result: 'b' })
    adapter.scoringAnswers.push('not json at all')
    const second = await run({ action: 'experiment', what: 'c', result: 'd' })
    expect(second.isError).toBe(false)
    expect(ctx.research.storeFor(root!).get('opt')!.hypotheses[0]).toMatchObject({ score: 0.6, scoreReason: 'promising' })
    expect(warnings.some(line => line.includes('research: scoring'))).toBe(true)
  })

  it('logs why a scoring request ended without an answer', async () => {
    const adapter = new UnansweredScoringAdapter([])
    adapter.finishes.push('max-tokens', 'tool-calls')
    const ctx = await setup(adapter)
    const warnings: string[] = []
    const warn = ctx.logger.warn.bind(ctx.logger)
    ctx.logger.warn = ((...args: unknown[]) => { warnings.push(String(args[0])); warn(...args as [string]) }) as typeof ctx.logger.warn
    const agent = await fakeAgent(ctx, root!)
    await research(ctx, agent, 'Find the optimum --slug opt')
    const run = (args: Record<string, unknown>) => executeToolFixture(ctx, { signal, callId: ToolCallId('c1'), name: 'journal', agent, arguments: args })
    await run({ action: 'hypothesis', text: 'Depth matters' })
    await run({ action: 'experiment', what: 'a', result: 'b' })
    await run({ action: 'experiment', what: 'c', result: 'd' })
    expect(warnings).toContain('research: scoring failed for "opt": scoring output reached maxOutputTokens')
    expect(warnings).toContain('research: scoring failed for "opt": scoring model unexpectedly requested a tool')
  })

  it('asks the scoring route for its lowest reasoning effort and logs it, so a route that cannot turn thinking off answers within the cap', async () => {
    // The efforts of a route such as Claude Sonnet 5.5: at its default effort the reasoning fills the cap.
    const adapter = new ThinkingScoringAdapter(['low', 'medium', 'high', 'xhigh', 'max'])
    const ctx = await setup(adapter)
    const agent = await fakeAgent(ctx, root!)
    await research(ctx, agent, 'Find the optimum --slug opt')
    const run = (args: Record<string, unknown>) => executeToolFixture(ctx, { signal, callId: ToolCallId('c1'), name: 'journal', agent, arguments: args })
    const h1 = (await run({ action: 'hypothesis', text: 'Depth matters' })).value as { id: string }
    adapter.reply = options => options.reasoningEffort === undefined
      ? reasoningOnly('weighing every experiment at length', 'max-tokens')
      : textResponse(`[{"hypothesisId":"${h1.id}","score":0.8,"reason":"loss fell"}]`)
    await run({ action: 'experiment', what: 'train deeper', result: 'loss 0.2' })
    expect(adapter.scoringRequests.map(request => [request.reasoningEffort, request.maxTokens])).toEqual([['low', 256]])
    expect(scoringEvents(agent)).toMatchObject([{ reasoningEffort: 'low', maxTokens: 256 }])
    expect(ctx.research.storeFor(root!).get('opt')!.hypotheses[0]).toMatchObject({ score: 0.8, scoreReason: 'loss fell' })
  })

  it('asks the scoring route once more at its default effort when the lowest effort leaves no answer text', async () => {
    const adapter = new ThinkingScoringAdapter(['off', 'high'])
    const ctx = await setup(adapter)
    const agent = await fakeAgent(ctx, root!)
    await research(ctx, agent, 'Find the optimum --slug opt')
    const run = (args: Record<string, unknown>) => executeToolFixture(ctx, { signal, callId: ToolCallId('c1'), name: 'journal', agent, arguments: args })
    const h1 = (await run({ action: 'hypothesis', text: 'Depth matters' })).value as { id: string }
    const answer = `[{"hypothesisId":"${h1.id}","score":0.6,"reason":"promising"}]`
    adapter.reply = options => options.reasoningEffort === undefined ? textResponse(answer) : reasoningOnly(answer, 'stop')
    await run({ action: 'experiment', what: 'a', result: 'b' })
    expect(adapter.scoringRequests.map(request => request.reasoningEffort)).toEqual(['off', undefined])
    const logged = scoringEvents(agent)
    expect(logged.map(data => data.reasoningEffort)).toEqual(['off', undefined])
    expect(logged[1]).not.toHaveProperty('reasoningEffort')
    expect(ctx.research.storeFor(root!).get('opt')!.hypotheses[0]).toMatchObject({ score: 0.6, scoreReason: 'promising' })
  })

  it.each([
    ['offers no reasoning efforts', () => new ScoringAdapter([])],
    ['fails its model lookup', () => new UnresolvableScoringAdapter([])],
  ])('asks a scoring route that %s once at its default effort', async (_route, create) => {
    const adapter = create()
    const ctx = await setup(adapter)
    const agent = await fakeAgent(ctx, root!)
    await research(ctx, agent, 'Find the optimum --slug opt')
    const run = (args: Record<string, unknown>) => executeToolFixture(ctx, { signal, callId: ToolCallId('c1'), name: 'journal', agent, arguments: args })
    await run({ action: 'hypothesis', text: 'Depth matters' })
    adapter.scoringAnswers.push('')
    await run({ action: 'experiment', what: 'a', result: 'b' })
    expect(adapter.scoringRequests).toHaveLength(1)
    expect(adapter.scoringRequests[0]).not.toHaveProperty('reasoningEffort')
    expect(scoringEvents(agent)[0]).not.toHaveProperty('reasoningEffort')
  })

  it('skips scoring when disabled or when no hypothesis is open', async () => {
    const adapter = new ScoringAdapter([])
    const ctx = await setup(adapter, { scoring: { enabled: true, maxOutputTokens: 256, timeoutMs: 5000, provider: 'mock', model: 'mock' } })
    const agent = await fakeAgent(ctx, root!)
    await research(ctx, agent, 'Find the optimum --slug opt')
    const run = (args: Record<string, unknown>) => executeToolFixture(ctx, { signal, callId: ToolCallId('c1'), name: 'journal', agent, arguments: args })
    await run({ action: 'experiment', what: 'a', result: 'b' })
    expect(adapter.scoringRequests).toHaveLength(0)
  })
})
