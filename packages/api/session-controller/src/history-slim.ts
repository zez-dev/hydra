/**
 * Settled history on the browser wire: the embedded token stream of an
 * assistant settlement is cut to what a reader of settled history uses (the
 * first-token time of every run, the framing records), so a page's bytes and
 * the Client's retained heap follow the message content, not the delta count.
 * @module dsh-api-session-controller/history-slim
 */
import type { AssistantStreamRecord } from '@deepseek-ai/dsh-llm'
import { assertNever } from '@deepseek-ai/dsh-util-values'

/**
 * Cut one packed run to its members up to and including the first non-empty
 * fragment, that fragment reduced to one character, so `runFirstTokenTime`
 * answers as before while the run holds no reader-visible text.
 * @param fragments - the run's text or argument fragments.
 * @param dt - the run's inter-member deltas (one fewer than the fragments).
 * @returns the cut fragments and deltas.
 */
function cutRun(fragments: readonly string[], dt: readonly number[]): { fragments: string[]; dt: number[] } {
  for (const [index, fragment] of fragments.entries()) {
    if (fragment !== '') return { fragments: [...fragments.slice(0, index), fragment.charAt(0)], dt: dt.slice(0, index) }
  }
  return { fragments: [], dt: [] }
}

/**
 * The settled-history form of one compact assistant stream: every run keeps
 * its start time and first-token time, every raw framing chunk stays, and
 * block-end payloads lose their text and arguments.
 * @param stream - the durable compact records of one settlement.
 * @returns records a settled-history reader answers identically from.
 */
export function slimAssistantStream(stream: readonly AssistantStreamRecord[]): AssistantStreamRecord[] {
  return stream.map((record) => {
    switch (record.type) {
      case 'text-chunks':
      case 'reasoning-chunks': {
        const cut = cutRun(record.texts, record.dt)
        return { ...record, texts: cut.fragments, dt: cut.dt }
      }
      case 'tool-call-chunks': {
        const cut = cutRun(record.args, record.dt)
        return { ...record, args: cut.fragments, dt: cut.dt }
      }
      case 'chunk': {
        const { chunk } = record
        if (chunk.type !== 'block-end') return record
        const block = chunk.block
        if (block.type === 'text' || block.type === 'reasoning') return { ...record, chunk: { ...chunk, block: { ...block, text: '' } } }
        if (block.type === 'tool-call') return { ...record, chunk: { ...chunk, block: { ...block, arguments: '' } } }
        return record
      }
      /* v8 ignore next 2 -- closed-union exhaustiveness guard */
      default:
        return assertNever(record, 'assistant stream record')
    }
  })
}
