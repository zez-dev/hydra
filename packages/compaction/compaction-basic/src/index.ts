/**
 * Basic replay-aware compaction backend.
 *
 * @module @deepseek-ai/dsh-compaction-basic
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { CompactionEngine, ManualCompactionError } from '@deepseek-ai/dsh-compaction'
import type { CompactionResult, CompactionTrigger } from '@deepseek-ai/dsh-compaction'
import type { EpochHeader, Session, SessionSeq } from '@deepseek-ai/dsh-session'
import { CONTEXT_WINDOW_EXCEEDED_CODE, LlmError, createSystemMessage, createUserMessage, messageText } from '@deepseek-ai/dsh-llm'
import { lastAssistantStreamChunk } from '@deepseek-ai/dsh-llm/assistant-stream'
import type { LlmCallConfig, LlmModelContext, ToolSchema } from '@deepseek-ai/dsh-llm'
import type { TokenMeasurement } from '@deepseek-ai/dsh-token-meter'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { SessionEventMap } from '@deepseek-ai/dsh-session/types'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { CommandId } from '@deepseek-ai/dsh-commands/brand'
// Type-only: makes the optional sibling service available to `ctx.get()`.
import type {} from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import {
  fitThresholdTokens,
  resolveCompactSpec,
  resolveConfig,
  resolveTargetPolicy,
  TargetPressureConfigError,
} from './config.ts'
import {
  assertNoActiveCompaction,
  compactSurfaceRegion,
  createCheckpointMessage,
  selectCompactableRange,
  SummaryNotSmallerError,
} from './region.ts'
import { COMPACTION_INSTRUCTION, SUMMARY_EMPTY_CODE, summarizeWithLlm } from './summarizer.ts'
import type { SummarizationInput, SummaryResult } from './summarizer.ts'
import type {
  BasicCompactionConfig,
  ModelCompactPolicyConfig,
  ResolvedCompactSpec,
  ResolvedConfig,
  ResolvedTargetPolicy,
} from './types.ts'

export type {
  BasicCompactionConfig,
  CompactionPolicyConfig,
  ModelCompactPolicyConfig,
  ResolvedCompactSpec,
  ResolvedConfig,
  ResolvedRetention,
  ResolvedTargetPolicy,
} from './types.ts'

/** Raises a cut checkpoint's cap may get before the failure is reported. */
const SUMMARY_RAISES = 3
/** Failed summarization attempts one compaction may follow with another range before the failure is reported. */
const SUMMARY_RETRIES = 4

/** Learned density sits this far above the bound a refusal proves, so the next request is under it, not at it. */
const REFUSAL_HEADROOM = 1.02
/** A range grown for a checkpoint of a known size reaches this many times that size, so the replacement is a real reduction. */
const GROWN_RANGE_FACTOR = 1.5
/** The output floor sits this far above the most reasoning a step of the session has spent, so the next step can think and still answer. */
const REASONING_HEADROOM = 1.25

/** Route key for facts learned about a provider's counting. */
function routeKey(target: Pick<LlmCallConfig, 'provider' | 'model'>): string {
  return `${target.provider}/${target.model}`
}

/**
 * Surface position of the node with seq `seq`. A checkpoint's seq is newer
 * than the nodes it precedes, so seq order says nothing about position.
 * @param measurement - current surface measurement.
 * @param seq - the seq of a node on the measured surface.
 * @returns the index into the measured nodes.
 */
function positionOf(measurement: TokenMeasurement, seq: SessionSeq): number {
  return measurement.nodes.findIndex(node => node.seq === seq)
}

/**
 * Heuristic tokens of the surface nodes from the first through the node at `end`.
 * @param measurement - current surface measurement.
 * @param end - the last node counted.
 * @returns the summed tokens.
 */
function tokensThrough(measurement: TokenMeasurement, end: SessionSeq): number {
  return sumTokens(measurement.nodes.slice(0, positionOf(measurement, end) + 1))
}

/** Summed measured tokens of `nodes`. */
function sumTokens(nodes: TokenMeasurement['nodes']): number {
  return nodes.reduce((sum, node) => sum + node.tokens, 0)
}

/**
 * Heuristic tokens from the latest assistant message to the end of the surface:
 * the step a summary leaves in place, with the results the model has not read yet.
 * @param session - the agent-owned session.
 * @param measurement - current surface measurement.
 * @returns the summed tokens of that step, or of every node when no assistant message exists.
 */
function latestStepTokens(session: Session, measurement: TokenMeasurement): number {
  const nodes = measurement.nodes
  let start = nodes.length - 1
  // Surface nodes are current log seqs, so the events exist.
  // Existing Session history read; migration deferred.
  // oxlint-disable-next-line typescript/no-non-null-assertion, typescript/no-deprecated
  while (start > 0 && session.eventAt(nodes[start]!.seq)!.type !== 'assistant/message') start -= 1
  return sumTokens(nodes.slice(Math.max(start, 0)))
}

/**
 * Heuristic tokens of the surface nodes from `start` through `end`.
 * @param measurement - current surface measurement.
 * @param start - the range's first node.
 * @param end - the range's last node.
 * @returns the summed tokens.
 */
function rangeTokens(measurement: TokenMeasurement, start: SessionSeq, end: SessionSeq): number {
  return sumTokens(measurement.nodes.slice(positionOf(measurement, start), positionOf(measurement, end) + 1))
}

/**
 * The retention that grows the range past `end` until it holds at least
 * `minTokens` (at least the next node), so a checkpoint of a known size has
 * a range worth replacing. A selected range always leaves the surface's last
 * node out, so a next node exists.
 * @param measurement - current surface measurement.
 * @param start - the range's first node.
 * @param end - the range's last node.
 * @param minTokens - tokens the grown range must reach.
 * @param retain - the current retention.
 * @returns the smaller retention, or `undefined` when it would not shrink the retention.
 */
function grownRetain(
  measurement: TokenMeasurement,
  start: SessionSeq,
  end: SessionSeq,
  minTokens: number,
  retain: number,
): number | undefined {
  const from = positionOf(measurement, start)
  let through = positionOf(measurement, end) + 1
  while (through + 1 < measurement.nodes.length && sumTokens(measurement.nodes.slice(from, through + 1)) < minTokens) through += 1
  const grown = sumTokens(measurement.nodes.slice(through + 1))
  return grown >= retain ? undefined : grown
}

/**
 * Half the measured tokens of the surface nodes from `start` through `end`,
 * at least one, so a refused range's retry leaves about half of it out.
 * @param measurement - current surface measurement.
 * @param start - the range's first node.
 * @param end - the range's last node.
 * @returns the retention to add for the retry.
 */
function halfOfRange(measurement: TokenMeasurement, start: SessionSeq, end: SessionSeq): number {
  return Math.max(1, Math.ceil(rangeTokens(measurement, start, end) / 2))
}

/**
 * Whether `error`, or a failure it wraps as its cause, carries `code`.
 * @param error - the failure to inspect.
 * @param code - the machine code looked for.
 * @returns `true` when the code is on the error or on any cause under it.
 */
function causeChainHas(error: unknown, code: string): boolean {
  for (let current = error; typeof current === 'object' && current !== null; current = (current as { cause?: unknown }).cause) {
    if ('code' in current && current.code === code) return true
  }
  return false
}

/** Whether a summarization failure is the provider refusing the request as over its window. */
function isProviderOverflow(error: unknown): boolean {
  return causeChainHas(error, CONTEXT_WINDOW_EXCEEDED_CODE)
}

