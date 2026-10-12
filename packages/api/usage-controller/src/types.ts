/** Remote values of the usage namespace: plain JSON projections of one cross-session token-usage report. */

/**
 * Token totals over one bucket of history.
 *
 * `totalTokens` is the billable figure, summed on the Host by the owning
 * service so no consumer re-derives it. `reasoningTokens` is a part of
 * `outputTokens` already counted there, and is reported separately only as a
 * breakdown of it.
 */
export interface UsageTotalsValue {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  /** Reasoning tokens, a subset of `outputTokens`. */
  reasoningTokens: number
  /** Billable tokens: input plus both cache buckets plus output. */
  totalTokens: number
  /** Assistant messages that carried a usage record. */
  messages: number
  /** Sessions contributing at least one counted message. */
  sessions: number
}

/** One local calendar day's totals. */
export interface UsageDayValue {
  /** Local calendar day, `YYYY-MM-DD`. */
  day: string
  totals: UsageTotalsValue
}

/** Totals for one provider route and model. */
export interface UsageByModelValue {
  provider: string
  model: string
  totals: UsageTotalsValue
}

/** Everything the dashboard renders for one slice of history. */
export interface UsageReportValue {
  overall: UsageTotalsValue
  /** Ascending by day, with days that have no usage omitted; a consumer fills its own gaps. */
  days: UsageDayValue[]
  /** Descending by total tokens. */
  byModel: UsageByModelValue[]
}

/** Bound one report to a stretch of local calendar days. */
export interface UsageReportRequest {
  /** Inclusive first local day, `YYYY-MM-DD`; unbounded when absent. */
  since?: string
  /** Inclusive last local day, `YYYY-MM-DD`; unbounded when absent. */
  until?: string
}
