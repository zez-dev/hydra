/**
 * Learning growth. After each finished turn with enough tool activity, the
 * plugin runs one logged auxiliary model request over that turn's transcript
 * and stores the returned knowledge as memory candidates; nothing reaches the
 * model until a human approves it through `/learn`, which can also promote an
 * entry to a `SKILL.md`. Named exports preserve Loader injection metadata.
 * @module @deepseek-ai/dsh-learning
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { auxiliaryRoute, createUserMessage, lowestReasoningEffort, streamText } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, Message, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { deadline, MAX_TIMER_DELAY_MS, TimeoutReason } from '@deepseek-ai/dsh-timeout'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { normalizeForSimilarity, workspaceTag } from '@deepseek-ai/dsh-memory'
import type { MemoryEntry, MemoryStore } from '@deepseek-ai/dsh-memory'
import { readFile } from 'node:fs/promises'
import { relative } from 'node:path'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
// Type-only: makes the optional job registry available to `ctx.get('jobs')`.
import type {} from '@deepseek-ai/dsh-jobs'
import {
  collectErrorPairs, collectTurnTranscript, ERROR_PATTERN_SYSTEM_PROMPT, errorFingerprint, EXTRACTION_SYSTEM_PROMPT, parseCandidates,
  parseFindings, renderErrorPairs, RESEARCH_SYSTEM_PROMPT, parseIngestFindings, renderResearchIngestSystem,
} from './extract.ts'
// Type-only: resolves the optional `ctx.research` service declaration.
import type {} from '@deepseek-ai/dsh-research'
import { deleteSkill, executeLearnCommand, listSkills, promoteEntries, promoteEntry, readSkill, writeDocumentSkill, writeSkill, type LearningRoots } from './command.ts'
import { chunkText, DOCUMENT_SYSTEM_PROMPT, documentSkill, parseDigestInput, parseResearchIngestInput, resolveImportPath, walkImportFiles } from './ingest.ts'
import type { ImportMode, ImportSkip, LearnFromRequest, ResearchIngestRequest } from './ingest.ts'
import { mirrorBreakthroughs } from '@deepseek-ai/dsh-research'
import { digestDocument, writeSkillDraft } from './digest.ts'
import { CONSOLIDATE_SYSTEM_PROMPT, planGroups, renderConsolidation, renderGroup, runConsolidation } from './consolidate.ts'
import type { LearningCandidate, LearningRequestEventData, TurnTranscript } from './types.ts'

export type * from './types.ts'
export {
  collectErrorPairs, collectTurnTranscript, DIGEST_DOCUMENT_SYSTEM_PROMPT, DIGEST_PART_SYSTEM_PROMPT, ERROR_PATTERN_SYSTEM_PROMPT,
  errorFingerprint, EXTRACTION_SYSTEM_PROMPT,
  parseCandidates, parseDigestDocument, parseDigestPart, parseFindings, parseIngestFindings, renderErrorPairs, renderResearchIngestSystem,
  RESEARCH_INGEST_SYSTEM_PROMPT, RESEARCH_SYSTEM_PROMPT,
} from './extract.ts'
export type { DigestDocument, DigestPart, IngestFindingCandidate, ResearchFindingCandidate } from './extract.ts'
export { digestDocument, freeSkillName, writeSkillDraft } from './digest.ts'
export { CONSOLIDATE_SYSTEM_PROMPT, parseConsolidation, planGroups, renderConsolidation, renderGroup, runConsolidation } from './consolidate.ts'
export type { ConsolidatedNote, ConsolidationSummary, GroupOptions } from './consolidate.ts'
export type { DigestAsk, DigestedDocument } from './digest.ts'
export { discardDraft, executeLearnCommand, promoteEntries, promoteEntry, publishDraft, renderSkillBundle, renderSkillFile, SKILL_NAME } from './command.ts'
export type { LearningRoots } from './command.ts'
export {
  chunkText, DEFAULT_TEXT_EXTENSIONS, DOCUMENT_SYSTEM_PROMPT, parseDigestInput, parseLearnFromInput, parseResearchIngestInput,
  resolveImportPath, walkImportFiles,
} from './ingest.ts'
export type {
  ImportFile, ImportMode, ImportSkip, ImportSkipReason, LearnFromRequest, ResearchIngestRequest, WalkImportOptions, WalkImportResult,
} from './ingest.ts'

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    'learning-import': 'learning-import'
    'learning-review': 'learning-review'
    'learning-consolidate': 'learning-consolidate'
  }
}

export const name = 'learning'
export const inject = ['memory', 'llm', 'commands', 'agents', 'sessions']

/** Timeout reason code for auxiliary extraction requests. */
export const LEARNING_TIMEOUT_CODE = 'LEARNING_EXTRACT_TIMEOUT'

/** Failure code of an extraction answer the output cap cut off before it was complete. */
export const LEARNING_TRUNCATED_CODE = 'LEARNING_EXTRACT_TRUNCATED'

/** Failure code for an extraction answer with no text, after one retry at the route's default effort when a lower one was asked. */
export const LEARNING_EMPTY_CODE = 'LEARNING_EMPTY_ANSWER'

/** The error-pattern pass: a second extraction over tool failures followed by a working retry. */
export interface ErrorPatternConfig {
  /** Whether the pass runs at all. */
  enabled: boolean
  /** Cap on failure-then-recovery pairs reviewed per turn. */
  maxPairsPerTurn: number
}

/** Learning plugin configuration. */
export interface Config {
  /** Review each finished turn for candidates with one extraction request; imports work either way. */
  reviewTurns?: boolean
  /**
   * The review's deadline is the larger of `timeoutMs` and this factor times
   * the longest model request of the turn it reviews, so a slow local route
   * gets the time it demonstrably needs and a fast API keeps `timeoutMs`.
   * Defaults to `4`.
   */
  reviewTimeoutFactor?: number
  /** Review state new knowledge is filed in: `approved` recalls it from the next step on; `candidate` waits for `/learn approve`. */
  fileAs?: 'approved' | 'candidate'
  /** Turns with fewer logged tool calls are not reviewed. */
  minToolCalls: number
  /** Cap on candidates stored from one turn. */
  maxCandidatesPerTurn: number
  /** UTF-8 byte cap on the transcript sent to the extraction model. */
  maxTranscriptBytes: number
  /**
   * Output-token cap for the extraction request. An answer cut at this cap
   * (a model that thinks before it answers spends part of it on that) is
   * retried with the cap times `outputRetryFactor`, up to three raises and
   * never above the route's own configured cap, and the raised cap is kept
   * for that route for the life of the plugin.
   */
  maxOutputTokens: number
  /** Multiplier for the output cap after a truncated answer, applied up to three times; `1` disables the retry. Defaults to `4`. */
  outputRetryFactor?: number
  /** Deadline for one extraction request, in milliseconds. */
  timeoutMs: number
  /** Explicit extraction provider; configure with `model`. Omitted: the session's own logged route. */
  provider?: string
  /** Explicit extraction model; configure with `provider`. Omitted: the session's own logged route. */
  model?: string
  /** Directory receiving promoted `<name>/SKILL.md` bundles. Omitted: `$DSH_HOME/skills`. */
  skillsRoot?: string
  /** `/learn from`: files larger than this many bytes are skipped (default 262144). */
  maxFileBytes?: number
  /** `/learn from`: files beyond this count in one import are skipped (default 200). */
  maxFilesPerImport?: number
  /** `/learn from`: extra accepted file extensions without the dot, beside the built-in text list. */
  extensions?: string[]
  /** `/digest`: entries kept from one model request; more are counted and reported as dropped (default 20). */
  digestMaxEntriesPerPart?: number
  /** `/digest`: directory receiving skill drafts that wait for `/learn publish`. Omitted: `$DSH_HOME/skill-drafts`. */
  skillDraftsRoot?: string
  /** `/learn consolidate`: note similarity at or above which a note joins a group's first note (default 0.4). */
  consolidateRelatedThreshold?: number
  /** `/learn consolidate`: most notes sent to the model in one group (default 20). */
  consolidateMaxGroupSize?: number
  /** `/learn consolidate`: most groups one run sends, largest first; the rest wait for the next run (default 25). */
  consolidateMaxGroups?: number
  /** Second extraction pass over tool failures followed by a working retry (default enabled, 5 pairs per turn). */
  errorPatterns?: ErrorPatternConfig
}

