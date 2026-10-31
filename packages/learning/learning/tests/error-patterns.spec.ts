import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createToolResultMessage, createUserMessage, LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox, unsupportedModel } from '@deepseek-ai/dsh-agent-loop-testkit'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as Memory from '@deepseek-ai/dsh-memory'
import * as Learning from '@deepseek-ai/dsh-learning'
import { collectErrorPairs, ERROR_PATTERN_SYSTEM_PROMPT, errorFingerprint, EXTRACTION_SYSTEM_PROMPT } from '@deepseek-ai/dsh-learning'

class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  constructor(private readonly script: (index: number) => StreamChunk[]) {
    super()
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield * this.script(this.requests.length - 1)
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
  minToolCalls: 1,
  maxCandidatesPerTurn: 3,
  maxTranscriptBytes: 20_000,
  maxOutputTokens: 512,
  timeoutMs: 5000,
  provider: 'mock',
  model: 'mock',
}

async function setup(adapter: LlmAdapter, config: Partial<Learning.Config> = {}): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-learning-errors-'))
  const ctx = new Context()
  context = ctx
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: join(root, 'storages') })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(Memory, { maxRecallBytes: 6000 })
  ctx.llm.registerAdapter(['mock'], adapter)
  await ctx.plugin(Learning, { ...BASE_CONFIG, skillsRoot: join(root, 'skills'), ...config })
  return ctx
}

async function liveAgent(ctx: Context, id = 'errors-agent'): Promise<{ agent: Agent; session: Session }> {
  const scope = ctx.plugin(() => {})
  const session = ctx.sessions.create(SessionId(id))
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

function call(session: Session, turn: number, id: string, name: string, command: string): void {
  session.append('tool/call', { turn, step: 1, callId: ToolCallId(id), name, arguments: JSON.stringify({ command }) })
}

function result(session: Session, turn: number, id: string, text: string, failed: boolean): void {
  session.append('tool/result', {
    turn,
    step: 1,
    message: createToolResultMessage({ callId: ToolCallId(id), content: [{ type: 'text', text }], isError: failed }),
    ...failed ? { error: { name: 'ToolError', code: 'EXIT' } } : {},
  }, { surfaceOp: 'append' })
}

/** A turn where `pnpm test` fails on a missing binary and a later bash call succeeds with the PATH fix. */
function recordFailureThenFix(session: Session, turn: number): void {
  session.append('turn/start', { turn })
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: `task ${turn}` }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  call(session, turn, `${turn}-a`, 'bash', 'pnpm test')
  result(session, turn, `${turn}-a`, 'bash: pnpm: command not found', true)
  call(session, turn, `${turn}-b`, 'bash', 'export PATH="$HOME/.local/bin:$PATH" && pnpm test')
  result(session, turn, `${turn}-b`, 'Tests 3 passed', false)
  session.append('turn/end', { turn, reason: 'completed' } as never)
}

async function settled(): Promise<void> {
  for (let index = 0; index < 30; index += 1) await new Promise(resolve => setTimeout(resolve, 5))
}

describe('collectErrorPairs', () => {
  it('pairs a failed tool call with the later successful call of the same tool', async () => {
    const ctx = await setup(new ScriptedAdapter(() => textChunks('[]')), { errorPatterns: { enabled: false, maxPairsPerTurn: 5 } })
    const { session } = await liveAgent(ctx)
    recordFailureThenFix(session, 1)
    const pairs = collectErrorPairs(session.snapshotEvents(), 1, 5)
    expect(pairs).toHaveLength(1)
    expect(pairs[0]).toMatchObject({
      tool: 'bash',
      failedArguments: JSON.stringify({ command: 'pnpm test' }),
      error: 'bash: pnpm: command not found',
      recoveredArguments: JSON.stringify({ command: 'export PATH="$HOME/.local/bin:$PATH" && pnpm test' }),
      recoveredResult: 'Tests 3 passed',
    })
  })

  it('reports no pair when the failure was never followed by a success, and caps the count', async () => {
    const ctx = await setup(new ScriptedAdapter(() => textChunks('[]')), { errorPatterns: { enabled: false, maxPairsPerTurn: 5 } })
    const { session } = await liveAgent(ctx)
    session.append('turn/start', { turn: 1 })
    call(session, 1, 'x', 'bash', 'false')
    result(session, 1, 'x', 'exit 1', true)
    call(session, 1, 'y', 'read_file', 'a')
    result(session, 1, 'y', 'contents', false)
    session.append('turn/end', { turn: 1, reason: 'completed' } as never)
    expect(collectErrorPairs(session.snapshotEvents(), 1, 5)).toEqual([])
    session.append('turn/start', { turn: 2 })
    for (const index of [1, 2, 3]) {
      call(session, 2, `f${index}`, 'bash', `cmd ${index}`)
      result(session, 2, `f${index}`, `error ${index}`, true)
    }
    for (const index of [1, 2, 3]) {
      call(session, 2, `ok${index}`, 'bash', `fixed ${index}`)
      result(session, 2, `ok${index}`, `done ${index}`, false)
    }
    session.append('turn/end', { turn: 2, reason: 'completed' } as never)
    expect(collectErrorPairs(session.snapshotEvents(), 2, 5)).toHaveLength(3)
    expect(collectErrorPairs(session.snapshotEvents(), 2, 2)).toHaveLength(2)
  })
})

