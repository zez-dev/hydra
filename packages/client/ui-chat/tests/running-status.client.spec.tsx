// @vitest-environment jsdom

import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HYDRA_LOGO_VIEWBOX } from '@deepseek-ai/dsh-client-ui-primitives'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { RunningStatus } from '../src/client/chat/RunningStatus.tsx'
import { zh } from '../src/client/locale.ts'

const t = makeTranslate(zh, commonZh)

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(5_000) })
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

function statusHarness(startTime?: number) {
  const view = render(<RunningStatus startTime={startTime} paused={false} t={t} />)
  return {
    ...view,
    content: () => view.container.querySelector('[data-chat-running] > :last-child'),
    set: (nextStartTime?: number, paused = false) => {
      view.rerender(<RunningStatus startTime={nextStartTime} paused={paused} t={t} />)
    },
  }
}

describe('RunningStatus', () => {
  it('leads the label with the decorative Hydra dragon mark, its pupils exposed to the eye-glow animation', () => {
    const view = statusHarness()
    const mark = view.content()?.firstElementChild
    expect(mark?.tagName).toBe('svg')
    expect(mark?.getAttribute('aria-hidden')).toBe('true')
    expect(mark?.getAttribute('viewBox')).toBe(`0 0 ${HYDRA_LOGO_VIEWBOX} ${HYDRA_LOGO_VIEWBOX}`)
    expect(mark?.querySelectorAll('[data-part="pupil"]')).toHaveLength(2)
    expect(view.container.querySelector('animate')).toBeNull()
    expect(view.getByRole('status').textContent).toBe('巨龙思考中…')
  })

  it('waits for an open Turn start before allocating its clock', () => {
    const view = statusHarness()
    expect(view.content()?.textContent).toBe('巨龙思考中…')
    expect(vi.getTimerCount()).toBe(0)
    view.set(1_000)
    expect(view.content()?.textContent).toMatch(/^巨龙思考中，用时 \d+秒 ···$/)
    expect(view.content()?.querySelectorAll('[data-shimmer="true"]')).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(1)
    view.set()
    expect(view.content()?.textContent).toBe('巨龙思考中…')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps the indicator mounted while a continuous run moves to the next Turn', () => {
    const view = statusHarness(1_000)
    const content = view.content()
    const status = view.getByRole('status')
    const initialText = content?.textContent
    act(() => { vi.advanceTimersByTime(2_000) })
    expect(content?.textContent).toMatch(/^巨龙思考中，用时 \d+秒 ···$/)
    expect(content?.textContent).not.toBe(initialText)
    view.set(7_000)
    expect(view.content()).toBe(content)
    expect(content?.textContent).toMatch(/^巨龙思考中，用时 \d+秒 ···$/)
    expect(vi.getTimerCount()).toBe(1)
    const nextTurnText = content?.textContent
    act(() => { vi.advanceTimersByTime(2_000) })
    expect(content?.textContent).toMatch(/^巨龙思考中，用时 \d+秒 ···$/)
    expect(content?.textContent).not.toBe(nextTurnText)
    expect(view.getByRole('status')).toBe(status)
    expect(status.textContent).toBe('巨龙思考中…')
    view.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps the duration nonnegative when the start is ahead of the local clock', () => {
    const view = statusHarness(6_000)
    expect(view.content()?.textContent).toMatch(/^巨龙思考中，用时 \d+秒 ···$/)
    expect(view.content()?.textContent).not.toContain('-')
    act(() => { vi.advanceTimersByTime(3_000) })
    expect(view.content()?.textContent).toMatch(/^巨龙思考中，用时 \d+秒 ···$/)
    expect(view.content()?.textContent).not.toContain('-')
  })

  it('freezes the duration while paused and resumes from the Turn start', () => {
    const view = statusHarness(1_000)
    expect(view.content()?.textContent).toBe('巨龙思考中，用时 4秒 ···')
    view.set(1_000, true)
    expect(vi.getTimerCount()).toBe(0)
    act(() => { vi.advanceTimersByTime(5_000) })
    expect(view.content()?.textContent).toBe('巨龙思考中，用时 4秒 ···')
    view.set(1_000)
    expect(view.content()?.textContent).toBe('巨龙思考中，用时 9秒 ···')
    expect(vi.getTimerCount()).toBe(1)
  })
})
