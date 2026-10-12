/**
 * Goal supervision across restarts. At activation the plugin lists stored
 * sessions, folds each log for an active goal, and resumes up to
 * `maxConcurrent` of them through the agent registry so a mounted
 * `dsh-goal-resume-on-open` can re-arm them under its policy. A required
 * `dailyRoundBudget` bounds spend: a stored goal that already ran that many
 * rounds since local midnight is not resumed, and a live goal that exceeds it
 * is paused. `/goals` lists live goals with their rounds today. Named exports
 * preserve Loader injection metadata.
 * @module @deepseek-ai/dsh-goal-supervisor
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { AgentSetup } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
// Type-only: resolves the optional `agentPresets` and `agentDefaultModel` declarations.
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-session-query'
import { isUnlimitedGoalRounds } from '@deepseek-ai/dsh-goal'
import { activeGoalOf, localMidnight, planSupervision, roundsSince } from './supervise.ts'
import type { SupervisionCandidate } from './supervise.ts'

export type { SupervisionCandidate, SupervisionLimits, SupervisionPlan } from './supervise.ts'
export { activeGoalOf, localMidnight, planSupervision, roundsSince } from './supervise.ts'

export const name = 'goal-supervisor'
export const inject = ['agents', 'sessionQuery', 'goals', 'commands', 'sessions']

/** Supervisor configuration: the concurrency cap is required; the daily budget is optional (absent means unlimited). */
export interface Config {
  /** Maximum stored sessions with active goals resumed at activation. */
  maxConcurrent: number
  /**
   * Goal rounds one goal may run per local day before it is paused. A paused
   * goal resumes by itself at the next local midnight. Omit for no budget.
   */
  dailyRoundBudget?: number
}

/** Schemastery configuration schema. */
export const Config: z<Config> = z.object({
  maxConcurrent: z.natural().min(1).required(),
  dailyRoundBudget: z.natural().min(1),
})

/**
 * The text a log line shows for a thrown value.
 * @param error - the value a `catch` or rejection handler received.
 * @returns the message of an `Error`, else the value as a string.
 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Collect stored, non-live sessions whose folded goal is active.
 * @param ctx - context carrying `sessionQuery`.
 * @param now - epoch milliseconds used for the daily window.
 * @param signal - cancellation for the listing and reads.
 * @returns candidates in listing order.
 */
async function findCandidates(ctx: Context, now: number, signal: AbortSignal): Promise<SupervisionCandidate[]> {
  const since = localMidnight(now)
  const candidates: SupervisionCandidate[] = []
  for (const record of await ctx.sessionQuery.listSessions(signal)) {
    if (record.live || !record.persisted) continue
    signal.throwIfAborted()
    let events
    let goal
    try {
      events = (await ctx.sessionQuery.readSession(record.header.id)).events
      goal = activeGoalOf(events)
    } catch (error) {
      ctx.logger.warn(`goal-supervisor: skipping unreadable session "${record.header.id}": ${errorMessage(error)}`)
      continue
    }
    if (goal === undefined) continue
    candidates.push({ sessionId: record.header.id, objective: goal.objective, roundsToday: roundsSince(events, since) })
  }
  return candidates
}

/**
 * Resume one stored session the way the Web session controller does: through
 * the agent registry, with the deployment's current default model and the
 * session's recorded agent preset when a preset service is mounted.
 * @param ctx - context carrying `agents` and optionally `agentPresets` and `agentDefaultModel`.
 * @param sessionId - the stored session.
 * @param signal - cancellation for the load.
 */
async function resumeStored(ctx: Context, sessionId: SessionId, signal: AbortSignal): Promise<void> {
  const presets = ctx.get('agentPresets')
  const defaultModel = ctx.get('agentDefaultModel')
  let setup: AgentSetup | undefined
  if (presets !== undefined) {
    const header = (await ctx.sessionQuery.readSession(sessionId)).session
    const resolved = await presets.resolve(header.agentPreset)
    setup = async (agentCtx) => { await presets.mount(agentCtx, resolved.id) }
  }
  const selection = defaultModel?.currentSelection()
  await ctx.agents.resume({
    resumeSessionId: sessionId,
    ...selection === undefined ? {} : { agentOptions: { provider: selection.provider, model: selection.model } },
    ...setup === undefined ? {} : { setup },
    signal,
  })
}

/**
 * Run the boot-time plan: list, fold, and resume under the limits.
 * @param ctx - plugin context.
 * @param config - the limits.
 * @param signal - activation-scoped cancellation.
 */
