/** Turn evidence folding, review thresholds, the review text, and durable meta validation. */
import { describe, expect, it } from 'vitest'
import {
  changedFile, collectFindings, createTurnEvidence, mergeRanges, readWindow, recordChange, recordCheck, recordRead,
  renderReview, shellCommand, unreadLines,
} from '../src/findings.ts'

const THRESHOLDS = { minUnreadLines: 20, reviewAfterToolCalls: 6 } as const

describe('read coverage', () => {
  it('merges overlapping and touching ranges in line order', () => {
    expect(mergeRanges([[50, 60], [1, 10], [11, 20], [15, 30], [62, 70]])).toEqual([[1, 30], [50, 60], [62, 70]])
  })

  it('counts unread lines, clipping ranges at the line count', () => {
    expect(unreadLines([[1, 30], [50, 60]], 100)).toBe(59)
    expect(unreadLines([[1, 120]], 100)).toBe(0)
    expect(unreadLines([[120, 130]], 100)).toBe(100)
  })
})

describe('findings', () => {
  it('finds nothing in a short turn that read whole files and changed nothing', () => {
    const evidence = createTurnEvidence()
    recordRead(evidence, 'a.ts', [1, 40], 40)
    evidence.toolCalls = 1
    expect(collectFindings(evidence, THRESHOLDS)).toBeUndefined()
  })

  it('reports a partly read file only when enough lines went unread, against its latest line count', () => {
    const evidence = createTurnEvidence()
    recordRead(evidence, 'small-gap.ts', [1, 81], 100)
    recordRead(evidence, 'big-gap.ts', [1, 10], 100)
    recordRead(evidence, 'big-gap.ts', [21, 40], 120)
    expect(collectFindings(evidence, THRESHOLDS)).toEqual({
      partialReads: [{ path: 'big-gap.ts', read: [[1, 10], [21, 40]], totalLines: 120, unread: 90 }],
      uncheckedChanges: [],
      toolCalls: 0,
    })
  })

  it('does not count a file the turn wrote whole as partly read', () => {
    const evidence = createTurnEvidence()
    recordRead(evidence, 'out.md', [1, 5], 200)
    recordChange(evidence, 'out.md', true)
    recordCheck(evidence)
    expect(collectFindings(evidence, THRESHOLDS)).toBeUndefined()
  })

  it('reports every changed file until a check runs after the last change', () => {
    const evidence = createTurnEvidence()
    recordChange(evidence, 'a.ts', false)
    recordCheck(evidence)
    recordChange(evidence, 'b.ts', false)
    expect(collectFindings(evidence, THRESHOLDS)?.uncheckedChanges).toEqual(['a.ts', 'b.ts'])
    recordCheck(evidence)
    expect(collectFindings(evidence, THRESHOLDS)).toBeUndefined()
  })

  it('reviews a turn with many tool calls even without other findings', () => {
    const evidence = createTurnEvidence()
    evidence.toolCalls = 6
    expect(collectFindings(evidence, THRESHOLDS)).toEqual({ partialReads: [], uncheckedChanges: [], toolCalls: 6 })
  })
})

describe('review request', () => {
  it('names each partly read file with its ranges and each unchecked change, then asks for a claim check and the answer again', () => {
    expect(renderReview({
      partialReads: [{ path: 'src/a.ts', read: [[1, 10], [20, 20]], totalLines: 40, unread: 29 }],
      uncheckedChanges: ['src/b.ts'],
      toolCalls: 3,
    })).toBe([
      'Before you finish, check your work:',
      '- You read only part of these files: src/a.ts (lines 1-10 and 20 of 40). Read the parts your answer depends on, or say which lines it covers.',
      '- You changed src/b.ts and ran no test, build, or lint command after the last change. Run the relevant check and fix any failure, or say why none applies.',
      '- Check every claim in your answer against what you read or ran, and correct anything wrong or unverified.',
      'Then give your complete final answer again.',
    ].join('\n'))
  })

  it('asks only for the claim check when a long turn read and checked everything', () => {
    expect(renderReview({ partialReads: [], uncheckedChanges: [], toolCalls: 9 })).toBe([
      'Before you finish, check your work:',
      '- Check every claim in your answer against what you read or ran, and correct anything wrong or unverified.',
      'Then give your complete final answer again.',
    ].join('\n'))
  })

  it('names at most five files and counts the rest', () => {
    expect(renderReview({ partialReads: [], uncheckedChanges: ['a', 'b', 'c', 'd', 'e', 'f', 'g'], toolCalls: 0 }))
      .toContain('- You changed a, b, c, d, e, and 2 more and ran no test')
  })
})

describe('durable meta', () => {
  it('reads the line window from read meta', () => {
    expect(readWindow({ path: '/w/a.ts', offset: 5, lines: [{ number: 5, text: 'x' }, { number: 9, text: 'y' }], totalLines: 30 }))
      .toEqual({ path: '/w/a.ts', range: [5, 9], totalLines: 30 })
  })

  it.each([
    ['a string', 'text'],
    ['an array', []],
    ['no path', { lines: [{ number: 1, text: '' }], totalLines: 1 }],
    ['no line count', { path: 'a', lines: [{ number: 1, text: '' }] }],
    ['no line array', { path: 'a', lines: 'x', totalLines: 1 }],
    ['no numbered line', { path: 'a', lines: [{ text: '' }, null], totalLines: 1 }],
  ])('ignores read meta with %s', (_case, meta) => {
    expect(readWindow(meta)).toBeUndefined()
  })

  it('tells a whole-file write from an edit', () => {
    expect(changedFile({ operation: 'create', path: 'a.ts', diffs: [] })).toEqual({ path: 'a.ts', whole: true })
    expect(changedFile({ path: 'a.ts', diffs: [] })).toEqual({ path: 'a.ts', whole: false })
    expect(changedFile({ diffs: [] })).toBeUndefined()
    expect(changedFile(null)).toBeUndefined()
  })

  it('reads a shell command only from a string command argument', () => {
    expect(shellCommand({ command: 'pnpm test' })).toBe('pnpm test')
    expect(shellCommand({ command: 1 })).toBeUndefined()
    expect(shellCommand(undefined)).toBeUndefined()
  })
})
