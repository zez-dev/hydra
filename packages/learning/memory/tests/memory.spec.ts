import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, ToolCallId, type UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import AgentRegistry, { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox, unsupportedModel } from '@deepseek-ai/dsh-agent-loop-testkit'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import CommandRuntime, { CommandId } from '@deepseek-ai/dsh-commands'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as Memory from '@deepseek-ai/dsh-memory'
import * as MemoryTools from '@deepseek-ai/dsh-memory/tools'
import { createMessage } from '@deepseek-ai/dsh-llm'
import { digestRecall, isRecallMessage, rankEntries, recalledIds, renderRecall, workspaceTag } from '@deepseek-ai/dsh-memory'
import type { MemoryEntry, MemoryEntryKind } from '@deepseek-ai/dsh-memory'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Context another plugin adds to a step; it starts no work. */
    'memory-test-plugin': { kind: 'memory-test-plugin' }
  }
}

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function setup(config: Partial<Memory.Config> = {}): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-memory-'))
  const ctx = new Context()
  context = ctx
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: join(root, 'storages') })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(Memory, { maxRecallBytes: 6000, ...config })
  await ctx.plugin(MemoryTools)
  return ctx
}

async function fakeAgent(ctx: Context, id = 'memory-agent', cwd?: string): Promise<Agent> {
  const scope = ctx.plugin(() => {})
  const session = cwd === undefined ? Session.create(SessionId(id)) : ctx.sessions.create(SessionId(id), { meta: { cwd } })
  const agent: Agent = {
    id: SessionId(id), options: {}, session, model: unsupportedModel(), inbox: unsupportedInbox(),
    status: 'idle', ctx: scope.ctx,
    followup: () => {}, steer: () => {}, inject: () => {}, send: () => {}, cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  await ctx.agents.register(agent)
  return agent
}

async function preStep(ctx: Context, agent: Agent, messages: UserMessage[] = []): Promise<PreStepDecision> {
  return agentEvents(ctx, agent).waterfall(
    'agent/pre-step',
    { messages, prompt: { systemPrompt: '', tools: [] }, modelSelection: { provider: 'mock', model: 'mock' }, turn: 1, step: 1, signal: new AbortController().signal },
    () => Promise.resolve({ kind: 'enter' as const, messages }),
  )
}

const signal = new AbortController().signal

describe('duplicates at the store', () => {
  it('turns a restatement into an update of the stored note: newest wording, tags joined, one entry', async () => {
    const ctx = await setup()
    const first = await ctx.memory.add({ text: 'Run pnpm test before pushing.', kind: 'shortcut', tags: ['testing'] }, 'approved')
    const again = await ctx.memory.add({ text: 'Always run pnpm test before pushing to main.', kind: 'fact', tags: ['git'] }, 'approved')
    expect(again.id).toBe(first.id)
    expect(ctx.memory.list()).toHaveLength(1)
    expect(ctx.memory.get(first.id)).toMatchObject({ text: 'Always run pnpm test before pushing to main.', kind: 'shortcut', tags: ['testing', 'git'], status: 'approved' })
    expect(ctx.memory.findDuplicate('run the pnpm tests before you push')?.id).toBe(first.id)
    expect(ctx.memory.findDuplicate('pnpm build runs tsdown')).toBeUndefined()
  })

  it('never touches a rejected note, never approves a candidate, revives a stale one, and ignores archived ones', async () => {
    const ctx = await setup()
    const rejected = await ctx.memory.add({ text: 'deploy on fridays', kind: 'fact', tags: [] }, 'rejected')
    expect(await ctx.memory.add({ text: 'Deploys on Fridays.', kind: 'fact', tags: ['ops'] }, 'approved')).toMatchObject({ id: rejected.id, text: 'deploy on fridays', tags: [], status: 'rejected' })
    const candidate = await ctx.memory.add({ text: 'the cache warms on boot', kind: 'fact', tags: [] }, 'candidate')
    expect(await ctx.memory.add({ text: 'cache warms on every boot', kind: 'fact', tags: [] }, 'approved')).toMatchObject({ id: candidate.id, status: 'candidate' })
    const stale = await ctx.memory.add({ text: 'logs live in /var/log/app', kind: 'fact', tags: [] }, 'approved')
    await ctx.memory.setStatus(stale.id, 'stale')
    expect(await ctx.memory.add({ text: 'the logs live in /var/log/app', kind: 'fact', tags: [] }, 'approved')).toMatchObject({ id: stale.id, status: 'approved' })
    const archived = await ctx.memory.add({ text: 'node 20 is required', kind: 'fact', tags: [] }, 'approved')
    await ctx.memory.setStatus(archived.id, 'archived')
    expect((await ctx.memory.add({ text: 'node 20 is required here', kind: 'fact', tags: [] }, 'approved')).id).not.toBe(archived.id)
  })

  it('lets the memory tool remember a fact twice without a second entry', async () => {
    const ctx = await setup()
    const agent = await fakeAgent(ctx)
    for (const text of ['tests run with vitest', 'the tests are run with vitest']) {
      await executeToolFixture(ctx, { signal, callId: ToolCallId(text), name: 'memory', agent, arguments: { action: 'remember', text } })
    }
    expect(ctx.memory.list().map(entry => entry.text)).toEqual(['the tests are run with vitest'])
  })
})

describe('memory store', () => {
  it('adds, lists by status, updates status, and forgets entries durably', async () => {
    const ctx = await setup()
    const entry = await ctx.memory.add({ text: 'pnpm lives in ~/.local/bin', kind: 'fact', tags: ['env'] }, 'candidate')
    expect(entry.status).toBe('candidate')
    expect(ctx.memory.list({ status: 'candidate' }).map(e => e.id)).toEqual([entry.id])
    await ctx.memory.setStatus(entry.id, 'approved')
    expect(ctx.memory.list({ status: 'approved' })).toHaveLength(1)
    const edited = await ctx.memory.update(entry.id, { text: 'pnpm lives in ~/.local/bin (corepack)', tags: ['env', 'pnpm'] })
    expect(edited).toMatchObject({ id: entry.id, status: 'approved', kind: 'fact', text: 'pnpm lives in ~/.local/bin (corepack)', tags: ['env', 'pnpm'] })
    expect(ctx.memory.get(entry.id)?.text).toBe('pnpm lives in ~/.local/bin (corepack)')
    await expect(ctx.memory.update(entry.id, { text: '   ' })).rejects.toThrow(/blank/u)
    expect(ctx.memory.search('pnpm')).toHaveLength(1)
    expect(await ctx.memory.forget(entry.id)).toBe(true)
    expect(ctx.memory.list()).toHaveLength(0)
  })

  it('survives a restart of the plugin over the same storage root', async () => {
    const ctx = await setup()
    await ctx.memory.add({ text: 'durable', kind: 'shortcut', tags: [] }, 'approved')
    const dir = root!
    await ctx.fiber.dispose()
    context = undefined
    const again = new Context()
    context = again
    await again.plugin(SystemPrompt)
    await again.plugin(ToolRuntime)
    await again.plugin(SessionStore)
    await again.plugin(SessionProjectionRegistry)
    await again.plugin(AgentRegistry)
    await again.plugin(CommandRuntime)
    await again.plugin(Storage)
    await again.plugin(StorageJson, { root: join(dir, 'storages') })
    await again.plugin(StorageDomain, { backend: 'json' })
    await again.plugin(Memory, { maxRecallBytes: 6000 })
    expect(again.memory.list().map(e => e.text)).toEqual(['durable'])
  })
})

describe('recall rendering', () => {
  it('renders approved and promoted entries inside a retrieved_memory block within the byte cap', () => {
    const text = renderRecall([
      { id: 'a' as never, text: 'one', kind: 'fact', tags: ['x'], status: 'approved', createdAt: 't', updatedAt: 't', recallCount: 0 },
      { id: 'b' as never, text: 'two', kind: 'shortcut', tags: [], status: 'promoted', createdAt: 't', updatedAt: 't', recallCount: 0 },
    ], 6000, ['preference'])
    expect(text).toContain('<retrieved_memory>')
    expect(text).toContain('one')
    expect(text).toContain('two')
    expect(text).toContain('</retrieved_memory>')
  })

  it('drops trailing entries once the byte cap is reached', () => {
    const entries = Array.from({ length: 50 }, (_, i) => ({
      id: String(i) as never, text: `entry number ${i} ${'x'.repeat(100)}`, kind: 'fact' as const, tags: [], status: 'approved' as const, createdAt: 't', updatedAt: 't', recallCount: 0,
    }))
    const text = renderRecall(entries, 1000, ['preference'])
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(1000)
    expect(text).toContain('entry number 0')
    expect(text).not.toContain('entry number 49')
  })

  it('renders nothing when the byte cap leaves no room for the first entry beside the head', () => {
    const entry: MemoryEntry = { id: 'a' as never, text: 'one', kind: 'fact', tags: [], status: 'approved', createdAt: 't', updatedAt: 't', recallCount: 0 }
    const full = renderRecall([entry], 6000, ['preference'])
    expect(full).toContain('one')
    expect(renderRecall([entry], Buffer.byteLength(full) - 1, ['preference'])).toBe('')
  })

  it('reads back the ids of the entries a rendered block carries', () => {
    const text = renderRecall([
      { id: 'a1b2c3d4' as never, text: 'one (with a parenthesis)', kind: 'fact', tags: ['x'], status: 'approved', createdAt: 't', updatedAt: 't', recallCount: 0 },
      { id: 'e5f6a7b8' as never, text: 'two', kind: 'preference', tags: [], status: 'approved', createdAt: 't', updatedAt: 't', recallCount: 0 },
    ], 6000, ['preference'])
    expect(recalledIds(text)).toEqual(['a1b2c3d4', 'e5f6a7b8'])
    expect(recalledIds('no block here')).toEqual([])
  })

  it('names the kinds it always carries, as configured, when it says what the block selects', () => {
    const entry: MemoryEntry = { id: 'a' as never, text: 'one', kind: 'fact', tags: [], status: 'approved', createdAt: 't', updatedAt: 't', recallCount: 0 }
    const selection = (always: MemoryEntryKind[]): string | undefined => renderRecall([entry], 6000, always).split('\n')[1]?.split(' More may be stored;')[0]
    expect(selection([])).toBe('A selection of notes from earlier work: notes that share words with the current task, this project\'s first.')
    expect(selection(['shortcut', 'preference']))
      .toBe('A selection of notes from earlier work: every shortcut and preference, plus notes that share words with the current task, this project\'s first.')
  })

  it('identifies recall messages by their plugin source form and digests their text', () => {
    const message = createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'plugin:dsh-memory', form: 'recall' } })
    expect(isRecallMessage(message)).toBe(true)
    expect(isRecallMessage(createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }))).toBe(false)
    expect(digestRecall('hello')).toBe(digestRecall('hello'))
    expect(digestRecall('hello')).not.toBe(digestRecall('bye'))
  })
})

