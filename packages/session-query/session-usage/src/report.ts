/**
 * Aggregation from per-session cells to one {@link UsageReport}.
 * @module
 */

import type { UsageByModel, UsageCell, UsageDay, UsageReport, UsageTotals } from './types.ts'

/** One session's cells, as the aggregator consumes them. */
export interface SessionCells {
  /** The session the cells were folded from; counted once per bucket it touches. */
  readonly key: string
  readonly cells: readonly UsageCell[]
}

interface MutableTotals {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  messages: number
  sessions: Set<string>
}

const emptyTotals = (): MutableTotals => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  messages: 0,
  sessions: new Set<string>(),
})

function accumulate(totals: MutableTotals, cell: UsageCell, sessionKey: string): void {
  totals.inputTokens += cell.inputTokens
  totals.outputTokens += cell.outputTokens
  totals.cacheReadTokens += cell.cacheReadTokens
  totals.cacheWriteTokens += cell.cacheWriteTokens
  totals.reasoningTokens += cell.reasoningTokens
  totals.messages += cell.messages
  totals.sessions.add(sessionKey)
}

function freeze(totals: MutableTotals): UsageTotals {
  return {
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    cacheReadTokens: totals.cacheReadTokens,
    cacheWriteTokens: totals.cacheWriteTokens,
    reasoningTokens: totals.reasoningTokens,
    messages: totals.messages,
    sessions: totals.sessions.size,
  }
}

/**
 * Billable tokens of one bucket: uncached input plus both cache buckets plus
 * output. Reasoning is a subset of output, so it is not added again.
 * @param totals - one bucket's totals.
 * @returns the summed billable tokens.
 */
export function totalTokens(totals: UsageTotals): number {
  return totals.inputTokens + totals.cacheReadTokens + totals.cacheWriteTokens + totals.outputTokens
}

/**
 * Aggregate every session's cells into overall, per-day, and per-model totals.
 *
 * `since` and `until` are inclusive `YYYY-MM-DD` keys compared
 * lexicographically against each cell's own day, which is exact because both
 * sides are zero-padded local calendar keys.
 * @param sessions - folded cells, one entry per contributing session.
 * @param bounds - inclusive day bounds; an absent bound is unbounded.
 * @returns the report for the bounded slice.
 */
export function aggregateUsage(
  sessions: readonly SessionCells[],
  bounds: { since?: string | undefined; until?: string | undefined } = {},
): UsageReport {
  const overall = emptyTotals()
  const days = new Map<string, MutableTotals>()
  const models = new Map<string, { provider: string; model: string; totals: MutableTotals }>()
  for (const session of sessions) {
    for (const cell of session.cells) {
      if (bounds.since !== undefined && cell.day < bounds.since) continue
      if (bounds.until !== undefined && cell.day > bounds.until) continue
      accumulate(overall, cell, session.key)
      let day = days.get(cell.day)
      if (day === undefined) days.set(cell.day, day = emptyTotals())
      accumulate(day, cell, session.key)
      const modelKey = `${cell.provider}\u0000${cell.model}`
      let model = models.get(modelKey)
      if (model === undefined) {
        models.set(modelKey, model = { provider: cell.provider, model: cell.model, totals: emptyTotals() })
      }
      accumulate(model.totals, cell, session.key)
    }
  }
  const daySeries: UsageDay[] = [...days.entries()]
    // Map keys are distinct days, so the comparator never sees two equal keys.
    .sort(([left], [right]) => left < right ? -1 : 1)
    .map(([day, totals]) => ({ day, totals: freeze(totals) }))
  const byModel: UsageByModel[] = [...models.values()]
    .map(entry => ({ provider: entry.provider, model: entry.model, totals: freeze(entry.totals) }))
    .sort((left, right) => {
      const delta = totalTokens(right.totals) - totalTokens(left.totals)
      if (delta !== 0) return delta
      // A stable order for equal totals keeps repeated reports comparable.
      return `${left.provider}/${left.model}` < `${right.provider}/${right.model}` ? -1 : 1
    })
  return { overall: freeze(overall), days: daySeries, byModel }
}
