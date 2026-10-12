import type { Message } from '@deepseek-ai/dsh-llm'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'

/** Log-only record of one hypothesis-scoring request, appended before the request is sent. */
export interface ResearchScoreEventData {
  /** The journal whose open hypotheses were scored. */
  readonly slug: string
  readonly route: { readonly provider: string; readonly model: string }
  readonly system: string
  readonly messages: readonly Message[]
  readonly maxTokens: number
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Log-only pre-dispatch record of one research hypothesis-scoring model request. */
    'session/research-score': ResearchScoreEventData
  }
}

/** Who recorded a journal entry. */
export type JournalEntrySource = 'model' | 'auto' | 'human'

/** Lifecycle of one research journal. */
export type JournalStatus = 'active' | 'paused' | 'done'

/** Truth status of a hypothesis. */
export type HypothesisStatus = 'open' | 'supported' | 'refuted'

/** A dated, attributed journal line: breakthroughs and dead ends. */
export interface JournalEntry {
  /** Stable id: `b-<hex>` for breakthroughs, `d-<hex>` for dead ends. */
  readonly id: string
  /** ISO-8601 time the entry was recorded. */
  readonly at: string
  /** Who recorded it. */
  readonly source: JournalEntrySource
  /** One or two sentences. */
  readonly text: string
}

/** A hypothesis with its current status and, once scored, the scorer's support estimate. */
export interface HypothesisEntry extends JournalEntry {
  /** `h-<hex>`. */
  readonly id: string
  readonly status: HypothesisStatus
  /** Support in `[0, 1]` from the latest scoring request; absent until scored. */
  readonly score?: number
  /** The scorer's one-sentence reason for the score. */
  readonly scoreReason?: string
}

/** An experiment and its outcome. */
export interface ExperimentEntry {
  /** `e-<hex>`. */
  readonly id: string
  /** ISO-8601 time the experiment was recorded. */
  readonly at: string
  /** Who recorded it. */
  readonly source: JournalEntrySource
  /** What was tried. */
  readonly what: string
  /** What happened. */
  readonly result: string
  /** Title a `run_experiment` call gave the run; repeats of a title get metric deltas. */
  readonly title?: string
  /** Metrics `run_experiment` read from the output. */
  readonly metrics?: Readonly<Record<string, number>>
  /** The hypothesis this experiment tested. */
  readonly hypothesisId?: string
}

/** Extra fields a `run_experiment` call records on an experiment. */
export interface ExperimentDetails {
  readonly title?: string
  readonly metrics?: Readonly<Record<string, number>>
  readonly hypothesisId?: string
}

/** One research goal's durable journal, the contents of `journal.md`. */
export interface Journal {
  /** Folder name under the research directory. */
  readonly slug: string
  /** The objective the goal works toward. */
  readonly objective: string
  /** What must hold for the research to be done. */
  readonly criteria: readonly string[]
  readonly status: JournalStatus
  /** ISO-8601 creation time. */
  readonly createdAt: string
  /** ISO-8601 time of the latest write. */
  readonly updatedAt: string
  /** Every session that ran `/research` for this slug, oldest first. */
  readonly sessions: readonly string[]
  readonly breakthroughs: readonly JournalEntry[]
  readonly hypotheses: readonly HypothesisEntry[]
  readonly experiments: readonly ExperimentEntry[]
  readonly deadEnds: readonly JournalEntry[]
  /** What the next round should do, in order. */
  readonly nextSteps: readonly string[]
}

/** Inputs for a new journal. */
export interface JournalInput {
  readonly slug: string
  readonly objective: string
  readonly criteria: readonly string[]
}

