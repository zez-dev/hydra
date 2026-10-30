/**
 * Research goals with a discovery journal. `/research <objective>` creates or
 * resumes a per-slug journal file in the workspace and a durable goal whose
 * rounds follow a research loop; the `journal` and `run_experiment` tools of
 * the `./tools` entry record breakthroughs, hypotheses, experiments, and dead
 * ends the moment they happen; and the journal digest is re-injected into
 * every request as one digest-stable `user/message`, so a compacted context
 * or a new session starts from the current state instead of a re-pasted
 * prompt. Named exports preserve Loader injection metadata.
 * @module @deepseek-ai/dsh-research
 */

import { isAbsolute, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { auxiliaryRoute, createUserMessage, lowestReasoningEffort, streamText } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session, SessionId, UserMessage } from '@deepseek-ai/dsh-session'
import { deadline } from '@deepseek-ai/dsh-timeout'
// Type-only: resolves the `ctx.goals` service and the optional `ctx.notify` service.
import type {} from '@deepseek-ai/dsh-goal'
import type {} from '@deepseek-ai/dsh-notify'
import { FolderJournalStore, slugify } from './journal.ts'
import { parseResearchInput, renderResearchInstruction, researchObjective, researchSlugOf } from './instruction.ts'
import { createRecallMessage, digestRecall, isRecallMessage, recallText, renderJournalRecall, RESEARCH_SOURCE_KIND } from './recall.ts'
import { relatedBreakthroughs } from './bridge.ts'
// Type-only: resolves the optional `ctx.memory` service declaration.
import type {} from '@deepseek-ai/dsh-memory'
import { parseScores, renderScoringRequest, SCORING_SYSTEM_PROMPT } from './scoring.ts'
import type { ActiveResearch, Journal, JournalEntrySource, JournalStore, ResearchFinding, ResearchService, ResearchScoreEventData } from './types.ts'

export type * from './types.ts'
export { FolderJournalStore, JOURNAL_FILE, parseJournalFile, renderJournalFile, slugify } from './journal.ts'
export { parseResearchInput, renderResearchInstruction, RESEARCH_PREFIX, researchObjective, researchSlugOf } from './instruction.ts'
export type { ResearchInput } from './instruction.ts'
export { createRecallMessage, digestRecall, isRecallMessage, recallText, renderJournalRecall, RESEARCH_SOURCE_KIND } from './recall.ts'
export { BREAKTHROUGH_TAG, mirrorBreakthroughs, normalizeBreakthrough, relatedBreakthroughs, researchTag, RESEARCH_TAG_PREFIX } from './bridge.ts'
export type { BridgeMemory, BridgeMemoryEntry } from './bridge.ts'
export type { RecallOptions } from './recall.ts'
export { extractMetrics, metricDeltas, previousExperiment, renderExperimentResult, truncateOutput } from './experiment.ts'
export type { ExperimentOutcome, MetricSpec } from './experiment.ts'
export { parseScores, renderScoringRequest, SCORING_SYSTEM_PROMPT } from './scoring.ts'
export type { HypothesisScore } from './scoring.ts'

/** Error code of a scoring request that outlived `scoring.timeoutMs`. */
export const RESEARCH_SCORE_TIMEOUT_CODE = 'RESEARCH_SCORE_TIMEOUT'

export const name = 'research'
export const inject = ['goals', 'commands', 'agents', 'sessions']

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Research journals and the session-to-research binding; provided by `dsh-research`. */
    research: ResearchService
  }
  interface Events {
    /**
     * One journal file was written by this process or changed on disk.
     * @param payload.dir - absolute research directory.
     * @param payload.slug - the journal slug.
     * @mode emit
     */
    'research/change'(payload: { dir: string; slug: string }): void
  }
}

/** Hypothesis scoring configuration. */
export interface ScoringConfig {
  /** Whether an auxiliary request re-ranks open hypotheses after each experiment. */
  enabled: boolean
  /** Output cap of each scoring request; a route that cannot turn thinking off spends part of it on reasoning. */
  maxOutputTokens: number
  /** Deadline of one scoring request in milliseconds. */
  timeoutMs: number
  /** Provider of the scoring route; absent with `model` absent reuses the session's route. */
  provider?: string
  /** Model of the scoring route. */
  model?: string
}

