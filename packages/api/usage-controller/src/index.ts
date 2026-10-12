/**
 * Host usage Remote: the Web dashboard's view of the cross-session token-usage
 * report `ctx.sessionUsage` folds from the session logs.
 * @module @deepseek-ai/dsh-api-usage-controller
 */

import type { Context } from '@deepseek-ai/cordis'
import { totalTokens } from '@deepseek-ai/dsh-session-usage'
import type { UsageByModel, UsageDay, UsageReport, UsageTotals } from '@deepseek-ai/dsh-session-usage'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
// Typert-generated ./typert and ./remote artifacts import Zod at runtime.
import type {} from 'zod'
import type {
  UsageByModelValue,
  UsageDayValue,
  UsageReportRequest,
  UsageReportValue,
  UsageTotalsValue,
} from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host usage Remote namespace owner. */
    usageController: UsageController
  }
}

/**
 * Project one bucket's totals into its Remote value.
 *
 * The billable sum comes from `totalTokens`, the one authority for which
 * buckets are billable, so the browser displays a figure it never computed.
 * @param totals - the folded totals.
 * @returns a detached JSON view carrying the billable sum.
 */
export function usageTotalsValue(totals: UsageTotals): UsageTotalsValue {
  return {
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    cacheReadTokens: totals.cacheReadTokens,
    cacheWriteTokens: totals.cacheWriteTokens,
    reasoningTokens: totals.reasoningTokens,
    totalTokens: totalTokens(totals),
    messages: totals.messages,
    sessions: totals.sessions,
  }
}

/**
 * Project one day's totals into its Remote value.
 * @param day - the folded day.
 * @returns the day key with its projected totals.
 */
export function usageDayValue(day: UsageDay): UsageDayValue {
  return { day: day.day, totals: usageTotalsValue(day.totals) }
}

/**
 * Project one provider route and model into its Remote value.
 * @param entry - the folded model entry.
 * @returns the route with its projected totals.
 */
export function usageByModelValue(entry: UsageByModel): UsageByModelValue {
  return { provider: entry.provider, model: entry.model, totals: usageTotalsValue(entry.totals) }
}

/**
 * Project one whole report into its Remote value.
 *
 * Day order and model order are the service's own and are preserved: days
 * ascend and carry no gap fillers, and models descend by billable tokens.
 * @param report - the folded report.
 * @returns the detached JSON view the dashboard renders.
 */
export function usageReportValue(report: UsageReport): UsageReportValue {
  return {
    overall: usageTotalsValue(report.overall),
    days: report.days.map(usageDayValue),
    byModel: report.byModel.map(usageByModelValue),
  }
}

/** Host service backing the generated `ctx.remote.usage` namespace. */
export class UsageController extends TypertRemoteService {
  static inject = ['sessionUsage']

  /** @param ctx - Host context carrying the cross-session usage service. */
  constructor(ctx: Context) {
    super(ctx, 'usageController', { namespace: 'usage' })
  }

  /**
   * Fold token usage over every recorded session for the dashboard.
   * @param request - inclusive local-day bounds; each absent bound is unbounded.
   * @returns overall totals, the per-day series, and the per-model split.
   * @throws when a bound is not a `YYYY-MM-DD` local calendar day.
   */
  @Remote('report')
  async report(request: UsageReportRequest): Promise<UsageReportValue> {
    return usageReportValue(await this.ctx.sessionUsage.report({
      ...request.since === undefined ? {} : { since: request.since },
      ...request.until === undefined ? {} : { until: request.until },
    }))
  }
}

export default UsageController
