/**
 * Load-time validation and routed-model policy resolution for compaction-basic.
 *
 * @module @deepseek-ai/dsh-compaction-basic/config
 */

import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import type {
  BasicCompactionConfig,
  CompactionPolicyConfig,
  ModelCompactPolicyConfig,
  ResolvedCompactSpec,
  ResolvedConfig,
  ResolvedRetention,
  ResolvedTargetPolicy,
} from './types.ts'

/** Default request-pressure fraction for every routed model. */
const DEFAULT_THRESHOLD_RATIO = 0.8

/** Default verbatim-tail fraction for every routed model. */
const DEFAULT_RETAIN_RATIO = 0.16
/** Default free fraction of the window beyond the output cap. */
const DEFAULT_RESERVE_MARGIN_RATIO = 0.05
/** Default share of the window reserved for the reply when deciding to condense. */
const DEFAULT_OUTPUT_RESERVE_RATIO = 0.25
/** Default steps a failed compaction waits before trying again. */
const DEFAULT_FAILURE_BACKOFF_STEPS = 8
/** Default window fraction of growth that ends a backoff early. */
const DEFAULT_FAILURE_BACKOFF_GROWTH_RATIO = 0.1
/** Default floor for a request output cap shrunk to fit the window. */
const DEFAULT_MIN_OUTPUT_TOKENS = 256
/** Default bound on the summarization cap as a fraction of the window. */
const DEFAULT_SUMMARY_WINDOW_RATIO = 0.25
/** Default multiplier for the summarization cap after a cut checkpoint. */
const DEFAULT_OUTPUT_RETRY_FACTOR = 4

/** Fields shared by top-level defaults and exact-target overrides. */
const POLICY_CONFIG_KEYS = [
  'thresholdRatio',
  'retainRatio',
  'retainTokens',
  'summarizationProvider',
  'summarizationModel',
  'maxTokens',
  'compactionRetries',
  'maxOverflowRetries',
  'reserveMarginRatio',
  'outputReserveRatio',
  'failureBackoffSteps',
  'failureBackoffGrowthRatio',
  'minOutputTokens',
  'summaryWindowRatio',
  'outputRetryFactor',
] as const

/** Complete public top-level configuration key set. */
const BASIC_COMPACT_CONFIG_KEYS: ReadonlySet<string> = new Set([
  ...POLICY_CONFIG_KEYS,
  'modelPolicies',
  'auto',
])

/** Complete exact-target override key set. */
const MODEL_POLICY_KEYS: ReadonlySet<string> = new Set([
  'provider',
  'model',
  ...POLICY_CONFIG_KEYS,
])

/** Target-specific pressure configuration failure eligible for warning suppression. */
export class TargetPressureConfigError extends Error {
  /**
   * @param targetKey - exact provider/model route used as the warning key.
   * @param message - actionable configuration failure detail.
   */
  constructor(readonly targetKey: string, message: string) {
    super(message)
  }
}

/**
 * Resolve and validate service defaults plus exact-target partial overrides.
 * @param config - untrusted plugin configuration after Loader normalization.
 * @returns detached immutable defaults and validated exact-target overrides.
 */
export function resolveConfig(config: BasicCompactionConfig = {}): ResolvedConfig {
  validateKeys(config, BASIC_COMPACT_CONFIG_KEYS, 'BasicCompactionConfig')
  validatePolicy(config, 'BasicCompactionConfig')
  if (config.auto !== undefined && typeof config.auto !== 'boolean') {
    throw new Error('BasicCompactionConfig: auto must be a boolean')
  }

  const thresholdRatio = config.thresholdRatio ?? DEFAULT_THRESHOLD_RATIO
  const retention = resolveRetention(config, { retainRatio: DEFAULT_RETAIN_RATIO })
  validateRatioRetention(thresholdRatio, retention, 'BasicCompactionConfig')
  const modelPolicies = resolveModelPolicies(config.modelPolicies)
  for (const [index, policy] of modelPolicies.entries()) {
    validateRatioRetention(
      policy.thresholdRatio ?? thresholdRatio,
      resolveRetention(policy, retention),
      `BasicCompactionConfig: modelPolicies[${index}]`,
    )
  }

  return deepFreeze({
    thresholdRatio,
    ...retention,
    summarizationProvider: config.summarizationProvider ?? '',
    summarizationModel: config.summarizationModel ?? '',
    maxTokens: config.maxTokens ?? 8192,
    compactionRetries: config.compactionRetries ?? 1,
    maxOverflowRetries: config.maxOverflowRetries ?? 1,
    reserveMarginRatio: config.reserveMarginRatio ?? DEFAULT_RESERVE_MARGIN_RATIO,
    outputReserveRatio: config.outputReserveRatio ?? DEFAULT_OUTPUT_RESERVE_RATIO,
    failureBackoffSteps: config.failureBackoffSteps ?? DEFAULT_FAILURE_BACKOFF_STEPS,
    failureBackoffGrowthRatio: config.failureBackoffGrowthRatio ?? DEFAULT_FAILURE_BACKOFF_GROWTH_RATIO,
    minOutputTokens: config.minOutputTokens ?? DEFAULT_MIN_OUTPUT_TOKENS,
    summaryWindowRatio: config.summaryWindowRatio ?? DEFAULT_SUMMARY_WINDOW_RATIO,
    outputRetryFactor: config.outputRetryFactor ?? DEFAULT_OUTPUT_RETRY_FACTOR,
    modelPolicies,
    auto: config.auto ?? true,
  })
}

