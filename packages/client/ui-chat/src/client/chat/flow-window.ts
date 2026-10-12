/**
 * The mounted window of a long settled flow: once a conversation holds more
 * nodes than a reader can have on screen, only the rows near the viewport
 * (and the live tail) mount their renderers, and every other row keeps its
 * box as a placeholder of its last measured height. The column's element
 * count and layout work then follow the viewport, not the pages loaded.
 * @module dsh-client-ui-chat/chat/flow-window
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MutableRefObject, type RefObject } from 'react'

/** Nodes a conversation must hold before rows outside the viewport stop mounting. */
export const FLOW_WINDOW_THRESHOLD = 200
/** Newest rows that always mount, so the live tail streams and anchors as before. */
export const FLOW_WINDOW_TAIL = 24
/** Height a row keeps before it has ever been measured, in CSS pixels. */
export const FLOW_PLACEHOLDER_HEIGHT = 96
/** Viewports of rows mounted above and below the visible ones. */
const OVERSCAN_VIEWPORTS = 1.5

/** The mounted index range, `end` exclusive; rows at or past `tailFrom` mount regardless. */
export interface FlowWindow {
  readonly start: number
  readonly end: number
  readonly tailFrom: number
}

/**
 * The window as the list renders it: the keys of the rows near the viewport,
 * so a page prepended before them does not move the window onto other rows
 * until the next measurement, plus the tail that always mounts.
 */
export interface FlowMount {
  readonly near: ReadonlySet<string>
  readonly tail: number
}

/**
 * The view's scroll ledger, shared by reference: every scroll the window
 * writes is recorded in `observedTop` so the view does not take it for a
 * reader scroll, and while `atBottom` holds, the window keeps the floor
 * instead of the anchor row, since the view follows the stream there.
 */
export interface FlowScrollLedger {
  readonly observedTop: MutableRefObject<number>
  readonly atBottom: RefObject<boolean>
}

/**
 * The scroll container a flow column lives in.
 * @param from - the flow column element.
 * @returns the nearest `[data-conversation-scroll]` ancestor, or `from` itself when none exists.
 */
export function scrollerOf(from: HTMLElement): HTMLElement {
  return (from.closest('[data-conversation-scroll]')) ?? from
}

/**
 * The rows that intersect the viewport widened by the overscan, given each
 * row's top and bottom in the scroller's coordinates.
 * @param rows - `[top, bottom]` per row, in order.
 * @param viewTop - the visible top in the same coordinates.
 * @param viewBottom - the visible bottom in the same coordinates.
 * @param total - the number of rows.
 * @param tail - rows at the end that always mount.
 * @returns the window; `start` and `end` bound the rows near the viewport.
 */
export function windowRange(
  rows: readonly (readonly [number, number])[],
  viewTop: number,
  viewBottom: number,
  total: number,
  tail: number,
): FlowWindow {
  const overscan = Math.max(0, viewBottom - viewTop) * OVERSCAN_VIEWPORTS
  const low = viewTop - overscan
  const high = viewBottom + overscan
  let start = 0
  let end = rows.length
  {
    let a = 0
    let b = rows.length
    while (a < b) {
      const middle = (a + b) >>> 1
      if ((rows[middle] as readonly [number, number])[1] >= low) b = middle
      else a = middle + 1
    }
    start = a
  }
  {
    let a = start
    let b = rows.length
    while (a < b) {
      const middle = (a + b) >>> 1
      if ((rows[middle] as readonly [number, number])[0] > high) b = middle
      else a = middle + 1
    }
    end = a
  }
  return { start, end, tailFrom: Math.max(0, total - tail) }
}

/**
 * Whether the row `key` at `index` of `total` mounts its renderer.
 * @param mount - the window, or `null` when every row mounts.
 * @param key - the row's node key.
 * @param index - the row's position.
 * @param total - the number of rows.
 * @returns `true` when the row renders its node.
 */
export function mountsRow(mount: FlowMount | null, key: string, index: number, total: number): boolean {
  return mount === null || index >= total - mount.tail || mount.near.has(key)
}

/**
 * Track which rows of the column under `listRef` should mount. Below the
 * threshold every row mounts and the hook returns `null`. Above it, the
 * window follows the scroller's scroll and size, and each mounted row's
 * height is remembered for the placeholder that replaces it once it leaves.
 * @param listRef - the flow column element.
 * @param order - the ordered node keys.
 * @param ledger - the view's scroll ledger; without one, corrections are plain scroll writes.
 * @returns the window, or `null` when every row mounts.
 */
