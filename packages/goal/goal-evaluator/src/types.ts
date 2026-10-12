import type { Message } from '@deepseek-ai/dsh-llm'

/** The evaluator's answer. */
export interface GoalVerdict {
  /** `achieved` lets the completion through; `not-yet` denies it with the reasons. */
  readonly verdict: 'achieved' | 'not-yet'
  /** Model-visible justification, one sentence per entry. */
  readonly reasons: readonly string[]
}

/** Log-only record of one goal evaluation request, written before the model is called. */
export interface GoalEvaluationEventData {
  /** Goal identity under evaluation. */
  readonly goalId: string
  /** Goal revision the model tried to complete. */
  readonly revision: number
  /** Provider and model that answered. */
  readonly route: { readonly provider: string; readonly model: string }
  /** Exact system prompt sent. */
  readonly system: string
  /** Exact messages sent. */
  readonly messages: readonly Message[]
  /** Output-token cap sent. */
  readonly maxTokens: number
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Log-only pre-dispatch record of one goal-evaluation model request. */
    'session/goal-evaluation': GoalEvaluationEventData
  }
}