/**
 * Merge the exact provider/model override over the validated default policy.
 * @param config - validated service defaults and override table.
 * @param target - exact durable provider/model route to match.
 * @returns detached immutable policy before model-capacity scaling.
 */
export function resolveTargetPolicy(
  config: ResolvedConfig,
  target: Pick<LlmCallConfig, 'provider' | 'model'>,
): ResolvedTargetPolicy {
  const override = config.modelPolicies.find(policy => (
    policy.provider === target.provider && policy.model === target.model
  ))
  const inheritedRetention: ResolvedRetention = config.retainTokens === undefined
    ? { retainRatio: config.retainRatio }
    : { retainTokens: config.retainTokens }
  return deepFreeze({
    target: { provider: target.provider, model: target.model },
    thresholdRatio: override?.thresholdRatio ?? config.thresholdRatio,
    ...resolveRetention(override ?? {}, inheritedRetention),
    summarizationProvider: override?.summarizationProvider ?? config.summarizationProvider,
    summarizationModel: override?.summarizationModel ?? config.summarizationModel,
    maxTokens: override?.maxTokens ?? config.maxTokens,
    compactionRetries: override?.compactionRetries ?? config.compactionRetries,
    maxOverflowRetries: override?.maxOverflowRetries ?? config.maxOverflowRetries,
    reserveMarginRatio: override?.reserveMarginRatio ?? config.reserveMarginRatio,
    outputReserveRatio: override?.outputReserveRatio ?? config.outputReserveRatio,
    failureBackoffSteps: override?.failureBackoffSteps ?? config.failureBackoffSteps,
    failureBackoffGrowthRatio: override?.failureBackoffGrowthRatio ?? config.failureBackoffGrowthRatio,
    minOutputTokens: override?.minOutputTokens ?? config.minOutputTokens,
    summaryWindowRatio: override?.summaryWindowRatio ?? config.summaryWindowRatio,
    outputRetryFactor: override?.outputRetryFactor ?? config.outputRetryFactor,
  })
}

/**
 * Scale one routed policy into concrete token budgets for its model capacity.
 * @param policy - merged policy for the exact routed target.
 * @param contextWindow - positive adapter-owned capacity for that target.
 * @returns detached immutable pressure and retention budgets.
 */
