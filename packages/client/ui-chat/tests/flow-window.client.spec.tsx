// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { createRef, type ComponentProps, type MutableRefObject } from 'react'
import { ChatNodeList } from '../src/client/chat/ChatNodeList.tsx'
import {
  FLOW_PLACEHOLDER_HEIGHT, FLOW_WINDOW_TAIL, FLOW_WINDOW_THRESHOLD, mountsRow, windowRange, type FlowScrollLedger,
} from '../src/client/chat/flow-window.ts'

/** The DOM insertions and removals React performs; the layout mock patches them to notice a changed column. */
const MUTATORS = ['appendChild', 'insertBefore', 'removeChild', 'replaceChild'] as const
const ORIGINAL_MUTATORS = Object.fromEntries(MUTATORS.map(name => [name, Node.prototype[name]]))

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  for (const name of ['getBoundingClientRect', 'clientHeight', 'offsetHeight'] as const) {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- restoring jsdom's own accessors
    delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name]
  }
  for (const name of MUTATORS) {
    Object.defineProperty(Node.prototype, name, { configurable: true, writable: true, value: ORIGINAL_MUTATORS[name] })
  }
})

describe('windowRange', () => {
  const rows = Array.from({ length: 100 }, (_, index) => [index * 100, index * 100 + 100] as const)

  it('names the rows that intersect the viewport widened by the overscan', () => {
    const window = windowRange(rows, 5_000, 5_400, 100, 5)
    // 400px viewport, 600px overscan each side: rows from 4400 to 6000.
    expect(window).toEqual({ start: 43, end: 61, tailFrom: 95 })
    const mount = { near: new Set(['row-43', 'row-60']), tail: 5 }
    expect(mountsRow(mount, 'row-42', 42, 100)).toBe(false)
    expect(mountsRow(mount, 'row-43', 43, 100)).toBe(true)
    expect(mountsRow(mount, 'row-60', 60, 100)).toBe(true)
    expect(mountsRow(mount, 'row-61', 61, 100)).toBe(false)
    expect(mountsRow(mount, 'row-95', 95, 100)).toBe(true)
    expect(mountsRow(null, 'row-0', 0, 100)).toBe(true)
  })

  it('clamps at both ends and keeps an empty window when the viewport is past every row', () => {
    expect(windowRange(rows, -100, 50, 100, 0)).toEqual({ start: 0, end: 3, tailFrom: 100 })
    expect(windowRange(rows, 20_000, 20_400, 100, 0)).toEqual({ start: 100, end: 100, tailFrom: 100 })
    expect(windowRange([], 0, 400, 0, 5)).toEqual({ start: 0, end: 0, tailFrom: 0 })
  })
})

/**
 * A column inside a scroller laid out the way a browser would: each row's
 * top is the sum of the rows before it (a placeholder's box, a mounted row's
 * height, nothing for a hidden row), less the scroll offset.
 */
