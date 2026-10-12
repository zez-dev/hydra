import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import GoalService from '@deepseek-ai/dsh-goal'
import type { GoalView } from '@deepseek-ai/dsh-goal'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as driver from '../src/index.ts'

type ScriptEntry = StreamChunk[] | Error | 'hang'

class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly script: ScriptEntry[]) {
    super()
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const entry = this.script.shift()
    if (entry === undefined) throw new Error('ScriptedAdapter: script exhausted')
    if (entry instanceof Error) throw entry
    if (entry === 'hang') {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      await new Promise<void>((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
      })
      return
    }
    for (const chunk of entry) yield chunk
  }
}

function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function maxTokensResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'max-tokens' } },
  ]
}

const contexts: Context[] = []

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(context => context.fiber.dispose()))
})

async function harness(script: ScriptEntry[], config: driver.Config) {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(GoalService)
  const driverFiber = await ctx.plugin(driver, config)
  await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new ScriptedAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent: Agent = await ctx.agentLoop.create(SessionId(`goal-retry-${Math.random()}`), { provider: 'mock', model: 'mock' })
  return { ctx, adapter, agent, driverFiber }
}

async function waitForGoal(ctx: Context, agent: Agent, predicate: (goal: GoalView | undefined) => boolean): Promise<GoalView | undefined> {
  await vi.waitFor(() => { expect(predicate(ctx.goals.get(agent))).toBe(true) }, { timeout: 5000 })
  return ctx.goals.get(agent)
}

// Goals are capped so the scripted adapter is never asked for more than the
// script holds; the cap surfaces as a `round-limit` blocker once every round ran.
const retry: driver.Config = { transientRetry: { delayMs: 20, maxConsecutive: 2 } }

