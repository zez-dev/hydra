/**
 * Independent goal evaluation. When the model calls `update_goal` with
 * `action: complete`, one logged auxiliary model request judges the objective
 * against the session's recent tool results; a `not-yet` verdict denies the
 * completion with the evaluator's reasons, so the goal stays active and the
 * model reads what is missing. Human `/goal` completion never passes through
 * the tool registry and is not evaluated. When the workspace-changes seam is
 * mounted, the recorded file changes of earlier turns join the evidence. Named
 * exports preserve Loader injection metadata.
 * @module @deepseek-ai/dsh-goal-evaluator
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { auxiliaryRoute, createUserMessage, streamText } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import type { GoalView } from '@deepseek-ai/dsh-goal'
import { deadline, MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type { WorkspaceChanges, WorkspaceChangesSummary } from '@deepseek-ai/dsh-workspace-changes'
import { collectEvidence, EVALUATION_SYSTEM_PROMPT, parseVerdict, renderWorkspaceEvidence } from './evaluate.ts'
import type { GoalVerdict } from './types.ts'

export type * from './types.ts'
export { collectEvidence, EVALUATION_SYSTEM_PROMPT, parseVerdict, renderWorkspaceEvidence } from './evaluate.ts'

export const name = 'goal-evaluator'
export const inject = ['tools', 'llm', 'goals']

/** Timeout reason code for evaluation requests. */
export const GOAL_EVALUATION_TIMEOUT_CODE = 'GOAL_EVALUATION_TIMEOUT'

/** Tool whose `complete` action is gated. */
const UPDATE_GOAL = 'update_goal'

/**
 * Whether a value is a plain object with string keys.
 * @param value - the parsed tool arguments.
 * @returns true for a non-null, non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Per-result character cap in the evidence sent to the evaluator. */
const EVIDENCE_RESULT_CHARS = 2000

/** Evaluator configuration. */
export interface Config {
  /** How many most-recent tool results are sent as evidence. */
  evidenceEvents: number
  /** Files named per recorded turn of workspace changes; the rest are counted. Applies only when `workspaceChanges` is mounted. */
  maxWorkspaceChangeEntries: number
  /** Output-token cap for the evaluation request. */
  maxOutputTokens: number
  /** Deadline for one evaluation request, in milliseconds. */
  timeoutMs: number
  /** Explicit evaluator provider; configure with `model`. Omitted: the session's own logged route. */
  provider?: string
  /** Explicit evaluator model; configure with `provider`. Omitted: the session's own logged route. */
  model?: string
}

/** Schemastery configuration schema; evidence and budgets are required deployment choices. */
export const Config: z<Config> = z.object({
  evidenceEvents: z.natural().min(1).required(),
  maxWorkspaceChangeEntries: z.natural().min(1).required(),
  maxOutputTokens: z.natural().min(1).required(),
  timeoutMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).required(),
  provider: z.string(),
  model: z.string(),
})

/**
 * Run one logged evaluation request for the goal.
 * @param ctx - plugin context.
 * @param config - plugin configuration.
 * @param agent - the agent completing its goal.
 * @param goal - the current goal view.
 * @param observed - the session's tool call and result events observed live, in order.
 * @param workspace - recorded workspace-change summaries of earlier turns, oldest first.
 * @param signal - the tool call's cancellation.
 * @returns the parsed verdict, or `undefined` when the model's answer was not a verdict.
 * @throws when no route resolves or the request fails.
 */
