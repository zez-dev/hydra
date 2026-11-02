/** One-shot Team change waiters independent of durable state projection. */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TeamId, TeamWaitResult } from './types.ts'
import { errorMessage, TeamError } from './error.ts'

interface Waiter {
  readonly member: SessionId
  readonly resolve: (allWaiting: boolean) => void
}

/**
 * Reject a wait duration outside ten seconds through one hour.
 * @param timeoutMs - requested wait duration in milliseconds.
 */
export function assertWaitTimeout(timeoutMs: number): void {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10_000 || timeoutMs > 3_600_000) {
    throw new TeamError('timeoutMs must be an integer from 10000 through 3600000', 'TEAM_INVALID_TIMEOUT')
  }
}

/** Owns current Team change waiters and releases each at most once. */
export class TeamActivity {
  private readonly waiters = new Map<TeamId, Set<Waiter>>()
  private closed = false

  /**
   * Wait for one later Team-domain or member-status change.
   * @param id - Team whose next edge wakes the caller.
   * @param member - waiting member, matched by {@link endIfAllWaiting}.
   * @param timeoutMs - bounded wait duration from ten seconds through one hour.
   * @param signal - caller cancellation for this wait only.
   * @returns whether the wait ended by timeout, flagged `allWaiting` when {@link endIfAllWaiting} ended it.
   */
  async wait(id: TeamId, member: SessionId, timeoutMs: number, signal: AbortSignal): Promise<TeamWaitResult> {
    assertWaitTimeout(timeoutMs)
    signal.throwIfAborted()
    if (this.closed) return { timedOut: false }
    const outcome = await new Promise<'changed' | 'all-waiting' | 'timeout'>((resolve, reject) => {
      let waiters = this.waiters.get(id)
      if (waiters === undefined) {
        waiters = new Set()
        this.waiters.set(id, waiters)
      }
      let settled = false
      const finish = (settle: () => void): void => {
        /* v8 ignore next -- timeout, abort, and notification may race after one winner removes the others. */
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        waiters.delete(waiter)
        if (waiters.size === 0) this.waiters.delete(id)
        settle()
      }
      const onAbort = (): void => {
        finish(() => {
          const reason: unknown = signal.reason
          reject(reason instanceof Error
            ? reason
            : new TeamError(`wait_agent aborted: ${errorMessage(reason)}`, 'TEAM_WAIT_ABORTED'))
        })
      }
      const waiter: Waiter = {
        member,
        resolve: (allWaiting) => {
          finish(() => { resolve(allWaiting ? 'all-waiting' : 'changed') })
        },
      }
      waiters.add(waiter)
      const timer = setTimeout(() => { finish(() => { resolve('timeout') }) }, timeoutMs)
      signal.addEventListener('abort', onAbort, { once: true })
      // AbortSignal does not replay an abort that wins between the pre-check and listener registration.
      /* v8 ignore next -- requires an abort in the synchronous gap between the pre-check and listener registration. */
      if (signal.aborted) onAbort()
    })
    return outcome === 'all-waiting' ? { timedOut: false, allWaiting: true } : { timedOut: outcome === 'timeout' }
  }

  /**
   * Wake and remove every current waiter for one Team.
   * @param id - Team whose current waiters observe the change.
   */
  notify(id: TeamId): void {
    this.wake(id, false)
  }

  /**
   * End every current waiter of one Team with `allWaiting` when each of
   * `peers` is among them: no member is left to make the change they wait for.
   * @param id - Team whose waiters are checked.
   * @param peers - the members other than the caller that can still produce a change.
   * @returns whether the waiters ended; false when `peers` is empty.
   */
  endIfAllWaiting(id: TeamId, peers: readonly SessionId[]): boolean {
    const waiting = new Set([...this.waiters.get(id) ?? []].map(waiter => waiter.member))
    if (peers.length === 0 || !peers.every(peer => waiting.has(peer))) return false
    this.wake(id, true)
    return true
  }

  /** Wake and remove every current waiter for one Team, naming why. */
  private wake(id: TeamId, allWaiting: boolean): void {
    const waiters = this.waiters.get(id)
    if (waiters === undefined) return
    this.waiters.delete(id)
    for (const waiter of waiters) waiter.resolve(allWaiting)
  }

  /** Close admission and wake every current waiter during runtime disposal. */
  close(): void {
    this.closed = true
    for (const waiters of this.waiters.values()) {
      for (const waiter of waiters) waiter.resolve(false)
    }
    this.waiters.clear()
  }
}
