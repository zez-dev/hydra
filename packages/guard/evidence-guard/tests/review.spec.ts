/**
 * The end-of-turn evidence review through the production agent loop: a
 * scripted model calls tools whose results carry the meta real tools persist,
 * and each review is read back from the session log and the next request.
 * The listener state checks drive the plugin's events directly.
 */
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, ToolCallId, type StreamChunk, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { defineTool } from '@deepseek-ai/dsh-tools'
import * as Review from '../src/review.ts'
import { renderReview } from '../src/findings.ts'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

/** Line counts of the files the test `read` tool serves; any other path fails. */
const FILES: Readonly<Record<string, number>> = { 'big.md': 100, 'small.md': 10 }

/** Register `read`, `edit`, `write`, `bash`, and a turn-concluding `finish`, each persisting the meta its real counterpart does. */
function registerTools(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'read',
    description: 'Read a file.',
    parameters: {
      file_path: { type: 'string', required: true },
      offset: { type: 'number' },
      limit: { type: 'number' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          offset: { type: 'integer', required: true },
          lines: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: { number: { type: 'integer', required: true }, text: { type: 'string', required: true } },
            },
          },
          totalLines: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.lines.map(line => `${line.number}: ${line.text}`).join('\n') }],
      presentationMeta: (_args, value) => ({
        path: value.path,
        offset: value.offset,
        lines: value.lines.map(({ number, text }) => ({ number, text })),
        totalLines: value.totalLines,
      }),
    },
    execute(args) {
      const totalLines = FILES[args.file_path]
      if (totalLines === undefined) return Promise.reject(new Error(`${args.file_path} does not exist`))
      const offset = args.offset ?? 1
      const last = Math.min(totalLines, offset + (args.limit ?? totalLines) - 1)
      const lines = Array.from({ length: Math.max(0, last - offset + 1) }, (_, index) => ({ number: offset + index, text: 'x' }))
      return Promise.resolve({ path: args.file_path, offset, lines, totalLines })
    },
  }))
  for (const [name, whole] of [['edit', false], ['write', true]] as const) {
    ctx.tools.register(defineTool({
      name,
      description: `${name} a file.`,
      parameters: { file_path: { type: 'string', required: true } },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { path: { type: 'string', required: true } } },
        render: () => [{ type: 'text', text: 'changed' }],
        presentationMeta: (_args, value) => whole ? { operation: 'create', path: value.path, diffs: [] } : { path: value.path, diffs: [] },
      },
      execute: args => Promise.resolve({ path: args.file_path }),
    }))
  }
  ctx.tools.register(defineTool({
    name: 'bash',
    description: 'Run a command.',
    parameters: { command: { type: 'string', required: true } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { exitCode: { type: 'integer', required: true } } },
      render: () => [{ type: 'text', text: 'exit 0' }],
    },
    execute: () => Promise.resolve({ exitCode: 0 }),
  }))
  ctx.tools.register(defineTool({
    name: 'finish',
    description: 'Finish the turn.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { done: { type: 'boolean', required: true } } },
      render: () => [{ type: 'text', text: 'done' }],
    },
    execute: (_args, exec) => {
      exec.concludeTurn()
      return Promise.resolve({ done: true })
    },
  }))
}

async function harness(config: Review.Config = {}, before?: (ctx: Context) => void): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  registerTools(ctx)
  before?.(ctx)
  await ctx.plugin(Review, config)
  return ctx
}

async function runTurn(ctx: Context, responses: StreamChunk[][]): Promise<{ agent: Agent; adapter: MockAdapter }> {
  const adapter = new MockAdapter(responses)
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await ctx.agentLoop.create(SessionId('review'), { provider: 'mock', model: 'mock' })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  return { agent, adapter }
}

function textOf(message: { content: readonly { type: string; text?: string }[] }): string {
  return message.content.map(block => block.type === 'text' ? block.text : '').join('')
}

/** Review requests in the session log, in order. */
function reviews(agent: Agent): string[] {
  return agent.session.snapshotEvents().flatMap(event =>
    event.type === 'user/message' && event.data.source.kind === Review.REVIEW_SOURCE_KIND ? [textOf(event.data)] : [])
}

/** One tool call whose arguments are not valid JSON. */
function malformedCall(rawCallId: string, name: string, argumentsJson: string): StreamChunk[] {
  const id = ToolCallId(rawCallId)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: argumentsJson },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: argumentsJson } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

