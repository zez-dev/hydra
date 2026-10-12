import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import GoalService from '@deepseek-ai/dsh-goal'
import * as Evaluator from '@deepseek-ai/dsh-goal-evaluator'
import { collectEvidence, parseVerdict, renderWorkspaceEvidence } from '@deepseek-ai/dsh-goal-evaluator'
import type { WorkspaceChanges, WorkspaceChangesSummary } from '@deepseek-ai/dsh-workspace-changes'

class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  constructor(private readonly script: () => StreamChunk[]) {
    super()
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield * this.script()
  }
}

function textChunks(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

async function setup(adapter: LlmAdapter, workspaceChanges?: WorkspaceChanges): Promise<{ ctx: Context; agent: Agent; session: Session }> {
  const ctx = new Context()
  if (workspaceChanges !== undefined) ctx.provide('workspaceChanges', workspaceChanges)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(GoalService)
  ctx.llm.registerAdapter(['mock'], adapter)
  await ctx.plugin(Evaluator, { evidenceEvents: 4, maxWorkspaceChangeEntries: 2, maxOutputTokens: 256, timeoutMs: 5000, provider: 'mock', model: 'mock' })
  ctx.tools.register(defineContentToolFixture({
    name: 'update_goal',
    description: 'fixture',
    parameters: {},
    async execute() {
      return [{ type: 'text', text: 'completed' }]
    },
  }))
  const session = ctx.sessions.create(SessionId(`evaluator-${Math.random()}`))
  const scope = ctx.plugin(() => {})
  const agent: Agent = {
    id: session.id, options: {}, session, inbox: createInboxStub(), ctx: scope.ctx, status: 'idle',
    send: () => {}, followup: () => {}, steer: () => {}, inject: () => {}, cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  await ctx.agents.register(agent)
  return { ctx, agent, session }
}

function recordToolResult(session: Session, index: number, text: string): void {
  session.append('tool/call', { turn: 1, step: 1, callId: ToolCallId(`c${index}`), name: 'bash', arguments: JSON.stringify({ command: `cmd ${index}` }) })
  session.append('tool/result', {
    turn: 1,
    step: 1,
    message: {
      id: `m${index}` as never,
      role: 'user',
      content: [{ type: 'tool-result', toolCallId: ToolCallId(`c${index}`), content: [{ type: 'text', text }] }],
      source: { kind: 'tool', toolName: 'bash', callId: ToolCallId(`c${index}`) },
    } as never,
  }, { surfaceOp: 'append' })
}

async function complete(ctx: Context, agent: Agent, goalId: string, revision: number) {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId('complete-1'),
    name: 'update_goal',
    arguments: { goal_id: goalId, revision, action: 'complete' },
    agent,
  })
}

describe('parseVerdict', () => {
  it('reads a strict or fenced verdict and rejects anything else', () => {
    expect(parseVerdict('{"verdict":"achieved","reasons":[]}')).toEqual({ verdict: 'achieved', reasons: [] })
    expect(parseVerdict('```json\n{"verdict":"not-yet","reasons":["tests missing"]}\n```')).toEqual({ verdict: 'not-yet', reasons: ['tests missing'] })
    expect(parseVerdict('done')).toBeUndefined()
    expect(parseVerdict('{"verdict":"maybe","reasons":[]}')).toBeUndefined()
  })
})

describe('collectEvidence', () => {
  it('keeps only the last N tool results, naming the tool and capping each result', () => {
    const events: SessionEvent[] = []
    let seq = 0
    const push = (event: Omit<SessionEvent, 'seq' | 'time'>): void => {
      events.push({ ...event, seq: SessionSeq(seq++), time: seq } as SessionEvent)
    }
    for (let index = 0; index < 3; index += 1) {
      push({ type: 'tool/call', data: { turn: 1, step: 1, callId: ToolCallId(`c${index}`), name: `tool${index}`, arguments: '{}' } } as never)
      push({ type: 'tool/result', data: { turn: 1, step: 1, message: { content: [{ type: 'tool-result', toolCallId: ToolCallId(`c${index}`), content: [{ type: 'text', text: `result ${index} ${'x'.repeat(50)}` }] }] } } } as never)
    }
    const evidence = collectEvidence(events, 2, 30)
    expect(evidence).toHaveLength(2)
    expect(evidence[0]).toContain('tool1')
    expect(evidence[1]).toContain('tool2')
    expect(evidence.every(line => line.length <= 30 + 'tool2: '.length + 1)).toBe(true)
  })
})

describe('renderWorkspaceEvidence', () => {
  it('lists changed files per turn with line counts, capped at the entry limit', () => {
    const summaries: WorkspaceChangesSummary[] = [
      { turn: 1, cwd: '/w', total: 1, added: 3, deleted: 0, files: [{ path: 'a.ts', display: 'a.ts', added: 3, deleted: 0 }] },
      { turn: 2, cwd: '/w', total: 3, added: 5, deleted: 2, files: [
        { path: 'b.ts', display: 'b.ts', added: 4, deleted: 1 },
        { path: 'c.ts', display: 'c.ts', added: 1, deleted: 1 },
        { path: 'd.bin', display: 'd.bin', added: 0, deleted: 0, binary: true },
      ] },
    ]
    const lines = renderWorkspaceEvidence(summaries, 2)
    expect(lines).toEqual([
      'turn 1: 1 file, +3/-0: a.ts (+3/-0)',
      'turn 2: 3 files, +5/-2: b.ts (+4/-1), c.ts (+1/-1), and 1 more',
    ])
    expect(renderWorkspaceEvidence([], 2)).toEqual([])
  })
})

