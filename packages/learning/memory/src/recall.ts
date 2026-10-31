/**
 * Recall rendering: the `<retrieved_memory>` block the model sees, its digest,
 * and the message identity test the pre-step listener uses to add, keep, or
 * replace exactly one recall message.
 * @module
 */

import { createHash } from 'node:crypto'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage, messageText } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { MemoryEntry, MemoryEntryId, MemoryEntryKind } from './types.ts'
import { visibleTags } from './workspace.ts'

/** Source kind recorded on every recall message. */
export const MEMORY_SOURCE_KIND = 'plugin:dsh-memory'

/** The rules for using notes, which only the first block in view states. */
const RULES = 'Use a note only when its situation matches the current one: the same file, command, component, or problem.'
  + ' A note about a different case that merely shares a word or a concept says nothing about this one, and never changes what the user asked for: answer the request as stated.'
  + ' When a note does match, check it before acting: do not repeat an approach it records as failed, and do not re-investigate a cause it records as settled.'
  + ' What you observe now takes precedence over any note; when the evidence shows a note is wrong or outdated, say so and correct or remove it with the `memory` tool.'

/** Joins the always-recalled kinds the first block names. */
const KIND_LIST = new Intl.ListFormat('en', { type: 'conjunction' })

/**
 * Head of a block added while no block is in view: which notes the block
 * selects, that `search` lists every stored note, then the rules.
 * @param always - the kinds the block carries whatever the work's words.
 * @returns the head, ending in a newline.
 */
function head(always: readonly MemoryEntryKind[]): string {
  const kinds = always.length === 0 ? '' : `every ${KIND_LIST.format(always)}, plus `
  return [
    '<retrieved_memory>',
    `A selection of notes from earlier work: ${kinds}notes that share words with the current task, this project's first.`
      + ' More may be stored; the `memory` tool\'s `search` without a query lists every stored note.'
      + ` ${RULES}`,
    '',
  ].join('\n')
}

/** Head of a block added while an earlier block, and the rules it states, is still in view. */
const MORE_HEAD = [
  '<retrieved_memory>',
  'More notes from earlier work, retrieved for the latest request; the rules of the earlier <retrieved_memory> block apply.',
  '',
].join('\n')
const TAIL = '\n</retrieved_memory>'

/** One rendered entry line; {@link recalledIds} reads the id back from it. */
const ENTRY_LINE = /^- \([a-z]+, id ([^)\s]+)\)/gmu

/**
 * Render recalled entries into one block, dropping trailing entries once the
 * block would exceed `maxBytes` (UTF-8).
 * @param entries - the entries to show, in order.
 * @param maxBytes - byte cap on the complete block.
 * @param always - the kinds recalled whatever the work's words, which the block's head names.
 * @returns the block text; empty when no entry fits or none was given.
 */
export function renderRecall(entries: readonly MemoryEntry[], maxBytes: number, always: readonly MemoryEntryKind[]): string {
  return renderRecallDetailed(entries, maxBytes, always).text
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
 * @param always - the kinds recalled whatever the work's words, which the block's head names.
 * @param continued - whether an earlier block, and the rules it states, is still in view; the block
 *   then opens with a one-line pointer to those rules instead of repeating them.
 * @returns the block text and the included ids; both empty when nothing fits.
 */
export function renderRecallDetailed(
  entries: readonly MemoryEntry[],
  maxBytes: number,
  always: readonly MemoryEntryKind[],
  continued = false,
): RenderedRecall {
  if (entries.length === 0) return { text: '', ids: [] }
  const opening = continued ? MORE_HEAD : head(always)
  const lines: string[] = []
  const ids: MemoryEntryId[] = []
  let bytes = Buffer.byteLength(opening) + Buffer.byteLength(TAIL)
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
  return { text: `${opening}${lines.join('\n')}${TAIL}`, ids }
}

/**
 * The ids of the entries a rendered block carries, in block order.
 * @param text - a block from {@link renderRecallDetailed}.
 * @returns the ids its entry lines name; empty for text without entry lines.
 */
export function recalledIds(text: string): MemoryEntryId[] {
  return Array.from(text.matchAll(ENTRY_LINE), match => brandString<MemoryEntryId>(String(match[1])))
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
 * @returns true for this plugin's source in `recall` form.
 */
export function isRecallMessage(message: UserMessage): boolean {
  return message.source.kind === MEMORY_SOURCE_KIND && message.source.form === 'recall'
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
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: MEMORY_SOURCE_KIND, form: 'recall' } })
}
