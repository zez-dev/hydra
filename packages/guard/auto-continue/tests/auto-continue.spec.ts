import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, ReasoningEffortId, ToolCallId, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as AutoContinue from '@deepseek-ai/dsh-auto-continue'
import type { Config } from '@deepseek-ai/dsh-auto-continue'
import { MockAdapter, maxTokensResponse, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

async function harness(config: Config = { maxContinuationsPerTurn: 8 }): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(AutoContinue, config)
  return ctx
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

async function runTurn(ctx: Context, adapter: MockAdapter, text = 'go'): Promise<Agent> {
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await waitForIdle(ctx, agent)
  return agent
}

function events(agent: Agent, type: SessionEvent['type']): SessionEvent[] {
  return agent.session.snapshotEvents().filter(event => event.type === type)
}

function continuations(agent: Agent): { text: string; turn: number }[] {
  const found: { text: string; turn: number }[] = []
  let turn = 0
  for (const event of agent.session.snapshotEvents()) {
    if (event.type === 'turn/start') turn = event.data.turn
    if (event.type !== 'user/message') continue
    const source = event.data.source
    if (source.kind !== 'plugin' || source.plugin !== 'dsh-auto-continue') continue
    found.push({ text: event.data.content.map(block => block.type === 'text' ? block.text : '').join(''), turn })
  }
  return found
}

/** A mock route that offers reasoning efforts, the way a thinking model's adapter does. */
class ThinkingMockAdapter extends MockAdapter {
  constructor(responses: ConstructorParameters<typeof MockAdapter>[0], private readonly efforts: readonly string[]) {
    super(responses)
  }
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider, id: model, name: model,
      reasoning: { efforts: this.efforts.map(id => ({ id: ReasoningEffortId(id), name: id })) },
    })
  }
}

/** A mock route whose metadata lookup fails once, on the continuation's own lookup. */
class FlakyRouteAdapter extends MockAdapter {
  private lookups = 0
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    this.lookups += 1
    if (this.lookups === 2) return Promise.reject(new Error('route lookup failed'))
    return super.resolveModel(provider, model)
  }
}

/** An agent created with an explicit effort on a thinking route whose first reply is cut before its answer. */
async function chosenEffortSession(
  effort: string,
  responses = [maxTokensResponse('My'), textResponse('The answer.'), textResponse('The next answer.')],
  efforts: readonly string[] = ['high', 'low', 'minimal'],
  config: Config = { maxContinuationsPerTurn: 8 },
) {
  const ctx = await harness(config)
  const adapter = new ThinkingMockAdapter(responses, efforts)
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock', reasoningEffort: ReasoningEffortId(effort) })
  const turn = async (text: string): Promise<void> => {
    agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
  }
  return { ctx, adapter, agent, turn }
}

/** A reply cut at the output limit after some reasoning, ending in `tail` blocks. */
function cutAfterReasoning(tail: StreamChunk[]): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: 'Weighing the options at length.' },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'Weighing the options at length.' } },
    ...tail,
    { type: 'finish', reason: { kind: 'max-tokens' } },
  ]
}

/** A cut answer long enough to count as progress the continuation can extend. */
const LONG_PART = 'Part one of the answer explains the first of the three steps in enough detail to be worth continuing from.'