describe('recall injection on agent/pre-step', () => {
  function ask(text: string): UserMessage {
    return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
  }

  function recalledText(decision: PreStepDecision): string | undefined {
    const recall = (decision.kind === 'enter' ? decision.messages : []).find(isRecallMessage)
    return recall === undefined ? undefined : (recall.content[0] as { text: string }).text
  }

  async function seed(ctx: Context): Promise<void> {
    await ctx.memory.add({ text: 'tests run with vitest from the repository root', kind: 'fact', tags: ['testing'] }, 'approved')
    await ctx.memory.add({ text: 'deployments use docker compose on the staging host', kind: 'fact', tags: ['deploy'] }, 'approved')
    await ctx.memory.add({ text: 'the bash workspace is /home/user/dsh-work', kind: 'fact', tags: ['environment'] }, 'approved')
  }

  it('injects nothing when no entry is approved', async () => {
    const ctx = await setup()
    const agent = await fakeAgent(ctx)
    await ctx.memory.add({ text: 'pending', kind: 'fact', tags: [] }, 'candidate')
    const decision = await preStep(ctx, agent, [ask('pending work?')])
    expect(recalledText(decision)).toBeUndefined()
  })

  it('recalls only the entries that relate to the turn\'s request', async () => {
    const ctx = await setup()
    const agent = await fakeAgent(ctx)
    await seed(ctx)
    const text = recalledText(await preStep(ctx, agent, [ask('How do I run the tests?')]))
    expect(text).toContain('vitest')
    expect(text).not.toContain('docker')
    expect(text).not.toContain('/home/user/dsh-work')
  })

  it('injects nothing when no approved entry relates to the request', async () => {
    const ctx = await setup()
    const agent = await fakeAgent(ctx)
    await seed(ctx)
    expect(recalledText(await preStep(ctx, agent, [ask('Write a haiku about autumn.')]))).toBeUndefined()
  })

  it('carries approved preferences into the first block in view, and not again while it stays in view', async () => {
    const ctx = await setup()
    const agent = await fakeAgent(ctx)
    await seed(ctx)
    await ctx.memory.add({ text: 'answer in short paragraphs', kind: 'preference', tags: [] }, 'approved')
    const first = await preStep(ctx, agent, [ask('Write a haiku about autumn.')])
    const text = recalledText(first)
    expect(text).toContain('short paragraphs')
    expect(text).not.toContain('vitest')
    agent.session.append('user/message', (first.kind === 'enter' ? first.messages : []).find(isRecallMessage)!, { surfaceOp: 'append' })
    expect(recalledText(await preStep(ctx, agent, [ask('Write another haiku about winter.')]))).toBeUndefined()
  })

  it('sends only notes not already in view, with the rules stated once per view', async () => {
    const ctx = await setup()
    const agent = await fakeAgent(ctx)
    await seed(ctx)
    const first = await preStep(ctx, agent, [ask('How do I run the tests, and how do deployments reach staging?')])
    const firstText = recalledText(first)
    expect(firstText).toContain('vitest')
    expect(firstText).toContain('docker compose')
    expect(firstText).toContain('Use a note only when its situation matches the current one')
    agent.session.append('user/message', (first.kind === 'enter' ? first.messages : []).find(isRecallMessage)!, { surfaceOp: 'append' })
    // Every related note is already in view, so nothing is sent again.
    expect(recalledText(await preStep(ctx, agent, [ask('How do deployments reach staging?')]))).toBeUndefined()
    // A newly related note comes alone, pointing at the rules already in view.
    const second = await preStep(ctx, agent, [ask('Where is the bash workspace?')])
    const later = recalledText(second)
    expect(later).toContain('/home/user/dsh-work')
    expect(later).not.toContain('vitest')
    expect(later).not.toContain('Use a note only when its situation matches the current one')
    expect(later).toContain('the rules of the earlier <retrieved_memory> block apply')
    // Notes from every block in view count, not only the newest block's.
    agent.session.append('user/message', (second.kind === 'enter' ? second.messages : []).find(isRecallMessage)!, { surfaceOp: 'append' })
    expect(recalledText(await preStep(ctx, agent, [ask('Run the tests from the bash workspace before deployments reach staging')]))).toBeUndefined()
  })

  it('says the block is a selection that always carries preferences, and that the memory tool\'s search lists every stored note', async () => {
    const ctx = await setup()
    const agent = await fakeAgent(ctx, 'project-agent', '/work/alpha')
    const fact = 'The billing service in /work/alpha deploys with make release'
    await ctx.memory.add({ text: fact, kind: 'fact', tags: [workspaceTag('/work/alpha')] }, 'approved')
    await ctx.memory.add({ text: 'answer in short paragraphs', kind: 'preference', tags: [] }, 'approved')
    // The request shares no word with the fact, so only the preference is recalled.
    const text = recalledText(await preStep(ctx, agent, [ask('What do you know about my projects?')]))
    expect(text).toContain('answer in short paragraphs')
    expect(text).not.toContain(fact)
    expect(text?.startsWith([
      '<retrieved_memory>',
      'A selection of notes from earlier work: every preference, plus notes that share words with the current task, this project\'s first.'
        + ' More may be stored; the `memory` tool\'s `search` without a query lists every stored note. Use a note only when',
    ].join('\n'))).toBe(true)
    const listed = await executeToolFixture(ctx, { signal, callId: ToolCallId('all'), name: 'memory', agent, arguments: { action: 'search' } })
    expect((listed.value as { text: string }[]).map(hit => hit.text).sort()).toEqual([fact, 'answer in short paragraphs'].sort())
  })

  it('tells the model to use a note only in the same situation, to check a matching one before acting, and to keep the request as asked', async () => {
    const ctx = await setup()
    const agent = await fakeAgent(ctx)
    await seed(ctx)
    const text = recalledText(await preStep(ctx, agent, [ask('How do I run the tests?')]))
    expect(text).toContain('Use a note only when its situation matches the current one')
    expect(text).toContain('never changes what the user asked for: answer the request as stated')
    expect(text).toContain('do not repeat an approach it records as failed')
    expect(text).toContain('What you observe now takes precedence')
  })

  it('recalls on a step that starts work without the user, such as a goal round, matched to its text', async () => {
    const ctx = await setup()
    const agent = await fakeAgent(ctx)
    await seed(ctx)
    const round = createUserMessage({ content: [{ type: 'text', text: 'Continue the goal: deploy to staging' }], source: { kind: 'goal', goalId: 'g' as never, revision: 1, round: 2 } })
    const first = await preStep(ctx, agent, [round])
    expect(recalledText(first)).toContain('docker compose')
    agent.session.append('user/message', (first.kind === 'enter' ? first.messages : []).find(isRecallMessage)!, { surfaceOp: 'append' })
    // A plugin's own message starts no work, even when its words would match other entries.
    const plugin = createUserMessage({ content: [{ type: 'text', text: 'How do I run the tests?' }], source: { kind: 'memory-test-plugin' } })
    expect(recalledText(await preStep(ctx, agent, [plugin]))).toBeUndefined()
  })

  it('recalls from the latest request and reply when no block is in view, as after a compaction, then holds it', async () => {
    const ctx = await setup()
    const agent = await fakeAgent(ctx)
    await seed(ctx)
    // A session with nothing on its surface has nothing to match yet.
    expect(recalledText(await preStep(ctx, agent))).toBeUndefined()
    // Only the latest request counts, and a plugin's own message is not one.
    agent.session.append('user/message', ask('How do deployments reach staging?'), { surfaceOp: 'append' })
    agent.session.append('user/message', ask('The tests fail on CI'), { surfaceOp: 'append' })
    agent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'staging deploy notes' }], source: { kind: 'memory-test-plugin' } }), { surfaceOp: 'append' })
    agent.session.append('assistant/message', {
      stream: [], turn: 1, step: 1,
      message: createMessage({ role: 'assistant', content: [{ type: 'text', text: 'I will rerun them with vitest.' }], source: { kind: 'model', provider: 'p', model: 'm' } }),
    }, { surfaceOp: 'append' })
    const first = await preStep(ctx, agent)
    expect(recalledText(first)).toContain('vitest from the repository root')
    expect(recalledText(first)).not.toContain('docker compose')
    agent.session.append('user/message', (first.kind === 'enter' ? first.messages : []).find(isRecallMessage)!, { surfaceOp: 'append' })
    for (let step = 0; step < 3; step += 1) expect(recalledText(await preStep(ctx, agent))).toBeUndefined()
  })

  it('leaves out a note that shares only a passing word with the work, and keeps the one about the same situation', async () => {
    const ctx = await setup()
    const agent = await fakeAgent(ctx)
    await ctx.memory.add({ text: 'The billing report sum overflows the int32 column; use bigint in report_totals.sql', kind: 'fact', tags: ['lesson'] }, 'approved')
    await ctx.memory.add({ text: 'The sum helper in math.ts rounds floats; call sumExact for currency', kind: 'fact', tags: ['lesson'] }, 'approved')
    const text = recalledText(await preStep(ctx, agent, [ask('fix the sum helper in math.ts')]))
    expect(text).toContain('sumExact')
    expect(text).not.toContain('billing')
  })

  it('ranks notes from this project first and hides the project tag', async () => {
    const ctx = await setup({ recallLimit: 1 })
    const agent = await fakeAgent(ctx, 'project-agent', '/work/alpha')
    await ctx.memory.add({ text: 'the tests run with jest', kind: 'fact', tags: [workspaceTag('/work/beta')] }, 'approved')
    await ctx.memory.add({ text: 'the tests run with vitest', kind: 'fact', tags: [workspaceTag('/work/alpha')] }, 'approved')
    const text = recalledText(await preStep(ctx, agent, [ask('how do the tests run')]))
    expect(text).toContain('vitest')
    expect(text).not.toContain('jest')
    expect(text).not.toContain('workspace:')
  })

  it('returns at most recallLimit related entries', async () => {
    const ctx = await setup({ recallLimit: 2 })
    const agent = await fakeAgent(ctx)
    for (const name of ['alpha', 'beta', 'gamma', 'delta']) await ctx.memory.add({ text: `test suite ${name} runs nightly`, kind: 'fact', tags: [] }, 'approved')
    const text = recalledText(await preStep(ctx, agent, [ask('when does the test suite run?')]))
    expect(text?.match(/^- /gm)).toHaveLength(2)
  })

  it('retrieves nothing on a step without a user message, and does not repeat a visible block', async () => {
    const ctx = await setup()
    const agent = await fakeAgent(ctx)
    await seed(ctx)
    const first = await preStep(ctx, agent, [ask('How do I run the tests?')])
    const recall = (first.kind === 'enter' ? first.messages : []).find(isRecallMessage)!
    // The loop would log the entered message; simulate that commit.
    agent.session.append('user/message', recall, { surfaceOp: 'append' })
    expect(recalledText(await preStep(ctx, agent))).toBeUndefined()
    expect(recalledText(await preStep(ctx, agent, [ask('And how do I run the tests in watch mode?')]))).toBeUndefined()
  })

  it('adds a new block when a later request relates to different entries', async () => {
    const ctx = await setup()
    const agent = await fakeAgent(ctx)
    await seed(ctx)
    const first = await preStep(ctx, agent, [ask('How do I run the tests?')])
    agent.session.append('user/message', (first.kind === 'enter' ? first.messages : []).find(isRecallMessage)!, { surfaceOp: 'append' })
    const text = recalledText(await preStep(ctx, agent, [ask('How do deployments reach staging?')]))
    expect(text).toContain('docker compose')
    expect(text).not.toContain('vitest')
  })
})

