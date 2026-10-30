import type { ContextFormed, Message } from '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /**
     * The evaluation request this plugin sends beside the conversation. The kind
     * is the name released Hydra logs migrate this plugin's sources to.
     * @persistenceAttribution
     */
    'plugin:dsh-goal-evaluator': { kind: 'plugin:dsh-goal-evaluator' } & ContextFormed
  }
}

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
