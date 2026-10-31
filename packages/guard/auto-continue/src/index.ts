/**
 * Auto-continue guard: when a step stops because the model hit its output-token
 * limit, steer one continuation request at the turn-stopping boundary so the
 * turn goes on without a human typing "continue". The continuation is an
 * ordinary logged user message with a plugin source; a completed, cancelled, or
 * errored step is never continued, and a required per-turn cap bounds the
 * number of continuations. Named exports preserve Loader injection metadata.
 * @module @deepseek-ai/dsh-auto-continue
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createUserMessage, expandAssistantStream, lowestReasoningEffort } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, ContextFormed, MessageSource, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
// Also resolves the `agent/turn-stopping`, `agent/pre-step`, and `agent/status` declarations.
import type { Agent, ModelSelection, PreStepDecision } from '@deepseek-ai/dsh-agent'

export const name = 'auto-continue'
export const inject = ['agents', 'llm']

/** Auto-continue configuration. */
export interface Config {
  /**
   * Required cap on continuations steered within one turn. Each continuation
   * costs a full model request over the whole context, so the value is the
   * spend the deployment accepts for one truncated answer.
   */
  maxContinuationsPerTurn: number
  /**
   * A cut answer whose visible text is shorter than this many characters was
   * cut before its answer: the cap was spent on something else, usually a
   * reasoning model's thinking. Defaults to `80`.
   */
  minVisibleChars?: number
  /**
   * Continuations per turn for an answer cut before its visible text (see
   * `minVisibleChars`). Such a continuation asks the model to answer now, and
   * its request asks the route for its lowest selectable reasoning effort
   * (`off`, `none`, `minimal`, or `low`, whichever the route offers first) so
   * the cap goes to the answer; they count toward `maxContinuationsPerTurn`.
   * `0` stops such a turn at once. Defaults to `1`.
   */
  maxReasoningContinuationsPerTurn?: number
}

/** Schemastery configuration for the auto-continue guard. */
export const Config: z<Config> = z.object({
  maxContinuationsPerTurn: z.natural().min(1).required(),
  minVisibleChars: z.natural().default(80),
  maxReasoningContinuationsPerTurn: z.natural().default(1),
})

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /**
     * The continuation message this guard steers. The kind is the name released
     * Hydra logs migrate this plugin's sources to.
     * @persistenceAttribution
     */
    'plugin:dsh-auto-continue': { kind: 'plugin:dsh-auto-continue' } & ContextFormed
  }
}

/** Source stamped on every continuation message the guard steers. */
export const CONTINUATION_SOURCE: MessageSource = { kind: 'plugin:dsh-auto-continue' }

/** Verbatim continuation instruction the model receives. */
export const CONTINUATION_TEXT =
  'Continue exactly where you stopped; do not repeat earlier output. '
  + 'Your previous message was cut off by the output-token limit.'

/** The continuation steered after a reply whose reasoning spent the cap before any answer. */
export const REASONING_CONTINUATION_TEXT =
  'Your previous reply spent the whole output-token limit on reasoning before answering. '
  + 'Answer now, keeping any further reasoning brief.'

/** What the guard remembers about the latest assistant settlement of a session. */
interface LatestSettlement {
  turn: number
  truncated: boolean
  hasContent: boolean
  /** Characters of visible answer text. */
  visibleChars: number
}

/** A selection a reasoning continuation recorded and the one it replaced. */
interface LoweredSelection {
  readonly lowered: Readonly<ModelSelection>
  readonly replaced: Readonly<ModelSelection>
}

/**
 * Whether a model choice is exactly the given selection.
 * @param current - the agent's current choice, if any.
 * @param selection - the selection to compare against.
 * @returns true when provider, model, and reasoning effort all match.
 */
function sameSelection(current: Readonly<ModelSelection> | undefined, selection: Readonly<ModelSelection>): boolean {
  return current !== undefined && current.provider === selection.provider
    && current.model === selection.model && current.reasoningEffort === selection.reasoningEffort
}

/**
 * Whether an assistant message carries any non-blank content the continuation
 * could extend.
 * @param content - the settled assistant content blocks.
 * @returns true when a block is non-blank text or any other kind, such as reasoning or a tool call.
 */
function hasVisibleContent(content: readonly ContentBlock[]): boolean {
  return content.some(block => block.type !== 'text' || block.text.trim().length > 0)
}

/**
 * How much of the answer the model managed to write: the visible text's
 * length. A reply cut at the output limit carries no tool calls, because the
 * stream assembler drops them from a truncated reply, so text is the only
 * progress such a reply can show.
 * @param content - the settled assistant content blocks.
 * @returns characters of visible text, reasoning excluded.
 */
function visibleChars(content: readonly ContentBlock[]): number {
  return content.reduce((sum, block) => sum + (block.type === 'text' ? block.text.trim().length : 0), 0)
}

/**
 * Register the guard: track each session's latest assistant settlement and
 * steer a continuation at `agent/turn-stopping` when that settlement ended at
 * the output-token limit.
 * @param ctx - plugin context with the agent registry.
 * @param config - the deployment's continuation cap.
 */
