/**
 * Types for the skill lockfile: what was recorded about a skill when it was
 * trusted, and how its current state compares.
 * @module
 */

// Anchors the Context augmentation below: with no import of the module, that
// declaration reads as a new ambient module instead of merging into Context.
import type {} from '@deepseek-ai/cordis'

/**
 * How a skill compares with its lockfile record. `locked` matches, `drifted`
 * has a different digest, `new` has no record, and `missing` has a record but
 * no discoverable skill.
 */
export type SkillLockState = 'locked' | 'drifted' | 'new' | 'missing'

/** One skill as the lockfile recorded it. */
export interface SkillLockRecord {
  /** Kebab-case skill identifier, unique within a lockfile. */
  readonly name: string
  /** Discovery root that produced the skill when it was locked, such as `project-dsh`. */
  readonly root: string
  /** Provider that owned the skill body when it was locked. */
  readonly source?: string
  /** Content-addressed digest of the skill's files, or of its metadata for a virtual skill. */
  readonly digest: string
  /** Total bytes the digest covered. */
  readonly bytes: number
  /** Number of files the digest covered; `0` for a virtual skill. */
  readonly files: number
  /** ISO timestamp of the lock. */
  readonly lockedAt: string
}

/** The lockfile document. */
export interface SkillLockFile {
  /** Document format version; only `1` is understood. */
  readonly version: 1
  /** Records sorted by name, so the file is stable across writes. */
  readonly skills: readonly SkillLockRecord[]
}

/** One skill's current state against the lockfile. */
export interface SkillLockStatusEntry {
  /** Kebab-case skill identifier. */
  readonly name: string
  /** Comparison against the record. */
  readonly state: SkillLockState
  /** Discovery root of the live skill; absent when the skill is `missing`. */
  readonly root?: string
  /** Digest computed now; absent when the skill is `missing`. */
  readonly digest?: string
  /** Digest the lockfile holds; absent when the skill is `new`. */
  readonly recordedDigest?: string
  /** Files the current digest covered. */
  readonly files?: number
  /** Bytes the current digest covered. */
  readonly bytes?: number
  /**
   * Whether the digest covers provider metadata rather than files on disk.
   * A runtime-registered skill has no directory to read, so its digest tracks
   * only the name, description and guidance the catalog exposes.
   */
  readonly virtual: boolean
}

/** Result of locking. */
export interface SkillLockResult {
  /** Names recorded by this call, sorted. */
  readonly locked: readonly string[]
  /** Names requested that no discoverable skill matched. */
  readonly unknown: readonly string[]
}

/** The `ctx.skillLock` service: records what a skill looked like, and reports drift. */
export interface SkillLockService {
  /**
   * Absolute path of the lockfile for one workspace.
   * @param cwd - workspace directory the lockfile belongs to.
   * @returns the resolved lockfile path.
   */
  path(cwd: string): string
  /**
   * Compare every discoverable skill, and every record, against the lockfile.
   * @param cwd - workspace directory selecting project skill roots.
   * @param signal - cancels discovery and file reads.
   * @returns one entry per skill or orphaned record, sorted by name.
   */
  status(cwd: string, signal?: AbortSignal): Promise<SkillLockStatusEntry[]>
  /**
   * Record the current state of every discoverable skill, or of the named ones.
   * @param cwd - workspace directory selecting project skill roots.
   * @param names - skills to record; omitted records every discoverable skill.
   * @param signal - cancels discovery and file reads.
   * @returns the names recorded and the requested names that matched nothing.
   */
  lock(cwd: string, names?: readonly string[], signal?: AbortSignal): Promise<SkillLockResult>
  /**
   * Remove one skill's record.
   * @param cwd - workspace directory selecting the lockfile.
   * @param name - skill to forget.
   * @returns whether a record was removed.
   */
  unlock(cwd: string, name: string): Promise<boolean>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Skill lockfile: records trusted skill content and reports drift. */
    skillLock: SkillLockService
  }
}