export function resolveCompactSpec(
  policy: ResolvedTargetPolicy,
  contextWindow: number,
): ResolvedCompactSpec {
  const targetKey = `${policy.target.provider}/${policy.target.model}`
  if (!Number.isInteger(contextWindow) || contextWindow <= 0) {
    throw new TargetPressureConfigError(
      targetKey,
      `BasicCompactionConfig: contextWindow (${contextWindow}) must be a positive integer`,
    )
  }
  const thresholdTokens = Math.floor(contextWindow * policy.thresholdRatio)
  const retainTokens = policy.retainTokens === undefined
    ? Math.floor(contextWindow * policy.retainRatio)
    : policy.retainTokens
  if (retainTokens >= thresholdTokens) {
    throw new TargetPressureConfigError(
      targetKey,
      `BasicCompactionConfig: ${policy.target.provider}/${policy.target.model} retainTokens `
      + `(${retainTokens}) must be less than threshold tokens ${thresholdTokens}`,
    )
  }
  return deepFreeze({
    target: { ...policy.target },
    contextWindow,
    thresholdRatio: policy.thresholdRatio,
    thresholdTokens,
    retainTokens,
    summarizationProvider: policy.summarizationProvider,
    summarizationModel: policy.summarizationModel,
    maxTokens: policy.maxTokens,
    compactionRetries: policy.compactionRetries,
    maxOverflowRetries: policy.maxOverflowRetries,
    reserveMarginRatio: policy.reserveMarginRatio,
    outputReserveRatio: policy.outputReserveRatio,
    failureBackoffSteps: policy.failureBackoffSteps,
    failureBackoffGrowthRatio: policy.failureBackoffGrowthRatio,
    minOutputTokens: policy.minOutputTokens,
    summaryWindowRatio: policy.summaryWindowRatio,
    outputRetryFactor: policy.outputRetryFactor,
    marginTokens: Math.floor(contextWindow * policy.reserveMarginRatio),
    outputReserveTokens: Math.floor(contextWindow * policy.outputReserveRatio),
    failureBackoffGrowthTokens: Math.floor(contextWindow * policy.failureBackoffGrowthRatio),
    summaryCapTokens: Math.max(1, Math.min(policy.maxTokens, Math.floor(contextWindow * policy.summaryWindowRatio))),
    summaryCeilingTokens: Math.max(1, Math.floor(contextWindow * policy.summaryWindowRatio)),
  })
}

/**
 * The pressure threshold that also keeps room for the reply and the margin:
 * the ratio threshold, or the window minus the reserved reply minus the
 * margin when that is lower. The reserved reply is the lower of the output
 * cap and `outputReserveTokens`, so a cap sized near the window does not
 * condense a mostly empty surface; the request-time clamp asks for the room
 * left when the whole cap does not fit. Never below one token.
 * @param spec - the routed model's scaled budgets.
 * @param outputCap - output cap the next request will ask for; `0` when unknown.
 * @returns the estimated-token count at or above which the surface must condense.
 */
export function fitThresholdTokens(spec: ResolvedCompactSpec, outputCap: number): number {
  const reserved = Math.min(outputCap, spec.outputReserveTokens)
  return Math.max(1, Math.min(spec.thresholdTokens, spec.contextWindow - reserved - spec.marginTokens))
}

/** Choose an explicit retention form or inherit the already-resolved fallback. */
function resolveRetention(
  config: CompactionPolicyConfig,
  fallback: ResolvedRetention,
): ResolvedRetention {
  if (config.retainTokens !== undefined) return { retainTokens: config.retainTokens }
  if (config.retainRatio !== undefined) return { retainRatio: config.retainRatio }
  return fallback
}

/** Reject a capacity-independent retention conflict at plugin load. */
function validateRatioRetention(
  thresholdRatio: number,
  retention: ResolvedRetention,
  name: string,
): void {
  if (retention.retainRatio !== undefined && retention.retainRatio >= thresholdRatio) {
    throw new Error(
      `${name}: retainRatio (${retention.retainRatio}) must be less than `
      + `the resolved thresholdRatio (${thresholdRatio})`,
    )
  }
}

/** Validate, detach, and reject duplicate exact-target policies. */
function resolveModelPolicies(configured: unknown): ModelCompactPolicyConfig[] {
  if (configured === undefined) return []
  if (!Array.isArray(configured)) {
    throw new Error('BasicCompactionConfig: modelPolicies must be an array')
  }
  const seen = new Set<string>()
  return configured.map((source: unknown, index) => {
    const name = `BasicCompactionConfig: modelPolicies[${index}]`
    assertModelPolicy(source, name)
    const key = `${source.provider}\u0000${source.model}`
    if (seen.has(key)) {
      throw new Error(
        `BasicCompactionConfig: duplicate model policy for ${source.provider}/${source.model}`,
      )
    }
    seen.add(key)
    return { ...source }
  })
}

/** Validate one untrusted exact-target override and narrow its public type. */
function assertModelPolicy(
  source: unknown,
  name: string,
): asserts source is ModelCompactPolicyConfig {
  if (!isUnknownRecord(source)) throw new Error(`${name} must be an object`)
  validateKeys(source, MODEL_POLICY_KEYS, name)
  assertNonEmptyString(`${name}.provider`, source.provider)
  assertNonEmptyString(`${name}.model`, source.model)
  validatePolicy(source, name)
}

