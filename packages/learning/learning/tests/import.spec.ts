import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox, unsupportedModel } from '@deepseek-ai/dsh-agent-loop-testkit'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import CommandRuntime, { CommandId } from '@deepseek-ai/dsh-commands'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as Memory from '@deepseek-ai/dsh-memory'
import * as Learning from '@deepseek-ai/dsh-learning'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import type { JobId } from '@deepseek-ai/dsh-jobs'
import {
  chunkText,
  DIGEST_DOCUMENT_SYSTEM_PROMPT,
  DIGEST_PART_SYSTEM_PROMPT,
  digestDocument,
  DOCUMENT_SYSTEM_PROMPT,
  parseDigestDocument,
  parseDigestInput,
  parseDigestPart,
  parseLearnFromInput,
  resolveImportPath,
  walkImportFiles,
} from '@deepseek-ai/dsh-learning'

class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  constructor(readonly script: (options: GenerateOptions) => StreamChunk[]) {
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
  minToolCalls: 2,
  maxCandidatesPerTurn: 3,
  maxTranscriptBytes: 20_000,
  maxOutputTokens: 512,
  timeoutMs: 5000,
  provider: 'mock',
  model: 'mock',
}

type ImportBaseConfig = Omit<typeof BASE_CONFIG, 'provider' | 'model'> & { readonly provider?: string; readonly model?: string }

async function setup(adapter: LlmAdapter, config: Partial<Learning.Config> = {}, base: ImportBaseConfig = BASE_CONFIG): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-learning-import-'))
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
  await ctx.plugin(Learning, { ...base, skillsRoot: join(root, 'skills'), skillDraftsRoot: join(root, 'drafts'), ...config })
  return ctx
}

/** Mount the local job registry with a controller, the way dsh-base composes it with tool-jobs. */
async function withJobs(ctx: Context): Promise<void> {
  await ctx.plugin(LocalJobRegistry)
  await ctx.plugin({
    inject: ['jobs'],
    apply(pluginCtx: Context) { pluginCtx.jobs.attachController('test-controller') },
  })
}

function jobIdIn(text: string): JobId {
  const match = /background job (learning-import-[0-9a-f]+)/u.exec(text)
  if (match === null) throw new Error(`no job id in: ${text}`)
  return match[1] as JobId
}

async function liveAgent(ctx: Context, cwd: string, id = 'import-agent'): Promise<{ agent: Agent; session: Session }> {
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

async function knowledgeTree(base: string): Promise<string> {
  const dir = join(base, 'knowledge')
  await mkdir(join(dir, 'wiki'), { recursive: true })
  await mkdir(join(dir, 'node_modules', 'dep'), { recursive: true })
  await mkdir(join(dir, '.git'), { recursive: true })
  await writeFile(join(dir, 'wiki', 'guide.md'), '# Guide\nRun `pnpm test` before pushing.\n')
  await writeFile(join(dir, 'wiki', 'notes.txt'), 'The staging URL is https://staging.example.\n')
  await writeFile(join(dir, 'node_modules', 'dep', 'README.md'), 'ignored dependency docs\n')
  await writeFile(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  await writeFile(join(dir, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]))
  await writeFile(join(dir, 'blob.txt'), Buffer.from([0x00, 0x01, 0x02, 0x00, 0xff, 0xfe]))
  await writeFile(join(dir, 'Makefile'), 'all:\n\techo build\n')
  await writeFile(join(dir, 'data.xyz'), 'custom extension content\n')
  await writeFile(join(dir, 'huge.md'), 'x'.repeat(5000))
  return dir
}

async function invoke(ctx: Context, agent: Agent, rawInput: string, signal = new AbortController().signal) {
  return ctx.commands.find(agent, 'learn')!.handler({ commandId: CommandId('c'), agent, rawInput, attachments: [], signal })
}

async function digest(ctx: Context, agent: Agent, rawInput: string) {
  return ctx.commands.find(agent, 'digest')!.handler({ commandId: CommandId('d'), agent, rawInput, attachments: [], signal: new AbortController().signal })
}

function promptOf(options: GenerateOptions): string {
  return options.messages.map(message => message.content.map(block => block.type === 'text' ? block.text : '').join('')).join('')
}

function textOf(result: Awaited<ReturnType<typeof invoke>>): string {
  return (result as { text?: string }).text ?? ''
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false)
}

describe('parseDigestInput and parseDigest', () => {
  it('reads the path and tags of a /digest request', () => {
    expect(parseDigestInput('knowledge/wiki --tags a,b')).toEqual({ path: 'knowledge/wiki', tags: ['a', 'b'], mode: 'auto' })
    expect(parseDigestInput('')).toBeUndefined()
  })

  it('reads --as-skills as part of a /digest path, since /digest has no such option', () => {
    expect(parseDigestInput('notes --as-skills')).toEqual({ path: 'notes --as-skills', tags: [], mode: 'auto' })
  })

  it('reads a part answer: what the part covers, whether it is steps, and its entries, counting what the cap dropped', () => {
    const answer = JSON.stringify({
      note: 'Deploy steps.',
      procedural: true,
      entries: [{ text: 'Run make deploy.', kind: 'shortcut', tags: [] }, { text: 'Prod runs in eu-1.', kind: 'fact', tags: [] }],
    })
    expect(parseDigestPart(answer, 1))
      .toEqual({ note: 'Deploy steps.', procedural: true, candidates: [{ text: 'Run make deploy.', kind: 'shortcut', tags: [] }], dropped: 1 })
    expect(parseDigestPart('[{"text": "A fact."}]', 5)).toEqual({ note: '', procedural: false, candidates: [{ text: 'A fact.', kind: 'fact', tags: [] }], dropped: 0 })
    expect(parseDigestPart('not json', 5)).toEqual({ note: '', procedural: false, candidates: [], dropped: 0 })
  })

  it('reads a document verdict: a draft only for a skill the model wrote a body for, and the entries', () => {
    const skill = JSON.stringify({ skill: true, description: 'Use to deploy.', body: '1. Run make deploy.', entries: [{ text: 'Prod runs in eu-1.' }] })
    expect(parseDigestDocument(skill, 5))
      .toEqual({ draft: { description: 'Use to deploy.', body: '1. Run make deploy.' }, candidates: [{ text: 'Prod runs in eu-1.', kind: 'fact', tags: [] }], dropped: 0 })
    expect(parseDigestDocument(JSON.stringify({ skill: true, description: 'Use to deploy.', body: '  ' }), 5)).toEqual({ candidates: [], dropped: 0 })
    expect(parseDigestDocument(JSON.stringify({ skill: true, body: 'Steps.' }), 5)).toEqual({ draft: { description: '', body: 'Steps.' }, candidates: [], dropped: 0 })
    expect(parseDigestDocument(JSON.stringify({ skill: false, description: '', body: '1. Steps.', entries: [] }), 5)).toEqual({ candidates: [], dropped: 0 })
    expect(parseDigestDocument('[{"text": "A fact."}]', 5)).toEqual({ candidates: [{ text: 'A fact.', kind: 'fact', tags: [] }], dropped: 0 })
    expect(parseDigestDocument('not json', 5)).toEqual({ candidates: [], dropped: 0 })
  })
})