describe('transient retry', () => {
  it('re-arms after a failed round and runs the next round after the delay', async () => {
    const test = await harness([new Error('ECONNRESET'), textResponse('recovered')], retry)
    test.ctx.goals.create(test.agent, { objective: 'survive a cut', maxGoalRounds: 2 })

    const goal = await waitForGoal(test.ctx, test.agent, current => current?.phase === 'blocked')
    expect(goal).toMatchObject({ roundsStarted: 2, blockedReason: { code: 'round-limit' } })
    expect(test.adapter.requests).toHaveLength(2)
  })

  it('treats a max-tokens end as transient when retry is configured', async () => {
    const test = await harness([maxTokensResponse('cut off'), textResponse('done now')], retry)
    test.ctx.goals.create(test.agent, { objective: 'finish despite output limits', maxGoalRounds: 2 })

    const goal = await waitForGoal(test.ctx, test.agent, current => current?.phase === 'blocked')
    expect(goal).toMatchObject({ roundsStarted: 2, blockedReason: { code: 'round-limit' } })
    expect(test.adapter.requests).toHaveLength(2)
  })

  it('blocks with transient-retries-exhausted after maxConsecutive failures, and /goal resume continues', async () => {
    const test = await harness([
      new Error('cut 1'), new Error('cut 2'), new Error('cut 3'), textResponse('back'),
    ], retry)
    test.ctx.goals.create(test.agent, { objective: 'exhaust then resume', maxGoalRounds: 4 })

    const blocked = await waitForGoal(test.ctx, test.agent, current => current?.phase === 'blocked')
    expect(blocked?.blockedReason).toMatchObject({ code: driver.TRANSIENT_RETRIES_EXHAUSTED })
    expect(blocked).toMatchObject({ roundsStarted: 3 })
    expect(test.adapter.requests).toHaveLength(3)

    test.ctx.goals.resume(test.agent, { id: blocked!.id, revision: blocked!.revision })
    const limited = await waitForGoal(test.ctx, test.agent, current => current?.blockedReason?.code === 'round-limit')
    expect(limited).toMatchObject({ roundsStarted: 4 })
    expect(test.adapter.requests).toHaveLength(4)
  })

  it('resets the consecutive-failure count after a successful round', async () => {
    // With maxConsecutive 1 the second failure would block unless the
    // successful round in between reset the count.
    const test = await harness([
      new Error('cut 1'), textResponse('ok'), new Error('cut 2'), textResponse('ok again'),
    ], { transientRetry: { delayMs: 20, maxConsecutive: 1 } })
    test.ctx.goals.create(test.agent, { objective: 'intermittent network', maxGoalRounds: 4 })

    const goal = await waitForGoal(test.ctx, test.agent, current => current?.phase === 'blocked')
    expect(goal).toMatchObject({ roundsStarted: 4, blockedReason: { code: 'round-limit' } })
    expect(test.adapter.requests).toHaveLength(4)
  })

  it('still pauses on a user cancellation instead of retrying', async () => {
    const test = await harness(['hang', textResponse('never')], retry)
    test.ctx.goals.create(test.agent, { objective: 'respect the human' })
    await vi.waitFor(() => { expect(test.adapter.requests).toHaveLength(1) })
    test.agent.cancel({ kind: 'user' })

    const goal = await waitForGoal(test.ctx, test.agent, current => current?.phase === 'paused')
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(goal?.phase).toBe('paused')
    expect(test.adapter.requests).toHaveLength(1)
  })

  it('drops a pending re-arm when the agent is disposed', async () => {
    const test = await harness([new Error('cut'), textResponse('never')], { transientRetry: { delayMs: 100, maxConsecutive: 2 } })
    test.ctx.goals.create(test.agent, { objective: 'gone before the retry', maxGoalRounds: 2 })
    await vi.waitFor(() => { expect(test.adapter.requests).toHaveLength(1) })
    await test.agent.whenIdle()
    await test.ctx.parallel('agent/disposed', { agent: test.agent })
    // A repeated disposal notice finds nothing left to clear.
    await test.ctx.parallel('agent/disposed', { agent: test.agent })
    await new Promise(resolve => setTimeout(resolve, 250))
    expect(test.adapter.requests).toHaveLength(1)
  })

  it('drops a pending re-arm when the driver is unloaded', async () => {
    const test = await harness([new Error('cut'), textResponse('never')], { transientRetry: { delayMs: 100, maxConsecutive: 2 } })
    test.ctx.goals.create(test.agent, { objective: 'driver gone before the retry', maxGoalRounds: 2 })
    await vi.waitFor(() => { expect(test.adapter.requests).toHaveLength(1) })
    await test.agent.whenIdle()
    await test.driverFiber.dispose()
    await new Promise(resolve => setTimeout(resolve, 250))
    expect(test.adapter.requests).toHaveLength(1)
  })

  it('does not count a failure that arrives after the goal was paused', async () => {
    const test = await harness(['hang', textResponse('never')], { transientRetry: { delayMs: 20, maxConsecutive: 1 } })
    const created = test.ctx.goals.create(test.agent, { objective: 'paused mid-round' })
    await vi.waitFor(() => { expect(test.adapter.requests).toHaveLength(1) })
    test.ctx.goals.pause(test.agent, { id: created.id, revision: test.ctx.goals.get(test.agent)!.revision })
    test.ctx.emit('agent/error', { agent: test.agent, turn: 1, step: 1, error: new Error('late failure') })
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(test.ctx.goals.get(test.agent)).toMatchObject({ phase: 'paused' })
    expect(test.adapter.requests).toHaveLength(1)
    test.agent.cancel({ kind: 'user' })
  })

  it('disarms the goal and warns when blocking after exhausted retries fails', async () => {
    const test = await harness([new Error('cut 1'), new Error('cut 2')], { transientRetry: { delayMs: 20, maxConsecutive: 1 } })
    vi.spyOn(test.ctx.goals, 'block').mockImplementation(() => { throw new Error('goal store unavailable') })
    const warn = vi.spyOn(test.ctx.logger, 'warn').mockImplementation(() => test.ctx.logger)
    test.ctx.goals.create(test.agent, { objective: 'cannot block', maxGoalRounds: 3 })
    const goal = await waitForGoal(test.ctx, test.agent, current => current?.activation === 'disarmed')
    expect(goal?.phase).toBe('active')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not block agent'))
    expect(test.adapter.requests).toHaveLength(2)
  })

  it('rejects a partial transientRetry config', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(GoalService)
    await expect(ctx.plugin(driver, { transientRetry: { delayMs: 10 } } as never)).rejects.toThrow()
  })
})