describe('errorFingerprint', () => {
  it('is short, stable, and ignores numbers, paths, and case', () => {
    const a = errorFingerprint('bash: pnpm: command not found (exit 127) at /home/user/x')
    const b = errorFingerprint('Bash: PNPM: command not found (exit 1) at /tmp/y')
    expect(a).toBe(b)
    expect(a).toMatch(/^[a-f0-9]{10}$/u)
    expect(errorFingerprint('something else entirely')).not.toBe(a)
  })
})

describe('error-pattern extraction on turn/end', () => {
  it('runs a focused second request over the pairs and files shortcut candidates with fix and error tags', async () => {
    const adapter = new ScriptedAdapter(index => textChunks(index === 0
      ? '[]'
      : '[{"text":"When pnpm is not found, export PATH with ~/.local/bin first.","tags":["pnpm"]}]'))
    const ctx = await setup(adapter)
    const { session } = await liveAgent(ctx)
    recordFailureThenFix(session, 1)
    await settled()
    expect(adapter.requests).toHaveLength(2)
    expect(adapter.requests[0]?.system).toBe(EXTRACTION_SYSTEM_PROMPT)
    expect(adapter.requests[1]?.system).toBe(ERROR_PATTERN_SYSTEM_PROMPT)
    const candidates = ctx.memory.list({ status: 'candidate' })
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({ kind: 'shortcut', text: 'When pnpm is not found, export PATH with ~/.local/bin first.' })
    expect(candidates[0]?.tags).toContain('pnpm')
    expect(candidates[0]?.tags).toContain('fix:bash')
    expect(candidates[0]?.tags).toContain(`error:${errorFingerprint('bash: pnpm: command not found')}`)
    const logged = session.snapshotEvents().filter(event => event.type === 'session/learning-request')
    expect(logged).toHaveLength(2)
    expect(logged[1]?.type === 'session/learning-request' ? logged[1].data.source : undefined).toEqual({ kind: 'error-patterns', pairs: 1 })
  })

  it('does not file the same shortcut twice across turns', async () => {
    const adapter = new ScriptedAdapter(index => textChunks(index % 2 === 0
      ? '[]'
      : '[{"text":"When pnpm is not found, export PATH with ~/.local/bin first.","tags":["pnpm"]}]'))
    const ctx = await setup(adapter)
    const { session } = await liveAgent(ctx)
    recordFailureThenFix(session, 1)
    await settled()
    recordFailureThenFix(session, 2)
    await settled()
    expect(adapter.requests).toHaveLength(4)
    expect(ctx.memory.list({ status: 'candidate' })).toHaveLength(1)
  })

  it('skips the second request when error patterns are disabled or no pair exists', async () => {
    const adapter = new ScriptedAdapter(() => textChunks('[]'))
    const ctx = await setup(adapter, { errorPatterns: { enabled: false, maxPairsPerTurn: 5 } })
    const { session } = await liveAgent(ctx)
    recordFailureThenFix(session, 1)
    await settled()
    expect(adapter.requests).toHaveLength(1)
  })
})
