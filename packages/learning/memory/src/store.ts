/**
 * The storage-domain backed {@link MemoryStore}: one `entries` table in the
 * `learning_memory` domain, one document per entry.
 * @module
 */

import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import { planCuration, planSuggestions } from './curator.ts'
import { rankEntries } from './rank.ts'
import { isSameNote, noteTerms, termSimilarity } from './similarity.ts'
import type {
  MemoryCurationPolicy, MemoryCurationReport, MemoryEntry, MemoryEntryId, MemoryEntryInput, MemoryEntryStatus,
  MemoryListFilter, MemoryStore, MemorySuggestion, MemorySuggestionFilter, MemorySuggestionId, MemorySuggestionStatus,
  MemoryTouch, MemoryEntryPatch,
} from './types.ts'

const memoryEntryRecord = z.object({
  id: z.string(),
  text: z.string(),
  tags: z.array(z.string()),
  kind: z.union([z.literal('fact'), z.literal('shortcut'), z.literal('preference')]),
  status: z.union([
    z.literal('candidate'), z.literal('approved'), z.literal('promoted'), z.literal('rejected'),
    z.literal('stale'), z.literal('archived'),
  ]),
  sourceSessionId: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastRecalledAt: z.string().optional(),
  recallCount: z.number().int().nonnegative().optional(),
  lastUsedAt: z.string().optional(),
  note: z.string().optional(),
})

type MemoryEntryRecord = z.infer<typeof memoryEntryRecord>

const memorySuggestionRecord = z.object({
  id: z.string(),
  name: z.string(),
  entryIds: z.array(z.string()),
  createdAt: z.string(),
  status: z.union([z.literal('proposed'), z.literal('accepted'), z.literal('dismissed')]),
})

type MemorySuggestionRecord = z.infer<typeof memorySuggestionRecord>

/** The `learning_memory` domain: the `entries` table keyed by entry id. */
export const memoryDomainSpec = defineDomain({
  name: 'learning_memory',
  version: 1,
  layout: 'per-record',
  invalidRecords: 'backup-and-skip',
  tables: {
    entries: domainTable<MemoryEntryId, MemoryEntryRecord>(memoryEntryRecord),
    suggestions: domainTable<MemorySuggestionId, MemorySuggestionRecord>(memorySuggestionRecord),
  },
})

/** Statuses whose entries are recalled into the model's context. */
const RECALLED: ReadonlySet<MemoryEntryStatus> = new Set(['approved', 'promoted'])

/** Statuses the model's search may return: recalled entries plus stale ones. */
const SEARCHABLE: ReadonlySet<MemoryEntryStatus> = new Set(['approved', 'promoted', 'stale'])

function toEntry(record: MemoryEntryRecord): MemoryEntry {
  return {
    id: brandString<MemoryEntryId>(record.id),
    text: record.text,
    tags: record.tags,
    kind: record.kind,
    status: record.status,
    ...record.sourceSessionId === undefined ? {} : { sourceSessionId: brandString<SessionId>(record.sourceSessionId) },
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...record.lastRecalledAt === undefined ? {} : { lastRecalledAt: record.lastRecalledAt },
    recallCount: record.recallCount ?? 0,
    ...record.lastUsedAt === undefined ? {} : { lastUsedAt: record.lastUsedAt },
    ...record.note === undefined ? {} : { note: record.note },
  }
}

function toSuggestion(record: MemorySuggestionRecord): MemorySuggestion {
  return {
    id: brandString<MemorySuggestionId>(record.id),
    name: record.name,
    entryIds: record.entryIds.map(id => brandString<MemoryEntryId>(id)),
    createdAt: record.createdAt,
    status: record.status,
  }
}

/**
 * Normalize tags: trimmed, lowercased, without blanks or repeats.
 * @param tags - caller tags.
 * @returns the stored tags, first occurrence order.
 */
function normalizeTags(tags: readonly string[]): string[] {
  return [...new Set(tags.map(tag => tag.trim().toLowerCase()).filter(tag => tag.length > 0))]
}

/**
 * Normalize a memory text: collapse whitespace and trim.
 * @param text - caller text.
 * @returns the normalized text.
 * @throws when the result is empty.
 */
