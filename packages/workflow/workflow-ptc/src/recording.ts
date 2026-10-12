/**
 * Binds one workflow run to the durable journal, when a journal Service
 * Provider is mounted. The run records calls as they settle and waits for its
 * closing write before its result resolves; a journal failure is logged and
 * never reaches the script.
 * @module @deepseek-ai/dsh-workflow-ptc/recording
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {
  JournalCall,
  WorkflowJournalService,
  WorkflowMeta,
  WorkflowResult,
  WorkflowRunId,
  WorkflowRunRecord,
} from '@deepseek-ai/dsh-workflow'
import { renderThrown } from './realm.ts'

/**
 * A run's durable journal attachment. Writes are ordered by the journal
 * Service Provider, so `record` returns nothing and the run keeps executing
 * while the write lands.
 */
export interface RunRecording {
  /** Completed calls of the resumed run, by ordinal; empty for a fresh run. */
  readonly replay: ReadonlyMap<number, JournalCall>
  /**
   * Queue one settled call.
   * @param call - the settled call, at its ordinal in this run.
   */
  record(call: JournalCall): void
  /**
   * Queue the run's terminal result and wait for the journal to be durable.
   * @param result - the run's terminal result.
   * @returns once the write landed or failed; it never rejects.
   */
  close(result: WorkflowResult): Promise<void>
}

/** What a new run's opening journal record needs. */
export interface RecordingRequest {
  /** The new run's id. */
  readonly id: WorkflowRunId
  /** The session whose agent the run executes on behalf of. */
  readonly sessionId: SessionId
  /** Hash of the script body this run executes. */
  readonly scriptHash: string
  /** The run's validated meta block. */
  readonly meta: WorkflowMeta
  /** The run being resumed, when this run is a resume. */
  readonly resumedFrom?: WorkflowRunId
  /** Completed calls this run may replay, by ordinal. */
  readonly replay: ReadonlyMap<number, JournalCall>
}

/**
 * Select the calls of a journaled run that a resume may replay: a call is
 * replayable only when the child completed and its recorded result survived
 * the journal's storage, so a rate-limited or cut-off child runs again rather
 * than reproducing its failure.
 * @param record - the journaled run being resumed.
 * @returns the replayable calls, by ordinal.
 */
export function replayableCalls(record: WorkflowRunRecord): ReadonlyMap<number, JournalCall> {
  return new Map(record.calls
    .filter(call => call.outcome.ok && call.outcome.value !== undefined)
    .map(call => [call.ordinal, call]))
}

/**
 * Open a journal record for a run and return its recorder.
 * @param ctx - the context whose logger reports journal failures.
 * @param journal - the mounted journal service.
 * @param request - the run's identity and its replay source.
 * @returns the recorder the run writes through.
 */
export function attachRecording(ctx: Context, journal: WorkflowJournalService, request: RecordingRequest): RunRecording {
  const warn = (error: unknown): void => {
    ctx.logger.warn(`workflow-ptc: journal write failed: ${renderThrown(error)}`)
  }
  // The opening write is not awaited; the journal orders it ahead of every
  // later write for this run id, so a call that settles first is not dropped.
  void journal.open({
    id: request.id,
    sessionId: request.sessionId,
    scriptHash: request.scriptHash,
    meta: request.meta,
    ...request.resumedFrom === undefined ? {} : { resumedFrom: request.resumedFrom },
  }).catch(warn)
  return {
    replay: request.replay,
    record: (call) => { void journal.record(request.id, call).catch(warn) },
    close: result => journal.close(request.id, result).catch(warn),
  }
}
