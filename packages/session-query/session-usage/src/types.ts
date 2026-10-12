/**
 * Public records of the cross-session token-usage report.
 *
 * @module @deepseek-ai/dsh-session-usage/types
 */

/** Token totals over some slice of history. */
export interface UsageTotals {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly reasoningTokens: number
  /** Assistant messages that carried a usage record. */
  readonly messages: number
  /** Sessions contributing at least one counted message. */
  readonly sessions: number
}

/** One local calendar day's totals. */
export interface UsageDay {
  /** Local calendar day, `YYYY-MM-DD`. */
  readonly day: string
  readonly totals: UsageTotals
}

/** Totals for one provider route and model. */
export interface UsageByModel {
  readonly provider: string
  readonly model: string
  readonly totals: UsageTotals
}

/** Overall, per-day, and per-model totals over one requested slice of history. */
export interface UsageReport {
  readonly overall: UsageTotals
  /** Ascending by day, with days that have no usage omitted. */
  readonly days: readonly UsageDay[]
  /** Descending by total tokens. */
  readonly byModel: readonly UsageByModel[]
}

/**
 * Slice and cancellation for one {@link SessionUsageService.report} call.
 *
 * Each bound is a local calendar day key, exactly `YYYY-MM-DD`; `report`
 * throws on any other text rather than comparing it and answering an empty
 * slice.
 */
export interface UsageReportOptions {
  /** Inclusive first local calendar day, `YYYY-MM-DD`; unbounded when absent. */
  readonly since?: string
  /** Inclusive last local calendar day, `YYYY-MM-DD`; unbounded when absent. */
  readonly until?: string
  /** Cancellation observed between sessions of a scan and before each source read. */
  readonly signal?: AbortSignal
}

/** Published on `ctx.sessionUsage`. */
export interface SessionUsageService {
  /**
   * Fold provider-reported token usage over every session in the corpus.
   * @param options - inclusive day bounds and cancellation.
   * @returns totals for the requested slice, derived from the session logs.
   * @throws when a bound is not a `YYYY-MM-DD` local calendar day.
   */
  report(options?: UsageReportOptions): Promise<UsageReport>
}

/**
 * One session's usage at one `(day, provider, model)` cell.
 *
 * Cells are the cached unit because every field of a {@link UsageReport} —
 * the day series, the model split, and a `since`/`until` slice — is a
 * different aggregation of the same cells, so folding a log once serves all
 * three and any later bound.
 */
export interface UsageCell {
  /** Local calendar day of the messages in this cell, `YYYY-MM-DD`. */
  readonly day: string
  /** Provider route that produced the messages. */
  readonly provider: string
  /** Provider model id that produced the messages. */
  readonly model: string
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly reasoningTokens: number
  /** Assistant messages that carried a usage record in this cell. */
  readonly messages: number
}
