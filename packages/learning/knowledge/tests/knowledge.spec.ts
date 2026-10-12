import { mkdir, mkdtemp, rm, stat, unlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import CommandRuntime, { CommandId } from '@deepseek-ai/dsh-commands'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import LlmRuntime, { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { JobStart } from '@deepseek-ai/dsh-jobs'
import * as Knowledge from '@deepseek-ai/dsh-knowledge'
import * as KnowledgeTools from '@deepseek-ai/dsh-knowledge/tools'
import { chunkFile, KnowledgeIndex, matchExpression, parseRef } from '@deepseek-ai/dsh-knowledge'

let root: string | undefined
let context: Context | undefined
const indexes: KnowledgeIndex[] = []

afterEach(async () => {
  for (const index of indexes.splice(0)) index.close()
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

const LEAVE_POLICY = [
  '# Leave policy',
  '',
  'This policy covers every kind of leave.',
  '',
  '## Annual leave',
  '',
  'Employees accrue annual leave monthly. Up to five days of unused annual leave carry over into the next year.',
  '',
  '## Sick leave',
  '',
  'Sick leave needs a medical certificate after three consecutive days.',
].join('\n')

const DEPLOY_SCRIPT = [
  '#!/usr/bin/env bash',
  'set -euo pipefail',
  '',
  'deploy() {',
  '  kubectl apply -f manifests/',
  '}',
  '',
  'rollback() {',
  '  kubectl rollout undo deployment/web',
  '}',
].join('\n')

/** Write a small corpus: two collections, a binary file, an oversized file, and a `.git` folder. */
async function corpus(): Promise<{ docs: string; tools: string }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-knowledge-'))
  const docs = join(root, 'docs')
  const tools = join(root, 'tools')
  await mkdir(join(docs, 'hr'), { recursive: true })
  await mkdir(join(docs, '.git'), { recursive: true })
  await mkdir(tools, { recursive: true })
  await writeFile(join(docs, 'hr', 'leave.md'), LEAVE_POLICY)
  await writeFile(join(docs, 'tips.txt'), 'Tip: press ctrl+r in bash to search command history.\n')
  await writeFile(join(docs, '.git', 'config'), 'annual leave inside git metadata')
  await writeFile(join(docs, 'image.png'), 'not really an image')
  await writeFile(join(docs, 'blob.txt'), 'binary\u0000content annual')
  await writeFile(join(docs, 'huge.md'), `annual ${'x'.repeat(5000)}`)
  await writeFile(join(tools, 'deploy.sh'), DEPLOY_SCRIPT)
  return { docs, tools }
}

async function openIndex(
  collections: { name: string; root: string }[],
  maxFileBytes = 4096,
  excludeDirs: string[] = ['.git'],
): Promise<KnowledgeIndex> {
  const index = await KnowledgeIndex.open({
    path: ':memory:',
    excludeDirs,
    maxFileBytes,
    maxDocumentBytes: 1048576,
    bounds: { targetChars: 2400, maxChars: 4800 },
    hitChars: 1500,
    maxReadLines: 5,
  }, collections)
  indexes.push(index)
  return index
}

describe('chunking', () => {
  it('splits Markdown at headings and keeps the heading path', () => {
    const chunks = chunkFile(LEAVE_POLICY, 'text', { targetChars: 2400, maxChars: 4800 })
    expect(chunks.map(chunk => chunk.heading)).toEqual(['Leave policy', 'Leave policy › Annual leave', 'Leave policy › Sick leave'])
    expect(chunks[1]).toMatchObject({ startLine: 5, endLine: 7 })
  })

  it('treats # lines as headings only in Markdown files', () => {
    const yaml = ['# comment about the file', 'key: value', '# another comment', 'other: 2'].join('\n')
    expect(chunkFile(yaml, 'text', { targetChars: 2400, maxChars: 4800 }, false).map(chunk => chunk.heading)).toEqual([''])
  })

  it('splits code at top-level definitions', () => {
    const chunks = chunkFile(DEPLOY_SCRIPT, 'code', { targetChars: 2400, maxChars: 4800 })
    expect(chunks.map(chunk => chunk.heading)).toEqual(['', 'deploy() {', 'rollback() {'])
  })

  it('ends a long section at a paragraph break once it passes the target size', () => {
    const paragraph = 'word '.repeat(60).trim()
    const text = Array.from({ length: 6 }, () => paragraph).join('\n\n')
    const chunks = chunkFile(text, 'text', { targetChars: 400, maxChars: 4800 })
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every(chunk => chunk.text.length <= 800)).toBe(true)
  })
})

describe('the knowledge index', () => {
  it('indexes supported files, skipping excluded folders, binary, oversized, and unsupported files', async () => {
    const { docs, tools } = await corpus()
    const index = await openIndex([{ name: 'docs', root: docs }, { name: 'tools', root: tools }])
    const report = await index.update()
    expect(report).toMatchObject({ indexed: 3, unchanged: 0, removed: 0, skipped: 3 })
    expect(index.stats()).toEqual([
      { name: 'docs', root: docs, files: 2, passages: 4, summarized: 0 },
      { name: 'tools', root: tools, files: 1, passages: 3, summarized: 0 },
    ])
  })

  it('never indexes secret files or credential folders, whatever the exclude list says', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-knowledge-'))
    const docs = join(root, 'docs')
    const files: Record<string, string> = {
      'notes.md': 'deploy notes',
      '.env': 'API_KEY=live',
      '.env.local': 'API_KEY=local',
      '.env.example': 'API_KEY=replace-me',
      'prod.env': 'DB_PASSWORD=hunter2',
      'id_rsa': '-----BEGIN OPENSSH PRIVATE KEY-----',
      'id_ed25519': '-----BEGIN OPENSSH PRIVATE KEY-----',
      'id_ed25519.pub': 'ssh-ed25519 AAAA public key',
      'server.pem': '-----BEGIN PRIVATE KEY-----',
      'tls.key': '-----BEGIN PRIVATE KEY-----',
      '.netrc': 'machine example.com login me password pw',
      '.npmrc': '//registry.npmjs.org/:_authToken=abc',
      '.pypirc': '[pypi]\npassword = abc',
      '.pgpass': 'host:5432:db:user:pw',
      '.git-credentials': 'https://me:pw@example.com',
      'credentials.json': '{"token":"abc"}',
      '.credentials.yaml': 'key: abc',
      'client_secret.json': '{"secret":"abc"}',
      '.ssh/config': 'Host example',
      '.gnupg/notes.txt': 'gpg notes',
      '.aws/config': '[default]',
      '.kube/config': 'token: abc',
      '.docker/config.json': '{"auths":{}}',
    }
    for (const [path, text] of Object.entries(files)) {
      await mkdir(dirname(join(docs, path)), { recursive: true })
      await writeFile(join(docs, path), text)
    }
    const index = await openIndex([{ name: 'docs', root: docs }], 4096, [])
    await index.update()
    expect(index.browse('docs', '').map(entry => entry.path)).toEqual(['notes.md'])
  })

  it('ranks the passage that answers a question first and cites it by file and lines', async () => {
    const { docs, tools } = await corpus()
    const index = await openIndex([{ name: 'docs', root: docs }, { name: 'tools', root: tools }])
    await index.update()
    const [best] = index.search({ query: 'How many days of annual leave carry over?', limit: 5 })
    expect(best).toMatchObject({ ref: 'docs:hr/leave.md#L5-L7', heading: 'Leave policy › Annual leave', kind: 'text' })
    expect(index.search({ query: 'annual leave', collection: 'tools', limit: 5 })).toEqual([])
    const [code] = index.search({ query: 'rollback deployment', kind: 'code', limit: 5 })
    expect(code).toMatchObject({ ref: 'tools:deploy.sh#L8-L10', heading: 'rollback() {' })
  })

  it('reindexes only changed files and drops deleted ones', async () => {
    const { docs, tools } = await corpus()
    const index = await openIndex([{ name: 'docs', root: docs }, { name: 'tools', root: tools }])
    await index.update()
    expect(await index.update()).toMatchObject({ indexed: 0, unchanged: 3, removed: 0 })

    const tips = join(docs, 'tips.txt')
    await writeFile(tips, 'Tip: use git worktree to keep two branches checked out.\n')
    const later = new Date(Date.now() + 5000)
    await utimes(tips, later, later)
    await unlink(join(tools, 'deploy.sh'))
    expect(await index.update()).toMatchObject({ indexed: 1, unchanged: 1, removed: 1 })
    expect(index.search({ query: 'worktree branches', limit: 5 })[0]?.ref).toBe('docs:tips.txt#L1-L1')
    expect(index.search({ query: 'ctrl history', limit: 5 })).toEqual([])
    expect(index.search({ query: 'rollback', limit: 5 })).toEqual([])
  })

  it('forgets a collection that is no longer configured', async () => {
    const { docs, tools } = await corpus()
    const path = join(root!, 'index.sqlite')
    const options = { path, excludeDirs: ['.git'], maxFileBytes: 4096, maxDocumentBytes: 1048576, bounds: { targetChars: 2400, maxChars: 4800 }, hitChars: 1500, maxReadLines: 5 }
    const first = await KnowledgeIndex.open(options, [{ name: 'docs', root: docs }, { name: 'tools', root: tools }])
    await first.update()
    first.close()
    const second = await KnowledgeIndex.open(options, [{ name: 'docs', root: docs }])
    indexes.push(second)
    expect(await second.update()).toMatchObject({ removed: 1, unchanged: 2 })
    expect(second.search({ query: 'rollback', limit: 5 })).toEqual([])
  })

  it('reads bounded line ranges and refuses paths outside the collection', async () => {
    const { docs } = await corpus()
    const index = await openIndex([{ name: 'docs', root: docs }])
    const read = await index.read('docs', 'hr/leave.md', 5, 100)
    expect(read).toMatchObject({ startLine: 5, endLine: 9, totalLines: 11 })
    expect(read.text.split('\n')[0]).toBe('5: ## Annual leave')
    await expect(index.read('docs', '../tools/deploy.sh')).rejects.toThrow(/outside the collection/)
    await expect(index.read('other', 'hr/leave.md')).rejects.toThrow(/unknown collection/)
  })

  it('lists folders and files under a folder', async () => {
    const { docs } = await corpus()
    const index = await openIndex([{ name: 'docs', root: docs }])
    await index.update()
    expect(index.browse('docs')).toEqual([
      { path: 'hr', type: 'folder', files: 1 },
      { path: 'tips.txt', type: 'file', files: 1 },
    ])
    expect(index.browse('docs', 'hr')).toEqual([{ path: 'hr/leave.md', type: 'file', files: 1 }])
  })

  it('opens no database and creates no file when no collection is configured', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-knowledge-'))
    const path = join(root, 'kb', 'index.sqlite')
    const options = {
      path, excludeDirs: [], maxFileBytes: 1, maxDocumentBytes: 1, bounds: { targetChars: 1, maxChars: 2 }, hitChars: 1, maxReadLines: 1,
    }
    const index = await KnowledgeIndex.open(options, [])
    indexes.push(index)
    expect(await index.update()).toMatchObject({ indexed: 0, removed: 0 })
    expect(index.stats()).toEqual([])
    expect(index.search({ query: 'anything', limit: 5 })).toEqual([])
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses a database that belongs to another application', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-knowledge-'))
    const path = join(root, 'other.sqlite')
    const { DatabaseSync } = await import('node:sqlite')
    const other = new DatabaseSync(path)
    other.exec('CREATE TABLE unrelated (x INTEGER)')
    other.close()
    const options = {
      path, excludeDirs: [], maxFileBytes: 1, maxDocumentBytes: 1, bounds: { targetChars: 1, maxChars: 2 }, hitChars: 1, maxReadLines: 1,
    }
    await expect(KnowledgeIndex.open(options, [{ name: 'docs', root }]))
      .rejects.toThrow(/not a knowledge index/)
  })
})

