/** The dashboard's Remote face: one report read over the usage namespace. */
import type { ClientRemote, UsageReportRequest, UsageReportValue } from '@deepseek-ai/dsh-api-remotes/client'

/** What the dashboard needs from the Host. */
export interface UsageInjected {
  /**
   * Fold token usage over every recorded session.
   * @param request - inclusive `YYYY-MM-DD` bounds; each absent bound is unbounded.
   * @returns overall totals, the day series, and the per-model split.
   */
  report: (request: UsageReportRequest) => Promise<UsageReportValue>
}

type Result<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } }

/** Unwrap one Remote result, throwing the Host business error. */
function unwrap<T>(name: string, result: Result<T>): T {
  if (!result.ok) throw new Error(`usage.${name} failed: ${result.error.code}: ${result.error.message}`)
  return result.value
}

/**
 * Bind the dashboard's face to the Client Remote.
 * @param remote - the Client Remote carrying the usage namespace.
 * @returns the injected face.
 */
export function usageFace(remote: ClientRemote): UsageInjected {
  return {
    report: async request => unwrap('report', await remote.usage.report(request)),
  }
}
