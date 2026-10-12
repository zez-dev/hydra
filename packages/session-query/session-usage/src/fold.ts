/**
 * Pure fold from one session's raw event log to its usage cells.
 * @module
 */

import { localDateKey } from '@deepseek-ai/dsh-util-time'
import type { SessionEvent, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { UsageCell } from './types.ts'

/**
 * The fold's own generation, stored beside every cached row.
 *
 * The freshness witness proves the LOG is unchanged; it says nothing about
 * the code that read it. Raising this number is what makes rows folded by an
 * older rule a miss, so a change to which messages count, how days are
 * bucketed, or how a cell is keyed must raise it in the same commit.
 */
export const USAGE_FOLD_VERSION = 1

interface MutableCell {
  day: string
  provider: string
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  messages: number
}

/**
 * Fold one session's own assistant messages into `(day, provider, model)` cells.
 *
 * Events before `inheritedEventCount` belong to the fork parent and are its
 * spend, so a forked session contributes only what it billed itself. Days come
 * from each event's own recorded time, never from the clock at fold time, so
 * re-folding old history places it on the days it happened.
 * @param events - the session's complete raw log, from seq 0.
 * @param inheritedEventCount - leading events inherited from the fork parent.
 * @returns one cell per occupied `(day, provider, model)`, in first-seen order.
 */
export function foldSessionUsage(
  events: readonly SessionEvent[],
  inheritedEventCount: SessionLogOffset,
): UsageCell[] {
  const cells = new Map<string, MutableCell>()
  const first: number = inheritedEventCount
  for (let index = first; index < events.length; index += 1) {
    const event = events[index]
    if (event === undefined || event.type !== 'assistant/message') continue
    const usage = event.data.usage
    if (usage === undefined) continue
    // Every assistant message is attributed to the model route that produced
    // it: `AssistantMessage.source` is a `ModelMessageSource`, so provider and
    // model are always present and no non-model source can reach this fold.
    const source = event.data.message.source
    const day = localDateKey(new Date(event.time))
    const key = `${day}\u0000${source.provider}\u0000${source.model}`
    let cell = cells.get(key)
    if (cell === undefined) {
      cell = {
        day,
        provider: source.provider,
        model: source.model,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        messages: 0,
      }
      cells.set(key, cell)
    }
    cell.inputTokens += usage.inputTokens
    cell.outputTokens += usage.outputTokens
    cell.cacheReadTokens += usage.cacheReadTokens ?? 0
    cell.cacheWriteTokens += usage.cacheWriteTokens ?? 0
    cell.reasoningTokens += usage.reasoningTokens ?? 0
    cell.messages += 1
  }
  return [...cells.values()]
}
