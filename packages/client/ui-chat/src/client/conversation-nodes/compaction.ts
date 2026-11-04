import type { Context } from '@deepseek-ai/cordis'
import type {
  CompactionSummaryNode, ConversationMatch, ConversationNodeContext, ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-compaction/types'
import { chatNode } from './common.ts'
import { compactSource, compactSummary, updateCompactionState } from './command.ts'

declare module '../contract/chat-nodes.ts' {
  interface ChatNodeDataMap {
    /** Automatic compaction checkpoint marker. */
    compaction: CompactionSummaryNode
    /** Automatic compaction still running: started, not ended, no checkpoint yet. */
    'compaction-running': CompactionRunningChatData
  }
}

interface CompactionState {
  readonly start?: ConversationMatch
  readonly ended?: true
  readonly summary?: ConversationMatch
  readonly checkpoint?: ConversationMatch
}

function fallbackState(context: ConversationNodeContext<CompactionState>): CompactionState {
  const summary = context.matches.find(match => match.event.type === 'compaction/summary')
  const checkpoint = context.matches.find(match => compactSource(match.event) !== undefined)
  return {
    ...summary === undefined ? {} : { summary },
    ...checkpoint === undefined ? {} : { checkpoint },
  }
}

/** Automatic compaction lifecycle and landed checkpoint Definition. */
export const compactionDefinition: ConversationNodeDefinition<CompactionState> = {
  kind: 'compaction',
  target: 'chat',
  match: (event) => {
    const checkpoint = compactSource(event)
    if (checkpoint !== undefined && checkpoint.sourceCommandId === undefined) {
      return { id: checkpoint.compactionId, role: 'update' }
    }
    if (event.type === 'compaction/start'
      || event.type === 'compaction/summary'
      || event.type === 'compaction/end') {
      if (event.data.sourceCommandId !== undefined) return null
      const compactionId: unknown = event.data.compactionId
      if (typeof compactionId !== 'string' || compactionId === '') return null
      return { id: compactionId, role: event.type === 'compaction/start' ? 'start' : 'update' }
    }
    return null
  },
  start: (_context, match) => ({ start: match }),
  update: (context, match) => match.event.type === 'compaction/end'
    ? { ...context.state, ended: true }
    : updateCompactionState(context.state, match),
  // A State rebuilt without its start (paged out of the window) never shows
  // the running row: only the live tail can hold a compaction still running.
  // The running row stands outside step runs so the collapsed step groups of
  // a running Turn cannot hide it, and hides once the compaction ends without
  // a checkpoint.
  buildViewNode: (context) => {
    const state = context.state ?? fallbackState(context)
    if (state.checkpoint !== undefined) {
      const marker = compactSummary(state.summary, state.checkpoint)
      return chatNode(context, 'compaction', marker.seq, marker)
    }
    if (state.start === undefined) return null
    const { seq, time } = state.start.event
    return chatNode(context, 'compaction-running', seq, { seq, time }, {
      groupTree: 'process',
      visibility: state.ended === true ? 'hidden' : 'visible',
    })
  },
}

/**
 * Register the automatic-compaction business contribution.
 * @param ctx - owning UI Conversation context.
 */
export function registerCompactionConversationNode(ctx: Context): void {
  ctx.uiConversation.events.register(compactionDefinition)
}
