/**
 * Off-peak deferral. While the clock lies outside every configured window, a
 * goal round that is about to start is rejected at `agent/pre-step`, its goal
 * is paused, and the deferral is recorded in the `off_peak` storage domain.
 * A timer reopens at the next window and resumes the queued sessions, up to
 * `maxConcurrent`. `/offpeak` queues and inspects work by hand, as does the
 * `off_peak` tool of the `./tools` entry.
 * Named exports preserve Loader injection metadata.
 * @module @deepseek-ai/dsh-off-peak
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
// Type-only: resolves the optional `goals` and `notify` service declarations.
import type {} from '@deepseek-ai/dsh-goal'
import type {} from '@deepseek-ai/dsh-notify'
import { inWindow, nextClose, nextOpen, parseWindows } from './window.ts'
import type {
  OffPeakChange, OffPeakDrainSummary, OffPeakEntry, OffPeakService, OffPeakWindow, ParsedWindow,
} from './types.ts'

export type * from './types.ts'
export { inWindow, nextClose, nextOpen, parseWindows } from './window.ts'

export const name = 'off-peak'
export const inject = ['agents', 'commands', 'storageDomain']

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The off-peak queue and window state; provided by `dsh-off-peak`. */
    offPeak: OffPeakService
  }
  interface Events {
    /**
     * A queue entry was added, started, finished, or cancelled.
     * @param payload.id - the entry.
     * @param payload.kind - what happened.
     * @param payload.sessionId - the entry's session.
     * @mode emit
     */
    'off-peak/change'(payload: OffPeakChange): void
  }
}

/** Off-peak configuration. */
export interface Config {
  /** Whether deferral and draining run at all; `false` leaves every round alone. */
  enabled: boolean
  /** Local-time windows in which deferred work runs. */
  windows: OffPeakWindow[]
  /** Maximum sessions resumed at once when a window opens. */
  maxConcurrent: number
  /** Whether a round already running when the window closes may finish. */
  finishRoundInFlight: boolean
}

/** Schemastery configuration schema. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().required(),
  windows: z.array(z.object({
    start: z.string().required(),
    end: z.string().required(),
  })).default([]),
  maxConcurrent: z.natural().min(1).required(),
  finishRoundInFlight: z.boolean().default(false),
})

const entryRow = zod.object({
  id: zod.string(),
  sessionId: zod.string(),
  kind: zod.union([zod.literal('goal-round'), zod.literal('manual')]),
  objective: zod.string().optional(),
  cwd: zod.string().optional(),
  queuedAt: zod.number(),
  state: zod.union([zod.literal('queued'), zod.literal('running'), zod.literal('done'), zod.literal('failed')]),
  startedAt: zod.number().optional(),
  error: zod.string().optional(),
})

type EntryRow = zod.infer<typeof entryRow>

/** The `off_peak` domain: one record per queued entry. */
export const offPeakDomainSpec = defineDomain({
  name: 'off_peak',
  version: 1,
  layout: 'per-record',
  invalidRecords: 'backup-and-skip',
  tables: {
    entries: domainTable<string, EntryRow>(entryRow),
  },
})

const USAGE = 'Usage: /offpeak list | queue <task> | drain | cancel <id>'

/**
 * Whether a claimed message batch carries a goal continuation round.
 * @param messages - the messages the loop admitted for this step.
 * @returns true when at least one message came from the goal round driver.
 */
export function hasGoalRound(messages: readonly UserMessage[]): boolean {
  return messages.some(message => message.source.kind === 'goal')
}

/**
 * Whether a message batch carries something a person is waiting on.
 * @param messages - the messages the loop admitted for this step.
 * @returns true when at least one message came from the user.
 */
export function hasHumanMessage(messages: readonly UserMessage[]): boolean {
  return messages.some(message => message.source.kind === 'user')
}

/**
 * The message of a thrown value.
 * @param value - what a failed operation threw or rejected with.
 * @returns the Error message, or the value's string form.
 */
