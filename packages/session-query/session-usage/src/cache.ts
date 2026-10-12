/**
 * The derived-read CACHE behind `/usage`: per-session folded cells keyed by
 * session id and a freshness witness.
 *
 * This is a cache and never an authority. Every row is reproducible by folding
 * the session's log again, a row whose witness no longer matches is discarded,
 * and an empty or unreadable cache changes only how long a report takes.
 * @module
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { USAGE_FOLD_VERSION } from './fold.ts'
import type { UsageCell } from './types.ts'

const usageCellRecord = z.object({
  day: z.string(),
  provider: z.string(),
  model: z.string(),
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  cacheReadTokens: z.number().nonnegative(),
  cacheWriteTokens: z.number().nonnegative(),
  reasoningTokens: z.number().nonnegative(),
  messages: z.number().int().nonnegative(),
})

const usageSessionRecord = z.object({
  /**
   * Durable persistence revision observed with the folded log. Opaque and
   * comparable only for equality: an equal witness means the same log, and any
   * other value re-folds.
   */
  witness: z.string(),
  /** `USAGE_FOLD_VERSION` that produced `cells`. */
  foldVersion: z.number().int().nonnegative(),
  cells: z.array(usageCellRecord),
})

/** One cached session fold as it is stored. */
export type UsageSessionRecord = z.infer<typeof usageSessionRecord>

/**
 * The `session_usage_cache` domain: one record per session id.
 *
 * `invalidRecords: 'backup-and-skip'` is what makes an unreadable row behave
 * as a miss instead of failing the report — the row is moved aside and the
 * session is folded again from its log.
 */
export const sessionUsageCacheDomainSpec = defineDomain({
  name: 'session_usage_cache',
  version: 1,
  layout: 'per-record',
  invalidRecords: 'backup-and-skip',
  tables: {
    sessions: domainTable<SessionId, UsageSessionRecord>(usageSessionRecord),
  },
})

/**
 * The cells a cached row still stands for.
 *
 * A row is reusable only when the log it was folded from is provably the same
 * one — an equal witness — and the fold that produced it is the fold running
 * now. Every other case, a missing row included, is an ordinary miss: the
 * caller folds the log again and the answer is identical, only slower.
 * @param record - the stored row, or `undefined` when nothing is cached.
 * @param witness - the session's current freshness witness, or `undefined` when none is available.
 * @returns the reusable cells, or `undefined` when the session must be folded again.
 */
export function reusableCells(
  record: UsageSessionRecord | undefined,
  witness: string | undefined,
): readonly UsageCell[] | undefined {
  if (record === undefined || witness === undefined) return undefined
  if (record.witness !== witness || record.foldVersion !== USAGE_FOLD_VERSION) return undefined
  return record.cells
}