describe('evidence review in the agent loop', () => {
  it('steers one review into a turn with many tool calls, and the reviewed answer ends the turn', async () => {
    const { agent, adapter } = await runTurn(await harness({ reviewAfterToolCalls: 2 }), [
      toolCallResponse('c1', 'read', { file_path: 'small.md' }),
      toolCallResponse('c2', 'read', { file_path: 'small.md' }),
      textResponse('first answer'),
      textResponse('reviewed answer'),
    ])
    const expected = renderReview({ partialReads: [], uncheckedChanges: [], toolCalls: 2 })
    expect(reviews(agent)).toEqual([expected])
    expect(adapter.requests).toHaveLength(4)
    expect(textOf(adapter.requests[3]!.messages.at(-1)!)).toContain(expected)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'turn/start')).toHaveLength(1)
  })

  it('names a file read only in part, with the lines it read', async () => {
    const { agent } = await runTurn(await harness(), [
      toolCallResponse('c1', 'read', { file_path: 'big.md', limit: 10 }),
      textResponse('answer'),
      textResponse('reviewed answer'),
    ])
    expect(reviews(agent)).toEqual([renderReview({
      partialReads: [{ path: 'big.md', read: [[1, 10]], totalLines: 100, unread: 90 }],
      uncheckedChanges: [],
      toolCalls: 1,
    })])
  })

  it('asks for a check after a change, and stays quiet once a check ran after the last change', async () => {
    const unchecked = await runTurn(await harness(), [
      toolCallResponse('c1', 'edit', { file_path: 'a.ts' }),
      toolCallResponse('c2', 'bash', { command: 'ls -la' }),
      textResponse('done'),
      textResponse('reviewed'),
    ])
    expect(reviews(unchecked.agent)).toEqual([renderReview({ partialReads: [], uncheckedChanges: ['a.ts'], toolCalls: 2 })])

    const checked = await runTurn(await harness(), [
      toolCallResponse('c1', 'write', { file_path: 'b.ts' }),
      toolCallResponse('c2', 'bash', { command: 'pnpm test' }),
      textResponse('done'),
    ])
    expect(reviews(checked.agent)).toEqual([])
    expect(checked.adapter.requests).toHaveLength(3)
  })

  it('takes no evidence from a failed call or from a command with malformed arguments', async () => {
    const { agent } = await runTurn(await harness(), [
      toolCallResponse('c1', 'read', { file_path: 'missing.md', limit: 1 }),
      toolCallResponse('c2', 'edit', { file_path: 'a.ts' }),
      malformedCall('c3', 'bash', '{"command": "pnpm test"'),
      textResponse('done'),
      textResponse('reviewed'),
    ])
    expect(reviews(agent)).toEqual([renderReview({ partialReads: [], uncheckedChanges: ['a.ts'], toolCalls: 3 })])
  })

  it('leaves alone a turn a tool concluded', async () => {
    const { agent, adapter } = await runTurn(await harness({ reviewAfterToolCalls: 1 }), [
      toolCallResponse('c1', 'finish', {}),
    ])
    expect(reviews(agent)).toEqual([])
    expect(adapter.requests).toHaveLength(1)
  })

  it('waits while another listener continues the turn, then reviews at the next stop', async () => {
    let continued = false
    const ctx = await harness({ reviewAfterToolCalls: 1 }, (root) => {
      root.on('agent/turn-stopping', ({ agent }) => {
        if (continued) return
        continued = true
        agent.steer(createUserMessage({ content: [{ type: 'text', text: 'one more thing' }], source: { kind: 'user' } }))
      })
    })
    const { agent, adapter } = await runTurn(ctx, [
      toolCallResponse('c1', 'read', { file_path: 'small.md' }),
      textResponse('first'),
      textResponse('second'),
      textResponse('reviewed'),
    ])
    expect(reviews(agent)).toHaveLength(1)
    expect(adapter.requests).toHaveLength(4)
  })

  it.each([
    ['a subagent session', { origin: 'subagent' as const, delegationDepth: 1 }],
    ['a delegated session', { delegationDepth: 1 }],
  ])('never reviews %s', async (_case, meta) => {
    const ctx = await harness({ reviewAfterToolCalls: 1 })
    const adapter = new MockAdapter([toolCallResponse('c1', 'read', { file_path: 'small.md' }), textResponse('answer')])
    ctx.llm.registerAdapter(['mock'], adapter)
    const handle = await ctx.agentLoop.createAgent(ctx, { sessionId: SessionId('child'), meta, agentOptions: { provider: 'mock', model: 'mock' } })
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await handle.agent.whenIdle()
    expect(reviews(handle.agent)).toEqual([])
    expect(adapter.requests).toHaveLength(2)
    await handle.dispose()
  })

  it('rejects a check pattern that is not a regular expression at load', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await expect(ctx.plugin(Review, { checkCommandPatterns: ['('] }))
      .rejects.toThrow('evidence-review: checkCommandPatterns entry "(" is not a valid regular expression')
  })
})

