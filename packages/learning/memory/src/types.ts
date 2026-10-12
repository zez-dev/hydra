import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** Opaque identity of one stored memory entry; crosses the model, command, and storage boundaries. */
export type MemoryEntryId = Branded<'MemoryEntryId'>

/** What kind of knowledge an entry records. */
export type MemoryEntryKind = 'fact' | 'shortcut' | 'preference'

/**
 * Review and curation state of an entry. `candidate` entries are proposals
 * that never reach the model; `approved` and `promoted` entries are recalled;
 * `rejected` entries are kept only so the same proposal is not raised again;
 * `stale` entries left recall for lack of use but remain searchable;
 * `archived` entries are neither recalled nor searched and are listed only by
 * `/memory archived`.
 */
export type MemoryEntryStatus = 'candidate' | 'approved' | 'promoted' | 'rejected' | 'stale' | 'archived'

/** One durable memory entry. */
export interface MemoryEntry {
  readonly id: MemoryEntryId
  readonly text: string
  readonly tags: readonly string[]
  readonly kind: MemoryEntryKind
  readonly status: MemoryEntryStatus
  /** Session whose work produced the entry, when known. */
  readonly sourceSessionId?: SessionId
  /** ISO-8601 creation time. */
  readonly createdAt: string
  /** ISO-8601 time of the last status or content change. */
  readonly updatedAt: string
  /** ISO-8601 time the entry last entered a request's recall block. */
  readonly lastRecalledAt?: string
  /** How many requests carried the entry in their recall block. */
  readonly recallCount: number
  /** ISO-8601 time the model's `memory search` last returned the entry. */
  readonly lastUsedAt?: string
  /** Curator note, such as the entry a duplicate was merged into. */
  readonly note?: string
}

/** Fields an edit may replace on an existing entry. */
export interface MemoryEntryPatch {
  /** New text; must not be blank. */
  readonly text?: string
  /** New tag list. */
  readonly tags?: readonly string[]
  /** New note: why the entry has its status, such as the entries that replaced it. */
  readonly note?: string
}

/** The caller-supplied part of a new entry. */
export interface MemoryEntryInput {
  readonly text: string
  readonly kind: MemoryEntryKind
  readonly tags: readonly string[]
}

/** Filter for {@link MemoryStore.list}. */
export interface MemoryListFilter {
  readonly status?: MemoryEntryStatus
}

/** Usage fields a caller may stamp on an entry. */
export interface MemoryTouch {
  readonly lastRecalledAt?: string
  readonly lastUsedAt?: string
}

/** Aging and duplicate policy the curator applies. */
export interface MemoryCurationPolicy {
  /** Days without recall or use before an approved entry turns `stale`; absent never ages. */
  readonly staleAfterDays?: number
  /** Days without recall or use before a stale entry turns `archived`; absent never archives. */
  readonly archiveAfterDays?: number
  /** Jaccard token similarity at or above which two recalled entries are duplicates. */
  readonly duplicateThreshold: number
  /** Similarity at or above which two recalled entries belong to one skill cluster; absent turns suggestions off. */
  readonly skillSuggestThreshold?: number
  /** Smallest cluster that becomes a skill suggestion; absent uses 3. */
  readonly skillSuggestMinEntries?: number
}

/** The skill-suggestion part of the curation policy, resolved. */
export interface MemorySuggestionPolicy {
  readonly skillSuggestThreshold: number
  readonly skillSuggestMinEntries: number
}

/** Counts of what one curation run changed. */
export interface MemoryCurationReport {
  readonly stale: number
  readonly archived: number
  readonly merged: number
  /** Skill suggestions written by this run. */
  readonly suggested: number
}

/** Opaque identity of one skill suggestion. */
export type MemorySuggestionId = Branded<'MemorySuggestionId'>

/** Review state of a suggestion: `proposed` awaits a person; `accepted` was promoted; `dismissed` hides the cluster. */
export type MemorySuggestionStatus = 'proposed' | 'accepted' | 'dismissed'

/** One cluster of recalled entries the curator proposes to promote together as a skill. */
export interface MemorySuggestion {
  readonly id: MemorySuggestionId
  /** Proposed skill name: lowercase letters, digits, and single hyphens. */
  readonly name: string
  readonly entryIds: readonly MemoryEntryId[]
  /** ISO-8601 creation time. */
  readonly createdAt: string
  readonly status: MemorySuggestionStatus
}

