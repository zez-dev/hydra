/**
 * Cross-session token usage, derived from the session logs.
 *
 * The logs are the only authority: every report folds the provider usage each
 * `assistant/message` recorded, so history written before this plugin existed
 * counts, and no durable counter can drift away from what was billed. A scan
 * is O(all history), so per-session folds are cached behind a freshness
 * witness; the cache only changes how long a report takes. Publishes
 * `ctx.sessionUsage` and `/usage`. Named exports preserve Loader injection
 * metadata.
 * @module @deepseek-ai/dsh-session-usage
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-session-query'
// Type-only: resolves the optional `sessionPersistence` declaration read through `ctx.get`.
import type {} from '@deepseek-ai/dsh-session-persistence'
import { reusableCells, sessionUsageCacheDomainSpec, type UsageSessionRecord } from './cache.ts'
import { foldSessionUsage, USAGE_FOLD_VERSION } from './fold.ts'
import { aggregateUsage, type SessionCells } from './report.ts'
import { renderUsageReport } from './render.ts'
import type { SessionUsageService, UsageCell, UsageReport, UsageReportOptions } from './types.ts'

export type * from './types.ts'
export { USAGE_FOLD_VERSION, foldSessionUsage } from './fold.ts'
export { aggregateUsage, totalTokens } from './report.ts'
export type { SessionCells } from './report.ts'
export { renderUsageReport } from './render.ts'
export { reusableCells, sessionUsageCacheDomainSpec } from './cache.ts'
export type { UsageSessionRecord } from './cache.ts'

export const name = 'session-usage'
export const inject = ['sessionQuery', 'commands', 'storageDomain']

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionUsage: SessionUsageService
  }
}

/** A local calendar day key, the only form `since` and `until` accept. */
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/

/**
 * Refuse a bound that is not a local calendar day.
 * @param name - the option being checked, named in the failure.
 * @param value - the caller's bound, or `undefined` for an unbounded end.
 * @throws when the bound is present and not `YYYY-MM-DD`.
 */
function assertDayKey(name: 'since' | 'until', value: string | undefined): void {
  if (value !== undefined && !DAY_KEY.test(value)) {
    throw new Error(`session-usage: ${name} must be a local calendar day as YYYY-MM-DD, not ${JSON.stringify(value)}`)
  }
}

/**
 * Publish `ctx.sessionUsage` and register `/usage`.
 * @param ctx - plugin context carrying `sessionQuery`, `commands`, and `storageDomain`; `sessionPersistence` is read when mounted.
 */
export async function apply(ctx: Context): Promise<void> {
  const domain: Domain<typeof sessionUsageCacheDomainSpec> = await ctx.storageDomain.open(sessionUsageCacheDomainSpec)
  ctx.effect(() => () => domain.close(), 'sessionUsage.domainClose')
  const cache: KvTable<SessionId, UsageSessionRecord> = domain.table('sessions')

  /**
   * Durable freshness witnesses for every stored session, by id.
   *
   * `SessionPersistence.stat`/`list` revisions exist for exactly this — derived
   * read-model caches — and `list` produces them from metadata alone, so the
   * scan learns which logs changed without opening one. A revision promises
   * only that an EQUAL value means an unchanged log, which is the one
   * direction a cache needs; anything else folds again.
   */
  async function witnesses(signal?: AbortSignal): Promise<Map<SessionId, string>> {
    const persistence = ctx.get('sessionPersistence')
    if (persistence === undefined) return new Map()
    const snapshots = await persistence.list({ ...signal === undefined ? {} : { signal } })
    return new Map(snapshots.map(snapshot => [snapshot.header.id, snapshot.revision]))
  }

  async function foldSession(sessionId: SessionId, signal?: AbortSignal): Promise<{
    cells: UsageCell[]
    /** The revision paired with the events actually folded, absent for a live source. */
    witness?: string
  }> {
    using observation = await ctx.sessionQuery.observeSession(sessionId, {
      ...signal === undefined ? {} : { signal },
      projectionMode: 'none',
    })
    const cells = foldSessionUsage(observation.events, observation.inheritedEventCount)
    // Pair the row with the revision this observation read, not the listed
    // one: a log appended to between the listing and the read would otherwise
    // be recorded as folded at a revision it never had.
    return { cells, ...observation.revision === undefined ? {} : { witness: observation.revision } }
  }

  /**
   * Absorb one cache write's failure. The cache is derived state, so a storage
   * fault must cost speed on the next report and nothing else; the figures
   * being returned came from the logs and are already correct.
   */
  function cached(sessionId: SessionId, write: Promise<void>): Promise<void> {
    return write.catch((error: unknown) => {
      ctx.logger.warn(`session-usage: could not cache "${sessionId}": ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  async function report(options: UsageReportOptions = {}): Promise<UsageReport> {
    // The bound is applied here, so every caller — the tool's model-supplied
    // arguments included — is checked at the one operation that uses it.
    assertDayKey('since', options.since)
    assertDayKey('until', options.until)
    const signal = options.signal
    signal?.throwIfAborted()
    const records = await ctx.sessionQuery.listSessions(signal)
    signal?.throwIfAborted()
    const current = await witnesses(signal)
    signal?.throwIfAborted()
    const sessions: SessionCells[] = []
    const writes: Promise<void>[] = []
    for (const record of records) {
      signal?.throwIfAborted()
      const sessionId = record.header.id
      // A live session's log is still growing and has no durable revision, so
      // it is folded on every report rather than read back from a row.
      const reusable = record.live ? undefined : reusableCells(cache.get(sessionId), current.get(sessionId))
      if (reusable !== undefined) {
        sessions.push({ key: sessionId, cells: reusable })
        continue
      }
      const folded = await foldSession(sessionId, signal)
      sessions.push({ key: sessionId, cells: folded.cells })
      if (folded.witness !== undefined) {
        writes.push(cached(sessionId, cache.put(sessionId, {
          witness: folded.witness,
          foldVersion: USAGE_FOLD_VERSION,
          cells: folded.cells,
        })))
      }
    }
    // A session removed from the corpus must stop contributing, so its row goes
    // with it rather than outliving the log it was derived from.
    const present = new Set(records.map(record => record.header.id))
    for (const sessionId of [...cache.keys()]) {
      if (!present.has(sessionId)) writes.push(cached(sessionId, cache.delete(sessionId).then(() => {})))
    }
    await Promise.all(writes)
    return aggregateUsage(sessions, {
      ...options.since === undefined ? {} : { since: options.since },
      ...options.until === undefined ? {} : { until: options.until },
    })
  }

  const service: SessionUsageService = { report }
  ctx.provide('sessionUsage', service)

  ctx.effect(() => ctx.commands.register({
    name: 'usage',
    description: 'Show token usage across every session: totals, a per-model table, and the last 12 weeks by day',
    handler: async (): Promise<CommandResult> => ({
      kind: 'success',
      text: renderUsageReport(await report()),
    }),
  }))
}