function mountList(count: number, rowHeight: number, viewportHeight: number, ledger?: FlowScrollLedger) {
  const listRef = createRef<HTMLDivElement>()
  const state = { order: Array.from({ length: count }, (_, index) => `node-${index}`) }
  const useChatNode = ((key: string) => ({
    key, kind: 'user', id: key, target: 'chat', anchorSeq: 1, visibility: 'visible',
    location: { kind: 'turn', turn: { turn: Number(key.slice(5)) + 1, data: {} } },
    data: {},
  })) as never
  const scroll = { top: 0 }
  const heightOverrides = new Map<string, number>()
  const heightOf = (row: HTMLElement): number => {
    if (row.hidden) return 0
    if (row.dataset['chatPlaceholder'] !== undefined) return Number.parseFloat(row.style.height) || 0
    return heightOverrides.get(row.dataset['chatFlowKey'] ?? '') ?? rowHeight
  }
  /**
   * Row tops by key, from the rows currently in the document: one pass serves
   * every rect read until a row is inserted or removed, or the test changes a
   * height and ticks.
   */
  let laidOut: Map<string, number> | null = null
  const invalidate = (): void => { laidOut = null }
  for (const name of MUTATORS) {
    const original = Node.prototype[name] as (...args: unknown[]) => unknown
    Object.defineProperty(Node.prototype, name, {
      configurable: true, writable: true,
      value(this: Node, ...args: unknown[]) { invalidate(); return original.apply(this, args) },
    })
  }
  const layout = (): Map<string, number> => {
    if (laidOut !== null) return laidOut
    const tops = new Map<string, number>()
    let y = 0
    for (const row of document.querySelectorAll<HTMLElement>('[data-chat-flow-key]')) {
      tops.set(row.dataset['chatFlowKey'] ?? '', y)
      y += heightOf(row)
    }
    laidOut = tops
    return tops
  }
  Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value(this: HTMLElement) {
      const rect = (top: number, height: number, width: number): DOMRect =>
        ({ top, bottom: top + height, left: 0, right: width, width, height, x: 0, y: top, toJSON: () => ({}) })
      const key = this.dataset['chatFlowKey']
      if (key === undefined) return rect(0, viewportHeight, 100)
      if (this.hidden) return rect(0, 0, 0)
      return rect((layout().get(key) ?? 0) - scroll.top, heightOf(this), 100)
    },
  })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return viewportHeight } })
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get(this: HTMLElement) { return heightOf(this) } })
  // Only the props the window and the placeholder read are real; the seat's own hooks answer with no bottom
  // membership, no folding policy, and a fresh row ref, and its other props never reach a renderer here.
  const props = {
    order: state.order,
    listRef,
    ledger,
    useChatNode,
    useChatNodeBottom: () => false,
    useChatNodeProcess: () => undefined,
    usePresentation: () => false,
    useGroupAction: () => ({ current: null }),
    historyIncomplete: false,
    compactTranscript: false,
    useStore: () => undefined,
    actions: {},
    renderSlot: () => <div data-testid="rendered" />,
    t: (key: string) => key,
  } as unknown as ComponentProps<typeof ChatNodeList>
  const view = render(
    <div data-conversation-scroll="">
      <div ref={listRef} data-chat-flow="">
        <ChatNodeList {...props} />
      </div>
    </div>,
  )
  const scroller = view.container.firstElementChild as HTMLElement
  // jsdom never scrolls; the scroller's offset is the one the layout above reads.
  Object.defineProperty(scroller, 'scrollTop', { configurable: true, get: () => scroll.top, set: (top: number) => { scroll.top = top } })
  Object.defineProperty(scroller, 'scrollHeight', {
    configurable: true,
    get: () => Array.from(document.querySelectorAll<HTMLElement>('[data-chat-flow-key]')).reduce((sum, row) => sum + heightOf(row), 0),
  })
  return { view, scroll, heightOverrides, invalidate, props, listRef, scroller }
}

/** Scroll the mocked scroller and run the frame the window scheduled for it. */
function scrollDriver(scroller: HTMLElement, frameOf: () => FrameRequestCallback | null) {
  return async (top: number): Promise<void> => {
    scroller.scrollTop = top
    await act(async () => {
      scroller.dispatchEvent(new Event('scroll'))
      frameOf()?.(0)
    })
  }
}

