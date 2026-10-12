/**
 * Recall rendering: the `<retrieved_memory>` block the model sees, its digest,
 * and the message identity test the pre-step listener uses to add, keep, or
 * replace exactly one recall message.
 * @module
 */

import { createHash } from 'node:crypto'
import { createPluginRecallMessage, isPluginRecallMessage, messageText } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { MemoryEntry, MemoryEntryId } from './types.ts'
import { visibleTags } from './workspace.ts'

/** Plugin name recorded on every recall message source. */
export const MEMORY_PLUGIN = 'dsh-memory'

const HEAD = [
  '<retrieved_memory>',
  'Notes from earlier work, retrieved because they share words with the current task; notes from this project come first.'
    + ' Use a note only when its situation matches the current one: the same file, command, component, or problem.'
    + ' A note about a different case that merely shares a word or a concept says nothing about this one, and never changes what the user asked for: answer the request as stated.'
    + ' When a note does match, check it before acting: do not repeat an approach it records as failed, and do not re-investigate a cause it records as settled.'
    + ' What you observe now takes precedence over any note; when the evidence shows a note is wrong or outdated, say so and correct or remove it with the `memory` tool.',
  '',
].join('\n')
const TAIL = '\n</retrieved_memory>'

/**
 * Render recalled entries into one block, dropping trailing entries once the
 * block would exceed `maxBytes` (UTF-8).
 * @param entries - the entries to show, in order.
 * @param maxBytes - byte cap on the complete block.
 * @returns the block text; empty when no entry fits or none was given.
 */
export function renderRecall(entries: readonly MemoryEntry[], maxBytes: number): string {
  return renderRecallDetailed(entries, maxBytes).text
}

/** A rendered recall block plus the ids of the entries it carries. */
export interface RenderedRecall {
  readonly text: string
  readonly ids: readonly MemoryEntryId[]
}

/**
 * Like {@link renderRecall}, also reporting which entries made it into the block.
 * @param entries - the entries to show, in order.
 * @param maxBytes - byte cap on the complete block.
 * @returns the block text and the included ids; both empty when nothing fits.
 */
export function renderRecallDetailed(entries: readonly MemoryEntry[], maxBytes: number): RenderedRecall {
  if (entries.length === 0) return { text: '', ids: [] }
  const lines: string[] = []
  const ids: MemoryEntryId[] = []
  let bytes = Buffer.byteLength(HEAD) + Buffer.byteLength(TAIL)
  for (const entry of entries) {
    const shown = visibleTags(entry.tags)
    const tags = shown.length === 0 ? '' : ` [${shown.join(', ')}]`
    const line = `- (${entry.kind}, id ${entry.id})${tags} ${entry.text}`
    const size = Buffer.byteLength(line) + 1
    if (bytes + size > maxBytes) break
    bytes += size
    lines.push(line)
    ids.push(entry.id)
  }
  if (lines.length === 0) return { text: '', ids: [] }
  return { text: `${HEAD}${lines.join('\n')}${TAIL}`, ids }
}

/**
 * Stable digest of a rendered recall block.
 * @param text - the block text.
 * @returns a hex digest.
 */
export function digestRecall(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/**
 * Whether a message is this plugin's recall message.
 * @param message - any user-role message.
 * @returns true for a `dsh-memory` plugin source in `recall` form.
 */
export function isRecallMessage(message: UserMessage): boolean {
  return isPluginRecallMessage(message, MEMORY_PLUGIN)
}

/**
 * The text of a recall message.
 * @param message - a message that satisfies {@link isRecallMessage}.
 * @returns the concatenated text blocks.
 */
export function recallText(message: UserMessage): string {
  return messageText(message)
}

/**
 * Build the recall message for one rendered block.
 * @param text - the block from {@link renderRecall}.
 * @returns a user-role message sourced to this plugin in `recall` form.
 */
export function createRecallMessage(text: string): UserMessage {
  return createPluginRecallMessage(MEMORY_PLUGIN, text)
}