describe('evidence review listener state', () => {
  /** A session and its agent as the listeners see them; the plugin keys both by the session id. */
  function fakeAgent() {
    const steer = vi.fn<(message: UserMessage) => void>()
    const session = { id: SessionId('fake'), header: {} }
    return { agent: { id: session.id, session, inbox: { nextStep: [] }, steer }, session, steer }
  }

  async function bareContext(config: Review.Config): Promise<Context> {
    const ctx = new Context()
    ctx.provide('agents', {} as never)
    await ctx.plugin(Review, config)
    return ctx
  }

  function logged(ctx: Context, session: object, event: object): void {
    ctx.emit('session/event', session as never, event as never)
  }

  function stop(ctx: Context, agent: object, turn: number, signal = new AbortController().signal): Promise<void> {
    return ctx.serial('agent/turn-stopping', { agent: agent as never, turn, signal })
  }

  it('counts sub-calls a program dispatched and folds only the read windows and changed paths their meta names', async () => {
    const { agent, session, steer } = fakeAgent()
    const ctx = await bareContext({ reviewAfterToolCalls: 5 })
    logged(ctx, session, { type: 'turn/start', data: { turn: 1 } })
    logged(ctx, session, { type: 'tool/ptc-dispatch', data: { name: 'read', arguments: { file_path: 'big.md' }, isError: false, meta: { path: 'big.md', offset: 1, lines: [{ number: 1, text: 'x' }], totalLines: 50 } } })
    logged(ctx, session, { type: 'tool/ptc-dispatch', data: { name: 'read', arguments: {}, isError: true } })
    // A read past the end of a file returns no lines, and an edit result without a path names no file.
    logged(ctx, session, { type: 'tool/ptc-dispatch', data: { name: 'read', arguments: { file_path: 'small.md', offset: 20 }, isError: false, meta: { path: 'small.md', offset: 20, lines: [], totalLines: 10 } } })
    logged(ctx, session, { type: 'tool/ptc-dispatch', data: { name: 'edit', arguments: {}, isError: false } })
    await stop(ctx, agent, 1)
    expect(steer).toHaveBeenCalledOnce()
    expect(textOf(steer.mock.calls[0]![0])).toBe(renderReview({
      partialReads: [{ path: 'big.md', read: [[1, 1]], totalLines: 50, unread: 49 }],
      uncheckedChanges: [],
      toolCalls: 4,
    }))
  })

  it.each([
    ['an aborted stop', 1, true],
    ['a stop for another turn', 2, false],
  ])('ignores %s', async (_case, turn, aborted) => {
    const { agent, session, steer } = fakeAgent()
    const ctx = await bareContext({ reviewAfterToolCalls: 1 })
    logged(ctx, session, { type: 'turn/start', data: { turn: 1 } })
    logged(ctx, session, { type: 'tool/call', data: { callId: ToolCallId('c1'), name: 'bash', arguments: '{"command":"ls"}' } })
    const controller = new AbortController()
    if (aborted) controller.abort()
    await stop(ctx, agent, turn, controller.signal)
    expect(steer).not.toHaveBeenCalled()
  })

  it('ignores activity of an agent before its first turn, and forgets a disposed agent', async () => {
    const { agent, session, steer } = fakeAgent()
    const ctx = await bareContext({ reviewAfterToolCalls: 1 })
    logged(ctx, session, { type: 'tool/call', data: { callId: ToolCallId('c0'), name: 'bash', arguments: '{}' } })
    ctx.emit('tools/result', {} as never, { concludesTurn: true } as never)
    ctx.emit('tools/result', { agent } as never, { concludesTurn: true } as never)
    await stop(ctx, agent, 1)
    logged(ctx, session, { type: 'turn/start', data: { turn: 1 } })
    logged(ctx, session, { type: 'tool/call', data: { callId: ToolCallId('c1'), name: 'bash', arguments: '{}' } })
    ctx.emit('agent/disposed', { agent: agent as never })
    await stop(ctx, agent, 1)
    expect(steer).not.toHaveBeenCalled()
  })
})
