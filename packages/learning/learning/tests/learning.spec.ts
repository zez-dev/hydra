import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, {
  createUserMessage, LlmAdapter, ReasoningEffortId, ToolCallId, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type Session, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox, unsupportedModel } from '@deepseek-ai/dsh-agent-loop-testkit'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import CommandRuntime, { CommandId } from '@deepseek-ai/dsh-commands'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as Memory from '@deepseek-ai/dsh-memory'
import { workspaceTag } from '@deepseek-ai/dsh-memory'
import * as Learning from '@deepseek-ai/dsh-learning'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import { RESEARCH_SYSTEM_PROMPT, collectTurnTranscript, parseCandidates } from '@deepseek-ai/dsh-learning'

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

/** An adapter that never answers and, like a real one, fails with the abort reason once cancelled. */
class HangingAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  /** Resolves when the first request arrives, so a test can act while it is in flight. */
  readonly requested = Promise.withResolvers<undefined>()
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    this.requested.resolve(undefined)
    await new Promise<never>((_, reject) => {
      options.signal?.addEventListener('abort', () => { reject(options.signal?.reason as Error) }, { once: true })
    })
  }
}

/** Answers after a fixed delay, the way a slow local route does; aborts stop the wait. */
class DelayedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  constructor(private readonly delayMs: number, private readonly answer: string) {
    super()
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, this.delayMs)
      options.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(options.signal?.reason as Error) }, { once: true })
    })
    yield * textChunks(this.answer)
  }
}

/** Cuts its answer at any output cap below `needed`, the way a thinking route whose reasoning fills a small cap does. */
class CapSensitiveAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  constructor(private readonly needed: number, private readonly answer: string) {
    super()
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if ((options.maxTokens ?? 0) < this.needed) {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '[{"text":"Run' } }
      yield { type: 'finish', reason: { kind: 'max-tokens' } }
      return
    }
    yield * textChunks(this.answer)
  }
}

/** Answers at once and offers reasoning efforts, the way a thinking route does. */
class ThinkingRouteAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  constructor(private readonly answer: string, private readonly efforts: readonly string[]) {
    super()
  }
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider, id: model, name: model,
      reasoning: { efforts: this.efforts.map(id => ({ id: ReasoningEffortId(id), name: id })) },
    })
  }
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield * textChunks(this.answer)
  }
}
/** Answers only in reasoning at a lowered effort (or always), the way a server that files a no-thinking reply as reasoning does. */
class ReasoningOnlyAdapter extends ThinkingRouteAdapter {
  constructor(answer: string, efforts: readonly string[], private readonly always = false) {
    super(answer, efforts)
  }
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (!this.always && options.reasoningEffort === undefined) {
      yield * super.stream(options)
      return
    }
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'reasoning' }
    yield { type: 'reasoning-delta', index: 0, text: 'the answer, filed as reasoning' }
    yield { type: 'finish', reason: { kind: 'stop' } }
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

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

const BASE_CONFIG = {
  fileAs: 'candidate' as const,
  minToolCalls: 2,
  maxCandidatesPerTurn: 3,
  maxTranscriptBytes: 20_000,
  maxOutputTokens: 512,
  timeoutMs: 5000,
  provider: 'mock',
  model: 'mock',
}

async function setup(adapter: LlmAdapter, config: Partial<Learning.Config> = {}, withSkills = false): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-learning-'))
  const ctx = new Context()
  context = ctx
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(CommandRuntime)
  if (withSkills) await ctx.plugin(SkillRegistry)
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: join(root, 'storages') })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(Memory, { maxRecallBytes: 6000 })
  ctx.llm.registerAdapter(['mock'], adapter)
  await ctx.plugin(Learning, { ...BASE_CONFIG, skillsRoot: join(root, 'skills'), ...config })
  return ctx
}

async function liveAgent(
  ctx: Context,
  id = 'learning-agent',
  cwd?: string,
  lineage: Pick<SessionHeader, 'parentSession' | 'origin' | 'delegationDepth'> = {},
): Promise<{ agent: Agent; session: Session }> {
  const scope = ctx.plugin(() => {})
  const session = ctx.sessions.create(SessionId(id), { meta: { ...cwd === undefined ? {} : { cwd }, ...lineage } })
  const agent: Agent = {
    id: SessionId(id), options: {}, session, model: unsupportedModel(), inbox: unsupportedInbox(),
    status: 'idle', ctx: scope.ctx,
    followup: () => {}, steer: () => {}, inject: () => {}, send: () => {}, cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  await ctx.agents.register(agent)
  return { agent, session }
}

function recordTurn(session: Session, turn: number, toolCalls: number): void {
  session.append('turn/start', { turn })
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: `task ${turn}` }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  for (let index = 0; index < toolCalls; index += 1) {
    session.append('tool/call', { turn, step: 1, callId: ToolCallId(`t${turn}-${index}`), name: 'bash', arguments: JSON.stringify({ command: `echo ${index}` }) })
  }
  session.append('turn/end', { turn, reason: 'completed' } as never)
}

