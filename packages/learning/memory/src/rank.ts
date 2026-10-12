/**
 * Relevance ranking of memory entries against free text: a full-text index
 * over each entry's text and tags, queried with fuzzy and prefix matching,
 * so a natural-language request finds the entries that share its words.
 * @module
 */

import MiniSearch from 'minisearch'
import type { MemoryEntry } from './types.ts'
import { isWorkspaceTag, visibleTags, workspaceTag } from './workspace.ts'
import { STOP_WORDS } from './similarity.ts'

/** Score multiplier for a note from the current workspace, and its inverse for a note from another one. */
const PROJECT_BOOST = 2

/** Narrowing for recall; search without options ranks every match. */
export interface RankOptions {
  /** The current workspace: its notes rank first, other workspaces' notes last. */
  readonly workspace?: string
  /** Distinct query words a note must match, capped at the query's own count (default 1). */
  readonly minMatchedTerms?: number
  /**
   * Fraction of a note's own words that, once matched, keeps it although it
   * matches fewer than `minMatchedTerms` query words: a short note about the
   * matched word stays, a long one that mentions it in passing does not (default: none).
   */
  readonly minCoverage?: number
  /** Fraction of the best note's score below which a note is left out (default 0). */
  readonly scoreFloor?: number
}

/** MiniSearch's default tokenizer; its declared type is `any`, so the signature is restated here. */
const tokenize = MiniSearch.getDefault('tokenize') as (text: string) => string[]

/**
 * The distinct indexed words of a text.
 * @param text - the text.
 * @returns its words after {@link processTerm}.
 */
function termsOf(text: string): Set<string> {
  return new Set(tokenize(text).flatMap(token => processTerm(token) ?? []))
}

/**
 * Normalize one token for indexing and querying.
 * @param term - a raw token.
 * @returns the lowercase token, or `null` for a stop word or a single character.
 */
function processTerm(term: string): string | null {
  const lower = term.toLowerCase()
  return lower.length < 2 || STOP_WORDS.has(lower) ? null : lower
}

/**
 * Rank entries by how well they match free text, best first; entries that
 * share no word with the text are left out. Workspace tags are not matched;
 * with `workspace` set, a note tagged with that workspace counts double and
 * one tagged with another workspace counts half.
 * @param entries - the candidate entries.
 * @param query - the text to match, such as a user's request.
 * @param limit - the most entries to return; `Infinity` for every match.
 * @param options - the current workspace, the words a note must share or cover, and the relative score floor.
 * @returns matching entries, best first.
 */
export function rankEntries(entries: readonly MemoryEntry[], query: string, limit: number, options: RankOptions = {}): MemoryEntry[] {
  if (entries.length === 0 || limit <= 0) return []
  const index = new MiniSearch<MemoryEntry>({
    fields: ['text', 'tags'],
    extractField: (entry, field) => (field === 'tags' ? visibleTags(entry.tags).join(' ') : field === 'id' ? entry.id : entry.text),
    processTerm,
  })
  index.addAll(entries)
  const byId = new Map(entries.map(entry => [entry.id as string, entry]))
  const own = options.workspace === undefined ? undefined : workspaceTag(options.workspace)
  const weights = new Map<string, number>(entries.map((entry) => {
    const tag = entry.tags.find(isWorkspaceTag)
    return [entry.id, own === undefined || tag === undefined ? 1 : tag === own ? PROJECT_BOOST : 1 / PROJECT_BOOST]
  }))
  const noteTerms = new Map(entries.map(entry => [entry.id as string, termsOf(`${entry.text} ${visibleTags(entry.tags).join(' ')}`).size]))
  const required = Math.min(options.minMatchedTerms ?? 1, termsOf(query).size)
  const coverage = options.minCoverage ?? Infinity
  const hits = index.search(query, {
    boost: { tags: 2 },
    prefix: term => term.length > 3,
    fuzzy: term => (term.length > 4 ? 0.2 : false),
    boostDocument: id => weights.get(String(id)) ?? 1,
  }).filter(hit => new Set(hit.queryTerms).size >= required
    || new Set(hit.terms).size >= coverage * (noteTerms.get(String(hit.id)) ?? Infinity))
  const floor = (hits[0]?.score ?? 0) * (options.scoreFloor ?? 0)
  return hits
    .filter(hit => hit.score >= floor)
    .slice(0, limit)
    .flatMap((hit) => {
      const entry = byId.get(String(hit.id))
      return entry === undefined ? [] : [entry]
    })
}