/** Research plugin configuration. */
export interface Config {
  /** Research directory; a relative path resolves against each session's workspace directory. */
  dir: string
  /** Byte cap on the `<research_journal>` block injected into a request. */
  maxRecallBytes: number
  /** How many most-recent experiments the block lists. */
  recentExperiments: number
  /** How many breakthroughs of other journals the recall block lists (schema default 5; `0` disables). */
  relatedBreakthroughs?: number
  /** Hypothesis scoring after each recorded experiment. */
  scoring: ScoringConfig
  /** Upper bound on a `run_experiment` timeout in milliseconds; a larger request is capped. */
  maxExperimentMs: number
  /** Byte cap on the output a `run_experiment` call records and returns. */
  maxOutputBytes: number
}

/** Schemastery configuration schema. */
export const Config: z<Config> = z.object({
  dir: z.string().required(),
  maxRecallBytes: z.natural().min(1).required(),
  recentExperiments: z.natural().required(),
  relatedBreakthroughs: z.natural().default(5),
  scoring: z.object({
    enabled: z.boolean().required(),
    maxOutputTokens: z.natural().min(1).required(),
    timeoutMs: z.natural().min(1).required(),
    provider: z.string(),
    model: z.string(),
  }).required(),
  maxExperimentMs: z.natural().min(1).required(),
  maxOutputBytes: z.natural().min(1).required(),
})

const USAGE = 'Usage: /research <objective> [--criteria "a; b"] [--slug name] | /research list | /research continue [name]'
  + ' | /research status | /research pause | /research resume'

/** Source kinds of the messages that start work: the user's, a goal round's, a webhook's, a scheduled follow-up's. */
const WORK_SOURCE_KINDS: ReadonlySet<string> = new Set(['user', 'goal', 'webhook', 'schedule'])

/** What a session without research is told; a journal from another session continues with `/research continue`. */
const NO_RESEARCH = 'No research goal in this session. /research continue <name> picks up a journal in this workspace'
  + ' (/research list shows them); /research <objective> starts a new one.'

/** The message for a session without a working directory. */
const NO_WORKSPACE = 'This session has no workspace directory for a research journal.'

/* jscpd:ignore-start -- mirrors dsh-memory's recallHistory. The synchronous Session read deprecation
   (.agents/notes/implemented/architecture/2026-09-09-deprecate-synchronous-session-event-reads.md) prohibits
   a shared wrapper, so each plugin keeps its waived read until it migrates to projected state. */
/**
 * Find the digest of the recall message currently visible in the agent's
 * model-visible surface.
 * @param agent - the stepping agent.
 * @returns the visible digest when a recall is on the surface.
 */
function recallHistory(agent: Agent): { visibleDigest?: string } {
  const visible = new Set(agent.session.surface.nodes)
  for (let index = agent.session.seq - 1; index >= 0; index -= 1) {
    // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
    const event = agent.session.eventAt(SessionSeq(index))
    if (event === undefined) break
    if (event.type !== 'user/message' || !isRecallMessage(event.data)) continue
    if (visible.has(event.seq)) return { visibleDigest: digestRecall(recallText(event.data)) }
    return {}
  }
  return {}
}
/* jscpd:ignore-end */

