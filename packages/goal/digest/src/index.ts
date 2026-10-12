/**
 * Daily digest reports. `/report` writes `<workspace>/.dsh/reports/<date>.md`
 * summarizing the day's goals, tickets, checkpoints, memory activity, spend,
 * scheduled runs, and research breakthroughs; `dailyAt` writes it on a timer
 * for every live workspace and notifies through `dsh-notify` when mounted.
 * Seams beyond goals and tickets are optional and read structurally. Named
 * exports preserve Loader injection metadata.
 * @module @deepseek-ai/dsh-digest
 */

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
// Type-only: resolves the required `ctx.goals` and `ctx.tickets` services.
import type {} from '@deepseek-ai/dsh-goal'
import { localDateKey } from '@deepseek-ai/dsh-util-time'
import { breakthroughsOn, dailyTotals, isOnDate, msUntil, parseDailyAt, renderDigest } from './report.ts'
import {
  aggregateWeek, isClosedOutcome, isoWeekLabel, msUntilWeekly, parseDigestFooter, parseWeeklyOn, renderWeekly, weekDates,
} from './weekly.ts'
import type {
  DailyTime, DailyTotals, DigestCheckpoint, DigestGoal, DigestInput, DigestReport, DigestService, DigestTicket, WeeklyInput, WeeklyReport,
  WeeklyTime,
} from './types.ts'

export type * from './types.ts'
export { breakthroughsOn, dailyTotals, isOnDate, msUntil, parseDailyAt, renderDigest, renderFooter } from './report.ts'
export {
  aggregateWeek, isClosedOutcome, isoWeekLabel, msUntilWeekly, parseDigestFooter, parseWeeklyOn, renderWeekly, sparkline, weekDates,
} from './weekly.ts'

export const name = 'digest'
export const inject = ['agents', 'commands', 'goals']

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Daily digest reports; provided by `dsh-digest`. */
    digest: DigestService
  }
}

/** Digest configuration. */
export interface Config {
  /** Local `HH:MM` at which the day's report is written for every live workspace. Omitted: `/report` only. */
  dailyAt?: string
  /** Local `<weekday> HH:MM` at which the weekly review is written for every live workspace. Omitted: `/report week` only. */
  weeklyOn?: string
}

/** Schemastery configuration schema. */
export const Config: z<Config> = z.object({
  dailyAt: z.string(),
  weeklyOn: z.string(),
})

/** Seams read structurally when mounted, so this package depends on none of them. */
interface CheckpointSeam {
  list(sessionId: SessionId): readonly { commit: string; role: string; round: number; ticketId?: string; createdAt: string }[]
}
interface MemorySeam {
  list(): readonly { status: string; createdAt: string; updatedAt: string }[]
}
interface SpendSeam {
  dayTokens(): number
}
interface CronSeam {
  list(): readonly { name: string; lastRunAt?: number; lastOutcome?: string }[]
}
/** The ticket store of one workspace, as the optional `tickets` service exposes it. */
interface TicketsSeam {
  storeFor(cwd: string): {
    whenReady(): Promise<void>
    list(): readonly {
      readonly id: string
      readonly title: string
      readonly status: string
      readonly severity: string
      readonly createdAt: string
      readonly updatedAt: string
    }[]
  }
}
interface ResearchSeam {
  /** Configured journal directory: absolute, or relative to a workspace root. */
  readonly dir: string
}
interface NotifySeam {
  send(notification: { event: 'dailyDigest' | 'weeklyDigest'; title: string; text: string }): Promise<void>
}

/** Relative location of the reports folder inside a workspace. */
const REPORTS_DIR = join('.dsh', 'reports')

