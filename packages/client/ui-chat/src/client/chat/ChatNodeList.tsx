/**
 * The ordered flow of chat nodes: every node mounts its renderer seat while
 * the conversation is short; past the window threshold, rows away from the
 * viewport hold their place as placeholders instead.
 * @module dsh-client-ui-chat/chat/ChatNodeList
 */
import { memo, type ComponentProps, type RefObject } from 'react'
import { ChatNodePlaceholder, ChatNodeSeat } from './ChatNodeSeat.tsx'
import { mountsRow, useFlowWindow, type FlowScrollLedger } from './flow-window.ts'

type ChatNodeListProps = Omit<ComponentProps<typeof ChatNodeSeat>, 'nodeKey'> & {
  readonly order: readonly string[]
  /** The flow column the rows render into; the mounted window follows its scroller. */
  readonly listRef: RefObject<HTMLElement | null>
  /** The view's scroll ledger, so the window's own scroll writes keep the view's follow state. */
  readonly ledger?: FlowScrollLedger
}

/**
 * Render the ordered nodes, mounting only the rows the window names once
 * the conversation is long.
 * @param props - the order, the column ref, the scroll ledger, and the seat props shared by every row.
 * @returns the rows.
 */
export const ChatNodeList = memo(function ChatNodeList({ order, listRef, ledger, ...seatProps }: ChatNodeListProps) {
  const { mount, heightOf } = useFlowWindow(listRef, order, ledger)
  return order.map((nodeKey, index) => (
    mountsRow(mount, nodeKey, index, order.length)
      ? <ChatNodeSeat key={nodeKey} nodeKey={nodeKey} {...seatProps} />
      : <ChatNodePlaceholder key={nodeKey} nodeKey={nodeKey} useChatNode={seatProps.useChatNode} height={heightOf(nodeKey)} />
  ))
})
