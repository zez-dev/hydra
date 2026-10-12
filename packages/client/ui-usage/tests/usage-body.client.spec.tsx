// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UsageReportValue, UsageTotalsValue } from '@deepseek-ai/dsh-api-remotes/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { UsageBody } from '../src/client/UsageBody.tsx'
import type { UsageBodyProps, UsageInjected } from '../src/client/UsageBody.tsx'
import { UsageTitle } from '../src/client/UsageTitle.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

function totals(overrides: Partial<UsageTotalsValue> = {}): UsageTotalsValue {
  return {
    inputTokens: 3500, outputTokens: 350, cacheReadTokens: 400, cacheWriteTokens: 30, reasoningTokens: 120,
    totalTokens: 4280, messages: 3, sessions: 2, ...overrides,
  }
}

/** Two days inside the window the dashboard draws around "today". */
function recentDays(today: Date): UsageReportValue['days'] {
  const key = (offset: number): string => {
    const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset)
    const pad = (value: number): string => value.toString().padStart(2, '0')
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  }
  return [
    { day: key(-3), totals: totals({ totalTokens: 1530, messages: 1, sessions: 1 }) },
    { day: key(-1), totals: totals({ totalTokens: 2750, messages: 2, sessions: 2 }) },
  ]
}

function report(today: Date, overrides: Partial<UsageReportValue> = {}): UsageReportValue {
  return {
    overall: totals(),
    days: recentDays(today),
    byModel: [
      { provider: 'deepseek', model: 'deepseek-chat', totals: totals({ totalTokens: 3730, inputTokens: 3000, outputTokens: 300, messages: 2 }) },
      { provider: 'zhipu', model: 'glm-4.6', totals: totals({ totalTokens: 550, inputTokens: 500, outputTokens: 50, messages: 1 }) },
    ],
    ...overrides,
  }
}

function mount(overrides: Partial<UsageInjected> = {}) {
  const today = new Date()
  const injected: UsageInjected = {
    report: vi.fn<UsageInjected['report']>(async () => report(today)),
    ...overrides,
  }
  const controller = new AbortController()
  const props = {
    useTabInfo: () => ({
      sidebar: { expanded: true, fullscreen: false },
      panel: { id: 'pane-1' },
      tab: {
        id: 'tab-1', kind: 'usage', contentId: 'usage', title: en['type.label'], visible: true,
        navigation: { address: 'usage', params: undefined, revision: 1 },
        signal: controller.signal,
        actions: { openResource: vi.fn(), openTab: vi.fn(), close: vi.fn() },
      },
    }),
    ...injected,
    t: makeTranslate(en),
  } as unknown as UsageBodyProps
  const view = render(<UsageBody {...props} />)
  return { view, injected, today }
}