function renderThrown(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/**
 * Install the window timer, the `ctx.offPeak` service, and `/offpeak`.
 * @param ctx - plugin context carrying `agents`, `commands`, and `storageDomain`;
 *   `goals` and `notify` are used when mounted.
 * @param config - deployment configuration.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const windows: ParsedWindow[] = parseWindows(config.windows)
  if (config.enabled && windows.length === 0) {
    throw new Error('off-peak: enabled with no windows; configure at least one window or disable the row')
  }
  const domain: Domain<typeof offPeakDomainSpec> = await ctx.storageDomain.open(offPeakDomainSpec)
  ctx.effect(() => () => domain.close(), 'offPeak.domainClose')
  const table: KvTable<string, EntryRow> = domain.table('entries')
  /** Sessions the drainer resumed in the open window, so closing can defer them again. */
  const draining = new Set<SessionId>()

  function toEntry(row: EntryRow): OffPeakEntry {
    return {
      id: row.id,
      sessionId: brandString<SessionId>(row.sessionId),
      kind: row.kind,
      queuedAt: row.queuedAt,
      state: row.state,
      ...row.objective === undefined ? {} : { objective: row.objective },
      ...row.cwd === undefined ? {} : { cwd: row.cwd },
      ...row.startedAt === undefined ? {} : { startedAt: row.startedAt },
      ...row.error === undefined ? {} : { error: row.error },
    }
  }

  function rows(): EntryRow[] {
    return [...table.entries()].map(([, row]) => row).sort((a, b) => a.queuedAt - b.queuedAt || a.id.localeCompare(b.id))
  }

  function isOpen(): boolean {
    return !config.enabled || inWindow(windows, new Date())
  }

  async function record(input: {
    sessionId: SessionId
    kind: EntryRow['kind']
    objective: string
    cwd?: string
  }): Promise<OffPeakEntry> {
    const row: EntryRow = {
      id: `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
      sessionId: input.sessionId,
      kind: input.kind,
      queuedAt: Date.now(),
      state: 'queued',
      objective: input.objective,
      ...input.cwd === undefined ? {} : { cwd: input.cwd },
    }
    await table.put(row.id, row)
    ctx.emit('off-peak/change', { id: row.id, kind: 'queued', sessionId: input.sessionId })
    return toEntry(row)
  }

  /**
   * Whether this session already has a goal round waiting, so a retried round
   * queues once. A waiting manual task does not count: it never resumes the goal.
   */
  function hasQueuedRound(sessionId: SessionId): boolean {
    return rows().some(row => row.sessionId === sessionId && row.kind === 'goal-round' && row.state === 'queued')
  }

  /**
   * Defer one goal round: pause the goal so the driver stops arming further
   * rounds, and record the deferral. The pause is synchronous because the
   * driver admits the next round as soon as this step settles, and a deferred
   * pause would let a goal burn its whole round budget against a closed
   * window. Recording is durable and follows asynchronously.
   */
  function deferRound(agent: Agent): void {
    const goals = ctx.get('goals')
    const goal = goals?.get(agent)
    if (goals === undefined || goal === undefined || goal.phase !== 'active') return
    const alreadyQueued = hasQueuedRound(agent.id)
    goals.pause(agent, { id: goal.id, revision: goal.revision })
    if (alreadyQueued) return
    void record({ sessionId: agent.id, kind: 'goal-round', objective: goal.objective }).catch((error: unknown) => {
      ctx.logger.warn(`off-peak: could not record a deferral: ${renderThrown(error)}`)
    })
  }

  // The drain exemption covers exactly one round: once that turn ends the
  // session is deferrable again, so a manual off-window drain never exempts a
  // session for good.
  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/end') draining.delete(session.id)
  })

  ctx.on('agent/pre-step', async ({ agent }, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (!config.enabled || decision.kind === 'reject' || isOpen()) return decision
    // A session the drainer resumed runs to the end of its round even when the
    // clock has left the window; `/offpeak drain` deliberately runs off-window.
    if (draining.has(agent.id)) return decision
    // Only the driver's own continuation is deferrable; a human message admitted
    // in the same step is work the person is waiting on, so the step proceeds.
    if (!hasGoalRound(decision.messages) || hasHumanMessage(decision.messages)) return decision
    deferRound(agent)
    return { kind: 'reject' }
  })

  /** Resume one queued session. */
  async function start(row: EntryRow): Promise<'done' | 'failed'> {
    const sessionId = brandString<SessionId>(row.sessionId)
    await table.update(row.id, current => ({ ...current, state: 'running', startedAt: Date.now() }))
    ctx.emit('off-peak/change', { id: row.id, kind: 'started', sessionId })
    try {
      const agent = ctx.agents.get(sessionId)
      if (agent === undefined) throw new Error(`session ${row.sessionId} is not live`)
      if (row.kind === 'manual') {
        if (row.objective === undefined) throw new Error('no task to send')
        agent.followup(createUserMessage({
          content: [{ type: 'text', text: row.objective }],
          source: { kind: 'user' },
        }))
      } else {
        const goals = ctx.get('goals')
        const goal = goals?.get(agent)
        if (goals === undefined || goal === undefined) throw new Error('no goal to resume')
        // A goal someone already resumed by hand is running, so the entry has nothing left to start.
        if (goal.phase !== 'active' || goal.activation !== 'armed') goals.resume(agent, { id: goal.id, revision: goal.revision })
      }
      draining.add(sessionId)
      await table.update(row.id, current => ({ ...current, state: 'done' }))
      ctx.emit('off-peak/change', { id: row.id, kind: 'finished', sessionId })
      return 'done'
    } catch (error: unknown) {
      const text = renderThrown(error)
      ctx.logger.warn(`off-peak: could not start ${row.id}: ${text}`)
      await table.update(row.id, current => ({ ...current, state: 'failed', error: text }))
      ctx.emit('off-peak/change', { id: row.id, kind: 'finished', sessionId })
      return 'failed'
    }
  }

  async function drain(): Promise<OffPeakDrainSummary> {
    const queued = rows().filter(row => row.state === 'queued')
    const batch = queued.slice(0, config.maxConcurrent)
    let done = 0
    let failed = 0
    for (const row of batch) {
      const outcome = await start(row)
      if (outcome === 'done') done += 1
      else failed += 1
    }
    const summary: OffPeakDrainSummary = {
      started: batch.length,
      done,
      failed,
      remaining: queued.length - batch.length,
    }
    const notify = ctx.get('notify')
    if (batch.length > 0 && notify !== undefined) {
      void notify.send({
        event: 'offPeakDrained',
        title: `Off-peak window drained ${String(done)} of ${String(batch.length)}`,
        text: `${String(summary.remaining)} still queued, ${String(failed)} failed.`,
      })
    }
    return summary
  }

  /**
   * Defer what the drainer resumed, so a window's work does not spill into
   * peak hours and waits in the queue for the next window.
   */
  function closeWindow(): void {
    if (!config.finishRoundInFlight) {
      for (const sessionId of draining) {
        const agent = ctx.agents.get(sessionId)
        if (agent !== undefined) deferRound(agent)
      }
    }
    draining.clear()
  }

  const service: OffPeakService = {
    isOpen,
    list: () => rows().map(toEntry),
    queue: input => record({ sessionId: input.sessionId, kind: 'manual', objective: input.objective, ...input.cwd === undefined ? {} : { cwd: input.cwd } }),
    cancel: async (id) => {
      const row = table.get(id)
      if (row === undefined) throw new Error(`no queued entry "${id}"`)
      await table.delete(id)
      ctx.emit('off-peak/change', { id, kind: 'cancelled', sessionId: brandString<SessionId>(row.sessionId) })
    },
    drain,
  }
  ctx.provide('offPeak', service)

  if (config.enabled) {
    ctx.effect(() => {
      // At most one timer is pending: each callback schedules the next one,
      // and the disposer clears the pending one.
      let timer: ReturnType<typeof setTimeout> | undefined
      const schedule = (): void => {
        const now = new Date()
        const open = inWindow(windows, now)
        // An enabled row has a window, so nextOpen finds one; an open clock lies in a window, so nextClose finds it.
        // oxlint-disable-next-line typescript/no-non-null-assertion -- both lookups find a window, as stated above
        const at = (open ? nextClose(windows, now) : nextOpen(windows, now))!
        const delay = Math.max(at.getTime() - now.getTime(), 1)
        timer = setTimeout(() => {
          if (inWindow(windows, new Date())) {
            void drain().catch((error: unknown) => {
              ctx.logger.warn(`off-peak: drain failed: ${renderThrown(error)}`)
            })
          } else {
            closeWindow()
          }
          schedule()
        }, delay)
      }
      if (inWindow(windows, new Date())) {
        void drain().catch((error: unknown) => {
          ctx.logger.warn(`off-peak: drain at activation failed: ${renderThrown(error)}`)
        })
      }
      schedule()
      return () => { clearTimeout(timer) }
    })
  }

  function formatRow(row: EntryRow): string {
    return [
      row.id,
      row.kind,
      row.state,
      new Date(row.queuedAt).toISOString(),
      row.objective ?? '',
    ].join(' ')
  }

  async function executeOffPeak(invocation: CommandInvocation): Promise<CommandResult> {
    const input = invocation.rawInput.trim()
    // ''.split() yields [''], so a bare command maps to no words and the verb defaults to list.
    const [verb = 'list', ...rest] = input === '' ? [] : input.split(/\s+/)
    try {
      switch (verb) {
        case 'list': {
          const all = rows()
          const header = config.enabled
            ? `Window ${isOpen() ? 'open' : 'closed'}; ${config.windows.map(w => `${w.start}-${w.end}`).join(', ')}.`
            : 'Off-peak deferral is disabled.'
          return { kind: 'success', text: all.length === 0 ? `${header}\nNothing queued.` : `${header}\n${all.map(formatRow).join('\n')}` }
        }
        case 'queue': {
          const task = input.slice(input.indexOf('queue') + 5).trim()
          if (task.length === 0) return { kind: 'error', text: USAGE }
          const cwd = invocation.agent.session.header.cwd
          const entry = await service.queue({
            sessionId: invocation.agent.id,
            objective: task,
            ...cwd === undefined ? {} : { cwd },
          })
          return { kind: 'success', text: `Queued ${entry.id} for the next off-peak window.` }
        }
        case 'drain': {
          const summary = await drain()
          return { kind: 'success', text: `Started ${String(summary.started)}, ${String(summary.remaining)} still queued.` }
        }
        case 'cancel': {
          const id = rest[0] ?? ''
          if (id.length === 0) return { kind: 'error', text: USAGE }
          await service.cancel(id)
          return { kind: 'success', text: `Cancelled ${id}.` }
        }
        default:
          return { kind: 'error', text: USAGE }
      }
    } catch (error: unknown) {
      return { kind: 'error', text: renderThrown(error) }
    }
  }

  ctx.effect(() => ctx.commands.register({
    name: 'offpeak',
    description: 'Queue work for the next off-peak window and inspect the queue',
    input: { hint: 'list | queue <task> | drain | cancel <id>' },
    handler: executeOffPeak,
  }))
}
