/**
 * Same-session goal-round driver over public agent, session, and goal services.
 * @module @deepseek-ai/dsh-goal-round-driver
 */

import { isDeepStrictEqual } from 'node:util'
import { FiberState } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { GoalMessageSource, GoalRef, GoalView } from '@deepseek-ai/dsh-goal'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, MessageId, MessageSource } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, UserMessage } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-subagent'
import { renderGoalRoundPrompt } from './prompt.ts'

export { renderGoalRoundPrompt } from './prompt.ts'

export const name = 'goal-round-driver'
export const inject = ['agents', 'goals', 'sessions']

/** Driver configuration. */
export interface Config {
  /**
   * Re-arm after a goal round that ends in a request or stream error, a
   * provider failure, or a max-tokens cut, instead of disarming. The delay
   * doubles per consecutive failure from `delayMs`; after `maxConsecutive`
   * consecutive failures the goal is blocked with reason
   * `transient-retries-exhausted` until a human resumes it. A successful
   * round resets the count. Omit to keep every such failure a disarm. A user
   * cancellation or explicit pause is never retried.
   */
  transientRetry?: {
    /** Delay before the first re-arm, in milliseconds. */
    delayMs: number
    /** Consecutive failures tolerated before blocking. */
    maxConsecutive: number
  } | undefined
}

/** Schemastery configuration schema. */
export const Config: z<Config> = z.object({
  transientRetry: z.union([
    z.object({
      delayMs: z.natural().min(1).required(),
      maxConsecutive: z.natural().min(1).required(),
    }),
    z.const(undefined),
  ]),
})

/** Blocker recorded when transient retries run out; `/goal resume` clears it. */
export const TRANSIENT_RETRIES_EXHAUSTED = 'transient-retries-exhausted'

/** Cap on the backoff exponent so the delay stays bounded. */
const MAX_BACKOFF_EXPONENT = 8

/** Identity reserved before a goal continuation enters the agent inbox. */
interface RoundIdentity {
  readonly goalId: GoalRef['id']
  readonly revision: number
  readonly round: number
}

/** One queued, claimed, or admitted goal message retained until whole-agent quiescence. */
interface RoundAttempt extends RoundIdentity {
  readonly messageId: MessageId
  readonly content: ContentBlock[]
  phase: 'queued' | 'claimed' | 'admitted'
  cancelled: boolean
  stale: boolean
}

/** Serialized process-local scheduling state for one exact Agent lifecycle. */
interface DriverState {
  readonly agent: Agent
  attempt: RoundAttempt | undefined
  competingQueued: boolean
  needsCheckpoint: boolean
  requested: boolean
  run: Promise<void> | undefined
  stopping: boolean
  /** Goal rounds that failed transiently since the last successful round. */
  consecutiveFailures: number
  /** Pending re-arm delay; the driver reserves nothing while it runs. */
  retryTimer: ReturnType<typeof setTimeout> | undefined
}

/** Whether a source identifies an automatic, positive-numbered goal round. */
function isGoalRoundSource(source: MessageSource): source is GoalMessageSource {
  return source.kind === 'goal' && source.round > 0
}

/** Compare a source to one reserved identity. */
function sameRound(source: GoalMessageSource, round: RoundIdentity): boolean {
  return source.goalId === round.goalId
    && source.revision === round.revision
    && source.round === round.round
}

/** Compare the complete queued record to the driver's reservation. */
function sameQueued(content: readonly ContentBlock[], source: MessageSource, attempt: RoundAttempt): boolean {
  return isGoalRoundSource(source) && sameRound(source, attempt) && isDeepStrictEqual(content, attempt.content)
}

/** Exact current ref for a view. */
function goalRef(goal: GoalView): GoalRef {
  return { id: goal.id, revision: goal.revision }
}

