// Unit coverage for the three pure pieces: the per-session fold, the
// aggregation into a report, and the text rendering `/usage` prints.
import { describe, expect, it } from 'vitest'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import { SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  USAGE_FOLD_VERSION,
  aggregateUsage,
  foldSessionUsage,
  renderUsageReport,
  reusableCells,
  totalTokens,
  type SessionCells,
  type UsageCell,
  type UsageSessionRecord,
} from '@deepseek-ai/dsh-session-usage'

function assistantEvent(options: {
  seq: number
  time: number
  provider?: string
  model?: string
  usage?: TokenUsage
}): SessionEvent {
  return {
    type: 'assistant/message',
    seq: options.seq,
    time: options.time,
    data: {
      turn: 0,
      step: options.seq,
      message: createAssistantMessage({
        content: [{ type: 'text', text: 'ok' }],
        source: { provider: options.provider ?? 'deepseek', model: options.model ?? 'deepseek-chat' },
      }),
      stream: [],
      ...options.usage === undefined ? {} : { usage: options.usage },
    },
  } as unknown as SessionEvent
}

const usage = (input: number, output: number, extra: Partial<TokenUsage> = {}): TokenUsage =>
  ({ inputTokens: input, outputTokens: output, ...extra })

/** Local noon on a calendar day, so a zone offset cannot move the day key. */
const noon = (year: number, month: number, day: number): number =>
  new Date(year, month - 1, day, 12, 0, 0).getTime()

const cell = (overrides: Partial<UsageCell> & Pick<UsageCell, 'day'>): UsageCell => ({
  provider: 'deepseek',
  model: 'deepseek-chat',
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  messages: 1,
  ...overrides,
})

describe('foldSessionUsage', () => {
  it('buckets by the day each message happened, not by today', () => {
    const cells = foldSessionUsage([
      assistantEvent({ seq: 0, time: noon(2026, 1, 5), usage: usage(10, 2) }),
      assistantEvent({ seq: 1, time: noon(2026, 3, 9), usage: usage(30, 4) }),
      assistantEvent({ seq: 2, time: noon(2026, 1, 5), usage: usage(5, 1) }),
    ], SessionLogOffset(0))
    expect(cells.map(entry => [entry.day, entry.inputTokens, entry.messages])).toEqual([
      ['2026-01-05', 15, 2],
      ['2026-03-09', 30, 1],
    ])
  })

  it('splits one day across provider routes and models', () => {
    const cells = foldSessionUsage([
      assistantEvent({ seq: 0, time: noon(2026, 2, 2), provider: 'deepseek', model: 'deepseek-chat', usage: usage(10, 1) }),
      assistantEvent({ seq: 1, time: noon(2026, 2, 2), provider: 'deepseek', model: 'deepseek-reasoner', usage: usage(20, 2) }),
      assistantEvent({ seq: 2, time: noon(2026, 2, 2), provider: 'zhipu', model: 'glm-4', usage: usage(30, 3) }),
    ], SessionLogOffset(0))
    expect(cells).toHaveLength(3)
    expect(cells.map(entry => `${entry.provider}/${entry.model}`)).toEqual([
      'deepseek/deepseek-chat', 'deepseek/deepseek-reasoner', 'zhipu/glm-4',
    ])
  })

  it('counts every optional bucket the provider reported', () => {
    const [only] = foldSessionUsage([
      assistantEvent({
        seq: 0,
        time: noon(2026, 4, 1),
        usage: usage(10, 5, { cacheReadTokens: 7, cacheWriteTokens: 3, reasoningTokens: 4 }),
      }),
    ], SessionLogOffset(0))
    expect(only).toMatchObject({
      inputTokens: 10, outputTokens: 5, cacheReadTokens: 7, cacheWriteTokens: 3, reasoningTokens: 4, messages: 1,
    })
  })

  it('leaves the fork parent its own spend', () => {
    const events = [
      assistantEvent({ seq: 0, time: noon(2026, 5, 1), usage: usage(1000, 100) }),
      assistantEvent({ seq: 1, time: noon(2026, 5, 1), usage: usage(1000, 100) }),
      assistantEvent({ seq: 2, time: noon(2026, 5, 2), usage: usage(7, 3) }),
    ]
    expect(foldSessionUsage(events, SessionLogOffset(2))).toEqual([
      cell({ day: '2026-05-02', inputTokens: 7, outputTokens: 3 }),
    ])
  })

  it('ignores assistant messages that carried no usage record', () => {
    expect(foldSessionUsage([
      assistantEvent({ seq: 0, time: noon(2026, 6, 1) }),
    ], SessionLogOffset(0))).toEqual([])
  })
})

