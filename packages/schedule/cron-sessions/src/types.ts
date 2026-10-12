import type { SessionId } from '@deepseek-ai/dsh-session'

/** A parsed five-field cron expression. */
export interface ParsedCron {
  /** The normalized expression text. */
  readonly expression: string
  readonly minutes: ReadonlySet<number>
  readonly hours: ReadonlySet<number>
  readonly daysOfMonth: ReadonlySet<number>
  readonly months: ReadonlySet<number>
  readonly daysOfWeek: ReadonlySet<number>
  /** Whether the day-of-month field is narrower than `*`. */
  readonly domRestricted: boolean
  /** Whether the day-of-week field is narrower than `*`. */
  readonly dowRestricted: boolean
}

/** How the last run of a schedule ended. */
export type CronRunOutcome = 'completed' | 'error'

/** One durable schedule. */
export interface CronSchedule {
  readonly id: string
  readonly name: string
  /** Five-field cron expression evaluated in local time. */
  readonly cron: string
  /** Absolute workspace directory the session runs in. */
  readonly cwd: string
  /** The user message submitted to the fresh session. */
  readonly prompt: string
  /** Agent preset id for the session, when the deployment mounts presets. */
  readonly agentPreset?: string
  readonly enabled: boolean
  /** Epoch milliseconds of the last run start. */
  readonly lastRunAt?: number
  readonly lastSessionId?: string
  readonly lastOutcome?: CronRunOutcome
}

/** Fields a caller supplies when adding a schedule. */
export interface CronScheduleInput {
  readonly name: string
  readonly cron: string
  readonly cwd: string
  readonly prompt: string
  readonly agentPreset?: string
}

/** The `ctx.cronSessions` service. */
export interface CronSessionsService {
  /**
   * All schedules, oldest first.
   * @returns every stored schedule.
   */
  list(): CronSchedule[]
  /**
   * Validate and store a schedule; it is enabled immediately.
   * @param input - name, cron expression, prompt, and workspace of the schedule.
   * @returns the stored schedule with its id.
   */
  add(input: CronScheduleInput): Promise<CronSchedule>
  /**
   * Enable or disable a schedule.
   * @param id - the schedule id.
   * @param enabled - whether the ticker may start runs for it.
   * @returns the updated schedule.
   */
  setEnabled(id: string, enabled: boolean): Promise<CronSchedule>
  /**
   * Remove a schedule; a live run finishes on its own, and no record keeps its outcome.
   * @param id - the schedule id.
   */
  remove(id: string): Promise<void>
  /**
   * Start a run now regardless of the expression; resolves when the run finishes.
   * @param id - the schedule id.
   * @returns the run's outcome.
   */
  runNow(id: string): Promise<CronRunOutcome>
  /**
   * Whether a run for the schedule is live.
   * @param id - the schedule id.
   * @returns true while a session started by this schedule has not finished.
   */
  isRunning(id: string): boolean
}

/** Payload of `cron-sessions/change`. */
export interface CronSessionsChange {
  readonly id: string
  readonly kind: 'added' | 'updated' | 'removed' | 'run-started' | 'run-finished'
  readonly sessionId?: SessionId
}
