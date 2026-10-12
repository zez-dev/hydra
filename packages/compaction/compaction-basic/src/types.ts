/**
 * Configuration vocabulary for the replay-aware basic compaction backend.
 *
 * @module @deepseek-ai/dsh-compaction-basic/types
 */

import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'

/** Policy fields shared by the default policy and exact model overrides. */
export interface CompactionPolicyConfig {
  /** Compact at this fraction of the model's context window. Defaults to `0.8`. */
  thresholdRatio?: number
  /** Recent context retained as a fraction of the model's window. Defaults to `0.16`. */
  retainRatio?: number
  /** Absolute recent-context budget; mutually exclusive with `retainRatio`. */
  retainTokens?: number
  /** Summary provider; set together with `summarizationModel`, or inherit the conversation target. */
  summarizationProvider?: string
  /** Summary model; set together with `summarizationProvider`, or inherit the conversation target. */
  summarizationModel?: string
  /** Provider generation cap for summarization. Defaults to `8192`. */
  maxTokens?: number
  /** Extra attempts after the first compaction when pressure remains above threshold. Defaults to `1`. */
  compactionRetries?: number
  /** Maximum retries after canonical context overflow; `0` disables recovery. Defaults to `1`. */
  maxOverflowRetries?: number
  /**
   * Fraction of the window kept free beyond the request's output cap, absorbing
   * heuristic pricing error on code and JSON. A request must fit in
   * `contextWindow − outputCap − margin`. Defaults to `0.05`.
   */
  reserveMarginRatio?: number
  /**
   * Fraction of the window reserved for the reply when deciding to condense:
   * the surface condenses once it leaves less than the lower of the output
   * cap and `contextWindow × outputReserveRatio`, plus the margin. A request
   * that leaves less than its whole cap asks for the room left instead.
   * Defaults to `0.25`.
   */
  outputReserveRatio?: number
  /**
   * Steps a failed step-boundary compaction waits before trying again, unless the surface grows by
   * `failureBackoffGrowthRatio` of the window, a checkpoint lands, or a reply is cut at its output
   * cap first. Defaults to `8`.
   */
  failureBackoffSteps?: number
  /** Fraction of the window the surface must grow by to retry before `failureBackoffSteps` pass. Defaults to `0.1`. */
  failureBackoffGrowthRatio?: number
  /** Smallest output cap a request is shrunk to when condensing cannot make room. Defaults to `256`. */
  minOutputTokens?: number
  /**
   * Upper bound on the summarization cap as a fraction of the window, so a
   * `maxTokens` sized for large models does not reserve most of a small
   * window. Defaults to `0.25`.
   */
  summaryWindowRatio?: number
  /**
   * Multiplier for the summarization cap after a checkpoint was cut at it,
   * applied up to three times and never above what the window affords
   * (`summaryWindowRatio` and the room the condensed range leaves); `1`
   * disables the retry. Defaults to `4`.
   */
  outputRetryFactor?: number
}

/** Exact provider/model override merged over the default compaction policy. */
export interface ModelCompactPolicyConfig extends CompactionPolicyConfig {
  /** Registered provider route to match. */
  provider: string
  /** Exact routed model id to match within `provider`. */
  model: string
}

/** Basic compaction configuration with an optional exact-target policy table. */
export interface BasicCompactionConfig extends CompactionPolicyConfig {
  /** Exact provider/model overrides; duplicate targets fail plugin load. */
  modelPolicies?: ModelCompactPolicyConfig[]
  /** Enable automatic step-boundary pressure and overflow-recovery listeners. Defaults to `true`. */
  auto?: boolean
}

/** Exactly one validated retention form. */
export type ResolvedRetention =
  | { readonly retainRatio: number; readonly retainTokens?: never }
  | { readonly retainRatio?: never; readonly retainTokens: number }

/** Validated policy fields shared before and after exact-target matching. */
interface ResolvedPolicyFields {
  readonly thresholdRatio: number
  readonly summarizationProvider: string
  readonly summarizationModel: string
  readonly maxTokens: number
  readonly compactionRetries: number
  readonly maxOverflowRetries: number
  readonly reserveMarginRatio: number
  readonly outputReserveRatio: number
  readonly failureBackoffSteps: number
  readonly failureBackoffGrowthRatio: number
  readonly minOutputTokens: number
  readonly summaryWindowRatio: number
  readonly outputRetryFactor: number
}

/** Validated immutable config whose target-specific defaults remain unresolved. */
export type ResolvedConfig = ResolvedPolicyFields & ResolvedRetention & {
  readonly modelPolicies: readonly Readonly<ModelCompactPolicyConfig>[]
  readonly auto: boolean
}

/** Fully merged policy for one routed conversation target, before capacity scaling. */
export type ResolvedTargetPolicy = ResolvedPolicyFields & ResolvedRetention & {
  readonly target: Pick<LlmCallConfig, 'provider' | 'model'>
}

/** One routed model's concrete pressure and retention budget. */
export type ResolvedCompactSpec = Omit<ResolvedTargetPolicy, 'retainRatio' | 'retainTokens'> & {
  readonly contextWindow: number
  readonly thresholdTokens: number
  readonly retainTokens: number
  /** Tokens kept free beyond the output cap: `floor(contextWindow × reserveMarginRatio)`. */
  readonly marginTokens: number
  /** Most tokens the condense decision reserves for the reply: `floor(contextWindow × outputReserveRatio)`. */
  readonly outputReserveTokens: number
  /** Growth after a failed compaction that ends its backoff early: `floor(contextWindow × failureBackoffGrowthRatio)`. */
  readonly failureBackoffGrowthTokens: number
  /** The summarization cap this window affords: `min(maxTokens, floor(contextWindow × summaryWindowRatio))`. */
  readonly summaryCapTokens: number
  /** The most a cut checkpoint's cap may be raised to: `floor(contextWindow × summaryWindowRatio)`. */
  readonly summaryCeilingTokens: number
}