/** Filter for {@link MemoryStore.suggestions}. */
export interface MemorySuggestionFilter {
  readonly status?: MemorySuggestionStatus
}

/** The `ctx.memory` service: durable entries plus the operations every consumer shares. */
export interface MemoryStore {
  /**
   * Store a new entry, unless {@link findDuplicate} finds the same note: then
   * that entry takes the new wording and the joined tags (a stale one turns
   * approved again when `status` is `approved`), and a rejected one is
   * returned unchanged.
   * @param input - text, kind, and tags.
   * @param status - initial review state of a new entry.
   * @param sourceSessionId - session whose work produced the entry.
   * @returns the stored entry, new or restated.
   */
  add(input: MemoryEntryInput, status: MemoryEntryStatus, sourceSessionId?: SessionId): Promise<MemoryEntry>
  /**
   * The stored entry that is the same note as a text: the most similar entry
   * that is not archived whose note similarity reaches the duplicate threshold.
   * @param text - the note text.
   * @returns the entry, or `undefined` when no stored entry is the same note.
   */
  findDuplicate(text: string): MemoryEntry | undefined
  /**
   * Read one entry.
   * @param id - the entry id.
   * @returns the entry, or `undefined` when unknown.
   */
  get(id: MemoryEntryId): MemoryEntry | undefined
  /**
   * List entries, oldest first.
   * @param filter - optional status filter.
   * @returns the matching entries.
   */
  list(filter?: MemoryListFilter): MemoryEntry[]
  /**
   * Case-insensitive substring search over text and tags of searchable entries.
   * @param query - the search text.
   * @returns approved, promoted, and stale entries whose text or a tag contains the query.
   */
  search(query: string): MemoryEntry[]
  /**
   * Change an entry's review state.
   * @param id - the entry id.
   * @param status - the new state.
   * @returns the updated entry.
   * @throws when the id is unknown.
   */
  setStatus(id: MemoryEntryId, status: MemoryEntryStatus): Promise<MemoryEntry>
  /**
   * Rewrite an entry's text or tags in place; identity, kind, status, and source tags stay.
   * @param id - the entry id.
   * @param patch - the fields to replace; an omitted field keeps its value.
   * @returns the updated entry.
   * @throws when the id is unknown or the new text is blank.
   */
  update(id: MemoryEntryId, patch: MemoryEntryPatch): Promise<MemoryEntry>
  /**
   * Delete an entry.
   * @param id - the entry id.
   * @returns whether an entry was deleted.
   */
  forget(id: MemoryEntryId): Promise<boolean>
  /**
   * The entries the model is shown, oldest first.
   * @returns approved and promoted entries.
   */
  recalled(): MemoryEntry[]
  /**
   * Stamp usage on one entry; `lastRecalledAt` also increments `recallCount`.
   * @param id - the entry id.
   * @param touch - the usage fields to set.
   * @returns the updated entry, or `undefined` when unknown.
   */
  touch(id: MemoryEntryId, touch: MemoryTouch): Promise<MemoryEntry | undefined>
  /**
   * Run the configured aging and duplicate policy once, then propose skills for clusters of recalled entries.
   * @returns what changed.
   * @throws when no policy is configured.
   */
  curate(): Promise<MemoryCurationReport>
  /**
   * List skill suggestions, oldest first.
   * @param filter - optional status filter.
   * @returns the matching suggestions.
   */
  suggestions(filter?: MemorySuggestionFilter): MemorySuggestion[]
  /**
   * Read one suggestion.
   * @param id - the suggestion id.
   * @returns the suggestion, or `undefined` when unknown.
   */
  getSuggestion(id: MemorySuggestionId): MemorySuggestion | undefined
  /**
   * Change a suggestion's review state.
   * @param id - the suggestion id.
   * @param status - the new state.
   * @returns the updated suggestion.
   * @throws when the id is unknown.
   */
  setSuggestionStatus(id: MemorySuggestionId, status: MemorySuggestionStatus): Promise<MemorySuggestion>
}