/** Schemastery configuration schema. */
export const Config: z<Config> = z.object({
  reviewTurns: z.boolean().default(true),
  reviewTimeoutFactor: z.number().min(1).default(4),
  fileAs: z.union(['approved', 'candidate'] as const).default('approved'),
  minToolCalls: z.natural().required(),
  maxCandidatesPerTurn: z.natural().min(1).required(),
  maxTranscriptBytes: z.natural().min(1).required(),
  maxOutputTokens: z.natural().min(1).required(),
  outputRetryFactor: z.number().min(1).default(4),
  timeoutMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).required(),
  provider: z.string(),
  model: z.string(),
  skillsRoot: z.string(),
  maxFileBytes: z.natural().min(1).default(262_144),
  maxFilesPerImport: z.natural().min(1).default(200),
  extensions: z.array(z.string()).default([]),
  digestMaxEntriesPerPart: z.natural().min(1).default(20),
  consolidateRelatedThreshold: z.number().min(0).max(1).default(0.4),
  consolidateMaxGroupSize: z.natural().min(2).default(20),
  consolidateMaxGroups: z.natural().min(1).default(25),
  skillDraftsRoot: z.string(),
  errorPatterns: z.object({
    enabled: z.boolean().default(true),
    maxPairsPerTurn: z.natural().min(1).default(5),
  }).default({ enabled: true, maxPairsPerTurn: 5 }),
})

/**
 * The review's total deadline: `timeoutMs`, or more when the turn's own model
 * requests show the route needs longer. The longest step of the turn, from
 * `step/start` to its `assistant/message`, times `reviewTimeoutFactor`, is the
 * route's demonstrated pace for a prompt of the review's size; the slowest
 * step's milliseconds per output token, times the review's own output cap,
 * is what a raised cap needs on that route.
 * @param config - plugin configuration.
 * @param events - the turn's events with their log times.
 * @param maxTokens - the output cap of the attempt the deadline covers.
 * @returns the deadline in milliseconds.
 */
function reviewDeadlineMs(config: Config, events: readonly SessionEvent[], maxTokens: number): number {
  const starts = new Map<number, number>()
  let longest = 0
  let msPerOutputToken = 0
  for (const event of events) {
    if (event.type === 'step/start') starts.set(event.data.step, event.time)
    if (event.type === 'assistant/message') {
      const start = starts.get(event.data.step)
      if (start === undefined) continue
      const took = event.time - start
      longest = Math.max(longest, took)
      const output = event.data.usage?.outputTokens ?? 0
      if (output > 0) msPerOutputToken = Math.max(msPerOutputToken, took / output)
    }
  }
  // The route's demonstrated pace, then the time this cap needs at that
  // pace on top of the longest request, which stands in for prompt reading.
  const paced = Math.round(longest + maxTokens * msPerOutputToken)
  return Math.max(config.timeoutMs, Math.round(longest * (config.reviewTimeoutFactor ?? 4)), paced)
}

/**
 * The transcript a turn review sends, when the turn qualifies for one.
 * @param config - plugin configuration.
 * @param events - the turn's events as observed live, `turn/start` through `turn/end`.
 * @param turn - the finished turn number.
 * @returns the transcript, or `undefined` for a turn with fewer than `minToolCalls` tool calls or no text.
 */
function reviewTranscript(config: Config, events: readonly SessionEvent[], turn: number): TurnTranscript | undefined {
  const transcript = collectTurnTranscript(events, turn, config.maxTranscriptBytes)
  return transcript.toolCalls < config.minToolCalls || transcript.text.length === 0 ? undefined : transcript
}

/**
 * Review one finished turn: log the exact request, call the model, store candidates.
 * @param ctx - plugin context.
 * @param config - plugin configuration.
 * @param store - the memory store.
 * @param agent - the agent whose turn finished.
 * @param turn - the finished turn number.
 * @param events - the turn's events as observed live, `turn/start` through `turn/end`.
 * @param transcript - the turn's transcript from `reviewTranscript`.
 * @param signal - cancellation: the job's, or the maintenance task's without a job registry.
 */
async function extractTurn(
  ctx: Context,
  config: Config,
  store: MemoryStore,
  agent: Agent,
  turn: number,
  events: readonly SessionEvent[],
  transcript: TurnTranscript,
  signal: AbortSignal,
): Promise<void> {
  const session = agent.session
  const route = auxiliaryRoute(config, session.requestHeader()?.config)
  if (route === undefined) return
  const deadlineFor = (maxTokens: number): number => reviewDeadlineMs(config, events, maxTokens)
  // A research session files findings into its journal instead of proposing memories.
  const research = ctx.get('research')
  const active = research?.activeFor(session.id)
  if (research !== undefined && active !== undefined) {
    const answer = await requestText(ctx, config, session, route, {
      system: RESEARCH_SYSTEM_PROMPT,
      prompt: `Extract journal findings from this research turn transcript:\n${transcript.text}`,
      log: { turn, source: { kind: 'research', slug: active.slug } },
      signal,
      deadlineFor,
    })
    let count = 0
    for (const finding of parseFindings(answer, config.maxCandidatesPerTurn)) {
      await research.record({ cwd: active.cwd, slug: active.slug, kind: finding.kind, text: finding.text, ...finding.result === undefined ? {} : { result: finding.result } }, 'auto')
      count += 1
    }
    session.append('session/learning-review', { turn, outcome: { kind: 'findings', slug: active.slug, count } }, { ignorable: true })
    return
  }
  const candidates = await requestCandidates(ctx, config, session, route, {
    system: EXTRACTION_SYSTEM_PROMPT,
    prompt: `Review this turn transcript:\n${transcript.text}`,
    log: { turn },
    signal,
    deadlineFor,
  })
  let filed = 0
  for (const candidate of candidates) {
    // A note the store already holds takes the new wording rather than counting as filed.
    const known = store.findDuplicate(candidate.text) !== undefined
    await store.add({ ...candidate, tags: [...candidate.tags, ...projectTags(session)] }, config.fileAs ?? 'approved', session.id)
    if (!known) filed += 1
  }
  const shortcuts = await extractErrorPatterns(ctx, config, store, session, route, events, turn, signal)
  session.append('session/learning-review', { turn, outcome: { kind: 'candidates', count: filed + shortcuts } }, { ignorable: true })
}

/**
 * Whether a maintenance rejection is the agent loop's `{ kind: 'disposed' }`
 * cancel reason, which ends every pending task when the Agent is disposed.
 * @param error - the maintenance rejection.
 * @returns true for a disposal cancel.
 */
function isDisposalCancel(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'kind' in error
    && (error.kind === 'disposed' || error.kind === 'superseded')
}