/** Validate the fields common to defaults and exact-target partial overrides. */
function validatePolicy(
  config: CompactionPolicyConfig | Record<string, unknown>,
  name: string,
): void {
  const thresholdRatio = config.thresholdRatio
  const retainRatio = config.retainRatio
  const retainTokens = config.retainTokens
  const maxTokens = config.maxTokens
  const compactionRetries = config.compactionRetries
  const maxOverflowRetries = config.maxOverflowRetries
  if (thresholdRatio !== undefined) assertRatio(`${name}.thresholdRatio`, thresholdRatio)
  if (retainRatio !== undefined) assertRatio(`${name}.retainRatio`, retainRatio)
  if (retainTokens !== undefined) assertNonNegativeInteger(`${name}.retainTokens`, retainTokens)
  if (retainRatio !== undefined && retainTokens !== undefined) {
    throw new Error(`${name}: retainRatio and retainTokens are mutually exclusive`)
  }
  if (maxTokens !== undefined) assertPositiveInteger(`${name}.maxTokens`, maxTokens)
  if (compactionRetries !== undefined) {
    assertNonNegativeInteger(`${name}.compactionRetries`, compactionRetries)
  }
  if (maxOverflowRetries !== undefined) {
    assertNonNegativeInteger(`${name}.maxOverflowRetries`, maxOverflowRetries)
  }
  if (config.reserveMarginRatio !== undefined) assertFraction(`${name}.reserveMarginRatio`, config.reserveMarginRatio)
  if (config.outputReserveRatio !== undefined) assertFraction(`${name}.outputReserveRatio`, config.outputReserveRatio)
  if (config.failureBackoffSteps !== undefined) assertNonNegativeInteger(`${name}.failureBackoffSteps`, config.failureBackoffSteps)
  if (config.failureBackoffGrowthRatio !== undefined) assertFraction(`${name}.failureBackoffGrowthRatio`, config.failureBackoffGrowthRatio)
  if (config.minOutputTokens !== undefined) assertPositiveInteger(`${name}.minOutputTokens`, config.minOutputTokens)
  if (config.summaryWindowRatio !== undefined) assertRatio(`${name}.summaryWindowRatio`, config.summaryWindowRatio)
  if (config.outputRetryFactor !== undefined) assertFactor(`${name}.outputRetryFactor`, config.outputRetryFactor)

  validateSummarizationPair(config, name)
}

/** Require one scope to omit, clear, or replace the summarization target as a pair. */
function validateSummarizationPair(
  config: CompactionPolicyConfig | Record<string, unknown>,
  name: string,
): void {
  const provider = config.summarizationProvider
  const model = config.summarizationModel
  if (provider !== undefined && typeof provider !== 'string') {
    throw new Error(`${name}.summarizationProvider must be a string`)
  }
  if (model !== undefined && typeof model !== 'string') {
    throw new Error(`${name}.summarizationModel must be a string`)
  }
  if (provider === undefined && model === undefined) return
  if (provider === undefined || model === undefined
    || (provider.length === 0) !== (model.length === 0)) {
    throw new Error(
      `${name}: summarizationProvider and summarizationModel must be set together `
      + 'as an empty or non-empty pair',
    )
  }
}

/** Reject stale or misspelled keys before defaults can hide them. */
function validateKeys(config: object, keys: ReadonlySet<string>, name: string): void {
  for (const key of Object.keys(config)) {
    if (!keys.has(key)) throw new Error(`${name}: unknown key "${key}"`)
  }
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertNonEmptyString(name: string, value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`)
  }
}

function assertPositiveInteger(name: string, value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} (${String(value)}) must be a positive integer`)
  }
}

function assertNonNegativeInteger(name: string, value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`${name} (${String(value)}) must be a non-negative integer`)
  }
}

function assertFactor(name: string, value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
    throw new Error(`${name} (${String(value)}) must be a finite number of at least 1`)
  }
}

function assertFraction(name: string, value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value >= 1) {
    throw new Error(`${name} (${String(value)}) must be a number in [0, 1)`)
  }
}

function assertRatio(name: string, value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1) {
    throw new Error(`${name} (${String(value)}) must be a number in (0, 1]`)
  }
}
