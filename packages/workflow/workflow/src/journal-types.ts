/**
 * Durable workflow-run vocabulary: what a Service Provider stores for a run
 * and every `agent()` call that settled, so a later run of the same script
 * replays matched calls instead of spawning them again. Types only, and free
 * of host Cordis declarations, per the package convention.
 *
 * @module @deepseek-ai/dsh-workflow/journal-types
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkflowMeta, WorkflowResult, WorkflowRunId } from './types.ts'

/**
 * Lifecycle of a journaled run. A run is `running` only while its process
 * lives, so a run still marked `running` when the journal next opens died
 * with its process and reconciles to `interrupted`.
 */
export type WorkflowRunState = 'running' | 'done' | 'failed' | 'interrupted'

/**
 * The settled outcome of one `agent()` call. `ok` means the child reached
 * `stopReason: 'completed'`, which is the only outcome a resume replays; a
 * child that failed for its own reasons is recorded not-ok so the resume runs
 * it again.
 */
export interface JournalCallOutcome {
  /** Whether the call completed and may be replayed. */
  readonly ok: boolean
  /** The child's JSON result, present when `ok`. */
  readonly value?: unknown
  /** Why the call is not replayable, present when not `ok`. */
  readonly error?: string
}

/** One `agent()` call that reached a terminal state. */
export interface JournalCall {
  /** 1-based position in the run's call order; the replay key together with {@link JournalCall.keyHash}. */
  readonly ordinal: number
  /** The only call kind a workflow script makes today. */
  readonly kind: 'agent'
  /** Stable hash of the call's inputs; an edited prompt or route changes it. */
  readonly keyHash: string
  /** The child session the call ran on, so a replay names the session holding the output. */
  readonly childId: string
  /** The `agent()` label, when the run observed one before the call settled. */
  readonly label?: string
  /** The phase the call ran under, when the run observed one. */
  readonly phase?: string
  /** ISO timestamp of settlement. */
  readonly settledAt: string
  /** How the call settled. */
  readonly outcome: JournalCallOutcome
}

/** One journaled workflow run and its settled calls. */
export interface WorkflowRunRecord {
  /** The run's id. */
  readonly id: WorkflowRunId
  /** The session whose agent the run executed on behalf of. */
  readonly sessionId: SessionId
  /** Stable hash of the script body, so a resume can report that the script changed. */
  readonly scriptHash: string
  /** The run's validated meta block. */
  readonly meta: WorkflowMeta
  /** ISO timestamp of the opening record. */
  readonly startedAt: string
  /** Where the run is in its lifecycle. */
  readonly state: WorkflowRunState
  /** ISO timestamp of settlement or reconciliation, present once the run is not `running`. */
  readonly finishedAt?: string
  /** The run's terminal result, present once it settled. */
  readonly result?: WorkflowResult
  /** The run this one resumed, when it was a resume. */
  readonly resumedFrom?: WorkflowRunId
  /** Settled calls in the order they were recorded. */
  readonly calls: readonly JournalCall[]
}

/** What a resume would do, without running anything. */
export interface ResumePlan {
  /** The run the plan describes. */
  readonly runId: WorkflowRunId
  /** Calls a replay could match, given an unchanged script. */
  readonly replayable: number
  /** Whether the stored script differs from the one the resume would run. */
  readonly scriptChanged: boolean
  /** The stored run's lifecycle state. */
  readonly state: WorkflowRunState
}

/** What one run opens with, before any call settles. */
export interface WorkflowRunOpen {
  /** The new run's id. */
  readonly id: WorkflowRunId
  /** The session whose agent the run executes on behalf of. */
  readonly sessionId: SessionId
  /** Hash of the script body the run executes. */
  readonly scriptHash: string
  /** The run's validated meta block. */
  readonly meta: WorkflowMeta
  /** The run being resumed, when this run is a resume. */
  readonly resumedFrom?: WorkflowRunId
}

/**
 * Durable record of workflow runs. A Service Provider orders writes per run
 * id, so a caller may start `open`, `record` and `close` without awaiting the
 * previous one and still have them applied in call order; a `record` that
 * names a run the journal never opened is dropped rather than inventing one.
 */
export interface WorkflowJournalService {
  /**
   * Record a run as it starts.
   * @param open - the run's identity, session, script hash and meta.
   * @returns once the opening record is durable.
   */
  open(open: WorkflowRunOpen): Promise<void>

  /**
   * Append one settled `agent()` call to a run.
   * @param id - the run the call belongs to.
   * @param call - the settled call.
   * @returns once the call is durable.
   */
  record(id: WorkflowRunId, call: JournalCall): Promise<void>

  /**
   * Close a run with its terminal result.
   * @param id - the run that settled.
   * @param result - the run's terminal result.
   * @returns once the closing record is durable.
   */
  close(id: WorkflowRunId, result: WorkflowResult): Promise<void>

  /**
   * Read one run.
   * @param id - the run to read.
   * @returns the record, or `undefined` when the journal has never seen it.
   */
  get(id: WorkflowRunId): WorkflowRunRecord | undefined

  /**
   * Read recent runs, newest first.
   * @param limit - maximum records to return; the Service Provider's configured page size by default.
   * @returns the records, newest first.
   */
  list(limit?: number): readonly WorkflowRunRecord[]

  /**
   * Describe what resuming a run with a given script would replay.
   * @param id - the run to resume.
   * @param scriptHash - hash of the script body the resume would run.
   * @returns the plan, or `undefined` when the journal has never seen the run.
   */
  plan(id: WorkflowRunId, scriptHash: string): ResumePlan | undefined
}
