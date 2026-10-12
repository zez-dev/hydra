import { describe, expect, it } from 'vitest'
import type { MemoryEntry, MemoryStore } from '@deepseek-ai/dsh-memory'
import { workspaceTag } from '@deepseek-ai/dsh-memory'
import { CONSOLIDATE_SYSTEM_PROMPT, parseConsolidation, planGroups, renderConsolidation, renderGroup, runConsolidation } from '@deepseek-ai/dsh-learning'

const entry = (id: string, text: string, extra: Partial<MemoryEntry> = {}): MemoryEntry => ({
  id, text, tags: [], kind: 'fact', status: 'approved',
  createdAt: `2026-09-${String(10 + Number(id.replace(/\D/gu, '') || 0) % 20).padStart(2, '0')}T00:00:00.000Z`,
  updatedAt: '2026-09-30T00:00:00.000Z', recallCount: 0, ...extra,
} as unknown as MemoryEntry)

describe('parseConsolidation', () => {
  const ids = new Set(['a', 'b', 'c'])

  it('reads notes with the ids they replace, from a bare array or one inside text', () => {
    expect(parseConsolidation('[{"text":"Tests run with vitest.","kind":"shortcut","tags":["testing"],"from":["a","b"]}]', ids))
      .toEqual([{ text: 'Tests run with vitest.', kind: 'shortcut', tags: ['testing'], from: ['a', 'b'] }])
    expect(parseConsolidation('Here:\n```json\n[{"text":"x","from":["c"]}]\n```', ids)).toEqual([{ text: 'x', kind: 'fact', tags: [], from: ['c'] }])
  })

  it('drops unknown ids, repeated ids, items that replace nothing, items without text, and non-string tags', () => {
    expect(parseConsolidation(JSON.stringify([
      { text: 'kept', kind: 'odd', tags: ['t', 3], from: ['a', 'a', 'zzz', 7] },
      { text: 'outside the group', from: ['zzz'] },
      { text: 'no from' },
      { text: '  ', from: ['b'] },
      'not an object',
      null,
    ]), ids)).toEqual([{ text: 'kept', kind: 'fact', tags: ['t'], from: ['a'] }])
  })

  it('reads nothing from an answer that is not a JSON array, and skips items whose text is not a string', () => {
    for (const answer of ['', 'no array here', '[not json', '{"text":"x"}', '][', '[{"text": }]']) expect(parseConsolidation(answer, ids)).toEqual([])
    expect(parseConsolidation('[1] {"a": 1}', ids)).toEqual([])
    expect(parseConsolidation('[{"text": 5, "from": ["a"]}]', ids)).toEqual([])
  })
})

describe('planGroups', () => {
  it('groups notes similar to a first note, largest groups first, and leaves unrelated notes out', () => {
    const groups = planGroups([
      entry('n1', 'pnpm test runs vitest in watch mode'),
      entry('n2', 'pnpm test runs vitest once in CI'),
      entry('n3', 'run pnpm test before pushing to main'),
      entry('n4', 'the staging host deploys with docker compose'),
      entry('n5', 'docker compose deploys the staging host nightly'),
      entry('n6', 'the logo is red'),
    ], { threshold: 0.4, maxSize: 20, all: true })
    // n3 is a workflow rule that only shares "pnpm test run" with n1, not the same subject.
    expect(groups.map(group => group.map(item => item.id))).toEqual([['n1', 'n2'], ['n4', 'n5']])
  })

  it('caps a group at the most similar notes and keeps other projects out unless asked', () => {
    const notes = [
      entry('n1', 'cache warms on boot in the api'),
      entry('n2', 'cache warms on boot in the api server', { tags: [workspaceTag('/work/beta')] }),
      entry('n3', 'the api cache warms on every boot'),
      entry('n4', 'api cache warms on boot slowly'),
    ]
    // n3 and n4 both hold every word of n1; with room for one more, the earlier one joins.
    expect(planGroups(notes, { threshold: 0.4, maxSize: 2, workspace: '/work/alpha', all: false }).map(group => group.map(item => item.id)))
      .toEqual([['n1', 'n3']])
    expect(planGroups(notes, { threshold: 0.4, maxSize: 20, workspace: '/work/alpha', all: true })[0]?.map(item => item.id)).toEqual(['n1', 'n2', 'n3', 'n4'])
  })

  it('orders notes stored in the same moment by id, and groups notes without a workspace when the session has none', () => {
    const same = { createdAt: '2026-09-01T00:00:00.000Z' }
    const groups = planGroups([entry('zz', 'cache warms on boot in the api', same), entry('aa', 'the api cache warms after deploys', same)], { threshold: 0.4, maxSize: 20, all: false })
    expect(groups.map(group => group.map(item => item.id))).toEqual([['aa', 'zz']])
  })
})

describe('runConsolidation and its summary', () => {
  const untouched = { setStatus: () => { throw new Error('nothing should be archived') } } as unknown as MemoryStore
  const group = [entry('a1', 'cache warms on boot'), entry('b2', 'cache warms after deploys')]

  it('changes nothing when the answer returns every note unchanged, and records a rejection that is not an Error', async () => {
    const asItWas = async () => JSON.stringify(group.map(item => ({ text: item.text, from: [item.id] })))
    const same = await runConsolidation(untouched, [group], 0, asItWas, undefined, new AbortController().signal)
    expect(same).toMatchObject({ consolidated: 0, replaced: 0, written: 0, kept: 2, failed: [] })
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- a rejection that is not an Error is the case under test
    const refused = await runConsolidation(untouched, [group], 0, () => Promise.reject('plain refusal'), undefined, new AbortController().signal)
    expect(refused.failed).toEqual([{ group: 1, message: 'plain refusal' }])
  })

  it('rethrows a request the run\'s own cancellation stopped', async () => {
    const controller = new AbortController()
    const run = runConsolidation(untouched, [group], 0, () => {
      controller.abort()
      return Promise.reject(new Error('stopped'))
    }, undefined, controller.signal)
    await expect(run).rejects.toThrow('stopped')
  })

  it('lists at most five failed groups', () => {
    const failed = Array.from({ length: 7 }, (_, index) => ({ group: index + 1, message: 'down' }))
    expect(renderConsolidation({ groups: 7, remaining: 0, consolidated: 0, replaced: 0, written: 0, kept: 14, untagged: 0, failed }, true))
      .toContain('Failed 7 group(s): group 1 (down), group 2 (down), group 3 (down), group 4 (down), group 5 (down), ...; their notes are unchanged.')
  })
})

describe('renderGroup and the system prompt', () => {
  it('lists every note with its id, date, kind, and visible tags', () => {
    expect(renderGroup([entry('a1', 'Tests run with vitest.', { tags: ['testing', workspaceTag('/w')], kind: 'shortcut' }), entry('b2', 'Lint with oxlint.')]))
      .toBe('Tidy these notes:\n- [a1] (2026-09-30, shortcut; testing) Tests run with vitest.\n- [b2] (2026-09-30, fact) Lint with oxlint.')
  })

  it('tells the model that the later date wins, nothing may be dropped or added, and an unrelated note comes back as itself', () => {
    expect(CONSOLIDATE_SYSTEM_PROMPT).toContain('the note with the later date is current')
    expect(CONSOLIDATE_SYSTEM_PROMPT).toContain('Every other fact in the input must appear in the output')
    expect(CONSOLIDATE_SYSTEM_PROMPT).toContain('never add a fact')
    expect(CONSOLIDATE_SYSTEM_PROMPT).toContain('returned unchanged, with its own id in "from"')
  })
})