/**
 * Record why a turn review produced nothing, so the transcript shows the
 * failure instead of silence. The review's own request event is already in
 * the log; this closes it.
 * @param session - the reviewed session.
 * @param turn - the reviewed turn.
 * @param error - the failure.
 * @param message - the failure text already logged.
 */
function recordFailedReview(session: Session, turn: number, error: unknown, message: string): void {
  const fields = typeof error === 'object' && error !== null ? error : {}
  const code = 'code' in fields && typeof fields.code === 'string' ? fields.code : 'UNKNOWN'
  // A rejection that is not an Error usually carries a message field; anything else is recorded as JSON so the row names it.
  if (!(error instanceof Error)) {
    if ('message' in fields && typeof fields.message === 'string') message = fields.message
    else {
      try {
        message = JSON.stringify(error).slice(0, 500)
      } catch {
        // A circular value keeps the caller's rendering.
      }
    }
  }
  try {
    session.append('session/learning-review', { turn, outcome: { kind: 'failed', code, message } }, { ignorable: true })
  } catch {
    // The session closed while the review was failing; nothing is left to tell.
  }
}

/**
 * The tag naming the session's workspace, so recall ranks this project's notes first.
 * @param session - the session an entry is learned in.
 * @returns the workspace tag, or none for a session without a working directory.
 */
function projectTags(session: Session): string[] {
  const cwd = session.header.cwd
  return cwd === undefined ? [] : [workspaceTag(cwd)]
}

/**
 * Whether the store already holds an entry with the same normalized text, or
 * an entry filed for the same error fingerprint, in any review state.
 * @param store - the memory store.
 * @param text - the candidate text.
 * @param fingerprintTag - the candidate's `error:` tag.
 * @returns true when filing the candidate would repeat an existing entry.
 */
function alreadyFiled(store: MemoryStore, text: string, fingerprintTag: string): boolean {
  const normalized = normalizeForSimilarity(text)
  return store.list().some(entry => normalizeForSimilarity(entry.text) === normalized || entry.tags.includes(fingerprintTag))
}

/**
 * The error-pattern pass: find failure-then-recovery pairs in the turn, ask
 * the model for one shortcut per pair, and file the new ones tagged with the
 * tool and the error fingerprint.
 * @param ctx - plugin context.
 * @param config - plugin configuration.
 * @param store - the memory store.
 * @param session - the reviewed session.
 * @param route - the extraction route.
 * @param events - the turn's events.
 * @param turn - the finished turn number.
 * @param signal - maintenance cancellation.
 * @returns how many shortcut candidates were filed.
 */
async function extractErrorPatterns(
  ctx: Context,
  config: Config,
  store: MemoryStore,
  session: Session,
  route: { provider: string; model: string },
  events: readonly SessionEvent[],
  turn: number,
  signal: AbortSignal,
): Promise<number> {
  const policy = config.errorPatterns ?? { enabled: true, maxPairsPerTurn: 5 }
  if (!policy.enabled) return 0
  const pairs = collectErrorPairs(events, turn, policy.maxPairsPerTurn)
  if (pairs.length === 0) return 0
  const candidates = await requestCandidates(ctx, config, session, route, {
    system: ERROR_PATTERN_SYSTEM_PROMPT,
    prompt: `Write one shortcut per pair:\n${renderErrorPairs(pairs)}`,
    log: { turn, source: { kind: 'error-patterns', pairs: pairs.length } },
    signal,
  })
  let filed = 0
  for (const [index, candidate] of candidates.entries()) {
    const pair = pairs[Math.min(index, pairs.length - 1)]
    if (pair === undefined) break
    const fingerprintTag = `error:${errorFingerprint(pair.error)}`
    if (alreadyFiled(store, candidate.text, fingerprintTag)) continue
    const tags = [...candidate.tags, `fix:${pair.tool}`, fingerprintTag, ...projectTags(session)]
    await store.add({ text: candidate.text, kind: 'shortcut', tags }, config.fileAs ?? 'approved', session.id)
    filed += 1
  }
  return filed
}

/** One extraction request: what to ask, and what the log-only event records beside it. */
interface CandidateRequest {
  readonly system: string
  readonly prompt: string
  readonly log: Pick<LearningRequestEventData, 'turn' | 'source'>
  readonly signal: AbortSignal
  /** Total deadline for this request; `timeoutMs` when absent. */
  readonly deadlineMs?: number
  /** Deadline for an attempt at the given output cap; takes precedence over `deadlineMs` when present. */
  readonly deadlineFor?: (maxTokens: number) => number
  /** Output cap for this request; the route's remembered cap or `maxOutputTokens` when absent. */
  readonly maxTokens?: number
}

/**
 * Log the exact request, call the extraction route, and parse the candidates.
 * @param ctx - plugin context.
 * @param config - plugin configuration.
 * @param session - the session the request is logged to.
 * @param route - the extraction route.
 * @param request - system prompt, user prompt, log fields, and cancellation.
 * @returns the parsed candidates, capped at `maxCandidatesPerTurn`.
 */
async function requestCandidates(
  ctx: Context,
  config: Config,
  session: Session,
  route: { provider: string; model: string },
  request: CandidateRequest,
): Promise<LearningCandidate[]> {
  return parseCandidates(await requestText(ctx, config, session, route, request), config.maxCandidatesPerTurn)
}

/**
 * Log the exact request, call the extraction route, and return its text answer.
 * @param ctx - plugin context.
 * @param config - plugin configuration.
 * @param session - the session the request is logged to.
 * @param route - the extraction route.
 * @param request - system prompt, user prompt, log fields, and cancellation.
 * @returns the concatenated text output.
 */
async function requestText(
  ctx: Context,
  config: Config,
  session: Session,
  route: { provider: string; model: string },
  request: CandidateRequest,
): Promise<string> {
  const routeKey = `${route.provider}/${route.model}`
  const raisedCaps = raisedOutputCapsOf(ctx)
  const defaultEffortRoutes = defaultEffortRoutesOf(ctx)
  let maxTokens = request.maxTokens ?? raisedCaps.get(routeKey) ?? config.maxOutputTokens
  const factor = config.outputRetryFactor ?? 4
  let lowerEffort = !defaultEffortRoutes.has(routeKey)
  for (let raise = 0; ; ) {
    try {
      const attempt = request.deadlineFor === undefined ? request : { ...request, deadlineMs: request.deadlineFor(maxTokens) }
      const text = await requestTextOnce(ctx, config, session, route, attempt, maxTokens, lowerEffort)
      // An answer at the default effort after an empty one at the lowest: the route keeps its default from now on.
      if (!lowerEffort) defaultEffortRoutes.add(routeKey)
      return text
    } catch (error) {
      if (isEmptyAtLoweredEffort(error)) {
        // Some servers file a reply asked not to think entirely as reasoning;
        // the route's default effort keeps the answer in the text.
        lowerEffort = false
        ctx.logger.warn(`learning: ${routeKey} answered with no text at its lowest reasoning effort; asking again at its default effort`)
        continue
      }
      raise += 1
      if (factor <= 1 || raise > OUTPUT_RAISES || !isTruncation(error)) throw error
      const ceiling = await outputCeiling(ctx, route, maxTokens, factor, request.signal)
      if (maxTokens >= ceiling) throw error
      const raised = Math.min(ceiling, Math.round(maxTokens * factor))
      raisedCaps.set(routeKey, raised)
      ctx.logger.warn(`learning: extraction on ${routeKey} was cut at ${maxTokens} output tokens; retrying with ${raised} and keeping it for this route`)
      maxTokens = raised
    }
  }
}

