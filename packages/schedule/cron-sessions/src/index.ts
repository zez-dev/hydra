/**
 * Cron-started sessions. Schedules live in the `cron_sessions` storage domain;
 * a ticker evaluates each enabled schedule against local time and, when due
 * and not already running, creates a fresh session in the schedule's `cwd`
 * through the agent registry, submits the prompt, waits for idle, and records
 * the outcome. `/cron` manages schedules from any session. Named exports
 * preserve Loader injection metadata.
 * @module @deepseek-ai/dsh-cron-sessions
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import type { Agent, AgentHandle, AgentSetup } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { DomainError, defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
// Type-only: resolves the optional `agentPresets`, `agentDefaultModel`, and `notify` declarations.
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-notify'
import { cronMatches, isDue, parseCron } from './cron.ts'
import type { CronRunOutcome, CronSchedule, CronScheduleInput, CronSessionsChange, CronSessionsService } from './types.ts'

export type * from './types.ts'
export { cronMatches, isDue, parseCron } from './cron.ts'

export const name = 'cron-sessions'
export const inject = ['agents', 'commands', 'storageDomain', 'sessions']

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Cron schedules that start fresh sessions; provided by `dsh-cron-sessions`. */
    cronSessions: CronSessionsService
  }
  interface Events {
    /**
     * A schedule was added, changed, removed, or ran.
     * @param payload.id - the schedule.
     * @param payload.kind - what happened.
     * @param payload.sessionId - the run's session for run events.
     * @mode emit
     */
    'cron-sessions/change'(payload: CronSessionsChange): void
  }
}

/** Cron sessions configuration. */
export interface Config {
  /** Milliseconds between schedule evaluations; a due minute is caught when the tick is shorter than a minute. */
  tickMs: number
  /** Maximum schedules running at once; further due schedules wait for the next tick. */
  maxConcurrent: number
  /** Whether a schedule whose expression matched while the process was down runs once at activation. */
  catchUp: boolean
}

/** Schemastery configuration schema. */
export const Config: z<Config> = z.object({
  tickMs: z.natural().min(1000).required(),
  maxConcurrent: z.natural().min(1).required(),
  catchUp: z.boolean().required(),
})

const scheduleRow = zod.object({
  id: zod.string(),
  name: zod.string(),
  cron: zod.string(),
  cwd: zod.string(),
  prompt: zod.string(),
  agentPreset: zod.string().optional(),
  enabled: zod.boolean(),
  lastRunAt: zod.number().optional(),
  lastSessionId: zod.string().optional(),
  lastOutcome: zod.union([zod.literal('completed'), zod.literal('error')]).optional(),
})

type ScheduleRow = zod.infer<typeof scheduleRow>

/** The `cron_sessions` domain: one record per schedule. */
export const cronSessionsDomainSpec = defineDomain({
  name: 'cron_sessions',
  version: 1,
  layout: 'per-record',
  invalidRecords: 'backup-and-skip',
  tables: {
    schedules: domainTable<string, ScheduleRow>(scheduleRow),
  },
})

const USAGE = 'Usage: /cron list | add <name> "<cron>" <prompt> | enable <id> | disable <id> | run <id> | remove <id>'

/**
 * Split `/cron add` input into name, quoted cron expression, and prompt.
 * @param input - text after `add`.
 * @returns the three parts, or `undefined` when the shape is wrong.
 */
