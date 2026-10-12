import { describe, expect, it } from 'vitest'
import { lowestReasoningEffort, ReasoningEffortId } from '@deepseek-ai/dsh-llm'

const efforts = (...ids: string[]) => ({ reasoning: { efforts: ids.map(id => ({ id: ReasoningEffortId(id), name: id })) } })

describe('lowestReasoningEffort', () => {
  it('prefers off, then none, minimal, and low, in that order', () => {
    expect(lowestReasoningEffort(efforts('high', 'low', 'off'))).toBe('off')
    expect(lowestReasoningEffort(efforts('high', 'none', 'minimal'))).toBe('none')
    expect(lowestReasoningEffort(efforts('medium', 'minimal', 'low'))).toBe('minimal')
    expect(lowestReasoningEffort(efforts('high', 'low'))).toBe('low')
  })

  it('answers nothing for a route without a low effort or without reasoning levels', () => {
    expect(lowestReasoningEffort(efforts('medium', 'high'))).toBeUndefined()
    expect(lowestReasoningEffort({})).toBeUndefined()
  })
})
