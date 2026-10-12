/**
 * Curation planning: which entries age to `stale` or `archived`, and which
 * near duplicates merge. Pure over an entry list so the rule is testable
 * without storage; the store applies the plan.
 * @module
 */

import type { MemoryCurationPolicy, MemoryEntry, MemoryEntryId, MemorySuggestion, MemorySuggestionPolicy } from './types.ts'
import { isSameNote, normalizeForSimilarity, noteTerms } from './similarity.ts'

const DAY_MS = 24 * 60 * 60 * 1000

/** Statuses the aging rule may change. */
const AGING: ReadonlySet<MemoryEntry['status']> = new Set(['approved', 'promoted', 'stale'])

/** Statuses that take part in duplicate detection. */
const MERGEABLE: ReadonlySet<MemoryEntry['status']> = new Set(['approved', 'promoted'])

/** One planned status change. */
export interface CurationAction {
  readonly id: MemoryEntryId
}

/** One planned merge: `from` folds into the older `into`, which keeps the union of tags. */
export interface CurationMerge {
  readonly into: MemoryEntryId
  readonly from: MemoryEntryId
  readonly tags: readonly string[]
}

/** The complete plan of one curation run. */
export interface CurationPlan {
  readonly stale: readonly CurationAction[]
  readonly archive: readonly CurationAction[]
  readonly merges: readonly CurationMerge[]
}

/**
 * Jaccard similarity of the token sets of two texts after {@link normalizeForSimilarity}.
 * @param a - first text.
 * @param b - second text.
 * @returns a value in [0, 1]; 0 when both are empty.
 */
export function jaccardSimilarity(a: string, b: string): number {
  const left = new Set(normalizeForSimilarity(a).split(' ').filter(token => token.length > 0))
  const right = new Set(normalizeForSimilarity(b).split(' ').filter(token => token.length > 0))
  if (left.size === 0 && right.size === 0) return 0
  let shared = 0
  for (const token of left) if (right.has(token)) shared += 1
  return shared / (left.size + right.size - shared)
}

/**
 * The moment the aging clock starts: the latest recall or use, or, for an
 * entry never recalled or used, its last change.
 * @param entry - the entry.
 * @returns epoch milliseconds.
 */
function lastActivity(entry: MemoryEntry): number {
  const usage = [entry.lastRecalledAt, entry.lastUsedAt]
    .filter((stamp): stamp is string => stamp !== undefined)
    .map(stamp => Date.parse(stamp))
    .filter(value => Number.isFinite(value))
  if (usage.length > 0) return Math.max(...usage)
  const changed = Date.parse(entry.updatedAt)
  return Number.isFinite(changed) ? changed : Date.parse(entry.createdAt)
}

/**
 * Plan one curation run. Aging: an approved or promoted entry idle for
 * `staleAfterDays` turns stale; any aging entry idle for `archiveAfterDays`
 * turns archived (the longer window wins when both apply). Duplicates: among
 * approved and promoted entries, each group whose note similarity reaches
 * `duplicateThreshold` merges into its newest entry; an entry merged once
 * is not merged again in the same run.
 * @param entries - every stored entry.
 * @param policy - the configured windows and threshold.
 * @param now - the run's clock in epoch milliseconds.
 * @returns the plan.
 */
export function planCuration(entries: readonly MemoryEntry[], policy: MemoryCurationPolicy, now: number): CurationPlan {
  const stale: CurationAction[] = []
  const archive: CurationAction[] = []
  for (const entry of entries) {
    if (!AGING.has(entry.status)) continue
    const idleDays = (now - lastActivity(entry)) / DAY_MS
    if (policy.archiveAfterDays !== undefined && idleDays >= policy.archiveAfterDays) {
      archive.push({ id: entry.id })
    } else if (policy.staleAfterDays !== undefined && entry.status !== 'stale' && idleDays >= policy.staleAfterDays) {
      stale.push({ id: entry.id })
    }
  }
  return { stale, archive, merges: planMerges(entries, policy.duplicateThreshold) }
}

/** Rarest words of a note whose other holders it is compared with. */
const RARE_TERMS = 2

/**
 * Group approved and promoted entries whose {@link noteSimilarity} reaches the
 * threshold, directly or through a chain of such pairs, and merge each group
 * into its newest entry. Each entry is compared only with the entries sharing
 * one of its two rarest words, so the work grows with how often words repeat,
 * not with the square of the entry count; a pair sharing only common words
 * is found from the side of whichever note holds the rarer ones.
 * @param entries - every stored entry.
 * @param threshold - similarity at or above which two entries are the same note.
 * @returns one merge per entry folded into its group's newest entry, oldest first.
 */
