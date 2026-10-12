/**
 * Skill lockfile: records what a skill's files looked like when it was trusted
 * and reports drift afterwards. Hydra writes skills itself (`/learn skill`, the
 * memory curator) and loads more from project and user directories, so an
 * edited or replaced skill otherwise changes how the agent behaves with nothing
 * to notice it. This plugin only records and reports; it never edits a skill.
 * Named exports preserve loader injection metadata.
 * @module @deepseek-ai/dsh-skill-lock
 */

import { readFile, readdir } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { SkillSummary } from '@deepseek-ai/dsh-skill'
import { digestFiles, digestMetadata, parseLockFile, renderLockFile, SkillLockFileError } from './digest.ts'
import type { DigestEntry, DigestResult } from './digest.ts'
import type {
  SkillLockFile, SkillLockRecord, SkillLockService, SkillLockStatusEntry,
} from './types.ts'

export type * from './types.ts'
export {
  digestFiles, digestMetadata, parseLockFile, renderLockFile, SkillLockFileError,
} from './digest.ts'
export type { DigestEntry, DigestResult } from './digest.ts'

export const name = 'skill-lock'
export const inject = ['skills', 'commands']

/** Permission bits for the lockfile: workspace-readable, owner-writable. */
const LOCKFILE_MODE = 0o644

/** Ceiling on files digested for one skill, so a stray large tree cannot stall discovery. */
const MAX_SKILL_FILES = 500

/** Skill-lock configuration. */
export interface Config {
  /** Whether the service and command are registered at all. */
  enabled: boolean
  /**
   * Lockfile location, resolved against the session workspace when relative.
   * The default keeps it beside the other workspace-owned Hydra state.
   */
  path: string
  /**
   * Log one warning per drifted skill when a status runs. Off by default: a
   * long autonomous loop calling status repeatedly would otherwise repeat the
   * same warning for every round.
   */
  warnOnDrift: boolean
}

/** Runtime configuration schema. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  path: z.string().default('.dsh/skills.lock.json'),
  warnOnDrift: z.boolean().default(false),
})

/**
 * Collect every file under a directory, relative to it, with `/` separators.
 * Symbolic links are read as their targets' contents through `readFile`; a link
 * pointing outside the skill is still that skill's content for digest purposes.
 * @param root - directory to walk.
 * @param signal - cancels the walk between entries.
 * @returns the files found, capped at {@link MAX_SKILL_FILES}.
 */
async function collectDirectory(root: string, signal?: AbortSignal): Promise<DigestEntry[]> {
  const entries: DigestEntry[] = []
  const pending: string[] = [root]
  while (pending.length > 0) {
    signal?.throwIfAborted()
    const current = pending.pop() as string
    const listing = await readdir(current, { withFileTypes: true })
    for (const item of listing) {
      const full = join(current, item.name)
      if (item.isDirectory()) {
        pending.push(full)
        continue
      }
      if (!item.isFile() && !item.isSymbolicLink()) continue
      if (entries.length >= MAX_SKILL_FILES) return entries
      const content = await readFile(full)
      entries.push({ path: relative(root, full).split(sep).join('/'), content })
    }
  }
  return entries
}

/**
 * Resolve a filesystem read, mapping a vanished path to `undefined`.
 * @param work - the pending read.
 * @returns the value, or `undefined` when the path no longer exists.
 * @throws the original error for every failure other than a missing path.
 */
async function vanishedToUndefined<T>(work: Promise<T>): Promise<T | undefined> {
  try {
    return await work
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined
    throw error
  }
}

/** One skill's digest plus whether it came from disk. */
interface SkillDigest extends DigestResult {
  /** Whether the digest covers catalog metadata rather than files. */
  readonly virtual: boolean
}

/**
 * Digest one skill. A directory-backed skill digests every file in its bundle,
 * a single-file skill digests that file, and a skill the catalog exposes
 * without a path digests its metadata instead, marked `virtual`.
 *
 * The catalog is a snapshot, so a skill can be deleted between discovery and
 * this read; that returns `undefined` rather than throwing, because a skill
 * that is gone is a state to report, not a failure.
 * @param skill - the catalog summary to digest.
 * @param signal - cancels file reads.
 * @returns the digest and whether it was metadata-only, or `undefined` when the files are gone.
 */