describe('digestDocument', () => {
  it('records a failed request with its message and goes on, but rethrows a cancelled one', async () => {
    const kept: unknown[] = []
    const keep = async (candidates: readonly unknown[]) => { kept.push(candidates) }
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- a rejection that is not an Error is the case under test
    const refuse = () => Promise.reject('plain refusal')
    const failing = await digestDocument('a.md', 'Short.', 100, 5, { ask: refuse, keep }, new AbortController().signal)
    expect(failing).toEqual({ dropped: 0, failed: [{ chunk: 1, message: 'plain refusal' }] })
    expect(kept).toEqual([[]])
    const controller = new AbortController()
    const cancelled = digestDocument('a.md', 'Short.', 100, 5, {
      ask: () => {
        controller.abort()
        return Promise.reject(new Error('stopped'))
      },
      keep,
    }, controller.signal)
    await expect(cancelled).rejects.toThrow('stopped')
  })
})

describe('parseLearnFromInput', () => {
  it('reads --as-skills and leaves it off by default', () => {
    expect(parseLearnFromInput('from knowledge --as-skills --tags a')).toMatchObject({ path: 'knowledge', mode: 'skills', tags: ['a'] })
    expect(parseLearnFromInput('from knowledge')).toMatchObject({ mode: 'facts' })
  })

  it('reads the path and the optional --tags list', () => {
    expect(parseLearnFromInput('from ./docs --tags a,b')).toEqual({ path: './docs', tags: ['a', 'b'], mode: 'facts' })
    expect(parseLearnFromInput('from /abs/file.md')).toEqual({ path: '/abs/file.md', tags: [], mode: 'facts' })
    expect(parseLearnFromInput('from --tags a')).toBeUndefined()
    expect(parseLearnFromInput('from')).toBeUndefined()
  })
})

describe('resolveImportPath', () => {
  it('resolves relative paths against the cwd and keeps absolute paths', () => {
    expect(resolveImportPath('/work/project', 'docs')).toBe(resolve('/work/project', 'docs'))
    expect(resolveImportPath('/work/project', '/elsewhere/file.md')).toBe(resolve('/elsewhere/file.md'))
  })
})

describe('walkImportFiles', () => {
  it('walks text files recursively, skipping ignored directories, binaries, oversized and unknown-extension files', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-learning-walk-'))
    const dir = await knowledgeTree(root)
    const walked = await walkImportFiles(dir, { extensions: [], maxFileBytes: 4000, maxFiles: 50 })
    expect(walked.files.map(file => file.relative)).toEqual(['Makefile', 'wiki/guide.md', 'wiki/notes.txt'])
    expect(walked.skipped.map(entry => [entry.relative, entry.reason])).toEqual(expect.arrayContaining([
      ['logo.png', 'extension'],
      ['blob.txt', 'binary'],
      ['huge.md', 'too-large'],
      ['data.xyz', 'extension'],
    ]))
    expect(walked.skipped.some(entry => entry.relative.startsWith('node_modules'))).toBe(false)
  })

  it('accepts extra extensions, a single file, and caps the file count', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-learning-walk-'))
    const dir = await knowledgeTree(root)
    const extra = await walkImportFiles(dir, { extensions: ['xyz'], maxFileBytes: 4000, maxFiles: 50 })
    expect(extra.files.map(file => file.relative)).toContain('data.xyz')
    const single = await walkImportFiles(join(dir, 'wiki', 'guide.md'), { extensions: [], maxFileBytes: 4000, maxFiles: 50 })
    expect(single.files.map(file => file.relative)).toEqual(['guide.md'])
    const capped = await walkImportFiles(dir, { extensions: [], maxFileBytes: 4000, maxFiles: 1 })
    expect(capped.files).toHaveLength(1)
    expect(capped.skipped.filter(entry => entry.reason === 'file-cap')).toHaveLength(2)
  })
})

describe('chunkText', () => {
  it('splits on line boundaries within the byte cap and covers all text', () => {
    const text = ['alpha line', 'beta line', 'gamma line', 'delta'].join('\n')
    const chunks = chunkText(text, 24)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) expect(Buffer.byteLength(chunk)).toBeLessThanOrEqual(24)
    expect(chunks.join('\n')).toBe(text)
    expect(chunkText('', 24)).toEqual([])
  })

  it('hard-splits a single line longer than the cap', () => {
    const chunks = chunkText('y'.repeat(50), 20)
    expect(chunks).toHaveLength(3)
    expect(chunks.join('')).toBe('y'.repeat(50))
  })
})

