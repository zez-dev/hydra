// Real composition: the skill catalog, its filesystem provider, the command
// registry and the lockfile booted from a cordis.yml through the Loader over a
// temporary workspace whose skill root holds one bundled skill. `/skills-lock
// status` reports it `new`, `/skills-lock lock` records it, and status then
// reports it `locked` from the lockfile the command wrote.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillFilesystem from '@deepseek-ai/dsh-skill-filesystem'
import CommandRuntime, { CommandId } from '@deepseek-ai/dsh-commands'
import type { Agent } from '@deepseek-ai/dsh-agent'
import * as SkillLock from '@deepseek-ai/dsh-skill-lock'

let workspace: string | undefined
let home: string | undefined
let context: Context | undefined
const signal = new AbortController().signal

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  for (const dir of [workspace, home]) if (dir !== undefined) await rm(dir, { recursive: true, force: true })
  workspace = undefined
  home = undefined
})

async function boot(): Promise<{ ctx: Context; cwd: string }> {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-skill-lock-loader-'))
  workspace = cwd
  home = await mkdtemp(join(tmpdir(), 'dsh-skill-lock-home-'))
  const skillRoot = join(cwd, 'skills')
  await mkdir(join(skillRoot, 'triage'), { recursive: true })
  await writeFile(
    join(skillRoot, 'triage', 'SKILL.md'),
    '---\nname: triage\ndescription: sort incoming reports\n---\n\nRead the report, then file it.\n',
    'utf8',
  )

  const configPath = join(home, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-skill'",
    "- name: '@deepseek-ai/dsh-skill-filesystem'",
    '  config:',
    '    includeDefaultRoots: false',
    '    watch: false',
    '    customSkillDirs:',
    `      - ${JSON.stringify(skillRoot)}`,
    "- name: '@deepseek-ai/dsh-commands'",
    "- name: '@deepseek-ai/dsh-skill-lock'",
    '  config:',
    '    enabled: true',
    '    path: .dsh/skills.lock.json',
    '    warnOnDrift: false',
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(home).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-skill', SkillRegistry],
    ['@deepseek-ai/dsh-skill-filesystem', SkillFilesystem],
    ['@deepseek-ai/dsh-commands', CommandRuntime],
    ['@deepseek-ai/dsh-skill-lock', SkillLock],
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
  return { ctx, cwd }
}

let sessionCounter = 0

function session(ctx: Context, cwd: string): Session {
  sessionCounter += 1
  return ctx.sessions.create(SessionId(`skill-lock-loader-${String(sessionCounter)}`), { meta: { cwd } })
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

async function invoke(ctx: Context, cwd: string, rawInput: string): Promise<string> {
  const agent = await fakeAgent(ctx, session(ctx, cwd))
  const command = ctx.commands.find(agent, 'skills-lock')
  if (command === undefined) throw new Error('skills-lock command is not registered after the Loader booted')
  const result = await command.handler({
    commandId: CommandId('c1'), agent, rawInput, attachments: [], signal,
  }) as { kind: string; text?: string }
  if (result.kind !== 'success') throw new Error(`/skills-lock ${rawInput} failed: ${result.text ?? '(no text)'}`)
  return result.text ?? ''
}

describe('skill-lock real Loader composition through cordis.yml', () => {
  it('reports a seeded skill as new, then locked once the command records it', async () => {
    const { ctx, cwd } = await boot()

    const before = await invoke(ctx, cwd, 'status')
    expect(before).toContain('new')
    expect(before).toContain('triage')

    const locked = await invoke(ctx, cwd, 'lock')
    expect(locked).toContain('Recorded 1 skill(s)')

    const lockfile = JSON.parse(await readFile(join(cwd, '.dsh', 'skills.lock.json'), 'utf8')) as SkillLock.SkillLockFile
    expect(lockfile.version).toBe(1)
    expect(lockfile.skills.map(record => record.name)).toEqual(['triage'])

    const after = await invoke(ctx, cwd, 'status')
    expect(after).toContain('locked')
    expect(after).not.toContain('drifted')
  }, 30_000)
})