function planMerges(entries: readonly MemoryEntry[], threshold: number): CurationMerge[] {
  const mergeable = entries
    .filter(entry => MERGEABLE.has(entry.status))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
  const terms = mergeable.map(entry => noteTerms(entry.text))
  const holders = new Map<string, number[]>()
  for (const [index, set] of terms.entries()) {
    for (const term of set) holders.set(term, [...holders.get(term) ?? [], index])
  }
  const parent = mergeable.map((_, index) => index)
  const root = (index: number): number => {
    let at = index
    while (parent[at] !== at) at = parent[at] ?? at
    return at
  }
  for (const [index, set] of terms.entries()) {
    const rare = [...set]
      .sort((a, b) => (holders.get(a)?.length ?? 0) - (holders.get(b)?.length ?? 0) || a.localeCompare(b))
      .slice(0, RARE_TERMS)
    const compared = new Set<number>([index])
    for (const term of rare) {
      for (const other of holders.get(term) ?? []) {
        if (compared.has(other)) continue
        compared.add(other)
        if (isSameNote(set, terms[other] ?? new Set(), threshold)) parent[root(other)] = root(index)
      }
    }
  }
  const groups = new Map<number, MemoryEntry[]>()
  for (const [index, entry] of mergeable.entries()) groups.set(root(index), [...groups.get(root(index)) ?? [], entry])
  const merges: CurationMerge[] = []
  for (const group of groups.values()) {
    // Oldest first, so the newest wording, which survives, is the last one.
    const survivor = group.at(-1)
    if (survivor === undefined || group.length < 2) continue
    const tags = [...new Set([...survivor.tags, ...group.slice(0, -1).flatMap(entry => entry.tags)])]
    for (const older of group.slice(0, -1)) merges.push({ into: survivor.id, from: older.id, tags })
  }
  const position = new Map(mergeable.map((entry, index) => [entry.id, index]))
  return merges.sort((a, b) => (position.get(a.from) ?? 0) - (position.get(b.from) ?? 0))
}

/** One proposed skill cluster before it is stored. */
export interface SuggestionPlan {
  /** Proposed skill name: lowercase letters, digits, and single hyphens. */
  readonly name: string
  readonly entryIds: readonly MemoryEntryId[]
}

/** Tag prefixes that record where an entry came from (`source:`) or what failed (`error:`), not its topic; they never form a cluster. */
const SOURCE_TAG = /^(?:source|error):/u

/**
 * Turn free text into a skill name: lowercase letters, digits, and single hyphens.
 * @param text - the source text.
 * @returns the slug, or `skill` when nothing survives.
 */
export function slugifySkillName(text: string): string {
  const slug = text.toLowerCase().replaceAll(/[^a-z0-9]+/gu, '-').replaceAll(/^-+|-+$/gu, '').replaceAll(/-{2,}/gu, '-')
  return slug.length === 0 ? 'skill' : slug.slice(0, 60).replace(/-+$/u, '')
}

/**
 * Name a cluster after its dominant topic tag, else after the first three
 * significant words of its oldest entry.
 * @param members - the cluster's entries, oldest first.
 * @returns the proposed skill name.
 */
function clusterName(members: readonly MemoryEntry[]): string {
  const counts = new Map<string, number>()
  for (const member of members) {
    for (const tag of member.tags) {
      if (SOURCE_TAG.test(tag)) continue
      counts.set(tag, (counts.get(tag) ?? 0) + 1)
    }
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  const dominant = ranked[0]
  if (dominant !== undefined && dominant[1] >= 2) return slugifySkillName(dominant[0])
  const words = normalizeForSimilarity(members[0]?.text ?? '').split(' ').filter(word => word.length > 3).slice(0, 3)
  return slugifySkillName(words.join(' '))
}

/**
 * Plan skill suggestions: recalled entries that share a topic tag or whose
 * texts reach `skillSuggestThreshold` similarity join one cluster; clusters of
 * at least `skillSuggestMinEntries` become suggestions unless an existing
 * suggestion, in any state, already covers every member.
 * @param entries - every stored entry.
 * @param existing - suggestions already stored.
 * @param policy - the resolved suggestion policy.
 * @returns the clusters to store, oldest member first.
 */
export function planSuggestions(
  entries: readonly MemoryEntry[],
  existing: readonly MemorySuggestion[],
  policy: MemorySuggestionPolicy,
): SuggestionPlan[] {
  const members = entries
    .filter(entry => MERGEABLE.has(entry.status))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
  const parent = new Map<MemoryEntryId, MemoryEntryId>(members.map(entry => [entry.id, entry.id]))
  const find = (id: MemoryEntryId): MemoryEntryId => {
    let current = id
    for (let next = parent.get(current); next !== undefined && next !== current; next = parent.get(current)) current = next
    return current
  }
  const union = (a: MemoryEntryId, b: MemoryEntryId): void => { parent.set(find(a), find(b)) }
  const topics = (entry: MemoryEntry): string[] => entry.tags.filter(tag => !SOURCE_TAG.test(tag))
  for (const [index, left] of members.entries()) {
    const leftTopics = new Set(topics(left))
    for (const right of members.slice(index + 1)) {
      const sharesTag = topics(right).some(tag => leftTopics.has(tag))
      if (sharesTag || jaccardSimilarity(left.text, right.text) >= policy.skillSuggestThreshold) union(left.id, right.id)
    }
  }
  const clusters = new Map<MemoryEntryId, MemoryEntry[]>()
  for (const member of members) {
    const root = find(member.id)
    const cluster = clusters.get(root)
    if (cluster === undefined) clusters.set(root, [member])
    else cluster.push(member)
  }
  const covered = existing.map(suggestion => new Set(suggestion.entryIds))
  const plans: SuggestionPlan[] = []
  for (const cluster of clusters.values()) {
    if (cluster.length < policy.skillSuggestMinEntries) continue
    if (covered.some(set => cluster.every(member => set.has(member.id)))) continue
    plans.push({ name: clusterName(cluster), entryIds: cluster.map(member => member.id) })
  }
  return plans
}