describe('update_goal complete gate', () => {
  it('includes recorded workspace changes of earlier turns in the evidence', async () => {
    const adapter = new ScriptedAdapter(() => textChunks('{"verdict":"not-yet","reasons":["file never verified"]}'))
    const summary: WorkspaceChangesSummary = {
      turn: 1, cwd: '/w', total: 1, added: 2, deleted: 0,
      files: [{ path: 'src/out.ts', display: 'src/out.ts', added: 2, deleted: 0 }],
    }
    const { ctx, agent, session } = await setup(adapter, {
      // The real recorder serves the summary before it announces the event.
      summary: (sessionId, seq) => sessionId === session.id && typeof seq === 'number' ? summary : undefined,
      diff: () => Promise.resolve(undefined),
    })
    const goal = ctx.goals.create(agent, { objective: 'write out.ts' })
    session.append('workspace/changes', { turn: 1 })
    // The plugin reads the served summary once the announcing append has settled.
    await Promise.resolve()
    await complete(ctx, agent, goal.id, goal.revision)
    const prompt = adapter.requests[0]!.messages.map(message => message.content.map(block => block.type === 'text' ? block.text : '').join('')).join('\n')
    expect(prompt).toContain('Workspace changes')
    expect(prompt).toContain('src/out.ts (+2/-0)')
  })


  it('denies completion with the evaluator reasons on not-yet and logs the request', async () => {
    const adapter = new ScriptedAdapter(() => textChunks('{"verdict":"not-yet","reasons":["tests were never run","README unchanged"]}'))
    const { ctx, agent, session } = await setup(adapter)
    const goal = ctx.goals.create(agent, { objective: 'ship the feature with tests' })
    recordToolResult(session, 1, 'ran build')
    const result = await complete(ctx, agent, goal.id, goal.revision)
    expect(result.isError).toBe(true)
    const text = result.content.map(block => block.type === 'text' ? block.text : '').join('')
    expect(text).toContain('tests were never run')
    expect(text).toContain('README unchanged')
    expect(ctx.goals.get(agent)).toMatchObject({ phase: 'active' })
    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]).toMatchObject({ purpose: 'goal-evaluate', provider: 'mock', model: 'mock' })
    const prompt = adapter.requests[0]!.messages.map(message => message.content.map(block => block.type === 'text' ? block.text : '').join('')).join('\n')
    expect(prompt).toContain('ship the feature with tests')
    expect(prompt).toContain('ran build')
    expect(session.snapshotEvents().some(event => event.type === 'session/goal-evaluation')).toBe(true)
  })

  it('delegates on achieved so the tool runs', async () => {
    const adapter = new ScriptedAdapter(() => textChunks('{"verdict":"achieved","reasons":["all done"]}'))
    const { ctx, agent } = await setup(adapter)
    const goal = ctx.goals.create(agent, { objective: 'ship it' })
    const result = await complete(ctx, agent, goal.id, goal.revision)
    expect(result.isError).toBe(false)
    expect(adapter.requests).toHaveLength(1)
  })

  it('fails closed naming the cause when the evaluation is cut at the cap or asks for a tool', async () => {
    for (const [kind, cause] of [
      ['max-tokens', 'goal-evaluator: evaluation output reached maxOutputTokens'],
      ['tool-calls', 'goal-evaluator: evaluation model unexpectedly requested a tool'],
    ] as const) {
      const adapter = new ScriptedAdapter(() => [{ type: 'finish', reason: { kind } }])
      const { ctx, agent } = await setup(adapter)
      const goal = ctx.goals.create(agent, { objective: 'ship it' })
      const result = await complete(ctx, agent, goal.id, goal.revision)
      expect(result.isError).toBe(true)
      expect(result.content.map(block => block.type === 'text' ? block.text : '').join('')).toContain(`goal completion was not evaluated (${cause})`)
      expect(ctx.goals.get(agent)).toMatchObject({ phase: 'active' })
    }
  })

  it('fails closed with an unreadable-evaluation denial on malformed output', async () => {
    const adapter = new ScriptedAdapter(() => textChunks('I think so?'))
    const { ctx, agent } = await setup(adapter)
    const goal = ctx.goals.create(agent, { objective: 'ship it' })
    const result = await complete(ctx, agent, goal.id, goal.revision)
    expect(result.isError).toBe(true)
    expect(result.content.map(block => block.type === 'text' ? block.text : '').join('')).toContain('unreadable')
  })

  it('ignores other update_goal actions and calls without a goal', async () => {
    const adapter = new ScriptedAdapter(() => textChunks('{"verdict":"not-yet","reasons":["no"]}'))
    const { ctx, agent } = await setup(adapter)
    const noGoal = await complete(ctx, agent, 'g', 1)
    expect(noGoal.isError).toBe(false)
    const goal = ctx.goals.create(agent, { objective: 'ship it' })
    const paused = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('pause-1'),
      name: 'update_goal',
      arguments: { goal_id: goal.id, revision: goal.revision, action: 'pause' },
      agent,
    })
    expect(paused.isError).toBe(false)
    expect(adapter.requests).toHaveLength(0)
  })
})
