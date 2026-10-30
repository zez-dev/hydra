/**
 * Token budgets. The guard sums the provider usage each `assistant/message`
 * carries, per session in memory and per local day in the `spend_guard`
 * storage domain. Crossing a budget once per session or day either pauses the
 * session's goal and tells the model to wrap up, or cancels the turn. `/spend`
 * shows totals against the budgets. Named exports preserve Loader injection
 * metadata.
 * @module @deepseek-ai/dsh-spend-guard
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { createUserMessage, usageTokens } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { localDateKey } from '@deepseek-ai/dsh-util-time'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
// Type-only: resolves the optional `goals` and `notify` declarations.
import type {} from '@deepseek-ai/dsh-goal'
import type {} from '@deepseek-ai/dsh-notify'
import type { SpendAction, SpendGuardService, SpendStatus } from './types.ts'

export type * from './types.ts'

export const name = 'spend-guard'
export const inject = ['agents', 'commands', 'storageDomain']

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Token budget accounting; provided by `dsh-spend-guard`. */
    spendGuard: SpendGuardService
  }
}

/** Spend guard configuration. */
export interface Config {
  /** Tokens one session may consume before the action fires; absent means unlimited. */
  perSessionTokens?: number
  /** Tokens all sessions may consume per local day before the action fires; absent means unlimited. */
  perDayTokens?: number
  /** `pause-goal` pauses an active goal and asks the model to finish the step; `stop` cancels the turn. */
  action: SpendAction
}

/** Schemastery configuration schema. */
export const Config: z<Config> = z.object({
  perSessionTokens: z.natural().min(1),
  perDayTokens: z.natural().min(1),
  action: z.union(['pause-goal', 'stop'] as const).required(),
})

const dayRow = zod.object({
  date: zod.string(),
  tokens: zod.number().nonnegative(),
})

type DayRow = zod.infer<typeof dayRow>

/** The `spend_guard` domain: one record per local date. */
export const spendGuardDomainSpec = defineDomain({
  name: 'spend_guard',
  version: 1,
  layout: 'per-record',
  invalidRecords: 'backup-and-skip',
  tables: {
    days: domainTable<string, DayRow>(dayRow),
  },
})

const NOTICE = 'The token budget for this work is reached. Finish the current step with what you have, state what remains, and stop; do not start new work.'