describe('aggregateUsage', () => {
  const sessions: SessionCells[] = [
    { key: 'a', cells: [
      cell({ day: '2026-02-01', inputTokens: 100, outputTokens: 10 }),
      cell({ day: '2026-02-03', inputTokens: 50, outputTokens: 5, model: 'deepseek-reasoner', reasoningTokens: 4 }),
    ] },
    { key: 'b', cells: [
      cell({ day: '2026-02-01', inputTokens: 7, outputTokens: 1, cacheReadTokens: 2 }),
    ] },
  ]

  it('orders days ascending and omits days with no usage', () => {
    expect(aggregateUsage(sessions).days.map(day => day.day)).toEqual(['2026-02-01', '2026-02-03'])
  })

  it('counts each contributing session once per bucket', () => {
    const report = aggregateUsage(sessions)
    expect(report.overall.sessions).toBe(2)
    expect(report.days[0]?.totals.sessions).toBe(2)
    expect(report.days[1]?.totals.sessions).toBe(1)
  })

  it('orders models by billable tokens, descending', () => {
    const report = aggregateUsage(sessions)
    expect(report.byModel.map(entry => [entry.model, totalTokens(entry.totals)])).toEqual([
      ['deepseek-chat', 120],
      ['deepseek-reasoner', 55],
    ])
  })

  it('leaves reasoning out of the billable total because it is part of output', () => {
    expect(totalTokens(aggregateUsage(sessions).byModel[1]!.totals)).toBe(55)
    expect(aggregateUsage(sessions).byModel[1]?.totals.reasoningTokens).toBe(4)
  })

  it('breaks a tie between equal totals on the route name', () => {
    const tied: SessionCells[] = [{ key: 'a', cells: [
      cell({ day: '2026-02-01', inputTokens: 10, model: 'zeta' }),
      cell({ day: '2026-02-01', inputTokens: 10, model: 'alpha' }),
    ] }]
    expect(aggregateUsage(tied).byModel.map(entry => entry.model)).toEqual(['alpha', 'zeta'])
    const reversed: SessionCells[] = [{ key: 'a', cells: [...tied[0]!.cells].reverse() }]
    expect(aggregateUsage(reversed).byModel.map(entry => entry.model)).toEqual(['alpha', 'zeta'])
  })

  it('treats since and until as inclusive day bounds', () => {
    expect(aggregateUsage(sessions, { since: '2026-02-03' }).days.map(day => day.day)).toEqual(['2026-02-03'])
    expect(aggregateUsage(sessions, { until: '2026-02-01' }).days.map(day => day.day)).toEqual(['2026-02-01'])
    expect(aggregateUsage(sessions, { since: '2026-02-01', until: '2026-02-03' }).days).toHaveLength(2)
    expect(aggregateUsage(sessions, { since: '2026-03-01' }).overall.messages).toBe(0)
  })
})