/** Whether a summarization failure is the checkpoint being cut at its output cap. */
function isSummaryCut(error: unknown): boolean {
  return causeChainHas(error, 'MAX_TOKENS')
}

/** Whether a summarization failure is an answer without text, after the summarizer's own retry. */
function isSummaryEmpty(error: unknown): boolean {
  return causeChainHas(error, SUMMARY_EMPTY_CODE)
}

/**
 * The checkpoint's size when a summarization failure is the checkpoint being
 * no smaller than the range it would replace.
 * @param error - the failure to inspect.
 * @returns the checkpoint's heuristic tokens, or `undefined` for any other failure.
 */
function notSmallerCheckpoint(error: unknown): number | undefined {
  for (let current = error; typeof current === 'object' && current !== null; current = (current as { cause?: unknown }).cause) {
    if (current instanceof SummaryNotSmallerError) return current.checkpointTokens
  }
  return undefined
}

/** Resolve the exact provider/model durably routed for the latest request. */
function routedTarget(
  session: Session,
): Pick<LlmCallConfig, 'provider' | 'model'> | undefined {
  const config = session.requestHeader()?.config
  if (config === undefined || config.provider.length === 0 || config.model.length === 0) {
    return undefined
  }
  return { provider: config.provider, model: config.model }
}

/**
 * Output cap the latest request asked for: the logged header's cap or the
 * agent's own option.
 * @param agent - the agent whose latest request is read.
 * @returns the cap in tokens, `0` when none is known.
 */
function requestCap(agent: Agent): number {
  return agent.session.requestHeader()?.config.maxTokens ?? agent.options.maxTokens ?? 0
}

/**
 * Output tokens the routed request reserves, which the provider charges to the
 * same window as the prompt. The effective envelope's own cap wins; otherwise
 * the adapter's per-request default, which the adapter materializes when that
 * envelope omits one. No declared cap means no reservation.
 */
function reservedCompletionTokens(header: EpochHeader, defaultMaxTokens: number | undefined): number {
  return header.config.maxTokens ?? defaultMaxTokens ?? 0
}

/**
 * Resolve the budgets the window fit sizes requests, summary ranges, and
 * overflow recovery with. The fit prices each request's output cap itself, so
 * the spec carries no output reservation; it carries no `headroomTokens`
 * either, because these callers do not catch a configuration error and a
 * headroom at least as large as the window would otherwise fail every request
 * on that route.
 * @param policy - merged policy for the routed target.
 * @param contextWindow - the route's positive context window.
 * @returns the scaled budgets, whose `thresholdTokens` is the window ratio alone.
 */
function fitSpec(policy: ResolvedTargetPolicy, contextWindow: number): ResolvedCompactSpec {
  return resolveCompactSpec({ ...policy, headroomTokens: 0 }, contextWindow, 0)
}

/** Resolve the conversation target used to select an optional policy override. */
function conversationTarget(
  agent: Agent,
): Pick<LlmCallConfig, 'provider' | 'model'> | undefined {
  const routed = routedTarget(agent.session)
  if (routed !== undefined) return routed
  if (agent.options.provider === undefined || agent.options.provider.length === 0
    || agent.options.model === undefined || agent.options.model.length === 0) return undefined
  return { provider: agent.options.provider, model: agent.options.model }
}

const thresholdRatioSchema = z.number()
const headroomTokensSchema = z.number().step(1).min(0)
const retainRatioSchema = z.number()
const retainTokensSchema = z.number().step(1).min(0)
const summarizationProviderSchema = z.string()
const summarizationModelSchema = z.string()
const maxTokensSchema = z.number().step(1).min(1)
const compactionRetriesSchema = z.number().step(1).min(0)
const maxOverflowRetriesSchema = z.number().step(1).min(0)
const reserveMarginRatioSchema = z.number()
const outputReserveRatioSchema = z.number()
const failureBackoffStepsSchema = z.number().step(1).min(0)
const failureBackoffGrowthRatioSchema = z.number()
const minOutputTokensSchema = z.number().step(1).min(1)
const summaryWindowRatioSchema = z.number()
const outputRetryFactorSchema = z.number().min(1)

/** Policy fields shared by the engine configuration and each per-model override, in schema order. */
const policyFields = {
  thresholdRatio: thresholdRatioSchema,
  headroomTokens: headroomTokensSchema,
  retainRatio: retainRatioSchema,
  retainTokens: retainTokensSchema,
  summarizationProvider: summarizationProviderSchema,
  summarizationModel: summarizationModelSchema,
  maxTokens: maxTokensSchema,
  compactionRetries: compactionRetriesSchema,
  maxOverflowRetries: maxOverflowRetriesSchema,
  reserveMarginRatio: reserveMarginRatioSchema,
  outputReserveRatio: outputReserveRatioSchema,
  failureBackoffSteps: failureBackoffStepsSchema,
  failureBackoffGrowthRatio: failureBackoffGrowthRatioSchema,
  minOutputTokens: minOutputTokensSchema,
  summaryWindowRatio: summaryWindowRatioSchema,
  outputRetryFactor: outputRetryFactorSchema,
}

const modelPolicy: z<ModelCompactPolicyConfig> = z.object({
  provider: z.string().required(),
  model: z.string().required(),
  ...policyFields,
})

/**
 * Dependency-light compaction backend using `ctx.tokenMeter` for pressure,
 * retention, cited source events, and summary-convergence pricing.
 *
 * `summarize()` is the sole subclass customization hook; the replay and durable
 * mutation strategy stays fixed so every pricing decision uses the singleton
 * token meter.
 */
export class BasicCompactionEngine extends CompactionEngine {
  static inject = ['llm', 'tokenMeter', 'sessions']

  static Config: z<BasicCompactionConfig> = z.object({
    ...policyFields,
    modelPolicies: z.array(modelPolicy),
    auto: z.boolean(),
  })

  /** Resolved and validated compaction configuration. */
  readonly config: ResolvedConfig

  private readonly warnedPressureConfigTargets = new Set<string>()
  private readonly overflowRetries = new WeakMap<Agent, number>()
  /** The last `compaction/pressure` facts logged per agent, so a retried request writes nothing new. */
  private readonly loggedPressure = new WeakMap<Agent, string>()
  private readonly overflowAgents = new WeakMap<Session, Agent>()
  /**
   * Estimated surface tokens the next step admits before its request: the
   * user batch plus the part of the system prompt the log does not hold yet.
   */
  private readonly pendingBatchTokens = new WeakMap<Agent, number>()
  /**
   * The priced size at which a session's step-boundary compaction last failed, and the steps
   * since; while present, the next steps skip compaction until the backoff ends.
   */
  private readonly failedCompactions = new WeakMap<Session, { pricedTokens: number; stepsSince: number }>()
  /** Estimated tool-schema tokens the next request carries beyond the logged header's; they land in the header, not the surface. */
  private readonly pendingToolTokens = new WeakMap<Agent, number>()
  /** Output cap the request waterfall shrank for an agent, restored once the surface has room again. */
  private readonly shrunkCaps = new WeakMap<Agent, number>()
  private instructionTokensCache: number | undefined
  /** Summary cap chosen for the compaction an agent is running, with the most a cut checkpoint may raise it to; read by `summarize()`. */
  private readonly summaryCaps = new WeakMap<Agent, { readonly cap: number; readonly ceiling: number }>()
  /** Capacity of the model last resolved for an agent's route, so a manual compaction can fit the window without a model lookup. */
  private readonly knownContexts = new WeakMap<Agent, LlmModelContext>()
  /**
   * Provider tokens per heuristic token a route proved by refusing a request
   * as over its window, by route key; the meter's anchored density and this
   * bound together price every fit decision, so a provider that counts denser
   * than the estimate is refused once per process, not once per turn.
   */
  private readonly learnedDensities = new Map<string, number>()
  /** Largest checkpoint a session has landed, in heuristic tokens: a range no larger than it is not worth a model call. */
  private readonly checkpointSizes = new WeakMap<Session, number>()
  /** The latest conversation request's heuristic size and output cap, so its success can relax a learned density. */
  private readonly lastRequests = new WeakMap<Agent, { readonly estimated: number; readonly cap: number }>()
  /** The most reasoning tokens one step of a session has reported, so no output cap is shrunk below what the model needs to think. */
  private readonly reasoningPeaks = new WeakMap<Session, number>()