describe('query and ref parsing', () => {
  it('turns free text into prefix terms without stop words', () => {
    expect(matchExpression('How do I roll back the deploy?')).toBe('"roll" OR "back" OR "deploy"*')
    expect(matchExpression('the of and')).toBeUndefined()
  })

  it('splits a ref into collection, path, and lines', () => {
    expect(parseRef('docs:hr/leave.md#L5-L8')).toEqual({ collection: 'docs', path: 'hr/leave.md', startLine: 5, endLine: 8 })
    expect(parseRef('docs:hr/leave.md')).toEqual({ collection: 'docs', path: 'hr/leave.md' })
    expect(() => parseRef('hr/leave.md')).toThrow(/collection:path/)
  })
})

/**
 * Boot the knowledge plugin and its tools through the real Loader from a cordis.yml.
 * @param collectionLines - YAML lines for `collections`, or none.
 * @returns the booted context.
 */
async function boot(collectionLines: readonly string[], extraLines: readonly string[] = []): Promise<Context> {
  root ??= await mkdtemp(join(tmpdir(), 'dsh-knowledge-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-llm'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-commands'",
    "- name: '@deepseek-ai/dsh-knowledge'",
    '  config:',
    `    path: ${JSON.stringify(join(root, 'kb', 'index.sqlite'))}`,
    '    maxFileBytes: 4096',
    ...collectionLines.length > 0 ? ['    collections:', ...collectionLines] : ['    collections: []'],
    ...extraLines,
    "- name: '@deepseek-ai/dsh-knowledge/tools'",
    '',
  ].join('\n'))
  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-commands', CommandRuntime],
    ['@deepseek-ai/dsh-knowledge', Knowledge],
    ['@deepseek-ai/dsh-knowledge/tools', KnowledgeTools],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  return ctx
}