describe('UsageBody', () => {
  it('asks for one unbounded report and shows the headline total with its breakdown', async () => {
    const { injected } = mount()
    await waitFor(() => { expect(screen.getByText('4,280')).toBeTruthy() })
    expect(injected.report).toHaveBeenCalledWith({})
    expect(screen.getByText(en['totals.total'])).toBeTruthy()
    const bucket = (name: string): HTMLElement => {
      const row = document.querySelector(`[data-usage-bucket="${name}"]`)
      if (row === null) throw new Error(`missing breakdown row ${name}`)
      return row as HTMLElement
    }
    expect(bucket('inputTokens').textContent).toContain('3,500')
    expect(bucket('outputTokens').textContent).toContain('350')
    expect(bucket('cacheReadTokens').textContent).toContain('400')
    expect(bucket('cacheWriteTokens').textContent).toContain('30')
    expect(bucket('reasoningTokens').textContent).toContain('120')
  })

  it('labels reasoning as a part of output rather than a bucket of its own', async () => {
    mount()
    await waitFor(() => { expect(screen.getByText('4,280')).toBeTruthy() })
    const reasoning = document.querySelector('[data-usage-bucket="reasoningTokens"]') as HTMLElement
    expect(reasoning.dataset['nested']).toBe('true')
    expect(reasoning.textContent).toContain(en['totals.reasoningNote'])
    // The headline is the Host's sum, not the five buckets added together.
    expect(3500 + 350 + 400 + 30).toBe(4280)
  })

  it('counts messages and sessions', async () => {
    mount()
    await waitFor(() => { expect(document.querySelector('[data-usage-count="messages"]')).not.toBeNull() })
    expect(document.querySelector('[data-usage-count="messages"]')?.textContent).toBe(`3${en['totals.messages']}`)
    expect(document.querySelector('[data-usage-count="sessions"]')?.textContent).toBe(`2${en['totals.sessions']}`)
  })

  it('draws a year of squares, one column per week, and names the date and count on hover', async () => {
    const { today } = mount()
    await waitFor(() => { expect(document.querySelector('[data-usage-section="heatmap"]')).not.toBeNull() })
    const squares = document.querySelectorAll('[data-day]')
    expect(squares).toHaveLength(365)
    expect(document.querySelectorAll('[data-week]')).toHaveLength(53)
    const busiest = document.querySelector('[data-level="4"][data-day]') as HTMLElement
    expect(busiest.dataset['tokens']).toBe('2750')
    expect(busiest.getAttribute('title')).toBe(
      en['heatmap.cell'].replace('{date}', busiest.dataset['day'] as string).replace('{tokens}', '2,750'),
    )
    const idle = [...squares].find(square => (square as HTMLElement).dataset['tokens'] === '0') as HTMLElement
    expect(idle.getAttribute('title')).toBe(en['heatmap.cellEmpty'].replace('{date}', idle.dataset['day'] as string))
    expect(today).toBeInstanceOf(Date)
  })

  it('lists every provider route in the order the Host ranked them', async () => {
    mount()
    await waitFor(() => { expect(document.querySelector('[data-usage-section="models"]')).not.toBeNull() })
    const routes = [...document.querySelectorAll('[data-usage-route]')].map(row => (row as HTMLElement).dataset['usageRoute'])
    expect(routes).toEqual(['deepseek/deepseek-chat', 'zhipu/glm-4.6'])
    expect(screen.getByText('3,730')).toBeTruthy()
    expect(screen.getByText(en['models.provider'])).toBeTruthy()
  })

  it('keeps the figures on screen while a refresh is in flight', async () => {
    const today = new Date()
    const pending = Promise.withResolvers<UsageReportValue>()
    const second = report(today, { overall: totals({ totalTokens: 9999 }) })
    const reread = vi.fn<UsageInjected['report']>()
      .mockResolvedValueOnce(report(today))
      .mockReturnValueOnce(pending.promise)
    mount({ report: reread })
    await waitFor(() => { expect(screen.getByText('4,280')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: en.refresh }))
    // The old figures stay put and the button says so, rather than the whole
    // dashboard dropping back to the loading view.
    await waitFor(() => { expect(screen.getByRole('button', { name: en.refreshing })).toBeTruthy() })
    expect(screen.getByText('4,280')).toBeTruthy()
    expect(screen.queryByText(en.loading)).toBeNull()
    pending.resolve(second)
    await waitFor(() => { expect(screen.getByText('9,999')).toBeTruthy() })
    expect(reread).toHaveBeenCalledTimes(2)
  })

  it('keeps the figures and names the failure when a refresh fails', async () => {
    const today = new Date()
    const reread = vi.fn<UsageInjected['report']>()
      .mockResolvedValueOnce(report(today))
      .mockRejectedValueOnce('storage offline')
    mount({ report: reread })
    await waitFor(() => { expect(screen.getByText('4,280')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: en.refresh }))
    await waitFor(() => { expect(screen.getByRole('status').textContent).toBe('storage offline') })
    expect(screen.getByText('4,280')).toBeTruthy()
    expect(screen.queryByText(en.error)).toBeNull()
  })

  it('says plainly when nothing has been recorded', async () => {
    const today = new Date()
    mount({ report: vi.fn<UsageInjected['report']>(async () => report(today, { overall: totals({ totalTokens: 0, messages: 0, sessions: 0 }), days: [], byModel: [] })) })
    await waitFor(() => { expect(screen.getByText(en.empty)).toBeTruthy() })
    expect(document.querySelector('[data-usage-section="heatmap"]')).toBeNull()
  })

  it('shows the failure and retries when the report fails', async () => {
    const today = new Date()
    const fail = vi.fn<UsageInjected['report']>()
      .mockRejectedValueOnce(new Error('usage.report failed: internal: since must be a local calendar day'))
      .mockResolvedValue(report(today))
    mount({ report: fail })
    await waitFor(() => { expect(screen.getByText(en.error)).toBeTruthy() })
    expect(screen.getByRole('status').textContent).toContain('since must be a local calendar day')
    fireEvent.click(screen.getByRole('button', { name: en.retry }))
    await waitFor(() => { expect(screen.getByText('4,280')).toBeTruthy() })
  })
})

describe('UsageTitle', () => {
  it('draws an icon before the tab title', () => {
    const view = render(<UsageTitle {...({ useTabInfo: () => ({ tab: { title: 'Usage' } }) } as unknown as Parameters<typeof UsageTitle>[0])} />)
    expect(view.container.querySelector('svg')).not.toBeNull()
    expect(view.container.textContent).toContain('Usage')
  })
})