export function useFlowWindow(
  listRef: RefObject<HTMLElement | null>,
  order: readonly string[],
  ledger?: FlowScrollLedger,
): {
  readonly mount: FlowMount | null
  readonly heightOf: (key: string) => number
} {
  const enabled = order.length > FLOW_WINDOW_THRESHOLD
  const heights = useRef(new Map<string, number>())
  const [mount, setMount] = useState<FlowMount | null>(null)
  const frame = useRef<number | null>(null)

  /** The first visible row and its top before a window change, so the commit that mounts or unmounts rows can keep it in place. */
  const held = useRef<{ readonly key: string; readonly top: number } | null>(null)

  /** Record every mounted row's height, so the placeholder that replaces it holds the same box. */
  const record = useCallback((list: HTMLElement): void => {
    for (const row of list.querySelectorAll<HTMLElement>('[data-chat-flow-key]:not([data-chat-placeholder])')) {
      const key = row.dataset['chatFlowKey']
      if (key !== undefined) heights.current.set(key, row.offsetHeight)
    }
  }, [])

  /**
   * The first row whose box reaches into the viewport, and its top in the
   * scroller's coordinates. A mounted row is preferred: its height survives
   * the change, while a placeholder that mounts takes its real height, which
   * would move every row below it if the placeholder held the anchor.
   */
  const firstVisible = useCallback((list: HTMLElement, scroller: HTMLElement): { key: string; top: number } | null => {
    const origin = scroller.getBoundingClientRect().top
    for (const selector of ['[data-chat-flow-key]:not([data-chat-placeholder])', '[data-chat-flow-key]']) {
      for (const row of list.querySelectorAll<HTMLElement>(selector)) {
        const rect = row.getBoundingClientRect()
        if (rect.width === 0 && rect.height === 0) continue
        const key = row.dataset['chatFlowKey']
        if (rect.bottom - origin > 0 && key !== undefined) return { key, top: rect.top - origin }
      }
    }
    return null
  }, [])

  const measure = useCallback((): void => {
    const list = listRef.current
    if (list === null) return
    const scroller = scrollerOf(list)
    record(list)
    const rows = list.querySelectorAll<HTMLElement>('[data-chat-flow-key]')
    if (!enabled) {
      setMount(current => current === null ? current : null)
      return
    }
    const origin = scroller.getBoundingClientRect().top
    const boxes: (readonly [number, number])[] = []
    for (const row of rows) {
      const rect = row.getBoundingClientRect()
      // A hidden row has no box and reports the origin; it sits where the
      // row before it ends, so the order the search relies on holds.
      const previous = boxes.at(-1)?.[1] ?? 0
      boxes.push(rect.width === 0 && rect.height === 0 ? [previous, previous] : [rect.top - origin, rect.bottom - origin])
    }
    const range = windowRange(boxes, 0, scroller.clientHeight, rows.length, FLOW_WINDOW_TAIL)
    const near = new Set<string>()
    for (let index = range.start; index < range.end; index += 1) {
      const key = rows[index]?.dataset['chatFlowKey']
      if (key !== undefined) near.add(key)
    }
    setMount((current) => {
      if (current !== null && current.near.size === near.size && [...near].every(key => current.near.has(key))) return current
      // Rows are about to mount or leave; the reader's first visible row
      // must not move when they do.
      held.current = firstVisible(list, scroller)
      return { near, tail: FLOW_WINDOW_TAIL }
    })
  }, [enabled, listRef, record, firstVisible])

  // A passive effect: the column's ref belongs to an ancestor of the list,
  // which React attaches after the list's own layout effects have run.
  useEffect(() => {
    measure()
    if (!enabled) return
    const list = listRef.current
    /* v8 ignore next -- ref-null guard: every ref is attached before passive effects run. */
    if (list === null) return
    const scroller = scrollerOf(list)
    const schedule = (): void => {
      if (frame.current !== null) return
      frame.current = requestAnimationFrame(() => {
        frame.current = null
        measure()
      })
    }
    scroller.addEventListener('scroll', schedule, { passive: true })
    const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null
    resize?.observe(scroller)
    resize?.observe(list)
    return () => {
      scroller.removeEventListener('scroll', schedule)
      resize?.disconnect()
      if (frame.current !== null) {
        cancelAnimationFrame(frame.current)
        frame.current = null
      }
    }
    // A changed order (a prepended page) re-measures without subscribing to anything new.
  }, [enabled, listRef, measure, order.length])

  // After the commit that applied a window change, before paint: the row the
  // reader had at the top of the viewport is put back where it was, whatever
  // the rows above it turned out to measure; a reader at the floor stays there.
  useLayoutEffect(() => {
    const list = listRef.current
    if (list === null) return
    record(list)
    const anchor = held.current
    if (anchor === null) return
    held.current = null
    const scroller = scrollerOf(list)
    if (ledger?.atBottom.current === true) {
      scroller.scrollTop = scroller.scrollHeight
      ledger.observedTop.current = scroller.scrollTop
      return
    }
    const origin = scroller.getBoundingClientRect().top
    for (const row of list.querySelectorAll<HTMLElement>('[data-chat-flow-key]')) {
      if (row.dataset['chatFlowKey'] !== anchor.key) continue
      const shift = row.getBoundingClientRect().top - origin - anchor.top
      if (shift !== 0) scroller.scrollTop += shift
      if (ledger !== undefined) ledger.observedTop.current = scroller.scrollTop
      return
    }
  })

  const heightOf = useCallback((key: string): number => {
    const known = heights.current.get(key)
    if (known !== undefined) return known
    heights.current.set(key, FLOW_PLACEHOLDER_HEIGHT)
    return FLOW_PLACEHOLDER_HEIGHT
  }, [])
  return { mount: enabled ? mount : null, heightOf }
}