export function normalizeMemoryText(text: string): string {
  const normalized = text.replaceAll(/\s+/g, ' ').trim()
  if (normalized.length === 0) throw new Error('memory: text must not be empty')
  return normalized
}

/** {@link MemoryStore} over one open domain. */
export class DomainMemoryStore implements MemoryStore {
  private readonly table: KvTable<MemoryEntryId, MemoryEntryRecord>
  private readonly suggestionTable: KvTable<MemorySuggestionId, MemorySuggestionRecord>

  /** Each entry's {@link noteTerms}, kept until its text changes. */
  private readonly terms = new Map<string, { readonly text: string; readonly terms: Set<string> }>()

  /**
   * @param domain - the open `learning_memory` domain.
   * @param policy - the curation policy, or `undefined` when curation is off.
   * @param duplicateThreshold - note similarity at or above which a stored entry is the same note as a new one.
   * @param clock - the curator's clock, epoch milliseconds.
   */
  constructor(
    domain: Domain<typeof memoryDomainSpec>,
    private readonly policy: MemoryCurationPolicy | undefined,
    private readonly duplicateThreshold: number,
    private readonly clock: () => number = () => Date.now(),
  ) {
    this.table = domain.table('entries')
    this.suggestionTable = domain.table('suggestions')
  }

  private termsOf(record: MemoryEntryRecord): Set<string> {
    const cached = this.terms.get(record.id)
    if (cached?.text === record.text) return cached.terms
    const terms = noteTerms(record.text)
    this.terms.set(record.id, { text: record.text, terms })
    return terms
  }

  findDuplicate(text: string): MemoryEntry | undefined {
    const wanted = noteTerms(text)
    let best: { readonly record: MemoryEntryRecord; readonly score: number } | undefined
    for (const [, record] of this.table.entries()) {
      if (record.status === 'archived') continue
      const terms = this.termsOf(record)
      if (!isSameNote(wanted, terms, this.duplicateThreshold)) continue
      const score = termSimilarity(wanted, terms)
      const better = best === undefined || score > best.score || (score === best.score && record.createdAt > best.record.createdAt)
      if (better) best = { record, score }
    }
    return best === undefined ? undefined : toEntry(best.record)
  }

  async add(input: MemoryEntryInput, status: MemoryEntryStatus, sourceSessionId?: SessionId): Promise<MemoryEntry> {
    const now = new Date(this.clock()).toISOString()
    const duplicate = this.findDuplicate(input.text)
    if (duplicate !== undefined) {
      // A rejected note stays as the person left it; any other takes the newest wording.
      if (duplicate.status === 'rejected') return duplicate
      const restated = await this.table.update(duplicate.id, current => ({
        ...current,
        text: normalizeMemoryText(input.text),
        tags: [...new Set([...current.tags, ...normalizeTags(input.tags)])],
        ...current.status === 'stale' && status === 'approved' ? { status: 'approved' as const } : {},
        updatedAt: now,
      }))
      return toEntry(restated)
    }
    const record: MemoryEntryRecord = {
      id: randomUUID().slice(0, 8),
      text: normalizeMemoryText(input.text),
      tags: normalizeTags(input.tags),
      kind: input.kind,
      status,
      ...sourceSessionId === undefined ? {} : { sourceSessionId },
      createdAt: now,
      updatedAt: now,
      recallCount: 0,
    }
    await this.table.put(brandString<MemoryEntryId>(record.id), record)
    return toEntry(record)
  }

  get(id: MemoryEntryId): MemoryEntry | undefined {
    const record = this.table.get(id)
    return record === undefined ? undefined : toEntry(record)
  }

  list(filter: MemoryListFilter = {}): MemoryEntry[] {
    const entries: MemoryEntry[] = []
    for (const [, record] of this.table.entries()) {
      if (filter.status !== undefined && record.status !== filter.status) continue
      entries.push(toEntry(record))
    }
    return entries.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
  }

  search(query: string): MemoryEntry[] {
    const searchable = this.list().filter(entry => SEARCHABLE.has(entry.status))
    if (query.trim().length === 0) return searchable
    return rankEntries(searchable, query, Infinity)
  }