/** A turn whose one model request took `stepMs`, as the route's speed evidence for the review deadline. */
async function recordSlowTurn(session: Session, turn: number, stepMs: number, outputTokens?: number): Promise<void> {
  session.append('turn/start', { turn })
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: `task ${turn}` }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  session.append('step/start', { turn, step: 1 })
  await new Promise(resolve => setTimeout(resolve, stepMs))
  session.append('assistant/message', { turn, step: 1, stream: [], ...outputTokens === undefined ? {} : { usage: { inputTokens: 10, outputTokens } }, message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], source: { kind: 'model', provider: 'mock', model: 'mock' } } } as never, { surfaceOp: 'append' })
  for (let index = 0; index < 3; index += 1) {
    session.append('tool/call', { turn, step: 1, callId: ToolCallId(`t${turn}-${index}`), name: 'bash', arguments: JSON.stringify({ command: `echo ${index}` }) })
  }
  session.append('turn/end', { turn, reason: 'completed' } as never)
}

async function withJobs(ctx: Context): Promise<void> {
  await ctx.plugin(LocalJobRegistry)
  await ctx.plugin({ inject: ['jobs'], apply(pluginCtx: Context) { pluginCtx.jobs.attachController('test-controller') } })
}

/**
 * Resolve once the owner's next job settles, as the registry reports it. The
 * registry commits the terminal status before it emits `settled`, and
 * observing the event, unlike `ctx.jobs.wait`, never marks the job awaited.
 */
function nextJobSettlement(ctx: Context, owner: SessionId): Promise<undefined> {
  const settled = Promise.withResolvers<undefined>()
  const stop = ctx.jobs.events.subscribe({ owner }, (event) => {
    if (event.type !== 'settled') return
    stop()
    settled.resolve(undefined)
  })
  return settled.promise
}

describe('research mode', () => {
  it('files findings into the active research journal instead of proposing memories', async () => {
    const adapter = new ScriptedAdapter(() => textChunks('[{"kind":"breakthrough","text":"Scaling law holds"},{"kind":"result","text":"Train 3 layers","result":"error 4%"},{"kind":"dead_end","text":"Dropout above 0.5"},{"kind":"nope","text":"ignored"}]'))
    const ctx = await setup(adapter)
    const recorded: unknown[] = []
    ctx.provide('research', {
      storeFor: () => { throw new Error('unused') },
      activeFor: () => ({ slug: 'scaling', cwd: root! }),
      record: async (finding: unknown) => { recorded.push(finding) },
    } as never)
    const { agent, session } = await liveAgent(ctx)
    recordTurn(session, 1, 2)
    await ctx.learning.settled(session.id)
    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]?.system).toBe(RESEARCH_SYSTEM_PROMPT)
    expect(recorded).toEqual([
      { cwd: root, slug: 'scaling', kind: 'breakthrough', text: 'Scaling law holds' },
      { cwd: root, slug: 'scaling', kind: 'result', text: 'Train 3 layers', result: 'error 4%' },
      { cwd: root, slug: 'scaling', kind: 'dead_end', text: 'Dropout above 0.5' },
    ])
    expect(ctx.memory.list({}).filter(entry => entry.status === 'candidate')).toHaveLength(0)
    const logged = session.snapshotEvents().find(event => event.type === 'session/learning-request')
    expect(logged?.type === 'session/learning-request' ? logged.data.source : undefined).toEqual({ kind: 'research', slug: 'scaling' })
    const review = session.snapshotEvents().find(event => event.type === 'session/learning-review')
    expect(review?.data).toEqual({ turn: 1, outcome: { kind: 'findings', slug: 'scaling', count: 3 } })
    expect(agent.id).toBe('learning-agent')
  })

  it('retries extraction after the agent finishes active work', async () => {
    const adapter = new ScriptedAdapter(() => textChunks('[]'))
    const ctx = await setup(adapter, { minToolCalls: 1 })
    const { agent, session } = await liveAgent(ctx)
    let busy = 2
    agent.runMaintenance = (task) => {
      if (busy > 0) {
        busy -= 1
        return Promise.reject(new Error('agent "learning-agent" already has active work'))
      }
      return task(new AbortController().signal)
    }
    recordTurn(session, 1, 1)
    await ctx.learning.settled(session.id)
    expect(adapter.requests).toHaveLength(1)
  })
})

