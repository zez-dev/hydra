import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import AgentRegistry, { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import CommandRuntime, { CommandId } from '@deepseek-ai/dsh-commands'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as Memory from '@deepseek-ai/dsh-memory'
import * as MemoryTools from '@deepseek-ai/dsh-memory/tools'
import { isRecallMessage, isSameNote, jaccardSimilarity, normalizeForSimilarity, noteSimilarity, noteTerms, planCuration } from '@deepseek-ai/dsh-memory'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  vi.useRealTimers()
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

const DAY = 24 * 60 * 60 * 1000

async function setup(config: Partial<Memory.Config> = {}): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-memory-curator-'))
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

async function fakeAgent(ctx: Context, id = 'curator-agent'): Promise<Agent> {
  const scope = ctx.plugin(() => {})
  const session = Session.create(SessionId(id))
  const agent: Agent = {
    id: SessionId(id), options: {}, session, inbox: unsupportedInbox(),
    status: 'idle', ctx: scope.ctx,
    followup: () => {}, steer: () => {}, inject: () => {}, send: () => {}, cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  await ctx.agents.register(agent)
  return agent
}

async function preStep(ctx: Context, agent: Agent, request = 'which package manager do we use, pnpm?'): Promise<PreStepDecision> {
  const messages = [createUserMessage({ content: [{ type: 'text', text: request }], source: { kind: 'user' } })]
  return agentEvents(ctx, agent).waterfall(
    'agent/pre-step',
    { messages, prompt: { systemPrompt: '', tools: [] }, turn: 1, step: 1, signal: new AbortController().signal },
    () => Promise.resolve({ kind: 'enter' as const, messages }),
  )
}

const signal = new AbortController().signal

describe('similarity', () => {
  it('normalizes case, punctuation, and whitespace before comparing token sets', () => {
    expect(normalizeForSimilarity('  Use PNPM, not npm!  ')).toBe('use pnpm not npm')
    expect(jaccardSimilarity('use pnpm not npm', 'Use pnpm, not NPM.')).toBe(1)
    expect(jaccardSimilarity('a b c d', 'a b x y')).toBeCloseTo(2 / 6)
    expect(jaccardSimilarity('', '')).toBe(0)
  })
})

describe('planCuration', () => {
  const at = (daysAgo: number) => new Date(Date.parse('2026-09-20T00:00:00Z') - daysAgo * DAY).toISOString()
  const now = Date.parse('2026-09-20T00:00:00Z')
  const entry = (id: string, text: string, extra: Partial<Memory.MemoryEntry> = {}): Memory.MemoryEntry => ({
    id: id as Memory.MemoryEntryId, text, tags: [], kind: 'fact', status: 'approved',
    createdAt: at(100), updatedAt: at(100), recallCount: 0, ...extra,
  })

  it('marks entries stale after staleAfterDays without recall or use, and archives after archiveAfterDays', () => {
    const plan = planCuration([
      entry('fresh', 'fresh one', { lastRecalledAt: at(1) }),
      entry('old', 'old one', { lastRecalledAt: at(40) }),
      entry('older', 'older one', { lastUsedAt: at(95) }),
      entry('never', 'never recalled', { createdAt: at(50), updatedAt: at(50) }),
    ], { staleAfterDays: 30, archiveAfterDays: 90, duplicateThreshold: 0.85 }, now)
    expect(plan.stale.map(a => a.id)).toEqual(['old', 'never'])
    expect(plan.archive.map(a => a.id)).toEqual(['older'])
  })

  it('leaves candidates and rejected entries alone and never ages without a configured window', () => {
    const plan = planCuration([
      entry('c', 'candidate', { status: 'candidate', createdAt: at(400) }),
      entry('r', 'rejected', { status: 'rejected', createdAt: at(400) }),
      entry('a', 'approved', { createdAt: at(400) }),
    ], { duplicateThreshold: 0.85 }, now)
    expect(plan.stale).toEqual([])
    expect(plan.archive).toEqual([])
  })

  it('merges every rewording of a fact into its newest wording, unioning tags and archiving the older ones', () => {
    const plan = planCuration([
      entry('a', 'Run pnpm test before pushing.', { createdAt: at(10), tags: ['testing'] }),
      entry('b', 'Always run pnpm test before pushing to main.', { createdAt: at(5), tags: ['git'] }),
      entry('c', 'Before you push, run pnpm test', { createdAt: at(1) }),
      entry('d', 'pnpm build runs tsdown', { createdAt: at(1) }),
    ], { duplicateThreshold: 0.7 }, now)
    expect(plan.merges).toEqual([
      { into: 'c', from: 'a', tags: ['testing', 'git'] },
      { into: 'c', from: 'b', tags: ['testing', 'git'] },
    ])
  })

  it('plans merges over thousands of entries without comparing every pair', () => {
    const many = Array.from({ length: 6000 }, (_, index) => entry(`e${index}`, `service ${index} listens on port ${10000 + index} in region r${index % 7}`))
    const started = performance.now()
    const plan = planCuration([...many, entry('dup', 'service 42 listens on port 10042 in region r0', { createdAt: at(1) })], { duplicateThreshold: 0.7 }, now)
    expect(performance.now() - started).toBeLessThan(5000)
    expect(plan.merges).toEqual([{ into: 'dup', from: 'e42', tags: [] }])
  })
})

describe('note similarity', () => {
  it('treats a rewording or a fuller restatement as the same note and different facts as different', () => {
    expect(noteSimilarity('Run pnpm test before pushing.', 'Always run pnpm test before pushing to main.')).toBeGreaterThanOrEqual(0.7)
    expect(noteSimilarity('The tests are run with vitest', 'Tests run with Vitest.')).toBeGreaterThanOrEqual(0.7)
    expect(noteSimilarity('pnpm test runs vitest', 'pnpm build runs tsdown')).toBeLessThan(0.7)
    expect(noteSimilarity('use pnpm', 'never use npm')).toBeLessThan(0.7)
    expect(noteSimilarity('', '')).toBe(0)
  })

  it('never calls notes the same when a word they differ in carries a number', () => {
    const terms = (text: string) => noteTerms(text)
    expect(isSameNote(terms('the api listens on port 8080 in staging'), terms('the api listens on port 9090 in staging'), 0.7)).toBe(false)
    expect(isSameNote(terms('the api listens on port 8080 in staging'), terms('in staging the api listens on port 8080'), 0.7)).toBe(true)
    expect(isSameNote(terms('Run pnpm test before pushing.'), terms('Always run pnpm test before pushing to main.'), 0.7)).toBe(true)
    // A number only the longer note has is a different fact too.
    expect(isSameNote(terms('the api listens on port 8080'), terms('the api listens on port 8080 and 9090'), 0.7)).toBe(false)
  })
})

describe('curation in the store', () => {
  it('recall bumps counters and stale entries leave recall but stay searchable; archived leave search', async () => {
    const ctx = await setup({ staleAfterDays: 30, archiveAfterDays: 90, duplicateThreshold: 0.85 })
    const agent = await fakeAgent(ctx)
    const kept = await ctx.memory.add({ text: 'keep using pnpm', kind: 'fact', tags: [] }, 'approved')
    const first = await preStep(ctx, agent)
    expect(first.kind === 'enter' ? first.messages.filter(isRecallMessage) : []).toHaveLength(1)
    const bumped = ctx.memory.get(kept.id)!
    expect(bumped.recallCount).toBe(1)
    expect(bumped.lastRecalledAt).toBeDefined()

    const stale = await ctx.memory.add({ text: 'old habit', kind: 'shortcut', tags: [] }, 'approved')
    const ancient = await ctx.memory.add({ text: 'ancient lore', kind: 'fact', tags: [] }, 'approved')
    await ctx.memory.touch(stale.id, { lastRecalledAt: new Date(Date.now() - 40 * DAY).toISOString() })
    await ctx.memory.touch(ancient.id, { lastRecalledAt: new Date(Date.now() - 100 * DAY).toISOString() })
    const report = await ctx.memory.curate()
    expect(report).toMatchObject({ stale: 1, archived: 1, merged: 0 })
    expect(ctx.memory.get(stale.id)?.status).toBe('stale')
    expect(ctx.memory.get(ancient.id)?.status).toBe('archived')
    expect(ctx.memory.recalled().map(e => e.id)).toEqual([kept.id])
    expect(ctx.memory.search('old habit').map(e => e.id)).toEqual([stale.id])
    expect(ctx.memory.search('ancient')).toEqual([])
    expect(ctx.memory.list({ status: 'archived' }).map(e => e.id)).toEqual([ancient.id])
  })

  it('search through the tool marks returned entries used', async () => {
    const ctx = await setup({ staleAfterDays: 30, archiveAfterDays: 90, duplicateThreshold: 0.85 })
    const entry = await ctx.memory.add({ text: 'tests run per package', kind: 'shortcut', tags: [] }, 'approved')
    const result = await ctx.tools.execute({ signal, callId: ToolCallId('c1'), name: 'memory', arguments: { action: 'search', query: 'per package' } })
    expect(result.isError).toBe(false)
    expect(ctx.memory.get(entry.id)?.lastUsedAt).toBeDefined()
  })

  it('merges duplicates stored before the store checked for them on /memory curate, into the newest wording', async () => {
    const ctx = await setup({ staleAfterDays: 30, archiveAfterDays: 90 })
    const agent = await fakeAgent(ctx)
    const older = await ctx.memory.add({ text: 'Use pnpm for installs', kind: 'fact', tags: ['pnpm'] }, 'approved')
    const newer = await ctx.memory.add({ text: 'Builds use tsdown', kind: 'fact', tags: ['tooling'] }, 'approved')
    // An edit skips the duplicate check, as entries stored by earlier versions did.
    await ctx.memory.update(newer.id, { text: 'use pnpm for every install' })
    const command = ctx.commands.find(agent, 'memory')!
    const result = await command.handler({ commandId: CommandId('c1'), agent, rawInput: 'curate', attachments: [], signal })
    expect(result.kind).toBe('success')
    expect((result as { text: string }).text).toContain('merged 1')
    expect(ctx.memory.get(newer.id)).toMatchObject({ status: 'approved', text: 'use pnpm for every install', tags: ['tooling', 'pnpm'] })
    expect(ctx.memory.get(older.id)).toMatchObject({ status: 'archived' })
    expect(ctx.memory.get(older.id)?.note).toContain(newer.id)
    const archived = await command.handler({ commandId: CommandId('c2'), agent, rawInput: 'archived', attachments: [], signal })
    expect((archived as { text: string }).text).toContain(older.id)
  })

  it('curates with the default duplicate threshold when none is configured', async () => {
    await expect(setup({ staleAfterDays: 30 })).resolves.toBeDefined()
  })

  it('runs the curator at activation and once per process day', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-09-20T12:00:00Z') })
    const ctx = await setup({ staleAfterDays: 30, duplicateThreshold: 0.85 })
    const entry = await ctx.memory.add({ text: 'ages away', kind: 'fact', tags: [] }, 'approved')
    await ctx.memory.touch(entry.id, { lastRecalledAt: new Date(Date.now() - 31 * DAY).toISOString() })
    expect(ctx.memory.get(entry.id)?.status).toBe('approved')
    await vi.advanceTimersByTimeAsync(DAY)
    vi.useRealTimers()
    await vi.waitFor(() => { expect(ctx.memory.get(entry.id)?.status).toBe('stale') })
  })
})
