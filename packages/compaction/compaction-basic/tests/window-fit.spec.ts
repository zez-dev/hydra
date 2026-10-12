import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, createMessage, CONTEXT_WINDOW_EXCEEDED_CODE, LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as SessionInvariant from '@deepseek-ai/dsh-session/invariant'
import * as AgentInvariant from '@deepseek-ai/dsh-agent/invariant'
import * as AgentLoopInvariant from '@deepseek-ai/dsh-agent-loop/invariant'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import type { BasicCompactionConfig } from '@deepseek-ai/dsh-compaction-basic'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import ToolResultPruner from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'

/**
 * The provider's side of the context window: every request whose priced
 * input plus output cap exceeds the window is rejected in band, the way a
 * vLLM or llama.cpp server answers with HTTP 400 instead of truncating. The
 * harness must never send such a request.
 */
class WindowEnforcingAdapter extends LlmAdapter {
  readonly rejected: { input: number; maxTokens: number | undefined }[] = []
  readonly conversationRequests: GenerateOptions[] = []
  readonly summaryRequests: GenerateOptions[] = []
  summaryFinish: 'stop' | 'max-tokens' = 'stop'
  /** When set, a summary request below this cap is cut at the limit, the way a thinking model's checkpoint is. */
  summaryNeedsCap: number | undefined
  /** Words in every checkpoint the summarizer writes; a long one is refused for a range no larger than it. */
  summaryWords = 2
  /** Reasoning tokens every conversation response reports in its usage, the way a thinking route does. */
  reasoningTokens = 0
  /** Provider tokens per heuristic token: a route that tokenizes denser than the harness's guess. */
  providerDensity = 1
  /** Conversation requests answered with an overflow even though they fit, as a provider with a smaller real window would. */
  forcedOverflows = 0
  /** Whether the tool schemas a request carries count toward its input, as they do on every real provider. */
  countsTools = false
  /** Conversation replies still to cut at the output cap, the way a server ends a reply the window has no room left for. */
  cutReplies = 0
  /** When set, a summary request whose input exceeds this many tokens is answered with reasoning only, as a model asked too much. */
  summaryEmptyAbove: number | undefined
  /** When set, a summary request answers only when its request is cancelled, the way a slow checkpoint the user stops does. */
  summaryHangs = false
  /** Models whose lookup fails, the way a server that no longer lists a model answers. */
  readonly unresolvedModels = new Set<string>()
  /** Whether a model lookup reports the window; a server that publishes no model metadata leaves it out. */
  publishesWindow = true
  /** Whether the route appends a changed system prompt to history instead of replacing the first one. */
  appendsPromptUpdates = false

  constructor(
    private readonly ctx: Context,
    private readonly window: number,
    private readonly cap: number,
    private toolSteps: number,
  ) {
    super()
  }

  /** Steps served so far, for tools that vary their result size per step. */
  get steps(): number {
    return this.conversationRequests.length
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    if (this.unresolvedModels.has(model)) return Promise.reject(new Error(`model "${model}" is not served`))
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      ...this.publishesWindow ? { context: { contextWindow: this.window } } : {},
      defaultMaxTokens: this.cap,
      ...this.appendsPromptUpdates ? { systemPromptUpdate: 'in-history' as const } : {},
    })
  }

  private priced(options: GenerateOptions): number {
    const estimated = options.messages.reduce((sum, message) => sum + this.ctx.tokenMeter.estimateMessage(message), 0)
      + (this.countsTools && options.tools !== undefined && options.tools.length > 0
        ? Math.ceil(JSON.stringify(options.tools).length / 4)
        : 0)
    return Math.round(estimated * this.providerDensity)
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const input = this.priced(options)
    const maxTokens = options.maxTokens ?? this.cap
    if (input + maxTokens > this.window) {
      this.rejected.push({ input, maxTokens: options.maxTokens })
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            message: `This model's maximum context length is ${this.window} tokens. However, you requested ${maxTokens} output tokens and your prompt contains at least ${input} input tokens`,
            code: CONTEXT_WINDOW_EXCEEDED_CODE,
          },
        },
      }
      return
    }
    const trailing = options.messages.at(-1)?.content.map(block => (block.type === 'text' ? block.text : '')).join('') ?? ''
    if (trailing.includes('acting as a compaction engine')) {
      this.summaryRequests.push(options)
      if (this.summaryHangs) {
        await new Promise(resolve => options.signal?.addEventListener('abort', resolve, { once: true }))
        yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'summary request aborted', code: 'ABORTED' } } }
        return
      }
      if (this.summaryEmptyAbove !== undefined && input > this.summaryEmptyAbove) {
        yield { type: 'block-start', index: 0, blockType: 'reasoning' }
        yield { type: 'reasoning-delta', index: 0, text: 'lost in the middle' }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      const cut = this.summaryNeedsCap !== undefined && (options.maxTokens ?? 0) < this.summaryNeedsCap
      yield { type: 'block-start', index: 0, blockType: 'text' }
      const summary = this.summaryWords <= 2 ? 'CHECKPOINT SUMMARY' : `## Primary Request\n${'checkpoint detail '.repeat(this.summaryWords / 2)}`
      yield { type: 'block-end', index: 0, block: { type: 'text', text: cut ? '## Primary' : summary } }
      yield { type: 'finish', reason: { kind: cut ? 'max-tokens' : this.summaryFinish } }
      return
    }
    this.conversationRequests.push(options)
    if (this.forcedOverflows > 0) {
      this.forcedOverflows -= 1
      yield {
        type: 'finish',
        reason: { kind: 'error', failure: { message: 'request too large for model context', code: CONTEXT_WINDOW_EXCEEDED_CODE } },
      }
      return
    }
    if (this.cutReplies > 0) {
      this.cutReplies -= 1
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'partial answer' } }
      yield { type: 'finish', reason: { kind: 'max-tokens' } }
      return
    }
    if (this.toolSteps > 0) {
      this.toolSteps -= 1
      const id = ToolCallId(`read-${this.conversationRequests.length}`)
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'read_big', arguments: '{}' } }
      if (this.reasoningTokens > 0) {
        yield { type: 'usage', usage: { inputTokens: input, outputTokens: this.reasoningTokens + 20, reasoningTokens: this.reasoningTokens } }
      }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'all done' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function harness(
  adapterOf: (ctx: Context) => WindowEnforcingAdapter,
  config: BasicCompactionConfig,
  toolResultWords: number | ((step: number) => number),
): Promise<{ ctx: Context; adapter: WindowEnforcingAdapter }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(SessionInvariant)
  await ctx.plugin(AgentInvariant)
  await ctx.plugin(AgentLoopInvariant)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TokenMeter)
  const adapter = adapterOf(ctx)
  ctx.llm.registerAdapter(['mock'], adapter)
  ctx.tools.register(defineContentToolFixture({
    name: 'read_big',
    description: 'reads a large file',
    parameters: {},
    async execute(): Promise<ContentBlock[]> {
      const words = typeof toolResultWords === 'number' ? toolResultWords : toolResultWords(adapter.steps)
      return [{ type: 'text', text: `${'file content '.repeat(words)}line ${adapter.steps}` }]
    },
  }))
  await ctx.plugin(BasicCompactionEngine, config)
  return { ctx, adapter }
}

function seedTurns(turns: number, words: number): readonly SessionEvent[] {
  const session = Session.create(SessionId('window-fit-seed'))
  for (let turn = 1; turn <= turns; turn += 1) {
    session.append('turn/start', { turn })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `OLD TURN ${turn} ${'old context '.repeat(words)}` }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('step/start', { turn, step: 1 })
    session.append('assistant/message', {
      stream: [],
      turn,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: `historical response ${turn} ${'detail '.repeat(words)}` }],
        source: { kind: 'model', provider: 'mock', model: 'mock' },
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  return session.snapshotEvents()
}