async function supervise(ctx: Context, config: Config, signal: AbortSignal): Promise<void> {
  const candidates = await findCandidates(ctx, Date.now(), signal)
  const plan = planSupervision(candidates, config)
  for (const candidate of plan.overBudget) {
    ctx.logger.warn(`goal-supervisor: not resuming "${candidate.sessionId}" until midnight: ${candidate.roundsToday} goal rounds today reached the budget of ${String(config.dailyRoundBudget)}`)
  }
  for (const candidate of plan.deferred) {
    ctx.logger.info(`goal-supervisor: deferring "${candidate.sessionId}" (maxConcurrent ${config.maxConcurrent} reached)`)
  }
  for (const candidate of plan.resume) {
    signal.throwIfAborted()
    try {
      await resumeStored(ctx, candidate.sessionId, signal)
      ctx.logger.info(`goal-supervisor: resumed "${candidate.sessionId}" for goal "${candidate.objective}"`)
    } catch (error) {
      ctx.logger.warn(`goal-supervisor: could not resume "${candidate.sessionId}": ${errorMessage(error)}`)
    }
  }
}

/**
 * Start one supervision pass without awaiting it; a failure is logged unless
 * the pass was cancelled.
 * @param ctx - plugin context.
 * @param config - the limits.
 * @param signal - cancellation owned by the effect that started the pass.
 * @param label - names the pass in the failure log line.
 */
function superviseInBackground(ctx: Context, config: Config, signal: AbortSignal, label: string): void {
  void supervise(ctx, config, signal).catch((error: unknown) => {
    if (signal.aborted) return
    ctx.logger.warn(`goal-supervisor: ${label} failed: ${errorMessage(error)}`)
  })
}

/**
 * Goal-round admission times per live session, observed live and seeded from
 * the stored log when a session is resumed, so no reader touches session
 * history synchronously.
 */
class RoundLedger {
  private readonly times = new Map<SessionId, number[]>()

  /**
   * Record one admitted round.
   * @param sessionId - the session.
   * @param time - admission time in epoch milliseconds.
   */
  record(sessionId: SessionId, time: number): void {
    const times = this.times.get(sessionId) ?? []
    times.push(time)
    this.times.set(sessionId, times)
  }

  /**
   * Replace the session's ledger with times from its stored log.
   * @param sessionId - the session.
   * @param events - the stored events.
   */
  seed(sessionId: SessionId, events: readonly SessionEvent[]): void {
    const live = this.times.get(sessionId) ?? []
    const stored = events.filter(event => event.type === 'user/message' && event.data.source.kind === 'goal').map(event => event.time)
    this.times.set(sessionId, [...stored, ...live.filter(time => !stored.includes(time))])
  }

  /**
   * Rounds admitted since local midnight.
   * @param sessionId - the session.
   * @param now - epoch milliseconds.
   * @returns the count.
   */
  today(sessionId: SessionId, now: number): number {
    const since = localMidnight(now)
    return (this.times.get(sessionId) ?? []).filter(time => time >= since).length
  }

  /**
   * Forget a session.
   * @param sessionId - the disposed session.
   */
  forget(sessionId: SessionId): void {
    this.times.delete(sessionId)
  }
}

/**
 * Pause a live goal whose rounds today exceed the budget.
 * @param ctx - plugin context.
 * @param config - the limits.
 * @param rounds - live goal-round ledger.
 * @param session - the session that admitted a goal round.
 */
function enforceBudget(ctx: Context, config: Config, rounds: RoundLedger, session: Session, budgetPaused: Set<SessionId>): void {
  if (config.dailyRoundBudget === undefined) return
  const agent = ctx.agents.get(session.id)
  if (agent === undefined) return
  const today = rounds.today(session.id, Date.now())
  if (today <= config.dailyRoundBudget) return
  let goal
  try {
    goal = ctx.goals.get(agent)
    if (goal === undefined || goal.phase !== 'active') return
    ctx.goals.pause(agent, { id: goal.id, revision: goal.revision })
  } catch (error) {
    ctx.logger.warn(`goal-supervisor: could not pause the goal of "${session.id}": ${errorMessage(error)}`)
    return
  }
  budgetPaused.add(session.id)
  ctx.logger.warn(`goal-supervisor: paused goal "${goal.id}" of "${session.id}" until midnight: ${today} rounds today exceed the budget of ${config.dailyRoundBudget}`)
}

/** Milliseconds in one day, for the midnight timer. */
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Re-arm every live goal this plugin paused for budget; a goal a human moved
 * elsewhere since is left alone.
 * @param ctx - plugin context.
 * @param budgetPaused - sessions paused for budget, cleared as they resume.
 */
