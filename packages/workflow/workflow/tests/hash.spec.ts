import { describe, expect, it } from 'vitest'
import { callKeyHash, scriptHash } from '@deepseek-ai/dsh-workflow'

describe('callKeyHash', () => {
  it('is stable across calls for the same inputs', () => {
    const request = { prompt: 'review src/index.ts', provider: 'zhipu', model: 'glm-4.5' }
    expect(callKeyHash(request)).toBe(callKeyHash({ ...request }))
  })

  it('ignores key order, so an option object built differently still matches', () => {
    expect(callKeyHash({ prompt: 'a', provider: 'p', model: 'm' }))
      .toBe(callKeyHash({ model: 'm', provider: 'p', prompt: 'a' }))
  })

  it('changes when the prompt is edited', () => {
    expect(callKeyHash({ prompt: 'review src/index.ts' }))
      .not.toBe(callKeyHash({ prompt: 'review src/index.ts twice' }))
  })

  it('changes when a route option changes, because the child would answer differently', () => {
    const base = { prompt: 'a' }
    expect(callKeyHash(base)).not.toBe(callKeyHash({ ...base, model: 'glm-4.5' }))
    expect(callKeyHash({ ...base, model: 'glm-4.5' })).not.toBe(callKeyHash({ ...base, model: 'glm-4.6' }))
    expect(callKeyHash({ ...base, provider: 'a' })).not.toBe(callKeyHash({ ...base, provider: 'b' }))
  })

  it('changes when the structured-output schema changes', () => {
    const schema = { type: 'object' as const, properties: { a: { type: 'string' as const } } }
    const other = { type: 'object' as const, properties: { b: { type: 'string' as const } } }
    expect(callKeyHash({ prompt: 'a', schema })).not.toBe(callKeyHash({ prompt: 'a', schema: other }))
    expect(callKeyHash({ prompt: 'a', schema })).not.toBe(callKeyHash({ prompt: 'a' }))
  })

  it('treats an absent option and an undefined one as the same call', () => {
    expect(callKeyHash({ prompt: 'a' })).toBe(callKeyHash({ prompt: 'a', provider: undefined, model: undefined }))
  })

  it('is a short lowercase hex digest', () => {
    expect(callKeyHash({ prompt: 'a' })).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe('scriptHash', () => {
  it('is stable for identical bodies and differs for an edit', () => {
    expect(scriptHash('return 1')).toBe(scriptHash('return 1'))
    expect(scriptHash('return 1')).not.toBe(scriptHash('return 2'))
  })

  it('does not collapse whitespace, because a reformatted script is a different script', () => {
    expect(scriptHash('return 1')).not.toBe(scriptHash('return  1'))
  })
})