/**
 * Steps in which a step-boundary compaction ran: one attempt can write several
 * compaction events when it condenses a smaller range after a cut checkpoint.
 * @param events - the session log.
 * @returns the number of distinct steps with a compaction.
 */
function stepsWithCompaction(events: readonly SessionEvent[]): number {
  const steps = new Set<string>()
  let step = ''
  for (const event of events) {
    if (event.type === 'step/start') step = `${event.data.turn}:${event.data.step}`
    if (event.type === 'compaction/start' && event.data.turn !== null) steps.add(step)
  }
  return steps.size
}

describe('the harness never sends a request the window cannot hold', () => {
  // Sizes below come from the meter's own estimates: three seeded turns are
  // about 1070 tokens, the 120-word file read about 400, the compaction
  // instruction about 460, and the test system prompt is a few tokens.

  it('condenses before the request when a tool result leaves no room for the output cap', async () => {
    // Window 2000, output cap 500: after the read the surface is about 1530
    // tokens, under the 80% threshold (1600) but over the room left for the
    // cap and margin (1400); 1530 + 500 would be rejected.
    const { ctx, adapter } = await harness(
      c => new WindowEnforcingAdapter(c, 2000, 500, 1),
      { thresholdRatio: 0.8, retainTokens: 60, maxTokens: 64, compactionRetries: 1 },
      120,
    )
    try {
      const { agent } = await ctx.agentLoop.createAgent(ctx, {
        sessionId: SessionId('fit-before-request'),
        seed: seedTurns(3, 70),
        agentOptions: { provider: 'mock', model: 'mock' },
      })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'read the file' }], source: { kind: 'user' } }))
      await agent.whenIdle()

      expect(adapter.rejected).toEqual([])
      expect(adapter.summaryRequests).toHaveLength(1)
      const events = agent.session.snapshotEvents()
      // The checkpoint lands after the file read and before the next model answer.
      const summary = events.find(event => event.type === 'compaction/summary')
      const read = events.find(event => event.type === 'tool/result')
      const answer = events.filter(event => event.type === 'assistant/message').at(-1)
      expect(summary).toBeDefined()
      expect(read).toBeDefined()
      expect(answer).toBeDefined()
      expect(summary!.seq).toBeGreaterThan(read!.seq)
      expect(summary!.seq).toBeLessThan(answer!.seq)
      expect(events.at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('logs each request as priced, with the threshold the next step condenses at, before its header', async () => {
    const { ctx, adapter } = await harness(
      c => new WindowEnforcingAdapter(c, 2000, 500, 1),
      { thresholdRatio: 0.8, retainTokens: 60, maxTokens: 64, compactionRetries: 1 },
      120,
    )
    try {
      const { agent } = await ctx.agentLoop.createAgent(ctx, {
        sessionId: SessionId('fit-pressure-logged'),
        seed: seedTurns(3, 70),
        agentOptions: { provider: 'mock', model: 'mock' },
      })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'read the file' }], source: { kind: 'user' } }))
      await agent.whenIdle()

      expect(adapter.rejected).toEqual([])
      const events = agent.session.snapshotEvents()
      const headers = events.filter(event => event.type === 'request/header')
      expect(headers.length).toBeGreaterThanOrEqual(2)
      for (const header of headers) {
        // The price precedes the header it prices, once: the event right before
        // the header's own request facts, never repeated for a retry.
        const before = events.slice(0, header.seq)
        const pressure = before.findLast(event => event.type === 'compaction/pressure')
        if (pressure?.type !== 'compaction/pressure') throw new Error('no priced request before a header')
        expect(pressure.ignorable).toBe(true)
        expect(pressure.data.pricedTokens).toBeGreaterThanOrEqual(pressure.data.estimatedTokens)
        expect(pressure.data.density).toBeGreaterThanOrEqual(1)
        expect(pressure.data.contextWindow).toBe(2000)
        expect(pressure.data.outputCap).toBeLessThanOrEqual(500)
        // The threshold is the lower of the ratio and the room the cap leaves.
        expect(pressure.data.thresholdTokens).toBeLessThanOrEqual(Math.min(1600, 2000 - pressure.data.outputCap))
        expect(pressure.data.thresholdTokens).toBeGreaterThan(0)
      }
      expect(events.filter(event => event.type === 'compaction/pressure')).toHaveLength(headers.length)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('prices a new session\'s first request with the system prompt and tool schemas it carries', async () => {
    // Window 2000, cap 500, margin 100, output floor 256: a prompt plus tool
    // schemas of about 1560 tokens is refused at the full cap but fits once
    // the cap shrinks. Before the first request neither is in the log yet.
    const { ctx, adapter } = await harness(
      c => new WindowEnforcingAdapter(c, 2000, 500, 0),
      { thresholdRatio: 0.8, retainTokens: 60, maxTokens: 64, compactionRetries: 1 },
      10,
    )
    adapter.countsTools = true
    const system = 'guidance '.repeat(540).trim()
    ctx.systemPrompt.section({ name: 'first-request-test', order: 0, complete: true, text: system })
    ctx.tools.register(defineContentToolFixture({
      name: 'lookup',
      description: 'reference '.repeat(120).trim(),
      parameters: {},
      execute: () => Promise.resolve([{ type: 'text', text: 'none' }]),
    }))
    try {
      const { agent } = await ctx.agentLoop.createAgent(ctx, {
        sessionId: SessionId('fit-first-request'),
        agentOptions: { provider: 'mock', model: 'mock' },
      })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }))
      await agent.whenIdle()

      expect(adapter.rejected).toEqual([])
      const [first] = adapter.conversationRequests
      if (first === undefined) throw new Error('no conversation request')
      const input = first.messages.reduce((sum, message) => sum + ctx.tokenMeter.estimateMessage(message), 0)
        + Math.ceil(JSON.stringify(first.tools).length / 4)
      // The configured cap would have been refused; the request asked for the room left.
      expect(input + 500).toBeGreaterThan(2000)
      expect(first.maxTokens).toBeLessThan(500)
      const pressure = agent.session.snapshotEvents().find(event => event.type === 'compaction/pressure')
      if (pressure?.type !== 'compaction/pressure') throw new Error('no priced request')
      expect(pressure.data.pricedTokens).toBeGreaterThanOrEqual(input)
      expect(agent.session.snapshotEvents().at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('prices tool schemas added after the last request before the next one goes out', async () => {
    // The first turn fits with the full cap; a tool registered afterwards
    // brings the next request to about 1560 tokens, which only fits once the
    // cap shrinks. The logged header still lists the old tools at pre-step.
    const { ctx, adapter } = await harness(
      c => new WindowEnforcingAdapter(c, 2000, 500, 0),
      { thresholdRatio: 0.8, retainTokens: 60, maxTokens: 64, compactionRetries: 1 },
      10,
    )
    adapter.countsTools = true
    ctx.systemPrompt.section({ name: 'tools-change-test', order: 0, complete: true, text: 'guidance '.repeat(300).trim() })
    try {
      const { agent } = await ctx.agentLoop.createAgent(ctx, {
        sessionId: SessionId('fit-tools-change'),
        agentOptions: { provider: 'mock', model: 'mock' },
      })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }))
      await agent.whenIdle()
      expect(adapter.conversationRequests[0]?.maxTokens ?? 500).toBe(500)
      ctx.tools.register(defineContentToolFixture({
        name: 'lookup',
        description: 'reference '.repeat(320).trim(),
        parameters: {},
        execute: () => Promise.resolve([{ type: 'text', text: 'none' }]),
      }))
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'again' }], source: { kind: 'user' } }))
      await agent.whenIdle()

      expect(adapter.rejected).toEqual([])
      const second = adapter.conversationRequests[1]
      if (second === undefined) throw new Error('no second request')
      const input = second.messages.reduce((sum, message) => sum + ctx.tokenMeter.estimateMessage(message), 0)
        + Math.ceil(JSON.stringify(second.tools).length / 4)
      expect(input + 500).toBeGreaterThan(2000)
      expect(second.maxTokens).toBeLessThan(500)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('reserves a share of the window, not a whole 100K output cap, before condensing', async () => {
    // Window 150K with a 100K output cap: reserving the whole cap would
    // condense at 150K - 100K - 7.5K margin = 42.5K. The reserve is the lower
    // of the cap and a quarter of the window, so condensing waits for
    // 150K - 37.5K - 7.5K = 105K; a request above 42.5K asks for the room left.
    const { ctx, adapter } = await harness(
      c => new WindowEnforcingAdapter(c, 150_000, 100_000, 0),
      { thresholdRatio: 0.8, retainRatio: 0.16 },
      10,
    )
    try {
      const { agent } = await ctx.agentLoop.createAgent(ctx, {
        sessionId: SessionId('fit-large-output-cap'),
        seed: seedTurns(10, 1000),
        agentOptions: { provider: 'mock', model: 'mock' },
      })
      // Two turns: the second step-boundary check runs against a logged route.
      for (const text of ['continue', 'continue again']) {
        agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
        await agent.whenIdle()
      }

      expect(adapter.rejected).toEqual([])
      expect(adapter.summaryRequests).toEqual([])
      const pressure = agent.session.snapshotEvents().findLast(event => event.type === 'compaction/pressure')
      if (pressure?.type !== 'compaction/pressure') throw new Error('no priced request')
      expect(pressure.data.pricedTokens).toBeGreaterThan(42_500)
      expect(pressure.data.thresholdTokens).toBe(105_000)
      const [request] = adapter.conversationRequests
      expect(request?.maxTokens).toBeLessThan(100_000)
      expect(agent.session.snapshotEvents().at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('backs off after a failed compaction instead of retrying on every step', async () => {
    // Every checkpoint is cut at its cap, the way a thinking route's is, so
    // each compaction attempt fails. Seven small reads follow; the surface
    // barely grows, so after the first failure no step retries until the
    // backoff's step count or growth allows it, and every request still fits.
    const { ctx, adapter } = await harness(
      c => new WindowEnforcingAdapter(c, 2000, 500, 7),
      {
        thresholdRatio: 0.5, retainTokens: 60, maxTokens: 64, compactionRetries: 0, failureBackoffSteps: 20, failureBackoffGrowthRatio: 0.5,
      },
      5,
    )
    adapter.summaryNeedsCap = 100_000
    try {
      const { agent } = await ctx.agentLoop.createAgent(ctx, {
        sessionId: SessionId('fit-backoff'),
        seed: seedTurns(3, 70),
        agentOptions: { provider: 'mock', model: 'mock' },
      })
      for (const text of ['warm up', 'read the files']) {
        agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
        await agent.whenIdle()
      }
      const events = agent.session.snapshotEvents()
      expect(adapter.rejected).toEqual([])
      expect(stepsWithCompaction(events)).toBe(1)
      expect(events.at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('retries a failed compaction at the step after a reply cut at its output cap, whatever the backoff', async () => {
    // Every checkpoint is cut, so the first attempt fails and the backoff
    // would hold for the rest of the run. A reply cut at its cap shows the
    // window no longer holds a whole answer, so the next step tries again.
    const { ctx, adapter } = await harness(
      c => new WindowEnforcingAdapter(c, 2000, 500, 2),
      {
        thresholdRatio: 0.5, retainTokens: 60, maxTokens: 64, compactionRetries: 0, failureBackoffSteps: 20, failureBackoffGrowthRatio: 0.5,
      },
      5,
    )
    adapter.summaryNeedsCap = 100_000
    try {
      const { agent } = await ctx.agentLoop.createAgent(ctx, {
        sessionId: SessionId('fit-backoff-cut'),
        seed: seedTurns(3, 70),
        agentOptions: { provider: 'mock', model: 'mock' },
      })
      const send = async (text: string): Promise<void> => {
        agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
        await agent.whenIdle()
      }
      await send('warm up')
      expect(stepsWithCompaction(agent.session.snapshotEvents())).toBe(1)
      adapter.cutReplies = 1
      await send('write the report')
      expect(agent.session.snapshotEvents().at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'max-tokens' } } })
      expect(stepsWithCompaction(agent.session.snapshotEvents())).toBe(1)
      await send('continue')
      expect(stepsWithCompaction(agent.session.snapshotEvents())).toBe(2)
      expect(adapter.rejected).toEqual([])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('does not back off after a compaction the user stopped', async () => {
    // Stopping the turn during a slow checkpoint is not a failed compaction:
    // the next turn condenses at its first step instead of waiting out a backoff.
    const { ctx, adapter } = await harness(
      c => new WindowEnforcingAdapter(c, 2000, 500, 2),
      {
        thresholdRatio: 0.5, retainTokens: 60, maxTokens: 64, compactionRetries: 0, failureBackoffSteps: 20, failureBackoffGrowthRatio: 0.5,
      },
      5,
    )
    adapter.summaryHangs = true
    try {
      const { agent } = await ctx.agentLoop.createAgent(ctx, {
        sessionId: SessionId('fit-stopped-compaction'),
        seed: seedTurns(3, 70),
        agentOptions: { provider: 'mock', model: 'mock' },
      })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'warm up' }], source: { kind: 'user' } }))
      await vi.waitFor(() => { expect(adapter.summaryRequests).toHaveLength(1) })
      agent.cancel({ kind: 'user' })
      await agent.whenIdle()
      adapter.summaryHangs = false
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } }))
      await agent.whenIdle()
      const events = agent.session.snapshotEvents()
      expect(events.filter(event => event.type === 'compaction/start')).toHaveLength(2)
      expect(events.filter(event => event.type === 'compaction/summary')).toHaveLength(1)
      expect(adapter.rejected).toEqual([])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('retries a failed compaction once the surface has grown by the backoff growth share', async () => {
    const { ctx, adapter } = await harness(
      c => new WindowEnforcingAdapter(c, 2000, 500, 7),
      {
        thresholdRatio: 0.5, retainTokens: 60, maxTokens: 64, compactionRetries: 0,
        failureBackoffSteps: 100, failureBackoffGrowthRatio: 0.05,
      },
      5,
    )
    adapter.summaryNeedsCap = 100_000
    try {
      const { agent } = await ctx.agentLoop.createAgent(ctx, {
        sessionId: SessionId('fit-backoff-growth'),
        seed: seedTurns(3, 70),
        agentOptions: { provider: 'mock', model: 'mock' },
      })
      for (const text of ['warm up', 'read the files']) {
        agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
        await agent.whenIdle()
      }
      const attempts = stepsWithCompaction(agent.session.snapshotEvents())
      // More than one attempt (growth ended the backoff), far fewer than one per step.
      expect(attempts).toBeGreaterThan(1)
      expect(attempts).toBeLessThan(8)
      expect(adapter.rejected).toEqual([])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('prunes a single read larger than the whole window before the next request', async () => {
    // A 3000-word read (about 9800 tokens) cannot fit a 2000 window whatever is
    // condensed; the model-free pruner cuts it to its head and tail first.
    const { ctx, adapter } = await harness(
      c => new WindowEnforcingAdapter(c, 2000, 300, 1),
      { thresholdRatio: 0.8, retainTokens: 60, maxTokens: 64, compactionRetries: 1 },
      3000,
    )
    await ctx.plugin(ToolResultPruner, { thresholdChars: 2000, headChars: 600, tailChars: 300 })
    try {
      const { agent } = await ctx.agentLoop.createAgent(ctx, {
        sessionId: SessionId('huge-read'),
        seed: seedTurns(1, 10),
        agentOptions: { provider: 'mock', model: 'mock' },
      })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'read the huge file' }], source: { kind: 'user' } }))
      await agent.whenIdle()

      expect(adapter.rejected).toEqual([])
      expect(agent.session.snapshotEvents().some(event => event.type === 'compaction/prune')).toBe(true)
      expect(agent.session.snapshotEvents().at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('survives thirty steps of reads of varying size without one rejected request', async () => {
    // Window 3000, cap 400: reads between 40 and 260 words (about 130 to 860
    // tokens) keep crossing the room left, so condensing has to run again and
    // again on a surface that is mostly checkpoints and fresh reads.
    const sizes = [40, 260, 120, 200, 60, 240, 180, 90, 250, 30]
    const { ctx, adapter } = await harness(
      c => new WindowEnforcingAdapter(c, 3000, 400, 30),
      { thresholdRatio: 0.8, retainRatio: 0.16, maxTokens: 64, compactionRetries: 1, maxOverflowRetries: 3 },
      step => sizes[step % sizes.length]!,
    )
    try {
      const { agent } = await ctx.agentLoop.createAgent(ctx, {
        sessionId: SessionId('stress-reads'),
        seed: seedTurns(2, 70),
        agentOptions: { provider: 'mock', model: 'mock' },
      })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'read all the files' }], source: { kind: 'user' } }))
      await agent.whenIdle()

      expect(adapter.rejected).toEqual([])
      expect(adapter.conversationRequests).toHaveLength(31)
      expect(adapter.summaryRequests.length).toBeGreaterThan(3)
      expect(agent.session.snapshotEvents().at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('fits a request whose only condensable head is smaller than any checkpoint', async () => {
    // A 400-word read (about 1300 tokens) on a 60-token history: the surface
    // is over the room left, but the only condensable head is smaller than the
    // checkpoint that would replace it, so condensing is refused and the
    // request fits by shrinking its cap instead. The policy cap of 8192 is
    // bounded to 25% of the window, so it does not reserve half of it.
    const { ctx, adapter } = await harness(
      c => new WindowEnforcingAdapter(c, 2000, 500, 1),
      { thresholdRatio: 0.8, retainTokens: 60, maxTokens: 8192, compactionRetries: 1, minOutputTokens: 64 },
      400,
    )
    try {
      const { agent } = await ctx.agentLoop.createAgent(ctx, {
        sessionId: SessionId('tiny-head'),
        seed: seedTurns(1, 4),
        agentOptions: { provider: 'mock', model: 'mock' },
      })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'read the file' }], source: { kind: 'user' } }))
      await agent.whenIdle()

      expect(adapter.rejected).toEqual([])
      expect(adapter.summaryRequests.length).toBeLessThanOrEqual(1)
      expect(agent.session.snapshotEvents().some(event => event.type === 'compaction/summary')).toBe(false)
      const caps = adapter.conversationRequests.map(request => request.maxTokens)
      expect(caps[1]).toBeLessThan(500)
      expect(agent.session.snapshotEvents().at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('sends the summarizer a cap bounded by the window', async () => {
    const { ctx, adapter } = await harness(
      c => new WindowEnforcingAdapter(c, 2000, 100, 0),
      { thresholdRatio: 0.8, retainTokens: 60, maxTokens: 8192, compactionRetries: 0, maxOverflowRetries: 2, summaryWindowRatio: 0.2 },
      0,
    )
    adapter.forcedOverflows = 1
    try {
      const { agent } = await ctx.agentLoop.createAgent(ctx, {
        sessionId: SessionId('bounded-summary-cap'),
        seed: seedTurns(3, 70),
        agentOptions: { provider: 'mock', model: 'mock' },
      })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } }))
      await agent.whenIdle()

      expect(adapter.rejected).toEqual([])
      const caps = adapter.summaryRequests.map(request => request.maxTokens ?? 0)
      expect(caps).toHaveLength(1)
      expect(caps[0]).toBeGreaterThan(0)
      expect(caps[0]).toBeLessThanOrEqual(400)
      expect(agent.session.snapshotEvents().at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('raises the summary cap when the checkpoint is cut at it, up to what the window affords', async () => {
    // The policy cap is 64; the checkpoint needs 900. Each cut raises the cap
    // four times, bounded by a quarter of the 4000 window: 64, 256, 1000.
    // Pressure at a fifth of the window condenses before the second request
    // (the first one routes the model, which the pressure check needs).
    const { ctx, adapter } = await harness(
      c => new WindowEnforcingAdapter(c, 4000, 100, 1),
      { thresholdRatio: 0.2, retainTokens: 60, maxTokens: 64, compactionRetries: 0, maxOverflowRetries: 2 },
      10,
    )
    adapter.summaryNeedsCap = 900
    try {
      const { agent } = await ctx.agentLoop.createAgent(ctx, {
        sessionId: SessionId('summary-cap-raise'),
        seed: seedTurns(3, 70),
        agentOptions: { provider: 'mock', model: 'mock' },
      })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } }))
      await agent.whenIdle()

      expect(adapter.summaryRequests.map(request => request.maxTokens)).toEqual([64, 256, 1000])
      expect(agent.session.snapshotEvents().some(event => event.type === 'compaction/summary')).toBe(true)
      expect(agent.session.snapshotEvents().at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('condenses a smaller range when the provider refuses the summarization request as over its window', async () => {
    // The provider counts half again as many tokens as the harness guesses,
    // so the first manual /compact replays a surface the provider will not
    // take; the next attempt condenses half the range and lands.
    const { ctx, adapter } = await harness(
      c => new WindowEnforcingAdapter(c, 2000, 100, 0),
      { thresholdRatio: 0.8, retainTokens: 60, maxTokens: 64, compactionRetries: 0, maxOverflowRetries: 0 },
      0,
    )
    try {
      const { agent } = await ctx.agentLoop.createAgent(ctx, {
        sessionId: SessionId('compact-shrink'),
        seed: seedTurns(3, 70),
        agentOptions: { provider: 'mock', model: 'mock' },
      })
      // One ordinary turn records the routed model; the provider then starts
      // counting denser than the harness.
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } }))
      await agent.whenIdle()
      expect(adapter.rejected).toEqual([])
      adapter.providerDensity = 1.5
      const result = await ctx.compaction.compactNow(agent, new AbortController().signal)
      expect(result).not.toBeNull()
      expect(adapter.rejected.length).toBeGreaterThanOrEqual(1)
      expect(adapter.summaryRequests.length).toBeGreaterThanOrEqual(1)
      expect(agent.session.snapshotEvents().some(event => event.type === 'compaction/summary')).toBe(true)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('condenses a smaller range when the checkpoint is cut at the room the whole surface leaves', async () => {
    // A thinking model needs 900 output tokens for the checkpoint. Replaying
    // the whole surface (about 2560 tokens) in a 4000 window leaves under 800,
    // so every raise is cut there; a range about half the size leaves the
    // window share (1000) and lands.
    const { ctx, adapter } = await harness(
      c => new WindowEnforcingAdapter(c, 4000, 100, 0),
      { thresholdRatio: 0.8, retainTokens: 60, maxTokens: 64, compactionRetries: 0, maxOverflowRetries: 0 },
      0,
    )
    adapter.summaryNeedsCap = 900
    try {
      const { agent } = await ctx.agentLoop.createAgent(ctx, {
        sessionId: SessionId('compact-cut-shrink'),
        seed: seedTurns(7, 70),
        agentOptions: { provider: 'mock', model: 'mock' },
      })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } }))
      await agent.whenIdle()
      const result = await ctx.compaction.compactNow(agent, new AbortController().signal)
      expect(result).not.toBeNull()
      expect(adapter.rejected).toEqual([])
      const caps = adapter.summaryRequests.map(request => request.maxTokens ?? 0)
      expect(caps.at(-1)).toBeGreaterThanOrEqual(900)
      expect(Math.max(...caps.slice(0, -1))).toBeLessThan(900)
      expect(agent.session.snapshotEvents().some(event => event.type === 'compaction/summary')).toBe(true)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('reports a checkpoint cut at the window share when a smaller range would afford no more', async () => {
    // The ceiling is the window share (a quarter of 4000), not the room the
    // range leaves, so shrinking the range cannot help and the cut is reported
    // after the three raises.
    const { ctx, adapter } = await harness(
      c => new WindowEnforcingAdapter(c, 4000, 100, 0),
      { thresholdRatio: 0.8, retainTokens: 60, maxTokens: 64, compactionRetries: 0, maxOverflowRetries: 0 },
      0,
    )
    adapter.summaryNeedsCap = 2000
    try {
      const { agent } = await ctx.agentLoop.createAgent(ctx, {
        sessionId: SessionId('compact-cut-share'),
        seed: seedTurns(3, 70),
        agentOptions: { provider: 'mock', model: 'mock' },
      })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } }))
      await agent.whenIdle()
      await expect(ctx.compaction.compactNow(agent, new AbortController().signal))
        .rejects.toMatchObject({ code: 'summary', cause: { code: 'MAX_TOKENS' } })
      expect(adapter.summaryRequests.map(request => request.maxTokens)).toEqual([64, 256, 1000])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('reports a checkpoint cut at the policy cap without a raise when outputRetryFactor is 1', async () => {
    const { ctx, adapter } = await harness(
      c => new WindowEnforcingAdapter(c, 4000, 100, 0),
      { thresholdRatio: 0.8, retainTokens: 60, maxTokens: 64, compactionRetries: 0, maxOverflowRetries: 0, outputRetryFactor: 1 },
      0,
    )
    adapter.summaryNeedsCap = 2000
    try {
      const { agent } = await ctx.agentLoop.createAgent(ctx, {
        sessionId: SessionId('compact-cut-unraised'),
        seed: seedTurns(3, 70),
        agentOptions: { provider: 'mock', model: 'mock' },
      })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } }))
      await agent.whenIdle()
      await expect(ctx.compaction.compactNow(agent, new AbortController().signal))
        .rejects.toMatchObject({ code: 'summary', cause: { code: 'MAX_TOKENS' } })
      expect(adapter.summaryRequests.map(request => request.maxTokens)).toEqual([64])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('condenses a smaller range on a reopened session whose route this process has not seen yet', async () => {
    // A session reopened in a new process carries its routed model but the
    // engine has resolved no capacity for the agent yet, so the first /compact
    // condenses the whole surface; when the provider refuses that, the
    // capacity is resolved and halved ranges are tried.
    const { ctx, adapter } = await harness(
      c => new WindowEnforcingAdapter(c, 2000, 100, 0),
      { thresholdRatio: 0.8, retainTokens: 60, maxTokens: 64, compactionRetries: 0, maxOverflowRetries: 0 },
      0,
    )
    try {
      const { agent: earlier } = await ctx.agentLoop.createAgent(ctx, {
        sessionId: SessionId('compact-shrink-earlier'),
        seed: seedTurns(3, 70),
        agentOptions: { provider: 'mock', model: 'mock' },
      })
      earlier.followup(createUserMessage({ content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } }))
      await earlier.whenIdle()
      const { agent } = await ctx.agentLoop.createAgent(ctx, {
        sessionId: SessionId('compact-shrink-reopened'),
        seed: earlier.session.snapshotEvents(),
        agentOptions: { provider: 'mock', model: 'mock' },
      })
      adapter.providerDensity = 1.5
      const result = await ctx.compaction.compactNow(agent, new AbortController().signal)
      expect(result).not.toBeNull()
      expect(adapter.rejected.length).toBeGreaterThanOrEqual(1)
      expect(agent.session.snapshotEvents().some(event => event.type === 'compaction/summary')).toBe(true)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('learns from one refusal how the provider counts and fits every later request to it', async () => {
    // The provider counts half again as many tokens as the harness guesses.
    // The first request it refuses teaches the route's density; the reads
    // that follow are all fitted at that density and none is refused.
    const { ctx, adapter } = await harness(
      c => new WindowEnforcingAdapter(c, 2000, 100, 6),
      { thresholdRatio: 0.8, retainTokens: 60, maxTokens: 64, compactionRetries: 0, maxOverflowRetries: 3 },
      60,
    )
    adapter.providerDensity = 1.5
    const warnings: string[] = []
    ctx.logger.warn = ((message: string) => void warnings.push(message)) as typeof ctx.logger.warn
    try {
      const { agent } = await ctx.agentLoop.createAgent(ctx, {
        sessionId: SessionId('learned-density'),
        seed: seedTurns(3, 70),
        agentOptions: { provider: 'mock', model: 'mock' },
      })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'read all the files' }], source: { kind: 'user' } }))
      await agent.whenIdle()
      expect(adapter.rejected).toHaveLength(1)
      expect(warnings.some(message => message.includes('counts at least'))).toBe(true)
      expect(adapter.conversationRequests.length).toBeGreaterThanOrEqual(7)
      expect(agent.session.snapshotEvents().at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('relaxes a learned density when a larger request is accepted', async () => {
    // A provider that refuses one request it would accept a moment later
    // (a transient rejection) teaches a density far above the truth; the
    // summarization request it then accepts, larger than the refused one,
    // proves the bound and the density comes back down.
    // With one short turn of history the refusal teaches a density that
    // leaves nothing condensable, so the fit falls back to the meter's own
    // density; that summarization request is larger than the refused one.
    const { ctx, adapter } = await harness(
      c => new WindowEnforcingAdapter(c, 4000, 100, 0),
      { thresholdRatio: 0.8, retainTokens: 60, maxTokens: 64, compactionRetries: 0, maxOverflowRetries: 2 },
      0,
    )
    adapter.forcedOverflows = 1
    const notes: string[] = []
    ctx.logger.warn = ((message: string) => void notes.push(message)) as typeof ctx.logger.warn
    ctx.logger.info = ((message: string) => void notes.push(message)) as typeof ctx.logger.info
    try {
      const { agent } = await ctx.agentLoop.createAgent(ctx, {
        sessionId: SessionId('relaxed-density'),
        seed: seedTurns(1, 70),
        agentOptions: { provider: 'mock', model: 'mock' },
      })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } }))
      await agent.whenIdle()
      expect(notes.some(message => message.includes('counts at least'))).toBe(true)
      expect(notes.some(message => message.includes('counts at most'))).toBe(true)
      expect(agent.session.snapshotEvents().at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('grows the range by the next node when the checkpoint is no smaller than the range', async () => {
    // The retention leaves a single old turn to condense, and the summarizer
    // writes a checkpoint longer than that turn; instead of reporting the
    // failure, the next turn joins the range and the checkpoint lands.
    const { ctx, adapter } = await harness(
      c => new WindowEnforcingAdapter(c, 4000, 100, 1),
      { thresholdRatio: 0.25, retainTokens: 800, maxTokens: 2000, compactionRetries: 0, maxOverflowRetries: 0 },
      10,
    )
    adapter.summaryWords = 400
    try {
      const { agent } = await ctx.agentLoop.createAgent(ctx, {
        sessionId: SessionId('grown-range'),
        seed: seedTurns(3, 70),
        agentOptions: { provider: 'mock', model: 'mock' },
      })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'read the file' }], source: { kind: 'user' } }))
      await agent.whenIdle()
      expect(adapter.summaryRequests).toHaveLength(2)
      expect(adapter.summaryRequests[1]!.messages.length).toBeGreaterThan(adapter.summaryRequests[0]!.messages.length)
      expect(agent.session.snapshotEvents().some(event => event.type === 'compaction/summary')).toBe(true)
      expect(agent.session.snapshotEvents().at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('stops after one summary request when the checkpoint is longer than all the history it could replace', async () => {
    // As above, but the checkpoint outgrows the whole history: the range
    // grows to the newest node and is still no larger than the checkpoint,
    // so the step reports the failure instead of asking the model again.
    const { ctx, adapter } = await harness(
      c => new WindowEnforcingAdapter(c, 4000, 100, 1),
      { thresholdRatio: 0.25, retainTokens: 800, maxTokens: 2000, compactionRetries: 0, maxOverflowRetries: 0 },
      10,
    )
    adapter.summaryWords = 1200
    const warnings: string[] = []
    ctx.logger.warn = ((message: string) => void warnings.push(message)) as typeof ctx.logger.warn
    try {
      const { agent } = await ctx.agentLoop.createAgent(ctx, {
        sessionId: SessionId('outgrown-range'),
        seed: seedTurns(3, 70),
        agentOptions: { provider: 'mock', model: 'mock' },
      })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'read the file' }], source: { kind: 'user' } }))
      await agent.whenIdle()
      expect(adapter.summaryRequests).toHaveLength(1)
      expect(warnings.some(message => message.startsWith('step compaction failed: summary is not smaller'))).toBe(true)
      expect(agent.session.snapshotEvents().some(event => event.type === 'compaction/summary')).toBe(false)
      expect(adapter.rejected).toEqual([])
      expect(agent.session.snapshotEvents().at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('reports a /compact whose checkpoint is longer than the whole history, then answers the next without a model call', async () => {
    const { ctx, adapter } = await harness(
      c => new WindowEnforcingAdapter(c, 4000, 100, 0),
      { thresholdRatio: 0.8, retainTokens: 60, maxTokens: 2000, compactionRetries: 0, maxOverflowRetries: 0 },
      0,
    )
    adapter.summaryWords = 400
    try {
      const { agent } = await ctx.agentLoop.createAgent(ctx, {
        sessionId: SessionId('compact-outgrown'),
        seed: seedTurns(1, 20),
        agentOptions: { provider: 'mock', model: 'mock' },
      })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } }))
      await agent.whenIdle()
      await expect(ctx.compaction.compactNow(agent, new AbortController().signal))
        .rejects.toMatchObject({ code: 'summary', cause: { code: 'SUMMARY_NOT_SMALLER' } })
      expect(adapter.summaryRequests).toHaveLength(1)
      // The refused checkpoint's size is remembered: no range of this history is worth another request.
      await expect(ctx.compaction.compactNow(agent, new AbortController().signal)).resolves.toBeNull()
      expect(adapter.summaryRequests).toHaveLength(1)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('answers a second /compact right after the first with nothing to condense instead of summarizing the checkpoint', async () => {
    const { ctx, adapter } = await harness(
      c => new WindowEnforcingAdapter(c, 4000, 100, 0),
      { thresholdRatio: 0.8, retainTokens: 60, maxTokens: 2000, compactionRetries: 0, maxOverflowRetries: 0 },
      0,
    )
    adapter.summaryWords = 200
    try {
      const { agent } = await ctx.agentLoop.createAgent(ctx, {
        sessionId: SessionId('compact-twice'),
        seed: seedTurns(3, 70),
        agentOptions: { provider: 'mock', model: 'mock' },
      })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } }))
      await agent.whenIdle()
      expect(await ctx.compaction.compactNow(agent, new AbortController().signal)).not.toBeNull()
      const requests = adapter.summaryRequests.length
      expect(await ctx.compaction.compactNow(agent, new AbortController().signal)).toBeNull()
      expect(adapter.summaryRequests).toHaveLength(requests)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('retries a checkpoint that came back without text with a range about half the size', async () => {
    const { ctx, adapter } = await harness(
      c => new WindowEnforcingAdapter(c, 4000, 100, 0),
      { thresholdRatio: 0.8, retainTokens: 60, maxTokens: 64, compactionRetries: 0 },
      0,
    )
    const warnings: string[] = []
    ctx.logger.warn = ((message: string) => void warnings.push(message)) as typeof ctx.logger.warn
    try {
      const { agent } = await ctx.agentLoop.createAgent(ctx, {
        sessionId: SessionId('empty-then-halved'),
        seed: seedTurns(6, 70),
        agentOptions: { provider: 'mock', model: 'mock' },
      })
      // One routed request makes the window known, so /compact fits its range like an automatic compaction.
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } }))
      await agent.whenIdle()
      adapter.summaryEmptyAbove = 2000
      expect(await ctx.compaction.compactNow(agent, new AbortController().signal)).not.toBeNull()
      expect(warnings.some(message => message.includes('came back without text; retrying with a range about half the size'))).toBe(true)
      const sizes = adapter.summaryRequests.map(request => request.messages.length)
      expect(sizes.length).toBeGreaterThan(1)
      expect(sizes.at(-1)).toBeLessThan(sizes[0]!)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('halves the range when a refusal proves no more than the density already learned', async () => {
    // One short turn and a spurious refusal teach a density that leaves
    // nothing condensable, so the fit falls back to the meter's density; a
    // provider that then refuses everything of that size proves nothing new,
    // and the range is halved until the failure is reported.
    const { ctx, adapter } = await harness(
      c => new WindowEnforcingAdapter(c, 4000, 100, 0),
      { thresholdRatio: 0.8, retainTokens: 60, maxTokens: 64, compactionRetries: 0, maxOverflowRetries: 2 },
      0,
    )
    adapter.forcedOverflows = 1
    const warnings: string[] = []
    ctx.logger.warn = ((message: string) => void warnings.push(message)) as typeof ctx.logger.warn
    try {
      const { agent } = await ctx.agentLoop.createAgent(ctx, {
        sessionId: SessionId('halved-after-learning'),
        seed: seedTurns(1, 70),
        agentOptions: { provider: 'mock', model: 'mock' },
      })
      adapter.providerDensity = 10
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } }))
      await agent.whenIdle()
      expect(warnings.some(message => message.includes('retrying with a range about half the size'))).toBe(true)
      expect(agent.session.snapshotEvents().at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'error' } } })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('reports the provider refusal once three halved ranges are refused too', async () => {
    // A provider that counts every token tenfold refuses the whole surface and
    // each of the three halved ranges; the manual /compact reports the last refusal.
    const { ctx, adapter } = await harness(
      c => new WindowEnforcingAdapter(c, 2000, 100, 0),
      { thresholdRatio: 0.8, retainTokens: 60, maxTokens: 64, compactionRetries: 0, maxOverflowRetries: 0 },
      0,
    )
    try {
      const { agent } = await ctx.agentLoop.createAgent(ctx, {
        sessionId: SessionId('compact-shrink-exhausted'),
        seed: seedTurns(3, 70),
        agentOptions: { provider: 'mock', model: 'mock' },
      })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } }))
      await agent.whenIdle()
      adapter.providerDensity = 10
      await expect(ctx.compaction.compactNow(agent, new AbortController().signal))
        .rejects.toMatchObject({
          code: 'summary',
          cause: { code: CONTEXT_WINDOW_EXCEEDED_CODE },
          facts: { contextWindow: 2000, requestCap: 100, marginTokens: 100 },
        })
      expect(adapter.rejected.length).toBeGreaterThanOrEqual(2)
      expect(adapter.summaryRequests).toEqual([])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('condenses a smaller range when the provider refuses the overflow recovery summary as over its window', async () => {
    // Mid-turn, the provider refuses a request the harness thought fit. The
    // recovery's summarization request replays the fitting range, which the
    // denser provider refuses as well; the halved range lands and the turn completes.
    const { ctx, adapter } = await harness(
      c => new WindowEnforcingAdapter(c, 2000, 100, 0),
      { thresholdRatio: 0.8, retainTokens: 60, maxTokens: 64, compactionRetries: 0, maxOverflowRetries: 2 },
      0,
    )
    try {
      const { agent } = await ctx.agentLoop.createAgent(ctx, {
        sessionId: SessionId('recovery-shrink'),
        seed: seedTurns(5, 70),
        agentOptions: { provider: 'mock', model: 'mock' },
      })
      adapter.providerDensity = 1.5
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } }))
      await agent.whenIdle()

      expect(adapter.rejected.length).toBeGreaterThanOrEqual(2)
      expect(agent.session.snapshotEvents().some(event => event.type === 'compaction/summary')).toBe(true)
      expect(agent.session.snapshotEvents().at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('leaves the overflow summarizer room for its own output', async () => {
    // The provider rejects the first request as an overflow. Recovery replays
    // the surface (about 1100 tokens) plus the instruction: with the policy's
    // 800-token summary cap that would not fit a 2000 window, so the cap is
    // lowered to the room left and the whole history is condensed.
    const { ctx, adapter } = await harness(
      c => new WindowEnforcingAdapter(c, 2000, 100, 0),
      { thresholdRatio: 0.8, retainTokens: 60, maxTokens: 800, compactionRetries: 0, maxOverflowRetries: 2 },
      0,
    )
    adapter.forcedOverflows = 1
    try {
      const { agent } = await ctx.agentLoop.createAgent(ctx, {
        sessionId: SessionId('overflow-fit'),
        seed: seedTurns(3, 70),
        agentOptions: { provider: 'mock', model: 'mock' },
      })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } }))
      await agent.whenIdle()

      expect(adapter.rejected).toEqual([])
      expect(adapter.summaryRequests).toHaveLength(1)
      expect(adapter.conversationRequests).toHaveLength(2)
      const retry = JSON.stringify(adapter.conversationRequests[1]!.messages)
      expect(retry).toContain('CHECKPOINT SUMMARY')
      expect(retry).not.toContain('OLD TURN 1 ')
      expect(adapter.summaryRequests[0]!.maxTokens).toBeLessThan(800)
      expect(agent.session.snapshotEvents().at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('shrinks the output cap for the leftover margin when condensing cannot close the gap', async () => {
    // The summary always ends at its cap, so pressure compaction fails; the
    // request must still fit by lowering its output cap for this one step,
    // never below a quarter more than the reasoning the route has shown it spends.
    const { ctx, adapter } = await harness(
      c => new WindowEnforcingAdapter(c, 2000, 500, 1),
      { thresholdRatio: 0.8, retainTokens: 60, maxTokens: 64, compactionRetries: 0, maxOverflowRetries: 0, minOutputTokens: 64 },
      120,
    )
    adapter.summaryFinish = 'max-tokens'
    adapter.reasoningTokens = 160
    try {
      const { agent } = await ctx.agentLoop.createAgent(ctx, {
        sessionId: SessionId('clamp-cap'),
        seed: seedTurns(3, 70),
        agentOptions: { provider: 'mock', model: 'mock' },
      })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'read the file' }], source: { kind: 'user' } }))
      await agent.whenIdle()

      expect(adapter.rejected).toEqual([])
      const caps = adapter.conversationRequests.map(request => request.maxTokens)
      expect(caps[0]).toBe(500)
      expect(caps[1]).toBeGreaterThanOrEqual(200)
      expect(caps[1]).toBeLessThan(500)
      expect(agent.session.snapshotEvents().at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('logs no priced request for a request the user stopped while its route settled', async () => {
    const { ctx, adapter } = await harness(
      c => new WindowEnforcingAdapter(c, 2000, 500, 0),
      { thresholdRatio: 0.8, retainTokens: 60, maxTokens: 64 },
      0,
    )
    try {
      const { agent } = await ctx.agentLoop.createAgent(ctx, {
        sessionId: SessionId('stopped-while-routing'),
        agentOptions: { provider: 'mock', model: 'mock' },
      })
      // A later listener settles the route, and the user stops the turn meanwhile.
      ctx.on('agent/request', ({ agent: requesting }, next) => {
        requesting.cancel({ kind: 'user' })
        return next()
      })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }))
      await agent.whenIdle()

      const events = agent.session.snapshotEvents()
      expect(events.some(event => event.type === 'compaction/pressure')).toBe(false)
      expect(adapter.conversationRequests).toEqual([])
      expect(events.at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'aborted' } } })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('fails a turn on a model the provider no longer resolves without starting a failure backoff', async () => {
    // A session reopened in a new process routes to a model the server has
    // stopped listing: the step check and the request both fail on the
    // lookup, and the turn ends with that failure. Nothing was priced, so no
    // backoff starts, and once the model is back the next step condenses.
    const { ctx, adapter } = await harness(
      c => new WindowEnforcingAdapter(c, 2000, 100, 0),
      {
        thresholdRatio: 0.5, retainTokens: 60, maxTokens: 64, compactionRetries: 0, failureBackoffSteps: 20, failureBackoffGrowthRatio: 0.5,
      },
      0,
    )
    const warnings: string[] = []
    ctx.logger.warn = ((message: string) => void warnings.push(message)) as typeof ctx.logger.warn
    try {
      const { agent: earlier } = await ctx.agentLoop.createAgent(ctx, {
        sessionId: SessionId('retired-model-earlier'),
        seed: seedTurns(3, 70),
        agentOptions: { provider: 'mock', model: 'retired' },
      })
      earlier.followup(createUserMessage({ content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } }))
      await earlier.whenIdle()
      const { agent } = await ctx.agentLoop.createAgent(ctx, {
        sessionId: SessionId('retired-model-reopened'),
        seed: earlier.session.snapshotEvents(),
        agentOptions: { provider: 'mock', model: 'retired' },
      })
      const priced = agent.session.snapshotEvents().filter(event => event.type === 'compaction/pressure').length
      adapter.unresolvedModels.add('retired')
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } }))
      await agent.whenIdle()

      expect(agent.session.snapshotEvents().at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'error' } } })
      expect(warnings.some(message => message.startsWith('step compaction failed: model "retired" is not served'))).toBe(true)
      expect(agent.session.snapshotEvents().filter(event => event.type === 'compaction/pressure')).toHaveLength(priced)

      adapter.unresolvedModels.delete('retired')
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'continue again' }], source: { kind: 'user' } }))
      await agent.whenIdle()
      const events = agent.session.snapshotEvents()
      expect(events.filter(event => event.type === 'compaction/summary')).toHaveLength(1)
      expect(events.at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
      expect(adapter.rejected).toEqual([])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('condenses a reopened session through the summarization route when its own model no longer resolves', async () => {
    // The window of the conversation's model is unknown, so /compact takes
    // the whole surface at the policy cap. A refusal of that request is
    // reported as it is (there is no window to fit a smaller range to);
    // once the provider takes it, the checkpoint lands.
    const { ctx, adapter } = await harness(
      c => new WindowEnforcingAdapter(c, 2000, 100, 0),
      {
        thresholdRatio: 0.8, retainTokens: 60, maxTokens: 64, compactionRetries: 0, maxOverflowRetries: 0,
        summarizationProvider: 'mock', summarizationModel: 'summarizer',
      },
      0,
    )
    try {
      const { agent: earlier } = await ctx.agentLoop.createAgent(ctx, {
        sessionId: SessionId('summarizer-route-earlier'),
        seed: seedTurns(3, 70),
        agentOptions: { provider: 'mock', model: 'retired' },
      })
      earlier.followup(createUserMessage({ content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } }))
      await earlier.whenIdle()
      adapter.unresolvedModels.add('retired')
      const { agent } = await ctx.agentLoop.createAgent(ctx, {
        sessionId: SessionId('summarizer-route-reopened'),
        seed: earlier.session.snapshotEvents(),
        agentOptions: { provider: 'mock', model: 'retired' },
      })

      adapter.providerDensity = 3
      const refusal: unknown = await ctx.compaction.compactNow(agent, new AbortController().signal).catch((error: unknown) => error)
      expect(refusal).toMatchObject({ code: 'summary', cause: { code: CONTEXT_WINDOW_EXCEEDED_CODE }, facts: undefined })
      expect(adapter.rejected).toEqual([expect.objectContaining({ maxTokens: 64 })])

      adapter.providerDensity = 1
      expect(await ctx.compaction.compactNow(agent, new AbortController().signal)).not.toBeNull()
      expect(adapter.summaryRequests).toHaveLength(1)
      expect(adapter.summaryRequests[0]).toMatchObject({ model: 'summarizer', maxTokens: 64 })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('reports a summarization route the provider no longer resolves from the summary request itself', async () => {
    const { ctx, adapter } = await harness(
      c => new WindowEnforcingAdapter(c, 4000, 100, 0),
      {
        thresholdRatio: 0.8, retainTokens: 60, maxTokens: 64, compactionRetries: 0, maxOverflowRetries: 0,
        summarizationProvider: 'mock', summarizationModel: 'retired-summarizer',
      },
      0,
    )
    adapter.unresolvedModels.add('retired-summarizer')
    try {
      const { agent } = await ctx.agentLoop.createAgent(ctx, {
        sessionId: SessionId('retired-summarizer'),
        seed: seedTurns(3, 70),
        agentOptions: { provider: 'mock', model: 'mock' },
      })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } }))
      await agent.whenIdle()
      await expect(ctx.compaction.compactNow(agent, new AbortController().signal)).rejects.toMatchObject({
        code: 'summary',
        cause: { message: expect.stringContaining('model "retired-summarizer" is not served') as string },
      })
      expect(adapter.summaryRequests).toEqual([])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('keeps the provider\'s overflow error when a route that publishes no window has nothing to condense', async () => {
    const { ctx, adapter } = await harness(
      c => new WindowEnforcingAdapter(c, 2000, 100, 0),
      { thresholdRatio: 0.8, retainTokens: 60, maxTokens: 64, compactionRetries: 0, maxOverflowRetries: 2 },
      0,
    )
    adapter.publishesWindow = false
    adapter.forcedOverflows = 1
    try {
      const { agent } = await ctx.agentLoop.createAgent(ctx, {
        sessionId: SessionId('unlisted-first-request'),
        agentOptions: { provider: 'mock', model: 'mock' },
      })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }))
      await agent.whenIdle()

      const events = agent.session.snapshotEvents()
      expect(events.some(event => event.type === 'compaction/start')).toBe(false)
      expect(adapter.conversationRequests).toHaveLength(1)
      expect(events.at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'error' } } })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('prices a changed system prompt whole on a route that appends prompt updates to history', async () => {
    // Such a route sends the new prompt as a second system message instead of
    // rewriting the first, so the next request grows by all of it, not by
    // the difference.
    const { ctx, adapter } = await harness(
      c => new WindowEnforcingAdapter(c, 8000, 500, 0),
      { thresholdRatio: 0.8, retainTokens: 60, maxTokens: 64 },
      0,
    )
    adapter.appendsPromptUpdates = true
    const guidance = 'guidance '.repeat(300).trim()
    const retireFirstPrompt = ctx.systemPrompt.section({ name: 'in-history-first', order: 0, complete: true, text: guidance })
    try {
      const { agent } = await ctx.agentLoop.createAgent(ctx, {
        sessionId: SessionId('in-history-prompt'),
        agentOptions: { provider: 'mock', model: 'mock' },
      })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }))
      await agent.whenIdle()
      retireFirstPrompt()
      ctx.systemPrompt.section({ name: 'in-history-second', order: 0, complete: true, text: `${guidance} and one more rule` })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'again' }], source: { kind: 'user' } }))
      await agent.whenIdle()

      const events = agent.session.snapshotEvents()
      expect(events.at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
      expect(events.filter(event => event.type === 'system/message')).toHaveLength(2)
      const pressures = events.filter(event => event.type === 'compaction/pressure')
      expect(pressures).toHaveLength(2)
      const second = pressures[1]
      if (second?.type !== 'compaction/pressure') throw new Error('no priced second request')
      expect(second.data.pendingTokens).toBeGreaterThan(Math.ceil(guidance.length / 4))
      expect(adapter.rejected).toEqual([])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('halves a refused /compact on a reopened session when the refusal teaches no denser count', async () => {
    // One agent's refused summarization teaches the route's density. A second
    // agent on the same route, reopened with no window known yet, has its
    // whole surface refused; that larger request proves a lower bound than
    // the one learned, so the retry halves the range instead of refitting.
    const { ctx, adapter } = await harness(
      c => new WindowEnforcingAdapter(c, 2000, 100, 0),
      { thresholdRatio: 0.8, retainTokens: 60, maxTokens: 64, compactionRetries: 0, maxOverflowRetries: 0 },
      0,
    )
    const warnings: string[] = []
    ctx.logger.warn = ((message: string) => void warnings.push(message)) as typeof ctx.logger.warn
    const learned = (): number => warnings.filter(message => message.includes('counts at least')).length
    try {
      const { agent: teacher } = await ctx.agentLoop.createAgent(ctx, {
        sessionId: SessionId('density-teacher'),
        seed: seedTurns(3, 70),
        agentOptions: { provider: 'mock', model: 'mock' },
      })
      teacher.followup(createUserMessage({ content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } }))
      await teacher.whenIdle()
      const reopenedSeed = teacher.session.snapshotEvents()
      adapter.providerDensity = 1.5
      expect(await ctx.compaction.compactNow(teacher, new AbortController().signal)).not.toBeNull()
      const taught = learned()
      expect(taught).toBeGreaterThan(0)

      const { agent } = await ctx.agentLoop.createAgent(ctx, {
        sessionId: SessionId('density-reopened'),
        seed: reopenedSeed,
        agentOptions: { provider: 'mock', model: 'mock' },
      })
      const refused = adapter.rejected.length
      const halving = warnings.length
      expect(await ctx.compaction.compactNow(agent, new AbortController().signal)).not.toBeNull()
      expect(adapter.rejected.length).toBeGreaterThan(refused)
      expect(warnings.slice(halving).some(message => message.includes('retrying with a range about half the size'))).toBe(true)
      expect(learned()).toBe(taught)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