  async setStatus(id: MemoryEntryId, status: MemoryEntryStatus): Promise<MemoryEntry> {
    if (this.table.get(id) === undefined) throw new Error(`memory: unknown entry ${id}`)
    const updated = await this.table.update(id, current => ({ ...current, status, updatedAt: new Date(this.clock()).toISOString() }))
    return toEntry(updated)
  }

  async update(id: MemoryEntryId, patch: MemoryEntryPatch): Promise<MemoryEntry> {
    if (this.table.get(id) === undefined) throw new Error(`memory: unknown entry ${id}`)
    const text = patch.text?.trim()
    if (text !== undefined && text.length === 0) throw new Error('memory: an entry cannot be blank')
    const updated = await this.table.update(id, current => ({
      ...current,
      ...text === undefined ? {} : { text },
      ...patch.tags === undefined ? {} : { tags: [...patch.tags] },
      ...patch.note === undefined ? {} : { note: patch.note },
      updatedAt: new Date(this.clock()).toISOString(),
    }))
    return toEntry(updated)
  }

  forget(id: MemoryEntryId): Promise<boolean> {
    return this.table.delete(id)
  }

  recalled(): MemoryEntry[] {
    return this.list().filter(entry => RECALLED.has(entry.status))
  }

  async touch(id: MemoryEntryId, touch: MemoryTouch): Promise<MemoryEntry | undefined> {
    if (this.table.get(id) === undefined) return undefined
    const updated = await this.table.update(id, current => ({
      ...current,
      ...touch.lastRecalledAt === undefined ? {} : { lastRecalledAt: touch.lastRecalledAt, recallCount: (current.recallCount ?? 0) + 1 },
      ...touch.lastUsedAt === undefined ? {} : { lastUsedAt: touch.lastUsedAt },
    }))
    return toEntry(updated)
  }

  async curate(): Promise<MemoryCurationReport> {
    if (this.policy === undefined) throw new Error('memory: curation is not configured')
    const now = this.clock()
    const stamp = new Date(now).toISOString()
    const plan = planCuration(this.list(), this.policy, now)
    for (const action of plan.stale) {
      await this.table.update(action.id, current => ({ ...current, status: 'stale', updatedAt: stamp }))
    }
    for (const action of plan.archive) {
      await this.table.update(action.id, current => ({ ...current, status: 'archived', updatedAt: stamp }))
    }
    for (const merge of plan.merges) {
      await this.table.update(merge.into, current => ({ ...current, tags: [...merge.tags], updatedAt: stamp }))
      await this.table.update(merge.from, current => ({
        ...current, status: 'archived', updatedAt: stamp, note: `merged into ${merge.into}`,
      }))
    }
    let suggested = 0
    if (this.policy.skillSuggestThreshold !== undefined) {
      const plans = planSuggestions(this.list(), this.suggestions(), {
        skillSuggestThreshold: this.policy.skillSuggestThreshold,
        skillSuggestMinEntries: this.policy.skillSuggestMinEntries ?? 3,
      })
      for (const suggestion of plans) {
        const record: MemorySuggestionRecord = {
          id: randomUUID().slice(0, 8),
          name: suggestion.name,
          entryIds: [...suggestion.entryIds],
          createdAt: stamp,
          status: 'proposed',
        }
        await this.suggestionTable.put(brandString<MemorySuggestionId>(record.id), record)
        suggested += 1
      }
    }
    return { stale: plan.stale.length, archived: plan.archive.length, merged: plan.merges.length, suggested }
  }

  suggestions(filter: MemorySuggestionFilter = {}): MemorySuggestion[] {
    const suggestions: MemorySuggestion[] = []
    for (const [, record] of this.suggestionTable.entries()) {
      if (filter.status !== undefined && record.status !== filter.status) continue
      suggestions.push(toSuggestion(record))
    }
    return suggestions.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
  }

  getSuggestion(id: MemorySuggestionId): MemorySuggestion | undefined {
    const record = this.suggestionTable.get(id)
    return record === undefined ? undefined : toSuggestion(record)
  }

  async setSuggestionStatus(id: MemorySuggestionId, status: MemorySuggestionStatus): Promise<MemorySuggestion> {
    if (this.suggestionTable.get(id) === undefined) throw new Error(`memory: unknown suggestion ${id}`)
    const updated = await this.suggestionTable.update(id, current => ({ ...current, status }))
    return toSuggestion(updated)
  }
}