/** Human-readable unexpected values for logs. */
function renderThrown(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/** Install automatic same-session continuation and its race fences. */
export function apply(ctx: Context, config: Config = {}): void {
  const states = new Map<Agent, DriverState>()
  const retry = config.transientRetry
  // Releases drivers still joining subagents when the plugin unloads.
  const unloading = Promise.withResolvers<void>()

  /** Create state for an exact currently live agent. */
  function stateFor(agent: Agent): DriverState {
    const existing = states.get(agent)
    if (existing !== undefined) return existing
    const state: DriverState = {
      agent,
      attempt: undefined,
      competingQueued: false,
      needsCheckpoint: false,
      requested: false,
      run: undefined,
      stopping: false,
      consecutiveFailures: 0,
      retryTimer: undefined,
    }
    states.set(agent, state)
    return state
  }

  /** Read only when the exact Agent remains live. */
  function currentGoal(state: DriverState): GoalView | undefined {
    if (ctx.agents.get(state.agent.id) !== state.agent) return undefined
    return ctx.goals.get(state.agent)
  }

  /** Whether a goal may receive automatic rounds. */
  function drivable(goal: GoalView | undefined): goal is GoalView {
    return goal !== undefined && goal.phase === 'active' && goal.activation === 'armed'
  }

  /** Whether this exact lifecycle is quiescent with no competing prompt. */
  function readyToDrive(state: DriverState): boolean {
    return ctx.fiber.state === FiberState.ACTIVE
      && !state.stopping
      && ctx.agents.get(state.agent.id) === state.agent
      && state.agent.status === 'idle'
      && !state.competingQueued
      && state.retryTimer === undefined
  }

  /** Recheck every condition that an awaited checkpoint may have changed. */
  function readyAfterCheckpoint(state: DriverState): boolean {
    return readyToDrive(state) && !state.needsCheckpoint
  }

  /** Remove automatic authority while preserving the durable phase. */
  function disarm(state: DriverState): void {
    try {
      const goal = currentGoal(state)
      if (goal?.activation === 'armed') ctx.goals.disarm(state.agent)
    } catch (error: unknown) {
      ctx.logger.warn(`goal-round-driver: could not disarm agent "${state.agent.id}": ${renderThrown(error)}`)
    }
  }

  /** Drop a pending re-arm delay. */
  function clearRetry(state: DriverState): void {
    if (state.retryTimer === undefined) return
    clearTimeout(state.retryTimer)
    state.retryTimer = undefined
  }

  /**
   * Handle a goal round that ended in a transient failure: re-arm after a
   * backoff, or block once the consecutive budget is spent. Without retry
   * configuration the failure disarms the goal.
   */
  function failTransiently(state: DriverState, cause: string): void {
    if (retry === undefined || state.attempt === undefined) {
      disarm(state)
      return
    }
    const goal = currentGoal(state)
    if (goal === undefined || goal.phase !== 'active' || goal.activation !== 'armed') return
    state.consecutiveFailures += 1
    if (state.consecutiveFailures > retry.maxConsecutive) {
      state.consecutiveFailures = 0
      try {
        ctx.goals.block(state.agent, goalRef(goal), {
          code: TRANSIENT_RETRIES_EXHAUSTED,
          message: `${retry.maxConsecutive} consecutive goal rounds failed (last: ${cause}); resume the goal to continue.`,
        })
      } catch (error: unknown) {
        ctx.logger.warn(`goal-round-driver: could not block agent "${state.agent.id}" after exhausted retries: ${renderThrown(error)}`)
        disarm(state)
      }
      return
    }
    const delay = retry.delayMs * 2 ** Math.min(state.consecutiveFailures - 1, MAX_BACKOFF_EXPONENT)
    ctx.logger.warn(`goal-round-driver: goal round for agent "${state.agent.id}" failed (${cause}); re-arming in ${delay}ms (${state.consecutiveFailures}/${retry.maxConsecutive})`)
    clearRetry(state)
    state.retryTimer = setTimeout(() => {
      state.retryTimer = undefined
      requestDrive(state)
    }, delay)
  }

  /** Preserve claimed step context when this driver drops only its own round. */
  function restoreOtherClaimed(agent: Agent, messages: UserMessage[], messageId: MessageId): void {
    const retained = messages.filter(message => message.id !== messageId
      && !(message.source.kind === 'goal' && message.source.round === 0))
    for (const message of retained.toReversed()) {
      if (agent.inbox.nextStep.some(candidate => candidate.id === message.id)
        || agent.inbox.nextTurn.some(candidate => candidate.id === message.id)) continue
      agent.inbox.prepend('next-step', message)
    }
  }

  /** Process admitted work at quiescence, then reserve at most one next round. */
  async function drive(state: DriverState): Promise<void> {
    const { agent } = state
    if (!readyToDrive(state)) return

    if (state.needsCheckpoint) {
      state.needsCheckpoint = false
      try {
        await ctx.sessions.flush(agent.session)
      } catch (error: unknown) {
        ctx.logger.warn(`goal-round-driver: durability checkpoint failed for agent "${agent.id}": ${renderThrown(error)}`)
        disarm(state)
        return
      }
      // A mutation or ordinary prompt may have arrived while the checkpoint
      // was settling. Give it its own checkpoint / turn before reserving.
      if (!readyAfterCheckpoint(state)) return
    }

    const attempt = state.attempt
    if (attempt !== undefined) {
      state.attempt = undefined
      state.needsCheckpoint = true
      state.requested = true
      return
    }

    const goal = currentGoal(state)
    if (!drivable(goal)) return
    // A round started while descendants progress would only wait for them.
    // Every goal mutation requests a checkpoint, so passing the recheck
    // proves this goal view is still current.
    const subagents = ctx.get('subagents')
    if (subagents !== undefined) {
      await Promise.race([subagents.waitForChildren(agent), unloading.promise])
      if (!readyAfterCheckpoint(state)) return
    }
    if (goal.roundsStarted >= goal.maxGoalRounds) {
      ctx.goals.block(agent, goalRef(goal), {
        code: 'round-limit',
        message: `Goal reached its configured limit of ${goal.maxGoalRounds} rounds.`,
      })
      return
    }

    const round = goal.roundsStarted + 1
    const content = renderGoalRoundPrompt(goal, round)
    const message = createUserMessage({
      content,
      source: { kind: 'goal', goalId: goal.id, revision: goal.revision, round },
    })
    const reservation: RoundAttempt = {
      goalId: goal.id,
      revision: goal.revision,
      round,
      messageId: message.id,
      content,
      phase: 'queued',
      cancelled: false,
      stale: false,
    }
    state.attempt = reservation
    try {
      agent.followup(message)
    } catch (error: unknown) {
      state.attempt = undefined
      ctx.logger.warn(`goal-round-driver: could not queue round ${round} for agent "${agent.id}": ${renderThrown(error)}`)
      const latest = currentGoal(state)
      if (latest !== undefined && latest.id === goal.id && latest.revision === goal.revision
        && latest.phase === 'active' && latest.activation === 'armed') {
        ctx.goals.block(agent, goalRef(latest), {
          code: 'queue-failed',
          message: `Could not queue goal round ${round}: ${renderThrown(error)}`,
        })
      }
    }
  }

  /** Coalesce triggers onto one agent-local serialized driver. */
  function requestDrive(state: DriverState): void {
    /* v8 ignore next -- teardown may race a final trigger after synchronously closing the step fence */
    if (state.stopping) return
    state.requested = true
    if (state.run !== undefined) return
    let run: Promise<void>
    try {
      run = ctx.agents.withoutInitiator(async () => {
        while (state.requested && !state.stopping) {
          state.requested = false
          try {
            await drive(state)
          } catch (error: unknown) {
            ctx.logger.warn(`goal-round-driver: driver failed for agent "${state.agent.id}": ${renderThrown(error)}`)
            disarm(state)
          }
        }
      })
    } catch (error: unknown) {
      ctx.logger.warn(`goal-round-driver: could not start driver for agent "${state.agent.id}": ${renderThrown(error)}`)
      disarm(state)
      return
    }
    state.run = run
    const retire = (): void => {
      state.run = undefined
      if (state.requested && !state.stopping) requestDrive(state)
    }
    void run.then(retire, (error: unknown) => {
      ctx.logger.warn(`goal-round-driver: driver task rejected for agent "${state.agent.id}": ${renderThrown(error)}`)
      disarm(state)
      retire()
    })
  }

  // One composite effect keeps the step fence installed until this
  // plugin's own scheduling tasks settle.
  ctx.effect(function* () {
    ctx.on('agent/error', ({ agent, error }) => {
      const state = stateFor(agent)
      failTransiently(state, renderThrown(error))
    })

    ctx.on('agent/disposed', ({ agent }) => {
      const state = states.get(agent)
      if (state !== undefined) clearRetry(state)
      states.delete(agent)
    })
    ctx.on('agent/created', ({ agent }) => {
      const state = stateFor(agent)
      state.attempt = undefined
      state.competingQueued = false
      state.needsCheckpoint = false
    })
    ctx.on('agent/status', ({ agent, status }) => {
      const state = stateFor(agent)
      if (status === 'idle') {
        state.competingQueued = false
        const attempt = state.attempt
        const goal = currentGoal(state)
        // Fence the pause to the exact dropped attempt's ref. A resume bumps
        // the revision, so a host pause followed by an immediate resume (before
        // the aborted turn converges to idle) must not re-pause the resumed goal.
        const pause = attempt !== undefined
          && (attempt.phase === 'queued' || attempt.phase === 'claimed' || attempt.cancelled)
          && goal !== undefined && goal.phase === 'active' && goal.activation === 'armed'
          && attempt.goalId === goal.id && attempt.revision === goal.revision
        // A reservation still queued when the agent reaches idle cannot run:
        // withdraw it so human input queued behind it is not stranded.
        if (pause || attempt?.phase === 'queued') {
          state.attempt = undefined
          try {
            if (attempt.phase === 'queued') agent.inbox.remove(attempt.messageId)
            if (pause) ctx.goals.pause(agent, goalRef(goal))
          } catch (error: unknown) {
            ctx.logger.warn(`goal-round-driver: could not settle cancelled goal round for agent "${agent.id}": ${renderThrown(error)}`)
            disarm(state)
          }
        }
        requestDrive(state)
      }
    })
    ctx.on('goal/changed', ({ agent, change }) => {
      const state = stateFor(agent)
      state.needsCheckpoint = true
      // A host-initiated pause stops goal execution: abort the live turn so the
      // model cannot keep acting or resume in the same turn. A model-initiated
      // pause (update_goal inside its own turn) finishes normally.
      if (change.operation === 'pause' && agent.status === 'running'
        && ctx.agents.currentInitiator() !== agent) {
        agent.cancel({ kind: 'user' }, { keepInbox: true })
      }
      requestDrive(state)
    })

    ctx.on('agent/inbox/inserted', ({ agent, message }) => {
      if (!agent.inbox.nextTurn.some(candidate => candidate.id === message.id)) return
      const state = stateFor(agent)
      const attempt = state.attempt
      if (attempt !== undefined && sameQueued(message.content, message.source, attempt)) return
      state.competingQueued = true
      if (attempt?.phase === 'queued') attempt.stale = true
    })
    ctx.on('agent/inbox/claimed', ({ agent, message }) => {
      const state = stateFor(agent)
      const attempt = state.attempt
      if (attempt !== undefined && sameQueued(message.content, message.source, attempt)) {
        attempt.phase = 'claimed'
      }
    })
    ctx.on('agent/inbox/discarded', ({ agent, message }) => {
      const state = stateFor(agent)
      const attempt = state.attempt
      if (attempt !== undefined && sameQueued(message.content, message.source, attempt)) {
        attempt.cancelled = true
      }
    })

    ctx.on('session/event', (session: Session, event: SessionEvent) => {
      const agent = ctx.agents.get(session.id)
      if (agent === undefined || agent.session !== session) return
      const state = stateFor(agent)
      switch (event.type) {
        case 'user/message':
          if (state.attempt !== undefined && event.data.id === state.attempt.messageId) {
            state.attempt.phase = 'admitted'
          }
          return
        case 'turn/end':
          // The loop's own retry turn may succeed after a failed request
          // already scheduled a re-arm; the round is settled, so drop it.
          if (event.data.reason.kind === 'completed' && state.attempt?.phase === 'admitted') {
            state.consecutiveFailures = 0
            clearRetry(state)
            return
          }
          if (event.data.reason.kind === 'max-tokens') {
            failTransiently(state, 'max-tokens')
            return
          }
          if (event.data.reason.kind !== 'aborted') return
          if (state.attempt?.phase === 'claimed' || state.attempt?.phase === 'admitted') {
            state.attempt.cancelled = true
          }
          else disarm(state)
          return
        default:
          return
      }
    })

    /** Fail closed unless the queued prompt still owns the exact live revision. */
    function validReservation(
      state: DriverState,
      content: readonly ContentBlock[],
      source: GoalMessageSource,
    ): boolean {
      const attempt = state.attempt
      const goal = currentGoal(state)
      return ctx.fiber.state === FiberState.ACTIVE
        && !state.stopping && attempt !== undefined && attempt.phase === 'claimed'
      && !attempt.stale && sameQueued(content, source, attempt)
      && goal !== undefined && goal.id === source.goalId && goal.revision === source.revision
      && goal.phase === 'active' && goal.activation === 'armed'
      && source.round === goal.roundsStarted + 1
    }

    ctx.on('agent/pre-step', async ({ agent, messages, signal }, next): Promise<PreStepDecision> => {
      const submitted = messages.find((message): message is UserMessage & { source: GoalMessageSource } =>
        isGoalRoundSource(message.source))
      if (submitted === undefined) return next()
      const { content, source } = submitted
      const state = stateFor(agent)
      let valid = false
      try {
        valid = validReservation(state, content, source)
      } catch (error: unknown) {
        ctx.logger.warn(`goal-round-driver: pre-step check failed for agent "${agent.id}": ${renderThrown(error)}`)
        disarm(state)
      }
      if (!valid) {
        const attempt = state.attempt
        if (attempt !== undefined && sameRound(source, attempt)) {
          attempt.stale = true
          state.attempt = undefined
        }
        restoreOtherClaimed(agent, messages, submitted.id)
        requestDrive(state)
        return { kind: 'reject' }
      }
      let decision: PreStepDecision
      try {
        decision = await next()
      } catch (error: unknown) {
        if (signal.aborted) throw error
        // A throwing downstream hook drops the whole step proposal. Clear the
        // reservation before the balanced no-step turn returns to idle so the
        // next drive pass can reschedule the round.
        state.attempt = undefined
        requestDrive(state)
        throw error
      }
      if (signal.aborted) {
        if (decision.kind === 'enter') restoreOtherClaimed(agent, decision.messages, submitted.id)
        return decision
      }
      if (decision.kind === 'reject') {
        state.attempt = undefined
        const goal = currentGoal(state)
        if (goal !== undefined && goal.id === source.goalId && goal.revision === source.revision
          && goal.phase === 'active' && goal.activation === 'armed') {
          ctx.goals.block(agent, goalRef(goal), {
            code: 'prompt-rejected',
            message: 'Goal round was rejected before entering its step.',
          })
        }
        return decision
      }
      try {
        valid = validReservation(state, content, source)
      } catch (error: unknown) {
        ctx.logger.warn(`goal-round-driver: post-decision check failed for agent "${agent.id}": ${renderThrown(error)}`)
        disarm(state)
        valid = false
      }
      if (!valid) {
        state.attempt = undefined
        restoreOtherClaimed(agent, decision.messages, submitted.id)
        requestDrive(state)
        return { kind: 'reject' }
      }
      return { ...decision, startsRequestSeries: true }
    })

    // Loading a lifecycle driver over existing agents never inherits hidden
    // automatic authority from an earlier producer instance.
    for (const agent of ctx.agents.list()) {
      const state = stateFor(agent)
      disarm(state)
    }

    // Yielded after listener registration, so this close runs first and the
    // composite effect removes listeners only after its promise settles.
    yield async () => {
      unloading.resolve()
      const waits: Promise<void>[] = []
      for (const state of states.values()) {
        state.stopping = true
        clearRetry(state)
        disarm(state)
        const attempt = state.attempt
        if (attempt !== undefined) {
          attempt.stale = true
          /* v8 ignore next -- followup reserves the live agent before publishing a queued attempt */
          if (state.agent.status === 'running') {
            state.agent.cancel({ kind: 'parent' })
            waits.push(state.agent.whenIdle())
          }
        }
        if (state.run !== undefined) waits.push(state.run)
      }
      await Promise.allSettled(waits)
      states.clear()
    }
  }, 'goal-round-driver lifecycle')
}
