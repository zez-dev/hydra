import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox, unsupportedModel } from '@deepseek-ai/dsh-agent-loop-testkit'
import CommandRuntime, { CommandId } from '@deepseek-ai/dsh-commands'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { Session, SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as Knowledge from '@deepseek-ai/dsh-knowledge'
import { mergeRanked, WORKSPACE_KNOWLEDGE_FOLDER } from '@deepseek-ai/dsh-knowledge'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  vi.unstubAllEnvs()
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** The test root, created on first use and removed after each test. */
async function fresh(): Promise<string> {
  root ??= await mkdtemp(join(tmpdir(), 'dsh-knowledge-ws-'))
  return root
}

/** Wait until `condition` holds. */
async function waitUntil(condition: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (condition()) return
    await new Promise(resolveWait => setTimeout(resolveWait, 10))
  }
  throw new Error(`never saw ${what}`)
}

/** A folder of notes and a script, under the test root. */
async function notes(folder: string): Promise<string> {
  await mkdir(join(folder, 'guides'), { recursive: true })
  await writeFile(join(folder, 'guides', 'backup.md'), '# Backups\n\nRun the nightly backup with restic before midnight.\n')
  await writeFile(join(folder, 'rotate.py'), 'def rotate_logs():\n    """Rotate the service logs."""\n    return 1\n')
  return folder
}

/** Boot the knowledge plugin with the given configured collections and extra configuration. */
async function boot(collections: { name: string; root: string }[] = [], extra: Record<string, unknown> = {}): Promise<Context> {
  const base = await fresh()
  const ctx = new Context()
  context = ctx
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(Knowledge, { path: join(base, 'global.sqlite'), collections, indexOnStart: false, reindexIntervalSeconds: 0, ...extra })
  return ctx
}

/** Register an agent whose session works in `cwd`, or in no folder. */
async function agentIn(ctx: Context, name: string, cwd: string | undefined): Promise<Agent> {
  const scope = ctx.plugin(() => {})
  const id = SessionId(name)
  const header: SessionHeader = cwd === undefined
    ? { version: SESSION_FORMAT_VERSION, id, createdAt: 0, isSeeded: false }
    : { version: SESSION_FORMAT_VERSION, id, createdAt: 0, isSeeded: false, cwd }
  const agent: Agent = {
    id, options: {}, session: Session.create(id, [], header), model: unsupportedModel(), inbox: unsupportedInbox(),
    status: 'idle', ctx: scope.ctx,
    followup: () => {}, steer: () => {}, inject: () => {}, send: () => {}, cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  await ctx.agents.register(agent)
  return agent
}

/** Run `/kb <input>` as the agent and return the reply text, failing on an error reply. */
async function kb(ctx: Context, agent: Agent, input: string): Promise<string> {
  const result = await run(ctx, agent, input)
  if (result.kind !== 'success') throw new Error(`/kb ${input} failed: ${JSON.stringify(result)}`)
  return result.text ?? ''
}

/** Run `/kb <input>` as the agent. */
async function run(ctx: Context, agent: Agent, input: string): Promise<CommandResult & { text?: string }> {
  const command = ctx.commands.find(agent, 'kb')
  if (command === undefined) throw new Error('/kb is not registered')
  return await command.handler({ commandId: CommandId('kb'), agent, rawInput: input, attachments: [], signal: new AbortController().signal })
}

/** Wait until `/kb` as the agent reports `expected`. */
async function waitForListing(ctx: Context, agent: Agent, expected: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if ((await kb(ctx, agent, '')).includes(expected)) return
    await new Promise(resolveWait => setTimeout(resolveWait, 10))
  }
  throw new Error(`/kb never listed ${expected}`)
}

