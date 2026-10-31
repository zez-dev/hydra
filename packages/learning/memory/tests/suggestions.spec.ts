import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
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
import { planSuggestions, type MemoryEntry, type MemorySuggestion } from '@deepseek-ai/dsh-memory'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function setup(config: Partial<Memory.Config> = {}): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-memory-suggest-'))
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
  await ctx.plugin(Memory, {
    maxRecallBytes: 6000, staleAfterDays: 30, archiveAfterDays: 90, duplicateThreshold: 0.95,
    skillSuggestThreshold: 0.6, skillSuggestMinEntries: 3, ...config,
  })
  return ctx
}

async function fakeAgent(ctx: Context, id = 'suggest-agent'): Promise<Agent> {
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
  return agent
}

function entry(id: string, text: string, tags: string[], status: MemoryEntry['status'] = 'approved'): MemoryEntry {
  return { id: id as MemoryEntry['id'], text, tags, kind: 'shortcut', status, createdAt: `2026-09-0${id.length}T00:00:00Z`, updatedAt: '2026-09-20T00:00:00Z', recallCount: 0 }
}

describe('planSuggestions', () => {
  it('clusters approved entries that share a tag, names the cluster after the dominant tag, and honors the minimum size', () => {
    const entries = [
      entry('a', 'Run vitest per package.', ['vitest', 'pnpm']),
      entry('b', 'Vitest needs the host addon built.', ['vitest']),
      entry('c', 'Filter one vitest scenario with -t.', ['vitest', 'snapshot']),
      entry('d', 'Unrelated fact.', ['git']),
      entry('e', 'Another git fact.', ['git']),
    ]
    const plan = planSuggestions(entries, [], { skillSuggestThreshold: 0.6, skillSuggestMinEntries: 3 })
    expect(plan).toHaveLength(1)
    expect(plan[0]).toMatchObject({ name: 'vitest' })
    expect([...plan[0]!.entryIds].sort()).toEqual(['a', 'b', 'c'])
  })

  it('clusters by text similarity without shared tags and ignores source and error tags', () => {
    const entries = [
      entry('a', 'export PATH with ~/.local/bin before running pnpm commands', ['source:readme.md']),
      entry('b', 'export PATH with ~/.local/bin before running pnpm', ['source:notes.md']),
      entry('c', 'export PATH with ~/.local/bin before pnpm commands run', ['error:abc123def0']),
      entry('d', 'restart the web app after building', ['source:readme.md', 'error:abc123def0']),
    ]
    const plan = planSuggestions(entries, [], { skillSuggestThreshold: 0.6, skillSuggestMinEntries: 3 })
    expect(plan).toHaveLength(1)
    expect([...plan[0]!.entryIds].sort()).toEqual(['a', 'b', 'c'])
    expect(plan[0]!.name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u)
  })

  it('skips clusters already covered by a suggestion and non-recalled entries', () => {
    const entries = [
      entry('a', 'one', ['vitest']), entry('b', 'two', ['vitest']), entry('c', 'three', ['vitest']),
      entry('x', 'cand', ['vitest'], 'candidate'), entry('y', 'gone', ['vitest'], 'archived'),
    ]
    const existing: MemorySuggestion[] = [{ id: 's1' as MemorySuggestion['id'], name: 'vitest', entryIds: ['a', 'b', 'c'] as MemoryEntry['id'][], createdAt: '2026-09-20T00:00:00Z', status: 'dismissed' }]
    expect(planSuggestions(entries, existing, { skillSuggestThreshold: 0.6, skillSuggestMinEntries: 3 })).toEqual([])
    const fresh = planSuggestions(entries, [], { skillSuggestThreshold: 0.6, skillSuggestMinEntries: 3 })
    expect(fresh).toHaveLength(1)
    expect([...fresh[0]!.entryIds].sort()).toEqual(['a', 'b', 'c'])
  })
})

describe('suggestion records', () => {
  it('writes suggestions during curation, lists them, and changes their status', async () => {
    const ctx = await setup()
    for (const text of ['Run vitest per package.', 'Vitest needs the host addon.', 'Filter vitest with -t.']) {
      await ctx.memory.add({ text, kind: 'shortcut', tags: ['vitest'] }, 'approved')
    }
    const report = await ctx.memory.curate()
    expect(report.suggested).toBe(1)
    const proposed = ctx.memory.suggestions({ status: 'proposed' })
    expect(proposed).toHaveLength(1)
    expect(proposed[0]).toMatchObject({ name: 'vitest', status: 'proposed' })
    expect(proposed[0]?.entryIds).toHaveLength(3)
    expect((await ctx.memory.curate()).suggested).toBe(0)
    const dismissed = await ctx.memory.setSuggestionStatus(proposed[0]!.id, 'dismissed')
    expect(dismissed.status).toBe('dismissed')
    expect(ctx.memory.suggestions({ status: 'proposed' })).toEqual([])
    expect(ctx.memory.getSuggestion(proposed[0]!.id)?.status).toBe('dismissed')
  })

  it('does not suggest when the threshold is not configured', async () => {
    const ctx = await setup({ skillSuggestThreshold: undefined } as never)
    for (const text of ['a vitest note', 'b vitest note', 'c vitest note']) {
      await ctx.memory.add({ text, kind: 'shortcut', tags: ['vitest'] }, 'approved')
    }
    expect((await ctx.memory.curate()).suggested).toBe(0)
    expect(ctx.memory.suggestions()).toEqual([])
  })

  it('lists proposed suggestions through /memory suggestions', async () => {
    const ctx = await setup()
    const agent = await fakeAgent(ctx)
    const command = ctx.commands.find(agent, 'memory')!
    const invoke = (rawInput: string) => command.handler({ commandId: CommandId('c'), agent, rawInput, attachments: [], signal: new AbortController().signal })
    const empty = await invoke('suggestions') as { kind: string; text?: string }
    expect(empty.kind).toBe('success')
    expect(empty.text).toContain('No skill suggestions')
    for (const text of ['Run vitest per package.', 'Vitest needs the host addon.', 'Filter vitest with -t.']) {
      await ctx.memory.add({ text, kind: 'shortcut', tags: ['vitest'] }, 'approved')
    }
    await ctx.memory.curate()
    const listed = await invoke('suggestions') as { kind: string; text?: string }
    expect(listed.text).toContain('vitest')
    expect(listed.text).toContain('/learn accept')
  })
})
