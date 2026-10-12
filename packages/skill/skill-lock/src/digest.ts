/**
 * Pure lockfile helpers: the content-addressed skill digest, and reading and
 * rendering the lockfile document. Nothing here touches a service or a clock.
 * @module
 */

import { createHash } from 'node:crypto'
import type { SkillLockFile, SkillLockRecord } from './types.ts'

/** One file the digest covers. */
export interface DigestEntry {
  /** Path relative to the skill's directory, with `/` separators. */
  readonly path: string
  /** File contents. */
  readonly content: Buffer
}

/** What a digest covered. */
export interface DigestResult {
  /** Hex sha256 over the sorted per-file digests. */
  readonly digest: string
  /** Number of files covered. */
  readonly files: number
  /** Total bytes covered. */
  readonly bytes: number
}

/**
 * Digest a skill's files. Entries are sorted by path first, so the result does
 * not depend on directory read order; each contributes both its path and its
 * content hash, so renaming a file or adding one changes the digest even when
 * the bytes are otherwise identical.
 * @param entries - the skill's files, in any order.
 * @returns the digest with the file and byte counts it covered.
 */
export function digestFiles(entries: readonly DigestEntry[]): DigestResult {
  const sorted = [...entries].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  const outer = createHash('sha256')
  let bytes = 0
  for (const entry of sorted) {
    const inner = createHash('sha256').update(entry.content).digest('hex')
    outer.update(entry.path)
    outer.update('\0')
    outer.update(inner)
    outer.update('\n')
    bytes += entry.content.byteLength
  }
  return { digest: outer.digest('hex'), files: sorted.length, bytes }
}

/**
 * Digest a skill that exists only in memory. A runtime-registered skill has no
 * directory to read, so the digest covers the routing metadata the catalog
 * exposes; it changes when that text changes and cannot see anything else.
 * @param fields - the metadata the catalog exposes for the skill.
 * @returns the digest with a zero file count, marking it metadata-only.
 */
export function digestMetadata(fields: {
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
}): DigestResult {
  const text = `${fields.name}\n${fields.description}\n${fields.whenToUse ?? ''}`
  const content = Buffer.from(text, 'utf8')
  return { digest: createHash('sha256').update(content).digest('hex'), files: 0, bytes: content.byteLength }
}

/** Raised when a lockfile exists but cannot be understood. */
export class SkillLockFileError extends Error {
  override readonly name = 'SkillLockFileError'

  /**
   * @param path - the lockfile that could not be read.
   * @param reason - what was wrong with it.
   */
  constructor(readonly path: string, reason: string) {
    super(`skill lockfile ${path} is unreadable: ${reason}. Fix or delete it; nothing is recorded until it parses.`)
  }
}

/**
 * Parse a lockfile document. A malformed file is an error rather than an empty
 * lock: silently resetting would report every skill as new and re-record
 * whatever is on disk, which is exactly the drift this package exists to catch.
 * @param path - the lockfile path, used in the error message.
 * @param text - the file contents.
 * @returns the parsed document.
 * @throws SkillLockFileError when the text is not a version 1 lockfile.
 */
export function parseLockFile(path: string, text: string): SkillLockFile {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new SkillLockFileError(path, error instanceof Error ? error.message : 'invalid JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new SkillLockFileError(path, 'expected a JSON object')
  }
  const document = parsed as { version?: unknown; skills?: unknown }
  if (document.version !== 1) {
    throw new SkillLockFileError(path, `expected "version": 1, found ${JSON.stringify(document.version)}`)
  }
  if (!Array.isArray(document.skills)) {
    throw new SkillLockFileError(path, 'expected "skills" to be an array')
  }
  const skills: SkillLockRecord[] = []
  for (const [index, raw] of document.skills.entries()) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new SkillLockFileError(path, `skills[${String(index)}] is not an object`)
    }
    const record = raw as Record<string, unknown>
    const { name, root, digest, bytes, files, lockedAt, source } = record
    if (typeof name !== 'string' || name === '') throw new SkillLockFileError(path, `skills[${String(index)}].name must be a non-empty string`)
    if (typeof root !== 'string') throw new SkillLockFileError(path, `skills[${name}].root must be a string`)
    if (typeof digest !== 'string' || digest === '') throw new SkillLockFileError(path, `skills[${name}].digest must be a non-empty string`)
    if (typeof bytes !== 'number' || !Number.isInteger(bytes) || bytes < 0) throw new SkillLockFileError(path, `skills[${name}].bytes must be a non-negative integer`)
    if (typeof files !== 'number' || !Number.isInteger(files) || files < 0) throw new SkillLockFileError(path, `skills[${name}].files must be a non-negative integer`)
    if (typeof lockedAt !== 'string' || lockedAt === '') throw new SkillLockFileError(path, `skills[${name}].lockedAt must be a non-empty string`)
    if (source !== undefined && typeof source !== 'string') throw new SkillLockFileError(path, `skills[${name}].source must be a string when present`)
    skills.push({ name, root, digest, bytes, files, lockedAt, ...source === undefined ? {} : { source } })
  }
  return { version: 1, skills }
}

/**
 * Render a lockfile document. Records are sorted by name and the file ends in a
 * newline, so a re-lock that changed nothing produces no diff.
 * @param records - the records to write, in any order.
 * @returns the complete file contents.
 */
export function renderLockFile(records: readonly SkillLockRecord[]): string {
  const skills = [...records].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
  return `${JSON.stringify({ version: 1, skills }, undefined, 2)}\n`
}