describe('parseCandidates', () => {
  it('parses a plain JSON array and a fenced block, defaults kind, and caps the count', () => {
    expect(parseCandidates('[{"text":"a","kind":"shortcut","tags":["x"]},{"text":"b"}]', 5)).toEqual([
      { text: 'a', kind: 'shortcut', tags: ['x'] },
      { text: 'b', kind: 'fact', tags: [] },
    ])
    expect(parseCandidates('Here you go:\n```json\n[{"text":"c"}]\n```', 5)).toEqual([{ text: 'c', kind: 'fact', tags: [] }])
    expect(parseCandidates('[{"text":"1"},{"text":"2"},{"text":"3"}]', 2)).toHaveLength(2)
  })

  it('returns nothing for invalid JSON, non-arrays, or entries without text', () => {
    expect(parseCandidates('nope', 5)).toEqual([])
    expect(parseCandidates('{"text":"x"}', 5)).toEqual([])
    expect(parseCandidates('[{"kind":"fact"},{"text":"  "}]', 5)).toEqual([])
  })
})

describe('collectTurnTranscript', () => {
  it('counts the turn tool calls and renders user, tool, and assistant lines within the byte cap', async () => {
    const ctx = await setup(new ScriptedAdapter(() => textChunks('[]')))
    const { session } = await liveAgent(ctx)
    recordTurn(session, 1, 2)
    const transcript = collectTurnTranscript(session.snapshotEvents(), 1, 20_000)
    expect(transcript.toolCalls).toBe(2)
    expect(transcript.text).toContain('task 1')
    expect(transcript.text).toContain('bash')
    const capped = collectTurnTranscript(session.snapshotEvents(), 1, 40)
    expect(Buffer.byteLength(capped.text)).toBeLessThanOrEqual(40)
  })

  it('reads past the turn/end of another turn and stops at its own', () => {
    const events = [
      { type: 'turn/start', data: { turn: 2 } },
      { type: 'turn/end', data: { turn: 1 } },
      { type: 'tool/call', data: { name: 'bash', arguments: '{"command":"ls"}' } },
      { type: 'turn/end', data: { turn: 2 } },
      { type: 'tool/call', data: { name: 'bash', arguments: '{"command":"later"}' } },
    ] as unknown as SessionEvent[]
    expect(collectTurnTranscript(events, 2, 20_000)).toEqual({ toolCalls: 1, text: 'tool bash: {"command":"ls"}' })
  })
})