/**
 * Install `ctx.digest`, `/report`, and the optional daily timer.
 * @param ctx - plugin context carrying `agents`, `commands`, `goals`, and `tickets`;
 *   `checkpoints`, `memory`, `spendGuard`, `cronSessions`, and `notify` are read when mounted.
 * @param config - deployment configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const dailyAt: DailyTime | undefined = config.dailyAt === undefined ? undefined : parseDailyAt(config.dailyAt)
  const weeklyOn: WeeklyTime | undefined = config.weeklyOn === undefined ? undefined : parseWeeklyOn(config.weeklyOn)

  /** The workspace's journal directory, from the mounted research service; undefined without one. */
  function researchDir(cwd: string): string | undefined {
    const research = ctx.get('research') as ResearchSeam | undefined
    if (research === undefined) return undefined
    return isAbsolute(research.dir) ? research.dir : join(cwd, research.dir)
  }

  function agentsIn(cwd: string): Agent[] {
    return ctx.agents.list().filter(agent => agent.session.header.cwd === cwd)
  }

  async function journalBreakthroughs(cwd: string, date: string): Promise<string[] | undefined> {
    const dir = researchDir(cwd)
    if (dir === undefined) return undefined
    let slugs: string[]
    try {
      slugs = await readdir(dir)
    } catch {
      // No research folder: the section reports its absence.
      return undefined
    }
    const found: string[] = []
    for (const slug of slugs.sort()) {
      try {
        found.push(...breakthroughsOn(await readFile(join(dir, slug, 'journal.md'), 'utf8'), date))
      } catch {
        // A slug directory without a journal is not a research goal.
      }
    }
    return found
  }

  async function collect(cwd: string, at: Date = new Date()): Promise<DigestInput> {
    const date = localDateKey(at)
    const agents = agentsIn(cwd)
    const goals = agents.flatMap((agent) => {
      const goal = ctx.goals.get(agent)
      if (goal === undefined) return []
      return [{ sessionId: String(agent.id), objective: goal.objective, phase: goal.phase, roundsStarted: goal.roundsStarted }]
    })
    const store = (ctx.get('tickets') as TicketsSeam | undefined)?.storeFor(cwd)
    if (store !== undefined) await store.whenReady()
    const tickets = store?.list() ?? []
    const counts: Record<string, number> = {}
    for (const ticket of tickets) counts[ticket.status] = (counts[ticket.status] ?? 0) + 1
    const changedToday = tickets
      .filter(ticket => isOnDate(ticket.updatedAt, date) || isOnDate(ticket.createdAt, date))
      .map(ticket => ({ id: ticket.id, title: ticket.title, status: ticket.status, severity: ticket.severity }))
    const openedToday = tickets.filter(ticket => isOnDate(ticket.createdAt, date)).length
    const closedToday = tickets.filter(ticket => isClosedOutcome(ticket.status) && isOnDate(ticket.updatedAt, date)).length
    const checkpointSeam = ctx.get('checkpoints') as CheckpointSeam | undefined
    const checkpoints: DigestCheckpoint[] = checkpointSeam === undefined
      ? []
      : agents.flatMap(agent => checkpointSeam.list(agent.id))
        .filter(entry => isOnDate(entry.createdAt, date))
        .map(entry => ({
          commit: entry.commit, role: entry.role, round: entry.round, ...entry.ticketId === undefined ? {} : { ticketId: entry.ticketId },
        }))
    const memorySeam = ctx.get('memory') as MemorySeam | undefined
    const memoryEntries = memorySeam?.list()
    const spendSeam = ctx.get('spendGuard') as SpendSeam | undefined
    const cronSeam = ctx.get('cronSessions') as CronSeam | undefined
    const breakthroughs = await journalBreakthroughs(cwd, date)
    return {
      date,
      goals,
      tickets: { counts, changedToday, openedToday, closedToday, ...store === undefined ? { absent: true as const } : {} },
      checkpoints,
      ...memoryEntries === undefined ? {} : {
        memory: {
          candidates: memoryEntries.filter(entry => entry.status === 'candidate' && isOnDate(entry.createdAt, date)).length,
          approved: memoryEntries.filter(entry => (entry.status === 'approved' || entry.status === 'promoted') && isOnDate(entry.updatedAt, date)).length,
        },
      },
      ...spendSeam === undefined ? {} : { spend: { dayTokens: spendSeam.dayTokens() } },
      ...cronSeam === undefined ? {} : {
        cronRuns: cronSeam.list()
          .filter(schedule => schedule.lastRunAt !== undefined && localDateKey(new Date(schedule.lastRunAt)) === date)
          .map(schedule => ({ name: schedule.name, outcome: schedule.lastOutcome ?? 'unknown' })),
      },
      ...breakthroughs === undefined ? {} : { breakthroughs },
    }
  }

  async function write(cwd: string, at: Date = new Date()): Promise<DigestReport> {
    const input = await collect(cwd, at)
    const text = renderDigest(input)
    const dir = join(cwd, REPORTS_DIR)
    await mkdir(dir, { recursive: true })
    const path = join(dir, `${input.date}.md`)
    await writeFile(path, text, 'utf8')
    return { date: input.date, path, text }
  }

  async function journalOpenHypotheses(cwd: string): Promise<{ slug: string; open: number }[]> {
    const dir = researchDir(cwd)
    if (dir === undefined) return []
    let slugs: string[]
    try {
      slugs = await readdir(dir)
    } catch {
      // No research folder: nothing open.
      return []
    }
    const found: { slug: string; open: number }[] = []
    for (const slug of slugs.sort()) {
      try {
        const journal = await readFile(join(dir, slug, 'journal.md'), 'utf8')
        const section = /^## Hypotheses\s*$([\s\S]*?)(?=^## |(?![\s\S]))/mu.exec(journal)?.[1] ?? ''
        const open = section.split('\n').filter(line => /^\s*- \[h-[0-9a-f]+ \S+ (?:model|auto|human) open\]/u.test(line)).length
        found.push({ slug, open })
      } catch {
        // A slug directory without a journal is not a research goal.
      }
    }
    return found
  }

  async function dailyFooters(cwd: string, dates: readonly string[]): Promise<DailyTotals[]> {
    const dir = join(cwd, REPORTS_DIR)
    const found: DailyTotals[] = []
    for (const date of dates) {
      let text: string
      try {
        text = await readFile(join(dir, `${date}.md`), 'utf8')
      } catch {
        // A day without a report contributes zeros.
        continue
      }
      const totals = parseDigestFooter(text)
      if (totals !== undefined && totals.date === date) found.push(totals)
    }
    return found
  }

  async function collectWeek(cwd: string, at: Date = new Date()): Promise<WeeklyInput> {
    const dates = weekDates(at)
    const from = dates[0] ?? localDateKey(at)
    const to = dates[dates.length - 1] ?? localDateKey(at)
    const footers = await dailyFooters(cwd, dates)
    // Today's report may not exist yet: derive its totals from the live seams.
    let spendSource = 'daily reports'
    if (!footers.some(totals => totals.date === to)) {
      footers.push(dailyTotals(await collect(cwd, at)))
      if (ctx.get('spendGuard') !== undefined) spendSource = 'daily reports plus the live spend guard for today'
    }
    const series = aggregateWeek(dates, footers)
    const inWeek = (iso: string): boolean => dates.some(date => isOnDate(iso, date))
    const store = (ctx.get('tickets') as TicketsSeam | undefined)?.storeFor(cwd)
    if (store !== undefined) await store.whenReady()
    const tickets = store?.list() ?? []
    const asRow = (ticket: (typeof tickets)[number]): DigestTicket => ({
      id: ticket.id, title: ticket.title, status: ticket.status, severity: ticket.severity,
    })
    const movedTickets = tickets.filter(ticket => inWeek(ticket.updatedAt) || inWeek(ticket.createdAt)).map(asRow)
    const needsHuman = tickets.filter(ticket => ticket.status === 'needs-human').map(asRow)
    const breakthroughs: string[] = []
    for (const date of dates) breakthroughs.push(...(await journalBreakthroughs(cwd, date)) ?? [])
    const goals: DigestGoal[] = agentsIn(cwd).flatMap((agent) => {
      const goal = ctx.goals.get(agent)
      if (goal === undefined || (goal.phase !== 'complete' && goal.phase !== 'blocked')) return []
      return [{ sessionId: String(agent.id), objective: goal.objective, phase: goal.phase, roundsStarted: goal.roundsStarted }]
    })
    return {
      week: isoWeekLabel(at),
      from,
      to,
      series,
      moved: { tickets: movedTickets, breakthroughs, goals },
      stillOpen: { needsHuman, openHypotheses: await journalOpenHypotheses(cwd) },
      spendSource,
    }
  }

  async function writeWeek(cwd: string, at: Date = new Date()): Promise<WeeklyReport> {
    const input = await collectWeek(cwd, at)
    const text = renderWeekly(input)
    const dir = join(cwd, REPORTS_DIR)
    await mkdir(dir, { recursive: true })
    const path = join(dir, `week-${input.week}.md`)
    await writeFile(path, text, 'utf8')
    return { week: input.week, path, text }
  }

  const service: DigestService = { collect, write, collectWeek, writeWeek }
  ctx.provide('digest', service)

  async function executeDigest(invocation: CommandInvocation): Promise<CommandResult> {
    const cwd = invocation.agent.session.header.cwd
    if (cwd === undefined) return { kind: 'error', text: 'This session has no workspace directory to report on.' }
    const verb = invocation.rawInput.trim()
    if (verb !== '' && verb !== 'week') return { kind: 'error', text: 'Usage: /report [week]' }
    try {
      const report = verb === 'week' ? await writeWeek(cwd) : await write(cwd)
      return { kind: 'success', text: `Wrote ${report.path}\n\n${report.text}` }
    } catch (error) {
      return { kind: 'error', text: `Digest failed: ${error instanceof Error ? error.message : String(error)}` }
    }
  }

  ctx.effect(() => ctx.commands.register({
    name: 'report',
    description: 'Write today\'s Hydra report for this workspace to .dsh/reports; `week` writes the weekly review',
    input: { hint: '[week]' },
    handler: executeDigest,
  }))

  // One timer per cadence to its next occurrence; each firing writes every
  // live workspace once and schedules the next. Disposal clears whichever
  // timer is pending.
  function scheduleReports(
    label: 'daily' | 'weekly',
    delay: (now: Date) => number,
    run: (cwd: string) => Promise<{ path: string; title: string }>,
    event: 'dailyDigest' | 'weeklyDigest',
  ): void {
    ctx.effect(() => {
      let timer: ReturnType<typeof setTimeout> | undefined
      let disposed = false
      const fire = async (): Promise<void> => {
        const cwds = new Set(ctx.agents.list().flatMap(agent => agent.session.header.cwd === undefined ? [] : [agent.session.header.cwd]))
        for (const cwd of cwds) {
          try {
            const report = await run(cwd)
            const notify = ctx.get('notify') as NotifySeam | undefined
            if (notify !== undefined) void notify.send({ event, title: report.title, text: report.path })
          } catch (error) {
            ctx.logger.warn(`digest: ${label} report for "${cwd}" failed: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
      }
      const schedule = (): void => {
        if (disposed) return
        timer = setTimeout(() => {
          void fire().finally(schedule)
        }, Math.min(delay(new Date()), MAX_TIMER_DELAY_MS))
      }
      schedule()
      return () => {
        disposed = true
        if (timer !== undefined) clearTimeout(timer)
      }
    })
  }

  if (dailyAt !== undefined) {
    scheduleReports('daily', now => msUntil(dailyAt, now), async (cwd) => {
      const report = await write(cwd)
      return { path: report.path, title: `Daily digest ${report.date}` }
    }, 'dailyDigest')
  }
  if (weeklyOn !== undefined) {
    scheduleReports('weekly', now => msUntilWeekly(weeklyOn, now), async (cwd) => {
      const report = await writeWeek(cwd)
      return { path: report.path, title: `Weekly review ${report.week}` }
    }, 'weeklyDigest')
  }
}
