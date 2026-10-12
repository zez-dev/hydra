import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { enrichFiles, KnowledgeIndex, parseSummary, rollupFolders } from '@deepseek-ai/dsh-knowledge'

let root: string | undefined
const indexes: KnowledgeIndex[] = []

afterEach(async () => {
  for (const index of indexes.splice(0)) index.close()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** A route that answers each enrichment request from a script keyed by the file path in the prompt. */
class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  constructor(private readonly answer: (prompt: string) => string) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async* stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const prompt = options.messages.flatMap(message => message.content.map(block => (block.type === 'text' ? block.text : ''))).join('')
    const text = this.answer(prompt)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const ANSWERS: Record<string, string> = {
  'leave.md': 'Here you go:\n```json\n{"type": "guide", "tags": ["HR", "Leave Policy", "vacation"], "summary": "Explains annual and sick leave rules, including how unused days carry over."}\n```',
  'deploy.sh': '{"type": "script", "tags": ["deploy", "kubernetes", "rollback"], "summary": "Bash helpers that apply manifests and roll back the web deployment."}',
  'tips.txt': 'not json at all',
}

async function setup(): Promise<{ llm: LlmRuntime; adapter: ScriptedAdapter; index: KnowledgeIndex; docs: string }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-knowledge-enrich-'))
  const docs = join(root, 'docs')
  await mkdir(join(docs, 'hr'), { recursive: true })
  await writeFile(join(docs, 'hr', 'leave.md'), '# Leave\n\n## Annual leave\n\nFive unused days carry over.\n')
  await writeFile(join(docs, 'deploy.sh'), 'deploy() {\n  kubectl apply -f manifests/\n}\n')
  await writeFile(join(docs, 'tips.txt'), 'Tip: press ctrl+r to search history.\n')
  const ctx = new Context()
  const llm = new LlmRuntime(ctx)
  const adapter = new ScriptedAdapter((prompt) => {
    if (prompt.startsWith('Folder: docs/hr')) return '{"tags": ["hr", "policies"], "summary": "Human resources policies such as leave."}'
    if (prompt.startsWith('Folder: docs/')) return '{"tags": ["operations", "hr"], "summary": "Deployment scripts and HR policies."}'
    return Object.entries(ANSWERS).find(([path]) => prompt.includes(path))?.[1] ?? '{}'
  })
  llm.registerAdapter(['mock'], adapter)
  const index = await KnowledgeIndex.open({
    path: ':memory:', excludeDirs: [], maxFileBytes: 65536, maxDocumentBytes: 1048576, bounds: { targetChars: 2400, maxChars: 4800 }, hitChars: 1500, maxReadLines: 50,
  }, [{ name: 'docs', root: docs }])
  indexes.push(index)
  await index.update()
  return { llm, adapter, index, docs }
}

const OPTIONS = { provider: 'mock', model: 'mock', limit: 100, concurrency: 2, maxInputChars: 6000, maxTokens: 512, timeoutMs: 10_000 }

describe('knowledge enrichment', () => {
  it('summarizes waiting files, and a failed answer leaves its file waiting', async () => {
    const { llm, adapter, index } = await setup()
    const report = await enrichFiles(llm, index, OPTIONS, new AbortController().signal)
    expect(report).toMatchObject({ summarized: 2, failed: 1, remaining: 1 })
    expect(report.failures).toEqual([{ path: 'docs:tips.txt', message: 'the answer has no JSON object' }])
    expect(adapter.requests).toHaveLength(3)
    expect(adapter.requests[0]).toMatchObject({ purpose: 'knowledge-enrich', maxTokens: 512 })
    expect(index.stats()[0]).toMatchObject({ files: 3, summarized: 2 })
    expect(index.pendingSummaries(10).map(file => file.path)).toEqual(['tips.txt'])
  })

  it('makes summaries searchable, browsable, and listable by tag', async () => {
    const { llm, index } = await setup()
    await enrichFiles(llm, index, OPTIONS, new AbortController().signal)
    const [hit] = index.searchSummaries({ query: 'vacation carry over', limit: 5 })
    expect(hit).toMatchObject({ ref: 'docs:hr/leave.md', type: 'guide', tags: ['hr', 'leave-policy', 'vacation'] })
    expect(index.browse('docs', 'hr')[0]?.summary?.type).toBe('guide')
    expect(index.filesWithTag('docs', 'kubernetes', 10).map(entry => entry.path)).toEqual(['deploy.sh'])
  })

  it('drops a changed file\'s summary so the next run writes a new one', async () => {
    const { llm, index, docs } = await setup()
    await enrichFiles(llm, index, OPTIONS, new AbortController().signal)
    const leave = join(docs, 'hr', 'leave.md')
    await writeFile(leave, '# Leave\n\nThe policy changed.\n')
    const later = new Date(Date.now() + 5000)
    await utimes(leave, later, later)
    await index.update()
    expect(index.pendingSummaries(10).map(file => file.path).sort()).toEqual(['hr/leave.md', 'tips.txt'])
    expect(index.searchSummaries({ query: 'vacation', limit: 5 })).toEqual([])
  })

  it('stops between files when the run is cancelled', async () => {
    const { llm, index } = await setup()
    const controller = new AbortController()
    controller.abort(new Error('stop'))
    await expect(enrichFiles(llm, index, OPTIONS, controller.signal)).rejects.toThrow('stop')
    expect(index.stats()[0]?.summarized).toBe(0)
  })
})

describe('folder rollups', () => {
  it('rolls a subfolder up into its parent in one run, and rewrites only what changed', async () => {
    const { llm, adapter, index, docs } = await setup()
    await enrichFiles(llm, index, OPTIONS, new AbortController().signal)
    expect(await rollupFolders(llm, index, OPTIONS, 1, new AbortController().signal)).toEqual({ folders: 2, failed: 0 })
    // The root's rollup was written from the hr/ rollup, not only from its files.
    const rootPrompt = adapter.requests.map(request => request.messages[0]!.content[0]).find(block => block?.type === 'text' && block.text.startsWith('Folder: docs/\n'))
    expect(rootPrompt?.type === 'text' ? rootPrompt.text : '').toContain('- hr/ (folder; hr, policies): Human resources policies such as leave.')
    expect(index.browse('docs')[0]).toMatchObject({ path: 'hr', type: 'folder', summary: { summary: 'Human resources policies such as leave.' } })
    expect(index.searchFolders({ query: 'deployment scripts', limit: 5 })[0]).toMatchObject({ ref: 'docs:', folder: '' })

    const before = adapter.requests.length
    expect(await rollupFolders(llm, index, OPTIONS, 1, new AbortController().signal)).toEqual({ folders: 0, failed: 0 })
    expect(adapter.requests.length).toBe(before)

    const leave = join(docs, 'hr', 'leave.md')
    await writeFile(leave, '# Leave\n\nThe policy changed.\n')
    const later = new Date(Date.now() + 5000)
    await utimes(leave, later, later)
    await index.update()
    await enrichFiles(llm, index, OPTIONS, new AbortController().signal)
    // Only hr/ is stale at first; its new rollup makes the root stale in turn, and one run rewrites both.
    expect(index.staleFolders(1).map(folder => folder.folder)).toEqual(['hr'])
    expect(await rollupFolders(llm, index, OPTIONS, 1, new AbortController().signal)).toEqual({ folders: 2, failed: 0 })
  })

  it('needs the configured number of summarized children before rolling a folder up', async () => {
    const { llm, index } = await setup()
    await enrichFiles(llm, index, OPTIONS, new AbortController().signal)
    expect(index.staleFolders(3)).toEqual([])
    expect(await rollupFolders(llm, index, OPTIONS, 3, new AbortController().signal)).toEqual({ folders: 0, failed: 0 })
  })
})

describe('parsing the enrichment answer', () => {
  it('reads the JSON object inside surrounding text and normalizes tags and type', () => {
    expect(parseSummary('Sure! {"type": "Cheatsheet", "tags": ["Git Tricks", "git tricks", "  ", 7], "summary": "  Short   git recipes. "} done'))
      .toEqual({ type: 'cheatsheet', tags: ['git-tricks'], summary: 'Short git recipes.' })
    expect(parseSummary('{"type": "poem", "summary": "x"}')).toEqual({ type: 'other', tags: [], summary: 'x' })
    expect(() => parseSummary('{"type": "tip"}')).toThrow('no summary')
  })
})