function resumeBudgetPaused(ctx: Context, budgetPaused: Set<SessionId>): void {
  for (const sessionId of [...budgetPaused]) {
    budgetPaused.delete(sessionId)
    const agent = ctx.agents.get(sessionId)
    if (agent === undefined) continue
    let goal
    try {
      goal = ctx.goals.get(agent)
      if (goal === undefined || goal.phase !== 'paused') continue
      ctx.goals.resume(agent, { id: goal.id, revision: goal.revision })
    } catch (error) {
      ctx.logger.warn(`goal-supervisor: could not resume the goal of "${sessionId}": ${errorMessage(error)}`)
      continue
    }
    ctx.logger.info(`goal-supervisor: resumed goal "${goal.id}" of "${sessionId}" after the daily budget reset`)
  }
}

/**
 * Render the `/goals` listing over live agents.
 * @param ctx - plugin context.
 * @param config - the limits, for the budget column.
 * @param rounds - live goal-round ledger.
 * @returns the command result.
 */
function listGoals(ctx: Context, config: Config, rounds: RoundLedger): CommandResult {
  const now = Date.now()
  const lines: string[] = []
  for (const agent of ctx.agents.list()) {
    const goal = ctx.goals.get(agent)
    if (goal === undefined) continue
    const today = rounds.today(agent.id, now)
    const budget = config.dailyRoundBudget === undefined ? 'unlimited' : String(config.dailyRoundBudget)
    const cap = isUnlimitedGoalRounds(goal.maxGoalRounds) ? 'unlimited' : String(goal.maxGoalRounds)
    lines.push(`${agent.id}: [${goal.phase}${goal.activation === 'armed' ? ', armed' : ''}] ${goal.objective} — rounds today ${today}/${budget}, total ${goal.roundsStarted}/${cap}`)
  }
  return { kind: 'success', text: lines.length === 0 ? 'No live sessions carry a goal.' : lines.join('\n') }
}

/**
 * Install boot-time supervision, live budget enforcement, and the `/goals` command.
 * @param ctx - plugin context carrying `agents`, `sessionQuery`, `goals`, `commands`, and `sessions`.
 * @param config - the limits.
 */
export function apply(ctx: Context, config: Config): void {
  const rounds = new RoundLedger()
  ctx.on('agent/disposed', ({ agent }) => { rounds.forget(agent.id) })
  ctx.on('agent/created', ({ agent, source }) => {
    if (source !== 'resume') return
    void ctx.sessionQuery.readSession(agent.id).then(
      (snapshot) => { rounds.seed(agent.id, snapshot.events) },
      (error: unknown) => { ctx.logger.warn(`goal-supervisor: could not seed rounds for "${agent.id}": ${errorMessage(error)}`) },
    )
  })
  ctx.effect(() => {
    const controller = new AbortController()
    superviseInBackground(ctx, config, controller.signal, 'supervision')
    return () => { controller.abort() }
  })
  // The round's own append is still publishing when the event arrives, and a
  // pause appends too, so enforcement runs after the current publication.
  const pending = new Set<ReturnType<typeof setTimeout>>()
  ctx.effect(() => () => {
    for (const timer of pending) clearTimeout(timer)
    pending.clear()
  })
  const budgetPaused = new Set<SessionId>()
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'user/message' || event.data.source.kind !== 'goal') return
    rounds.record(session.id, event.time)
    const timer = setTimeout(() => {
      pending.delete(timer)
      enforceBudget(ctx, config, rounds, session, budgetPaused)
    }, 0)
    pending.add(timer)
  })
  if (config.dailyRoundBudget !== undefined) {
    ctx.effect(() => {
      // Assigned by the schedule() call below, before any disposer can run.
      let timer: ReturnType<typeof setTimeout>
      const controller = new AbortController()
      const schedule = (): void => {
        const now = Date.now()
        timer = setTimeout(() => {
          resumeBudgetPaused(ctx, budgetPaused)
          superviseInBackground(ctx, config, controller.signal, 'midnight supervision')
          schedule()
        }, localMidnight(now) + DAY_MS - now)
      }
      schedule()
      return () => {
        controller.abort()
        clearTimeout(timer)
      }
    })
  }
  ctx.effect(() => ctx.commands.register({
    name: 'goals',
    description: 'List live goals with their rounds today against the daily budget',
    handler: (_invocation: CommandInvocation) => listGoals(ctx, config, rounds),
  }))
}