describe('DOCUMENT_SYSTEM_PROMPT', () => {
  it('asks for durable knowledge from documents in the same JSON shape', () => {
    expect(DOCUMENT_SYSTEM_PROMPT).toMatch(/facts/u)
    expect(DOCUMENT_SYSTEM_PROMPT).toMatch(/procedures/u)
    expect(DOCUMENT_SYSTEM_PROMPT).toMatch(/conventions/u)
    expect(DOCUMENT_SYSTEM_PROMPT).toMatch(/preferences/u)
    expect(DOCUMENT_SYSTEM_PROMPT).toContain('"kind": "fact" | "shortcut" | "preference"')
  })
})

describe('/learn from', () => {
  it('ingests a folder: one request per chunk, candidates tagged with their source and the given tags', async () => {
    const adapter = new ScriptedAdapter((options) => {
      const prompt = options.messages.map(message => message.content.map(block => block.type === 'text' ? block.text : '').join('')).join('')
      if (prompt.includes('staging')) return textChunks('[{"text":"Staging lives at https://staging.example.","kind":"fact","tags":["env"]}]')
      if (prompt.includes('pnpm test')) return textChunks('[{"text":"Run pnpm test before pushing.","kind":"shortcut","tags":[]}]')
      return textChunks('[]')
    })
    const ctx = await setup(adapter, { maxFileBytes: 4000 })
    const dir = await knowledgeTree(root!)
    const { agent, session } = await liveAgent(ctx, root!)
    const result = await invoke(ctx, agent, 'from knowledge --tags docs')
    expect(result.kind).toBe('success')
    const text = (result as { text?: string }).text ?? ''
    expect(text).toMatch(/3 file/u)
    expect(text).toMatch(/2 candidate/u)
    expect(adapter.requests).toHaveLength(3)
    expect(adapter.requests.every(request => request.purpose === 'learning-extract' && request.system === DOCUMENT_SYSTEM_PROMPT)).toBe(true)
    const candidates = ctx.memory.list({ status: 'candidate' })
    expect(candidates.map(entry => entry.text).sort()).toEqual(['Run pnpm test before pushing.', 'Staging lives at https://staging.example.'])
    const staging = candidates.find(entry => entry.text.startsWith('Staging'))!
    expect(staging.tags).toEqual(expect.arrayContaining(['env', 'docs', 'source:wiki/notes.txt']))
    expect(staging.sourceSessionId).toBe(session.id)
    const logged = session.snapshotEvents().filter(event => event.type === 'session/learning-request')
    expect(logged).toHaveLength(3)
    expect(logged[0]!.data).toMatchObject({ turn: 0, source: { kind: 'import' } })
    expect(dir).toBeDefined()
  })

  it('files extractions straight into recalled knowledge by default and never files the same text twice', async () => {
    const adapter = new ScriptedAdapter(() => textChunks('[{"text":"Run pnpm test before pushing.","kind":"shortcut","tags":[]}]'))
    const ctx = await setup(adapter, { maxFileBytes: 4000, fileAs: 'approved' })
    await knowledgeTree(root!)
    const { agent } = await liveAgent(ctx, root!)
    const first = await invoke(ctx, agent, 'from knowledge/wiki')
    expect((first as { text?: string }).text ?? '').toMatch(/1 entry approved/u)
    expect(ctx.memory.list({ status: 'approved' }).map(entry => entry.text)).toEqual(['Run pnpm test before pushing.'])
    expect(ctx.memory.list({ status: 'candidate' })).toHaveLength(0)
    const again = await invoke(ctx, agent, 'from knowledge/wiki')
    expect((again as { text?: string }).text ?? '').toMatch(/0 entries approved.*already known/u)
    expect(ctx.memory.list({ status: 'approved' })).toHaveLength(1)
  })

  it('writes skills without any extraction route, since --as-skills needs no model', async () => {
    const adapter = new ScriptedAdapter(() => textChunks('[]'))
    const { provider: _provider, model: _model, ...routeless } = BASE_CONFIG
    const ctx = await setup(adapter, { maxFileBytes: 4000 }, routeless)
    await knowledgeTree(root!)
    const { agent } = await liveAgent(ctx, root!)
    const result = await invoke(ctx, agent, 'from knowledge/wiki --as-skills')
    expect(result.kind).toBe('success')
    expect((result as { text?: string }).text ?? '').toMatch(/Wrote 2 skill/u)
    expect(adapter.requests).toHaveLength(0)
  })

  it('writes one skill per file with --as-skills and never calls the model', async () => {
    const adapter = new ScriptedAdapter(() => textChunks('[]'))
    const ctx = await setup(adapter, { maxFileBytes: 4000 })
    await knowledgeTree(root!)
    await writeFile(join(root!, 'knowledge', 'wiki', 'Release Checklist.md'), '---\nname: x\ndescription: "Steps before a release"\n---\n\n# Release\n1. tag\n')
    const { agent } = await liveAgent(ctx, root!)
    const result = await invoke(ctx, agent, 'from knowledge/wiki --as-skills')
    expect((result as { text?: string }).text ?? '').toMatch(/Wrote 3 skill/u)
    expect(adapter.requests).toHaveLength(0)
    const guide = await readFile(join(root!, 'skills', 'guide', 'SKILL.md'), 'utf8')
    expect(guide).toContain('name: guide')
    expect(guide).toContain('description: "Guide"')
    expect(guide).toContain('Run `pnpm test` before pushing.')
    const release = await readFile(join(root!, 'skills', 'release-checklist', 'SKILL.md'), 'utf8')
    expect(release.startsWith('---\nname: x')).toBe(true)
    expect(ctx.memory.list()).toHaveLength(0)
  })

  it('goes on with the next chunk when one extraction fails and reports the failure', async () => {
    // guide.md is walked first and fails; the candidate must come from notes.txt, which follows it.
    const adapter = new ScriptedAdapter((options) => {
      const prompt = options.messages
        .map(message => message.content.map(block => block.type === 'text' ? block.text : '').join(''))
        .join('')
      if (prompt.includes('pnpm test')) {
        throw Object.assign(new Error('LEARNING_EXTRACT_TIMEOUT after 20ms'), { code: 'LEARNING_EXTRACT_TIMEOUT' })
      }
      if (prompt.includes('staging')) return textChunks('[{"text":"The staging URL is https://staging.example.","kind":"fact","tags":[]}]')
      return textChunks('[]')
    })
    const ctx = await setup(adapter, { maxFileBytes: 4000 })
    await knowledgeTree(root!)
    const { agent } = await liveAgent(ctx, root!)
    const result = await invoke(ctx, agent, 'from knowledge/wiki')
    expect(result.kind).toBe('success')
    const text = (result as { text?: string }).text ?? ''
    expect(text).toMatch(/1 candidate/u)
    expect(text).toMatch(/Failed 1 chunk\(s\): guide\.md part 1 \(LEARNING_EXTRACT_TIMEOUT after 20ms\)/u)
    expect(ctx.memory.list().map(entry => entry.text)).toEqual(['The staging URL is https://staging.example.'])
  })

  it('does not file a rephrasing of a fact the store already holds', async () => {
    let phrase = 'Run pnpm test before pushing.'
    const adapter = new ScriptedAdapter((options) => {
      const prompt = options.messages.map(message => message.content.map(block => block.type === 'text' ? block.text : '').join('')).join('')
      if (prompt.includes('pnpm test')) return textChunks(JSON.stringify([{ text: phrase, kind: 'shortcut', tags: [] }]))
      return textChunks('[]')
    })
    const ctx = await setup(adapter, { maxFileBytes: 4000 })
    await knowledgeTree(root!)
    const { agent } = await liveAgent(ctx, root!)
    await invoke(ctx, agent, 'from knowledge/wiki')
    phrase = 'Always run pnpm test before pushing.'
    const again = await invoke(ctx, agent, 'from knowledge/wiki')
    expect((again as { text?: string }).text ?? '').toMatch(/1 already known and not filed again/u)
    // The stored note takes the newest wording instead of a second entry.
    expect(ctx.memory.list().map(entry => entry.text)).toEqual(['Always run pnpm test before pushing.'])
  })

  it('digests a folder: the model writes a skill draft from a procedure, facts become entries, and nothing goes live', async () => {
    const adapter = new ScriptedAdapter((options) => {
      const prompt = promptOf(options)
      if (prompt.includes('pnpm test')) {
        return textChunks(JSON.stringify({
          skill: true,
          description: 'Check a change before pushing',
          body: '# Before pushing\n1. Run `pnpm test`.',
          entries: [{ text: 'Run pnpm test before pushing.', kind: 'shortcut', tags: [] }, { text: 'Past the cap.' }],
        }))
      }
      // A verdict without a body never becomes a draft, and never a copy of the document.
      return textChunks('{"skill": true, "entries": [{"text":"The staging URL is https://staging.example.","kind":"fact","tags":[]}]}')
    })
    const ctx = await setup(adapter, { maxFileBytes: 4000, fileAs: 'approved', digestMaxEntriesPerPart: 1 })
    const dir = await knowledgeTree(root!)
    await writeFile(join(dir, 'wiki', 'empty.md'), '')
    const { agent } = await liveAgent(ctx, root!)
    const result = await digest(ctx, agent, 'knowledge/wiki --tags docs')
    expect(result.kind).toBe('success')
    const text = textOf(result)
    expect(text).toMatch(/^Digested 3 file\(s\) in 2 model request\(s\): 1 skill draft\(s\) for your review: guide; 2 entries approved/u)
    expect(text).toContain('/learn publish <draft> makes one live.')
    expect(text).toContain('\n1 more entry past the per-request cap not filed.')
    expect(adapter.requests.map(request => request.system?.includes(DIGEST_DOCUMENT_SYSTEM_PROMPT))).toEqual([true, true])
    const draft = await readFile(join(root!, 'drafts', 'guide', 'SKILL.md'), 'utf8')
    expect(draft).toBe('---\nname: guide\ndescription: "Check a change before pushing"\n---\n\n# Before pushing\n1. Run `pnpm test`.\n\n'
      + 'Source: `source/guide.md` in this skill\'s folder.\n')
    await expect(readFile(join(root!, 'drafts', 'guide', 'source', 'guide.md'), 'utf8')).resolves.toBe('# Guide\nRun `pnpm test` before pushing.\n')
    expect(JSON.parse(await readFile(join(root!, 'drafts', 'guide', 'draft.json'), 'utf8'))).toMatchObject({ source: join(dir, 'wiki', 'guide.md') })
    expect(await exists(join(root!, 'drafts', 'notes'))).toBe(false)
    expect(await exists(join(root!, 'skills'))).toBe(false)
    expect(ctx.memory.list().map(entry => entry.text).sort()).toEqual(['Run pnpm test before pushing.', 'The staging URL is https://staging.example.'])
    expect(ctx.memory.list().every(entry => entry.tags.includes('docs'))).toBe(true)
  })

  it('reads a long document part by part, then decides once from every part\'s note and the steps that fit', async () => {
    const manual = ['# Manual', 'Overview of mantool.', '## Install', '1. Run `make install`.', '## Deploy', '1. Run `make deploy`.'].join('\n')
    expect(chunkText(manual, 35)).toHaveLength(3)
    let verdict = ''
    const adapter = new ScriptedAdapter((options) => {
      const prompt = promptOf(options)
      if (options.system?.includes(DIGEST_DOCUMENT_SYSTEM_PROMPT) === true) {
        verdict = prompt
        return textChunks(JSON.stringify({ skill: true, description: '', body: '1. Run `make deploy`.', entries: [{ text: 'The verdict files no entries.' }] }))
      }
      expect(options.system).toContain(DIGEST_PART_SYSTEM_PROMPT)
      if (prompt.includes('make install')) throw new Error('install part timed out')
      if (prompt.includes('Overview')) return textChunks('{"note": "What mantool is.", "procedural": false, "entries": [{"text": "The tool is called mantool."}]}')
      return textChunks(JSON.stringify({
        note: 'Deploy steps.',
        procedural: true,
        entries: [{ text: 'Deploy with make deploy.', kind: 'shortcut' }, { text: 'One more.' }, { text: 'And another.' }],
      }))
    })
    const ctx = await setup(adapter, { maxTranscriptBytes: 35, digestMaxEntriesPerPart: 1 })
    await mkdir(join(root!, 'knowledge'), { recursive: true })
    await writeFile(join(root!, 'knowledge', 'manual.md'), manual)
    const { agent, session } = await liveAgent(ctx, root!)
    const text = textOf(await digest(ctx, agent, 'knowledge'))
    expect(text).toMatch(/^Digested 1 file\(s\) in 4 model request\(s\): /u)
    expect(text).toContain('1 skill draft(s) for your review: manual (written from an excerpt);')
    expect(text).toContain('2 more entries past the per-request cap not filed.')
    expect(text).toContain('Failed 1 request(s): manual.md part 2 (install part timed out)')
    expect(verdict).toContain('The document was read in 3 parts. What each part covers:\n1. What mantool is.\n2. (not read: its request failed)\n3. Deploy steps. [steps]')
    expect(verdict).toContain('An excerpt follows: part 3 of 3, steps first.\n\n## Deploy\n1. Run `make deploy`.')
    expect(verdict).not.toContain('Overview')
    // The draft takes its description from the document when the model wrote none.
    await expect(readFile(join(root!, 'drafts', 'manual', 'SKILL.md'), 'utf8')).resolves.toContain('description: "Manual"\n---\n\n1. Run `make deploy`.')
    expect(ctx.memory.list().map(entry => entry.text).sort()).toEqual(['Deploy with make deploy.', 'The tool is called mantool.'])
    const sources = session.snapshotEvents().flatMap(event => event.type === 'session/learning-request' ? [event.data.source] : [])
    expect(sources.map(source => source?.kind === 'import' ? source.chunk : undefined)).toEqual([1, 2, 3, 0])
    expect(sources[3]).toEqual({ kind: 'import', path: 'manual.md', chunk: 0, chunks: 3 })
  })

  it('drafts nothing when the verdict says no or fails, and names a failed verdict', async () => {
    let answer = (): StreamChunk[] => textChunks('{"skill": false, "body": "Not used."}')
    let verdict = ''
    const adapter = new ScriptedAdapter((options) => {
      if (options.system?.includes(DIGEST_PART_SYSTEM_PROMPT) === true) return textChunks('{"note": "Reference.", "entries": []}')
      verdict = promptOf(options)
      return answer()
    })
    const ctx = await setup(adapter, { maxTranscriptBytes: 20 })
    await mkdir(join(root!, 'knowledge'), { recursive: true })
    await writeFile(join(root!, 'knowledge', 'ref.md'), ['x'.repeat(9), 'y'.repeat(15), 'z'.repeat(9)].join('\n'))
    const { agent } = await liveAgent(ctx, root!)
    expect(textOf(await digest(ctx, agent, 'knowledge'))).toMatch(/^Digested 1 file\(s\) in 4 model request\(s\): no skill drafts; 0 candidate\(s\) filed/u)
    expect(verdict).toContain(`An excerpt follows: parts 1, 3 of 3, steps first.\n\n${'x'.repeat(9)}\n${'z'.repeat(9)}`)
    answer = () => { throw new Error('verdict timed out') }
    expect(textOf(await digest(ctx, agent, 'knowledge'))).toContain('Failed 1 request(s): ref.md skill verdict (verdict timed out)')
    expect(await exists(join(root!, 'drafts'))).toBe(false)
  })

  it('replaces a document\'s own draft when digested again, and never takes a live skill\'s name', async () => {
    const adapter = new ScriptedAdapter(() => textChunks('{"skill": true, "description": "Steps", "body": "1. Do it."}'))
    const ctx = await setup(adapter, { maxFileBytes: 4000 })
    const dir = await knowledgeTree(root!)
    await writeFile(join(dir, 'wiki', '_.md'), '1. A procedure without a name.\n')
    await mkdir(join(root!, 'skills', 'guide'), { recursive: true })
    await writeFile(join(root!, 'skills', 'guide', 'SKILL.md'), '---\nname: guide\ndescription: "Live"\n---\n\nLive.\n')
    await mkdir(join(root!, 'drafts', 'stray'), { recursive: true })
    const { agent } = await liveAgent(ctx, root!)
    const first = textOf(await digest(ctx, agent, 'knowledge/wiki'))
    expect(first).toContain('2 skill draft(s) for your review: guide-2, notes;')
    expect(first).toContain('_.md (no-skill-name)')
    await digest(ctx, agent, 'knowledge/wiki')
    const { readdir } = await import('node:fs/promises')
    expect((await readdir(join(root!, 'drafts'))).sort()).toEqual(['guide-2', 'notes', 'stray'])
  })

  it('lists, publishes, renames on publish, and discards drafts, refusing a live name', async () => {
    const adapter = new ScriptedAdapter(() => textChunks('{"skill": true, "description": "Steps", "body": "1. Do it."}'))
    const ctx = await setup(adapter, { maxFileBytes: 4000 })
    await knowledgeTree(root!)
    const { agent } = await liveAgent(ctx, root!)
    expect(textOf(await invoke(ctx, agent, 'drafts'))).toMatch(/^No skill drafts\./u)
    await digest(ctx, agent, 'knowledge/wiki')
    const listed = textOf(await invoke(ctx, agent, 'drafts'))
    expect(listed).toContain('2 skill draft(s), not live until published:')
    expect(listed).toContain(`  guide: Steps (${join(root!, 'drafts', 'guide', 'SKILL.md')})`)
    const published = await invoke(ctx, agent, 'publish guide')
    expect(textOf(published)).toBe(`Published skill \`guide\` at ${join(root!, 'skills', 'guide', 'SKILL.md')}; it is live from the next step on.`)
    expect(await exists(join(root!, 'drafts', 'guide'))).toBe(false)
    expect(await exists(join(root!, 'skills', 'guide', 'draft.json'))).toBe(false)
    expect(await exists(join(root!, 'skills', 'guide', 'source', 'guide.md'))).toBe(true)
    await digest(ctx, agent, 'knowledge/wiki')
    const clash = await invoke(ctx, agent, 'publish guide-2 as guide')
    expect(clash).toEqual({ kind: 'error', text: 'A skill named guide already exists; publish under another name with `/learn publish guide-2 as <name>`.' })
    expect(textOf(await invoke(ctx, agent, 'publish guide-2 as pre-push'))).toContain('Published skill `pre-push`')
    await expect(readFile(join(root!, 'skills', 'pre-push', 'SKILL.md'), 'utf8')).resolves.toMatch(/^---\nname: pre-push\n/u)
    expect(await invoke(ctx, agent, 'publish guide-2')).toEqual({ kind: 'error', text: 'No skill draft guide-2; /learn drafts lists them.' })
    const badName = await invoke(ctx, agent, 'publish notes as Bad_Name')
    expect(badName.kind).toBe('error')
    expect(textOf(badName)).toContain('A skill name is required')
    const badSyntax = await invoke(ctx, agent, 'publish notes to other')
    expect(badSyntax.kind).toBe('error')
    expect(textOf(badSyntax)).toContain('Usage: /learn')
    expect(await invoke(ctx, agent, 'discard notes')).toEqual({ kind: 'success', text: 'Discarded skill draft notes.' })
    expect(await invoke(ctx, agent, 'discard notes')).toEqual({ kind: 'error', text: 'No skill draft notes; /learn drafts lists them.' })
  })

  it('runs a model-backed import as a background job owned by the agent and delivers the summary as its output', async () => {
    const adapter = new ScriptedAdapter((options) => {
      const prompt = options.messages.map(message => message.content.map(block => block.type === 'text' ? block.text : '').join('')).join('')
      if (prompt.includes('pnpm test')) return textChunks('[{"text":"Run pnpm test before pushing.","kind":"shortcut","tags":[]}]')
      return textChunks('[]')
    })
    const ctx = await setup(adapter, { maxFileBytes: 4000 })
    await withJobs(ctx)
    await knowledgeTree(root!)
    const { agent } = await liveAgent(ctx, root!)
    const result = await invoke(ctx, agent, 'from knowledge/wiki')
    expect(result.kind).toBe('success')
    const text = (result as { text?: string }).text ?? ''
    expect(text).toMatch(/Importing 2 file\(s\) from knowledge\/wiki as background job learning-import-[0-9a-f]+/u)
    const id = jobIdIn(text)
    expect(ctx.jobs.get(id, agent.session.id)).toMatchObject({ kind: 'learning-import', label: '/learn from knowledge/wiki', owner: agent.session.id })
    const settled = await ctx.jobs.wait(id, 5000, agent.session.id)
    expect(settled.status).toBe('completed')
    expect(settled.detail).toBe('1 entries filed')
    expect(ctx.jobs.read(id, agent.session.id).result).toMatch(/Imported 2 file\(s\) in 2 chunk\(s\); 1 candidate/u)
    expect(ctx.memory.list().map(entry => entry.text)).toEqual(['Run pnpm test before pushing.'])
  })

  it('runs a digest as a background job whose detail counts the drafts', async () => {
    const adapter = new ScriptedAdapter(() => textChunks('{"skill": true, "description": "Steps", "body": "1. Do it.", "entries": [{"text": "A fact."}]}'))
    const ctx = await setup(adapter, { maxFileBytes: 4000 })
    await withJobs(ctx)
    await knowledgeTree(root!)
    const { agent } = await liveAgent(ctx, root!)
    const id = jobIdIn(textOf(await digest(ctx, agent, 'knowledge/wiki')))
    expect(ctx.jobs.get(id, agent.session.id)).toMatchObject({ label: '/digest knowledge/wiki' })
    expect((await ctx.jobs.wait(id, 5000, agent.session.id)).detail).toBe('1 entries filed, 2 skill draft(s)')
  })

  it('stops a killed import after the current chunk and keeps what was filed', async () => {
    let release: (() => void) | undefined
    const adapter = new ScriptedAdapter((options) => {
      const prompt = options.messages.map(message => message.content.map(block => block.type === 'text' ? block.text : '').join('')).join('')
      if (prompt.includes('pnpm test')) return textChunks('[{"text":"Run pnpm test before pushing.","kind":"shortcut","tags":[]}]')
      // The second chunk hangs until the test releases it, so the kill lands mid-import.
      return [{ type: 'block-start', index: 0, blockType: 'text' }]
    })
    class HangingAdapter extends LlmAdapter {
      override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        const chunks = adapter.stream(options)
        for await (const chunk of chunks) yield chunk
        const prompt = options.messages.map(message => message.content.map(block => block.type === 'text' ? block.text : '').join('')).join('')
        if (!prompt.includes('pnpm test')) {
          await new Promise<void>((resolve) => {
            release = resolve
            options.signal?.addEventListener('abort', () => { resolve() }, { once: true })
          })
          yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'aborted', code: 'ABORTED' } } }
        }
      }
    }
    const ctx = await setup(new HangingAdapter(), { maxFileBytes: 4000 })
    await withJobs(ctx)
    await knowledgeTree(root!)
    const { agent } = await liveAgent(ctx, root!)
    const result = await invoke(ctx, agent, 'from knowledge/wiki')
    const id = jobIdIn((result as { text?: string }).text ?? '')
    for (let i = 0; i < 200 && release === undefined; i += 1) await new Promise(resolve => setTimeout(resolve, 10))
    expect(release).toBeDefined()
    expect(ctx.jobs.kill(id, agent.session.id, 'enough')).toBe('requested')
    const settled = await ctx.jobs.wait(id, 5000, agent.session.id)
    expect(settled.status).toBe('killed')
    expect(ctx.jobs.read(id, agent.session.id).result).toMatch(/Import cancelled after 2 chunk\(s\); 1 candidate\(s\) were filed/u)
    expect(ctx.memory.list().map(entry => entry.text)).toEqual(['Run pnpm test before pushing.'])
  })

  it('writes skills inline even when background jobs are composed', async () => {
    const ctx = await setup(new ScriptedAdapter(() => textChunks('[]')), { maxFileBytes: 4000 })
    await withJobs(ctx)
    await knowledgeTree(root!)
    const { agent } = await liveAgent(ctx, root!)
    const result = await invoke(ctx, agent, 'from knowledge/wiki --as-skills')
    expect((result as { text?: string }).text ?? '').toMatch(/^Wrote 2 skill\(s\)/u)
    expect(ctx.jobs.list(agent.session.id)).toEqual([])
  })

  it('caps the number of files per import and reports the skipped ones', async () => {
    const adapter = new ScriptedAdapter(() => textChunks('[{"text":"one"}]'))
    const ctx = await setup(adapter, { maxFileBytes: 4000, maxFilesPerImport: 1 })
    await knowledgeTree(root!)
    const { agent } = await liveAgent(ctx, root!)
    const result = await invoke(ctx, agent, 'from knowledge')
    expect(result.kind).toBe('success')
    expect(adapter.requests).toHaveLength(1)
    expect((result as { text?: string }).text).toMatch(/skipped \d+/iu)
    expect((result as { text?: string }).text).toContain('file-cap')
  })

  it('stops cleanly when the invocation is aborted mid-import', async () => {
    const controller = new AbortController()
    const adapter = new ScriptedAdapter(() => {
      controller.abort()
      return textChunks('[{"text":"partial"}]')
    })
    const ctx = await setup(adapter, { maxFileBytes: 4000 })
    await knowledgeTree(root!)
    const { agent } = await liveAgent(ctx, root!)
    const result = await invoke(ctx, agent, 'from knowledge', controller.signal)
    expect(result.kind).toBe('error')
    expect(adapter.requests).toHaveLength(1)
  })

  it('reports a missing path, a missing route, and usage errors', async () => {
    const adapter = new ScriptedAdapter(() => textChunks('[]'))
    const ctx = await setup(adapter, { provider: undefined, model: undefined } as unknown as Partial<Learning.Config>)
    const { agent } = await liveAgent(ctx, root!)
    expect((await invoke(ctx, agent, 'from')).kind).toBe('error')
    expect((await invoke(ctx, agent, 'from does-not-exist')).kind).toBe('error')
    await knowledgeTree(root!)
    const noRoute = await invoke(ctx, agent, 'from knowledge')
    expect(noRoute.kind).toBe('error')
    expect((noRoute as { text?: string }).text).toMatch(/route/u)
    expect(adapter.requests).toHaveLength(0)
  })
})

