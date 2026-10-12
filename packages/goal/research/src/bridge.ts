/**
 * Cross-goal breakthrough bridge: mirrors every journal breakthrough into the
 * memory store as an approved fact, and reads other journals' breakthroughs
 * back for the recall block. Both sides are structural over the memory store
 * so this package has no runtime dependency on `dsh-memory`.
 * @module
 */

import type { Journal } from './types.ts'

/** Tag every mirrored breakthrough carries. */
export const BREAKTHROUGH_TAG = 'breakthrough'

/** Prefix of the tag naming the journal a mirrored breakthrough came from. */
export const RESEARCH_TAG_PREFIX = 'research:'

/**
 * The tag naming a journal.
 * @param slug - the journal slug.
 * @returns `research:<slug>`.
 */
export function researchTag(slug: string): string {
  return `${RESEARCH_TAG_PREFIX}${slug}`
}

/** The fields of a memory entry the bridge reads. */
export interface BridgeMemoryEntry {
  readonly text: string
  readonly tags: readonly string[]
  readonly status: string
  /** ISO-8601 time of the last change; newest first in recall. */
  readonly updatedAt: string
}

/** The memory-store operations the bridge needs; `ctx.memory` satisfies it. */
export interface BridgeMemory {
  /**
   * Every entry in any state.
   * @returns the entries.
   */
  list(): readonly BridgeMemoryEntry[]
  /**
   * Store one entry.
   * @param input - text, kind, and tags.
   * @param status - the initial review state.
   * @returns the stored entry.
   */
  add(input: { text: string; kind: 'fact'; tags: readonly string[] }, status: 'approved'): Promise<unknown>
}

/**
 * Normalize text for duplicate detection: lowercase, punctuation to spaces,
 * whitespace collapsed.
 * @param text - the entry text.
 * @returns the normalized form.
 */
export function normalizeBreakthrough(text: string): string {
  return text.toLowerCase().replaceAll(/[^\p{L}\p{N}\s]+/gu, ' ').replaceAll(/\s+/g, ' ').trim()
}

/**
 * Mirror the journal's breakthroughs that memory does not hold yet, as
 * approved `fact` entries tagged with the journal and `breakthrough`.
 * Duplicates are detected by normalized text across every entry state.
 * @param memory - the memory store.
 * @param journal - the journal whose breakthroughs to mirror.
 * @returns how many entries were added.
 */
export async function mirrorBreakthroughs(memory: BridgeMemory, journal: Journal): Promise<number> {
  const known = new Set(memory.list().map(entry => normalizeBreakthrough(entry.text)))
  let added = 0
  for (const entry of journal.breakthroughs) {
    const key = normalizeBreakthrough(entry.text)
    if (key.length === 0 || known.has(key)) continue
    known.add(key)
    await memory.add({ text: entry.text, kind: 'fact', tags: [researchTag(journal.slug), BREAKTHROUGH_TAG] }, 'approved')
    added += 1
  }
  return added
}

/**
 * Breakthroughs mirrored from other journals, newest first, as recall lines.
 * Only approved and promoted entries count; the current slug is excluded.
 * @param memory - the memory store, or `undefined` when none is mounted.
 * @param slug - the current journal slug.
 * @param limit - how many lines to return.
 * @returns lines of the form `[<slug>] <text>`.
 */
export function relatedBreakthroughs(memory: BridgeMemory | undefined, slug: string, limit: number): string[] {
  if (memory === undefined || limit <= 0) return []
  const own = researchTag(slug)
  return memory.list()
    .filter(entry => (entry.status === 'approved' || entry.status === 'promoted') && entry.tags.includes(BREAKTHROUGH_TAG))
    .map(entry => ({ entry, origin: entry.tags.find(tag => tag.startsWith(RESEARCH_TAG_PREFIX)) }))
    .filter((item): item is { entry: BridgeMemoryEntry; origin: string } => item.origin !== undefined && item.origin !== own)
    .sort((a, b) => b.entry.updatedAt.localeCompare(a.entry.updatedAt))
    .slice(0, limit)
    .map(({ entry, origin }) => `[${origin.slice(RESEARCH_TAG_PREFIX.length)}] ${entry.text}`)
}