/** Raises a truncated extraction may get before its failure is recorded. */
const OUTPUT_RAISES = 3

/**
 * The largest output cap a raise may reach: the route's own configured cap
 * when the adapter reports one, else the cap after every allowed raise.
 * @param ctx - plugin context.
 * @param route - the extraction route.
 * @param current - the cap the truncated attempt used.
 * @param factor - the raise multiplier.
 * @param signal - cancellation for the adapter lookup.
 * @returns the ceiling in output tokens.
 */
async function outputCeiling(
  ctx: Context,
  route: { provider: string; model: string },
  current: number,
  factor: number,
  signal: AbortSignal,
): Promise<number> {
  const fallback = Math.round(current * factor ** OUTPUT_RAISES)
  const info = await ctx.llm.resolveModelInfo(route.provider, route.model, signal).catch(() => undefined)
  return info?.defaultMaxTokens ?? fallback
}

/** Output caps raised after a truncated answer, by `provider/model`, for the life of each plugin instance. */
const raisedOutputCapsByPlugin = new WeakMap<Context, Map<string, number>>()

function raisedOutputCapsOf(ctx: Context): Map<string, number> {
  let caps = raisedOutputCapsByPlugin.get(ctx)
  if (caps === undefined) {
    caps = new Map()
    raisedOutputCapsByPlugin.set(ctx, caps)
  }
  return caps
}

function isTruncation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === LEARNING_TRUNCATED_CODE
}

/**
 * Routes that answered with no text at their lowest effort and with text at
 * their default, asked at their default for the life of each plugin instance.
 */
const defaultEffortRoutesByPlugin = new WeakMap<Context, Set<string>>()

function defaultEffortRoutesOf(ctx: Context): Set<string> {
  let routes = defaultEffortRoutesByPlugin.get(ctx)
  if (routes === undefined) {
    routes = new Set()
    defaultEffortRoutesByPlugin.set(ctx, routes)
  }
  return routes
}

function isEmptyAtLoweredEffort(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'loweredEffort' in error && error.loweredEffort === true
}

/**
 * The route's lowest selectable reasoning effort, so a thinking model spends
 * the extraction's small output cap on the answer instead of on reasoning.
 * @param ctx - plugin context.
 * @param route - the extraction route.
 * @param signal - cancellation for the adapter lookup.
 * @returns the effort id, or `undefined` when the route offers none or cannot be resolved.
 */
async function routeLowestEffort(
  ctx: Context,
  route: { provider: string; model: string },
  signal: AbortSignal,
): Promise<ReasoningEffortId | undefined> {
  try {
    return lowestReasoningEffort(await ctx.llm.resolveModelInfo(route.provider, route.model, signal))
  } catch (_unresolvedRoute) {
    // The request itself fails loud on a route that cannot be resolved; the effort is a preference.
    return undefined
  }
}

/**
 * Log the exact request with one output cap, call the route, and return its text answer.
 * @param ctx - plugin context.
 * @param config - plugin configuration.
 * @param session - the session the request is logged to.
 * @param route - the extraction route.
 * @param request - system prompt, user prompt, log fields, and cancellation.
 * @param maxTokens - the output cap for this attempt.
 * @param lowerEffort - ask for the route's lowest reasoning effort.
 * @returns the concatenated text output.
 * @throws an `Error` with code {@link LEARNING_EMPTY_CODE} when the answer has no text, marked
 *   `loweredEffort: true` when a lowered effort was asked.
 */
async function requestTextOnce(
  ctx: Context,
  config: Config,
  session: Session,
  route: { provider: string; model: string },
  request: CandidateRequest,
  maxTokens: number,
  lowerEffort: boolean,
): Promise<string> {
  const messages: Message[] = [createUserMessage({
    content: [{ type: 'text', text: request.prompt }],
    source: { kind: 'plugin:dsh-learning' },
  })]
  using callDeadline = deadline(request.signal, request.deadlineMs ?? config.timeoutMs, LEARNING_TIMEOUT_CODE)
  const reasoningEffort = lowerEffort ? await routeLowestEffort(ctx, route, callDeadline.signal) : undefined
  const options: GenerateOptions = {
    provider: route.provider,
    model: route.model,
    messages,
    system: request.system,
    maxTokens,
    sessionId: session.id,
    purpose: 'learning-extract',
    signal: callDeadline.signal,
    ...reasoningEffort === undefined ? {} : { reasoningEffort },
  }
  session.append('session/learning-request', {
    turn: request.log.turn,
    route,
    system: request.system,
    messages,
    maxTokens,
    ...reasoningEffort === undefined ? {} : { reasoningEffort },
    ...request.log.source === undefined ? {} : { source: request.log.source },
  }, { ignorable: true })
  let text: string
  try {
    text = await streamText(ctx.llm.stream(options), callDeadline.signal, {
      maxTokens: () => Object.assign(new Error('learning: extraction output reached maxOutputTokens'), { code: LEARNING_TRUNCATED_CODE }),
      toolCalls: () => new Error('learning: extraction model unexpectedly requested a tool'),
    })
  } catch (error) {
    // A request the deadline cut short reports the deadline, not the adapter's view of the abort.
    if (callDeadline.signal.reason instanceof TimeoutReason) throw callDeadline.signal.reason
    throw error
  }
  if (text.trim().length === 0) {
    throw Object.assign(new Error('learning: the model\'s answer had no text'), { code: LEARNING_EMPTY_CODE, loweredEffort: reasoningEffort !== undefined })
  }
  return text
}

/** Totals reported by one `/learn from` import. */
interface ImportSummary {
  files: number
  chunks: number
  candidates: number
  /** Extractions already held under the same normalized text, so not filed again. */
  duplicates: number
  /** Whether filed entries went straight to `approved`. */
  approved: boolean
  /** What the import made of each file. */
  mode: ImportMode
  /** Skills written when the import ran with `--as-skills`. */
  skills: string[]
  /** `/digest` skill drafts, and whether each was written from an excerpt of a long document. */
  drafts: { readonly name: string; readonly excerpt: boolean }[]
  /** `/digest` entries past the per-request cap, not filed. */
  dropped: number
  /** Requests that failed (chunk 0 is a `/digest` skill verdict); the import went on with the next one. */
  failed: { readonly relative: string; readonly chunk: number; readonly message: string }[]
  skipped: ImportSkip[]
}

/**
 * Render the import totals for the command result.
 * @param summary - the totals.
 * @returns one or two lines.
 */
function renderImportSummary(summary: ImportSummary): string {
  const filed = summary.approved
    ? `${summary.candidates} entr${summary.candidates === 1 ? 'y' : 'ies'} approved and recalled from the next step on`
    : `${summary.candidates} candidate(s) filed for /learn review`
  const duplicates = summary.duplicates === 0 ? '' : `; ${summary.duplicates} already known and not filed again`
  const failedList = summary.failed.slice(0, 5)
    .map(entry => `${entry.relative} ${entry.chunk === 0 ? 'skill verdict' : `part ${entry.chunk}`} (${entry.message})`).join(', ')
  const failed = summary.failed.length === 0
    ? ''
    : `\nFailed ${summary.failed.length} ${summary.mode === 'auto' ? 'request' : 'chunk'}(s): ${failedList}${summary.failed.length > 5 ? ', ...' : ''}`
  const drafts = summary.drafts.map(draft => `${draft.name}${draft.excerpt ? ' (written from an excerpt)' : ''}`).join(', ')
  const digested = summary.drafts.length === 0
    ? 'no skill drafts'
    : `${summary.drafts.length} skill draft(s) for your review: ${drafts}`
  const dropped = summary.dropped === 0 ? '' : `\n${summary.dropped} more entr${summary.dropped === 1 ? 'y' : 'ies'} past the per-request cap not filed.`
  const review = summary.drafts.length === 0 ? '' : '\n/learn drafts lists the drafts; /learn publish <draft> makes one live.'
  const line = summary.chunks === 0 && summary.skills.length > 0
    ? `Wrote ${summary.skills.length} skill(s) from ${summary.files} file(s): ${summary.skills.join(', ')}.`
    : summary.mode === 'auto'
      ? `Digested ${summary.files} file(s) in ${summary.chunks} model request(s): ${digested}; ${filed}${duplicates}.${dropped}${failed}${review}`
      : `Imported ${summary.files} file(s) in ${summary.chunks} chunk(s); ${filed}${duplicates}.${failed}`
  if (summary.skipped.length === 0) return line
  const shown = summary.skipped.slice(0, 10).map(entry => `${entry.relative} (${entry.reason})`).join(', ')
  return `${line}\nSkipped ${summary.skipped.length}: ${shown}${summary.skipped.length > 10 ? ', ...' : ''}`
}