describe('rankEntries', () => {
  const entry = (id: string, text: string, tags: string[] = []): MemoryEntry => ({
    id, text, kind: 'fact', tags, status: 'approved', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
  } as unknown as MemoryEntry)

  it('never matches the project tag\'s path words, and keeps a one-word query\'s single-word matches', () => {
    const tagged = entry('a', 'deploys run nightly', [workspaceTag('/home/user/project')])
    expect(rankEntries([tagged], 'project home', 5, { workspace: '/home/user/project' })).toEqual([])
    expect(rankEntries([tagged, entry('b', 'builds run hourly')], 'nightly', 5).map(hit => hit.id)).toEqual(['a'])
  })

  it('ranks other projects\' notes below untagged ones, and applies no floor unless asked', () => {
    const own = entry('own', 'cache warms on boot', [workspaceTag('/a')])
    const loose = entry('loose', 'cache warms on boot')
    const other = entry('other', 'cache warms on boot', [workspaceTag('/b')])
    expect(rankEntries([other, loose, own], 'cache warms', 5, { workspace: '/a' }).map(hit => hit.id)).toEqual(['own', 'loose', 'other'])
    const weak = entry('weak', 'the cache size is fixed')
    expect(rankEntries([own, weak], 'cache warms boot', 5).map(hit => hit.id)).toEqual(['own', 'weak'])
    expect(rankEntries([own, weak], 'cache warms boot', 5, { minMatchedTerms: 2 }).map(hit => hit.id)).toEqual(['own'])
    // `weak` has three words, one of them matched: a third of the note is about the work.
    expect(rankEntries([own, weak], 'cache warms boot', 5, { minMatchedTerms: 2, minCoverage: 0.3 }).map(hit => hit.id)).toEqual(['own', 'weak'])
    expect(rankEntries([own, weak], 'cache warms boot', 5, { minMatchedTerms: 2, minCoverage: 0.5 }).map(hit => hit.id)).toEqual(['own'])
    expect(rankEntries([own, weak], 'cache warms boot', 5, { scoreFloor: 0.9 }).map(hit => hit.id)).toEqual(['own'])
  })
})

