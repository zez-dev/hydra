/**
 * End-of-turn evidence review: when a completed turn read part of a file and
 * left many lines unread, changed files without a check command after the last
 * change, or made many tool calls, steer one review request at
 * `agent/turn-stopping`. The request names each finding, asks the model to
 * check its claims against what it read or ran, and ends by asking for the
 * complete final answer again. It is an ordinary logged user message with a
 * plugin source. Subagent sessions, turns a tool concluded, and stops another
 * listener already steered are left alone, and a per-turn cap bounds reviews.
 * Named exports preserve Loader injection metadata.
 * @module @deepseek-ai/dsh-evidence-guard/review
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed, MessageSource, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
// Also resolves the `agent/turn-stopping` and `agent/disposed` declarations.
import type {} from '@deepseek-ai/dsh-agent'
// Resolves the `tools/result` event declaration.
import type {} from '@deepseek-ai/dsh-tools'
// Resolves the `tool/ptc-dispatch` session event declaration.
import type {} from '@deepseek-ai/dsh-tool-executor-ptc'
import {
  changedFile, collectFindings, createTurnEvidence, readWindow, recordChange, recordCheck, recordRead, renderReview,
  shellCommand, type TurnEvidence,
} from './findings.ts'

export const name = 'evidence-review'
export const inject = ['agents']

/** Evidence-review configuration. */
export interface Config {
  /**
   * A partly read file is a finding only when at least this many of its lines
   * went unread. Defaults to `20`, so a short unread tail does not trigger a
   * review.
   */
  minUnreadLines?: number
  /**
   * A turn with at least this many tool calls, PTC sub-calls included, is
   * reviewed even without other findings. Defaults to `6`.
   */
  reviewAfterToolCalls?: number
  /**
   * Regular expressions (JavaScript syntax, case-insensitive) a `bash` or
   * `pwsh` command must match to count as a check that follows a change.
   * Defaults to {@link DEFAULT_CHECK_COMMAND_PATTERNS}.
   */
  checkCommandPatterns?: string[]
  /**
   * Reviews steered within one turn. Each review costs one model request over
   * the whole context; `0` turns the review off. Defaults to `1`.
   */
  maxReviewsPerTurn?: number
}

/** Command words that count as a test, build, lint, or type check. */
export const DEFAULT_CHECK_COMMAND_PATTERNS: readonly string[] = [
  String.raw`\b(?:test|tests|lint|typecheck|type-check|build|check|verify)\b`,
  String.raw`\b(?:tsc|vitest|jest|mocha|pytest|unittest|mypy|ruff|flake8|eslint|oxlint|clippy|vet)\b`,
  String.raw`\b(?:make|gradle|gradlew|mvn|xcodebuild|swift|dotnet|cargo|bazel)\b`,
]

/** Schemastery configuration for the evidence review. */
export const Config: z<Config> = z.object({
  minUnreadLines: z.natural().min(1).default(20),
  reviewAfterToolCalls: z.natural().min(1).default(6),
  checkCommandPatterns: z.array(z.string()).default([...DEFAULT_CHECK_COMMAND_PATTERNS]),
  maxReviewsPerTurn: z.natural().default(1),
})

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /**
     * The review request this guard steers before a turn ends.
     * @persistenceAttribution
     */
    'plugin:dsh-evidence-guard': { kind: 'plugin:dsh-evidence-guard' } & ContextFormed
  }
}

/** Source kind stamped on every review request. */
export const REVIEW_SOURCE_KIND = 'plugin:dsh-evidence-guard'

/** Tools whose `command` argument can run a check. */
const SHELL_TOOLS: ReadonlySet<string> = new Set(['bash', 'pwsh'])

/** What the guard remembers about one session's current turn. */
interface TurnState {
  readonly turn: number
  readonly evidence: TurnEvidence
  /** Top-level calls awaiting their results, by call id. */
  readonly calls: Map<ToolCallId, { name: string; args: unknown }>
  /** A tool concluded the turn, so the turn stops on purpose. */
  concluded: boolean
  reviews: number
}

/**
 * Whether a session belongs to a top-level conversation the user reads.
 * @param session - the agent's session.
 * @returns false for subagent and delegated sessions.
 */
function topLevel(session: Session): boolean {
  const { origin, delegationDepth } = session.header
  return origin !== 'subagent' && (delegationDepth ?? 0) === 0
}

/**
 * Parse a logged call's raw arguments.
 * @param raw - the argument JSON exactly as the model produced it.
 * @returns the parsed value, or `undefined` when the model produced invalid JSON.
 */
