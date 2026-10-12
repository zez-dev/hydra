import { describe, expect, it } from 'vitest'
import { mirrorBreakthroughs, relatedBreakthroughs, researchTag, BREAKTHROUGH_TAG } from '../src/bridge.ts'
import type { BridgeMemory, BridgeMemoryEntry } from '../src/bridge.ts'
import { renderJournalRecall } from '../src/recall.ts'
import type { Journal } from '../src/types.ts'

function journal(slug: string, breakthroughs: readonly string[]): Journal {
  const at = '2026-09-21T00:00:00.000Z'
  return {
    slug, objective: `objective ${slug}`, criteria: [], status: 'active', createdAt: at, updatedAt: at, sessions: [],
    breakthroughs: breakthroughs.map((text, index) => ({ id: `b-${index}`, at, source: 'model', text })),
    hypotheses: [], experiments: [], deadEnds: [], nextSteps: [],
  }
}

class FakeMemory implements BridgeMemory {
  readonly entries: BridgeMemoryEntry[] = []
  private counter = 0
  list(): BridgeMemoryEntry[] { return [...this.entries] }
  async add(input: { text: string; kind: 'fact'; tags: readonly string[] }, status: 'approved'): Promise<BridgeMemoryEntry> {
    this.counter += 1
    const updatedAt = new Date(2026, 8, 21, 0, 0, this.counter).toISOString()
    const entry: BridgeMemoryEntry = { text: input.text, tags: [...input.tags], status, updatedAt }
    this.entries.push(entry)
    return entry
  }
}

describe('mirrorBreakthroughs', () => {
  it('files each breakthrough once as an approved fact tagged with the slug', async () => {
    const memory = new FakeMemory()
    expect(await mirrorBreakthroughs(memory, journal('alpha', ['Cooling to 4K doubles the signal.']))).toBe(1)
    expect(memory.entries).toHaveLength(1)
    expect(memory.entries[0]).toMatchObject({ status: 'approved', tags: [researchTag('alpha'), BREAKTHROUGH_TAG] })
    expect(await mirrorBreakthroughs(memory, journal('alpha', ['Cooling to 4K doubles the signal.', 'cooling to 4k DOUBLES the signal!']))).toBe(0)
    expect(memory.entries).toHaveLength(1)
  })
})

describe('relatedBreakthroughs', () => {
  it('lists approved breakthroughs of other journals, newest first, never the current slug or unapproved rows', async () => {
    const memory = new FakeMemory()
    await mirrorBreakthroughs(memory, journal('alpha', ['A first.', 'A second.']))
    await mirrorBreakthroughs(memory, journal('beta', ['B only.']))
    memory.entries.push({ text: 'stale one', tags: [researchTag('gamma'), BREAKTHROUGH_TAG], status: 'stale', updatedAt: '2030-01-01T00:00:00.000Z' })
    expect(relatedBreakthroughs(memory, 'beta', 5)).toEqual(['[alpha] A second.', '[alpha] A first.'])
    expect(relatedBreakthroughs(memory, 'alpha', 1)).toEqual(['[beta] B only.'])
    expect(relatedBreakthroughs(undefined, 'alpha', 5)).toEqual([])
  })
})

describe('renderJournalRecall with related breakthroughs', () => {
  it('adds the related section only when there is something to relate', () => {
    const base = { maxRecallBytes: 8000, recentExperiments: 3 }
    const plain = renderJournalRecall(journal('alpha', ['A first.']), base)
    expect(plain).not.toContain('Related breakthroughs')
    const related = renderJournalRecall(journal('alpha', ['A first.']), { ...base, related: ['[beta] B only.'] })
    expect(related).toContain('Related breakthroughs from other research:\n- [beta] B only.')
    expect(related.indexOf('Related breakthroughs')).toBeGreaterThan(related.indexOf('Breakthroughs:'))
  })
})