export function parseAddInput(input: string): { name: string; cron: string; prompt: string } | undefined {
  const match = /^\s*(?<name>\S+)\s+"(?<cron>[^"]+)"\s+(?<prompt>[\s\S]+?)\s*$/.exec(input)
  const groups = match?.groups
  if (groups?.name === undefined || groups.cron === undefined || groups.prompt === undefined) return undefined
  return { name: groups.name, cron: groups.cron, prompt: groups.prompt }
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
 * Install the ticker, the `ctx.cronSessions` service, and `/cron`.
 * @param ctx - plugin context carrying `agents`, `commands`, `storageDomain`, and `sessions`;
 *   `agentPresets`, `agentDefaultModel`, and `notify` are used when mounted.
 * @param config - deployment configuration.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const domain: Domain<typeof cronSessionsDomainSpec> = await ctx.storageDomain.open(cronSessionsDomainSpec)
  ctx.effect(() => () => domain.close(), 'cronSessions.domainClose')
  const table: KvTable<string, ScheduleRow> = domain.table('schedules')
  const running = new Map<string, Promise<CronRunOutcome>>()
  const activatedAt = Date.now()

  function toSchedule(row: ScheduleRow): CronSchedule {
    return {
      id: row.id,
      name: row.name,
      cron: row.cron,
      cwd: row.cwd,
      prompt: row.prompt,
      enabled: row.enabled,
      ...row.agentPreset === undefined ? {} : { agentPreset: row.agentPreset },
      ...row.lastRunAt === undefined ? {} : { lastRunAt: row.lastRunAt },
      ...row.lastSessionId === undefined ? {} : { lastSessionId: row.lastSessionId },
      ...row.lastOutcome === undefined ? {} : { lastOutcome: row.lastOutcome },
    }
  }

  function rows(): ScheduleRow[] {
    return [...table.entries()].map(([, row]) => row).sort((a, b) => a.id.localeCompare(b.id))
  }

  function list(): CronSchedule[] {
    return rows().map(toSchedule)
  }

  function require(id: string): ScheduleRow {
    const row = table.get(id)
    if (row === undefined) throw new Error(`no schedule "${id}"`)
    return row
  }

  async function add(input: CronScheduleInput): Promise<CronSchedule> {
    const parsed = parseCron(input.cron)
    const nameText = input.name.trim()
    if (nameText.length === 0) throw new Error('a schedule needs a name')
    if (input.prompt.trim().length === 0) throw new Error('a schedule needs a prompt')
    const stamp = Date.now().toString(36)
    const row: ScheduleRow = {
      id: `${stamp}-${randomUUID().slice(0, 8)}`,
      name: nameText,
      cron: parsed.expression,
      cwd: input.cwd,
      prompt: input.prompt.trim(),
      ...input.agentPreset === undefined ? {} : { agentPreset: input.agentPreset },
      enabled: true,
    }
    await table.put(row.id, row)
    ctx.emit('cron-sessions/change', { id: row.id, kind: 'added' })
    return toSchedule(row)
  }

  async function setEnabled(id: string, enabled: boolean): Promise<CronSchedule> {
    require(id)
    await table.update(id, row => ({ ...row, enabled }))
    ctx.emit('cron-sessions/change', { id, kind: 'updated' })
    return toSchedule(require(id))
  }

  async function remove(id: string): Promise<void> {
    require(id)
    await table.delete(id)
    ctx.emit('cron-sessions/change', { id, kind: 'removed' })
  }

  async function openSession(schedule: ScheduleRow): Promise<AgentHandle> {
    const presets = ctx.get('agentPresets')
    const defaultModel = ctx.get('agentDefaultModel')
    let setup: AgentSetup | undefined
    let agentPreset: string | undefined
    if (presets !== undefined) {
      const resolved = await presets.resolve(schedule.agentPreset)
      agentPreset = resolved.id
      setup = async (agentCtx) => { await presets.mount(agentCtx, resolved.id) }
    }
    const selection = defaultModel?.currentSelection()
    return ctx.agents.create({
      sessionId: brandString<SessionId>(randomUUID()),
      meta: { cwd: schedule.cwd, ...agentPreset === undefined ? {} : { agentPreset } },
      ...selection === undefined ? {} : { agentOptions: { provider: selection.provider, model: selection.model } },
      ...setup === undefined ? {} : { setup },
    })
  }

  async function execute(schedule: ScheduleRow): Promise<CronRunOutcome> {
    const startedAt = Date.now()
    // The previous outcome belongs to the previous run: a run that never records
    // its own, because an unload or a crash cut it short, must not inherit it.
    await table.update(schedule.id, ({ lastOutcome: _previous, ...row }) => ({ ...row, lastRunAt: startedAt }))
    let outcome: CronRunOutcome = 'error'
    let sessionId: SessionId | undefined
    let handle: AgentHandle | undefined
    const errors = { seen: false }
    const stopWatching = ctx.on('agent/error', ({ agent }: { agent: Agent }) => {
      if (sessionId !== undefined && agent.id === sessionId) errors.seen = true
    })
    try {
      handle = await openSession(schedule)
      sessionId = handle.agent.id
      ctx.emit('cron-sessions/change', { id: schedule.id, kind: 'run-started', sessionId })
      handle.agent.followup(createUserMessage({
        content: [{ type: 'text', text: schedule.prompt }],
        source: { kind: 'user' },
      }))
      await handle.agent.whenIdle()
      await ctx.sessions.flush(handle.agent.session)
      outcome = errors.seen ? 'error' : 'completed'
    } catch (error) {
      ctx.logger.warn(`cron-sessions: run of "${schedule.name}" failed: ${renderThrown(error)}`)
      outcome = 'error'
    } finally {
      stopWatching()
      await handle?.dispose().catch(() => {
        // Disposal after a failed run must not mask the outcome already decided.
      })
    }
    try {
      await table.update(schedule.id, row => ({
        ...row,
        lastOutcome: outcome,
        ...sessionId === undefined ? {} : { lastSessionId: sessionId },
      }))
    } catch (error: unknown) {
      // A schedule removed while it ran has no record left to carry the outcome.
      if (!(error instanceof DomainError && error.code === 'missing-key')) throw error
    }
    ctx.emit('cron-sessions/change', { id: schedule.id, kind: 'run-finished', ...sessionId === undefined ? {} : { sessionId } })
    const notify = ctx.get('notify')
    if (notify !== undefined) {
      void notify.send({
        event: 'cronRun',
        title: `Scheduled run ${outcome}: ${schedule.name}`,
        text: schedule.prompt,
        ...sessionId === undefined ? {} : { sessionId },
      })
    }
    return outcome
  }

  function start(schedule: ScheduleRow): Promise<CronRunOutcome> {
    const live = running.get(schedule.id)
    if (live !== undefined) return live
    const run = execute(schedule).finally(() => { running.delete(schedule.id) })
    running.set(schedule.id, run)
    return run
  }

  async function runNow(id: string): Promise<CronRunOutcome> {
    return start(require(id))
  }

  function tick(now: Date): void {
    for (const row of rows()) {
      if (!row.enabled || running.has(row.id) || running.size >= config.maxConcurrent) continue
      let parsed
      try {
        parsed = parseCron(row.cron)
      } catch {
        // A hand-edited record with a bad expression stays listed but never runs.
        continue
      }
      const missed = config.catchUp && row.lastRunAt !== undefined && row.lastRunAt < activatedAt
        && missedSince(parsed, row.lastRunAt, now)
      if (!isDue(parsed, now, row.lastRunAt) && !missed) continue
      void start(row).catch(() => {
        // execute() rejects only when the schedule's record cannot be written; a run it started has ended.
      })
    }
  }

  const service: CronSessionsService = {
    list,
    add,
    setEnabled,
    remove,
    runNow,
    isRunning: id => running.has(id),
  }
  ctx.provide('cronSessions', service)

  ctx.effect(() => {
    const timer = setInterval(() => { tick(new Date()) }, config.tickMs)
    return () => { clearInterval(timer) }
  })

  function formatRow(row: ScheduleRow): string {
    return [
      row.id,
      row.name,
      `"${row.cron}"`,
      row.enabled ? 'enabled' : 'disabled',
      running.has(row.id) ? 'running' : (row.lastOutcome ?? (row.lastRunAt === undefined ? 'never ran' : 'interrupted')),
      ...row.lastRunAt === undefined ? [] : [new Date(row.lastRunAt).toISOString()],
      row.cwd,
    ].join(' ')
  }

  async function executeCron(invocation: CommandInvocation): Promise<CommandResult> {
    const input = invocation.rawInput.trim()
    // ''.split() yields [''], so a bare command maps to no words and the verb defaults to list.
    const [verb = 'list', ...rest] = input === '' ? [] : input.split(/\s+/)
    const arg = rest[0] ?? ''
    try {
      switch (verb) {
        case 'list': {
          const all = rows()
          return { kind: 'success', text: all.length === 0 ? 'No schedules.' : all.map(formatRow).join('\n') }
        }
        case 'add': {
          const parts = parseAddInput(input.slice(input.indexOf('add') + 3))
          if (parts === undefined) return { kind: 'error', text: USAGE }
          const cwd = invocation.agent.session.header.cwd
          if (cwd === undefined) return { kind: 'error', text: 'this session has no workspace directory to schedule in' }
          const added = await add({ ...parts, cwd })
          return { kind: 'success', text: `Added ${added.id} (${added.name}, "${added.cron}") in ${cwd}.` }
        }
        case 'enable':
        case 'disable': {
          if (arg.length === 0) return { kind: 'error', text: USAGE }
          const updated = await setEnabled(arg, verb === 'enable')
          return { kind: 'success', text: `${updated.name} is now ${updated.enabled ? 'enabled' : 'disabled'}.` }
        }
        case 'run': {
          if (arg.length === 0) return { kind: 'error', text: USAGE }
          const row = require(arg)
          void start(row).catch(() => {
            // execute() rejects only when the schedule's record cannot be written; a run it started has ended.
          })
          return { kind: 'success', text: `Started ${row.name}.` }
        }
        case 'remove': {
          if (arg.length === 0) return { kind: 'error', text: USAGE }
          await remove(arg)
          return { kind: 'success', text: `Removed ${arg}.` }
        }
        default:
          return { kind: 'error', text: USAGE }
      }
    } catch (error) {
      return { kind: 'error', text: renderThrown(error) }
    }
  }

  ctx.effect(() => ctx.commands.register({
    name: 'cron',
    description: 'Schedule prompts that run in fresh sessions on a cron timer',
    input: { hint: 'list | add <name> "<cron>" <prompt> | enable <id> | disable <id> | run <id> | remove <id>' },
    handler: executeCron,
  }))
}

/**
 * Whether any matching minute lies strictly between the last run and now,
 * bounded to the last 24 hours so a long outage runs a schedule once.
 * @param cron - the parsed expression.
 * @param lastRunAt - epoch milliseconds of the last run start.
 * @param now - the current instant.
 * @returns true when a run was missed.
 */
export function missedSince(cron: ReturnType<typeof parseCron>, lastRunAt: number, now: Date): boolean {
  const floor = Math.max(lastRunAt + 60_000, now.getTime() - 24 * 60 * 60_000)
  for (let at = Math.floor(floor / 60_000) * 60_000; at < now.getTime(); at += 60_000) {
    if (cronMatches(cron, new Date(at))) return true
  }
  return false
}
