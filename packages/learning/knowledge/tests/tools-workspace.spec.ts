import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import CommandRuntime, { CommandId } from '@deepseek-ai/dsh-commands'
import { JobId, type JobSpec } from '@deepseek-ai/dsh-jobs'
import LlmRuntime, { createUserMessage, LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import * as Knowledge from '@deepseek-ai/dsh-knowledge'
import * as KnowledgeTools from '@deepseek-ai/dsh-knowledge/tools'
import { WORKSPACE_KNOWLEDGE_FOLDER } from '@deepseek-ai/dsh-knowledge'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  vi.restoreAllMocks()
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** The test root, created on first use and removed after each test. */
async function fresh(): Promise<string> {
  root ??= await mkdtemp(join(tmpdir(), 'dsh-knowledge-tools-'))
  return root
}

/** A folder of notes and a script. */
async function notes(folder: string): Promise<string> {
  await mkdir(join(folder, 'guides'), { recursive: true })
  await writeFile(join(folder, 'guides', 'backup.md'), '# Backups\n\nRun the nightly backup with restic before midnight.\n')
  await writeFile(join(folder, 'rotate.py'), 'def rotate_logs():\n    """Rotate the service logs."""\n    return 1\n')
  return folder
}

/** A route that summarizes every file as an operations note. */
class SummaryAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async* stream(): AsyncIterable<StreamChunk> {
    const text = '{"type": "guide", "tags": ["ops"], "summary": "An operations note."}'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

interface BootOptions {
  /** The user's answers, in order; a question past the last one is rejected. */
  readonly answers?: readonly ApprovalOutcome[]
  /** Whether an approval service is composed at all. */
  readonly approval?: boolean
  /** Collections the profile configures. */
  readonly configured?: { name: string; root: string }[]
  /** More knowledge plugin configuration. */
  readonly knowledge?: Record<string, unknown>
}

/** Boot the agent loop with the knowledge plugin and its tools, answering approvals from `answers`. */
async function boot(options: BootOptions = {}): Promise<{ ctx: Context; asked: string[]; tools: Awaited<ReturnType<Context['plugin']>> }> {
  const base = await fresh()
  const ctx = new Context()
  context = ctx
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(CommandRuntime)
  const asked: string[] = []
  if (options.approval !== false) {
    const answers = [...options.answers ?? []]
    ctx.provide('approval', {
      request: (request: ApprovalRequest) => {
        asked.push(request.reason ?? '')
        return Promise.resolve(answers.shift() ?? 'rejected')
      },
    } as unknown as Context['approval'])
  }
  await ctx.plugin(Knowledge, {
    path: join(base, 'global.sqlite'), collections: options.configured ?? [], indexOnStart: false, reindexIntervalSeconds: 0, ...options.knowledge,
  })
  const tools = await ctx.plugin(KnowledgeTools)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], new SummaryAdapter())
  return { ctx, asked, tools }
}

/** A session working in `cwd`, or in no folder. */
async function agentIn(ctx: Context, name: string, cwd: string | undefined): Promise<Agent> {
  if (cwd !== undefined) await mkdir(cwd, { recursive: true })
  return ctx.agentLoop.create(SessionId(name), { provider: 'mock', model: 'mock' }, cwd === undefined ? {} : { cwd })
}

/** Call a tool as the agent. */
async function call(
  ctx: Context,
  agent: Agent | undefined,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; text: string }> {
  const result = await executeToolFixture(ctx, {
    signal: new AbortController().signal, callId: ToolCallId(`call-${name}`), name, arguments: args, ...agent === undefined ? {} : { agent },
  })
  return { isError: result.isError, text: result.content.map(block => (block.type === 'text' ? block.text : '')).join('') }
}

/** The knowledge tools the agent sees. */
function knowledgeTools(ctx: Context, agent: Agent): string[] {
  return ctx.tools.schemas(agent).map(schema => schema.name).filter(name => name.startsWith('knowledge_')).sort()
}

/** The knowledge section of the agent's system prompt, `''` when it renders nothing. */
async function section(ctx: Context, agent: Agent): Promise<string> {
  return (await ctx.systemPrompt.assemble({ scope: agent })).sections.find(entry => entry.name === 'knowledge')?.text ?? ''
}

/** Wait until `condition` holds. */
async function waitUntil(condition: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (condition()) return
    await new Promise(resolveWait => setTimeout(resolveWait, 10))
  }
  throw new Error(`never saw ${what}`)
}

