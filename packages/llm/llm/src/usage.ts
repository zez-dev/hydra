/**
 * Folds over provider-reported token usage.
 * @module @deepseek-ai/dsh-llm/usage
 */

import type { TokenUsage } from './types.ts'

/**
 * Billable tokens of one provider usage record.
 *
 * {@link TokenUsage} buckets are disjoint, so billed input is uncached input
 * plus both cache buckets; `reasoningTokens` is a subset of `outputTokens` on
 * the providers that report it and is deliberately left out so a total never
 * counts the same reasoning twice.
 * @param usage - provider-reported usage.
 * @returns the summed billable tokens.
 */
export function usageTokens(usage: TokenUsage): number {
  return usage.inputTokens
    + (usage.cacheReadTokens ?? 0)
    + (usage.cacheWriteTokens ?? 0)
    + usage.outputTokens
}