function parseArguments(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch (_malformed) {
    // A malformed call is refused by the tool pipeline; it carries no command to classify.
    return undefined
  }
}

/**
 * Compile the configured check patterns.
 * @param patterns - pattern sources from configuration.
 * @returns the compiled, case-insensitive expressions.
 * @throws {Error} naming the first pattern that is not a valid regular expression.
 */
function compilePatterns(patterns: readonly string[]): RegExp[] {
  return patterns.map((source) => {
    try {
      return new RegExp(source, 'i')
    } catch (cause) {
      throw new Error(`evidence-review: checkCommandPatterns entry ${JSON.stringify(source)} is not a valid regular expression`, { cause })
    }
  })
}

/**
 * Register the review: fold each session's logged tool activity into the
 * current turn's evidence, and steer one review request at
 * `agent/turn-stopping` when the evidence warrants it.
 * @param ctx - plugin context with the agent registry.
 * @param config - the deployment's review thresholds and cap.
 */
export function apply(ctx: Context, config: Config): void {
  // Schemastery (`Config`) fills every defaulted field before apply runs; the cast records that runtime fact.
  const { minUnreadLines, reviewAfterToolCalls, checkCommandPatterns, maxReviewsPerTurn } = config as Required<Config>
  const checks = compilePatterns(checkCommandPatterns)
  const states = new Map<SessionId, TurnState>()

  const isCheck = (args: unknown): boolean => {
    const command = shellCommand(args)
    return command !== undefined && checks.some(pattern => pattern.test(command))
  }

  /**
   * Fold one settled call into the turn's evidence.
   * @param evidence - the turn's evidence record.
   * @param tool - the called tool's name.
   * @param args - the call's parsed arguments.
   * @param meta - the result's durable presentation payload.
   */
  function settle(evidence: TurnEvidence, tool: string, args: unknown, meta: unknown): void {
    if (tool === 'read') {
      const window = readWindow(meta)
      if (window !== undefined) recordRead(evidence, window.path, window.range, window.totalLines)
    } else if (tool === 'edit' || tool === 'write') {
      const changed = changedFile(meta)
      if (changed !== undefined) recordChange(evidence, changed.path, changed.whole)
    } else if (SHELL_TOOLS.has(tool) && isCheck(args)) {
      recordCheck(evidence)
    }
  }

  /**
   * Apply one logged session event to the session's current turn.
   * @param session - the session that logged the event.
   * @param event - the logged event.
   */
  function observe(session: Session, event: SessionEvent): void {
    if (event.type === 'turn/start') {
      states.set(session.id, { turn: event.data.turn, evidence: createTurnEvidence(), calls: new Map(), concluded: false, reviews: 0 })
      return
    }
    const state = states.get(session.id)
    if (state === undefined) return
    if (event.type === 'tool/call') {
      state.evidence.toolCalls += 1
      state.calls.set(event.data.callId, { name: event.data.name, args: parseArguments(event.data.arguments) })
    } else if (event.type === 'tool/result') {
      const { callId } = event.data.message.source
      const call = state.calls.get(callId)
      state.calls.delete(callId)
      if (call !== undefined && !event.data.message.isError) settle(state.evidence, call.name, call.args, event.data.meta)
    } else if (event.type === 'tool/ptc-dispatch') {
      state.evidence.toolCalls += 1
      if (!event.data.isError) settle(state.evidence, event.data.name, event.data.arguments, event.data.meta)
    }
  }

  ctx.on('session/event', observe)

  ctx.on('tools/result', (exec, result) => {
    if (result.concludesTurn !== true || exec.agent === undefined) return
    const state = states.get(exec.agent.id)
    if (state !== undefined) state.concluded = true
  })

  ctx.on('agent/disposed', ({ agent }) => {
    states.delete(agent.id)
  })

  ctx.on('agent/turn-stopping', ({ agent, turn, signal }) => {
    if (signal.aborted || !topLevel(agent.session)) return
    const state = states.get(agent.id)
    if (state === undefined || state.turn !== turn || state.concluded || state.reviews >= maxReviewsPerTurn) return
    // Another listener already continues this turn; the review waits for the next stop.
    if (agent.inbox.nextStep.length > 0) return
    const findings = collectFindings(state.evidence, { minUnreadLines, reviewAfterToolCalls })
    if (findings === undefined) return
    state.reviews += 1
    const source: MessageSource = { kind: REVIEW_SOURCE_KIND, form: 'notice', summary: 'Evidence check before the final answer' }
    agent.steer(createUserMessage({ content: [{ type: 'text', text: renderReview(findings) }], source }))
  })
}
