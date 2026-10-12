import type { SessionId } from '@deepseek-ai/dsh-session'

/** One configured wall-clock window; `start` later than `end` wraps past midnight. */
export interface OffPeakWindow {
  /** Zero-padded 24-hour local start time, `HH:MM`. */
  readonly start: string
  /** Zero-padded 24-hour local end time, `HH:MM`, exclusive. */
  readonly end: string
}

/** One window reduced to local-time minute bounds. */
export interface ParsedWindow {
  /** Minutes since local midnight when the window opens. */
  readonly startMinute: number
  /** Minutes since local midnight when the window closes, exclusive. */
  readonly endMinute: number
}

/** What a queued entry represents. */
export type OffPeakKind = 'goal-round' | 'manual'

/** Lifecycle of one queued entry. */
export type OffPeakState = 'queued' | 'running' | 'done' | 'failed'

/** One durable queue entry. */
export interface OffPeakEntry {
  readonly id: string
  /** Session whose work was deferred, or that a manual task runs in. */
  readonly sessionId: SessionId
  readonly kind: OffPeakKind
  /** The goal objective for a deferred round, or the task text for a manual entry. */
  readonly objective?: string
  /** Absolute workspace directory, recorded for a manual entry. */
  readonly cwd?: string
  /** Epoch milliseconds when the entry was queued. */
  readonly queuedAt: number
  readonly state: OffPeakState
  /** Epoch milliseconds when the drainer last started this entry. */
  readonly startedAt?: number
  /** Why the entry failed, when it did. */
  readonly error?: string
}

/** Counts reported after a window drains. */
export interface OffPeakDrainSummary {
  readonly started: number
  readonly done: number
  readonly failed: number
  /** Entries still queued when the window closed. */
  readonly remaining: number
}

/** The `ctx.offPeak` service. */
export interface OffPeakService {
  /**
   * Whether a window is open right now.
   * @returns true while the clock lies inside a configured window, and always
   *   true when the plugin is disabled, so callers need no separate check.
   */
  isOpen(): boolean
  /**
   * Every queue entry, oldest first.
   * @returns the stored entries in queue order.
   */
  list(): OffPeakEntry[]
  /**
   * Queue a task to run in the next window.
   * @param input - the session to run in, the task text, and its workspace.
   * @returns the stored entry.
   */
  queue(input: { sessionId: SessionId; objective: string; cwd?: string }): Promise<OffPeakEntry>
  /**
   * Remove one queued entry.
   * @param id - the entry id.
   */
  cancel(id: string): Promise<void>
  /**
   * Drain the queue now, regardless of the clock.
   * @returns what the drain started and finished.
   */
  drain(): Promise<OffPeakDrainSummary>
}

/** Payload of `off-peak/change`. */
export interface OffPeakChange {
  readonly id: string
  readonly kind: 'queued' | 'started' | 'finished' | 'cancelled'
  readonly sessionId: SessionId
}