describe('ChatNodeList windowing', () => {
  it('mounts every row while the conversation is within the threshold', () => {
    const { view } = mountList(FLOW_WINDOW_THRESHOLD, 100, 800)
    expect(view.container.querySelectorAll('[data-chat-placeholder]')).toHaveLength(0)
    expect(view.container.querySelectorAll('[data-testid="rendered"]')).toHaveLength(FLOW_WINDOW_THRESHOLD)
  })

  it('holds rows away from the viewport as placeholders that keep their identity and height, and follows the scroll', async () => {
    let frame: FrameRequestCallback | null = null
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frame = callback; return 1 })
    vi.stubGlobal('cancelAnimationFrame', () => undefined)
    const observed: Element[] = []
    vi.stubGlobal('ResizeObserver', class {
      observe(element: Element) { observed.push(element) }
      disconnect() { observed.length = 0 }
    })
    const count = FLOW_WINDOW_THRESHOLD + 100
    const { view, scroller, heightOverrides, invalidate, props, listRef } = mountList(count, 100, 800)
    const placeholders = () => view.container.querySelectorAll<HTMLElement>('[data-chat-placeholder]')
    const rendered = () => view.container.querySelectorAll('[data-testid="rendered"]').length
    const tick = scrollDriver(scroller, () => frame)
    // Viewport at the top: rows through 2.5 viewports (the row starting at that edge included) and the tail mount.
    expect(rendered()).toBe(21 + FLOW_WINDOW_TAIL)
    expect(placeholders().length).toBe(count - 21 - FLOW_WINDOW_TAIL)
    const first = placeholders()[0]
    expect(first?.dataset['chatFlowKey']).toBe('node-21')
    expect(first?.dataset['chatAnchorKey']).toBe('node-21')
    expect(first?.dataset['chatTurn']).toBe('22')
    // Every row mounted once before the window applied, so each placeholder holds its measured height.
    expect(first?.style.height).toBe('100px')
    expect(FLOW_PLACEHOLDER_HEIGHT).toBeGreaterThan(0)
    expect(observed).toHaveLength(2)
    // Scrolling moves the window; rows that were mounted keep their measured height as placeholders.
    await tick(15_000)
    const after = Array.from(placeholders()).map(row => row.dataset['chatFlowKey'])
    expect(after).toContain('node-0')
    expect(after).not.toContain('node-150')
    expect(placeholders()[0]?.style.height).toBe('100px')
    // A row measured at no height (a folded process row) leaves a hidden placeholder.
    heightOverrides.set('node-250', 0)
    invalidate()
    await tick(25_000)
    await tick(15_000)
    const folded = view.container.querySelector<HTMLElement>('[data-chat-flow-key="node-250"]')
    expect(folded?.dataset['chatPlaceholder']).toBe('')
    expect(folded?.hidden).toBe(true)
    heightOverrides.delete('node-250')
    invalidate()
    // A page prepended above the reader arrives as never-measured placeholders.
    // When the reader nears them they mount at their real height, and the
    // row the reader had at the top of the viewport stays where it was.
    const prepended = Array.from({ length: 10 }, (_, index) => `node-${index - 10}`)
    view.rerender(
      <div data-conversation-scroll="">
        <div ref={listRef} data-chat-flow="">
          <ChatNodeList {...props} order={[...prepended, ...props.order]} />
        </div>
      </div>,
    )
    const arrived = Array.from(placeholders()).filter(row => prepended.includes(row.dataset['chatFlowKey'] ?? ''))
    expect(arrived).toHaveLength(10)
    expect(arrived[0]?.style.height).toBe(`${FLOW_PLACEHOLDER_HEIGHT}px`)
    // Ten placeholders of 96px sit above node-0; scroll so node-0 tops the viewport.
    await tick(960)
    const topRow = view.container.querySelector<HTMLElement>('[data-chat-flow-key="node-0"]')
    expect(topRow?.getBoundingClientRect().top).toBe(0)
    // The prepended rows are now within the overscan and mount at 100px each: 40px more above node-0,
    // and the scroller followed so node-0 still tops the viewport.
    expect(arrived.every(row => row.dataset['chatPlaceholder'] === undefined || !row.isConnected)).toBe(true)
    expect(scroller.scrollTop).toBe(1000)
    view.unmount()
    expect(observed).toHaveLength(0)
  })

  it('records its scroll writes in the view ledger and keeps the floor while the view follows the stream', async () => {
    let frame: FrameRequestCallback | null = null
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frame = callback; return 1 })
    vi.stubGlobal('cancelAnimationFrame', () => undefined)
    vi.stubGlobal('ResizeObserver', class { observe() { /* the test drives the scroll */ } disconnect() { /* nothing observed */ } })
    const atBottom: MutableRefObject<boolean> = { current: false }
    const ledger: FlowScrollLedger = { observedTop: { current: 0 }, atBottom }
    const count = FLOW_WINDOW_THRESHOLD + 100
    const { view, scroller, props, listRef } = mountList(count, 100, 800, ledger)
    const tick = scrollDriver(scroller, () => frame)
    const prepend = (keys: readonly string[]) => {
      view.rerender(
        <div data-conversation-scroll="">
          <div ref={listRef} data-chat-flow="">
            <ChatNodeList {...props} order={[...keys, ...props.order]} />
          </div>
        </div>,
      )
    }
    // Away from the floor: the prepended page mounts under the reader and the correction lands in the ledger.
    await tick(15_000)
    const first = Array.from({ length: 10 }, (_, index) => `node-${index - 10}`)
    prepend(first)
    await tick(960)
    expect(scroller.scrollTop).toBe(1000)
    expect(ledger.observedTop.current).toBe(1000)
    // At the floor: a window change re-pins the floor instead of holding a row, and records that too.
    const floor = scroller.scrollHeight - 800
    await tick(floor)
    atBottom.current = true
    const second = Array.from({ length: 10 }, (_, index) => `node-${index - 20}`)
    prepend([...second, ...first])
    // The page of placeholders grew the column; a window change while at the floor lands on the new floor.
    await tick(scroller.scrollHeight - 800 - 5_000)
    await tick(scroller.scrollHeight - 800)
    expect(scroller.scrollTop).toBe(scroller.scrollHeight)
    expect(ledger.observedTop.current).toBe(scroller.scrollHeight)
  })
})
