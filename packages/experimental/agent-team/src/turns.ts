/** Process-local turn order for a Team whose teammates take turns. */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { errorMessage, TeamError } from './error.ts'
import type { TeamId } from './types.ts'

/** One possession of a Team's turn; ending by grant compares identity, so a stale end cannot release a later grant. */
export interface TurnGrant {
  readonly agent: Agent
}

interface TurnWaiter {
  readonly agent: Agent
  readonly grant: (grant: TurnGrant) => void
  readonly reject: (reason: Error) => void
}

interface TurnState {
  holder: TurnGrant
  readonly waiters: TurnWaiter[]
}

/** Reject a turn wait with the caller's Error reason, or a coded Team failure for any other reason. */
function turnAbortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason
  return reason instanceof Error
    ? reason
    : new TeamError(`waiting for the Team turn aborted: ${errorMessage(reason)}`, 'TEAM_TURN_ABORTED')
}

/** First-in-first-out ownership of one turn per Team. */
export class TurnQueue {
  /** Teams whose turn is held or awaited; a free turn has no entry. */
  private readonly teams = new Map<TeamId, TurnState>()
  private closed = false

  /**
   * Test whether one Agent has its Team's turn.
   * @param team - Team whose turn is read.
   * @param agent - exact live teammate.
   * @returns whether the Agent holds the current grant.
   */
  holds(team: TeamId, agent: Agent): boolean {
    return this.teams.get(team)?.holder.agent === agent
  }

  /**
   * Test whether one Agent waits for its Team's turn.
   * @param team - Team whose queue is read.
   * @param agent - exact live teammate.
   * @returns whether the Agent is queued.
   */
  waiting(team: TeamId, agent: Agent): boolean {
    return this.teams.get(team)?.waiters.some(waiter => waiter.agent === agent) === true
  }

  /**
   * Take a free turn without waiting.
   * @param team - Team whose turn is taken.
   * @param agent - exact live teammate.
   * @returns the new grant, or undefined while another teammate holds or waits for the turn.
   */
  take(team: TeamId, agent: Agent): TurnGrant | undefined {
    return this.teams.has(team) ? undefined : this.grantFree(team, agent)
  }