/**
 * Install the accounting listener, the `ctx.spendGuard` service, and `/spend`.
 * @param ctx - plugin context carrying `agents`, `commands`, and `storageDomain`; `goals` and `notify` are used when mounted.
 * @param config - deployment budgets and action.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const domain: Domain<typeof spendGuardDomainSpec> = await ctx.storageDomain.open(spendGuardDomainSpec)
  const days: KvTable<string, DayRow> = domain.table('days')
  const sessions = new Map<SessionId, number>()
  const dayTotals = new Map<string, number>()
  const sessionTripped = new Set<SessionId>()
  let dayTripped: string | undefined
  let persistence: Promise<void> = Promise.resolve()
  // The guard owns its domain handle. Closing refuses writes queued after it
  // starts, so the day totals already recorded land first and a remount
  // reopens the domain with the latest total.
  ctx.effect(() => async () => {
    await persistence
    await domain.close()
  }, 'spendGuard.domainClose')

  function dayTokens(date = new Date()): number {
    const key = localDateKey(date)
    return dayTotals.get(key) ?? days.get(key)?.tokens ?? 0
  }

  function sessionTokens(sessionId: SessionId): number {
    return sessions.get(sessionId) ?? 0
  }

  function status(sessionId: SessionId): SpendStatus {
    const session = sessionTokens(sessionId)
    const day = dayTokens()
    return {
      sessionId,
      sessionTokens: session,
      dayTokens: day,
      ...config.perSessionTokens === undefined ? {} : { perSessionTokens: config.perSessionTokens },
      ...config.perDayTokens === undefined ? {} : { perDayTokens: config.perDayTokens },
      sessionExceeded: config.perSessionTokens !== undefined && session >= config.perSessionTokens,
      dayExceeded: config.perDayTokens !== undefined && day >= config.perDayTokens,
    }
  }

  function enforce(agent: Agent, scope: 'session' | 'day'): void {
    const goals = ctx.get('goals')
    const goal = goals?.get(agent)
    if (goal !== undefined && goal.phase === 'active') goals?.pause(agent, { id: goal.id, revision: goal.revision })
    if (config.action === 'pause-goal') {
      agent.inject(createUserMessage({
        content: [{ type: 'text', text: NOTICE }],
        source: { kind: 'plugin:dsh-spend-guard' },
      }))
    } else {
      agent.cancel({ kind: 'hook', reason: `spend-guard: ${scope} token budget reached` })
    }
    const current = status(agent.id)
    ctx.logger.warn(`spend-guard: ${scope} budget reached for "${agent.id}" (session ${current.sessionTokens}, day ${current.dayTokens})`)
    const notify = ctx.get('notify')
    if (notify !== undefined) {
      void notify.send({
        event: 'spendBudgetReached',
        title: `Token budget reached (${scope})`,
        text: `Session ${current.sessionTokens}${current.perSessionTokens === undefined ? '' : ` / ${current.perSessionTokens}`}, today ${current.dayTokens}${current.perDayTokens === undefined ? '' : ` / ${current.perDayTokens}`}. Action: ${config.action}.`,
        sessionId: agent.id,
      })
    }
  }

  // Totals update synchronously so budgets are enforced on the message that
  // crosses them; the durable day record follows behind.
  function record(sessionId: SessionId, tokens: number): void {
    sessions.set(sessionId, sessionTokens(sessionId) + tokens)
    const key = localDateKey(new Date())
    const total = dayTokens() + tokens
    dayTotals.set(key, total)
    persistence = persistence
      .then(() => days.get(key) === undefined
        ? days.put(key, { date: key, tokens: total })
        : days.update(key, row => ({ ...row, tokens: total })).then(() => undefined))
      .catch((error: unknown) => {
        /* v8 ignore next -- the storage domain and its backends reject with Error instances. */
        const detail = error instanceof Error ? error.message : String(error)
        ctx.logger.warn(`spend-guard: could not persist today's total: ${detail}`)
      })
    const agent = ctx.agents.get(sessionId)
    if (agent === undefined) return
    const current = status(sessionId)
    // The crossing message is still publishing, and pausing a goal appends to
    // the same log, so enforcement runs after the current publication.
    if (current.sessionExceeded && !sessionTripped.has(sessionId)) {
      sessionTripped.add(sessionId)
      defer(() => { enforce(agent, 'session') })
    } else if (current.dayExceeded && dayTripped !== key) {
      dayTripped = key
      defer(() => { enforce(agent, 'day') })
    }
  }

  const pendingTimers = new Set<ReturnType<typeof setTimeout>>()
  function defer(task: () => void): void {
    const timer = setTimeout(() => {
      pendingTimers.delete(timer)
      task()
    }, 0)
    pendingTimers.add(timer)
  }
  ctx.effect(() => () => {
    for (const timer of pendingTimers) clearTimeout(timer)
    pendingTimers.clear()
  })

  ctx.on('session/event', (session, event) => {
    if (event.type !== 'assistant/message' || event.data.usage === undefined) return
    const tokens = usageTokens(event.data.usage)
    if (tokens > 0) record(session.id, tokens)
  })

  ctx.on('agent/disposed', ({ agent }) => {
    sessions.delete(agent.id)
    sessionTripped.delete(agent.id)
  })

  const service: SpendGuardService = { sessionTokens, dayTokens: () => dayTokens(), status, settled: () => persistence }
  ctx.provide('spendGuard', service)

  function executeSpend(invocation: CommandInvocation): CommandResult {
    const current = status(invocation.agent.id)
    const limit = (value: number | undefined): string => value === undefined ? 'unlimited' : String(value)
    return {
      kind: 'success',
      text: [
        `This session: ${current.sessionTokens} / ${limit(current.perSessionTokens)} tokens${current.sessionExceeded ? ' (budget reached)' : ''}`,
        `Today: ${current.dayTokens} / ${limit(current.perDayTokens)} tokens${current.dayExceeded ? ' (budget reached)' : ''}`,
        `On budget: ${config.action}`,
      ].join('\n'),
    }
  }

  ctx.effect(() => ctx.commands.register({
    name: 'spend',
    description: 'Show token spend for this session and today against the budgets',
    handler: executeSpend,
  }))
}