describe('/learn consolidate', () => {
  /** Merges every note but those listed in `keep` into one note, and returns `unchanged` as itself. */
  function merging(options: { keep?: readonly string[]; unchanged?: readonly string[] } = {}) {
    return new ScriptedAdapter((request) => {
      const prompt = promptOf(request)
      const lines = [...prompt.matchAll(/^- \[([0-9a-f]{8})\] \([^)]*\) (.*)$/gmu)].map(match => ({ id: match[1]!, text: match[2]! }))
      const idOf = (text: string) => lines.find(line => line.text === text)?.id
      const keep = new Set((options.keep ?? []).map(idOf))
      const same = new Set((options.unchanged ?? []).map(idOf))
      const merged = lines.filter(line => !keep.has(line.id) && !same.has(line.id))
      return textChunks(JSON.stringify([
        ...merged.length === 0 ? [] : [{ text: `Merged: ${merged.map(line => line.text).join(' / ')}`, kind: 'fact', tags: ['merged'], from: merged.map(line => line.id) }],
        ...lines.filter(line => same.has(line.id)).map(line => ({ text: line.text, kind: 'fact', tags: [], from: [line.id] })),
      ]))
    })
  }

  it('rewrites a group of related notes as one note, archives the notes it replaces, and links both ways', async () => {
    const adapter = merging()
    const ctx = await setup(adapter, { fileAs: 'approved' })
    const { agent, session } = await liveAgent(ctx, root!)
    const project = Memory.workspaceTag(root!)
    const a = await ctx.memory.add({ text: 'pnpm test runs vitest in watch mode', kind: 'fact', tags: [project] }, 'approved')
    const b = await ctx.memory.add({ text: 'pnpm test runs vitest once in CI', kind: 'fact', tags: [project] }, 'approved')
    const other = await ctx.memory.add({ text: 'the logo is red', kind: 'fact', tags: [project] }, 'approved')
    const result = await invoke(ctx, agent, 'consolidate')
    expect(textOf(result)).toBe([
      'Consolidated 1 of 1 group(s): 2 note(s) became 1; 0 kept as they were.',
      'Replaced notes are archived: /memory archived lists them, /memory restore <id> brings one back.',
    ].join('\n'))
    const written = ctx.memory.list({ status: 'approved' }).find(entry => entry.text.startsWith('Merged:'))!
    expect(written).toMatchObject({ tags: ['merged', project], note: `consolidated from ${a.id}, ${b.id}` })
    for (const id of [a.id, b.id]) expect(ctx.memory.get(id)).toMatchObject({ status: 'archived', note: `consolidated into ${written.id}` })
    expect(ctx.memory.get(other.id)?.status).toBe('approved')
    expect(adapter.requests[0]?.system).toBe(Learning.CONSOLIDATE_SYSTEM_PROMPT)
    expect(adapter.requests[0]?.maxTokens).toBe(512)
    const logged = session.snapshotEvents().filter(event => event.type === 'session/learning-request')
    expect(logged.map(event => event.type === 'session/learning-request' ? [event.data.turn, event.data.source] : [])).toEqual([[0, undefined]])
  })

  it('keeps notes the answer returns unchanged or leaves out, and leaves a failed group as it was', async () => {
    let fail = false
    const merge = merging({ keep: ['api cache warming takes ten seconds'], unchanged: ['the api cache warms after deploys'] })
    const ctx = await setup(new ScriptedAdapter((request) => {
      if (fail) throw new Error('route down')
      return merge.script(request)
    }), { consolidateMaxGroupSize: 20 })
    const { agent } = await liveAgent(ctx, root!)
    // Related notes, none the same note as another, so the store keeps all four.
    for (const text of ['cache warms on boot in the api', 'the api cache warms after deploys', 'api cache warming takes ten seconds', 'cache warm-up on boot reads redis']) {
      await ctx.memory.add({ text, kind: 'fact', tags: [] }, 'approved')
    }
    expect(ctx.memory.recalled()).toHaveLength(4)
    fail = true
    const failed = textOf(await invoke(ctx, agent, 'consolidate'))
    expect(failed).toContain('Consolidated 0 of 1 group(s): 0 note(s) became 0; 4 kept as they were.')
    expect(failed).toContain('Failed 1 group(s): group 1 (route down); their notes are unchanged.')
    expect(ctx.memory.recalled()).toHaveLength(4)
    fail = false
    const done = textOf(await invoke(ctx, agent, 'consolidate'))
    expect(done).toContain('Consolidated 1 of 1 group(s): 2 note(s) became 1; 2 kept as they were.')
    expect(done).toContain('4 grouped note(s) have no project tag (saved before notes were tagged); run this from the project they belong to.')
    expect(ctx.memory.recalled().map(entry => entry.text).sort()).toEqual([
      'Merged: cache warms on boot in the api / cache warm-up on boot reads redis', 'api cache warming takes ten seconds', 'the api cache warms after deploys',
    ])
  })

  it('caps groups per run, keeps other projects out unless --all, says when nothing is related, and refuses unknown options', async () => {
    const ctx = await setup(merging(), { consolidateMaxGroups: 1 })
    const { agent } = await liveAgent(ctx, root!)
    expect(textOf(await invoke(ctx, agent, 'consolidate'))).toBe('Nothing to consolidate: no related notes in this project. /learn consolidate --all looks across every project.')
    const elsewhere = Memory.workspaceTag('/somewhere/else')
    for (const text of ['deploys use docker compose on staging', 'docker compose on staging restarts the api']) await ctx.memory.add({ text, kind: 'fact', tags: [elsewhere] }, 'approved')
    for (const text of ['the build uses tsdown for bundles', 'tsdown bundles the build into lib']) await ctx.memory.add({ text, kind: 'fact', tags: [elsewhere] }, 'approved')
    expect(ctx.memory.recalled()).toHaveLength(4)
    expect(textOf(await invoke(ctx, agent, 'consolidate'))).toMatch(/^Nothing to consolidate/u)
    const all = textOf(await invoke(ctx, agent, 'consolidate --all'))
    expect(all).toContain('Consolidated 1 of 1 group(s)')
    expect(all).toContain('1 more group(s) remain; run /learn consolidate again to continue.')
    // The next run takes the group the cap left; only then is nothing left.
    const next = textOf(await invoke(ctx, agent, 'consolidate --all'))
    expect(next).toContain('Consolidated 1 of 1 group(s)')
    expect(next).not.toContain('remain')
    expect(textOf(await invoke(ctx, agent, 'consolidate --all'))).toMatch(/^Nothing to consolidate: no related notes in memory\.$/u)
    expect((await invoke(ctx, agent, 'consolidate --bogus')).kind).toBe('error')
  })

  it('needs a route', async () => {
    const ctx = await setup(merging(), { provider: undefined, model: undefined } as unknown as Partial<Learning.Config>)
    const { agent } = await liveAgent(ctx, root!)
    await ctx.memory.add({ text: 'pnpm test runs vitest in watch mode', kind: 'fact', tags: [] }, 'approved')
    expect(await invoke(ctx, agent, 'consolidate')).toMatchObject({ kind: 'error', text: expect.stringContaining('No extraction route yet') as unknown })
  })

  it('runs as a background job owned by the agent when jobs are composed', async () => {
    const ctx = await setup(merging())
    await withJobs(ctx)
    const { agent } = await liveAgent(ctx, root!)
    for (const text of ['pnpm test runs vitest in watch mode', 'pnpm test runs vitest once in CI']) await ctx.memory.add({ text, kind: 'fact', tags: [] }, 'approved')
    const started = textOf(await invoke(ctx, agent, 'consolidate'))
    const id = /background job (learning-consolidate-[0-9a-f]+)/u.exec(started)?.[1] as JobId
    expect(ctx.jobs.get(id, agent.session.id)).toMatchObject({ kind: 'learning-consolidate', label: '/learn consolidate' })
    expect(await ctx.jobs.wait(id, 5000, agent.session.id)).toMatchObject({ status: 'completed', detail: '2 notes became 1' })
    expect(ctx.jobs.read(id, agent.session.id).result).toContain('Consolidated 1 of 1 group(s)')
  })
})
