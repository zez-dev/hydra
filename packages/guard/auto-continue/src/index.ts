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
import type { ContentBlock, LlmCallConfig, MessageSource, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
// Type-only: resolves the `agent/turn-stopping` and `agent/status` declarations.
import type {} from '@deepseek-ai/dsh-agent'

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

/** Source stamped on every continuation message the guard steers. */
export const CONTINUATION_SOURCE: MessageSource = { kind: 'plugin', plugin: 'dsh-auto-continue' }

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
  /** Agents whose next request is a reasoning continuation, so it asks for the lowest effort. */
  const lowEffortNext = new Set<SessionId>()
  /**
   * The effort each lowered request replaced, put back on the agent's next
   * request: the lowered effort is logged in that request's header, and the
   * loop and the Web selection seed later requests from the logged header.
   */
  const restoreEffort = new Map<SessionId, { lowered: ReasoningEffortId; replaced: ReasoningEffortId | undefined }>()

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
      lowEffortNext.delete(session.id)
    }
  })

  ctx.on('agent/disposed', ({ agent }) => {
    latest.delete(agent.id)
    continuations.delete(agent.id)
    reasoningContinuations.delete(agent.id)
    lowEffortNext.delete(agent.id)
    restoreEffort.delete(agent.id)
  })

  // A reasoning continuation's request asks for the route's lowest effort;
  // the effort rides the logged request header like any other call setting,
  // so the next request puts back the effort it replaced unless the chain
  // now proposes a different one, which is a newer choice.
  ctx.on('agent/request', async ({ agent, signal }, next): Promise<LlmCallConfig> => {
    const resolved = await next()
    // A cancelled request is discarded, so it neither lowers an effort nor puts one back.
    if (signal.aborted) return resolved
    const restore = restoreEffort.get(agent.id)
    if (!lowEffortNext.delete(agent.id)) {
      if (restore === undefined) return resolved
      restoreEffort.delete(agent.id)
      if (resolved.reasoningEffort !== restore.lowered) return resolved
      const { reasoningEffort: _lowered, ...rest } = resolved
      return restore.replaced === undefined ? rest : { ...rest, reasoningEffort: restore.replaced }
    }
    let effort: ReasoningEffortId | undefined
    try {
      effort = lowestReasoningEffort(await ctx.llm.resolveModelInfo(resolved.provider, resolved.model, signal))
    } catch (_unresolvedRoute) {
      // The loop's own call preparation fails loud on a route it cannot resolve; the effort is a preference.
      return resolved
    }
    if (effort === undefined) return resolved
    // A second lowering before the first was put back keeps the effort the first one replaced.
    restoreEffort.set(agent.id, { lowered: effort, replaced: restore === undefined ? resolved.reasoningEffort : restore.replaced })
    return { ...resolved, reasoningEffort: effort }
  })

  ctx.on('agent/turn-stopping', ({ agent, turn, signal }) => {
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
      lowEffortNext.add(agent.id)
    }
    continuations.set(agent.id, { turn, count: count + 1 })
    // Consumed: the settlement that triggered this continuation must not
    // trigger again if the next step ends without an assistant message.
    latest.delete(agent.id)
    const text = cutBeforeAnswer ? REASONING_CONTINUATION_TEXT : CONTINUATION_TEXT
    agent.steer(createUserMessage({ content: [{ type: 'text', text }], source: CONTINUATION_SOURCE }))
  })
}