describe('renderUsageReport', () => {
  it('says so plainly when nothing is recorded', () => {
    expect(renderUsageReport(aggregateUsage([]))).toBe('No token usage recorded in the session history.')
  })

  it('shades each day against the busiest day in the window', () => {
    const text = renderUsageReport(aggregateUsage([{ key: 'a', cells: [
      cell({ day: '2026-09-21', inputTokens: 1000 }),
      cell({ day: '2026-09-22', inputTokens: 750 }),
      cell({ day: '2026-09-23', inputTokens: 500 }),
      cell({ day: '2026-09-24', inputTokens: 250 }),
      cell({ day: '2026-09-25', inputTokens: 1 }),
    ] }]), new Date(2026, 8, 26, 10, 0, 0))
    const glyph = (weekday: number): string =>
      text.split('\n').filter(line => /^ {2}(Sun|Mon|Tue|Wed|Thu|Fri|Sat) {2}/.test(line))[weekday]!.slice(-1)
    // Mon 1000/1000, Tue 750/1000, Wed 500/1000, Thu 250/1000, Fri 1/1000.
    expect([1, 2, 3, 4, 5].map(glyph)).toEqual(['█', '▓', '▒', '░', '░'])
    expect(text).toContain('up to 1,000 tokens/day')
  })

  it('says the window is empty when every counted day predates it', () => {
    const text = renderUsageReport(aggregateUsage([{ key: 'a', cells: [
      cell({ day: '2025-01-02', inputTokens: 40 }),
    ] }]), new Date(2026, 8, 22, 10, 0, 0))
    expect(text).toContain('(no usage in this window)')
    expect(text).toContain('Total          40  tokens')
  })

  it('renders totals, the model table, and a 12-week day grid', () => {
    const report = aggregateUsage([
      { key: 'a', cells: [
        cell({ day: '2026-09-21', inputTokens: 120_000, outputTokens: 8000, cacheReadTokens: 40_000, messages: 90 }),
        cell({ day: '2026-09-15', inputTokens: 30_000, outputTokens: 2000, messages: 24 }),
        cell({ day: '2026-07-06', inputTokens: 4000, outputTokens: 300, model: 'deepseek-reasoner', reasoningTokens: 150, messages: 6 }),
      ] },
      { key: 'b', cells: [
        cell({ day: '2026-09-09', inputTokens: 9000, outputTokens: 700, provider: 'zhipu', model: 'glm-4.6', messages: 11 }),
      ] },
    ])
    const text = renderUsageReport(report, new Date(2026, 8, 22, 10, 0, 0))
    expect(text).toContain('Total          214,000  tokens')
    expect(text).toContain('Messages           131  across 2 sessions')
    expect(text).toContain('deepseek/deepseek-chat')
    expect(text).toContain('Last 12 weeks  2026-07-05 to 2026-09-26')
    // Seven weekday rows, twelve columns each.
    const rows = text.split('\n').filter(line => /^ {2}(Sun|Mon|Tue|Wed|Thu|Fri|Sat) {2}/.test(line))
    expect(rows).toHaveLength(7)
    for (const row of rows) expect(row.slice(7).split(' ')).toHaveLength(12)
    // The window ends on the week of 2026-09-22, so the last Monday column is
    // 2026-09-21 — the busiest day, and the only full block in the grid.
    expect(rows[1]?.endsWith('█')).toBe(true)
    expect(text.split('█')).toHaveLength(3)
  })
})

describe('reusableCells', () => {
  const cells = [cell({ day: '2026-02-01', inputTokens: 3 })]
  const record = (overrides: Partial<UsageSessionRecord> = {}): UsageSessionRecord =>
    ({ witness: 'rev-1', foldVersion: USAGE_FOLD_VERSION, cells, ...overrides })

  it('reuses a row whose witness and fold version both still hold', () => {
    expect(reusableCells(record(), 'rev-1')).toEqual(cells)
  })

  it('misses when nothing is cached for the session', () => {
    expect(reusableCells(undefined, 'rev-1')).toBeUndefined()
  })

  it('misses when no witness is available to compare against', () => {
    expect(reusableCells(record(), undefined)).toBeUndefined()
  })

  it('misses when the log moved on', () => {
    expect(reusableCells(record(), 'rev-2')).toBeUndefined()
  })

  it('misses when an older fold produced the row', () => {
    expect(reusableCells(record({ foldVersion: USAGE_FOLD_VERSION - 1 }), 'rev-1')).toBeUndefined()
  })
})