export async function digestSkill(skill: SkillSummary, signal?: AbortSignal): Promise<SkillDigest | undefined> {
  const base = skill.resourceBase
  if (base !== undefined && base.kind === 'directory') {
    const entries = await vanishedToUndefined(collectDirectory(base.path, signal))
    return entries === undefined ? undefined : { ...digestFiles(entries), virtual: false }
  }
  if (skill.path !== undefined) {
    const content = await vanishedToUndefined(readFile(skill.path))
    if (content === undefined) return undefined
    const name = skill.path.split(sep).pop() ?? 'SKILL.md'
    return { ...digestFiles([{ path: name, content }]), virtual: false }
  }
  return {
    ...digestMetadata({
      name: skill.name,
      description: skill.description,
      ...skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse },
    }),
    virtual: true,
  }
}

/**
 * Render the `/skills-lock` table. Each row is one skill; the summary line
 * names what needs attention.
 * @param entries - status entries, already sorted.
 * @returns the printable report.
 */
export function renderStatus(entries: readonly SkillLockStatusEntry[]): string {
  if (entries.length === 0) return 'No skills discovered, and the lockfile records none.'
  const lines = entries.map((entry) => {
    const where = entry.state === 'missing' ? 'recorded, not discovered' : `${entry.root ?? 'unknown'}${entry.virtual ? ', metadata only' : ''}`
    const detail = entry.state === 'drifted'
      ? ` recorded ${(entry.recordedDigest ?? '').slice(0, 12)}, now ${(entry.digest ?? '').slice(0, 12)}`
      : ''
    return `  ${entry.state.padEnd(8)} ${entry.name} (${where})${detail}`
  })
  const counts = new Map<string, number>()
  for (const entry of entries) counts.set(entry.state, (counts.get(entry.state) ?? 0) + 1)
  const summary = [...counts.entries()].sort().map(([state, count]) => `${String(count)} ${state}`).join(', ')
  const drifted = counts.get('drifted') ?? 0
  const fresh = counts.get('new') ?? 0
  const advice = drifted > 0 || fresh > 0 ? '\nRun `/skills-lock lock` to record the current content as trusted.' : ''
  return `Skills: ${summary}\n${lines.join('\n')}${advice}`
}

/**
 * Register the skill lockfile service and its command.
 * @param ctx - registrant context carrying the skill catalog and command registry.
 * @param config - the deployment's lockfile policy.
 */