export function apply(ctx: Context, config: Config): void {
  // Schemastery (`Config`) fills every defaulted field before apply runs; the cast records that runtime fact.
  const { maxContinuationsPerTurn, minVisibleChars, maxReasoningContinuationsPerTurn } = config as Required<Config>
  const latest = new Map<SessionId, LatestSettlement>()
  const continuations = new Map<SessionId, { turn: number; count: number }>()
  const reasoningContinuations = new Map<SessionId, { turn: number; count: number }>()
  /** The lowest-effort selection each pending reasoning continuation recorded, until the one it replaced is put back. */
  const lowered = new Map<SessionId, LoweredSelection>()

  /**
   * Record the route's lowest selectable effort for the agent's next step.
   * @param agent - the agent about to run a reasoning continuation.
   * @param signal - the stopping turn's cancellation signal, for the route lookup.
   */
  async function lowerEffort(agent: Agent, signal: AbortSignal): Promise<void> {
    const current = agent.model.current()
    /* v8 ignore next -- the stopping turn ran a request, so the agent has a selection */
    if (current === undefined) return
    let effort: ReasoningEffortId | undefined
    try {
      effort = lowestReasoningEffort(await ctx.llm.resolveModelInfo(current.provider, current.model, signal))
    } catch (_unresolvedRoute) {
      // The loop's own call preparation fails loud on a route it cannot resolve; the effort is a preference.
      return
    }
    if (effort === undefined) return
    const selection: ModelSelection = { provider: current.provider, model: current.model, reasoningEffort: effort }
    agent.model.select(selection)
    lowered.set(agent.id, { lowered: selection, replaced: current })
  }

  /**
   * Put back the selection a reasoning continuation replaced, unless a newer
   * choice already replaced the lowered one.
   * @param agent - the agent whose selection a reasoning continuation may have lowered.
   */
  function putBack(agent: Agent): void {
    const entry = lowered.get(agent.id)
    if (entry === undefined) return
    lowered.delete(agent.id)
    if (sameSelection(agent.model.current(), entry.lowered)) agent.model.select(entry.replaced)
  }

  ctx.on('session/event', (session, event) => {
    if (event.type === 'assistant/message') {
      const finish = expandAssistantStream(event.data.stream)
        .map(entry => entry.chunk)
        .find(chunk => chunk.type === 'finish')
      latest.set(session.id, {
        turn: event.data.turn,
        truncated: finish?.type === 'finish' && finish.reason.kind === 'max-tokens',
        hasContent: hasVisibleContent(event.data.message.content),
        visibleChars: visibleChars(event.data.message.content),
      })
    } else if (event.type === 'turn/start') {
      latest.delete(session.id)
      continuations.delete(session.id)
      reasoningContinuations.delete(session.id)
    }
  })

  ctx.on('agent/disposed', ({ agent }) => {
    latest.delete(agent.id)
    continuations.delete(agent.id)
    reasoningContinuations.delete(agent.id)
    lowered.delete(agent.id)
  })

  // The loop fixes a step's selection before its pre-step, so the step that
  // claims a reasoning continuation keeps the lowered selection and the steps
  // after it get the replaced one back.
  ctx.on('agent/pre-step', async ({ agent }, next): Promise<PreStepDecision> => {
    const decision = await next()
    putBack(agent)
    return decision
  })

  // A turn cancelled or failed before its continuation step never reaches that pre-step.
  ctx.on('agent/status', ({ agent, status }) => {
    if (status === 'idle') putBack(agent)
  })

  ctx.on('agent/turn-stopping', async ({ agent, turn, signal }) => {
    if (signal.aborted) return
    const settlement = latest.get(agent.id)
    if (settlement === undefined || settlement.turn !== turn || !settlement.truncated || !settlement.hasContent) return
    const used = continuations.get(agent.id)
    const count = used?.turn === turn ? used.count : 0
    if (count >= maxContinuationsPerTurn) {
      ctx.logger.info(`auto-continue: turn ${turn} of "${agent.id}" reached ${maxContinuationsPerTurn} continuations; stopping`)
      return
    }
    const cutBeforeAnswer = settlement.visibleChars < minVisibleChars
    if (cutBeforeAnswer) {
      const spent = reasoningContinuations.get(agent.id)
      const reasoningCount = spent?.turn === turn ? spent.count : 0
      if (reasoningCount >= maxReasoningContinuationsPerTurn) {
        ctx.logger.info(
          `auto-continue: turn ${turn} of "${agent.id}" was cut after ${settlement.visibleChars} visible characters again; `
          + 'the output cap is spent before the answer (a reasoning model\'s thinking counts against it). '
          + 'Raise maxTokens on the route or lower its reasoning budget.',
        )
        return
      }
      reasoningContinuations.set(agent.id, { turn, count: reasoningCount + 1 })
    }
    continuations.set(agent.id, { turn, count: count + 1 })
    // Consumed: the settlement that triggered this continuation must not
    // trigger again if the next step ends without an assistant message.
    latest.delete(agent.id)
    const text = cutBeforeAnswer ? REASONING_CONTINUATION_TEXT : CONTINUATION_TEXT
    agent.steer(createUserMessage({ content: [{ type: 'text', text }], source: CONTINUATION_SOURCE }))
    // The loop reads the selection for the continuation step only after this listener settles.
    if (cutBeforeAnswer) await lowerEffort(agent, signal)
  })
}
