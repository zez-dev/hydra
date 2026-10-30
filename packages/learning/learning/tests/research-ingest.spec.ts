import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox, unsupportedModel } from '@deepseek-ai/dsh-agent-loop-testkit'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import CommandRuntime, { CommandId } from '@deepseek-ai/dsh-commands'
import GoalService from '@deepseek-ai/dsh-goal'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as Memory from '@deepseek-ai/dsh-memory'
import * as Research from '@deepseek-ai/dsh-research'
import * as Learning from '@deepseek-ai/dsh-learning'
import { parseResearchIngestInput, RESEARCH_INGEST_SYSTEM_PROMPT, parseIngestFindings } from '@deepseek-ai/dsh-learning'

class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  constructor(private readonly script: (options: GenerateOptions) => StreamChunk[]) {
    super()
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield * this.script(options)
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
  minToolCalls: 2, maxCandidatesPerTurn: 3, maxTranscriptBytes: 20_000, maxOutputTokens: 512, timeoutMs: 5000, provider: 'mock', model: 'mock',
}

async function setup(adapter: LlmAdapter): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-research-ingest-'))
  const ctx = new Context()
  context = ctx
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(GoalService)
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: join(root, 'storages') })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(Memory, { maxRecallBytes: 6000 })
  await ctx.plugin(Research, {
    dir: '.dsh/research', maxRecallBytes: 8000, recentExperiments: 3,
    scoring: { enabled: false, maxOutputTokens: 256, timeoutMs: 10_000 }, maxExperimentMs: 60_000, maxOutputBytes: 20_000,
  })
  ctx.llm.registerAdapter(['mock'], adapter)
  await ctx.plugin(Learning, { ...BASE_CONFIG, skillsRoot: join(root, 'skills') })
  return ctx
}

async function liveAgent(ctx: Context, cwd: string, id = 'ingest-agent'): Promise<{ agent: Agent; session: Session }> {
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
  return { agent, session }
}

const signal = new AbortController().signal

async function invoke(ctx: Context, agent: Agent, name: string, rawInput: string) {
  return ctx.commands.find(agent, name)!.handler({ commandId: CommandId('c'), agent, rawInput, attachments: [], signal })
}

describe('parseResearchIngestInput and parseIngestFindings', () => {
  it('parses the path and an optional slug', () => {
    expect(parseResearchIngestInput(' papers --slug cooling ')).toEqual({ path: 'papers', slug: 'cooling' })
    expect(parseResearchIngestInput('notes.md')).toEqual({ path: 'notes.md' })
    expect(parseResearchIngestInput('')).toBeUndefined()
  })

  it('keeps only hypotheses, results, and dead ends with text', () => {
    const answer = '```json\n[{"kind":"hypothesis","text":"H1"},{"kind":"result","text":"tried","result":"worked"},{"kind":"dead_end","text":"no"},{"kind":"breakthrough","text":"x"},{"kind":"hypothesis"}]\n```'
    expect(parseIngestFindings(answer, 10)).toEqual([
      { kind: 'hypothesis', text: 'H1' }, { kind: 'result', text: 'tried', result: 'worked' }, { kind: 'dead_end', text: 'no' },
    ])
    expect(parseIngestFindings('nope', 10)).toEqual([])
  })
})

describe('/research-ingest', () => {
  it('files hypotheses, results, and dead ends from a folder into the active journal with the source noted', async () => {
    const adapter = new ScriptedAdapter(() => textChunks('[{"kind":"hypothesis","text":"Lower temperature raises signal."},{"kind":"result","text":"Ran at 77K","result":"noise doubled"},{"kind":"dead_end","text":"Room temperature is hopeless."}]'))
    const ctx = await setup(adapter)
    const { agent } = await liveAgent(ctx, root!)
    await mkdir(join(root!, 'papers'), { recursive: true })
    await writeFile(join(root!, 'papers', 'a.md'), '# Paper A\nCooling helps.\n')
    const started = await invoke(ctx, agent, 'research', 'find the cooling limit --slug cooling')
    expect(started.kind).toBe('success')
    const result = await invoke(ctx, agent, 'research-ingest', 'papers')
    expect(result).toMatchObject({ kind: 'success' })
    expect((result as { text: string }).text).toContain('1 file')
    const store = ctx.research.storeFor(root!)
    await store.whenReady()
    const journal = store.get('cooling')!
    expect(journal.hypotheses.map(entry => entry.text)).toEqual(['Lower temperature raises signal. (source: papers/a.md)'])
    expect(journal.hypotheses[0]).toMatchObject({ status: 'open', source: 'auto' })
    expect(journal.experiments.map(entry => [entry.what, entry.result])).toEqual([['Ran at 77K (source: papers/a.md)', 'noise doubled']])
    expect(journal.deadEnds.map(entry => entry.text)).toEqual(['Room temperature is hopeless. (source: papers/a.md)'])
    expect(adapter.requests[0]?.system).toContain(RESEARCH_INGEST_SYSTEM_PROMPT.split('\n')[0])
    expect(adapter.requests[0]?.system).toContain('find the cooling limit')
    expect(ctx.memory.list()).toHaveLength(0)
  })

  it('reports a missing journal instead of importing', async () => {
    const ctx = await setup(new ScriptedAdapter(() => textChunks('[]')))
    const { agent } = await liveAgent(ctx, root!)
    await writeFile(join(root!, 'note.md'), 'text\n')
    const result = await invoke(ctx, agent, 'research-ingest', 'note.md --slug missing')
    expect(result.kind).toBe('error')
    expect((result as { text: string }).text).toContain('missing')
  })
})

describe('cross-goal breakthrough bridge', () => {
  it('mirrors a recorded breakthrough into approved memory once', async () => {
    const ctx = await setup(new ScriptedAdapter(() => textChunks('[]')))
    const { agent } = await liveAgent(ctx, root!)
    await invoke(ctx, agent, 'research', 'find the cooling limit --slug cooling')
    await ctx.research.record({ cwd: root!, slug: 'cooling', kind: 'breakthrough', text: 'Cooling to 4K doubles the signal.' }, 'model')
    await new Promise(resolve => setTimeout(resolve, 50))
    const entries = ctx.memory.list({ status: 'approved' })
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ kind: 'fact', text: 'Cooling to 4K doubles the signal.' })
    expect(entries[0]!.tags).toEqual(expect.arrayContaining(['research:cooling', 'breakthrough']))
    await ctx.research.record({ cwd: root!, slug: 'cooling', kind: 'breakthrough', text: 'cooling to 4k doubles the signal' }, 'model')
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(ctx.memory.list({ status: 'approved' })).toHaveLength(1)
  })
})