describe('memory tool', () => {
  it('tags what it remembers with the session\'s project and never shows the tag', async () => {
    const ctx = await setup()
    const agent = await fakeAgent(ctx, 'tool-agent', '/work/alpha')
    await executeToolFixture(ctx, { signal, callId: ToolCallId('w1'), name: 'memory', agent, arguments: { action: 'remember', text: 'the build needs node 22', tags: ['build'] } })
    expect(ctx.memory.list()[0]?.tags).toEqual(['build', workspaceTag('/work/alpha')])
    await executeToolFixture(ctx, { signal, callId: ToolCallId('w0'), name: 'memory', agent, arguments: { action: 'remember', text: 'deploys go through make' } })
    expect(ctx.memory.list().find(entry => entry.text === 'deploys go through make')?.tags).toEqual([workspaceTag('/work/alpha')])
    const found = await executeToolFixture(ctx, { signal, callId: ToolCallId('w2'), name: 'memory', agent, arguments: { action: 'search', query: 'build node' } })
    expect(JSON.stringify(found.value)).not.toContain('workspace:')
    const listed = await ctx.commands.find(agent, 'memory')!.handler({ commandId: CommandId('l'), agent, rawInput: '', attachments: [], signal })
    expect((listed as { text?: string }).text).toContain('the build needs node 22')
    expect((listed as { text?: string }).text).not.toContain('workspace:')
  })

  it('remembers an approved entry attributed to the calling session, searches it, and forgets it', async () => {
    const ctx = await setup()
    const agent = await fakeAgent(ctx)
    const remembered = await executeToolFixture(ctx, { signal, callId: ToolCallId('m1'), name: 'memory', agent, arguments: { action: 'remember', text: 'tests run with vitest', kind: 'fact', tags: ['testing'] } })
    expect(remembered.isError).toBe(false)
    const [entry] = ctx.memory.list({ status: 'approved' })
    expect(entry).toMatchObject({ text: 'tests run with vitest', sourceSessionId: agent.id })
    const found = await executeToolFixture(ctx, { signal, callId: ToolCallId('m2'), name: 'memory', agent, arguments: { action: 'search', query: 'which runner do the tests use' } })
    expect(found.isError).toBe(false)
    expect(JSON.stringify(found.value)).toContain(entry!.id)
    const forgotten = await executeToolFixture(ctx, { signal, callId: ToolCallId('m3'), name: 'memory', agent, arguments: { action: 'forget', id: entry!.id } })
    expect(forgotten.isError).toBe(false)
    expect(ctx.memory.list()).toHaveLength(0)
  })

  it('rejects remember without text', async () => {
    const ctx = await setup()
    const agent = await fakeAgent(ctx)
    const result = await executeToolFixture(ctx, { signal, callId: ToolCallId('m4'), name: 'memory', agent, arguments: { action: 'remember' } })
    expect(result.isError).toBe(true)
  })
})

