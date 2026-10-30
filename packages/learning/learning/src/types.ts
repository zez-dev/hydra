import type { ContextFormed, Message } from '@deepseek-ai/dsh-llm'
import type { MemoryEntryId, MemoryEntryKind } from '@deepseek-ai/dsh-memory'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /**
     * The extraction request this plugin sends beside the conversation. The kind
     * is the name released Hydra logs migrate this plugin's sources to.
     * @persistenceAttribution
     */
    'plugin:dsh-learning': { kind: 'plugin:dsh-learning' } & ContextFormed
  }
}

/** One proposed memory entry parsed from the extraction model's answer. */
export interface LearningCandidate {
  readonly text: string
  readonly kind: MemoryEntryKind
  readonly tags: readonly string[]
}

/** One tool failure followed by a later success of the same tool inside one turn. */
export interface ErrorPair {
  readonly tool: string
  /** Raw JSON arguments of the failed call. */
  readonly failedArguments: string
  /** Text of the failed result, first 400 characters. */
  readonly error: string
  /** Raw JSON arguments of the later successful call. */
  readonly recoveredArguments: string
  /** Text of the successful result, first 400 characters. */
  readonly recoveredResult: string
}

/** The compact rendering of one finished turn handed to the extraction model. */
export interface TurnTranscript {
  /** Number of `tool/call` events logged in the turn. */
  readonly toolCalls: number
  /** Rendered transcript, capped in UTF-8 bytes. */
  readonly text: string
}

/** Exact model-visible request recorded before one learning-extraction dispatch. */
export interface LearningRequestEventData {
  /** The finished turn the transcript covers. */
  readonly turn: number
  /** Exact auxiliary LLM route. */
  readonly route: { readonly provider: string; readonly model: string }
  /** Exact auxiliary system prompt. */
  readonly system: string
  /** Exact auxiliary message list. */
  readonly messages: Message[]
  /** Exact auxiliary output-token cap. */
  readonly maxTokens: number
  /** The route's lowest selectable reasoning effort, requested so the cap goes to the answer; absent when the route offers none. */
  readonly reasoningEffort?: string
  /**
   * Present for imports and other non-turn reviews (`turn` is then 0). For `/learn from` and `/digest`, the
   * document part reviewed (1-based `chunk` of `chunks`); `chunk` 0 is the `/digest` skill verdict over a document read in `chunks` parts.
   */
  readonly source?:
    | { readonly kind: 'import'; readonly path: string; readonly chunk: number; readonly chunks: number }
    | { readonly kind: 'research'; readonly slug: string }
    | { readonly kind: 'research-import'; readonly slug: string; readonly path: string; readonly chunk: number; readonly chunks: number }
    | { readonly kind: 'error-patterns'; readonly pairs: number }
}

/** What one turn review filed. */
export type LearningReviewOutcome =
  | { readonly kind: 'candidates'; readonly count: number }
  | { readonly kind: 'findings'; readonly slug: string; readonly count: number }
  | { readonly kind: 'failed'; readonly code: string; readonly message: string }

/** `session/learning-review` payload: the durable outcome of one turn review. */
export interface LearningReviewEventData {
  /** The reviewed turn. */
  readonly turn: number
  /** Memory candidates filed, findings recorded in the active research journal, or why the review produced nothing. */
  readonly outcome: LearningReviewOutcome
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Log-only pre-dispatch record of one learning-extraction model request.
     * @param data - the exact auxiliary request.
     */
    'session/learning-request': LearningRequestEventData
    /**
     * Log-only outcome of one turn review, appended once every candidate or finding it produced is stored.
     * @param data - the reviewed turn and what the review filed.
     */
    'session/learning-review': LearningReviewEventData
  }
}

/** One skill under the skills root as the Web card lists it. */
export interface LearningSkillView {
  /** Directory name, which is the skill name. */
  readonly name: string
  /** The frontmatter `description`, else the first heading, else the name. */
  readonly description: string
  /** Absolute path of the `SKILL.md`. */
  readonly path: string
  /** Size of the file in bytes. */
  readonly bytes: number
}

/** The `ctx.learning` service: the promotion path `/learn skill` and the Web card share. */
export interface LearningService {
  /**
   * Write one memory entry as `<skillsRoot>/<name>/SKILL.md`, register it live when a skill
   * registry is mounted, and mark the entry `promoted`.
   * @param id - the memory entry to promote.
   * @param name - the skill name: lowercase letters, digits, and single hyphens.
   * @returns the written skill file path.
   * @throws when the entry is unknown or the name is invalid.
   */
  promote(id: MemoryEntryId, name: string): Promise<string>
  /**
   * Write several entries as one `<skillsRoot>/<name>/SKILL.md`, register it live when a skill
   * registry is mounted, and mark every entry `promoted`.
   * @param ids - the memory entries to promote together, in the order they appear in the skill.
   * @param name - the skill name: lowercase letters, digits, and single hyphens.
   * @returns the written skill file path.
   * @throws when an entry is unknown, the list is empty, or the name is invalid.
   */
  promoteMany(ids: readonly MemoryEntryId[], name: string): Promise<string>
  /**
   * List the skills under the skills root, the ones `/learn` wrote from memory or documents.
   * @returns skills sorted by name.
   */
  skills(): Promise<LearningSkillView[]>
  /**
   * Read one skill's `SKILL.md`.
   * @param name - the skill name.
   * @returns the file contents, or `undefined` when no such skill exists.
   */
  readSkill(name: string): Promise<string | undefined>
  /**
   * Replace one skill's `SKILL.md` and re-register it live when a skill registry is mounted.
   * @param name - the skill name.
   * @param content - the complete file contents.
   * @returns the written path.
   * @throws when the name is invalid or the content is blank.
   */
  writeSkill(name: string, content: string): Promise<string>
  /**
   * Delete one skill directory and drop its live registration.
   * @param name - the skill name.
   * @returns whether a skill existed.
   */
  deleteSkill(name: string): Promise<boolean>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Memory-to-skill promotion shared by the `/learn` command and the learning Remote. */
    learning: LearningService
  }
}
