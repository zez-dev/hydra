/**
 * Host learning Remote: the Web card's view of memory candidates and recalled
 * entries, with review, forget, and promote-to-skill actions over the same
 * `ctx.memory` store and `ctx.learning` promotion path the `/learn` command uses.
 * @module @deepseek-ai/dsh-api-learning-controller
 */

import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { MemoryEntry, MemoryEntryId, MemorySuggestion, MemorySuggestionId } from '@deepseek-ai/dsh-memory'
// Type-only: resolves the `ctx.learning` service declaration.
import type {} from '@deepseek-ai/dsh-learning'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
// Typert-generated ./typert and ./remote artifacts import Zod at runtime.
import type {} from 'zod'
import type {
  LearningAcceptSuggestionRequest,
  LearningAcceptSuggestionValue,
  LearningCurateValue,
  LearningDismissSuggestionRequest,
  LearningEntryView,
  LearningForgetRequest,
  LearningForgetValue,
  LearningPromoteRequest,
  LearningPromoteValue,
  LearningReviewRequest,
  LearningSnapshot,
  LearningSuggestionsValue,
  LearningSuggestionView, LearningUpdateRequest, LearningSkillsValue, LearningReadSkillRequest, LearningReadSkillValue,
  LearningWriteSkillRequest, LearningWriteSkillValue, LearningDeleteSkillRequest, LearningDeleteSkillValue,
} from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host learning Remote namespace owner. */
    learningController: LearningController
  }
}

/**
 * Project one stored entry into its Remote value.
 * @param entry - the stored entry.
 * @returns a detached JSON view.
 */
export function learningEntryView(entry: MemoryEntry): LearningEntryView {
  return {
    id: String(entry.id),
    text: entry.text,
    tags: [...entry.tags],
    kind: entry.kind,
    status: entry.status,
    ...entry.sourceSessionId === undefined ? {} : { sourceSessionId: String(entry.sourceSessionId) },
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  }
}

/**
 * Project one suggestion with its surviving entries into its Remote value.
 * @param suggestion - the stored suggestion.
 * @param entries - resolver from entry id to entry.
 * @returns a detached JSON view.
 */
export function learningSuggestionView(
  suggestion: MemorySuggestion,
  entries: (id: MemoryEntryId) => MemoryEntry | undefined,
): LearningSuggestionView {
  return {
    id: String(suggestion.id),
    name: suggestion.name,
    entries: suggestion.entryIds.map(entries).filter((entry): entry is MemoryEntry => entry !== undefined).map(learningEntryView),
    createdAt: suggestion.createdAt,
    status: suggestion.status,
  }
}

/** Host service backing the generated `ctx.remote.learning` namespace. */
export class LearningController extends TypertRemoteService {
  static inject = ['memory', 'learning']

  /** @param ctx - Host context carrying the memory store and the learning service. */
  constructor(ctx: Context) {
    super(ctx, 'learningController', { namespace: 'learning' })
  }

  /**
   * Read the candidates awaiting review and the entries the model recalls.
   * @returns both lists, oldest first.
   */
  @Remote('list')
  list(): Promise<LearningSnapshot> {
    return Promise.resolve({
      candidates: this.ctx.memory.list({ status: 'candidate' }).map(learningEntryView),
      recalled: this.ctx.memory.recalled().map(learningEntryView),
      curated: [...this.ctx.memory.list({ status: 'stale' }), ...this.ctx.memory.list({ status: 'archived' })].map(learningEntryView),
    })
  }

  /**
   * Run the configured curation once.
   * @returns what changed.
   */
  @Remote('curate')
  curate(): Promise<LearningCurateValue> {
    return this.ctx.memory.curate()
  }

  /**
   * Approve or reject one candidate.
   * @param request - the entry and the decision.
   * @returns the updated entry.
   */
  @Remote('review')
  async review(request: LearningReviewRequest): Promise<LearningEntryView> {
    const id = brandString<MemoryEntryId>(request.id)
    const entry = await this.ctx.memory.setStatus(id, request.decision === 'approve' ? 'approved' : 'rejected')
    return learningEntryView(entry)
  }