describe('/memory command', () => {
  it('lists entries and forgets one by id', async () => {
    const ctx = await setup()
    const agent = await fakeAgent(ctx)
    const entry = await ctx.memory.add({ text: 'listed', kind: 'fact', tags: [] }, 'approved')
    const definition = ctx.commands.find(agent, 'memory')!
    const listed = await definition.handler({ commandId: CommandId('c1'), agent, rawInput: '', attachments: [], signal })
    expect(listed.kind).toBe('success')
    expect((listed as { text?: string }).text).toContain('listed')
    const forgotten = await definition.handler({ commandId: CommandId('c2'), agent, rawInput: `forget ${entry.id}`, attachments: [], signal })
    expect(forgotten.kind).toBe('success')
    expect(ctx.memory.list()).toHaveLength(0)
    const missing = await definition.handler({ commandId: CommandId('c3'), agent, rawInput: 'forget nope', attachments: [], signal })
    expect(missing.kind).toBe('error')
  })

  it('restores an archived entry, and refuses an entry that is not archived or does not exist', async () => {
    const ctx = await setup()
    const agent = await fakeAgent(ctx)
    const definition = ctx.commands.find(agent, 'memory')!
    const run = async (rawInput: string) => definition.handler({ commandId: CommandId('r'), agent, rawInput, attachments: [], signal })
    const entry = await ctx.memory.add({ text: 'the build needs node 22', kind: 'fact', tags: [] }, 'approved')
    expect(await run(`restore ${entry.id}`)).toEqual({ kind: 'error', text: `Memory entry ${entry.id} is approved, not archived.` })
    await ctx.memory.setStatus(entry.id, 'archived')
    expect(await run(`restore ${entry.id}`)).toEqual({ kind: 'success', text: `Restored ${entry.id}; it is recalled again.` })
    expect(ctx.memory.get(entry.id)?.status).toBe('approved')
    expect(await run('restore nope')).toEqual({ kind: 'error', text: 'No memory entry nope.' })
  })
})
