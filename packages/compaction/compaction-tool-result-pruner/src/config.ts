/** Configuration resolution for deterministic tool-result pruning. */

import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import type { ResolvedConfig, ToolResultPruneConfig } from './types.ts'

/**
 * The marker substituted for a removed middle span. It names the amount
 * removed and, for a result no model request has carried, that the model has
 * not seen that span and how to see it.
 * @param removedChars - Unicode code points removed.
 * @param read - whether a model request already carried the original result.
 * @returns the marker text between blank lines.
 */
export function pruneMarker(removedChars: number, read: boolean): string {
  return read
    ? `\n\n[... ${removedChars} characters cut from the middle to save context ...]\n\n`
    : `\n\n[... ${removedChars} characters cut from the middle before you read them; `
      + 'repeat the call with a narrower range to see them ...]\n\n'
}

/** Low-friction defaults for coding-agent tool output. */
export const DEFAULTS: ResolvedConfig = deepFreeze({
  thresholdChars: 8192,
  headChars: 4096,
  tailChars: 1024,
})

const CONFIG_KEYS: ReadonlySet<string> = new Set([
  'thresholdChars',
  'headChars',
  'tailChars',
])

/**
 * Count Unicode code points without splitting surrogate pairs.
 * @param text - text to measure.
 * @returns the Unicode code-point count.
 */
export function codePointLength(text: string): number {
  return hasSurrogates(text) ? Array.from(text).length : text.length
}

/**
 * Whether `text` holds any surrogate code unit, so its UTF-16 length and
 * code-point count differ; text without one is measured and sliced by code
 * unit, which is the same result without materializing every code point.
 * @param text - the text to inspect.
 * @returns `true` when a code point takes two code units somewhere in `text`.
 */
export function hasSurrogates(text: string): boolean {
  // No `u` flag: the class must see code units, where a pair shows as two surrogates.
  return /[\uD800-\uDFFF]/.test(text)
}

/**
 * Resolve and validate pruning budgets.
 * @param config - raw plugin configuration.
 * @returns a detached deeply immutable configuration.
 */
export function resolveConfig(config: ToolResultPruneConfig = {}): ResolvedConfig {
  for (const key of Object.keys(config)) {
    if (!CONFIG_KEYS.has(key)) {
      throw new Error(
        `ToolResultPruneConfig: unknown key "${key}" `
        + '(allowed: thresholdChars, headChars, tailChars)',
      )
    }
  }

  const resolved: ResolvedConfig = {
    thresholdChars: config.thresholdChars ?? DEFAULTS.thresholdChars,
    headChars: config.headChars ?? DEFAULTS.headChars,
    tailChars: config.tailChars ?? DEFAULTS.tailChars,
  }
  assertPositiveInteger('thresholdChars', resolved.thresholdChars)
  assertNonNegativeInteger('headChars', resolved.headChars)
  assertNonNegativeInteger('tailChars', resolved.tailChars)

  // Budget for the longest marker, so a pruned result never exceeds the threshold again.
  const emittedChars = resolved.headChars
    + codePointLength(pruneMarker(Number.MAX_SAFE_INTEGER, false))
    + resolved.tailChars
  if (emittedChars > resolved.thresholdChars) {
    throw new Error(
      `ToolResultPruneConfig: headChars + marker + tailChars (${emittedChars}) `
      + `must be at most thresholdChars (${resolved.thresholdChars})`,
    )
  }
  return deepFreeze(structuredClone(resolved))
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`ToolResultPruneConfig: ${name} (${value}) must be a positive integer`)
  }
}

function assertNonNegativeInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`ToolResultPruneConfig: ${name} (${value}) must be a non-negative integer`)
  }
}