export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) return

  function lockfilePath(cwd: string): string {
    return isAbsolute(config.path) ? config.path : resolve(cwd, config.path)
  }

  async function readLock(cwd: string): Promise<SkillLockFile> {
    const path = lockfilePath(cwd)
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch (error) {
      // A lockfile that does not exist yet is an empty lock; any other read
      // failure (a directory, a permission problem) must surface.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, skills: [] }
      throw error
    }
    return parseLockFile(path, text)
  }

  async function writeLock(cwd: string, records: readonly SkillLockRecord[]): Promise<void> {
    await writeFileAtomic(lockfilePath(cwd), renderLockFile(records), { mode: LOCKFILE_MODE, dirMode: 0o700 })
  }

  async function currentSkills(cwd: string, signal?: AbortSignal): Promise<SkillSummary[]> {
    const snapshot = await ctx.skills.snapshot({ cwd, ...signal === undefined ? {} : { signal } })
    return [...snapshot.skills]
  }

  const service: SkillLockService = {
    path: lockfilePath,

    async status(cwd, signal) {
      const [lock, skills] = await Promise.all([readLock(cwd), currentSkills(cwd, signal)])
      const recorded = new Map(lock.skills.map(record => [record.name, record]))
      const entries: SkillLockStatusEntry[] = []
      for (const skill of skills) {
        const digested = await digestSkill(skill, signal)
        const record = recorded.get(skill.name)
        recorded.delete(skill.name)
        if (digested === undefined) {
          entries.push({
            name: skill.name,
            state: 'missing',
            virtual: false,
            ...record === undefined ? {} : { recordedDigest: record.digest },
          })
          continue
        }
        const state = record === undefined ? 'new' : record.digest === digested.digest ? 'locked' : 'drifted'
        entries.push({
          name: skill.name,
          state,
          root: skill.source,
          digest: digested.digest,
          files: digested.files,
          bytes: digested.bytes,
          virtual: digested.virtual,
          ...record === undefined ? {} : { recordedDigest: record.digest },
        })
      }
      for (const orphan of recorded.values()) {
        entries.push({ name: orphan.name, state: 'missing', recordedDigest: orphan.digest, virtual: orphan.files === 0 })
      }
      entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
      if (config.warnOnDrift) {
        for (const entry of entries) {
          if (entry.state === 'drifted') ctx.logger.warn(`skill-lock: "${entry.name}" changed since it was locked`)
        }
      }
      return entries
    },

    async lock(cwd, names, signal) {
      const [lock, skills] = await Promise.all([readLock(cwd), currentSkills(cwd, signal)])
      const wanted = names === undefined ? undefined : new Set(names)
      const kept = new Map(lock.skills.map(record => [record.name, record]))
      const locked: string[] = []
      const lockedAt = new Date().toISOString()
      for (const skill of skills) {
        if (wanted !== undefined && !wanted.has(skill.name)) continue
        const digested = await digestSkill(skill, signal)
        if (digested === undefined) continue
        kept.set(skill.name, {
          name: skill.name,
          root: skill.source,
          digest: digested.digest,
          bytes: digested.bytes,
          files: digested.files,
          lockedAt,
          source: skill.provider,
        })
        locked.push(skill.name)
      }
      const discovered = new Set(skills.map(skill => skill.name))
      const unknown = wanted === undefined ? [] : [...wanted].filter(candidate => !discovered.has(candidate)).sort()
      await writeLock(cwd, [...kept.values()])
      return { locked: locked.sort(), unknown }
    },

    async unlock(cwd, name) {
      const lock = await readLock(cwd)
      const remaining = lock.skills.filter(record => record.name !== name)
      if (remaining.length === lock.skills.length) return false
      if (remaining.length === 0) {
        // Keep the file rather than deleting it: its absence means "never
        // locked", which is a different answer from "locked nothing".
        await writeLock(cwd, [])
        return true
      }
      await writeLock(cwd, remaining)
      return true
    },
  }

  ctx.provide('skillLock', service)

  ctx.commands.register({
    definitionId: CommandDefinitionId('@deepseek-ai/dsh-skill-lock'),
    name: 'skills-lock',
    description: 'Report which skills changed since they were trusted, and record the current content',
    input: { hint: '[status|lock [<name>]|unlock <name>]' },
    handler: invocation => execute(invocation),
  })

  async function execute(invocation: CommandInvocation): Promise<CommandResult> {
    const cwd = invocation.agent.session.header.cwd
    if (cwd === undefined) {
      return { kind: 'error', text: 'This session has no workspace, so there is no lockfile to read.' }
    }
    const [verb = 'status', ...rest] = invocation.rawInput.trim().split(/\s+/).filter(part => part !== '')
    try {
      if (verb === 'status') {
        return { kind: 'success', text: renderStatus(await service.status(cwd, invocation.signal)) }
      }
      if (verb === 'lock') {
        const result = await service.lock(cwd, rest.length > 0 ? rest : undefined, invocation.signal)
        const unknown = result.unknown.length > 0 ? ` Not found: ${result.unknown.join(', ')}.` : ''
        return {
          kind: 'success',
          text: `Recorded ${String(result.locked.length)} skill(s) in ${service.path(cwd)}.${unknown}`,
        }
      }
      if (verb === 'unlock') {
        const target = rest[0]
        if (target === undefined) return { kind: 'error', text: 'Usage: /skills-lock unlock <name>' }
        const removed = await service.unlock(cwd, target)
        return removed
          ? { kind: 'success', text: `Removed the record for "${target}".` }
          : { kind: 'error', text: `No record for "${target}".` }
      }
      return { kind: 'error', text: 'Usage: /skills-lock [status|lock [<name>]|unlock <name>]' }
    } catch (error) {
      if (error instanceof SkillLockFileError) return { kind: 'error', text: error.message }
      throw error
    }
  }

}