describe('knowledge_add and the workspace collections a session reaches', () => {
  it('offers only knowledge_add, and no prompt section, to a session that reaches no collection', async () => {
    const { ctx } = await boot()
    const agent = await agentIn(ctx, 'bare', join(root!, 'project'))

    expect(knowledgeTools(ctx, agent)).toEqual(['knowledge_add'])
    expect(await section(ctx, agent)).toBe('')
  })

  it('indexes a folder the user approves, then every session in that workspace can search it', async () => {
    const { ctx, asked } = await boot({ answers: ['allowed-once'] })
    const workspace = join(root!, 'project')
    const docs = await notes(join(root!, 'doc'))
    const agent = await agentIn(ctx, 'asks', workspace)
    const sibling = await agentIn(ctx, 'sibling', workspace)
    const elsewhere = await agentIn(ctx, 'elsewhere', join(root!, 'other'))

    const added = await call(ctx, agent, 'knowledge_add', { path: docs })

    expect(added).toEqual({
      isError: false,
      text: `Indexed ${docs} as doc: 2 files, 2 passages. Search it with knowledge_search and cite passages by their ref.\nIts files are not summarized; the user can run /kb enrich doc.`,
    })
    expect(asked).toEqual([`Index ${docs} (about 2 files) so the sessions in ${workspace} can search it?`])
    await waitUntil(() => knowledgeTools(ctx, sibling).length === 4, 'the sibling session\'s tools')
    expect(knowledgeTools(ctx, agent)).toEqual(['knowledge_add', 'knowledge_browse', 'knowledge_read', 'knowledge_search'])
    expect(knowledgeTools(ctx, elsewhere)).toEqual(['knowledge_add'])
    expect(await section(ctx, agent)).toContain('Indexed document collections: doc.')
    expect(await section(ctx, elsewhere)).toBe('')
    expect((await call(ctx, sibling, 'knowledge_search', { query: 'nightly backup restic' })).text).toContain('[doc:guides/backup.md#L1-L3] Backups')
    expect((await call(ctx, sibling, 'knowledge_read', { ref: 'doc:rotate.py' })).text).toContain('1: def rotate_logs():')
    expect((await call(ctx, sibling, 'knowledge_browse', {})).text).toBe('doc: 2 files, 2 passages, 0 summarized')
    expect((await call(ctx, sibling, 'knowledge_browse', { collection: 'doc' })).text).toBe('guides/ (1 files)\nrotate.py')
    expect(await call(ctx, sibling, 'knowledge_search', { query: 'backup', collection: 'shared' }))
      .toEqual({ isError: true, text: expect.stringContaining('No knowledge collection shared; knowledge_browse without a collection lists the ones this session reaches.') as unknown })
  })

  it('indexes nothing when the user declines, the question is cancelled, or nobody can be asked', async () => {
    const { ctx } = await boot({ answers: ['rejected', 'cancelled'] })
    const workspace = join(root!, 'project')
    const docs = await notes(join(root!, 'doc'))
    const agent = await agentIn(ctx, 'declines', workspace)

    expect((await call(ctx, agent, 'knowledge_add', { path: docs })).text).toBe(`The user declined indexing ${docs}; nothing was indexed.`)
    expect((await call(ctx, agent, 'knowledge_add', { path: docs })).text).toBe(`The approval for indexing ${docs} was cancelled; nothing was indexed.`)
    await expect(stat(join(workspace, WORKSPACE_KNOWLEDGE_FOLDER))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(knowledgeTools(ctx, agent)).toEqual(['knowledge_add'])

    await context?.fiber.dispose()
    const unasked = await boot({ approval: false })
    const lone = await agentIn(unasked.ctx, 'lone', workspace)
    expect((await call(unasked.ctx, lone, 'knowledge_add', { path: docs })).text)
      .toBe(`This session cannot ask the user for approval, so nothing was indexed; the user can run /kb add ${docs} instead.`)
  })

  it('refuses a session without a workspace folder and a folder it cannot index', async () => {
    const { ctx } = await boot({ answers: ['allowed-once'] })
    const nowhere = await agentIn(ctx, 'nowhere', undefined)
    const agent = await agentIn(ctx, 'paths', join(root!, 'project'))

    expect(await call(ctx, nowhere, 'knowledge_add', { path: root })).toMatchObject({ isError: true, text: expect.stringContaining('needs a session with a workspace folder') as unknown })
    expect(await call(ctx, undefined, 'knowledge_add', { path: root })).toMatchObject({ isError: true })
    expect(await call(ctx, agent, 'knowledge_add', { path: 'missing' })).toMatchObject({ isError: true, text: expect.stringContaining('does not exist') as unknown })
  })

  it('asks separately before summarizing, and summarizes inline or as a job when the user agrees', async () => {
    const route = { enrichProvider: 'mock', enrichModel: 'mock' }
    const { ctx, asked } = await boot({ answers: ['allowed-once', 'rejected', 'allowed-once', 'allowed-once'], knowledge: route })
    const workspace = join(root!, 'project')
    const agent = await agentIn(ctx, 'summaries', workspace)

    const declined = await call(ctx, agent, 'knowledge_add', { path: await notes(join(root!, 'first')) })
    expect(declined.text).toContain('The user chose not to summarize its files now; /kb enrich first does it later.')
    expect(asked[1]).toBe('Also summarize the 2 files of first with mock/mock? That is one model request per file.')

    const inline = await call(ctx, agent, 'knowledge_add', { path: await notes(join(root!, 'second')) })
    expect(inline.text).toContain('Summaries: summarized 2, failed 0, 0 still waiting')

    const starts: JobSpec[] = []
    ctx.provide('jobs', { start: (spec: JobSpec) => starts.push(spec) && `knowledge-enrich-${starts.length}` } as unknown as Context['jobs'])
    const answers = ['allowed-once', 'allowed-once']
    vi.spyOn(ctx.approval, 'request').mockImplementation(() => Promise.resolve(answers.shift() as ApprovalOutcome))
    const queued = await call(ctx, agent, 'knowledge_add', { path: await notes(join(root!, 'third')) })
    expect(queued.text).toContain('Summarizing its files with mock/mock as background job knowledge-enrich-1')
    expect(starts[0]).toMatchObject({ kind: 'knowledge-enrich', label: 'knowledge_add summaries for third (2 files)' })
    expect(starts[0]?.owner).toBe(agent.session.id)
    const run = starts[0]!.run({ id: JobId('knowledge-enrich-1'), append() {}, updateProgress() {} })
    await expect(run.done).resolves.toMatchObject({ status: 'completed', detail: '2 summarized' })
  })

  it('says there is nothing to summarize when the folder holds no readable file', async () => {
    const { ctx, asked } = await boot({ answers: ['allowed-once'], knowledge: { enrichProvider: 'mock', enrichModel: 'mock' } })
    const empty = join(root!, 'empty')
    await mkdir(empty, { recursive: true })
    await writeFile(join(empty, '.env'), 'API_KEY=live')
    const agent = await agentIn(ctx, 'empty', join(root!, 'project'))

    expect((await call(ctx, agent, 'knowledge_add', { path: empty })).text).toContain('The folder holds no files the index reads, so there is nothing to summarize.')
    expect(asked).toHaveLength(1)
  })

  it('searches the configured collections and the workspace\'s together', async () => {
    const shared = await notes(join(await fresh(), 'configured', 'shared'))
    await writeFile(join(shared, 'restic.md'), '# Restic\n\nRestic keeps encrypted backup snapshots.\n')
    const { ctx } = await boot({ answers: ['allowed-once'], configured: [{ name: 'shared', root: shared }] })
    await ctx.knowledge.update()
    const agent = await agentIn(ctx, 'both', join(root!, 'project'))
    expect(knowledgeTools(ctx, agent)).toEqual(['knowledge_add', 'knowledge_browse', 'knowledge_read', 'knowledge_search'])
    await call(ctx, agent, 'knowledge_add', { path: await notes(join(root!, 'doc')) })

    const found = (await call(ctx, agent, 'knowledge_search', { query: 'restic backup' })).text
    expect(found).toContain('[shared:restic.md#L1-L3] Restic')
    expect(found).toContain('[doc:guides/backup.md#L1-L3] Backups')
    expect((await call(ctx, agent, 'knowledge_browse', {})).text).toBe('shared: 3 files, 3 passages, 0 summarized\ndoc: 2 files, 2 passages, 0 summarized')
    expect(await section(ctx, agent)).toContain('Indexed document collections: shared, doc.')
    expect((await call(ctx, undefined, 'knowledge_browse', {})).text).toBe('shared: 3 files, 3 passages, 0 summarized')
  })

  it('hides the reading tools again when the workspace loses its last folder', async () => {
    const { ctx } = await boot({ answers: ['allowed-once'] })
    const workspace = join(root!, 'project')
    const agent = await agentIn(ctx, 'loses', workspace)
    await call(ctx, agent, 'knowledge_add', { path: await notes(join(root!, 'doc')) })
    await waitUntil(() => knowledgeTools(ctx, agent).length === 4, 'the reading tools')

    await ctx.knowledgeWorkspaces.remove(workspace, 'doc')

    await waitUntil(() => knowledgeTools(ctx, agent).length === 1, 'the reading tools gone')
    expect(await section(ctx, agent)).toBe('')
  })

  it('opens a session whose workspace list cannot be read, with the reading tools hidden', async () => {
    const { ctx } = await boot()
    const workspace = join(root!, 'project')
    await mkdir(join(workspace, WORKSPACE_KNOWLEDGE_FOLDER), { recursive: true })
    await writeFile(join(workspace, WORKSPACE_KNOWLEDGE_FOLDER, 'collections.json'), '{ broken')
    const warn = vi.spyOn(ctx.logger, 'warn')

    const agent = await agentIn(ctx, 'broken', workspace)

    expect(knowledgeTools(ctx, agent)).toEqual(['knowledge_add'])
    expect(warn.mock.calls.map(entry => String(entry[0])).join('\n')).toContain('is not a workspace collection list')
  })

  it('logs, rather than throws, when a session\'s tools cannot be registered', async () => {
    const { ctx } = await boot({ answers: ['allowed-once'] })
    const workspace = join(root!, 'project')
    const agent = await agentIn(ctx, 'clash', workspace)
    agent.ctx.get('tools')!.register(defineTool({
      name: 'knowledge_search',
      description: 'Another tool that took the name.',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: () => Promise.resolve('taken'),
    }))
    const warn = vi.spyOn(ctx.logger, 'warn')

    await ctx.knowledgeWorkspaces.add(workspace, await notes(join(root!, 'doc')), undefined)

    await waitUntil(() => warn.mock.calls.some(entry => String(entry[0]).startsWith('knowledge tools:')), 'the warning')
  })

  it('drops the per-session registrations when the tools unload', async () => {
    const { ctx, tools } = await boot({ answers: ['allowed-once'] })
    const workspace = join(root!, 'project')
    const agent = await agentIn(ctx, 'unload', workspace)
    await call(ctx, agent, 'knowledge_add', { path: await notes(join(root!, 'doc')) })
    await waitUntil(() => knowledgeTools(ctx, agent).length === 4, 'the reading tools')

    await tools.dispose()

    expect(knowledgeTools(ctx, agent)).toEqual([])
  })

  it('serves only its own session when a preset mounts it for one agent', async () => {
    const base = await fresh()
    const ctx = new Context()
    context = ctx
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(Knowledge, { path: join(base, 'global.sqlite'), collections: [], indexOnStart: false, reindexIntervalSeconds: 0 })
    await ctx.plugin(AgentLoop, { agents: [] })
    const workspace = join(base, 'project')
    await ctx.knowledgeWorkspaces.add(workspace, await notes(join(base, 'doc')), undefined)
    const own = await agentIn(ctx, 'own', workspace)
    const other = await agentIn(ctx, 'other', workspace)

    await own.ctx.plugin(KnowledgeTools)

    await waitUntil(() => knowledgeTools(ctx, own).length === 4, 'its own reading tools')
    expect(knowledgeTools(ctx, own)).toEqual(['knowledge_add', 'knowledge_browse', 'knowledge_read', 'knowledge_search'])
    expect(knowledgeTools(ctx, other)).toEqual([])
    expect(await section(ctx, own)).toContain('Indexed document collections: doc.')
    expect(await section(ctx, other)).toBe('')
  })
})

describe('knowledge tool results', () => {
  it('renders summaries, folder rollups, filters, line ranges, tags, and empty results', async () => {
    const shared = await notes(join(await fresh(), 'configured', 'shared'))
    await writeFile(join(shared, 'plain.txt'), 'Water the garden plants every evening.\n')
    await writeFile(join(shared, 'guides', 'restore.md'), '# Restores\n\nRestore last night\'s snapshot first.\n')
    const { ctx } = await boot({ configured: [{ name: 'shared', root: shared }], knowledge: { enrichProvider: 'mock', enrichModel: 'mock' } })
    await ctx.knowledge.update()
    const agent = await agentIn(ctx, 'reader', join(root!, 'project'))
    const kb = ctx.commands.find(agent, 'kb')
    if (kb === undefined) throw new Error('/kb is not registered')
    await kb.handler({ commandId: CommandId('kb'), agent, rawInput: 'enrich shared', attachments: [], signal: new AbortController().signal })

    const summarized = (await call(ctx, agent, 'knowledge_search', { query: 'operations note' })).text
    expect(summarized).toContain('Matching folders:\n- [shared:] (ops) An operations note.')
    expect(summarized).toMatch(/Matching files:\n- \[shared:[^\]]+\] \(guide; ops\) An operations note\./u)
    expect((await call(ctx, agent, 'knowledge_search', { query: 'garden plants', collection: 'shared' })).text).toContain('[shared:plain.txt#L1-L1]\nWater the garden')
    expect((await call(ctx, agent, 'knowledge_search', { query: 'rotate logs', kind: 'code' })).text).toMatch(/^\[shared:rotate\.py#L1-L3\]/u)
    expect((await call(ctx, agent, 'knowledge_search', { query: 'zzzqqq' })).text).toBe('No matching passages. Try other words, a broader query, or knowledge_browse.')
    expect((await call(ctx, agent, 'knowledge_read', { ref: 'shared:rotate.py', startLine: 2, endLine: 2 })).text).toBe('shared:rotate.py lines 2-2 of 4\n2:     \"\"\"Rotate the service logs.\"\"\"')
    expect((await call(ctx, agent, 'knowledge_read', { ref: 'shared:rotate.py#L1-L1', startLine: 3 })).text).toContain('lines 3-4 of 4')
    expect((await call(ctx, agent, 'knowledge_browse', { collection: 'shared', folder: 'guides' })).text).toContain('guides/backup.md (guide; ops) An operations note.')
    expect((await call(ctx, agent, 'knowledge_browse', { collection: 'shared' })).text).toContain('guides/ (2 files) [ops] An operations note.')
    expect((await call(ctx, agent, 'knowledge_browse', { collection: 'shared', tag: 'ops' })).text).toContain('rotate.py (guide; ops) An operations note.')
    expect((await call(ctx, agent, 'knowledge_browse', { collection: 'shared', folder: 'missing' })).text).toBe('Nothing indexed here.')
    expect(ctx.tools.get('knowledge_search')?.presentCall?.({ query: 'q' })).toMatchObject({ title: 'Search knowledge: q', kind: 'search' })
    expect(ctx.tools.get('knowledge_read')?.presentCall?.({ ref: 'shared:a' })).toMatchObject({ title: 'Read knowledge: shared:a', kind: 'read' })
    expect(ctx.tools.get('knowledge_browse')?.presentCall?.({})).toMatchObject({ title: 'Browse knowledge' })
    expect(ctx.tools.get('knowledge_add')?.presentCall?.({ path: '~/doc' })).toMatchObject({ title: 'Add knowledge folder: ~/doc' })
    await expect(ctx.knowledgeWorkspaces.summarize(join(root!, 'project'), 'nope', { provider: 'mock', model: 'mock' }, new AbortController().signal))
      .rejects.toThrow('knowledge: this workspace has no collection nope')
  })

  it('offers the session\'s own route for summaries when the deployment names none', async () => {
    const { ctx, asked } = await boot({ answers: ['allowed-once', 'rejected'] })
    const agent = await agentIn(ctx, 'routed', join(root!, 'project'))
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    await call(ctx, agent, 'knowledge_add', { path: await notes(join(root!, 'doc')) })

    expect(asked[1]).toBe('Also summarize the 2 files of doc with mock/mock? That is one model request per file.')
  })

  it('registers knowledge_add in a composition without an agent registry', async () => {
    const base = await fresh()
    const ctx = new Context()
    context = ctx
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(Knowledge, { path: join(base, 'global.sqlite'), collections: [], indexOnStart: false, reindexIntervalSeconds: 0 })
    await ctx.plugin(KnowledgeTools)

    expect(ctx.tools.schemas().map(schema => schema.name).filter(name => name.startsWith('knowledge_'))).toEqual(['knowledge_add'])
  })
})

describe('/kb add from a person refreshes the sessions in that workspace', () => {
  it('shows the reading tools to a live session once a person attaches a folder', async () => {
    const { ctx } = await boot()
    const workspace = join(root!, 'project')
    const agent = await agentIn(ctx, 'person', workspace)
    const kb = ctx.commands.find(agent, 'kb')
    if (kb === undefined) throw new Error('/kb is not registered')

    await kb.handler({ commandId: CommandId('kb'), agent, rawInput: `add ${await notes(join(root!, 'doc'))}`, attachments: [], signal: new AbortController().signal })

    await waitUntil(() => knowledgeTools(ctx, agent).length === 4, 'the reading tools')
  })
})
