import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /**
     * The notice this plugin injects when a budget pauses a goal. The kind is
     * the name released Hydra logs migrate this plugin's sources to.
     * @persistenceAttribution
     */
    'plugin:dsh-spend-guard': { kind: 'plugin:dsh-spend-guard' } & ContextFormed
  }
}

/** What the guard does when a budget is crossed. */
export type SpendAction = 'pause-goal' | 'stop'

/** Budget status of one session against the deployment's limits. */
export interface SpendStatus {
  readonly sessionId: SessionId
  /** Provider-reported tokens this session consumed since it was created or resumed in this process. */
  readonly sessionTokens: number
  /** Tokens every session consumed today (local date), persisted across restarts. */
  readonly dayTokens: number
  readonly perSessionTokens?: number
  readonly perDayTokens?: number
  readonly sessionExceeded: boolean
  readonly dayExceeded: boolean
}

/** The `ctx.spendGuard` service. */
export interface SpendGuardService {
  /**
   * Tokens a session consumed in this process.
   * @param sessionId - the session to total.
   * @returns input plus output tokens observed for that session.
   */
  sessionTokens(sessionId: SessionId): number
  /**
   * Tokens consumed today across sessions.
   * @returns the local-day total, including totals restored from storage.
   */
  dayTokens(): number
  /**
   * Status of a session against both budgets.
   * @param sessionId - the session to report.
   * @returns totals and whether each budget is exceeded.
   */
  status(sessionId: SessionId): SpendStatus
  /** Resolves once every day total recorded so far has been written durably. */
  settled(): Promise<void>
}