  /**
   * Wait behind every earlier waiter for the turn.
   * @param team - Team whose turn is requested.
   * @param agent - exact live teammate.
   * @param signal - cancellation that leaves the queue.
   * @returns the grant once the turn passes to the Agent.
   */
  async acquire(team: TeamId, agent: Agent, signal: AbortSignal): Promise<TurnGrant> {
    if (signal.aborted) throw turnAbortError(signal)
    if (this.closed) throw new TeamError('Agent Teams service disposed', 'TEAM_DISPOSED')
    const state = this.teams.get(team)
    if (state === undefined) return this.grantFree(team, agent)
    return await new Promise<TurnGrant>((resolve, reject) => {
      const onAbort = (): void => {
        state.waiters.splice(state.waiters.indexOf(waiter), 1)
        reject(turnAbortError(signal))
      }
      const waiter: TurnWaiter = {
        agent,
        grant: (grant) => {
          signal.removeEventListener('abort', onAbort)
          resolve(grant)
        },
        reject: (reason) => {
          signal.removeEventListener('abort', onAbort)
          reject(reason)
        },
      }
      state.waiters.push(waiter)
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  /**
   * Pass the turn to the next waiter when one Agent holds it.
   * @param team - Team whose turn is released.
   * @param agent - Agent that stops working.
   */
  release(team: TeamId, agent: Agent): void {
    const state = this.teams.get(team)
    if (state?.holder.agent === agent) this.pass(team, state)
  }

  /**
   * Pass the turn to the next waiter when one grant is still current.
   * @param team - Team whose turn is released.
   * @param grant - grant whose possession ends.
   */
  end(team: TeamId, grant: TurnGrant): void {
    const state = this.teams.get(team)
    if (state?.holder === grant) this.pass(team, state)
  }

  /**
   * Release every turn one Agent holds and leave every queue it waits in.
   * @param agent - Agent leaving the registry.
   */
  forget(agent: Agent): void {
    for (const [team, state] of this.teams) {
      for (const waiter of state.waiters.filter(candidate => candidate.agent === agent)) {
        state.waiters.splice(state.waiters.indexOf(waiter), 1)
        waiter.reject(new TeamError('teammate left the Agent registry while waiting for its turn', 'TEAM_TURN_ABORTED'))
      }
      if (state.holder.agent === agent) this.pass(team, state)
    }
  }

  /** Reject every waiter and every later acquisition during runtime disposal. */
  close(): void {
    this.closed = true
    const waiters = [...this.teams.values()].flatMap(state => state.waiters)
    this.teams.clear()
    for (const waiter of waiters) waiter.reject(new TeamError('Agent Teams service disposed', 'TEAM_DISPOSED'))
  }

  /** Record a free turn as held by one Agent. */
  private grantFree(team: TeamId, agent: Agent): TurnGrant {
    const holder = { agent }
    this.teams.set(team, { holder, waiters: [] })
    return holder
  }

  /** Give the turn to the oldest waiter, or leave it free. */
  private pass(team: TeamId, state: TurnState): void {
    const next = state.waiters.shift()
    if (next === undefined) {
      this.teams.delete(team)
      return
    }
    const holder = { agent: next.agent }
    state.holder = holder
    next.grant(holder)
  }
}

/**
 * Hold teammates outside their Team's turn. Input entering an idle teammate
 * while another teammate has the turn starts an Agent maintenance hold: the
 * input stays pending in the durable inbox and its wake is latched until the
 * turn passes. A step proposed by a running teammate without the turn waits
 * before any other step work. The holder releases the turn at its idle edge,
 * when it leaves the registry, and while it waits for Team activity.
 */
export class TeamTurnGate {
  /**
   * Register the gate's listeners in the Team service context.
   * @param ctx - Team service context; its disposal removes the listeners.
   * @param queue - turn ownership shared with roster views.
   * @param teamOf - resolve the Team of a rostered teammate; undefined for the Lead and non-Team Agents.
   */
  constructor(
    ctx: Context,
    private readonly queue: TurnQueue,
    private readonly teamOf: (agent: Agent) => TeamId | undefined,
  ) {
    ctx.on('agent/inbox/inserted', ({ agent }) => { this.admit(agent) })
    // Prepended so no other step work, such as pressure compaction, runs before the turn.
    ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
      const team = this.teamOf(agent)
      if (team !== undefined && !this.queue.holds(team, agent)) {
        this.endWhenIdle(team, agent, await this.queue.acquire(team, agent, signal))
      }
      return await next()
    }, { prepend: true })
    ctx.on('agent/status', ({ agent, status }) => {
      if (status !== 'idle') return
      const team = this.teamOf(agent)
      if (team !== undefined) this.queue.release(team, agent)
    })
    ctx.on('agent/disposed', ({ agent }) => { this.queue.forget(agent) })
  }

  /**
   * Give up the caller's turn while one wait runs, then wait for the turn again.
   * @param team - caller's Team.
   * @param agent - exact live teammate that may hold the turn.
   * @param signal - cancellation of the renewed turn wait.
   * @param operation - wait that registers before the turn passes, so it observes the handoff it causes.
   * @returns the operation's value once the caller has the turn again.
   */
  async yieldDuring<T>(team: TeamId, agent: Agent, signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    if (!this.queue.holds(team, agent)) return await operation()
    const pending = operation()
    this.queue.release(team, agent)
    // A rejected wait ends the caller's turn without a renewed turn wait; a later step waits at the pre-step gate.
    const value = await pending
    this.endWhenIdle(team, agent, await this.queue.acquire(team, agent, signal))
    return value
  }

  /** Take a free turn for input entering an idle teammate, or hold the teammate until the turn passes to it. */
  private admit(agent: Agent): void {
    if (agent.status !== 'idle') return
    const team = this.teamOf(agent)
    if (team === undefined || this.queue.holds(team, agent) || this.queue.waiting(team, agent)) return
    const grant = this.queue.take(team, agent)
    if (grant !== undefined) {
      this.endWhenIdle(team, agent, grant)
      return
    }
    let hold: Promise<void>
    try {
      hold = agent.runMaintenance(async (maintenance) => {
        this.endWhenIdle(team, agent, await this.queue.acquire(team, agent, maintenance))
      })
    } catch (error: unknown) {
      // Other maintenance owns the idle Agent; its latched wake reaches the pre-step gate instead.
      void error
      return
    }
    // Cancellation or disposal ends the hold; the Agent owns the wake it latched.
    void hold.catch(() => undefined)
  }

  /** End a still-current grant once the Agent is idle again, including input that never woke it. */
  private endWhenIdle(team: TeamId, agent: Agent, grant: TurnGrant): void {
    const end = (): void => { this.queue.end(team, grant) }
    void agent.whenIdle().then(end, end)
  }
}