export async function evaluateGoal(
  ctx: Context,
  config: Config,
  agent: Agent,
  goal: GoalView,
  observed: readonly SessionEvent[],
  workspace: readonly WorkspaceChangesSummary[],
  signal: AbortSignal,
): Promise<GoalVerdict | undefined> {
  const session = agent.session
  const route = auxiliaryRoute(config, session.requestHeader()?.config)
  if (route === undefined) throw new Error('goal-evaluator: no evaluation route; configure provider and model or log a request first')
  const evidence = collectEvidence(observed, config.evidenceEvents, EVIDENCE_RESULT_CHARS)
  const changes = renderWorkspaceEvidence(workspace, config.maxWorkspaceChangeEntries)
  const messages: Message[] = [createUserMessage({
    content: [{
      type: 'text',
      text: [
        `Objective: ${goal.objective}`,
        `Goal rounds used: ${goal.roundsStarted} of ${goal.maxGoalRounds}.`,
        evidence.length === 0 ? 'Evidence: no tool results were recorded in this session.' : `Evidence (most recent ${evidence.length} tool results):\n${evidence.map(line => `- ${line}`).join('\n')}`,
        ...changes.length === 0 ? [] : [`Workspace changes recorded in earlier turns:\n${changes.map(line => `- ${line}`).join('\n')}`],
        'Is the objective achieved?',
      ].join('\n'),
    }],
    source: { kind: 'plugin', plugin: 'dsh-goal-evaluator' },
  })]
  using callDeadline = deadline(signal, config.timeoutMs, GOAL_EVALUATION_TIMEOUT_CODE)
  const options: GenerateOptions = {
    provider: route.provider,
    model: route.model,
    messages,
    system: EVALUATION_SYSTEM_PROMPT,
    maxTokens: config.maxOutputTokens,
    sessionId: session.id,
    purpose: 'goal-evaluate',
    signal: callDeadline.signal,
  }
  session.append('session/goal-evaluation', {
    goalId: goal.id,
    revision: goal.revision,
    route,
    system: EVALUATION_SYSTEM_PROMPT,
    messages,
    maxTokens: config.maxOutputTokens,
  }, { ignorable: true })
  const text = await streamText(ctx.llm.stream(options), callDeadline.signal, {
    maxTokens: () => new Error('goal-evaluator: evaluation output reached maxOutputTokens'),
    toolCalls: () => new Error('goal-evaluator: evaluation model unexpectedly requested a tool'),
  })
  return parseVerdict(text)
}

/**
 * Install the `tools/pre-execute` gate on `update_goal` completions.
 * @param ctx - plugin context carrying `tools`, `llm`, and `goals`.
 * @param config - deployment configuration.
 */
export function apply(ctx: Context, config: Config): void {
  if ((config.provider === undefined) !== (config.model === undefined)) {
    throw new Error('goal-evaluator: provider and model must be configured together')
  }
  // Tool activity is observed live per session: the evidence never reads
  // session history synchronously. Only the last window that can matter is kept.
  const observed = new Map<SessionId, SessionEvent[]>()
  const keep = config.evidenceEvents * 2 + 2
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'tool/call' && event.type !== 'tool/result') return
    const events = observed.get(session.id) ?? []
    events.push(event)
    if (events.length > keep) events.splice(0, events.length - keep)
    observed.set(session.id, events)
  })
  // Recorded workspace changes are served by the deliverables seam for the
  // announcing event's sequence; the latest summary per turn is kept, and only
  // the turns that can still matter as evidence.
  const changes = new Map<SessionId, Map<number, WorkspaceChangesSummary>>()
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'workspace/changes') return
    // The recorder files the summary right after its own append returns, so a
    // lookup during publication is one step early; read it once the append settles.
    queueMicrotask(() => {
      const service: WorkspaceChanges | undefined = ctx.get('workspaceChanges')
      const summary = service?.summary(session.id, event.seq)
      if (summary === undefined) return
      const turns = changes.get(session.id) ?? new Map<number, WorkspaceChangesSummary>()
      turns.set(summary.turn, summary)
      for (const turn of [...turns.keys()].sort((a, b) => a - b).slice(0, Math.max(0, turns.size - keep))) turns.delete(turn)
      changes.set(session.id, turns)
    })
  })
  ctx.on('agent/disposed', ({ agent }) => {
    observed.delete(agent.id)
    changes.delete(agent.id)
  })
  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    if (exec.name !== UPDATE_GOAL || exec.agent === undefined) return next()
    const args = exec.arguments
    if (!isRecord(args) || args.action !== 'complete') return next()
    const goal = ctx.goals.get(exec.agent)
    if (goal === undefined) return next()
    let verdict: GoalVerdict | undefined
    try {
      const workspace = [...changes.get(exec.agent.id)?.values() ?? []].sort((a, b) => a.turn - b.turn)
      verdict = await evaluateGoal(ctx, config, exec.agent, goal, observed.get(exec.agent.id) ?? [], workspace, exec.signal)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { kind: 'deny', reason: `goal completion was not evaluated (${message}); the goal stays active — retry later or ask the user to complete it` }
    }
    if (verdict === undefined) {
      return { kind: 'deny', reason: 'goal completion was not accepted: the independent evaluation was unreadable; the goal stays active — retry later or ask the user to complete it' }
    }
    if (verdict.verdict === 'not-yet') {
      const reasons = verdict.reasons.length === 0 ? 'no reasons were given' : verdict.reasons.join('; ')
      return { kind: 'deny', reason: `independent evaluation says the goal is not yet achieved: ${reasons}. Continue working on it or report a concrete blocker with action blocked.` }
    }
    return next()
  })
}
