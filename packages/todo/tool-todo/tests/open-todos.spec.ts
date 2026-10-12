import { createUserMessage, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as ToolTodo from '@deepseek-ai/dsh-tool-todo'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

/**
 * Open tasks through the real agent loop: only the model is scripted. A turn
 * that ends with open tasks it wrote is asked once to continue or update the
 * list, and open tasks the model can no longer act on (after an error turn)
 * come back as a task-state message on the next request.
 */
async function harness(adapter: MockAdapter, config: Partial<ToolTodo.Config> = {}): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(ToolTodo, { allowParallelInProgress: true, ...config })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

function requestText(request: GenerateOptions | undefined): string {
  return (request?.messages ?? [])
    .flatMap(message => message.content.map(block => (block.type === 'text' ? block.text : '')))
    .join('\n')
}

const OPEN = {
  todos: [
    { content: 'read the code', status: 'completed' },
    { content: 'write the fix', status: 'in_progress' },
    { content: 'run the tests', status: 'pending' },
  ],
}

const authError: StreamChunk[] = [
  { type: 'finish', reason: { kind: 'error', failure: { code: 'AUTH', message: 'simulated provider error (HTTP 401)' } } },
]

describe('open tasks through the agent loop', () => {
  it('stops with a plan by default: no extra request when a turn ends with open tasks', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('call-1', 'todo_write', OPEN),
      textResponse('Planned; tell me when to start.'),
    ])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('todo-plan-only'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'plan the fix, do not start' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(2)
  })

  it('asks once to continue or update the list when configured and a turn it planned ends with open tasks', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('call-1', 'todo_write', OPEN),
      textResponse('I have started.'),
      textResponse('Still going.'),
    ])
    const ctx = await harness(adapter, { maxOpenTodoContinuationsPerTurn: 1 })
    const agent = await ctx.agentLoop.create(SessionId('todo-open-turn'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'fix the bug' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(3)
    const nudge = requestText(adapter.requests[2])
    expect(nudge).toContain('write the fix')
    expect(nudge).toContain('run the tests')
    expect(nudge).not.toMatch(/- \[completed\] read the code/)
    expect(agent.session.snapshotEvents().at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
  })

  it('brings open tasks back on the next request after a turn that ended in an error', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('call-1', 'todo_write', OPEN),
      authError,
      textResponse('Resuming.'),
    ])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('todo-after-error'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'fix the bug' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(agent.session.snapshotEvents().at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'error' } } })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'the connection is back' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    const resumed = requestText(adapter.requests.at(-1))
    expect(resumed).toContain('[in_progress] write the fix')
    expect(resumed).toContain('[pending] run the tests')
  })

  it('leaves an older list alone when a later turn moves on without touching it', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('call-1', 'todo_write', OPEN),
      textResponse('Paused.'),
      textResponse('Paused again.'),
      textResponse('A haiku.'),
    ])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('todo-older-list'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'fix the bug' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    const before = adapter.requests.length

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'write a haiku' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    // One request for the haiku turn: no continuation nudge, no reminder message.
    expect(adapter.requests.length).toBe(before + 1)
    const last = adapter.requests.at(-1)!
    const tail = last.messages.at(-1)
    expect(tail?.content).toEqual([{ type: 'text', text: 'write a haiku' }])
  })

  it('brings nothing back when reminders are switched off', async () => {
    const adapter = new MockAdapter([toolCallResponse('call-1', 'todo_write', OPEN), authError, textResponse('Resuming.')])
    const ctx = await harness(adapter, { remindOpenTodos: false })
    const agent = await ctx.agentLoop.create(SessionId('todo-no-reminder'), { provider: 'mock', model: 'mock' })
    for (const text of ['fix the bug', 'the connection is back']) {
      agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
      await agent.whenIdle()
    }
    expect(requestText(adapter.requests.at(-1))).not.toContain('[pending] run the tests')
  })

  it('asks no continuation in a later turn that did not write the list', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('call-1', 'todo_write', OPEN), textResponse('Started.'), textResponse('Still going.'), textResponse('A haiku.'),
    ])
    const ctx = await harness(adapter, { maxOpenTodoContinuationsPerTurn: 1 })
    const agent = await ctx.agentLoop.create(SessionId('todo-later-turn'), { provider: 'mock', model: 'mock' })
    for (const text of ['fix the bug', 'write a haiku']) {
      agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
      await agent.whenIdle()
    }
    // Three requests for the planning turn (including its one continuation), one for the haiku.
    expect(adapter.requests).toHaveLength(4)
  })

  it('brings the tasks back once per turn: a visible task-state message counts as the list being visible', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('call-1', 'todo_write', OPEN), authError,
      toolCallResponse('call-2', 'no_such_tool', {}), textResponse('Resumed.'),
    ])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('todo-reminder-once'), { provider: 'mock', model: 'mock' })
    for (const text of ['fix the bug', 'the connection is back']) {
      agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
      await agent.whenIdle()
    }
    const reminders = (request: GenerateOptions | undefined) => requestText(request).split('[pending] run the tests').length - 1
    expect(reminders(adapter.requests.at(-2))).toBe(1)
    expect(reminders(adapter.requests.at(-1))).toBe(1)
  })

  it('brings the tasks back when the latest visible todo_write call cannot show the list', async () => {
    const malformed: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('call-2'), name: 'todo_write', arguments: '{not json' } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ]
    for (const [label, rewrite] of [['malformed', malformed], ['empty', toolCallResponse('call-2', 'todo_write', {})]] as const) {
      const adapter = new MockAdapter([toolCallResponse('call-1', 'todo_write', OPEN), textResponse('Planned.'), rewrite, textResponse('Done.')])
      const ctx = await harness(adapter)
      const agent = await ctx.agentLoop.create(SessionId(`todo-unreadable-${label}`), { provider: 'mock', model: 'mock' })
      for (const text of ['plan the fix', 'go on']) {
        agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
        await agent.whenIdle()
      }
      expect(requestText(adapter.requests.at(-1))).toContain('[pending] run the tests')
    }
  })

  it('leaves a step another plugin rejected rejected, adding no task-state message', async () => {
    const adapter = new MockAdapter([toolCallResponse('call-1', 'todo_write', OPEN), authError, textResponse('never')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('todo-rejected-step'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'fix the bug' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    const before = adapter.requests.length
    // Registered after the task list, so it decides inside it, the way an off-peak deferral does.
    ctx.on('agent/pre-step', async () => ({ kind: 'reject' as const }))
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'the connection is back' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(before)
  })

  it('shows open tasks that no visible todo_write call carries', async () => {
    const adapter = new MockAdapter([textResponse('On it.')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('todo-written-elsewhere'), { provider: 'mock', model: 'mock' })
    // Another plugin writes the list inside the open turn, so no model tool call carries it.
    ctx.on('agent/pre-step', async ({ agent: stepping }, next) => {
      const decision = await next()
      if (stepping === agent && ctx.sessionProjections.stateOf(agent.session, 'todos') === null) {
        agent.session.append('todo/write', { todos: [{ content: 'run the tests', status: 'pending' }] })
      }
      return decision
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'carry on' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(requestText(adapter.requests[0])).toContain('[pending] run the tests')
  })

  it('ignores list writes and turn ends from a turn that started before it loaded', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    const session = ctx.sessions.create(SessionId('todo-unseen-turn'))
    session.append('turn/start', { turn: 1 })
    await ctx.plugin(ToolTodo, { allowParallelInProgress: true })
    session.append('todo/write', { todos: [{ content: 'carried', status: 'pending' }] })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(ctx.sessionProjections.stateOf(session, 'todos')).toEqual([{ content: 'carried', status: 'pending' }])
  })
})
