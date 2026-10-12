import { describe, expect, it } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { assistantStreamFirstTokenTime, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { AssistantStreamRecord } from '@deepseek-ai/dsh-llm'
import { slimAssistantStream } from '../src/history-slim.ts'

const STREAM: AssistantStreamRecord[] = [
  { type: 'chunk', time: 1000, chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } },
  { type: 'reasoning-chunks', time0: 1010, index: 0, dt: [5, 5, 5], texts: ['', 'thinking', ' hard', ' now'] },
  { type: 'chunk', time: 1030, chunk: { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'thinking hard now' } } },
  { type: 'chunk', time: 1031, chunk: { type: 'block-start', index: 1, blockType: 'text' } },
  { type: 'text-chunks', time0: 1040, index: 1, dt: Array.from({ length: 199 }, () => 3), texts: Array.from({ length: 200 }, (_, i) => `word${i} `) },
  { type: 'chunk', time: 1700, chunk: { type: 'block-end', index: 1, block: { type: 'text', text: 'the whole answer '.repeat(50) } } },
  { type: 'tool-call-chunks', time0: 1710, index: 2, dt: [2], id: ToolCallId('c1'), name: 'read', args: ['{"path":', '"a.txt"}'] },
  { type: 'chunk', time: 1720, chunk: { type: 'block-end', index: 2, block: { type: 'tool-call', id: ToolCallId('c1'), name: 'read', arguments: '{"path":"a.txt"}' } } },
  { type: 'chunk', time: 1721, chunk: { type: 'usage', usage: { inputTokens: 10, outputTokens: 220 } } },
  { type: 'chunk', time: 1722, chunk: { type: 'finish', reason: { kind: 'stop' } } },
]

describe('slimAssistantStream', () => {
  it('keeps every first-token time and the framing while dropping the deltas', () => {
    const slim = slimAssistantStream(STREAM)
    expect(assistantStreamFirstTokenTime(slim)).toBe(assistantStreamFirstTokenTime(STREAM))
    expect(slim).toHaveLength(STREAM.length)
    expect(slim.map(record => record.type)).toEqual(STREAM.map(record => record.type))
    const text = slim[4]
    if (text?.type !== 'text-chunks') throw new Error('text run expected')
    expect(text.texts).toEqual(['w'])
    expect(text.dt).toEqual([])
    const reasoning = slim[1]
    if (reasoning?.type !== 'reasoning-chunks') throw new Error('reasoning run expected')
    expect(reasoning.texts).toEqual(['', 't'])
    expect(reasoning.dt).toEqual([5])
    expect(JSON.stringify(slim).length).toBeLessThan(JSON.stringify(STREAM).length / 4)
    expect(slim.at(-2)).toEqual(STREAM.at(-2))
    expect(slim.at(-1)).toEqual(STREAM.at(-1))
  })

  it('leaves a run without a non-empty fragment empty and a tool call with its name', () => {
    const slim = slimAssistantStream([
      { type: 'text-chunks', time0: 5, index: 0, dt: [1], texts: ['', ''] },
      { type: 'tool-call-chunks', time0: 9, index: 1, dt: [], id: ToolCallId('c2'), name: 'ls', args: ['{}'] },
    ])
    expect(slim[0]).toEqual({ type: 'text-chunks', time0: 5, index: 0, dt: [], texts: [] })
    expect(slim[1]).toEqual({ type: 'tool-call-chunks', time0: 9, index: 1, dt: [], id: ToolCallId('c2'), name: 'ls', args: ['{'] })
  })

  it('keeps the block-end of an image output whole, since it carries no text to drop', () => {
    const image: AssistantStreamRecord = {
      type: 'chunk',
      time: 30,
      chunk: {
        type: 'block-end',
        index: 0,
        block: {
          type: 'image',
          attachment: { attachmentId: AttachmentId(`sha256:${'c'.repeat(64)}`), mediaType: 'image/png', bytes: 68, width: 1, height: 1 },
        },
      },
    }
    expect(slimAssistantStream([image])).toEqual([image])
  })
})