describe('extraction on turn/end', () => {
  it('skips turns below minToolCalls and never calls the model', async () => {
    const adapter = new ScriptedAdapter(() => textChunks('[{"text":"never"}]'))
    const ctx = await setup(adapter)
    const { session } = await liveAgent(ctx)
    recordTurn(session, 1, 1)
    await ctx.learning.settled(session.id)
    expect(adapter.requests).toHaveLength(0)
    expect(ctx.memory.list()).toHaveLength(0)
    expect(session.snapshotEvents().some(event => event.type === 'session/learning-review')).toBe(false)
  })

  it('asks the review for lessons stated with their situation, and tags what it files with the session\'s project', async () => {
    const lesson = 'In auth.ts the token refresh failed because the clock-skew check ran first; refresh before checking.'
    const adapter = new ScriptedAdapter(() => textChunks(JSON.stringify([{ text: lesson, kind: 'fact', tags: ['lesson'] }])))
    const ctx = await setup(adapter)
    const { session } = await liveAgent(ctx, 'project-agent', '/work/alpha')
    recordTurn(session, 1, 3)
    await ctx.learning.settled(session.id)
    const system = adapter.requests[0]?.system ?? ''
    expect(system).toContain('an approach that failed and why')
    expect(system).toContain('name its situation')
    // Selective by default: most turns file nothing, and common knowledge or a restated task never qualifies.
    expect(system).toContain('Most turns teach nothing new; then answer []')
    expect(system).toContain('Never keep general programming knowledge')
    expect(system).toContain('a restatement of the task')
    expect(system).toContain('with no explanation before or after it')
    expect(system).toContain('never two items that say the same thing')
    // The request line asks for a review, not for extraction, so it never contradicts "answer []".
    const prompt = adapter.requests[0]?.messages.map(message => message.content.map(block => block.type === 'text' ? block.text : '').join('')).join('') ?? ''
    expect(prompt.startsWith('Review this turn transcript:\n')).toBe(true)
    expect(ctx.memory.list().map(entry => [entry.text, entry.tags])).toEqual([[lesson, ['lesson', workspaceTag('/work/alpha')]]])
  })

  it('files what a turn review extracts as recalled knowledge by default, once per distinct text', async () => {
    const adapter = new ScriptedAdapter(() => textChunks('[{"text":"echo prints its arguments","kind":"fact","tags":["shell"]},{"text":"Echo prints its arguments.","kind":"fact","tags":[]}]'))
    const ctx = await setup(adapter, { fileAs: 'approved' })
    const { session } = await liveAgent(ctx)
    recordTurn(session, 1, 3)
    await ctx.learning.settled(session.id)
    expect(ctx.memory.list({ status: 'candidate' })).toHaveLength(0)
    expect(ctx.memory.list({ status: 'approved' }).map(entry => entry.text)).toEqual(['Echo prints its arguments.'])
    const reviews = session.snapshotEvents().filter(event => event.type === 'session/learning-review')
    expect(reviews.map(event => event.data)).toEqual([{ turn: 1, outcome: { kind: 'candidates', count: 1 } }])
  })

  it('skips the turn review entirely when reviewTurns is false', async () => {
    const adapter = new ScriptedAdapter(() => textChunks('[{"text":"never"}]'))
    const ctx = await setup(adapter, { reviewTurns: false })
    const { session } = await liveAgent(ctx)
    recordTurn(session, 1, 3)
    await ctx.learning.settled(session.id)
    expect(adapter.requests).toHaveLength(0)
    expect(ctx.memory.list()).toHaveLength(0)
    expect(session.snapshotEvents().filter(event => event.type === 'session/learning-request')).toHaveLength(0)
  })

  it('logs a learning request, calls the configured route, and stores candidates', async () => {
    const adapter = new ScriptedAdapter(() => textChunks('[{"text":"echo prints its arguments","kind":"fact","tags":["shell"]},{"text":"second"}]'))
    const ctx = await setup(adapter)
    const { session } = await liveAgent(ctx)
    recordTurn(session, 1, 3)
    await ctx.learning.settled(session.id)
    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]).toMatchObject({ provider: 'mock', model: 'mock', purpose: 'learning-extract', sessionId: session.id })
    const candidates = ctx.memory.list({ status: 'candidate' })
    expect(candidates.map(entry => entry.text)).toEqual(['echo prints its arguments', 'second'])
    expect(candidates[0]).toMatchObject({ tags: ['shell'], sourceSessionId: session.id })
    const logged = session.snapshotEvents().filter(event => event.type === 'session/learning-request')
    expect(logged).toHaveLength(1)
    expect(logged[0]!.data).toMatchObject({ turn: 1, route: { provider: 'mock', model: 'mock' } })
    const reviews = session.snapshotEvents().filter(event => event.type === 'session/learning-review')
    expect(reviews.map(event => event.data)).toEqual([{ turn: 1, outcome: { kind: 'candidates', count: 2 } }])
  })

  it('records nothing when the Agent is disposed before the review runs', async () => {
    const adapter = new ScriptedAdapter(() => textChunks('[{"text":"never"}]'))
    const ctx = await setup(adapter)
    const { agent, session } = await liveAgent(ctx)
    // The agent loop cancels pending maintenance with this plain reason object, not an Error.
    // oxlint-disable-next-line prefer-promise-reject-errors -- mirrors the loop's cancel reason
    agent.runMaintenance = () => Promise.reject({ kind: 'disposed' })
    recordTurn(session, 1, 3)
    await ctx.learning.settled(session.id)
    expect(adapter.requests).toHaveLength(0)
    expect(session.snapshotEvents().some(event => event.type === 'session/learning-review')).toBe(false)
  })

  it('records a failed review carrying the truncation code when the output cap cuts the answer', async () => {
    const adapter = new ScriptedAdapter(() => [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: '[{"text":"half' },
      { type: 'block-end', index: 0, block: { type: 'text', text: '[{"text":"half' } },
      { type: 'finish', reason: { kind: 'max-tokens' } },
    ])
    const ctx = await setup(adapter)
    const { session } = await liveAgent(ctx)
    recordTurn(session, 1, 3)
    await ctx.learning.settled(session.id)
    expect(ctx.memory.list()).toHaveLength(0)
    const reviews = session.snapshotEvents().filter(event => event.type === 'session/learning-review')
    expect(reviews.map(event => event.data)).toEqual([
      { turn: 1, outcome: { kind: 'failed', code: Learning.LEARNING_TRUNCATED_CODE, message: 'learning: extraction output reached maxOutputTokens' } },
    ])
  })

  it('records a failed review when the extraction model asks for a tool', async () => {
    const adapter = new ScriptedAdapter(() => [{ type: 'finish', reason: { kind: 'tool-calls' } }])
    const ctx = await setup(adapter)
    const { session } = await liveAgent(ctx)
    recordTurn(session, 1, 3)
    await ctx.learning.settled(session.id)
    const reviews = session.snapshotEvents().filter(event => event.type === 'session/learning-review')
    expect(reviews.map(event => event.data)).toEqual([
      { turn: 1, outcome: { kind: 'failed', code: 'UNKNOWN', message: 'learning: extraction model unexpectedly requested a tool' } },
    ])
  })

  it('records a failed review carrying the deadline code when the route is too slow', async () => {
    const adapter = new HangingAdapter()
    const ctx = await setup(adapter, { timeoutMs: 20 })
    const { session } = await liveAgent(ctx)
    recordTurn(session, 1, 3)
    await ctx.learning.settled(session.id)
    expect(adapter.requests).toHaveLength(1)
    expect(ctx.memory.list()).toHaveLength(0)
    const reviews = session.snapshotEvents().filter(event => event.type === 'session/learning-review')
    expect(reviews.map(event => event.data)).toEqual([
      { turn: 1, outcome: { kind: 'failed', code: Learning.LEARNING_TIMEOUT_CODE, message: `${Learning.LEARNING_TIMEOUT_CODE} after 20ms` } },
    ])
  })

  it('gives the review as long as the route needed for the turn, not only the configured deadline', async () => {
    // The turn's one request took about 120 ms; a 30 ms deadline would cut a
    // review that answers after 200 ms, but four times the route's own pace does not.
    const adapter = new DelayedAdapter(200, '[{"text":"Run pnpm test before pushing.","kind":"shortcut","tags":[]}]')
    const ctx = await setup(adapter, { timeoutMs: 30 })
    const { session } = await liveAgent(ctx)
    await recordSlowTurn(session, 1, 120)
    await ctx.learning.settled(session.id)
    expect(ctx.memory.list().map(entry => entry.text)).toEqual(['Run pnpm test before pushing.'])
    expect(session.snapshotEvents().filter(event => event.type === 'session/learning-review').map(event => event.data))
      .toEqual([{ turn: 1, outcome: { kind: 'candidates', count: 1 } }])
  })

  it('reviews a turn as a job owned by the agent, reported by the plugin, without waiting for the agent to be idle', async () => {
    const adapter = new DelayedAdapter(20, '[{"text":"Run pnpm test before pushing.","kind":"shortcut","tags":[]}]')
    const ctx = await setup(adapter)
    await withJobs(ctx)
    const { agent, session } = await liveAgent(ctx)
    agent.whenIdle = () => new Promise(() => {})
    agent.runMaintenance = () => Promise.reject(new Error('maintenance must not be used when jobs are composed'))
    const settlements: [string, boolean][] = []
    const jobSettled = Promise.withResolvers<undefined>()
    ctx.jobs.events.subscribe({ owner: agent.session.id }, (event) => {
      if (event.type !== 'settled') return
      settlements.push([event.job.kind, event.awaited])
      jobSettled.resolve(undefined)
    })
    recordTurn(session, 1, 3)
    await jobSettled.promise
    expect(ctx.memory.list().map(entry => entry.text)).toEqual(['Run pnpm test before pushing.'])
    const jobs = ctx.jobs.list(agent.session.id)
    expect(jobs.map(job => [job.kind, job.status, job.owner]))
      .toEqual([['learning-review', 'completed', agent.session.id]])
    // The plugin's own wait collected the settlement, so tool-jobs owes no completion notice.
    expect(settlements).toEqual([['learning-review', true]])
  })

  it('starts no job for a turn below minToolCalls', async () => {
    const adapter = new ScriptedAdapter(() => textChunks('[{"text":"never"}]'))
    const ctx = await setup(adapter)
    await withJobs(ctx)
    const { agent, session } = await liveAgent(ctx)
    recordTurn(session, 1, 1)
    await ctx.learning.settled(session.id)
    expect(ctx.jobs.list(agent.session.id)).toEqual([])
    expect(adapter.requests).toHaveLength(0)
  })

  it('settles a session\'s pending review only once the review has filed its result', async () => {
    const adapter = new DelayedAdapter(30, '[{"text":"Run pnpm test before pushing.","kind":"shortcut","tags":[]}]')
    const ctx = await setup(adapter)
    await withJobs(ctx)
    const { session } = await liveAgent(ctx)
    recordTurn(session, 1, 3)
    // The review is pending from the turn's end, before its job starts.
    const pending = ctx.learning.settled(session.id)
    let done = false
    void pending.then(() => { done = true })
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(done).toBe(false)
    await pending
    expect(session.snapshotEvents().filter(event => event.type === 'session/learning-review').map(event => event.data))
      .toEqual([{ turn: 1, outcome: { kind: 'candidates', count: 1 } }])
  })

  it('settles at once for a session whose turn gets no review', async () => {
    const ctx = await setup(new ScriptedAdapter(() => textChunks('[]')))
    await withJobs(ctx)
    const { session } = await liveAgent(ctx)
    recordTurn(session, 1, 1)
    await ctx.learning.settled(session.id)
    expect(session.snapshotEvents().some(event => event.type === 'session/learning-request')).toBe(false)
  })

  it('starts no review for a turn of a subagent child, which is disposed as soon as its turn ends', async () => {
    const adapter = new ScriptedAdapter(() => textChunks('[{"text":"Run pnpm test before pushing.","kind":"shortcut","tags":[]}]'))
    const ctx = await setup(adapter)
    await withJobs(ctx)
    const { agent, session } = await liveAgent(ctx, 'child-agent', '/work/alpha', {
      parentSession: SessionId('parent-agent'), origin: 'subagent', delegationDepth: 1,
    })
    recordTurn(session, 1, 3)
    await ctx.learning.settled(session.id)
    expect(ctx.jobs.list(agent.session.id)).toEqual([])
    expect(adapter.requests).toHaveLength(0)
    expect(ctx.memory.list()).toHaveLength(0)
    expect(session.snapshotEvents().some(event => event.type === 'session/learning-request' || event.type === 'session/learning-review')).toBe(false)
  })

  it('reviews a turn of a session that names a parent session without being a subagent child', async () => {
    const adapter = new ScriptedAdapter(() => textChunks('[{"text":"Run pnpm test before pushing.","kind":"shortcut","tags":[]}]'))
    const ctx = await setup(adapter)
    const { session } = await liveAgent(ctx, 'fork-agent', undefined, { parentSession: SessionId('source-agent') })
    recordTurn(session, 1, 3)
    await ctx.learning.settled(session.id)
    expect(adapter.requests).toHaveLength(1)
    expect(ctx.memory.list().map(entry => entry.text)).toEqual(['Run pnpm test before pushing.'])
  })

  it('asks a thinking route for its lowest reasoning effort so the cap goes to the answer', async () => {
    const adapter = new ThinkingRouteAdapter('[{"text":"Run pnpm test before pushing.","kind":"shortcut","tags":[]}]', ['high', 'medium', 'minimal'])
    const ctx = await setup(adapter)
    const { session } = await liveAgent(ctx)
    recordTurn(session, 1, 3)
    await ctx.learning.settled(session.id)
    expect(adapter.requests.map(request => request.reasoningEffort)).toEqual(['minimal'])
    const requests = session.snapshotEvents().filter(event => event.type === 'session/learning-request')
    expect(requests.map(event => event.data.reasoningEffort)).toEqual(['minimal'])
  })

  it('asks again at the route\'s default effort when its lowest effort leaves no answer text, and keeps the default for that route', async () => {
    const adapter = new ReasoningOnlyAdapter('[{"text":"Run pnpm test before pushing.","kind":"shortcut","tags":[]}]', ['high', 'off'])
    const ctx = await setup(adapter)
    const { session } = await liveAgent(ctx)
    recordTurn(session, 1, 3)
    await ctx.learning.settled(session.id)
    expect(ctx.memory.list().map(entry => entry.text)).toEqual(['Run pnpm test before pushing.'])
    recordTurn(session, 2, 3)
    await ctx.learning.settled(session.id)
    expect(adapter.requests.map(request => request.reasoningEffort)).toEqual(['off', undefined, undefined])
    const requests = session.snapshotEvents().filter(event => event.type === 'session/learning-request')
    expect(requests.map(event => event.data.reasoningEffort)).toEqual(['off', undefined, undefined])
  })

  it('reports a review whose answer has no text as failed, not as nothing learned', async () => {
    const adapter = new ReasoningOnlyAdapter('unused', ['off'], true)
    const ctx = await setup(adapter)
    const { session } = await liveAgent(ctx)
    recordTurn(session, 1, 3)
    await ctx.learning.settled(session.id)
    const reviews = session.snapshotEvents().flatMap(event => event.type === 'session/learning-review' ? [event.data] : [])
    expect(reviews).toEqual([{
      turn: 1,
      outcome: { kind: 'failed', code: Learning.LEARNING_EMPTY_CODE, message: 'learning: the model\'s answer had no text' },
    }])
    // The default effort did not help, so the next review still asks the lowest first.
    recordTurn(session, 2, 3)
    await ctx.learning.settled(session.id)
    expect(adapter.requests.map(request => request.reasoningEffort)).toEqual(['off', undefined, 'off', undefined])
  })

  it('asks a route without a lower effort for nothing', async () => {
    const adapter = new ThinkingRouteAdapter('[{"text":"Run pnpm test before pushing.","kind":"shortcut","tags":[]}]', ['medium', 'high'])
    const ctx = await setup(adapter)
    const { session } = await liveAgent(ctx)
    recordTurn(session, 1, 3)
    await ctx.learning.settled(session.id)
    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]).not.toHaveProperty('reasoningEffort')
    const requests = session.snapshotEvents().filter(event => event.type === 'session/learning-request')
    expect(requests[0]?.data).not.toHaveProperty('reasoningEffort')
  })

  it('gives a raised output cap the time the route\'s own pace needs, not only the turn\'s length', async () => {
    // The turn's one request produced 100 tokens in about 100 ms: 1 ms per
    // token. A review answering after 350 ms exceeds the 30 ms deadline and
    // the turn's own length, but not 100 ms plus 512 tokens at that pace.
    const adapter = new DelayedAdapter(350, '[{"text":"Run pnpm test before pushing.","kind":"shortcut","tags":[]}]')
    const ctx = await setup(adapter, { timeoutMs: 30, reviewTimeoutFactor: 1 })
    const { session } = await liveAgent(ctx)
    await recordSlowTurn(session, 1, 100, 100)
    await ctx.learning.settled(session.id)
    expect(session.snapshotEvents().filter(event => event.type === 'session/learning-review').map(event => event.data))
      .toEqual([{ turn: 1, outcome: { kind: 'candidates', count: 1 } }])
  })

  it('yields a review in flight to the next turn, recording nothing', async () => {
    const adapter = new HangingAdapter()
    const ctx = await setup(adapter, { timeoutMs: 5000 })
    await withJobs(ctx)
    const { agent, session } = await liveAgent(ctx)
    recordTurn(session, 1, 3)
    await adapter.requested.promise
    expect(adapter.requests).toHaveLength(1)
    const yielded = nextJobSettlement(ctx, agent.session.id)
    session.append('turn/start', { turn: 2 })
    await yielded
    expect(ctx.jobs.list(agent.session.id).map(job => [job.status, job.detail])).toEqual([['killed', 'review yielded to the next turn']])
    expect(session.snapshotEvents().some(event => event.type === 'session/learning-review')).toBe(false)
  })

  it('yields a review whose next turn starts before the review does, recording nothing', async () => {
    const adapter = new HangingAdapter()
    const ctx = await setup(adapter, { timeoutMs: 5000 })
    await withJobs(ctx)
    const { session } = await liveAgent(ctx)
    recordTurn(session, 1, 3)
    // A queued message starts the next turn in the same tick the previous one ended.
    session.append('turn/start', { turn: 2 })
    await ctx.learning.settled(session.id)
    expect(adapter.requests).toHaveLength(0)
    expect(session.snapshotEvents().some(event => event.type === 'session/learning-review')).toBe(false)
  })

  it('cancels a running review job when its agent is disposed, recording nothing', async () => {
    const adapter = new HangingAdapter()
    const ctx = await setup(adapter, { timeoutMs: 5000 })
    await withJobs(ctx)
    const { agent, session } = await liveAgent(ctx)
    recordTurn(session, 1, 3)
    await adapter.requested.promise
    expect(adapter.requests).toHaveLength(1)
    const cancelled = nextJobSettlement(ctx, agent.session.id)
    await ctx.parallel('agent/disposed', { agent })
    await cancelled
    expect(ctx.jobs.list(agent.session.id).map(job => job.status)).toEqual(['killed'])
    expect(session.snapshotEvents().some(event => event.type === 'session/learning-review')).toBe(false)
  })

  it('retries a truncated extraction with a larger output cap and keeps that cap for the route', async () => {
    // Needs 5000: two raises (512 → 2048 → 8192); the second turn starts at the remembered 8192.
    const adapter = new CapSensitiveAdapter(5000, '[{"text":"Run pnpm test before pushing.","kind":"shortcut","tags":[]}]')
    const ctx = await setup(adapter, { maxOutputTokens: 512 })
    const { session } = await liveAgent(ctx)
    recordTurn(session, 1, 3)
    await ctx.learning.settled(session.id)
    expect(adapter.requests.map(request => request.maxTokens)).toEqual([512, 2048, 8192])
    expect(ctx.memory.list().map(entry => entry.text)).toEqual(['Run pnpm test before pushing.'])
    expect(session.snapshotEvents().filter(event => event.type === 'session/learning-request').map(event => event.data.maxTokens)).toEqual([512, 2048, 8192])
    recordTurn(session, 2, 3)
    await ctx.learning.settled(session.id)
    expect(adapter.requests.map(request => request.maxTokens)).toEqual([512, 2048, 8192, 8192])
  })

  it('does not extract the same turn twice and tolerates a malformed model answer', async () => {
    const adapter = new ScriptedAdapter(() => textChunks('not json'))
    const ctx = await setup(adapter)
    const { session } = await liveAgent(ctx)
    recordTurn(session, 1, 2)
    await ctx.learning.settled(session.id)
    session.append('turn/end', { turn: 1, reason: 'completed' } as never)
    await ctx.learning.settled(session.id)
    expect(adapter.requests).toHaveLength(1)
    expect(ctx.memory.list()).toHaveLength(0)
  })

  it('falls back to the session request route when no provider/model is configured', async () => {
    const adapter = new ScriptedAdapter(() => textChunks('[{"text":"routed"}]'))
    const ctx = await setup(adapter, { provider: undefined, model: undefined } as unknown as Partial<Learning.Config>)
    const { session } = await liveAgent(ctx)
    session.append('request/header', { reason: 'initial', header: { config: { provider: 'mock', model: 'mock' } } } as never)
    recordTurn(session, 1, 2)
    await ctx.learning.settled(session.id)
    expect(adapter.requests).toHaveLength(1)
    expect(ctx.memory.list({ status: 'candidate' }).map(entry => entry.text)).toEqual(['routed'])
  })
})