describe('workspace collections through /kb', () => {
  it('attaches a folder to the session\'s workspace, lists it, and searches it', async () => {
    const ctx = await boot()
    const workspace = join(root!, 'project')
    await mkdir(workspace)
    const docs = await notes(join(root!, 'doc'))
    const agent = await agentIn(ctx, 'here', workspace)

    const added = await kb(ctx, agent, `add ${docs}`)

    expect(added).toContain(`Indexed ${docs} as doc for this workspace: 2 files, 2 passages.`)
    expect(added).toContain('/kb enrich doc summarizes them')
    expect(await kb(ctx, agent, '')).toBe(`doc: 2 files, 2 passages, 0 summarized (${docs}), this workspace`)
    expect(await kb(ctx, agent, 'list')).toBe(await kb(ctx, agent, ''))
    expect(await ctx.knowledgeWorkspaces.countFiles(docs)).toBe(2)
    await expect(ctx.knowledgeWorkspaces.countFiles(docs, AbortSignal.abort())).rejects.toThrow()
    expect(await kb(ctx, agent, 'search nightly backup restic')).toContain('doc:guides/backup.md#L1-L3')
    const stored = JSON.parse(await readFile(join(workspace, WORKSPACE_KNOWLEDGE_FOLDER, 'collections.json'), 'utf8')) as unknown
    expect(stored).toEqual({ version: 1, collections: [{ name: 'doc', root: docs }] })
  })

  it('keeps each workspace\'s collections to the sessions in that workspace', async () => {
    const ctx = await boot()
    const first = join(root!, 'first')
    const second = join(root!, 'second')
    await mkdir(first)
    await mkdir(second)
    const docs = await notes(join(root!, 'doc'))
    const inFirst = await agentIn(ctx, 'first', first)
    const inSecond = await agentIn(ctx, 'second', second)
    await kb(ctx, inFirst, `add ${docs}`)

    expect(await kb(ctx, inSecond, '')).toContain('No knowledge collections.')
    expect(await kb(ctx, inSecond, 'search nightly backup')).toBe('No matching passages.')
  })

  it('names a collection after its folder and keeps every name unique', async () => {
    const ctx = await boot([{ name: 'doc', root: await notes(join(await fresh(), 'configured', 'doc')) }])
    const workspace = join(root!, 'project')
    await mkdir(workspace)
    const agent = await agentIn(ctx, 'names', workspace)

    expect(await kb(ctx, agent, `add ${await notes(join(root!, 'a', 'doc'))}`)).toContain(' as doc-2 ')
    expect(await kb(ctx, agent, `add ${await notes(join(root!, 'b', 'doc'))}`)).toContain(' as doc-3 ')
    expect(await kb(ctx, agent, `add ${await notes(join(root!, 'My Notes!'))}`)).toContain(' as My-Notes- ')
    expect(await kb(ctx, agent, `add ${await notes(join(root!, '__'))}`)).toContain(' as docs ')
    expect(await kb(ctx, agent, `add ${await notes(join(root!, 'c'))} --name team_notes`)).toContain(' as team_notes ')
    expect(await run(ctx, agent, `add ${await notes(join(root!, 'd'))} --name team_notes`))
      .toEqual({ kind: 'error', text: 'knowledge: a collection named team_notes already exists' })
    expect(await run(ctx, agent, `add ${await notes(join(root!, 'e'))} --name doc`))
      .toEqual({ kind: 'error', text: 'knowledge: a collection named doc already exists' })
    expect(await run(ctx, agent, `add ${await notes(join(root!, 'f'))} --name -bad`))
      .toEqual({ kind: 'error', text: 'knowledge: collection name "-bad" must use letters, digits, - and _' })
  })

  it('resolves a folder relative to the workspace or under the home folder, and refuses what it cannot index', async () => {
    const ctx = await boot()
    const workspace = join(root!, 'project')
    await notes(join(workspace, 'handbook'))
    await notes(join(root!, 'home', 'library'))
    vi.stubEnv('HOME', join(root!, 'home'))
    const agent = await agentIn(ctx, 'paths', workspace)

    expect(await kb(ctx, agent, 'add handbook')).toContain(`Indexed ${join(workspace, 'handbook')} as handbook`)
    expect(await kb(ctx, agent, 'add ~/library')).toContain(`Indexed ${join(root!, 'home', 'library')} as library`)
    expect(await kb(ctx, agent, 'add ~')).toContain(`Indexed ${join(root!, 'home')} as home`)
    await expect(ctx.knowledgeWorkspaces.add(workspace, '   ', undefined)).rejects.toThrow('knowledge: name the folder to index')
    expect(await run(ctx, agent, 'add ./handbook'))
      .toEqual({ kind: 'error', text: `knowledge: ${join(workspace, 'handbook')} is already indexed as handbook` })
    expect(await run(ctx, agent, 'add /')).toEqual({ kind: 'error', text: 'knowledge: / is a whole disk; name a documents folder' })
    expect(await run(ctx, agent, 'add missing')).toEqual({ kind: 'error', text: `knowledge: ${join(workspace, 'missing')} does not exist` })
    expect(await run(ctx, agent, 'add handbook/rotate.py'))
      .toEqual({ kind: 'error', text: `knowledge: ${join(workspace, 'handbook', 'rotate.py')} is not a folder` })
    expect(await run(ctx, agent, 'add')).toMatchObject({ kind: 'error', text: expect.stringContaining('Usage: /kb') as unknown })
    expect(await run(ctx, agent, 'add   --name x')).toMatchObject({ kind: 'error' })
  })

  it('refuses to attach a folder in a session without a workspace folder', async () => {
    const ctx = await boot()
    const agent = await agentIn(ctx, 'nowhere', undefined)

    expect(await run(ctx, agent, `add ${root!}`)).toEqual({ kind: 'error', text: 'This session has no workspace folder to attach a collection to.' })
    expect(await run(ctx, agent, 'remove doc')).toEqual({ kind: 'error', text: 'This workspace has no collection doc.' })
  })

  it('detaches a workspace collection and drops its files, but never a configured one', async () => {
    const configured = await notes(join(await fresh(), 'configured', 'shared'))
    const ctx = await boot([{ name: 'shared', root: configured }])
    await ctx.knowledge.update()
    const workspace = join(root!, 'project')
    await mkdir(workspace)
    const docs = await notes(join(root!, 'doc'))
    const agent = await agentIn(ctx, 'remove', workspace)
    await kb(ctx, agent, `add ${docs}`)

    expect(await run(ctx, agent, 'remove shared')).toEqual({ kind: 'error', text: 'shared is configured in the profile\'s cordis.patch.yml; remove it there.' })
    expect(await run(ctx, agent, 'remove nothing')).toEqual({ kind: 'error', text: 'This workspace has no collection nothing.' })
    expect(await run(ctx, agent, 'remove')).toMatchObject({ kind: 'error', text: expect.stringContaining('Usage: /kb') as unknown })
    expect(await kb(ctx, agent, 'remove doc')).toBe('Removed doc from this workspace; 2 file(s) dropped from its index.')
    expect(await kb(ctx, agent, '')).toBe(`shared: 2 files, 2 passages, 0 summarized (${configured})`)
    const stored = JSON.parse(await readFile(join(workspace, WORKSPACE_KNOWLEDGE_FOLDER, 'collections.json'), 'utf8')) as unknown
    expect(stored).toEqual({ version: 1, collections: [] })
    expect(await kb(ctx, agent, `add ${docs}`)).toContain(' as doc ')
  })

  it('fails loud on a collection list it cannot trust, naming the file', async () => {
    const ctx = await boot([{ name: 'shared', root: await notes(join(await fresh(), 'configured', 'shared')) }])
    const lists = {
      broken: '{ not json',
      future: JSON.stringify({ version: 2, collections: [] }),
      clash: JSON.stringify({ version: 1, collections: [{ name: 'shared', root: '/tmp' }] }),
      badname: JSON.stringify({ version: 1, collections: [{ name: '-x', root: '/tmp' }] }),
    }
    for (const [name, text] of Object.entries(lists)) {
      const workspace = join(root!, name)
      const file = join(workspace, WORKSPACE_KNOWLEDGE_FOLDER, 'collections.json')
      await mkdir(join(workspace, WORKSPACE_KNOWLEDGE_FOLDER), { recursive: true })
      await writeFile(file, text)
      const result = await run(ctx, await agentIn(ctx, name, workspace), '')
      expect(result).toMatchObject({ kind: 'error', text: expect.stringContaining(file) as unknown })
    }
    const unreadable = join(root!, 'unreadable')
    await mkdir(join(unreadable, WORKSPACE_KNOWLEDGE_FOLDER, 'collections.json'), { recursive: true })
    expect(await run(ctx, await agentIn(ctx, 'unreadable', unreadable), '')).toMatchObject({ kind: 'error', text: expect.stringContaining('EISDIR') as unknown })
  })

  it('reindexes, summarizes, and embeds a workspace collection by its name', async () => {
    const ctx = await boot()
    const workspace = join(root!, 'project')
    await mkdir(workspace)
    const docs = await notes(join(root!, 'doc'))
    const agent = await agentIn(ctx, 'runs', workspace)
    await kb(ctx, agent, `add ${docs}`)
    await writeFile(join(docs, 'later.txt'), 'A note written after the folder was attached.\n')

    expect(await kb(ctx, agent, 'reindex doc')).toMatch(/^Knowledge index: indexed 1, unchanged 2, removed 0, skipped 0 in /u)
    expect(await kb(ctx, agent, 'reindex')).toMatch(/^Knowledge index: indexed 0, unchanged 3, removed 0, skipped 0 in /u)
    expect(await run(ctx, agent, 'reindex other')).toEqual({ kind: 'error', text: 'No knowledge collection other.' })
    ctx.llm.registerAdapter(['mock'], new SummaryAdapter())
    const summarizer = { ...agent, options: { provider: 'mock', model: 'mock' } }
    expect(await kb(ctx, summarizer, 'enrich doc')).toContain('summarized 3, failed 0, 0 still waiting')
    expect(await kb(ctx, summarizer, 'enrich')).toBe('Every indexed file already has a summary, and every folder rollup is current.')
    expect(await run(ctx, agent, 'embed doc')).toEqual({ kind: 'error', text: 'No embedding endpoint is configured: set `embeddings` on the knowledge plugin.' })
  })

  it('refreshes a workspace\'s index when a later process opens it, without any command', async () => {
    const ctx = await boot()
    const workspace = join(root!, 'project')
    await mkdir(workspace)
    const docs = await notes(join(root!, 'doc'))
    await kb(ctx, await agentIn(ctx, 'before', workspace), `add ${docs}`)
    await context?.fiber.dispose()
    await writeFile(join(docs, 'later.txt'), 'A note written while no process ran.\n')

    const restarted = await boot()
    await waitForListing(restarted, await agentIn(restarted, 'after', workspace), 'doc: 3 files')
  })

  it('says when nothing is in reach, and shows usage for a bare search or an unknown verb', async () => {
    const ctx = await boot()
    const agent = await agentIn(ctx, 'empty', join(root!, 'project'))

    expect(await kb(ctx, agent, 'reindex')).toContain('No knowledge collections.')
    expect(await run(ctx, agent, 'search')).toMatchObject({ kind: 'error', text: expect.stringContaining('Usage: /kb') as unknown })
    expect(await run(ctx, agent, 'frobnicate')).toMatchObject({ kind: 'error', text: expect.stringContaining('Usage: /kb') as unknown })
  })

  it('reports the files an added folder skips, and lists a heading-less hit by its ref alone', async () => {
    const ctx = await boot()
    const workspace = join(root!, 'project')
    await mkdir(workspace)
    const docs = await notes(join(root!, 'doc'))
    await writeFile(join(docs, '.env'), 'API_KEY=live')
    await writeFile(join(docs, 'plain.txt'), 'Water the garden plants every evening.\n')
    const agent = await agentIn(ctx, 'skips', workspace)

    expect(await kb(ctx, agent, `add ${docs}`)).toContain('as doc for this workspace: 3 files, 3 passages, 1 skipped.')
    expect(await kb(ctx, agent, 'search garden plants evening')).toBe('doc:plain.txt#L1-L1')
  })

  it('keeps an open workspace current on the timer and embeds its new passages', async () => {
    const embeddings = { baseURL: 'http://127.0.0.1:1/v1', model: 'unreachable', timeoutMs: 2000 }
    const ctx = await boot([], { reindexIntervalSeconds: 1, embeddings })
    const workspace = join(root!, 'project')
    await mkdir(workspace)
    const docs = await notes(join(root!, 'doc'))
    const agent = await agentIn(ctx, 'timer', workspace)
    await kb(ctx, agent, `add ${docs}`)
    await writeFile(join(docs, 'later.txt'), 'A note the timer pass picks up.\n')

    await waitForListing(ctx, agent, 'doc: 3 files')
    expect(await kb(ctx, agent, '')).toContain('embeddings: 0 passages embedded, 3 waiting')
    expect(await kb(ctx, agent, 'embed doc')).toBe('Knowledge embeddings: embedded 0 passages, 1 batch(es) failed, 3 still waiting.')
  })

  it('logs a refresh that fails, for the configured collections and for a workspace', async () => {
    const ctx = await boot([{ name: 'shared', root: await notes(join(await fresh(), 'configured', 'shared')) }], { reindexIntervalSeconds: 1 })
    const workspace = join(root!, 'project')
    await mkdir(workspace)
    await ctx.knowledgeWorkspaces.add(workspace, await notes(join(root!, 'doc')), undefined)
    const entry = await ctx.knowledgeWorkspaces.open(workspace)
    const warn = vi.spyOn(ctx.logger, 'warn')
    vi.spyOn(ctx.knowledge, 'update').mockRejectedValueOnce(new Error('configured disk gone'))
    vi.spyOn(entry!.index, 'update').mockRejectedValueOnce(new Error('workspace disk gone'))

    await waitUntil(() => warn.mock.calls.length >= 2, 'two warnings')

    expect(warn.mock.calls.map(call => String(call[0]))).toEqual(expect.arrayContaining([
      'knowledge index update failed: configured disk gone',
      `knowledge index update for ${workspace} failed: workspace disk gone`,
    ]))
  })

  it('records every folder when two are attached at once', async () => {
    const ctx = await boot()
    const workspace = join(root!, 'project')
    await mkdir(workspace)
    const first = await notes(join(root!, 'first'))
    const second = await notes(join(root!, 'second'))

    await Promise.all([ctx.knowledgeWorkspaces.add(workspace, first, undefined), ctx.knowledgeWorkspaces.add(workspace, second, undefined)])

    const entry = await ctx.knowledgeWorkspaces.open(workspace)
    expect(entry?.collections.map(collection => collection.name).sort()).toEqual(['first', 'second'])
  })

  it('opens a workspace once for concurrent callers and keeps it open while a folder remains', async () => {
    const ctx = await boot()
    const workspace = join(root!, 'project')
    await mkdir(workspace)
    await ctx.knowledgeWorkspaces.add(workspace, await notes(join(root!, 'first')), undefined)
    await ctx.knowledgeWorkspaces.add(workspace, await notes(join(root!, 'second')), undefined)
    await context?.fiber.dispose()
    const restarted = await boot()

    const [one, two] = await Promise.all([restarted.knowledgeWorkspaces.open(workspace), restarted.knowledgeWorkspaces.open(workspace)])
    expect(one).toBe(two)
    await restarted.knowledgeWorkspaces.remove(workspace, 'first')
    expect((await restarted.knowledgeWorkspaces.open(workspace))?.collections.map(collection => collection.name)).toEqual(['second'])
    await expect(restarted.knowledgeWorkspaces.remove(workspace, 'first')).rejects.toThrow('knowledge: this workspace has no collection first')
  })

  it('closes the workspace indexes when the plugin unloads', async () => {
    const ctx = await boot()
    const workspace = join(root!, 'project')
    await mkdir(workspace)
    await ctx.knowledgeWorkspaces.add(workspace, await notes(join(root!, 'doc')), undefined)
    const workspaces = ctx.knowledgeWorkspaces

    await context?.fiber.dispose()
    context = undefined

    expect(workspaces.list()).toEqual([])
  })
})

describe('merging rankings from several indexes', () => {
  it('interleaves the lists by rank and stops at the limit', () => {
    expect(mergeRanked([['a1', 'a2', 'a3'], ['b1']], 3)).toEqual(['a1', 'b1', 'a2'])
    expect(mergeRanked([], 5)).toEqual([])
  })
})

/** A route that summarizes every file as a backup guide. */
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
