import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as Memory from '@deepseek-ai/dsh-memory'
import * as Learning from '@deepseek-ai/dsh-learning'
import LearningController from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function setup(curation: Partial<Memory.Config> = {}): Promise<{ ctx: Context; controller: LearningController }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-learning-controller-'))
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
  await ctx.plugin(Memory, { maxRecallBytes: 6000, ...curation })
  await ctx.plugin(Learning, {
    minToolCalls: 3, maxCandidatesPerTurn: 5, maxTranscriptBytes: 24000, maxOutputTokens: 512, timeoutMs: 60000,
    skillsRoot: join(root, 'skills'),
  })
  await ctx.plugin(LearningController)
  const controller = ctx.get('learningController') as LearningController
  return { ctx, controller }
}

describe('LearningController', () => {
  it('publishes the learning namespace with direct list, review, forget, and promote methods', async () => {
    const { controller } = await setup()
    expect(controller.typertRemote).toMatchObject({ serviceKey: 'learningController', namespace: 'learning' })
    expect(remoteMethods(controller)).toEqual([
      { method: 'list', invocation: { kind: 'direct' } },
      { method: 'curate', invocation: { kind: 'direct' } },
      { method: 'review', invocation: { kind: 'direct' } },
      { method: 'update', invocation: { kind: 'direct' } },
      { method: 'forget', invocation: { kind: 'direct' } },
      { method: 'skills', invocation: { kind: 'direct' } },
      { method: 'readSkill', invocation: { kind: 'direct' } },
      { method: 'writeSkill', invocation: { kind: 'direct' } },
      { method: 'deleteSkill', invocation: { kind: 'direct' } },
      { method: 'suggestions', invocation: { kind: 'direct' } },
      { method: 'acceptSuggestion', invocation: { kind: 'direct' } },
      { method: 'dismissSuggestion', invocation: { kind: 'direct' } },
      { method: 'promote', invocation: { kind: 'direct' } },
    ])
  })

  it('lists proposed suggestions with their entries, accepts one into a bundled skill, and dismisses another', async () => {
    const { ctx, controller } = await setup({
      staleAfterDays: 30, archiveAfterDays: 90, duplicateThreshold: 0.95, skillSuggestThreshold: 0.6, skillSuggestMinEntries: 3,
    })
    for (const text of ['Run vitest per package.', 'Vitest needs the host addon.', 'Filter vitest with -t.']) {
      await ctx.memory.add({ text, kind: 'shortcut', tags: ['vitest'] }, 'approved')
    }
    for (const text of ['Commit with git add -A.', 'Git worktrees share the stash.', 'Git merge --no-edit keeps going.']) {
      await ctx.memory.add({ text, kind: 'shortcut', tags: ['git'] }, 'approved')
    }
    expect((await controller.curate()).suggested).toBe(2)
    const listed = await controller.suggestions()
    expect(listed.suggestions.map(suggestion => suggestion.name).sort()).toEqual(['git', 'vitest'])
    expect(listed.suggestions[0]?.entries).toHaveLength(3)
    const vitest = listed.suggestions.find(suggestion => suggestion.name === 'vitest')!
    const git = listed.suggestions.find(suggestion => suggestion.name === 'git')!
    const accepted = await controller.acceptSuggestion({ id: vitest.id, name: 'vitest-habits' })
    expect(accepted).toEqual({ path: join(root!, 'skills', 'vitest-habits', 'SKILL.md'), name: 'vitest-habits' })
    const skill = await readFile(accepted.path, 'utf8')
    expect(skill).toContain('name: vitest-habits')
    expect(skill).toContain('- Run vitest per package.')
    expect(skill).toContain('- Filter vitest with -t.')
    expect(vitest.entries.every(entry => ctx.memory.get(entry.id as never)?.status === 'promoted')).toBe(true)
    expect(await controller.dismissSuggestion({ id: git.id })).toMatchObject({ id: git.id, status: 'dismissed' })
    expect((await controller.suggestions()).suggestions).toEqual([])
    await expect(controller.acceptSuggestion({ id: 'missing' })).rejects.toThrow(/No skill suggestion/u)
  })

  it('lists curated entries apart and runs the curator on request', async () => {
    const { ctx, controller } = await setup({ staleAfterDays: 30, archiveAfterDays: 90, duplicateThreshold: 0.85 })
    const fresh = await ctx.memory.add({ text: 'fresh', kind: 'fact', tags: [] }, 'approved')
    const old = await ctx.memory.add({ text: 'old', kind: 'fact', tags: [] }, 'approved')
    await ctx.memory.touch(old.id, { lastRecalledAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString() })
    expect(await controller.curate()).toEqual({ stale: 1, archived: 0, merged: 0, suggested: 0 })
    const snapshot = await controller.list()
    expect(snapshot.recalled.map(entry => entry.id)).toEqual([fresh.id])
    expect(snapshot.curated.map(entry => [entry.id, entry.status])).toEqual([[old.id, 'stale']])
  })

  it('reports an unconfigured curator as an error', async () => {
    const { controller } = await setup()
    await expect(controller.curate()).rejects.toThrow(/curation is not configured/u)
  })

  it('lists candidates apart from the recalled entries', async () => {
    const { ctx, controller } = await setup()
    const candidate = await ctx.memory.add({ text: 'pnpm lives in ~/.local/bin', kind: 'fact', tags: ['pnpm'] }, 'candidate')
    const approved = await ctx.memory.add({ text: 'run one package at a time', kind: 'shortcut', tags: [] }, 'approved')
    await ctx.memory.add({ text: 'ignored', kind: 'fact', tags: [] }, 'rejected')
    const snapshot = await controller.list()
    expect(snapshot.candidates.map(entry => entry.id)).toEqual([candidate.id])
    expect(snapshot.candidates[0]).toMatchObject({ text: 'pnpm lives in ~/.local/bin', kind: 'fact', tags: ['pnpm'], status: 'candidate' })
    expect(snapshot.recalled.map(entry => entry.id)).toEqual([approved.id])
  })

  it('reviews a candidate into approved or rejected', async () => {
    const { ctx, controller } = await setup()
    const first = await ctx.memory.add({ text: 'a', kind: 'fact', tags: [] }, 'candidate')
    const second = await ctx.memory.add({ text: 'b', kind: 'fact', tags: [] }, 'candidate')
    expect(await controller.review({ id: first.id, decision: 'approve' })).toMatchObject({ id: first.id, status: 'approved' })
    expect(await controller.review({ id: second.id, decision: 'reject' })).toMatchObject({ id: second.id, status: 'rejected' })
    expect(ctx.memory.recalled().map(entry => entry.id)).toEqual([first.id])
  })

  it('edits an entry in place and lists, writes, reads, and deletes skills', async () => {
    const { ctx, controller } = await setup()
    const entry = await ctx.memory.add({ text: 'old text', kind: 'fact', tags: ['a'] }, 'approved')
    const edited = await controller.update({ id: String(entry.id), text: 'new text', tags: ['a', 'b'] })
    expect(edited).toMatchObject({ id: String(entry.id), text: 'new text', tags: ['a', 'b'], status: 'approved' })
    expect(await controller.skills()).toEqual({ skills: [] })
    const written = await controller.writeSkill({ name: 'release-checklist', content: '---\nname: release-checklist\ndescription: "Steps before a release"\n---\n\n# Release\n1. tag\n' })
    expect(written.path.endsWith('/release-checklist/SKILL.md')).toBe(true)
    expect(await controller.skills()).toMatchObject({ skills: [{ name: 'release-checklist', description: 'Steps before a release' }] })
    expect((await controller.readSkill({ name: 'release-checklist' })).content).toContain('# Release')
    expect((await controller.readSkill({ name: 'missing' })).content).toBeNull()
    await expect(controller.writeSkill({ name: 'Bad Name', content: 'x' })).rejects.toThrow(/skill name/u)
    expect(await controller.deleteSkill({ name: 'release-checklist' })).toEqual({ removed: true })
    expect(await controller.deleteSkill({ name: 'release-checklist' })).toEqual({ removed: false })
    expect(await controller.skills()).toEqual({ skills: [] })
  })

  it('forgets an entry and reports whether one existed', async () => {
    const { ctx, controller } = await setup()
    const entry = await ctx.memory.add({ text: 'a', kind: 'fact', tags: [] }, 'approved')
    expect(await controller.forget({ id: entry.id })).toEqual({ removed: true })
    expect(await controller.forget({ id: entry.id })).toEqual({ removed: false })
  })

  it('promotes an entry to a skill file through the learning service', async () => {
    const { ctx, controller } = await setup()
    const entry = await ctx.memory.add({ text: 'Run one package with pnpm vitest run <dir>.', kind: 'shortcut', tags: ['vitest'] }, 'approved')
    const result = await controller.promote({ id: entry.id, name: 'run-one-package' })
    expect(result.path).toBe(join(root!, 'skills', 'run-one-package', 'SKILL.md'))
    expect(await readFile(result.path, 'utf8')).toContain('name: run-one-package')
    expect(ctx.memory.get(entry.id)).toMatchObject({ status: 'promoted' })
  })

  it('rejects an invalid skill name and an unknown entry without writing', async () => {
    const { ctx, controller } = await setup()
    const entry = await ctx.memory.add({ text: 'a', kind: 'fact', tags: [] }, 'approved')
    await expect(controller.promote({ id: entry.id, name: 'Bad Name' })).rejects.toThrow(/skill name/u)
    await expect(controller.promote({ id: 'missing', name: 'fine' })).rejects.toThrow(/No memory entry/u)
    expect(ctx.memory.get(entry.id)).toMatchObject({ status: 'approved' })
  })
})
