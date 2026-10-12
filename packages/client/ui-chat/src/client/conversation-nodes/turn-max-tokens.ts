import type { Context } from '@deepseek-ai/cordis'
import type {
  ConversationMatch, ConversationNodeContext, ConversationNodeDefinition, TurnMaxTokensNode,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { lastAssistantStreamChunk } from '@deepseek-ai/dsh-llm/assistant-stream'
import { CHAT_SYNTHETIC_SEQ_OFFSETS, chatNode } from './common.ts'

declare module '../contract/chat-nodes.ts' {
  interface ChatNodeDataMap {
    /** Turn ended by the per-request output-token cap. */
    'turn-max-tokens': TurnMaxTokensNode
  }
}

interface TurnMaxTokensState {
  readonly turn: number
  /**
   * Whether the turn's latest reply stopped at the cap; `undefined` until a
   * reply with a recorded stream is seen.
   */
  readonly lastCut?: boolean
  /** The max-tokens `turn/end`, once it arrives. */
  readonly end?: { readonly seq: number; readonly time: number }
}

function lastStep(context: ConversationNodeContext<TurnMaxTokensState>): number {
  const location = context.start?.location ?? context.matches[0]?.location
  if (location?.kind !== 'turn' && location?.kind !== 'step') return 0
  return location.turn.steps.at(-1)?.step ?? 0
}

/**
 * Anchor the notice between the closing Assistant and the turn-tail so the
 * tail stays the turn's last Chat node and keeps its branch action enabled.
 * Without a closing text Assistant there is no branch action to protect, and
 * the turn/end seq keeps the notice at the truncation point.
 */
function noticeAnchor(context: ConversationNodeContext<TurnMaxTokensState>, seq: number): number {
  const location = context.start?.location ?? context.matches[0]?.location
  if (location?.kind !== 'turn' && location?.kind !== 'step') return seq
  const closing = location.turn.data.get('turn-tail')?.closing
  return closing === null || closing === undefined
    ? seq
    : closing.finalNode.seq + CHAT_SYNTHETIC_SEQ_OFFSETS.maxTokensNotice
}

function endFrom(match: ConversationMatch): TurnMaxTokensState['end'] | undefined {
  if (match.event.type !== 'turn/end' || match.event.data.reason.kind !== 'max-tokens') return undefined
  return { seq: match.event.seq, time: match.event.time }
}

/** Whether a reply stopped at the cap; `undefined` for a reply whose stream records no finish. */
function replyCut(match: ConversationMatch): boolean | undefined {
  if (match.event.type !== 'assistant/message' || !Array.isArray(match.event.data.stream)) return undefined
  const finish = lastAssistantStreamChunk(match.event.data.stream, 'finish')
  return finish === undefined ? undefined : finish.reason.kind === 'max-tokens'
}

/**
 * The state a window that starts after the owning `turn/start` still proves:
 * the max-tokens `turn/end`, and whether the latest reply on the page was cut.
 */
function fallbackState(context: ConversationNodeContext<TurnMaxTokensState>): TurnMaxTokensState | undefined {
  const endMatch = context.matches.find(match => endFrom(match) !== undefined)
  if (endMatch?.event.type !== 'turn/end') return undefined
  const end = endFrom(endMatch)
  if (end === undefined) return undefined
  const lastCut = context.matches.reduce<boolean | undefined>((cut, match) => replyCut(match) ?? cut, undefined)
  return { turn: endMatch.event.data.turn, end, ...lastCut === undefined ? {} : { lastCut } }
}

/**
 * Notice Definition for a turn the provider ended at its output-token cap.
 * The `max-tokens` turn outcome is sticky once any step was cut, so a turn
 * that auto-continue carried to a finished answer still ends `max-tokens`;
 * the notice asks the reader to continue, so it shows only when the turn's
 * last reply is the one the cap cut (or when that reply is not on the page).
 */
export const turnMaxTokensDefinition: ConversationNodeDefinition<TurnMaxTokensState> = {
  kind: 'turn-max-tokens',
  target: 'chat',
  match: (event) => {
    if (event.type === 'turn/start') return { id: String(event.data.turn), role: 'start' }
    if (event.type === 'assistant/message') return { id: String(event.data.turn), role: 'update' }
    if (event.type === 'turn/end' && event.data.reason.kind === 'max-tokens') {
      return { id: String(event.data.turn), role: 'update' }
    }
    return null
  },
  start: (_context, match) => {
    if (match.event.type !== 'turn/start') throw new Error('turn-max-tokens start requires turn/start')
    return { turn: match.event.data.turn }
  },
  update: (context, match) => {
    const end = endFrom(match)
    if (end !== undefined) return { ...context.state, end }
    const cut = replyCut(match)
    return cut === undefined ? context.state : { ...context.state, lastCut: cut }
  },
  buildViewNode: (context) => {
    const state = context.state ?? fallbackState(context)
    if (state?.end === undefined || state.lastCut === false) return null
    const node: TurnMaxTokensNode = {
      kind: 'turn-max-tokens',
      seq: state.end.seq,
      time: state.end.time,
      turn: state.turn,
      step: lastStep(context),
    }
    return chatNode(context, 'turn-max-tokens', noticeAnchor(context, state.end.seq), node)
  },
}

/**
 * Register the max-tokens turn-end notice contribution.
 * @param ctx - owning UI Conversation context.
 */
export function registerTurnMaxTokensConversationNode(ctx: Context): void {
  ctx.uiConversation.events.register(turnMaxTokensDefinition)
}
