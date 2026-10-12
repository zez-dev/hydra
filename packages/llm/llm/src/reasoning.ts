/**
 * Pick the reasoning effort that spends the least of an output cap on
 * thinking, for auxiliary requests whose small cap must go to the answer.
 * @module @deepseek-ai/dsh-llm/reasoning
 */
import type { ReasoningEffortId } from './brand.ts'
import type { LlmResolvedModelInfo } from './types.ts'

/** Efforts that spend the least of an output cap on thinking, most preferred first. */
export const LOWEST_REASONING_EFFORTS: readonly string[] = Object.freeze(['off', 'none', 'minimal', 'low'])

/**
 * The route's lowest selectable reasoning effort among {@link LOWEST_REASONING_EFFORTS}.
 * @param info - the route's resolved model metadata.
 * @returns the effort id, or `undefined` when the route offers none of them.
 */
export function lowestReasoningEffort(info: Pick<LlmResolvedModelInfo, 'reasoning'>): ReasoningEffortId | undefined {
  const efforts = info.reasoning?.efforts ?? []
  for (const wanted of LOWEST_REASONING_EFFORTS) {
    const match = efforts.find(effort => effort.id === wanted)
    if (match !== undefined) return match.id
  }
  return undefined
}