describe('ctx.learning service', () => {
  it('promotes a memory entry to a skill file and marks it promoted', async () => {
    const adapter = new ScriptedAdapter(() => textChunks('[]'))
    const ctx = await setup(adapter)
    const entry = await ctx.memory.add({ text: 'Use pnpm vitest run <dir> for one package.', kind: 'shortcut', tags: ['vitest'] }, 'approved')
    const path = await ctx.learning.promote(entry.id, 'one-package-tests')
    expect(path).toBe(join(root!, 'skills', 'one-package-tests', 'SKILL.md'))
    expect(await readFile(path, 'utf8')).toContain('name: one-package-tests')
    expect(ctx.memory.get(entry.id)).toMatchObject({ status: 'promoted' })
    await expect(ctx.learning.promote(entry.id, 'Not Valid')).rejects.toThrow(/skill name/u)
  })
})

describe('/learn command', () => {
  const signal = new AbortController().signal

  async function invoke(ctx: Context, agent: Agent, rawInput: string) {
    return ctx.commands.find(agent, 'learn')!.handler({ commandId: CommandId('c'), agent, rawInput, attachments: [], signal })
  }

  it('lists, approves, and rejects candidates', async () => {
    const ctx = await setup(new ScriptedAdapter(() => textChunks('[]')))
    const { agent } = await liveAgent(ctx)
    const a = await ctx.memory.add({ text: 'alpha', kind: 'fact', tags: [] }, 'candidate')
    const b = await ctx.memory.add({ text: 'beta', kind: 'fact', tags: [] }, 'candidate')
    const listed = await invoke(ctx, agent, '')
    expect(listed.kind).toBe('success')
    expect((listed as { text?: string }).text).toContain('alpha')
    expect((await invoke(ctx, agent, `approve ${a.id}`)).kind).toBe('success')
    expect((await invoke(ctx, agent, `reject ${b.id}`)).kind).toBe('success')
    expect(ctx.memory.get(a.id)?.status).toBe('approved')
    expect(ctx.memory.get(b.id)?.status).toBe('rejected')
    expect((await invoke(ctx, agent, 'approve missing')).kind).toBe('error')
  })

  it('promotes an entry to a SKILL.md under skillsRoot and registers it with the skill registry', async () => {
    const ctx = await setup(new ScriptedAdapter(() => textChunks('[]')), {}, true)
    const { agent } = await liveAgent(ctx)
    const entry = await ctx.memory.add({ text: 'Run vitest with `pnpm vitest run <path>` for one package.', kind: 'shortcut', tags: ['testing'] }, 'candidate')
    const result = await invoke(ctx, agent, `skill ${entry.id} run-one-package-tests`)
    expect(result.kind).toBe('success')
    const written = await readFile(join(root!, 'skills', 'run-one-package-tests', 'SKILL.md'), 'utf8')
    expect(written).toContain('name: run-one-package-tests')
    expect(written).toContain('pnpm vitest run')
    expect(ctx.memory.get(entry.id)?.status).toBe('promoted')
    const snapshot = await ctx.skills.snapshot({})
    expect(snapshot.skills.some(skill => skill.name === 'run-one-package-tests')).toBe(true)
  })

  it('rejects an invalid skill name', async () => {
    const ctx = await setup(new ScriptedAdapter(() => textChunks('[]')))
    const { agent } = await liveAgent(ctx)
    const entry = await ctx.memory.add({ text: 'x', kind: 'fact', tags: [] }, 'candidate')
    expect((await invoke(ctx, agent, `skill ${entry.id} Bad Name!`)).kind).toBe('error')
  })
})