/** The journal folder of one workspace: `<dir>/<slug>/journal.md` per research goal. */
export interface JournalStore {
  /** Absolute research directory. */
  readonly dir: string
  /**
   * Create the directory, load every journal, and start watching for edits.
   * @returns resolves once the index is loaded.
   */
  open(): Promise<void>
  /**
   * Wait for the index to be loaded.
   * @returns resolves once {@link JournalStore.open} finished; rejects when opening failed or never started.
   */
  whenReady(): Promise<void>
  /** Stop watching; files stay as written. */
  close(): Promise<void>
  /**
   * Every journal, oldest first.
   * @returns the journals.
   */
  list(): Journal[]
  /**
   * One journal.
   * @param slug - the journal slug.
   * @returns the journal, or `undefined` when none exists.
   */
  get(slug: string): Journal | undefined
  /**
   * Create a journal file.
   * @param input - slug, objective, and criteria.
   * @returns the new journal.
   * @throws when the slug already exists or is malformed.
   */
  create(input: JournalInput): Promise<Journal>
  /**
   * Record a breakthrough.
   * @param slug - the journal.
   * @param text - one or two sentences.
   * @param source - who recorded it.
   * @returns the new entry.
   */
  addBreakthrough(slug: string, text: string, source: JournalEntrySource): Promise<JournalEntry>
  /**
   * Add an open hypothesis.
   * @param slug - the journal.
   * @param text - the hypothesis.
   * @param source - who recorded it.
   * @returns the new entry.
   */
  addHypothesis(slug: string, text: string, source: JournalEntrySource): Promise<HypothesisEntry>
  /**
   * Set a hypothesis status.
   * @param slug - the journal.
   * @param id - the hypothesis id.
   * @param status - the new status.
   * @returns the updated entry.
   * @throws when the hypothesis is unknown.
   */
  setHypothesis(slug: string, id: string, status: HypothesisStatus): Promise<HypothesisEntry>
  /**
   * Record an experiment and its result.
   * @param slug - the journal.
   * @param what - what was tried.
   * @param result - what happened.
   * @param source - who recorded it.
   * @param details - title, metrics, and hypothesis id from a `run_experiment` call.
   * @returns the new entry.
   */
  addExperiment(
    slug: string, what: string, result: string, source: JournalEntrySource, details?: ExperimentDetails,
  ): Promise<ExperimentEntry>
  /**
   * Record the scorer's support estimate for a hypothesis.
   * @param slug - the journal.
   * @param id - the hypothesis id.
   * @param score - support in `[0, 1]`.
   * @param reason - the scorer's one-sentence reason.
   * @returns the updated entry.
   * @throws when the hypothesis is unknown.
   */
  setHypothesisScore(slug: string, id: string, score: number, reason: string): Promise<HypothesisEntry>
  /**
   * Record a dead end.
   * @param slug - the journal.
   * @param text - what not to retry and why.
   * @param source - who recorded it.
   * @returns the new entry.
   */
  addDeadEnd(slug: string, text: string, source: JournalEntrySource): Promise<JournalEntry>
  /**
   * Replace the next steps.
   * @param slug - the journal.
   * @param steps - the steps, in order.
   * @returns the updated journal.
   */
  setNextSteps(slug: string, steps: readonly string[]): Promise<Journal>
  /**
   * Set the journal status.
   * @param slug - the journal.
   * @param status - the new status.
   * @returns the updated journal.
   */
  setStatus(slug: string, status: JournalStatus): Promise<Journal>
  /**
   * Record that a session works on this journal.
   * @param slug - the journal.
   * @param sessionId - the session.
   * @returns the updated journal.
   */
  attachSession(slug: string, sessionId: string): Promise<Journal>
  /**
   * Observe writes and external edits.
   * @param listener - called with the slug that changed.
   * @returns a disposer.
   */
  onChange(listener: (slug: string) => void): () => void
}

/** The research a session is working on. */
export interface ActiveResearch {
  readonly slug: string
  /** Workspace directory whose journal folder holds the slug. */
  readonly cwd: string
}

/** A finding to record from outside the model's own tool call. */
export interface ResearchFinding {
  readonly cwd: string
  readonly slug: string
  readonly kind: 'breakthrough' | 'result' | 'dead_end'
  /** For `result`: what was tried; otherwise the finding text. */
  readonly text: string
  /** For `result`: what happened. */
  readonly result?: string
}

/** Service published as `ctx.research`. */
export interface ResearchService {
  /** Configured journal directory: absolute, or relative to a workspace root. */
  readonly dir: string
  /**
   * The journal store of one workspace, opened on first use.
   * @param cwd - the workspace directory.
   * @returns the store; await `whenReady()` before reading.
   */
  storeFor(cwd: string): JournalStore
  /**
   * The research a live session's goal works on.
   * @param sessionId - the session.
   * @returns the slug and workspace, or `undefined` when the session has no research goal.
   */
  activeFor(sessionId: SessionId): ActiveResearch | undefined
  /**
   * Record a finding from an automated source.
   * @param finding - the finding and its journal.
   * @param source - who recorded it.
   * @returns resolves once the journal file is written.
   */
  record(finding: ResearchFinding, source: JournalEntrySource): Promise<void>
  /**
   * Announce one breakthrough, when `notify` is mounted.
   * @param journal - the journal the breakthrough belongs to.
   * @param text - the breakthrough text.
   */
  announceBreakthrough(journal: Journal, text: string): void
  /**
   * Re-rank a journal's open hypotheses with one logged scoring request. A
   * disabled scoring config, an absent route, a failed request, and an
   * unreadable answer are each logged and leave the recorded scores unchanged.
   * @param store - the store holding the journal.
   * @param slug - the journal slug.
   * @param session - session the request is logged against and whose route is reused by default.
   * @param signal - cancellation of the caller's tool call or round.
   * @returns resolves once the scores are written or the attempt is abandoned.
   */
  scoreHypotheses(store: JournalStore, slug: string, session: Session, signal: AbortSignal): Promise<void>
  /** Deployment bounds one `run_experiment` call enforces. */
  readonly experimentLimits: ExperimentLimits
}

/** Deployment bounds on one recorded experiment. */
export interface ExperimentLimits {
  /** Upper bound on a `run_experiment` timeout in milliseconds; a larger request is capped. */
  readonly maxExperimentMs: number
  /** Byte cap on the output a `run_experiment` call records and returns. */
  readonly maxOutputBytes: number
}