/**
 * Publish `ctx.research`, `/research`, the recall injection, and the round
 * instruction.
 * @param ctx - plugin context carrying `goals`, `commands`, `agents`, and `sessions`;
 *   `notify` is used when mounted.
 * @param config - deployment configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const stores = new Map<string, FolderJournalStore>()

  function storeFor(cwd: string): JournalStore {
    const dir = isAbsolute(config.dir) ? config.dir : resolve(cwd, config.dir)
    let store = stores.get(dir)
    if (store === undefined) {
      store = new FolderJournalStore(dir)
      stores.set(dir, store)
      store.onChange((slug) => { ctx.emit('research/change', { dir, slug }) })
      void store.open().catch((error: unknown) => {
        ctx.logger.warn(`research: could not open ${dir}: ${error instanceof Error ? error.message : String(error)}`)
      })
    }
    return store
  }
  ctx.effect(() => () => {
    for (const store of stores.values()) void store.close()
    stores.clear()
  })

  function activeFor(sessionId: SessionId): ActiveResearch | undefined {
    const agent = ctx.agents.get(sessionId)
    if (agent === undefined) return undefined
    const cwd = agent.session.header.cwd
    const goal = ctx.goals.get(agent)
    if (cwd === undefined || goal === undefined || goal.phase === 'complete') return undefined
    const slug = researchSlugOf(goal.objective)
    return slug === undefined ? undefined : { slug, cwd }
  }

  function announceBreakthrough(journal: Journal, text: string): void {
    const notify = ctx.get('notify')
    if (notify === undefined) return
    void notify.send({ event: 'researchBreakthrough', title: `Breakthrough: ${journal.objective}`, text: `${text}\n(journal "${journal.slug}")` })
      .catch((error: unknown) => { ctx.logger.warn(`research: notify failed: ${error instanceof Error ? error.message : String(error)}`) })
  }

  async function record(finding: ResearchFinding, source: JournalEntrySource): Promise<void> {
    const store = storeFor(finding.cwd)
    await store.whenReady()
    const journal = store.get(finding.slug)
    if (journal === undefined) throw new Error(`no research journal "${finding.slug}" in ${store.dir}`)
    switch (finding.kind) {
      case 'breakthrough':
        await store.addBreakthrough(finding.slug, finding.text, source)
        announceBreakthrough(journal, finding.text)
        return
      case 'result':
        await store.addExperiment(finding.slug, finding.text, finding.result ?? 'no result recorded', source)
        return
      case 'dead_end':
        await store.addDeadEnd(finding.slug, finding.text, source)
        return
      default:
        throw new Error(`research: unknown finding kind ${(finding as { kind: string }).kind}`)
    }
  }

  /**
   * Re-rank the journal's open hypotheses with a logged scoring request at the
   * route's lowest selectable reasoning effort, so a thinking route spends the
   * output cap on the scores, asked once more at the route's default effort
   * when that answer has no text. Failures and unreadable answers are logged
   * and leave scores untouched.
   */
  async function scoreHypotheses(store: JournalStore, slug: string, session: Session, signal: AbortSignal): Promise<void> {
    if (!config.scoring.enabled) return
    const journal = store.get(slug)
    if (journal === undefined || !journal.hypotheses.some(entry => entry.status === 'open')) return
    const llm = ctx.get('llm')
    if (llm === undefined) {
      ctx.logger.warn('research: scoring skipped: no llm service is mounted')
      return
    }
    const route = auxiliaryRoute(config.scoring, session.requestHeader()?.config)
    if (route === undefined) {
      ctx.logger.warn('research: scoring skipped: no route; configure scoring.provider and scoring.model or log a request first')
      return
    }
    const messages: Message[] = [createUserMessage({
      content: [{ type: 'text', text: renderScoringRequest(journal) }],
      source: { kind: RESEARCH_SOURCE_KIND },
    })]
    const ask = async (lowerEffort: boolean): Promise<{ text: string; lowered: boolean }> => {
      using callDeadline = deadline(signal, config.scoring.timeoutMs, RESEARCH_SCORE_TIMEOUT_CODE)
      // The effort is a preference: a route that cannot be resolved fails loud in the request itself.
      const reasoningEffort = lowerEffort
        ? await llm.resolveModelInfo(route.provider, route.model, callDeadline.signal)
          .then(info => lowestReasoningEffort(info), (_unresolvedRoute: unknown) => undefined)
        : undefined
      const logged: ResearchScoreEventData = {
        slug, route, system: SCORING_SYSTEM_PROMPT, messages, maxTokens: config.scoring.maxOutputTokens,
        ...reasoningEffort === undefined ? {} : { reasoningEffort },
      }
      session.append('session/research-score', logged, { ignorable: true })
      const options: GenerateOptions = {
        provider: route.provider,
        model: route.model,
        messages,
        system: SCORING_SYSTEM_PROMPT,
        maxTokens: config.scoring.maxOutputTokens,
        ...reasoningEffort === undefined ? {} : { reasoningEffort },
        sessionId: session.id,
        purpose: 'research-score',
        signal: callDeadline.signal,
      }
      const text = await streamText(llm.stream(options), callDeadline.signal, {
        maxTokens: () => new Error('scoring output reached maxOutputTokens'),
        toolCalls: () => new Error('scoring model unexpectedly requested a tool'),
      })
      return { text, lowered: reasoningEffort !== undefined }
    }
    try {
      const answer = await ask(true)
      // Some servers file a reply asked not to think entirely as reasoning; the route's default effort keeps it in the text.
      const text = answer.lowered && answer.text.trim().length === 0 ? (await ask(false)).text : answer.text
      const scores = parseScores(text)
      if (scores === undefined) {
        ctx.logger.warn(`research: scoring answer for "${slug}" was not a JSON array; scores unchanged`)
        return
      }
      const known = new Set(journal.hypotheses.map(entry => entry.id))
      for (const item of scores) {
        if (known.has(item.hypothesisId)) await store.setHypothesisScore(slug, item.hypothesisId, item.score, item.reason)
      }
    } catch (error) {
      ctx.logger.warn(`research: scoring failed for "${slug}": ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const service: ResearchService = {
    dir: config.dir,
    storeFor, activeFor, record, announceBreakthrough, scoreHypotheses,
    experimentLimits: { maxExperimentMs: config.maxExperimentMs, maxOutputBytes: config.maxOutputBytes },
  }
  ctx.provide('research', service)

  /**
   * The journal store of the session's workspace, ready to read.
   * @param agent - the session's agent.
   * @returns the store, or `undefined` when the session has no working directory.
   */
  async function workspaceStore(agent: Agent): Promise<JournalStore | undefined> {
    const cwd = agent.session.header.cwd
    if (cwd === undefined) return undefined
    const store = storeFor(cwd)
    await store.whenReady()
    return store
  }

  /**
   * Render the workspace's journals, newest first.
   * @param store - the workspace's journal store.
   * @param journals - its journals.
   * @returns one line per journal and how to continue one.
   */
  function renderJournals(store: JournalStore, journals: readonly Journal[]): string {
    if (journals.length === 0) return `No research journals in ${store.dir} yet. /research <objective> starts one.`
    const newest = [...journals].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.slug.localeCompare(right.slug))
    return [
      `Research journals in ${store.dir}, newest first:`,
      ...newest.map(journal => `  ${journal.slug} [${journal.status}] ${journal.objective}: ${journal.breakthroughs.length} breakthrough(s), `
        + `${journal.hypotheses.filter(entry => entry.status === 'open').length} open hypothesis(es), ${journal.experiments.length} experiment(s); `
        + `updated ${journal.updatedAt}`),
      '/research continue <name> picks one up in this session.',
    ].join('\n')
  }

  /**
   * Bind an existing journal of this workspace to the session: the named one,
   * the only one when no name is given, or a listing to choose from.
   * @param agent - the session's agent.
   * @param requested - the journal name, when given.
   * @returns the resumed research, the listing, or why nothing was continued.
   */
  async function continueResearch(agent: Agent, requested: string | undefined): Promise<CommandResult> {
    const store = await workspaceStore(agent)
    if (store === undefined) return { kind: 'error', text: NO_WORKSPACE }
    const journals = store.list()
    const [only, ...others] = journals
    const slug = requested !== undefined ? slugify(requested) : only !== undefined && others.length === 0 ? only.slug : undefined
    if (slug === undefined) return { kind: 'success', text: renderJournals(store, journals) }
    const journal = store.get(slug)
    if (journal === undefined) {
      const known = journals.map(entry => entry.slug).sort()
      return {
        kind: 'error',
        text: `No research journal "${slug}" in ${store.dir}.${known.length === 0
          ? ' This workspace has none yet; /research <objective> starts one.'
          : ` Journals here: ${known.join(', ')}.`}`,
      }
    }
    return startResearch(agent, journal.objective, [], slug)
  }

  async function startResearch(
    agent: Agent, objective: string, criteria: readonly string[], requestedSlug: string | undefined,
  ): Promise<CommandResult> {
    const store = await workspaceStore(agent)
    if (store === undefined) return { kind: 'error', text: NO_WORKSPACE }
    const slug = requestedSlug === undefined ? slugify(objective) : slugify(requestedSlug)
    const current = ctx.goals.get(agent)
    if (current !== undefined && current.phase !== 'complete' && researchSlugOf(current.objective) !== slug) {
      return { kind: 'error', text: `This session already has a ${current.phase} goal: ${current.objective}. Use /goal clear first.` }
    }
    let journal = store.get(slug)
    const resumed = journal !== undefined
    if (journal === undefined) {
      journal = await store.create({ slug, objective, criteria })
    } else if (journal.status !== 'active') {
      journal = await store.setStatus(slug, 'active')
    }
    await store.attachSession(slug, agent.id)
    if (current !== undefined && current.phase !== 'complete') {
      if (current.phase !== 'active') ctx.goals.resume(agent, { id: current.id, revision: current.revision })
    } else {
      ctx.goals.create(agent, { objective: researchObjective(slug, journal.objective) })
    }
    const summary = `${journal.breakthroughs.length} breakthrough(s), ${journal.hypotheses.filter(entry => entry.status === 'open').length} open hypothesis(es), ${journal.nextSteps.length} next step(s)`
    return {
      kind: 'success',
      text: resumed
        ? `Resumed research "${slug}" (${summary}): ${journal.objective}. Rounds continue from the journal's next steps; /goal resume re-arms it after a restart.`
        : `Started research "${slug}": ${journal.objective}. Journal: ${store.dir}/${slug}/journal.md. Rounds run until every criterion holds; /research pause stops them and /research resume continues.`,
    }
  }

  async function executeResearch(invocation: CommandInvocation): Promise<CommandResult> {
    const { agent } = invocation
    const input = parseResearchInput(invocation.rawInput)
    if (input.kind === 'usage') return { kind: 'error', text: USAGE }
    if (input.kind === 'start') return startResearch(agent, input.objective, input.criteria, input.slug)
    if (input.kind === 'continue') return continueResearch(agent, input.slug)
    if (input.kind === 'list') {
      const store = await workspaceStore(agent)
      return store === undefined ? { kind: 'error', text: NO_WORKSPACE } : { kind: 'success', text: renderJournals(store, store.list()) }
    }
    const active = activeFor(agent.id)
    const goal = ctx.goals.get(agent)
    if (active === undefined || goal === undefined) return { kind: 'success', text: NO_RESEARCH }
    const store = storeFor(active.cwd)
    await store.whenReady()
    const journal = store.get(active.slug)
    switch (input.kind) {
      case 'status':
        return {
          kind: 'success',
          text: journal === undefined
            ? `Research "${active.slug}" has no journal file under ${store.dir}.`
            : [
              `Research "${journal.slug}": ${journal.objective}`,
              `Journal: ${journal.status}, ${store.dir}/${journal.slug}/journal.md`,
              `Goal: ${goal.phase} (${goal.roundsStarted} rounds)`,
              `Breakthroughs: ${journal.breakthroughs.length}; open hypotheses: ${journal.hypotheses.filter(entry => entry.status === 'open').length}; experiments: ${journal.experiments.length}; dead ends: ${journal.deadEnds.length}`,
              `Next: ${journal.nextSteps[0] ?? '(none recorded)'}`,
            ].join('\n'),
        }
      case 'pause':
        if (goal.phase === 'active') ctx.goals.pause(agent, { id: goal.id, revision: goal.revision })
        await store.setStatus(active.slug, 'paused')
        return { kind: 'success', text: `Research "${active.slug}" paused; /research resume continues it.` }
      case 'resume':
        if (goal.phase !== 'active') ctx.goals.resume(agent, { id: goal.id, revision: goal.revision })
        await store.setStatus(active.slug, 'active')
        return { kind: 'success', text: `Research "${active.slug}" resumed.` }
      default:
        return { kind: 'error', text: USAGE }
    }
  }

  ctx.effect(() => ctx.commands.register({
    name: 'research',
    description: 'Start or resume a research goal with a discovery journal that survives sessions and compaction',
    input: { hint: '<objective> [--criteria "a; b"] [--slug name] | status | pause | resume' },
    handler: executeResearch,
  }))

  // A step that starts work (the user's message, a goal round) and any step
  // while no digest is in view (as after a compaction) sees the current journal
  // digest; within a turn the model sees its own journal changes in the results
  // of the tool calls that made them. Every goal round also gets the research
  // instruction after the driver's own round message.
  ctx.on('agent/pre-step', async ({ agent, signal }, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    const active = activeFor(agent.id)
    const pending = decision.messages.find(isRecallMessage)
    const withoutPending = (): UserMessage[] => decision.messages.filter(message => message !== pending)
    if (active === undefined) return pending === undefined ? decision : { ...decision, messages: withoutPending() }
    const store = storeFor(active.cwd)
    await store.whenReady()
    signal.throwIfAborted()
    const journal = store.get(active.slug)
    if (journal === undefined) return pending === undefined ? decision : { ...decision, messages: withoutPending() }
    const text = renderJournalRecall(journal, {
      maxRecallBytes: config.maxRecallBytes,
      recentExperiments: config.recentExperiments,
      related: relatedBreakthroughs(ctx.get('memory'), active.slug, config.relatedBreakthroughs ?? 5),
    })
    const digest = digestRecall(text)
    const visible = recallHistory(agent).visibleDigest
    const startsWork = decision.messages.some(message => WORK_SOURCE_KINDS.has(message.source.kind))
    let messages = decision.messages
    if (visible === digest || (visible !== undefined && !startsWork)) {
      messages = pending === undefined ? messages : withoutPending()
    } else if (pending === undefined || digestRecall(recallText(pending)) !== digest) {
      const recall = createRecallMessage(text)
      messages = pending === undefined ? [...messages, recall] : messages.map(message => message === pending ? recall : message)
    }
    const round = messages.find(message => message.source.kind === 'goal')
    const goal = ctx.goals.get(agent)
    if (round !== undefined && goal !== undefined && goal.phase === 'active') {
      messages = [...messages, createUserMessage({
        content: [{ type: 'text', text: renderResearchInstruction(journal) }],
        source: { kind: RESEARCH_SOURCE_KIND },
      })]
    }
    return messages === decision.messages ? decision : { ...decision, messages }
  })
}
