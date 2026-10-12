import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillFilesystem from '@deepseek-ai/dsh-skill-filesystem'
import CommandRuntime, { CommandId } from '@deepseek-ai/dsh-commands'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import type { Agent } from '@deepseek-ai/dsh-agent'
import * as SkillLock from '@deepseek-ai/dsh-skill-lock'

const contexts: Context[] = []
const roots: string[] = []
const signal = new AbortController().signal

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(context => context.fiber.dispose()))
  await Promise.allSettled(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/** A workspace with a skill root the provider is pointed at. */
async function workspace(): Promise<{ cwd: string; skills: string }> {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-skill-lock-'))
  roots.push(cwd)
  const skills = join(cwd, 'skills')
  await mkdir(skills, { recursive: true })
  return { cwd, skills }
}

/** Write a directory-bundled skill with a SKILL.md and any extra files. */
async function writeSkill(
  root: string,
  name: string,
  body: string,
  extras: Record<string, string> = {},
): Promise<string> {
  const dir = join(root, name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} skill\n---\n\n${body}\n`, 'utf8')
  for (const [relative, content] of Object.entries(extras)) {
    const full = join(dir, relative)
    await mkdir(join(full, '..'), { recursive: true })
    await writeFile(full, content, 'utf8')
  }
  return dir
}

async function bench(skillRoot: string, config: Partial<SkillLock.Config> = {}): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(SkillFilesystem, {
    includeDefaultRoots: false, customSkillDirs: [skillRoot], watch: false,
  })
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(SkillLock, { enabled: true, path: '.dsh/skills.lock.json', warnOnDrift: false, ...config })
  return ctx
}

let sessionCounter = 0

function session(ctx: Context, cwd: string): Session {
  sessionCounter += 1
  return ctx.sessions.create(SessionId(`skill-lock-session-${String(sessionCounter)}`), { meta: { cwd } })
}

async function fakeAgent(ctx: Context, target: Session): Promise<Agent> {
  const scope = ctx.plugin({ apply: () => {} })
  await scope.await()
  return {
    id: target.id, options: {}, session: target, inbox: {} as never,
    status: 'idle', ctx: scope.ctx,
    followup: () => {}, steer: () => {}, inject: () => {}, send: () => {}, cancel() {},
    runMaintenance: (task: (used: AbortSignal) => unknown) => task(signal),
    whenIdle: async () => {}, dispose: async () => {},
  } as unknown as Agent
}

async function invoke(ctx: Context, cwd: string, rawInput: string): Promise<CommandResult> {
  const agent = await fakeAgent(ctx, session(ctx, cwd))
  const command = ctx.commands.find(agent, 'skills-lock')
  if (command === undefined) throw new Error('skills-lock command is not registered')
  return await command.handler({
    commandId: CommandId('c1'), agent, rawInput, attachments: [], signal,
  })
}

describe('status', () => {
  it('reports a discovered skill as new before anything is locked', async () => {
    const { cwd, skills } = await workspace()
    await writeSkill(skills, 'triage', 'original body')
    const ctx = await bench(skills)
    const entries = await ctx.skillLock.status(cwd)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ name: 'triage', state: 'new', virtual: false })
    expect(entries[0]?.digest).toMatch(/^[0-9a-f]{64}$/)
  })

  it('reports it locked after a lock, and drifted once its body changes', async () => {
    const { cwd, skills } = await workspace()
    const dir = await writeSkill(skills, 'triage', 'original body')
    const ctx = await bench(skills)
    await ctx.skillLock.lock(cwd)
    expect((await ctx.skillLock.status(cwd))[0]).toMatchObject({ state: 'locked' })

    await writeFile(join(dir, 'SKILL.md'), '---\nname: triage\ndescription: triage skill\n---\n\nedited body\n', 'utf8')
    const drifted = (await ctx.skillLock.status(cwd))[0]
    expect(drifted).toMatchObject({ state: 'drifted' })
    expect(drifted?.digest).not.toBe(drifted?.recordedDigest)
  })

  it('drifts when a resource file is added beside the instructions', async () => {
    const { cwd, skills } = await workspace()
    const dir = await writeSkill(skills, 'triage', 'body')
    const ctx = await bench(skills)
    await ctx.skillLock.lock(cwd)
    await writeFile(join(dir, 'reference.md'), 'extra guidance', 'utf8')
    expect((await ctx.skillLock.status(cwd))[0]).toMatchObject({ state: 'drifted' })
  })

  it('reports a record whose skill disappeared as missing', async () => {
    const { cwd, skills } = await workspace()
    const dir = await writeSkill(skills, 'triage', 'body')
    const ctx = await bench(skills)
    await ctx.skillLock.lock(cwd)
    await rm(dir, { recursive: true, force: true })
    const entries = await ctx.skillLock.status(cwd)
    expect(entries).toEqual([expect.objectContaining({ name: 'triage', state: 'missing' })])
  })

  it('warns once per drifted skill only when the deployment asked for it', async () => {
    const { cwd, skills } = await workspace()
    const dir = await writeSkill(skills, 'triage', 'body')
    const quiet = await bench(skills)
    await quiet.skillLock.lock(cwd)
    await writeFile(join(dir, 'SKILL.md'), '---\nname: triage\ndescription: triage skill\n---\n\nchanged\n', 'utf8')
    const quietWarn = vi.spyOn(quiet.logger, 'warn').mockImplementation(() => {})
    await quiet.skillLock.status(cwd)
    expect(quietWarn).not.toHaveBeenCalled()

    const loud = await bench(skills, { warnOnDrift: true })
    const loudWarn = vi.spyOn(loud.logger, 'warn').mockImplementation(() => {})
    await loud.skillLock.status(cwd)
    expect(loudWarn).toHaveBeenCalledTimes(1)
    expect(String(loudWarn.mock.calls[0]?.[0])).toContain('triage')
  })
})

describe('lock and unlock', () => {
  it('writes a lockfile at the configured path and records what it covered', async () => {
    const { cwd, skills } = await workspace()
    await writeSkill(skills, 'triage', 'body', { 'ref/a.md': 'a' })
    const ctx = await bench(skills)
    const result = await ctx.skillLock.lock(cwd)
    expect(result.locked).toEqual(['triage'])
    const text = await readFile(ctx.skillLock.path(cwd), 'utf8')
    const parsed = SkillLock.parseLockFile('lock', text)
    expect(parsed.skills[0]).toMatchObject({ name: 'triage', files: 2 })
    expect(typeof parsed.skills[0]?.root).toBe('string')
    expect(ctx.skillLock.path(cwd)).toBe(join(cwd, '.dsh/skills.lock.json'))
  })

  it('locks only the named skills and reports a name that matched nothing', async () => {
    const { cwd, skills } = await workspace()
    await writeSkill(skills, 'triage', 'body')
    await writeSkill(skills, 'review', 'body')
    const ctx = await bench(skills)
    const result = await ctx.skillLock.lock(cwd, ['triage', 'absent'])
    expect(result).toEqual({ locked: ['triage'], unknown: ['absent'] })
    const states = new Map((await ctx.skillLock.status(cwd)).map(entry => [entry.name, entry.state]))
    expect(states.get('triage')).toBe('locked')
    expect(states.get('review')).toBe('new')
  })

  it('removes one record and leaves the rest', async () => {
    const { cwd, skills } = await workspace()
    await writeSkill(skills, 'triage', 'body')
    await writeSkill(skills, 'review', 'body')
    const ctx = await bench(skills)
    await ctx.skillLock.lock(cwd)
    expect(await ctx.skillLock.unlock(cwd, 'triage')).toBe(true)
    expect(await ctx.skillLock.unlock(cwd, 'triage')).toBe(false)
    const states = new Map((await ctx.skillLock.status(cwd)).map(entry => [entry.name, entry.state]))
    expect(states.get('triage')).toBe('new')
    expect(states.get('review')).toBe('locked')
  })

  it('refuses to read a malformed lockfile instead of resetting it', async () => {
    const { cwd, skills } = await workspace()
    await writeSkill(skills, 'triage', 'body')
    const ctx = await bench(skills)
    await mkdir(join(cwd, '.dsh'), { recursive: true })
    await writeFile(join(cwd, '.dsh/skills.lock.json'), '{ "version": 9 }', 'utf8')
    await expect(ctx.skillLock.status(cwd)).rejects.toThrow(SkillLock.SkillLockFileError)
    // The bad file is still there: nothing overwrote the record the user must fix.
    expect(await readFile(join(cwd, '.dsh/skills.lock.json'), 'utf8')).toContain('"version": 9')
  })
})

describe('/skills-lock', () => {
  it('reports status, locks, and unlocks through the command', async () => {
    const { cwd, skills } = await workspace()
    await writeSkill(skills, 'triage', 'body')
    const ctx = await bench(skills)

    const before = await invoke(ctx, cwd, '')
    expect(before.kind).toBe('success')
    expect(before.text).toContain('new')
    expect(before.text).toContain('/skills-lock lock')

    expect((await invoke(ctx, cwd, 'lock')).text).toContain('Recorded 1 skill(s)')
    expect((await invoke(ctx, cwd, 'status')).text).toContain('locked')
    expect((await invoke(ctx, cwd, 'unlock triage')).text).toContain('Removed the record')
    expect(await invoke(ctx, cwd, 'unlock triage')).toMatchObject({ kind: 'error' })
  })

  it('rejects an unknown verb and a missing unlock target', async () => {
    const { cwd, skills } = await workspace()
    await writeSkill(skills, 'triage', 'body')
    const ctx = await bench(skills)
    expect(await invoke(ctx, cwd, 'wat')).toMatchObject({ kind: 'error' })
    expect((await invoke(ctx, cwd, 'unlock')).text).toContain('Usage')
  })

  it('reports a malformed lockfile as a command error rather than throwing', async () => {
    const { cwd, skills } = await workspace()
    await writeSkill(skills, 'triage', 'body')
    const ctx = await bench(skills)
    await mkdir(join(cwd, '.dsh'), { recursive: true })
    await writeFile(join(cwd, '.dsh/skills.lock.json'), 'not json', 'utf8')
    const result = await invoke(ctx, cwd, 'status')
    expect(result).toMatchObject({ kind: 'error' })
    expect(result.text).toContain('unreadable')
  })
})

describe('registration', () => {
  it('registers nothing while disabled', async () => {
    const { skills } = await workspace()
    const ctx = await bench(skills, { enabled: false })
    expect(ctx.get('skillLock')).toBeUndefined()
  })

  it('removes the service and command when its fiber is disposed', async () => {
    const { cwd, skills } = await workspace()
    await writeSkill(skills, 'triage', 'body')
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(SkillFilesystem, { includeDefaultRoots: false, customSkillDirs: [skills], watch: false })
    await ctx.plugin(CommandRuntime)
    const fiber = ctx.plugin(SkillLock, { enabled: true, path: '.dsh/skills.lock.json', warnOnDrift: false })
    await fiber.await()
    expect(ctx.get('skillLock')).toBeDefined()
    const agent = await fakeAgent(ctx, session(ctx, cwd))
    expect(ctx.commands.find(agent, 'skills-lock')).toBeDefined()

    await fiber.dispose()
    expect(ctx.get('skillLock')).toBeUndefined()
    expect(ctx.commands.find(agent, 'skills-lock')).toBeUndefined()
  })
})