async function fakeAgent(ctx: Context, cwd?: string): Promise<Agent> {
  const scope = ctx.plugin(() => {})
  const id = SessionId('knowledge-agent')
  const session = cwd === undefined
    ? Session.create(id)
    : Session.create(id, [], { version: SESSION_FORMAT_VERSION, id, createdAt: 0, isSeeded: false, cwd })
  const value: Agent = {
    id, options: {}, session, inbox: unsupportedInbox(),
    status: 'idle', ctx: scope.ctx,
    followup: () => {}, steer: () => {}, inject: () => {}, send: () => {}, cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  await ctx.agents.register(value)
  return value
}

/** A route that summarizes every file as a leave policy guide. */
class SummaryAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async* stream(): AsyncIterable<StreamChunk> {
    const text = '{"type": "guide", "tags": ["hr"], "summary": "A leave policy."}'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function resultText(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

describe('knowledge real Loader composition through cordis.yml', () => {
  it('indexes the configured folders at start and answers through the model tools and /kb', async () => {
    const { docs } = await corpus()
    const ctx = await boot(['      - name: docs', `        root: ${JSON.stringify(docs)}`])
    await ctx.knowledge.update()
    const signal = new AbortController().signal

    const found = await ctx.tools.execute({ signal, callId: ToolCallId('k1'), name: 'knowledge_search', arguments: { query: 'sick leave certificate' } })
    expect(found.isError).toBe(false)
    expect(resultText(found)).toContain('[docs:hr/leave.md#L9-L11] Leave policy › Sick leave')

    const read = await ctx.tools.execute({ signal, callId: ToolCallId('k2'), name: 'knowledge_read', arguments: { ref: 'docs:hr/leave.md#L9-L11' } })
    expect(resultText(read)).toContain('11: Sick leave needs a medical certificate')

    const escaped = await ctx.tools.execute({ signal, callId: ToolCallId('k3'), name: 'knowledge_read', arguments: { ref: 'docs:../secret' } })
    expect(escaped.isError).toBe(true)

    const listed = await ctx.tools.execute({ signal, callId: ToolCallId('k4'), name: 'knowledge_browse', arguments: {} })
    expect(resultText(listed)).toBe('docs: 2 files, 4 passages, 0 summarized')

    const assembly = await ctx.systemPrompt.assemble()
    expect(assembly.sections.find(section => section.name === 'knowledge')?.text).toContain('Indexed document collections: docs.')

    const agent = await fakeAgent(ctx)
    const kb = ctx.commands.find(agent, 'kb')
    if (kb === undefined) throw new Error('/kb is not registered')
    const stats = await kb.handler({ commandId: CommandId('kb-1'), agent, rawInput: '', attachments: [], signal })
    expect(stats).toMatchObject({ kind: 'success' })
    expect((stats as { text: string }).text).toContain('docs: 2 files, 4 passages, 0 summarized')
    const hits = await kb.handler({ commandId: CommandId('kb-2'), agent, rawInput: 'search medical certificate', attachments: [], signal })
    expect((hits as { text: string }).text).toContain('docs:hr/leave.md#L9-L11')

    // /kb enrich runs inline without a job registry, over the session's route.
    ctx.llm.registerAdapter(['mock'], new SummaryAdapter())
    const enriched = await kb.handler({ commandId: CommandId('kb-3'), agent: { ...agent, options: { provider: 'mock', model: 'mock' } }, rawInput: 'enrich docs', attachments: [], signal })
    expect((enriched as { text: string }).text).toContain('summarized 2, failed 0, 0 still waiting')
    const summarized = await ctx.tools.execute({ signal, callId: ToolCallId('k5'), name: 'knowledge_search', arguments: { query: 'leave policy certificate' } })
    expect(resultText(summarized)).toContain('Matching files:\n- [docs:hr/leave.md] (guide; hr) A leave policy.')
  })

  it('attaches a workspace folder with /kb add and answers through the model tools', async () => {
    const { docs } = await corpus()
    const ctx = await boot([])
    const workspace = join(root!, 'project')
    await mkdir(workspace, { recursive: true })
    const agent = await fakeAgent(ctx, workspace)
    const signal = new AbortController().signal
    const knowledgeTools = (): string[] => ctx.tools.schemas(agent).map(schema => schema.name).filter(name => name.startsWith('knowledge_'))
    expect(knowledgeTools()).toEqual(['knowledge_add'])

    const unasked = await ctx.tools.execute({ signal, callId: ToolCallId('k-add'), name: 'knowledge_add', arguments: { path: docs }, agent })
    expect(resultText(unasked)).toBe(`This session cannot ask the user for approval, so nothing was indexed; the user can run /kb add ${docs} instead.`)

    const kb = ctx.commands.find(agent, 'kb')
    if (kb === undefined) throw new Error('/kb is not registered')
    const added = await kb.handler({ commandId: CommandId('kb-add'), agent, rawInput: `add ${docs}`, attachments: [], signal })
    expect((added as { text: string }).text).toContain(`Indexed ${docs} as docs for this workspace: 2 files, 4 passages`)
    await vi.waitFor(() => {
      expect(knowledgeTools()).toContain('knowledge_search')
    })
    const found = await ctx.tools.execute({ signal, callId: ToolCallId('k-found'), name: 'knowledge_search', arguments: { query: 'sick leave certificate' }, agent })
    expect(resultText(found)).toContain('[docs:hr/leave.md#L9-L11] Leave policy › Sick leave')
  })

  it('runs /kb enrich as a background job that fails, is killed, or completes', async () => {
    const { docs } = await corpus()
    // One file at a time, so a cancel lands while the second file still waits and the run stops.
    const ctx = await boot(['      - name: docs', `        root: ${JSON.stringify(docs)}`], ['    enrichConcurrency: 1'])
    await ctx.knowledge.update()
    ctx.llm.registerAdapter(['mock'], new SummaryAdapter())
    const starts: JobStart[] = []
    ctx.provide('jobs', {
      start: (spec: JobStart) => {
        starts.push(spec)
        return `knowledge-enrich-${starts.length}`
      },
    } as unknown as Context['jobs'])
    const signal = new AbortController().signal
    const agent = await fakeAgent(ctx)
    const kb = ctx.commands.find(agent, 'kb')
    if (kb === undefined) throw new Error('/kb is not registered')
    const enrich = async (): Promise<string> => {
      const result = await kb.handler({
        commandId: CommandId('kb-job'), agent: { ...agent, options: { provider: 'mock', model: 'mock' } }, rawInput: 'enrich docs', attachments: [], signal,
      })
      return (result as { text: string }).text
    }
    expect(await enrich()).toBe('Summarizing up to 2 of 2 waiting file(s) with mock/mock as background job knowledge-enrich-1; '
      + '/kb shows progress, and job_kill knowledge-enrich-1 stops it after the files in flight.')
    await enrich()
    await enrich()
    expect(starts.map(spec => [spec.kind, spec.label])).toEqual(Array.from({ length: 3 }, () => ['knowledge-enrich', '/kb enrich docs (2 files)']))

    // A rejection that is not an Error is reported through String().
    const unreadable = vi.spyOn(ctx.knowledge, 'pendingSummaries').mockImplementationOnce(() => { throw 'index unavailable' })
    expect(await starts[0]!.run().done).toEqual({ status: 'failed', detail: 'index unavailable' })
    unreadable.mockRestore()

    const killed = starts[1]!.run()
    killed.cancel()
    expect(await killed.done).toMatchObject({ status: 'killed' })

    const completed = await starts[2]!.run().done
    expect(completed.status).toBe('completed')
    expect(completed.detail).toMatch(/^\d summarized$/)
  })

  it('keeps the index, summaries, and folder rollups current in the background without any command', async () => {
    const { docs } = await corpus()
    const ctx = await boot(
      ['      - name: docs', `        root: ${JSON.stringify(docs)}`],
      ['    reindexIntervalSeconds: 1', '    enrichProvider: mock', '    enrichModel: mock', '    folderRollupMinChildren: 1'],
    )
    ctx.llm.registerAdapter(['mock'], new SummaryAdapter())
    await writeFile(join(docs, 'hr', 'expenses.md'), '# Expenses\n\nKeep every receipt.\n')
    const deadline = Date.now() + 15_000
    const done = (): boolean => ctx.knowledge.stats()[0]?.files === 3 && ctx.knowledge.pendingCount() === 0
      && ctx.knowledge.folderSummary('docs', 'hr') !== undefined
    while (!done() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100))
    expect(ctx.knowledge.stats()[0]).toMatchObject({ files: 3, summarized: 3 })
    expect(ctx.knowledge.search({ query: 'receipt', limit: 1 })[0]?.path).toBe('hr/expenses.md')
    expect(ctx.knowledge.folderSummary('docs', 'hr')?.summary).toBe('A leave policy.')
  }, 20_000)

  it('skips the workspace data folder .dsh by default', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-knowledge-'))
    const docs = join(root, 'docs')
    await mkdir(join(docs, '.dsh', 'reports'), { recursive: true })
    await writeFile(join(docs, '.dsh', 'reports', '2026-09-30.md'), '# Report\n\nWhat Hydra did today.')
    await writeFile(join(docs, 'notes.md'), 'deploy notes')
    const ctx = new Context()
    context = ctx
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(Knowledge, { path: ':memory:', collections: [{ name: 'docs', root: docs }], indexOnStart: false, reindexIntervalSeconds: 0 })
    await ctx.knowledge.update()
    expect(ctx.knowledge.browse('docs', '').map(entry => entry.path)).toEqual(['notes.md'])
  })

  it('registers only knowledge_add and renders no prompt section when no collection is configured', async () => {
    const ctx = await boot([])
    expect(ctx.tools.schemas().map(schema => schema.name).filter(name => name.startsWith('knowledge_'))).toEqual(['knowledge_add'])
    const assembly = await ctx.systemPrompt.assemble()
    expect(assembly.sections.find(section => section.name === 'knowledge')?.text).toBe('')
  })

  it('fails loud on a relative collection root', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-knowledge-'))
    await expect(Knowledge.apply(new Context() as never, { path: ':memory:', collections: [{ name: 'docs', root: 'relative/docs' }] }))
      .rejects.toThrow(/must be an absolute path/)
    await expect(Knowledge.apply(new Context() as never, { path: ':memory:', collections: [{ name: 'a', root: '/x' }, { name: 'a', root: '/y' }] }))
      .rejects.toThrow(/configured twice/)
  })
})
