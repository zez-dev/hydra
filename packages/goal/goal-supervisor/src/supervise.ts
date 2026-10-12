/**
 * Pure supervision helpers: find the active goal in a stored log, count admitted goal rounds since a
 * point in time, and plan which stored sessions to resume under the concurrency cap and daily budget.
 * @module
 */

import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { foldGoal } from '@deepseek-ai/dsh-goal'
import type { GoalSnapshot } from '@deepseek-ai/dsh-goal'

/** One stored session with an active goal, as seen at boot. */
export interface SupervisionCandidate {
  /** The stored session. */
  readonly sessionId: SessionId
  /** The active goal's objective. */
  readonly objective: string
  /** Goal rounds admitted since local midnight. */
  readonly roundsToday: number
}

/** The boot-time plan over every candidate. */
export interface SupervisionPlan {
  /** Candidates to resume now, in candidate order, at most `maxConcurrent`. */
  readonly resume: readonly SupervisionCandidate[]
  /** Candidates whose rounds today already reached the daily budget; never resumed. */
  readonly overBudget: readonly SupervisionCandidate[]
  /** Candidates within budget that did not fit under the concurrency cap. */
  readonly deferred: readonly SupervisionCandidate[]
}

/** The spend limits: a required concurrency cap and an optional daily budget. */
export interface SupervisionLimits {
  /** Maximum stored sessions resumed at boot. */
  readonly maxConcurrent: number
  /** Goal rounds one goal may run per local day; absent means unlimited. */
  readonly dailyRoundBudget?: number
}

/**
 * Fold a stored log and return its goal when the goal is active.
 * @param events - the session's events in sequence order.
 * @returns the active goal snapshot, or `undefined` when there is no goal or it is not active.
 */
export function activeGoalOf(events: readonly SessionEvent[]): GoalSnapshot | undefined {
  const folded = foldGoal(events)
  return folded.goal?.phase === 'active' ? folded.goal : undefined
}

/**
 * Count goal rounds admitted at or after `since`: each is a `user/message` whose source kind is `goal`.
 * @param events - the session's events in sequence order.
 * @param since - epoch milliseconds; earlier rounds are ignored.
 * @returns the number of qualifying rounds.
 */
export function roundsSince(events: readonly SessionEvent[], since: number): number {
  let count = 0
  for (const event of events) {
    if (event.type !== 'user/message' || event.time < since) continue
    if (event.data.source.kind === 'goal') count += 1
  }
  return count
}

/**
 * Local midnight preceding `now`.
 * @param now - epoch milliseconds.
 * @returns epoch milliseconds of the most recent local midnight.
 */
export function localMidnight(now: number): number {
  const date = new Date(now)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/**
 * Split candidates into resume, over-budget, and deferred sets.
 * @param candidates - stored sessions with active goals, in the order they were listed.
 * @param limits - the concurrency cap and daily budget.
 * @returns the plan; `resume` preserves candidate order.
 */
export function planSupervision(candidates: readonly SupervisionCandidate[], limits: SupervisionLimits): SupervisionPlan {
  const resume: SupervisionCandidate[] = []
  const overBudget: SupervisionCandidate[] = []
  const deferred: SupervisionCandidate[] = []
  for (const candidate of candidates) {
    if (limits.dailyRoundBudget !== undefined && candidate.roundsToday >= limits.dailyRoundBudget) {
      overBudget.push(candidate)
    } else if (resume.length < limits.maxConcurrent) {
      resume.push(candidate)
    } else {
      deferred.push(candidate)
    }
  }
  return { resume, overBudget, deferred }
}