  /**
   * Edit one entry's text or tags in place.
   * @param request - the entry and the fields to replace.
   * @returns the updated entry.
   */
  @Remote('update')
  async update(request: LearningUpdateRequest): Promise<LearningEntryView> {
    const entry = await this.ctx.memory.update(brandString<MemoryEntryId>(request.id), {
      ...request.text === undefined ? {} : { text: request.text },
      ...request.tags === undefined ? {} : { tags: request.tags },
    })
    return learningEntryView(entry)
  }

  /**
   * Delete one entry.
   * @param request - the entry to delete.
   * @returns whether an entry existed.
   */
  @Remote('forget')
  async forget(request: LearningForgetRequest): Promise<LearningForgetValue> {
    return { removed: await this.ctx.memory.forget(brandString<MemoryEntryId>(request.id)) }
  }

  /**
   * List the skills the learning plugin wrote.
   * @returns skills sorted by name.
   */
  @Remote('skills')
  async skills(): Promise<LearningSkillsValue> {
    return { skills: await this.ctx.learning.skills() }
  }

  /**
   * Read one skill file.
   * @param request - the skill name.
   * @returns the contents, or `null` when the skill does not exist.
   */
  @Remote('readSkill')
  async readSkill(request: LearningReadSkillRequest): Promise<LearningReadSkillValue> {
    return { content: (await this.ctx.learning.readSkill(request.name)) ?? null }
  }

  /**
   * Replace one skill file and re-register it live.
   * @param request - the skill name and its complete contents.
   * @returns the written path.
   */
  @Remote('writeSkill')
  async writeSkill(request: LearningWriteSkillRequest): Promise<LearningWriteSkillValue> {
    return { path: await this.ctx.learning.writeSkill(request.name, request.content) }
  }

  /**
   * Delete one skill.
   * @param request - the skill name.
   * @returns whether a skill existed.
   */
  @Remote('deleteSkill')
  async deleteSkill(request: LearningDeleteSkillRequest): Promise<LearningDeleteSkillValue> {
    return { removed: await this.ctx.learning.deleteSkill(request.name) }
  }

  /**
   * Read the skill suggestions awaiting a decision.
   * @returns proposed suggestions with their entries, oldest first.
   */
  @Remote('suggestions')
  suggestions(): Promise<LearningSuggestionsValue> {
    return Promise.resolve({
      suggestions: this.ctx.memory.suggestions({ status: 'proposed' }).map(suggestion => learningSuggestionView(suggestion, id => this.ctx.memory.get(id))),
    })
  }

  /**
   * Promote a suggestion's entries together as one skill and mark it accepted.
   * @param request - the suggestion and an optional skill name.
   * @returns the written skill file path and the name used.
   */
  @Remote('acceptSuggestion')
  async acceptSuggestion(request: LearningAcceptSuggestionRequest): Promise<LearningAcceptSuggestionValue> {
    const suggestion = this.ctx.memory.getSuggestion(brandString<MemorySuggestionId>(request.id))
    if (suggestion === undefined) throw new Error(`No skill suggestion ${request.id}.`)
    const name = request.name ?? suggestion.name
    const path = await this.ctx.learning.promoteMany(suggestion.entryIds, name)
    await this.ctx.memory.setSuggestionStatus(suggestion.id, 'accepted')
    return { path, name }
  }

  /**
   * Dismiss a suggestion so the curator does not propose that cluster again.
   * @param request - the suggestion to dismiss.
   * @returns the dismissed suggestion.
   */
  @Remote('dismissSuggestion')
  async dismissSuggestion(request: LearningDismissSuggestionRequest): Promise<LearningSuggestionView> {
    const updated = await this.ctx.memory.setSuggestionStatus(brandString<MemorySuggestionId>(request.id), 'dismissed')
    return learningSuggestionView(updated, id => this.ctx.memory.get(id))
  }

  /**
   * Write one entry as a skill and mark it promoted.
   * @param request - the entry and the skill name.
   * @returns the written skill file path.
   */
  @Remote('promote')
  async promote(request: LearningPromoteRequest): Promise<LearningPromoteValue> {
    return { path: await this.ctx.learning.promote(brandString<MemoryEntryId>(request.id), request.name) }
  }
}

export default LearningController