/** A validated import: the route, the files to read, and the entries skipped while walking. */
interface PreparedImport {
  readonly route: { readonly provider: string; readonly model: string } | undefined
  readonly walked: Awaited<ReturnType<typeof walkImportFiles>>
}

/**
 * Validate an import before any work starts: the route (unless the files are
 * written as skills) and the walk of the target path.
 * @param config - plugin configuration.
 * @param session - the agent session whose cwd resolves the path and whose log names the route.
 * @param request - the parsed `/learn from` arguments.
 * @param signal - cancellation for the walk.
 * @returns the prepared import, or the error result to return at once.
 */
async function prepareImport(
  config: Config,
  session: Session,
  request: LearnFromRequest,
  signal: AbortSignal,
): Promise<PreparedImport | CommandResult> {
  const cwd = session.header.cwd ?? process.cwd()
  const target = resolveImportPath(cwd, request.path)
  // Writing files as skills needs no model; only an extraction needs a route.
  const route = request.mode === 'skills' ? undefined : auxiliaryRoute(config, session.requestHeader()?.config)
  if (route === undefined && request.mode !== 'skills') {
    return { kind: 'error', text: 'No extraction route yet: send one message in this session first, or configure `provider` and `model` on dsh-learning.' }
  }
  try {
    const walked = await walkImportFiles(target, {
      extensions: config.extensions ?? [],
      maxFileBytes: config.maxFileBytes ?? 262_144,
      maxFiles: config.maxFilesPerImport ?? 200,
      signal,
    })
    return { route, walked }
  } catch (error) {
    return { kind: 'error', text: `Cannot import ${request.path}: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/**
 * Read every prepared file, extract from each chunk, and file what is new.
 * Never throws: cancellation and failure become error results, and what was
 * filed before them stays filed.
 * @param ctx - plugin context.
 * @param config - plugin configuration.
 * @param store - the memory store.
 * @param roots - the folders receiving `--as-skills` imports and `/digest` drafts.
 * @param request - the parsed `/learn from` arguments.
 * @param prepared - the validated route and files.
 * @param session - the session that logs each extraction request and owns the filed entries.
 * @param signal - cancellation; the import stops after the current request.
 * @returns the command result and, on success, the totals behind it.
 */
async function executeImport(
  ctx: Context,
  config: Config,
  store: MemoryStore,
  roots: LearningRoots,
  request: LearnFromRequest,
  prepared: PreparedImport,
  session: Session,
  signal: AbortSignal,
): Promise<{ result: CommandResult; summary: ImportSummary }> {
  const { route, walked } = prepared
  const filedAs = config.fileAs ?? 'approved'
  const summary: ImportSummary = {
    mode: request.mode, files: 0, chunks: 0, candidates: 0, duplicates: 0, approved: filedAs === 'approved', skills: [], drafts: [], dropped: 0, failed: [],
    skipped: walked.skipped,
  }
  try {
    for (const file of walked.files) {
      signal.throwIfAborted()
      const text = await readFile(file.path, 'utf8')
      summary.files += 1
      const skill = documentSkill(file.relative, text)
      if (request.mode === 'skills') {
        if (skill === undefined) {
          summary.skipped.push({ relative: file.relative, reason: 'no-skill-name' })
          continue
        }
        await writeDocumentSkill(ctx, roots.skills, skill.name, skill.description, text)
        summary.skills.push(skill.name)
        continue
      }
      if (route === undefined) throw new Error('learning: extraction route missing after the route check')
      const fileCandidates = async (candidates: readonly LearningCandidate[]): Promise<void> => {
        for (const candidate of candidates) {
          const known = store.findDuplicate(candidate.text) !== undefined
          await store.add({ ...candidate, tags: [...candidate.tags, ...request.tags, `source:${file.relative}`, ...projectTags(session)] }, filedAs, session.id)
          if (known) summary.duplicates += 1
          else summary.candidates += 1
        }
      }
      if (request.mode === 'auto') {
        const digested = await digestDocument(file.relative, text, config.maxTranscriptBytes, config.digestMaxEntriesPerPart ?? 20, {
          ask: (system, prompt, part) => {
            summary.chunks += 1
            const log = { turn: 0, source: { kind: 'import' as const, path: file.relative, chunk: part.chunk, chunks: part.chunks } }
            return requestText(ctx, config, session, route, { system, prompt, log, signal })
          },
          keep: fileCandidates,
        }, signal)
        summary.dropped += digested.dropped
        summary.failed.push(...digested.failed.map(failure => ({ relative: file.relative, ...failure })))
        if (digested.draft === undefined) continue
        if (skill === undefined) {
          summary.skipped.push({ relative: file.relative, reason: 'no-skill-name' })
          continue
        }
        const description = digested.draft.description.length > 0 ? digested.draft.description : skill.description
        const draft = { description, body: digested.draft.body }
        const name = await writeSkillDraft(roots.drafts, roots.skills, skill.name, draft, { path: file.path, text })
        summary.drafts.push({ name, excerpt: digested.draft.excerpt })
        continue
      }
      const chunks = chunkText(text, config.maxTranscriptBytes)
      for (const [index, chunk] of chunks.entries()) {
        signal.throwIfAborted()
        summary.chunks += 1
        let candidates: LearningCandidate[]
        try {
          const prompt = `Source file: ${file.relative}${chunks.length > 1 ? ` (part ${index + 1} of ${chunks.length})` : ''}\n\n${chunk}`
          const log = { turn: 0, source: { kind: 'import' as const, path: file.relative, chunk: index + 1, chunks: chunks.length } }
          candidates = await requestCandidates(ctx, config, session, route, { system: DOCUMENT_SYSTEM_PROMPT, prompt, log, signal })
        } catch (error) {
          // A cancelled import stops; a failed chunk (a slow route, a cut answer) is reported and the next chunk still runs.
          if (signal.aborted) throw error
          const message = error instanceof Error ? error.message : String(error)
          summary.failed.push({ relative: file.relative, chunk: index + 1, message })
          continue
        }
        await fileCandidates(candidates)
      }
    }
  } catch (error) {
    if (signal.aborted) {
      return { result: { kind: 'error', text: `Import cancelled after ${summary.chunks} chunk(s); ${summary.candidates} candidate(s) were filed.` }, summary }
    }
    return { result: { kind: 'error', text: `Import failed after ${summary.chunks} chunk(s): ${error instanceof Error ? error.message : String(error)}` }, summary }
  }
  return { result: { kind: 'success', text: renderImportSummary(summary) }, summary }
}

/**
 * Import a file or folder of knowledge. Files written as skills, and every
 * import without a composed job registry, run inside the command request. A
 * model-backed import with `ctx.jobs` composed starts a `learning-import`
 * job owned by the agent: the command returns at once with the job id, the
 * extraction goes on after the request that sent it ends, the summary is the
 * job's output (delivered as the job notice), and `job_kill` or the agent's
 * disposal stops it after the current chunk.
 * @param ctx - plugin context.
 * @param config - plugin configuration.
 * @param store - the memory store.
 * @param roots - the folders receiving `--as-skills` imports and `/digest` drafts.
 * @param request - the parsed `/learn from` arguments.
 * @param invocation - the command invocation (agent, cancellation).
 * @returns the command result: totals for an inline import, the job id for a background one,
 *   or an error for a bad path, a missing route, or cancellation.
 */
async function importPath(
  ctx: Context,
  config: Config,
  store: MemoryStore,
  roots: LearningRoots,
  request: LearnFromRequest,
  invocation: CommandInvocation,
): Promise<CommandResult> {
  const session = invocation.agent.session
  const prepared = await prepareImport(config, session, request, invocation.signal)
  if ('kind' in prepared) return prepared
  const jobs = request.mode === 'skills' ? undefined : ctx.get('jobs')
  if (jobs === undefined) {
    return (await executeImport(ctx, config, store, roots, request, prepared, session, invocation.signal)).result
  }
  const controller = new AbortController()
  let id: string
  try {
    id = jobs.start({
      kind: 'learning-import',
      label: `${request.mode === 'auto' ? '/digest' : '/learn from'} ${request.path}`,
      owner: invocation.agent.session.id,
      run: () => ({
        cancel: (reason) => { controller.abort(new Error(reason ?? 'learning import cancelled')) },
        done: executeImport(ctx, config, store, roots, request, prepared, session, controller.signal).then(({ result, summary }) => ({
          status: result.kind === 'success' ? 'completed' as const : controller.signal.aborted ? 'killed' as const : 'failed' as const,
          detail: `${summary.candidates} entries filed${summary.drafts.length === 0 ? '' : `, ${summary.drafts.length} skill draft(s)`}`,
          ...result.text === undefined ? {} : { result: result.text },
        })),
      }),
    })
  } catch (error) {
    return { kind: 'error', text: `Cannot start the import as a background job: ${error instanceof Error ? error.message : String(error)}` }
  }
  return {
    kind: 'success',
    text: `${request.mode === 'auto' ? 'Digesting' : 'Importing'} ${prepared.walked.files.length} file(s) from ${request.path} as background job ${id}; `
      + `the summary arrives as its job notice, and job_kill ${id} stops it after the current chunk.`,
  }
}

/** Output tokens a consolidation answer is given per note in its group, before the cut-answer raise. */
const CONSOLIDATE_TOKENS_PER_NOTE = 120

/**
 * Run `/learn consolidate`: group the approved and promoted entries of the
 * session's workspace and those saved without one (every workspace's with
 * `all`), and consolidate up to `consolidateMaxGroups` groups, largest first.
 * Each group is one auxiliary request, logged as `session/learning-request`
 * with `turn: 0` and no `source`; its output cap grows with the group. With
 * `ctx.jobs` composed the run is a `learning-consolidate` job owned by the
 * agent, like an import; otherwise it runs inside the command request.
 * @param ctx - plugin context.
 * @param config - plugin configuration.
 * @param store - the memory store.
 * @param all - group every workspace's entries.
 * @param invocation - the command invocation (agent, cancellation).
 * @returns the totals, the job id for a background run, or an error for a missing route.
 */
async function consolidateMemory(
  ctx: Context,
  config: Config,
  store: MemoryStore,
  all: boolean,
  invocation: CommandInvocation,
): Promise<CommandResult> {
  const session = invocation.agent.session
  const route = auxiliaryRoute(config, session.requestHeader()?.config)
  if (route === undefined) {
    return { kind: 'error', text: 'No extraction route yet: send one message in this session first, or configure `provider` and `model` on dsh-learning.' }
  }
  const cwd = session.header.cwd
  const groups = planGroups(store.recalled(), {
    threshold: config.consolidateRelatedThreshold ?? 0.4,
    maxSize: config.consolidateMaxGroupSize ?? 20,
    ...cwd === undefined ? {} : { workspace: cwd },
    all,
  })
  const batch = groups.slice(0, config.consolidateMaxGroups ?? 25)
  if (batch.length === 0) {
    const none = { groups: 0, remaining: 0, consolidated: 0, replaced: 0, written: 0, kept: 0, untagged: 0, failed: [] }
    return { kind: 'success', text: renderConsolidation(none, all) }
  }
  const ask = (signal: AbortSignal) => (group: readonly MemoryEntry[]) => requestText(ctx, config, session, route, {
    system: CONSOLIDATE_SYSTEM_PROMPT,
    prompt: renderGroup(group),
    log: { turn: 0 },
    signal,
    maxTokens: Math.max(config.maxOutputTokens, group.length * CONSOLIDATE_TOKENS_PER_NOTE),
  })
  const run = (signal: AbortSignal) => runConsolidation(store, batch, groups.length - batch.length, ask(signal), session.id, signal)
  const jobs = ctx.get('jobs')
  if (jobs === undefined) {
    try {
      return { kind: 'success', text: renderConsolidation(await run(invocation.signal), all) }
    } catch (error) {
      return { kind: 'error', text: `Consolidation stopped: ${error instanceof Error ? error.message : String(error)}` }
    }
  }
  const controller = new AbortController()
  let id: string
  try {
    id = jobs.start({
      kind: 'learning-consolidate',
      label: `/learn consolidate${all ? ' --all' : ''}`,
      owner: invocation.agent.session.id,
      run: () => ({
        cancel: (reason) => { controller.abort(new Error(reason ?? 'consolidation cancelled')) },
        done: run(controller.signal).then(
          summary => ({ status: 'completed' as const, detail: `${summary.replaced} notes became ${summary.written}`, result: renderConsolidation(summary, all) }),
          (error: unknown) => ({
            status: controller.signal.aborted ? 'killed' as const : 'failed' as const,
            detail: 'stopped',
            result: `Consolidation stopped: ${error instanceof Error ? error.message : String(error)}`,
          }),
        ),
      }),
    })
  } catch (error) {
    return { kind: 'error', text: `Cannot start the consolidation as a background job: ${error instanceof Error ? error.message : String(error)}` }
  }
  return {
    kind: 'success',
    text: `Consolidating ${batch.length} group(s) of related notes as background job ${id}; the summary arrives as its job notice, and job_kill ${id} stops it after the current group.`,
  }
}

/** Totals reported by `/research-ingest`. */
interface ResearchIngestSummary {
  files: number
  chunks: number
  hypotheses: number
  results: number
  deadEnds: number
  skipped: readonly ImportSkip[]
}

/**
 * Run `/research-ingest <path> [--slug name]`: walk the path like `/learn from`,
 * ask the extraction route for hypotheses, results, and dead ends relevant to
 * the journal's objective, and file them into the journal with the source
 * file noted on each entry. Nothing reaches memory candidates.
 * @param ctx - plugin context.
 * @param config - plugin configuration.
 * @param request - the parsed arguments.
 * @param invocation - the command invocation (agent, cancellation).
 * @returns the command result with totals, or an error for a missing research plugin, journal, path, or route.
 */
async function ingestResearch(
  ctx: Context,
  config: Config,
  request: ResearchIngestRequest,
  invocation: CommandInvocation,
): Promise<CommandResult> {
  const research = ctx.get('research')
  if (research === undefined) return { kind: 'error', text: 'No research plugin is mounted; `/research-ingest` needs dsh-research.' }
  const session = invocation.agent.session
  const cwd = session.header.cwd ?? process.cwd()
  const store = research.storeFor(cwd)
  await store.whenReady()
  const slug = request.slug ?? research.activeFor(session.id)?.slug
  if (slug === undefined) return { kind: 'error', text: 'No research journal is active in this session; pass `--slug <name>` or start one with `/research`.' }
  const journal = store.get(slug)
  if (journal === undefined) return { kind: 'error', text: `No research journal "${slug}" in ${store.dir}.` }
  const route = auxiliaryRoute(config, session.requestHeader()?.config)
  if (route === undefined) {
    return { kind: 'error', text: 'No extraction route yet: send one message in this session first, or configure `provider` and `model` on dsh-learning.' }
  }
  const target = resolveImportPath(cwd, request.path)
  let walked: Awaited<ReturnType<typeof walkImportFiles>>
  try {
    walked = await walkImportFiles(target, {
      extensions: config.extensions ?? [],
      maxFileBytes: config.maxFileBytes ?? 262_144,
      maxFiles: config.maxFilesPerImport ?? 200,
      signal: invocation.signal,
    })
  } catch (error) {
    return { kind: 'error', text: `Cannot ingest ${request.path}: ${error instanceof Error ? error.message : String(error)}` }
  }
  const summary: ResearchIngestSummary = { files: 0, chunks: 0, hypotheses: 0, results: 0, deadEnds: 0, skipped: walked.skipped }
  const system = renderResearchIngestSystem(journal.objective, journal.criteria)
  try {
    for (const file of walked.files) {
      invocation.signal.throwIfAborted()
      const text = await readFile(file.path, 'utf8')
      const chunks = chunkText(text, config.maxTranscriptBytes)
      // Journal entries name the file relative to the workspace, not to the
      // ingested folder, so a reader can open it from the workspace root.
      const source = relative(cwd, file.path) || file.relative
      summary.files += 1
      for (const [index, chunk] of chunks.entries()) {
        invocation.signal.throwIfAborted()
        summary.chunks += 1
        const answer = await requestText(ctx, config, session, route, {
          system,
          prompt: `Source file: ${source}${chunks.length > 1 ? ` (part ${index + 1} of ${chunks.length})` : ''}\n\n${chunk}`,
          log: { turn: 0, source: { kind: 'research-import', slug, path: source, chunk: index + 1, chunks: chunks.length } },
          signal: invocation.signal,
        })
        const note = ` (source: ${source})`
        for (const finding of parseIngestFindings(answer, config.maxCandidatesPerTurn)) {
          switch (finding.kind) {
            case 'hypothesis':
              await store.addHypothesis(slug, `${finding.text}${note}`, 'auto')
              summary.hypotheses += 1
              break
            case 'result':
              await store.addExperiment(slug, `${finding.text}${note}`, finding.result ?? 'no result reported', 'auto')
              summary.results += 1
              break
            case 'dead_end':
              await store.addDeadEnd(slug, `${finding.text}${note}`, 'auto')
              summary.deadEnds += 1
              break
            default:
              assertNever(finding.kind, 'ingest finding kind')
          }
        }
      }
    }
  } catch (error) {
    if (invocation.signal.aborted) {
      return { kind: 'error', text: `Ingest cancelled after ${summary.chunks} chunk(s); ${summary.hypotheses + summary.results + summary.deadEnds} entries were filed.` }
    }
    return { kind: 'error', text: `Ingest failed after ${summary.chunks} chunk(s): ${error instanceof Error ? error.message : String(error)}` }
  }
  const lines = [
    `Ingested ${summary.files} file(s) in ${summary.chunks} chunk(s) into journal "${slug}": ${summary.hypotheses} hypothesis(es), ${summary.results} result(s), ${summary.deadEnds} dead end(s).`,
  ]
  if (summary.skipped.length > 0) lines.push(`Skipped ${summary.skipped.length}: ${summary.skipped.map(skip => `${skip.relative} (${skip.reason})`).join(', ')}`)
  return { kind: 'success', text: lines.join('\n') }
}

/** Bounded retries of the maintenance claim when the agent went busy again between idle and the claim. */
const MAINTENANCE_ATTEMPTS = 20

/**
 * Review a turn as a `learning-review` job owned by the agent when a job
 * registry is composed: the next turn is not held behind the review, the
 * agent's disposal cancels it, and the plugin waits on the job itself, which
 * marks it reported so no completion notice reaches the model. A killed or
 * disposed review records nothing; a failed one records its failure.
 * @param ctx - plugin context.
 * @param config - plugin configuration.
 * @param agent - the agent whose turn finished.
 * @param turn - the finished turn number.
 * @param events - the turn's events as observed live.
 * @param transcript - the turn's transcript from `reviewTranscript`.
 * @param controller - cancels the review; the next turn's start aborts it as superseded.
 * @param onSettled - called once the review has settled or yielded.
 * @param nextTurnStarted - whether the next turn started while the review waited to begin.
 * @returns whether the job path took the review, running it or yielding it; `false` leaves it to the maintenance path.
 */
function startReviewJob(
  ctx: Context,
  config: Config,
  agent: Agent,
  turn: number,
  events: readonly SessionEvent[],
  transcript: TurnTranscript,
  controller: AbortController,
  onSettled: () => void,
  nextTurnStarted: boolean,
): boolean {
  const jobs = ctx.get('jobs')
  if (jobs === undefined) return false
  // A job would run beside that turn and compete with it for the route, so the
  // review yields before it starts, as a running one does when the next turn starts.
  if (nextTurnStarted) {
    onSettled()
    return true
  }
  const session = agent.session
  const offDisposed = ctx.on('agent/disposed', ({ agent: disposed }) => {
    if (disposed === agent) controller.abort({ kind: 'disposed' })
  })
  try {
    const id = jobs.start({
      kind: 'learning-review',
      label: `learning review of turn ${turn}`,
      owner: agent.session.id,
      run: () => ({
        cancel: () => { controller.abort({ kind: 'disposed' }) },
        done: extractTurn(ctx, config, ctx.memory, agent, turn, events, transcript, controller.signal)
          .then(() => ({ status: 'completed' as const }), (error: unknown) => {
            const message = error instanceof Error ? error.message : String(error)
            if (controller.signal.aborted || isDisposalCancel(error)) {
              const reason: unknown = controller.signal.reason
              const superseded = typeof reason === 'object' && reason !== null && 'kind' in reason && reason.kind === 'superseded'
              return { status: 'killed' as const, detail: superseded ? 'review yielded to the next turn' : 'review cancelled' }
            }
            ctx.logger.warn(`learning: extraction failed for turn ${turn} of "${session.id}": ${message}`)
            recordFailedReview(session, turn, error, message)
            return { status: 'failed' as const, detail: message }
          })
          .finally(() => { offDisposed(); onSettled() }),
      }),
    })
    // A pending wait makes the settlement `awaited`, so tool-jobs sends no notice.
    void jobs.wait(id, MAX_TIMER_DELAY_MS, agent.session.id).catch(() => undefined)
    return true
  } catch (error) {
    offDisposed()
    ctx.logger.warn(`learning: review job could not start (${error instanceof Error ? error.message : String(error)}); reviewing in maintenance`)
    return false
  }
}
/** Pause between those retries, in milliseconds. */
const MAINTENANCE_RETRY_MS = 50

/**
 * Install the turn-end extractor and the `/learn` command.
 * @param ctx - plugin context carrying `memory`, `llm`, `commands`, `agents`, and `sessions`.
 * @param config - deployment configuration.
 */
export function apply(ctx: Context, config: Config): void {
  if ((config.provider === undefined) !== (config.model === undefined)) {
    throw new Error('learning: provider and model must be configured together')
  }
  const skillsRoot = config.skillsRoot ?? dshHomePath('skills')
  const roots: LearningRoots = { skills: skillsRoot, drafts: config.skillDraftsRoot ?? dshHomePath('skill-drafts') }
  const reviewed = new Map<SessionId, number>()
  // Events are observed live, per session, from `turn/start` to `turn/end`,
  // so the review never reads Session history synchronously.
  const buffered = new Map<SessionId, SessionEvent[]>()
  /** The review in flight per session; the next turn's start cancels it so it never holds the route. */
  const reviewing = new Map<SessionId, AbortController>()
  /** Settlement of each session's latest turn review, from that turn's end until the review settles. */
  const pending = new Map<SessionId, Promise<void>>()
  ctx.on('session/event', (session, event) => {
    if (config.reviewTurns === false) return
    if (event.type === 'turn/start') {
      reviewing.get(session.id)?.abort({ kind: 'superseded' })
      buffered.set(session.id, [event])
      return
    }
    const events = buffered.get(session.id)
    if (events === undefined) return
    events.push(event)
    if (event.type !== 'turn/end') return
    buffered.delete(session.id)
    const agent = ctx.agents.get(session.id)
    if (agent === undefined || reviewed.get(session.id) === event.data.turn) return
    reviewed.set(session.id, event.data.turn)
    const turn = event.data.turn
    // A turn that gets no review starts no job and claims no maintenance. A
    // subagent child gets none: its activation disposes it as soon as the turn
    // ends, which would cancel the review after its request was sent.
    if (session.header.origin === 'subagent') return
    const transcript = reviewTranscript(config, events, turn)
    if (transcript === undefined) return
    const controller = new AbortController()
    const settle = (): void => {
      if (reviewing.get(session.id) === controller) reviewing.delete(session.id)
    }
    controller.signal.addEventListener('abort', settle, { once: true })
    // Pending from this `turn/end`, before the job starts, so a host that
    // exits after the turn can wait for the review instead of cancelling it.
    const finished = Promise.withResolvers<void>()
    pending.set(session.id, finished.promise)
    const done = (): void => {
      if (pending.get(session.id) === finished.promise) pending.delete(session.id)
      finished.resolve()
    }
    void (async () => {
      // The review appends its own log events, so it starts after the
      // `turn/end` append that triggered it has finished publishing.
      await new Promise(resolve => setTimeout(resolve, 0))
      // Only a review running as a background job overlaps the conversation,
      // so only it yields when the next turn starts; a maintenance review
      // cannot overlap a turn and waits for the next idle instead.
      reviewing.set(session.id, controller)
      if (startReviewJob(ctx, config, agent, turn, events, transcript, controller, () => { settle(); done() }, buffered.has(session.id))) {
        return
      }
      settle()
      // A goal-driven session goes busy again right after idle, so the
      // maintenance claim can lose the race; wait for the next idle and retry
      // a bounded number of times before giving the turn up.
      try {
        for (let attempt = 1; attempt <= MAINTENANCE_ATTEMPTS; attempt += 1) {
          await agent.whenIdle()
          if (controller.signal.aborted) return
          try {
            await agent.runMaintenance(signal => extractTurn(
              ctx, config, ctx.memory, agent, turn, events, transcript, AbortSignal.any([signal, controller.signal]),
            ))
            return
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            if (message.includes('already has active work') && attempt < MAINTENANCE_ATTEMPTS) {
              await new Promise(resolve => setTimeout(resolve, MAINTENANCE_RETRY_MS))
              continue
            }
            ctx.logger.warn(`learning: extraction skipped for turn ${turn} of "${session.id}": ${message}`)
            // A review the Agent's disposal cancelled never ran; the request event already says one was started.
            if (!isDisposalCancel(error)) recordFailedReview(session, turn, error, message)
            return
          }
        }
      } finally {
        settle()
        done()
      }
    })()
  })
  ctx.provide('learning', {
    settled: sessionId => pending.get(sessionId) ?? Promise.resolve(),
    promote: (id, name) => promoteEntry(ctx, ctx.memory, skillsRoot, id, name),
    promoteMany: (ids, name) => promoteEntries(ctx, ctx.memory, skillsRoot, ids, name),
    skills: () => listSkills(skillsRoot),
    readSkill: name => readSkill(skillsRoot, name),
    writeSkill: (name, content) => writeSkill(ctx, skillsRoot, name, content),
    deleteSkill: name => deleteSkill(ctx, skillsRoot, name),
  })
  ctx.effect(() => ctx.commands.register({
    name: 'research-ingest',
    description: 'Read a file or folder of papers, notes, or code into the active research journal as hypotheses, results, and dead ends',
    input: { hint: '<path> [--slug name]' },
    handler: (invocation) => {
      const request = parseResearchIngestInput(invocation.rawInput)
      return request === undefined
        ? Promise.resolve({ kind: 'error', text: 'Usage: /research-ingest <path> [--slug name]' } satisfies CommandResult)
        : ingestResearch(ctx, config, request, invocation)
    },
  }))
  // Cross-goal bridge: a breakthrough recorded in any journal of a live
  // session's workspace becomes an approved memory, so other journals and
  // ordinary sessions recall it. The change carries the research directory;
  // the store owning it is found through the live sessions' workspaces.
  ctx.on('research/change', ({ dir, slug }) => {
    const research = ctx.get('research')
    if (research === undefined) return
    for (const agent of ctx.agents.list()) {
      const cwd = agent.session.header.cwd
      if (cwd === undefined) continue
      const store = research.storeFor(cwd)
      if (store.dir !== dir) continue
      const journal = store.get(slug)
      if (journal === undefined || journal.breakthroughs.length === 0) return
      void mirrorBreakthroughs(ctx.memory, journal).catch((error: unknown) => {
        ctx.logger.warn(`learning: breakthrough bridge failed for "${slug}": ${error instanceof Error ? error.message : String(error)}`)
      })
      return
    }
  })
  ctx.effect(() => ctx.commands.register({
    name: 'digest',
    description: 'Read a file or folder of knowledge and keep what it holds: procedures as skills, facts and rules as memory entries, or both',
    input: { hint: '<path> [--tags a,b]' },
    handler: (invocation) => {
      const request = parseDigestInput(invocation.rawInput)
      if (request === undefined) return Promise.resolve({ kind: 'error' as const, text: 'Usage: /digest <path> [--tags a,b]' })
      return importPath(ctx, config, ctx.memory, roots, request, invocation)
    },
  }))
  ctx.effect(() => ctx.commands.register({
    name: 'learn',
    description: 'Review learned-memory candidates, promote entries or a suggested cluster to a skill, or import a file or folder of knowledge',
    input: { hint: '[approve <id> | reject <id> | skill <id> <name> | accept <suggestion> [name] | dismiss <suggestion> | from <path> [--tags a,b] | consolidate [--all]]' },
    handler: invocation => executeLearnCommand(
      ctx, ctx.memory, roots, invocation,
      request => importPath(ctx, config, ctx.memory, roots, request, invocation),
      all => consolidateMemory(ctx, config, ctx.memory, all, invocation),
    ),
  }))
}