describe('auto-continue', () => {
  it('continues once, asking for an answer, when the cut reply is a few words, then stops', async () => {
    const ctx = await harness()
    const adapter = new MockAdapter([maxTokensResponse('My'), maxTokensResponse('So'), textResponse('never requested')])
    const agent = await runTurn(ctx, adapter)
    expect(adapter.requests).toHaveLength(2)
    expect(continuations(agent)).toEqual([{ text: AutoContinue.REASONING_CONTINUATION_TEXT, turn: 1 }])
    expect(events(agent, 'turn/end')).toHaveLength(1)
  })

  it('asks the route for its lowest reasoning effort on a reasoning continuation only', async () => {
    const ctx = await harness()
    const adapter = new ThinkingMockAdapter([maxTokensResponse('My'), textResponse('The answer.')], ['high', 'low', 'minimal'])
    const agent = await runTurn(ctx, adapter)
    expect(adapter.requests.map(request => request.reasoningEffort)).toEqual([undefined, 'minimal'])
    // The lowered effort is a call setting, so the continuation's logged request header carries it.
    expect(JSON.stringify(events(agent, 'request/header').at(-1))).toContain('"reasoningEffort":"minimal"')
  })

  it('puts the adapter default back on the request after a reasoning continuation', async () => {
    const ctx = await harness()
    const adapter = new ThinkingMockAdapter(
      [maxTokensResponse('My'), textResponse('The answer.'), textResponse('The next answer.')],
      ['high', 'low', 'minimal'],
    )
    const agent = await runTurn(ctx, adapter)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'next' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    expect(adapter.requests.map(request => request.reasoningEffort)).toEqual([undefined, 'minimal', undefined])
  })

  it('puts a chosen effort back on the request after a reasoning continuation', async () => {
    const { adapter, turn } = await chosenEffortSession('high')
    await turn('go')
    await turn('next')
    expect(adapter.requests.map(request => request.reasoningEffort)).toEqual(['high', 'minimal', 'high'])
  })

  it('keeps a choice made after a reasoning continuation instead of putting the old one back', async () => {
    const { ctx, adapter, turn } = await chosenEffortSession('high')
    await turn('go')
    // The newer choice reaches the chain inside auto-continue's listener, as a picker's selection does.
    ctx.on('agent/request', async (_payload, next) => ({ ...await next(), reasoningEffort: ReasoningEffortId('low') }))
    await turn('next')
    expect(adapter.requests.map(request => request.reasoningEffort)).toEqual(['high', 'minimal', 'low'])
  })

  it('puts back the effort the first lowering replaced after two reasoning continuations in a row', async () => {
    const { adapter, turn } = await chosenEffortSession(
      'high',
      [maxTokensResponse('My'), maxTokensResponse('So'), textResponse('The answer.'), textResponse('The next answer.')],
      ['high', 'low', 'minimal'],
      { maxContinuationsPerTurn: 8, maxReasoningContinuationsPerTurn: 2 },
    )
    await turn('go')
    await turn('next')
    expect(adapter.requests.map(request => request.reasoningEffort)).toEqual(['high', 'minimal', 'minimal', 'high'])
  })

  it('keeps the effort on a route that offers no low setting', async () => {
    const { adapter, turn } = await chosenEffortSession('high', undefined, ['high', 'max'])
    await turn('go')
    await turn('next')
    expect(adapter.requests.map(request => request.reasoningEffort)).toEqual(['high', 'high', 'high'])
  })

  it('keeps the effort to put back when the request that would put it back is cancelled', async () => {
    const { ctx, adapter, agent, turn } = await chosenEffortSession('high')
    await turn('go')
    let cancel = true
    ctx.on('agent/request', async (_payload, next) => {
      const resolved = await next()
      if (cancel) {
        cancel = false
        agent.cancel({ kind: 'user' })
      }
      return resolved
    })
    await turn('next')
    await turn('again')
    expect(adapter.requests.map(request => request.reasoningEffort)).toEqual(['high', 'minimal', 'high'])
  })

  it('counts only answer text, not reasoning, toward a cut reply\'s visible length', async () => {
    const ctx = await harness()
    const adapter = new MockAdapter([
      cutAfterReasoning([
        { type: 'block-start', index: 1, blockType: 'text' },
        { type: 'text-delta', index: 1, text: 'My' },
        { type: 'block-end', index: 1, block: { type: 'text', text: 'My' } },
      ]),
      textResponse('The answer.'),
    ])
    const agent = await runTurn(ctx, adapter)
    expect(continuations(agent)).toEqual([{ text: AutoContinue.REASONING_CONTINUATION_TEXT, turn: 1 }])
  })

  it('treats a reply cut during a tool call as cut before its answer, since the cut drops the call', async () => {
    const ctx = await harness()
    const adapter = new MockAdapter([
      cutAfterReasoning([
        { type: 'block-start', index: 1, blockType: 'tool-call' },
        { type: 'tool-call-delta', index: 1, id: ToolCallId('cut-call'), name: 'lookup', argumentsDelta: '{}' },
        { type: 'block-end', index: 1, block: { type: 'tool-call', id: ToolCallId('cut-call'), name: 'lookup', arguments: '{}' } },
      ]),
      textResponse('The answer.'),
    ])
    const agent = await runTurn(ctx, adapter)
    expect(events(agent, 'tool/call')).toEqual([])
    expect(continuations(agent)).toEqual([{ text: AutoContinue.REASONING_CONTINUATION_TEXT, turn: 1 }])
  })

  it('steers nothing when the turn is cancelled as it stops', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    // Registered first, so it cancels before the guard's listener runs.
    ctx.on('agent/turn-stopping', ({ agent }) => { agent.cancel({ kind: 'user' }) })
    await ctx.plugin(AutoContinue, { maxContinuationsPerTurn: 8 })
    const adapter = new MockAdapter([maxTokensResponse(LONG_PART), textResponse('never requested')])
    const agent = await runTurn(ctx, adapter)
    expect(adapter.requests).toHaveLength(1)
    expect(continuations(agent)).toEqual([])
  })

  it('keeps the configured effort when the route cannot be resolved for the continuation', async () => {
    const ctx = await harness()
    const adapter = new FlakyRouteAdapter([maxTokensResponse('My'), textResponse('The answer.')])
    const agent = await runTurn(ctx, adapter)
    expect(adapter.requests.map(request => request.reasoningEffort)).toEqual([undefined, undefined])
    expect(continuations(agent)).toEqual([{ text: AutoContinue.REASONING_CONTINUATION_TEXT, turn: 1 }])
    // Disposal drops the agent's bookkeeping; a later agent under the same id starts clean.
    await ctx.parallel('agent/disposed', { agent })
  })

  it('stops a reply cut before its answer at once when maxReasoningContinuationsPerTurn is 0', async () => {
    const ctx = await harness({ maxContinuationsPerTurn: 8, maxReasoningContinuationsPerTurn: 0 })
    const adapter = new MockAdapter([maxTokensResponse('My'), textResponse('never requested')])
    const agent = await runTurn(ctx, adapter)
    expect(adapter.requests).toHaveLength(1)
    expect(continuations(agent)).toEqual([])
  })

  it('steers one continuation when a step stops at the output-token limit', async () => {
    const ctx = await harness()
    const adapter = new MockAdapter([maxTokensResponse(LONG_PART), textResponse('part two')])
    const agent = await runTurn(ctx, adapter)
    expect(adapter.requests).toHaveLength(2)
    expect(events(agent, 'assistant/message')).toHaveLength(2)
    const [continuation] = continuations(agent)
    expect(continuation).toMatchObject({ turn: 1 })
    expect(continuation!.text).toContain('Continue exactly where you stopped')
    expect(events(agent, 'turn/end')).toHaveLength(1)
  })

  it('stops after maxContinuationsPerTurn continuations', async () => {
    const ctx = await harness({ maxContinuationsPerTurn: 1 })
    const adapter = new MockAdapter([maxTokensResponse(`${LONG_PART} one`), maxTokensResponse(`${LONG_PART} two`), maxTokensResponse(`${LONG_PART} three`)])
    const agent = await runTurn(ctx, adapter)
    expect(adapter.requests).toHaveLength(2)
    expect(continuations(agent)).toHaveLength(1)
  })

  it('does not continue a completed step', async () => {
    const ctx = await harness()
    const adapter = new MockAdapter([textResponse('done')])
    const agent = await runTurn(ctx, adapter)
    expect(adapter.requests).toHaveLength(1)
    expect(continuations(agent)).toHaveLength(0)
  })

  it('does not continue when the truncated message carried no content', async () => {
    const ctx = await harness()
    const adapter = new MockAdapter([maxTokensResponse('   ')])
    const agent = await runTurn(ctx, adapter)
    expect(adapter.requests).toHaveLength(1)
    expect(continuations(agent)).toHaveLength(0)
  })

  it('counts continuations per turn', async () => {
    const ctx = await harness({ maxContinuationsPerTurn: 1 })
    const adapter = new MockAdapter([
      maxTokensResponse(`${LONG_PART} a`), textResponse('a done'),
      maxTokensResponse(`${LONG_PART} b`), textResponse('b done'),
    ])
    const agent = await runTurn(ctx, adapter)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'again' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    expect(adapter.requests).toHaveLength(4)
    expect(continuations(agent).map(entry => entry.turn)).toEqual([1, 2])
  })

  it('rejects a configuration without maxContinuationsPerTurn', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await expect(ctx.plugin(AutoContinue, {} as Config)).rejects.toThrow(/maxContinuationsPerTurn/)
  })
})
