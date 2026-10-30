/** A local wall-clock time of day. */
export interface DailyTime {
  /** Hour, 0 to 23. */
  readonly hour: number
  /** Minute, 0 to 59. */
  readonly minute: number
}

/** One live goal in the digest. */
export interface DigestGoal {
  readonly sessionId: string
  readonly objective: string
  readonly phase: string
  readonly roundsStarted: number
}

/** One ticket row in the digest. */
export interface DigestTicket {
  readonly id: string
  readonly title: string
  readonly status: string
  readonly severity: string
}

/** One checkpoint row in the digest. */
export interface DigestCheckpoint {
  readonly commit: string
  readonly role: string
  readonly round: number
  readonly ticketId?: string
}

/** Everything a day's report renders; optional sections belong to seams that may not be mounted. */
export interface DigestInput {
  /** Local calendar date `YYYY-MM-DD`. */
  readonly date: string
  readonly goals: readonly DigestGoal[]
  readonly tickets: {
    /** Present when no tickets service is mounted: the section reports absence and the counts stay empty. */
    readonly absent?: true
    /** Ticket counts by status. */
    readonly counts: Readonly<Record<string, number>>
    /** Tickets created or changed on the date. */
    readonly changedToday: readonly DigestTicket[]
    /** Tickets created on the date. */
    readonly openedToday: number
    /** Tickets that reached `verified`, `closed`, or `wontfix` on the date. */
    readonly closedToday: number
  }
  /** Checkpoints made on the date. */
  readonly checkpoints: readonly DigestCheckpoint[]
  /** Memory activity on the date; absent when `dsh-memory` is not mounted. */
  readonly memory?: { readonly candidates: number; readonly approved: number }
  /** Tokens spent on the date; absent when `dsh-spend-guard` is not mounted. */
  readonly spend?: { readonly dayTokens: number }
  /** Scheduled runs that finished on the date; absent when `dsh-cron-sessions` is not mounted. */
  readonly cronRuns?: readonly { readonly name: string; readonly outcome: string }[]
  /** Breakthroughs journaled on the date; absent when no research journal exists in the workspace. */
  readonly breakthroughs?: readonly string[]
}

/** A written report. */
export interface DigestReport {
  /** Local calendar date the report covers. */
  readonly date: string
  /** Absolute path of the Markdown file. */
  readonly path: string
  /** The rendered Markdown. */
  readonly text: string
}

/** A local weekday and wall-clock time. */
export interface WeeklyTime {
  /** Weekday, 0 = Sunday through 6 = Saturday. */
  readonly weekday: number
  /** Hour, 0 to 23. */
  readonly hour: number
  /** Minute, 0 to 59. */
  readonly minute: number
}

/** The machine-readable totals a daily report carries in its footer. */
export interface DailyTotals {
  /** Local calendar date `YYYY-MM-DD`; a week sum carries `from..to`. */
  readonly date: string
  readonly ticketsOpened: number
  readonly ticketsClosed: number
  readonly checkpoints: number
  readonly breakthroughs: number
  readonly memoryCandidates: number
  readonly memoryApproved: number
  /** Tokens spent, or `null` when the spend guard was not mounted. */
  readonly spendTokens: number | null
  readonly cronRuns: number
}

/** One day of the weekly series. */
export interface WeekDay {
  readonly date: string
  /** Whether a daily report with a footer existed for the date. */
  readonly reported: boolean
  /** The day's totals; zeros when no report existed. */
  readonly totals: DailyTotals
}

/** Seven days lined up with their sums. */
export interface WeekSeries {
  readonly days: readonly WeekDay[]
  readonly totals: DailyTotals
  /** How many of the days had a report. */
  readonly reportedDays: number
  /** Tokens per closed ticket or breakthrough; absent when spend or outcomes are unknown. */
  readonly spendPerOutcome?: number
}

/** Everything the weekly review renders. */
export interface DigestWeeklyInput {
  /** ISO week label `YYYY-Www`. */
  readonly week: string
  /** First local date of the range. */
  readonly from: string
  /** Last local date of the range. */
  readonly to: string
  readonly series: WeekSeries
  /** Items that changed during the week, read live. */
  readonly moved: {
    readonly tickets: readonly DigestTicket[]
    readonly breakthroughs: readonly string[]
    readonly goals: readonly DigestGoal[]
  }
  /** Items still waiting at the end of the week. */
  readonly stillOpen: {
    readonly needsHuman: readonly DigestTicket[]
    readonly openHypotheses: readonly { readonly slug: string; readonly open: number }[]
  }
  /** Where spend numbers came from, named in the report. */
  readonly spendSource: string
}

/** A written weekly review. */
export interface WeeklyReport {
  /** ISO week label the report covers. */
  readonly week: string
  /** Absolute path of the Markdown file. */
  readonly path: string
  /** The rendered Markdown. */
  readonly text: string
}

/** Service published as `ctx.digest`. */
export interface DigestService {
  /**
   * Gather the day's facts for one workspace from every mounted seam.
   * @param cwd - the workspace directory.
   * @param at - the moment that defines the day; defaults to now.
   * @returns the report input.
   */
  collect(cwd: string, at?: Date): Promise<DigestInput>
  /**
   * Render and write the day's report to `<cwd>/.dsh/reports/<date>.md`.
   * @param cwd - the workspace directory.
   * @param at - the moment that defines the day; defaults to now.
   * @returns the written report.
   */
  write(cwd: string, at?: Date): Promise<DigestReport>
  /**
   * Gather the last seven days for one workspace from the daily report footers and live seams.
   * @param cwd - the workspace directory.
   * @param at - the moment that defines the last day; defaults to now.
   * @returns the weekly review input.
   */
  collectWeek(cwd: string, at?: Date): Promise<DigestWeeklyInput>
  /**
   * Render and write the weekly review to `<cwd>/.dsh/reports/week-<YYYY-Www>.md`.
   * @param cwd - the workspace directory.
   * @param at - the moment that defines the last day; defaults to now.
   * @returns the written review.
   */
  writeWeek(cwd: string, at?: Date): Promise<WeeklyReport>
}
