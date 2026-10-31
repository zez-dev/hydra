import type { Context } from '@deepseek-ai/cordis'
import type {
  ConversationMatch, ConversationNodeContext, ConversationNodeDefinition, LearningReviewNode,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-learning/types'
import { chatNode } from './common.ts'

declare module '../contract/chat-nodes.ts' {
  interface ChatNodeDataMap {
    /** Outcome row of one automatic learning review. */
    'learning-review': LearningReviewNode
  }
}

interface LearningReviewState {
  readonly node: LearningReviewNode
}

function nodeFrom(match: ConversationMatch): LearningReviewNode | undefined {
  if (match.event.type !== 'session/learning-review') return undefined
  const { turn, outcome } = match.event.data
  return { kind: 'learning-review', seq: match.event.seq, time: match.event.time, turn, outcome }
}

/**
 * Row Definition for the outcome of one automatic learning review. The event
 * lands after its turn's end, once the review request has settled, so the row
 * anchors at the event itself and follows the turn it reviewed.
 */
export const learningReviewDefinition: ConversationNodeDefinition<LearningReviewState> = {
  kind: 'learning-review',
  target: 'chat',
  match: event => event.type === 'session/learning-review' ? { id: String(event.seq), role: 'start' } : null,
  start: (_context, match) => {
    const node = nodeFrom(match)
    if (node === undefined) throw new Error('learning-review start requires a session/learning-review event')
    return { node }
  },
  update: context => context.state,
  buildViewNode: (context: ConversationNodeContext<LearningReviewState>) => {
    const first = context.matches[0]
    const node = context.state?.node ?? (first === undefined ? undefined : nodeFrom(first))
    if (node === undefined) return null
    return chatNode(context, 'learning-review', node.seq, node, { groupTree: 'turn' })
  },
}

/**
 * Register the learning-review row contribution.
 * @param ctx - owning UI Conversation context.
 */
export function registerLearningReviewConversationNode(ctx: Context): void {
  ctx.uiConversation.events.register(learningReviewDefinition)
}