  constructor(ctx: Context, config: BasicCompactionConfig = {}) {
    super(ctx)
    this.config = resolveConfig(config)
    if (this.config.auto) this._registerAutomaticCompaction()
  }

  /**
   * Register between-step pressure, model-switch pressure, and request-overflow
   * recovery. Pre-step and overflow listeners dispatch through `compactIfNeeded`;
   * model switches price the proposed header directly. All summaries use `summarize`.
   */
  private _registerAutomaticCompaction(): void {
    const { ctx } = this
    const logResult = (result: CompactionResult, trigger: string): void => {
      ctx.logger.info(
        `compaction (${trigger}): shadowed ${result.shadowedSeqs.length} surface nodes `
        + `(seqs ${result.shadowedRange.start}-${result.shadowedRange.end}, `
        + `~${result.shadowedTokenCount} tokens)`,
      )
    }

    // A landed checkpoint (a manual /compact included) ends a failure backoff,
    // and so does a reply cut at its output cap, so the step after the cut
    // compacts instead of sending another request the window cannot answer.
    ctx.on('session/event', (session, event) => {
      if (event.type === 'compaction/summary'
        || (event.type === 'assistant/message' && lastAssistantStreamChunk(event.data.stream, 'finish')?.reason.kind === 'max-tokens')) {
        this.failedCompactions.delete(session)
      }
    })

    ctx.on('agent/pre-step', async (
      { agent, messages, prompt, signal },
      next,
    ): Promise<PreStepDecision> => {
      if (!signal.aborted) {
        this.pendingBatchTokens.set(
          agent,
          messages.reduce((sum, message) => sum + ctx.tokenMeter.estimateMessage(message), 0)
            + this.pendingSystemTokens(agent.session, prompt.systemPrompt),
        )
        this.pendingToolTokens.set(agent, this.pendingToolsTokens(agent.session, prompt.tools))
        if (this.backingOff(agent)) return next()
        try {
          const result = await this.compactIfNeeded(agent, 'pressure', signal)
          if (result !== null) logResult(result, 'step pressure')
        } catch (error: unknown) {
          // The turn was cancelled during the attempt; that is not a failed compaction.
          // oxlint-disable-next-line typescript/no-unnecessary-condition -- the signal can abort while compaction is awaited.
          if (signal.aborted) return next()
          if (error instanceof TargetPressureConfigError) {
            if (this.warnedPressureConfigTargets.has(error.targetKey)) return next()
            this.warnedPressureConfigTargets.add(error.targetKey)
          }
          const message = error instanceof Error ? error.message : String(error)
          // A misconfigured route is not a failed compaction; it has its own one-time warning.
          if (!(error instanceof TargetPressureConfigError)) {
            const current = this.currentPressure(agent)
            if (current !== undefined) this.failedCompactions.set(agent.session, { pricedTokens: current.pricedTokens, stepsSince: 0 })
          }
          ctx.logger.warn(`step compaction failed: ${message}; continuing the turn and retrying after the backoff`)
        }
      }
      return next()
    })

    // Prepend wraps routing listeners: await their final selection while the
    // committed header still identifies the model that can summarize the history.
    ctx.on('agent/request', async ({ agent, signal }, next) => {
      const config = await next()
      const previous = agent.session.requestHeader()
      if (signal.aborted || previous === undefined || config.provider === '' || config.model === ''
        || (previous.config.provider === config.provider && previous.config.model === config.model)) return config
      try {
        const header = { ...previous, config }
        const result = await this.compactPressure(agent, header, signal, true)
        if (result !== null) logResult(result, 'model switch')
      } catch (error: unknown) {
        signal.throwIfAborted()
        const message = error instanceof Error ? error.message : String(error)
        throw new LlmError(
          `Cannot switch to ${config.provider}/${config.model}: context compaction failed: ${message}. `
          + 'The previous request model is preserved; retry or select a model with a larger context window.',
          'MODEL_SWITCH_COMPACTION_FAILED',
          { cause: error },
        )
      }
      return config
    }, { prepend: true })

    // Last resort for the margin condensing could not close: the request asks
    // for the room that is left instead of the configured cap. The shrunk cap
    // is a header change, so the meter prices that step heuristically; the
    // configured cap returns as soon as the surface has room for it.
    // Prepended so it is outermost and sees the route every later listener
    // (model selection registers per agent) settled on.
    ctx.on('agent/request', async ({ agent, signal }, next): Promise<LlmCallConfig> => {
      const resolved = await next()
      const pending = this.pendingBatchTokens.get(agent) ?? 0
      const pendingTools = this.pendingToolTokens.get(agent) ?? 0
      this.pendingBatchTokens.delete(agent)
      this.pendingToolTokens.delete(agent)
      if (signal.aborted) return resolved
      let info: Awaited<ReturnType<typeof ctx.llm.resolveModelInfo>>
      try {
        info = await ctx.llm.resolveModelInfo(resolved.provider, resolved.model, signal)
      } catch (_unresolvableRoute) {
        // An unknown route fails loud in the loop's own call preparation; the cap stays as configured.
        return resolved
      }
      this.rememberContext(agent, info.context)
      const base = agent.options.maxTokens ?? info.defaultMaxTokens
      if (base === undefined || info.context === undefined) return resolved
      const spec = fitSpec(resolveTargetPolicy(this.config, resolved), info.context.contextWindow)
      const measurement = ctx.tokenMeter.measure(agent.session)
      const total = this.pricedTotal(measurement, resolved) + Math.round((pending + pendingTools) * this.densityFor(measurement, resolved))
      const room = spec.contextWindow - total - spec.marginTokens
      const estimated = measurement.estimatedTokens + pending + pendingTools
      const cap = room >= base ? base : Math.max(this.outputFloor(agent.session, spec), room)
      this.logPressure(agent, {
        estimatedTokens: estimated,
        pendingTokens: pending,
        pricedTokens: total,
        density: Math.round(this.densityFor(measurement, resolved) * 1000) / 1000,
        contextWindow: spec.contextWindow,
        outputCap: cap,
        thresholdTokens: fitThresholdTokens(spec, cap),
      })
      if (room >= base) {
        this.lastRequests.set(agent, { estimated, cap: base })
        if (!this.shrunkCaps.has(agent)) return resolved
        this.shrunkCaps.delete(agent)
        return { ...resolved, maxTokens: base }
      }
      this.lastRequests.set(agent, { estimated, cap })
      if (cap >= base) return resolved
      ctx.logger.warn(
        `request output cap shrunk from ${base} to ${cap}: ${total} priced tokens (pending batch included) leave `
        + `${room} of a ${spec.contextWindow} window after a ${spec.marginTokens} margin`,
      )
      this.shrunkCaps.set(agent, cap)
      return { ...resolved, maxTokens: cap }
    }, { prepend: true })

    ctx.on('agent/status', ({ agent, status }) => {
      if (status === 'idle') this.overflowRetries.delete(agent)
    })

    // A successful response starts a fresh overflow-recovery sequence even
    // when tool calls continue the same turn into another request.
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'assistant/message') return
      const reasoning = event.data.usage?.reasoningTokens
      if (reasoning !== undefined && reasoning > (this.reasoningPeaks.get(session) ?? 0)) this.reasoningPeaks.set(session, reasoning)
      const agent = this.overflowAgents.get(session)
      if (agent !== undefined) {
        this.overflowRetries.delete(agent)
        this.learnAcceptance(agent)
      }
    })

    ctx.on('agent/request-error', async (
      { agent, failure, signal },
      next,
    ) => {
      if (failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE || signal.aborted) return next()
      this.overflowAgents.set(agent.session, agent)
      const target = routedTarget(agent.session)
      if (target === undefined) return next()
      const policy = resolveTargetPolicy(this.config, target)
      const retries = this.overflowRetries.get(agent) ?? 0
      if (retries >= policy.maxOverflowRetries) return next()

      const generation = agent.session.surface.replaceGeneration
      let result: CompactionResult | null
      try {
        result = await this.compactIfNeeded(agent, 'context-overflow', signal)
      } catch (recoveryError: unknown) {
        const message = recoveryError instanceof Error ? recoveryError.message : String(recoveryError)
        // A model-free prune can land before later summary work fails. That
        // durable reduction is sufficient retry proof; do not discard it just
        // because the optional second phase threw. Cancellation still wins.
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- the signal can abort while recovery is awaited.
        if (!signal.aborted && agent.session.surface.replaceGeneration > generation) {
          ctx.logger.warn(
            `context-overflow compaction failed after durable surface progress: ${message}; `
            + 'retrying from the replacement surface',
          )
          this.overflowRetries.set(agent, retries + 1)
          return { kind: 'retry' }
        }
        ctx.logger.warn(
          // oxlint-disable-next-line typescript/no-unnecessary-condition -- the signal can abort while recovery is awaited.
          `context-overflow compaction failed: ${message}; ${signal.aborted
            ? 'cancellation prevents retry'
            : 'preserving the original request error'}`,
        )
        return next()
      }
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- the signal can abort while compaction is awaited.
      if (signal.aborted
        || agent.session.surface.replaceGeneration <= generation) return next()
      if (result !== null) logResult(result, 'context overflow recovery')
      this.overflowRetries.set(agent, retries + 1)
      return { kind: 'retry' }
    })
  }

  /**
   * Summarize the replayed conversation region through a direct one-shot
   * `ctx.llm.stream()` call whose prefix reuses the conversation's own system
   * prompt, tools, and messages so the provider's KV cache is not invalidated.
   * Override this sole hook for a template or remote summarizer.
   * @param input - replayed conversation prefix (system, tools, and leading messages) to condense.
   * @param agent - supplies routed-model history, fallback model, and session id.
   * @param signal - optional cancellation forwarded to the adapter.
   * @returns safe text summary blocks and the exact auxiliary call envelope and output.
   */
  protected async summarize(
    input: SummarizationInput,
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<SummaryResult> {
    const target = conversationTarget(agent)
    const config = target === undefined
      ? this.config
      : resolveTargetPolicy(this.config, target)
    // The cap chosen with the range wins; otherwise the window's bound, with
    // the whole surface assumed replayed when computing the room a raise has.
    const chosen = this.summaryCaps.get(agent)
    const context = chosen !== undefined || target === undefined
      ? undefined
      : await this.ctx.llm.resolveModelInfo(target.provider, target.model, signal).then(info => info.context, () => undefined)
    this.rememberContext(agent, context)
    let budget = chosen
    if (budget === undefined && context !== undefined && target !== undefined && 'target' in config) {
      const spec = fitSpec(config, context.contextWindow)
      const measurement = this.ctx.tokenMeter.measure(agent.session)
      const room = spec.contextWindow - spec.marginTokens - this.pricedTotal(measurement, target)
        - Math.round(this.instructionTokens() * this.densityFor(measurement, target))
      budget = { cap: spec.summaryCapTokens, ceiling: Math.max(spec.summaryCapTokens, Math.min(spec.summaryCeilingTokens, room)) }
    }
    if (budget === undefined) return summarizeWithLlm(this.ctx, config, input, agent, signal)
    // A checkpoint cut at its cap is retried with a larger one while the
    // window affords it: a model that thinks first spends part of the cap on that.
    let cap = budget.cap
    for (let raise = 0; ; raise += 1) {
      try {
        return await summarizeWithLlm(this.ctx, { ...config, maxTokens: cap }, input, agent, signal)
      } catch (error) {
        const factor = config.outputRetryFactor
        if (!isSummaryCut(error) || factor <= 1 || raise >= SUMMARY_RAISES || cap >= budget.ceiling) throw error
        const raised = Math.min(budget.ceiling, Math.round(cap * factor))
        this.ctx.logger.warn(`compaction: the checkpoint was cut at ${cap} output tokens; retrying with ${raised}`)
        cap = raised
      }
    }
  }

  /**
   * Compact for replayed step-boundary pressure or one provider-confirmed context
   * overflow. Both triggers price the latest durable routed request envelope;
   * overflow bypasses the normal threshold and retained-tail policy so it can
   * force one useful balanced reduction.
   * @param agent - agent whose latest durable routed request is measured.
   * @param trigger - normal step-boundary pressure or context-overflow recovery.
   * @param signal - live turn cancellation signal forwarded to summarization.
   * @returns the latest summary compaction result, or `null` when no summary ran.
   */
  override async compactIfNeeded(
    agent: Agent,
    trigger: CompactionTrigger,
    signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    const header = agent.session.requestHeader()
    if (header === undefined || routedTarget(agent.session) === undefined) return null
    switch (trigger) {
      case 'pressure':
        return this.compactPressure(agent, header, signal, false)
      case 'context-overflow': {
        const target = header.config
        const policy = resolveTargetPolicy(this.config, target)
        const meter = this.ctx.tokenMeter
        let measurement = meter.measure(agent.session)
        // An unlisted route still recovers: without capacity metadata the whole
        // surface is condensed, as it was before the fit rule.
        const context = await this.ctx.llm.resolveModelInfo(target.provider, target.model, signal)
          .then(info => info.context, () => undefined)
        this.rememberContext(agent, context)
        // The refused request proves how the provider counts this route.
        if (context !== undefined) {
          this.learnRefusal(target, fitSpec(policy, context.contextWindow), measurement.estimatedTokens,
            requestCap(agent), 'the request')
        }
        const prune = this.ctx.get('toolResultPruner')
        if (prune !== undefined) {
          prune.pruneSession(agent.session, 'all')
          measurement = meter.measure(agent.session)
        }
        // The summarizer replays the prefix it condenses, so a tail stays out of
        // the range whenever the whole surface plus the summary cap would not fit.
        if (context === undefined) {
          const range = selectCompactableRange(agent.session, measurement, 0)
          if (range === null) return null
          return this.compactRegion(range.start, range.end, agent, signal)
        }
        return this.condenseFitting(agent.session, measurement, fitSpec(policy, context.contextWindow), 0, agent, target,
          fit => this.compactFitting(fit, agent, signal))
      }
      /* v8 ignore next -- closed-union exhaustiveness guard */
      default:
        assertNever(trigger, 'compaction trigger')
    }
  }

  /** Price the proposed header; switch checks require history below its threshold. */
  private async compactPressure(
    agent: Agent,
    header: EpochHeader,
    signal: AbortSignal,
    requireBelowThreshold: boolean,
  ): Promise<CompactionResult | null> {
    const target = header.config
    const policy = resolveTargetPolicy(this.config, target)
    const meter = this.ctx.tokenMeter
    let measurement = meter.measure(agent.session, header)
    const prune = this.ctx.get('toolResultPruner')
    const info = await this.ctx.llm.resolveModelInfo(target.provider, target.model, signal)
    this.rememberContext(agent, info.context)
    assertNoActiveCompaction(agent.session, 'automatic pressure compaction')
    const targetKey = `${target.provider}/${target.model}`
    if (info.context === undefined) {
      throw new TargetPressureConfigError(
        targetKey,
        `compaction-basic: no context capacity for ${targetKey}; `
        + 'configure contextWindow on that adapter model',
      )
    }
    const spec = resolveCompactSpec(
      policy,
      info.context.contextWindow,
      reservedCompletionTokens(header, info.defaultMaxTokens),
    )
    const outputCap = agent.options.maxTokens ?? info.defaultMaxTokens ?? header.config.maxTokens ?? 0
    const pending = (this.pendingBatchTokens.get(agent) ?? 0) + (this.pendingToolTokens.get(agent) ?? 0)
    // `spec.thresholdTokens` already nets out the routed output reservation and `headroomTokens`, and
    // `fitThresholdTokens` nets out `min(outputCap, outputReserveTokens)` plus the margin again; both
    // test suites accept only this combination. The threshold logged in `compaction/pressure` comes from
    // `fitSpec`, which omits the reservation and headroom, so it can sit above this condense point.
    const threshold = fitThresholdTokens(spec, outputCap)
    const fits = (current: TokenMeasurement): boolean =>
      this.pricedTotal(current, target) + Math.round(pending * this.densityFor(current, target)) < threshold
    if (fits(measurement)) return null

    // Once pressure qualifies, land the model-free pass before choosing a
    // summary range, then remeasure through the singleton replay fold. This
    // pass cuts only results the model has read; a summary of older history
    // may make room for the ones it has not.
    if (prune !== undefined) {
      prune.pruneSession(agent.session, 'read')
      measurement = meter.measure(agent.session, header)
    }
    if (fits(measurement)) return null

    // Cutting a result the model has not read marks it with how to see the cut span.
    let unreadCut = false
    const cutUnread = (): boolean => {
      if (prune === undefined || unreadCut) return false
      unreadCut = true
      prune.pruneSession(agent.session, 'all')
      measurement = meter.measure(agent.session, header)
      return fits(measurement)
    }
    // A summary leaves the latest step in place; when that step alone is over
    // the threshold, no summary can make room, so its results are cut first.
    const framing = measurement.estimatedTokens - measurement.surfaceTokens
    const leastAfterSummary = Math.round(
      (framing + latestStepTokens(agent.session, measurement) + pending) * this.densityFor(measurement, target),
    )
    if (leastAfterSummary >= threshold && cutUnread()) return null

    const condense = await this.pressureCondenser(agent, target, spec, signal)
    let result: CompactionResult | null = null
    let exhausted = true
    for (let attempt = 0; attempt <= spec.compactionRetries; attempt += 1) {
      const condensed = await condense(measurement)
      if (condensed === null) {
        exhausted = false
        break
      }
      result = condensed
      measurement = meter.measure(agent.session, header)
      if (fits(measurement)) return result
    }
    if (cutUnread()) return result
    if (exhausted) {
      throw new Error(
        `compaction still above threshold after ${spec.compactionRetries + 1} compaction attempts `
        + `(${this.pricedTotal(measurement, target)} priced + ${pending} pending tokens >= threshold ${threshold}; `
        + `window ${spec.contextWindow}, output cap ${outputCap}, margin ${spec.marginTokens})`,
      )
    }
    if (result === null && !requireBelowThreshold) return null
    throw new Error(
      'no safe compaction range can reduce context below threshold '
      + `(${this.pricedTotal(measurement, target)} priced + ${pending} pending tokens >= threshold ${threshold})`,
    )
  }

  /**
   * The condensing step for pressure on `target`. The range is fitted to the
   * window of the session's routed model, which writes the summary unless a
   * summarization target is configured and which on a model switch is still
   * the previous route; retention stays the one `spec` sets. A routed model
   * without capacity metadata condenses the policy range whole, as overflow
   * recovery does for an unlisted route.
   * @param agent - agent whose session is condensed.
   * @param target - route whose pressure requires condensing.
   * @param spec - that route's resolved budgets.
   * @param signal - cancellation forwarded to the capacity lookup and summarization.
   * @returns a function that condenses one range of a measurement, resolving `null` when nothing is condensable.
   */
  private async pressureCondenser(
    agent: Agent,
    target: Pick<LlmCallConfig, 'provider' | 'model'>,
    spec: ResolvedCompactSpec,
    signal: AbortSignal,
  ): Promise<(measurement: TokenMeasurement) => Promise<CompactionResult | null>> {
    const summarizer = routedTarget(agent.session)
    if (summarizer === undefined || (summarizer.provider === target.provider && summarizer.model === target.model)) {
      return measurement => this.condenseFitting(agent.session, measurement, spec, spec.retainTokens, agent, target,
        fit => this.compactFitting(fit, agent, signal))
    }
    const context = await this.ctx.llm.resolveModelInfo(summarizer.provider, summarizer.model, signal)
      .then(info => info.context, () => undefined)
    if (context === undefined) {
      return async (measurement) => {
        const range = selectCompactableRange(agent.session, measurement, spec.retainTokens)
        return range === null ? null : this.compactRegion(range.start, range.end, agent, signal)
      }
    }
    const fitted = fitSpec(resolveTargetPolicy(this.config, summarizer), context.contextWindow)
    return measurement => this.condenseFitting(agent.session, measurement, fitted, spec.retainTokens, agent, summarizer,
      fit => this.compactFitting(fit, agent, signal))
  }

  /**
   * Choose the range to condense and the summary cap it leaves room for. The
   * summarization request replays the surface up to the range's end (system,
   * tools, the range) plus the instruction, so its output cap is what the
   * window has left after that and the margin, bounded by the policy cap.
   * When the policy's retention leaves less room than the floor (the larger of
   * `minOutputTokens` and the instruction's size, but never above the summary
   * cap), a larger verbatim tail stays out of
   * the range instead, so a thinking model keeps room to answer; when even that
   * leaves nothing to condense, the policy's range is used with the floor as
   * its cap, so something is still condensed rather than nothing.
   * @param session - the agent-owned session.
   * @param measurement - current surface measurement.
   * @param spec - the routed model's scaled budgets.
   * @param configuredRetain - retention the policy asks for.
   * @param density - provider tokens per heuristic token the replayed prefix is priced at.
   * @returns the inclusive positional range to condense with its summary cap, or `null`.
   */
  private selectFittingRange(
    session: Session,
    measurement: TokenMeasurement,
    spec: ResolvedCompactSpec,
    configuredRetain: number,
    density: number,
  ): { start: SessionSeq; end: SessionSeq; summaryCap: number; summaryCeiling: number } | null {
    const instruction = Math.round(this.instructionTokens() * density)
    // Tool schemas and framing replay with every prefix.
    const framing = measurement.estimatedTokens - measurement.surfaceTokens
    const roomAfter = (end: SessionSeq): number =>
      spec.contextWindow - spec.marginTokens - Math.round((framing + tokensThrough(measurement, end)) * density) - instruction
    // A checkpoint needs at least about the instruction's size to carry its
    // sections, a thinking model at least the request floor, and the
    // summarizer never more than its own cap.
    const floor = Math.min(spec.summaryCapTokens, Math.max(this.outputFloor(session, spec), instruction))
    const ceilingAfter = (end: SessionSeq, cap: number): number => Math.max(cap, Math.min(spec.summaryCeilingTokens, roomAfter(end)))
    const policyRange = selectCompactableRange(session, measurement, configuredRetain)
    if (policyRange === null) return null
    const policyRoom = roomAfter(policyRange.end)
    if (policyRoom >= floor) {
      const summaryCap = Math.min(spec.summaryCapTokens, policyRoom)
      return { ...policyRange, summaryCap, summaryCeiling: ceilingAfter(policyRange.end, summaryCap) }
    }
    // The policy range leaves less room than the floor, so the retention that
    // leaves the floor is larger than the policy's retention.
    const fittingRetain = Math.ceil(measurement.estimatedTokens - (spec.contextWindow - spec.marginTokens - instruction - floor) / density)
    const fitting = selectCompactableRange(session, measurement, fittingRetain)
    if (fitting === null) return { ...policyRange, summaryCap: floor, summaryCeiling: ceilingAfter(policyRange.end, floor) }
    const summaryCap = Math.min(spec.summaryCapTokens, Math.max(floor, roomAfter(fitting.end)))
    return { ...fitting, summaryCap, summaryCeiling: ceilingAfter(fitting.end, summaryCap) }
  }

  /**
   * Condense the fitting range, following a failed summarization with a
   * better range instead of giving up: a request the provider refuses as over
   * its window teaches the route's density and the range is refitted at it
   * (halved when the density was already known); a checkpoint cut at a
   * ceiling the room set, or one that came back without text, gets a range
   * about half the size; a checkpoint no
   * smaller than its range gets the range grown by the next node. At most
   * `SUMMARY_RETRIES` such retries follow the first attempt.
   * @param session - the agent-owned session.
   * @param measurement - current surface measurement.
   * @param spec - the routed model's scaled budgets.
   * @param configuredRetain - retention the policy asks for.
   * @param agent - the owning agent, named in the log line.
   * @param target - the routed model, whose learned density prices the fit.
   * @param run - condenses one fitting range.
   * @returns the compaction result, or `null` when nothing is condensable.
   */
  private async condenseFitting(
    session: Session,
    measurement: TokenMeasurement,
    spec: ResolvedCompactSpec,
    configuredRetain: number,
    agent: Agent,
    target: Pick<LlmCallConfig, 'provider' | 'model'>,
    run: (fit: { start: SessionSeq; end: SessionSeq; summaryCap: number; summaryCeiling: number }) => Promise<CompactionResult>,
  ): Promise<CompactionResult | null> {
    let retain = configuredRetain
    let density = this.densityFor(measurement, target)
    let failed: Error | undefined
    let lastEnd: SessionSeq | undefined
    for (let retries = 0; ; retries += 1) {
      let fit = this.selectFittingRange(session, measurement, spec, retain, density)
      if (fit === null && failed === undefined && density > measurement.density) {
        // A learned density that leaves nothing condensable is worth less
        // than a request the provider can rule on: fit at the meter's density.
        density = measurement.density
        fit = this.selectFittingRange(session, measurement, spec, retain, density)
      }
      if (fit === null) {
        // Nothing else is left to try: the failure, not "nothing to
        // condense", is what the caller reports.
        if (failed !== undefined) throw failed
        return null
      }
      if (fit.end === lastEnd && failed !== undefined) throw failed
      lastEnd = fit.end
      // A range no larger than a checkpoint this session has landed cannot
      // shrink by being summarized; bring the next node in without a model call.
      const smallest = this.checkpointSizes.get(session)
      if (smallest !== undefined && rangeTokens(measurement, fit.start, fit.end) <= smallest) {
        const grown = grownRetain(measurement, fit.start, fit.end, Math.ceil(smallest * GROWN_RANGE_FACTOR), retain)
        if (grown === undefined) {
          if (failed !== undefined) throw failed
          return null
        }
        retain = grown
        continue
      }
      const framing = measurement.estimatedTokens - measurement.surfaceTokens
      const request = framing + tokensThrough(measurement, fit.end) + this.instructionTokens()
      try {
        const result = await run(fit)
        this.relaxDensity(target, spec.contextWindow, request, fit.summaryCap)
        // The checkpoint is text-only, so this estimate is the price of the node that landed.
        const checkpoint = createCheckpointMessage(result.summary, result.compactionId, result.sourceCommandId)
        this.checkpointSizes.set(session, Math.max(smallest ?? 0, this.ctx.tokenMeter.estimateMessage(checkpoint)))
        return result
      } catch (error) {
        if (retries >= SUMMARY_RETRIES) throw error
        failed = error instanceof Error ? error : new Error(String(error))
        const half = () => { retain += halfOfRange(measurement, fit.start, fit.end) }
        if (isProviderOverflow(error)) {
          if (this.learnRefusal(target, spec, request, fit.summaryCap, 'the summarization request')) {
            density = this.densityFor(measurement, target)
            lastEnd = undefined
            continue
          }
          half()
          this.ctx.logger.warn(
            `compaction: the provider refused the summarization request for "${agent.id}" as over its window; `
            + 'retrying with a range about half the size',
          )
          continue
        }
        // A checkpoint cut at a ceiling the room set (not the window share)
        // gets more room from a smaller range.
        if (isSummaryCut(error) && fit.summaryCeiling < spec.summaryCeilingTokens) {
          half()
          this.ctx.logger.warn(
            `compaction: the checkpoint for "${agent.id}" was cut at the ${fit.summaryCeiling} output tokens the range leaves; `
            + 'retrying with a range about half the size',
          )
          continue
        }
        // A model that answers a long range with no text may answer a shorter
        // one: some lose the instruction that far from the start of the request.
        if (isSummaryEmpty(error)) {
          half()
          this.ctx.logger.warn(
            `compaction: the checkpoint for "${agent.id}" came back without text; retrying with a range about half the size`,
          )
          continue
        }
        const checkpoint = notSmallerCheckpoint(error)
        if (checkpoint !== undefined) {
          // The range was too small to be worth a checkpoint of that size:
          // grow it past the checkpoint before asking for another.
          this.checkpointSizes.set(session, Math.max(smallest ?? 0, checkpoint))
          const grown = grownRetain(measurement, fit.start, fit.end, Math.ceil(checkpoint * GROWN_RANGE_FACTOR), retain)
          if (grown === undefined) throw error
          retain = grown
          this.ctx.logger.warn(
            `compaction: the checkpoint for "${agent.id}" was no smaller than its range; retrying with the next node in the range`,
          )
          continue
        }
        throw error
      }
    }
  }

  /**
   * Heuristic tokens of the system prompt the next request adds to the
   * surface: the whole prompt before any is logged, nothing when the latest
   * logged text matches, otherwise the growth over the replaced head, or the
   * whole prompt on a route that appends updates to history.
   * @param session - the session the request is for.
   * @param rendered - the system prompt the request will carry.
   * @returns non-negative heuristic tokens not yet in the surface.
   */
  private pendingSystemTokens(session: Session, rendered: string): number {
    const texts = session.deriveMessages()
      .filter(message => message.role === 'system')
      .map(message => ({
        text: messageText(message),
        tokens: this.ctx.tokenMeter.estimateMessage(message),
      }))
    const latest = texts.findLast(node => node.text !== '') ?? texts[0]
    if (latest?.text === rendered) return 0
    if (rendered === '') return 0
    const priced = this.ctx.tokenMeter.estimateMessage(createSystemMessage(rendered))
    const inHistory = session.requestContext()?.systemPromptUpdate === 'in-history'
    return Math.max(0, priced - (inHistory ? 0 : texts[0]?.tokens ?? 0))
  }

  /**
   * Heuristic tokens the next request's tool schemas add over the logged header's.
   * @param session - the session the request is for.
   * @param tools - the tool schemas the request will carry.
   * @returns non-negative heuristic tokens not yet priced.
   */
  private pendingToolsTokens(session: Session, tools: readonly ToolSchema[]): number {
    const meter = this.ctx.tokenMeter
    return Math.max(0, meter.estimateTools(tools) - meter.estimateTools(session.requestHeader()?.tools ?? []))
  }

  /**
   * The routed model's spec and the session's priced size, when the route's capacity is known.
   * @param agent - the stepping agent.
   * @returns the spec and priced tokens, or `undefined` before the route's capacity is known.
   */
  private currentPressure(agent: Agent): { spec: ResolvedCompactSpec; pricedTokens: number } | undefined {
    const target = routedTarget(agent.session)
    const context = this.knownContexts.get(agent)
    if (target === undefined || context === undefined) return undefined
    const spec = fitSpec(resolveTargetPolicy(this.config, target), context.contextWindow)
    return { spec, pricedTokens: this.pricedTotal(this.ctx.tokenMeter.measure(agent.session), target) }
  }

  /**
   * Whether this step skips compaction because an earlier attempt failed: until
   * `failureBackoffSteps` steps pass, the surface grows by `failureBackoffGrowthTokens`,
   * or a checkpoint lands or a reply is cut at its output cap (both end the backoff
   * where they are logged). Counts the step and ends the backoff when either limit is reached.
   * @param agent - the stepping agent.
   * @returns true when the step skips compaction.
   */
  private backingOff(agent: Agent): boolean {
    const backoff = this.failedCompactions.get(agent.session)
    if (backoff === undefined) return false
    backoff.stepsSince += 1
    const current = this.currentPressure(agent)
    if (current === undefined
      || backoff.stepsSince >= current.spec.failureBackoffSteps
      || current.pricedTokens >= backoff.pricedTokens + current.spec.failureBackoffGrowthTokens) {
      this.failedCompactions.delete(agent.session)
      return false
    }
    return true
  }

  /**
   * The least output a request of this session may ask for: the configured
   * floor, or a quarter more than the most reasoning one step has spent,
   * whichever is larger, so a model that thinks first is never cut before
   * its answer.
   * @param session - the agent-owned session.
   * @param spec - the routed model's scaled budgets.
   * @returns the floor in output tokens.
   */
  private outputFloor(session: Session, spec: ResolvedCompactSpec): number {
    const peak = this.reasoningPeaks.get(session) ?? 0
    return Math.max(spec.minOutputTokens, Math.ceil(peak * REASONING_HEADROOM))
  }

  /**
   * Provider tokens per heuristic token for pricing this route: the meter's
   * anchored density or the bound a refusal proved, whichever is larger.
   * @param measurement - current surface measurement.
   * @param target - the routed model.
   * @returns the density, at least `1`.
   */
  private densityFor(measurement: TokenMeasurement, target: Pick<LlmCallConfig, 'provider' | 'model'>): number {
    return Math.max(measurement.density, this.learnedDensities.get(routeKey(target)) ?? 1)
  }

  /**
   * Log the request as priced and the threshold the next step condenses at,
   * once per distinct measurement, for the occupancy meter to show.
   * @param agent - the requesting agent.
   * @param facts - the priced request facts.
   */
  private logPressure(agent: Agent, facts: SessionEventMap['compaction/pressure']): void {
    const key = JSON.stringify(facts)
    if (this.loggedPressure.get(agent) === key) return
    this.loggedPressure.set(agent, key)
    agent.session.append('compaction/pressure', facts, { ignorable: true })
  }

  /**
   * The current request as the provider will count it: the meter's anchored
   * total, or the heuristic at the density a refusal proved when that is larger.
   * @param measurement - current surface measurement.
   * @param target - the routed model.
   * @returns priced request tokens.
   */
  private pricedTotal(measurement: TokenMeasurement, target: Pick<LlmCallConfig, 'provider' | 'model'>): number {
    const learned = this.learnedDensities.get(routeKey(target)) ?? 1
    return Math.max(measurement.totalTokens, Math.round(measurement.estimatedTokens * learned))
  }

  /**
   * Record what a refusal proves: a request of `estimatedTokens` heuristic
   * tokens with `cap` output tokens did not fit the window, so the provider
   * counts at least `(window − cap) / estimatedTokens` per heuristic token.
   * @param target - the routed model.
   * @param spec - the routed model's scaled budgets.
   * @param estimatedTokens - the refused request's heuristic size; positive, since a request carries at least one message.
   * @param cap - the output cap the refused request asked for.
   * @param what - the refused request, named in the log line.
   * @returns `true` when the route's known density rose.
   */
  private learnRefusal(
    target: Pick<LlmCallConfig, 'provider' | 'model'>,
    spec: ResolvedCompactSpec,
    estimatedTokens: number,
    cap: number,
    what: string,
  ): boolean {
    const proven = ((spec.contextWindow - cap) / estimatedTokens) * REFUSAL_HEADROOM
    const key = routeKey(target)
    const known = this.learnedDensities.get(key) ?? 1
    if (proven <= known) return false
    this.learnedDensities.set(key, proven)
    this.ctx.logger.warn(
      `compaction: ${what} was refused as over the window; ${key} counts at least ${proven.toFixed(2)} tokens `
      + 'per estimated token, and every fit is priced at that from now on',
    )
    return true
  }

  /**
   * Relax a learned density with what an accepted request proves: its
   * heuristic size at the true density plus its cap fit the window, so the
   * density is at most `(window − cap) / estimatedTokens`. A refusal that a
   * later, larger request contradicts (a transient rejection, or denser
   * content that one time) stops pricing every fit.
   * @param agent - the agent whose latest request the provider accepted.
   */
  private learnAcceptance(agent: Agent): void {
    const target = routedTarget(agent.session)
    const context = this.knownContexts.get(agent)
    const request = this.lastRequests.get(agent)
    if (target === undefined || context === undefined || request === undefined) return
    this.relaxDensity(target, context.contextWindow, request.estimated, request.cap)
  }

  /**
   * Lower a route's learned density to the bound an accepted request proves.
   * @param target - the routed model.
   * @param contextWindow - the route's configured window.
   * @param estimatedTokens - the accepted request's heuristic size; positive, since a request carries at least one message.
   * @param cap - the output cap the accepted request asked for.
   */
  private relaxDensity(
    target: Pick<LlmCallConfig, 'provider' | 'model'>,
    contextWindow: number,
    estimatedTokens: number,
    cap: number,
  ): void {
    const key = routeKey(target)
    const known = this.learnedDensities.get(key)
    if (known === undefined) return
    const bound = Math.max(1, (contextWindow - cap) / estimatedTokens)
    if (bound >= known) return
    this.learnedDensities.set(key, bound)
    this.ctx.logger.info(
      `compaction: an accepted request shows ${key} counts at most ${bound.toFixed(2)} tokens per estimated token; `
      + 'fits are priced at that now',
    )
  }

  /**
   * Attach the numbers behind a refused manual compaction to its failure, so
   * the reason a person reads carries the window, the caps, the sizes, and
   * the densities the fit was priced at.
   * @param error - the failure compactNow is about to throw.
   * @param agent - the agent whose session was being condensed.
   * @returns the same failure, or a copy carrying `facts` for a summary failure.
   */
  private withFacts(error: unknown, agent: Agent): unknown {
    if (!(error instanceof ManualCompactionError) || error.code !== 'summary') return error
    const target = routedTarget(agent.session)
    const context = this.knownContexts.get(agent)
    if (target === undefined || context === undefined) return error
    const measurement = this.ctx.tokenMeter.measure(agent.session)
    const spec = fitSpec(resolveTargetPolicy(this.config, target), context.contextWindow)
    return new ManualCompactionError(error.code, error.message, {
      cause: error.cause,
      facts: {
        contextWindow: spec.contextWindow,
        marginTokens: spec.marginTokens,
        requestCap: requestCap(agent),
        summaryCap: spec.summaryCapTokens,
        summaryShare: spec.summaryCeilingTokens,
        estimatedTokens: measurement.estimatedTokens,
        pricedTokens: this.pricedTotal(measurement, target),
        density: Number(this.densityFor(measurement, target).toFixed(2)),
        outputFloor: this.outputFloor(agent.session, spec),
      },
    })
  }

  /**
   * Keep the capacity resolved for an agent's route for the manual path.
   * @param agent - the agent whose route was resolved.
   * @param context - the resolved capacity, or `undefined` for an unlisted route.
   */
  private rememberContext(agent: Agent, context: LlmModelContext | undefined): void {
    if (context !== undefined) this.knownContexts.set(agent, context)
  }

  /** Condense one chosen range with the summary cap chosen for it. */
  private async compactFitting(
    fit: { start: SessionSeq; end: SessionSeq; summaryCap: number; summaryCeiling: number },
    agent: Agent,
    signal: AbortSignal,
  ): Promise<CompactionResult> {
    this.summaryCaps.set(agent, { cap: fit.summaryCap, ceiling: fit.summaryCeiling })
    try {
      return await this.compactRegion(fit.start, fit.end, agent, signal)
    } finally {
      this.summaryCaps.delete(agent)
    }
  }

  /** Estimated size of the compaction instruction appended to every summarization request. */
  private instructionTokens(): number {
    this.instructionTokensCache ??= this.ctx.tokenMeter.estimateMessage(createUserMessage({
      content: [{ type: 'text', text: COMPACTION_INSTRUCTION }],
      source: { kind: 'user' },
    }))
    return this.instructionTokensCache
  }

  /**
   * Compact one inclusive positional range from the agent-owned surface using
   * the effective token meter for all retention and shrink pricing.
   * @param start - inclusive first surface-node seq.
   * @param end - inclusive last surface-node seq.
   * @param agent - owner of the target session, used by the summarizer.
   * @param signal - optional summarization cancellation signal.
   * @returns the successful durable compaction result.
   */
  override async compactRegion(
    start: SessionSeq,
    end: SessionSeq,
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<CompactionResult> {
    return compactSurfaceRegion(
      this.regionDependencies(),
      agent.session,
      start,
      end,
      agent,
      { owner: 'current-turn', stability: 'whole-surface' },
      signal,
    )
  }

  /**
   * Force one useful idle-session compaction below the pressure threshold, and
   * resolve only after its standalone marker pair is durably checkpointed.
   * @param agent - idle agent whose next-turn admission this call reserves.
   * @param signal - cancellation scoped to this compaction request.
   * @param sourceCommandId - initiating command identity for presentation correlation.
   * @returns the committed result, or `null` when no safe useful range exists.
   */
  override compactNow(
    agent: Agent,
    signal: AbortSignal,
    sourceCommandId?: CommandId,
  ): Promise<CompactionResult | null> {
    signal.throwIfAborted()
    try {
      return agent.runMaintenance(async (agentSignal) => {
        const operationSignal = AbortSignal.any([agentSignal, signal])
        try {
          operationSignal.throwIfAborted()
          const measurement = this.ctx.tokenMeter.measure(agent.session)
          const manual = (start: SessionSeq, end: SessionSeq): Promise<CompactionResult> => compactSurfaceRegion(
            this.regionDependencies(),
            agent.session,
            start,
            end,
            agent,
            {
              owner: null,
              stability: 'selected-span',
              ...sourceCommandId === undefined ? {} : { sourceCommandId },
              flush: async () => {
                await this.ctx.sessions.flush(agent.session)
              },
            },
            operationSignal,
          )
          const fitting = async (
            target: Pick<LlmCallConfig, 'provider' | 'model'>,
            spec: ResolvedCompactSpec,
            remeasured: TokenMeasurement,
            retain: number,
          ): Promise<CompactionResult | null> =>
            this.condenseFitting(agent.session, remeasured, spec, retain, agent, target, async (fit) => {
              this.summaryCaps.set(agent, { cap: fit.summaryCap, ceiling: fit.summaryCeiling })
              try {
                return await manual(fit.start, fit.end)
              } finally {
                this.summaryCaps.delete(agent)
              }
            })
          // With the route's capacity known from an earlier request, the manual
          // range fits the window like an automatic one; before any request,
          // the whole compactable surface is condensed.
          const target = routedTarget(agent.session)
          const known = this.knownContexts.get(agent)
          if (target !== undefined && known !== undefined) {
            return await fitting(target, fitSpec(resolveTargetPolicy(this.config, target), known.contextWindow), measurement, 0)
          }
          const range = selectCompactableRange(agent.session, measurement, 0)
          if (range === null) return null
          try {
            return await manual(range.start, range.end)
          } catch (error: unknown) {
            // The provider counted the whole surface as over its window while the
            // harness did not: with the routed window known, retry on ranges that
            // leave progressively more of the surface out.
            if (target === undefined || !isProviderOverflow(error)) throw error
            const context = await this.ctx.llm.resolveModelInfo(target.provider, target.model, operationSignal)
              .then(info => info.context, () => undefined)
            if (context === undefined) throw error
            this.rememberContext(agent, context)
            const remeasured = this.ctx.tokenMeter.measure(agent.session)
            this.ctx.logger.warn(
              `compaction: the provider refused the summarization request for "${agent.id}" as over its window; `
              + 'retrying with a range about half the size',
            )
            const spec = fitSpec(resolveTargetPolicy(this.config, target), context.contextWindow)
            // The refused whole-surface request proves the density; the fit at it replaces the halving.
            const learned = this.learnRefusal(target, spec, remeasured.estimatedTokens + this.instructionTokens(),
              this.summaryCaps.get(agent)?.cap ?? spec.summaryCapTokens, 'the summarization request')
            return await fitting(target, spec, remeasured, learned ? 0 : halfOfRange(remeasured, range.start, range.end))
          }
        } catch (error: unknown) {
          if (agentSignal.aborted && operationSignal.reason === agentSignal.reason) {
            throw new ManualCompactionError(
              'cancelled',
              'manual compaction was cancelled',
              { cause: error },
            )
          }
          operationSignal.throwIfAborted()
          throw this.withFacts(error, agent)
        }
      })
    } catch (error: unknown) {
      throw new ManualCompactionError(
        'busy',
        'manual compaction requires an idle agent with no waking queued work',
        { cause: error },
      )
    }
  }

  /** Bind the effective token meter and dynamically dispatched summarizer hook. */
  private regionDependencies(): Parameters<typeof compactSurfaceRegion>[0] {
    return {
      meter: this.ctx.tokenMeter,
      summarize: (input, owner, abort) => this.summarize(input, owner, abort),
      recover: (error, agent, sourceEventSeqs, signal) => this.ctx.waterfall('compaction/summary-error', {
        session: agent.session,
        sourceEventSeqs,
        error,
        ...signal === undefined ? {} : { signal },
      }, () => false),
    }
  }
}

export default BasicCompactionEngine
