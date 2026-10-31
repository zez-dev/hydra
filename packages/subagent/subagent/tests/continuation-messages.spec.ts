import { describe, expect, it } from 'vitest'
import { ToolCallId, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createSettlementMessage, withContinuableReturnGuidance } from '../src/continuation-messages.ts'

const childId = SessionId('settled-child')
const summary = { type: 'text', text: `Background subagent ${childId} finished and will do no further work unless you send it more.` }
const reasoning: ContentBlock = { type: 'reasoning', text: 'private child reasoning' }
const toolCall: ContentBlock = { type: 'tool-call', id: ToolCallId('child-call'), name: 'read', arguments: '{}' }

describe('continuable settlement content', () => {
  it.each([
    ['reasoning before the answer', [reasoning, { type: 'text', text: 'answer' }]],
    ['a tool call after the answer', [{ type: 'text', text: 'answer' }, toolCall]],
  ] satisfies [string, ContentBlock[]][])('reports only the closing text with %s', (_label, output) => {
    const original = structuredClone(output)
    const message = createSettlementMessage(childId, { stopReason: 'completed', output })

    expect(message.role).toBe('user')
    expect(message.content).toEqual([
      summary,
      { type: 'text', text: 'Its closing message:' },
      { type: 'text', text: 'answer' },
    ])
    expect(output).toEqual(original)
  })

  it.each([
    ['empty output', []],
    ['reasoning-only output', [reasoning]],
    ['empty text', [{ type: 'text', text: '' }]],
  ] satisfies [string, ContentBlock[]][])('reports no closing message for %s', (_label, output) => {
    const message = createSettlementMessage(childId, { stopReason: 'completed', output })

    expect(message.content).toEqual([
      summary,
      { type: 'text', text: 'It left no closing message.' },
    ])
  })

  it('preserves text block order and bytes around omitted reasoning and tool calls', () => {
    const first: ContentBlock = { type: 'text', text: '  first\n' }
    const second: ContentBlock = { type: 'text', text: '\n第二段  ' }
    const message = createSettlementMessage(childId, {
      stopReason: 'completed',
      output: [reasoning, first, toolCall, second],
    })

    expect(message.content).toEqual([
      summary,
      { type: 'text', text: 'Its closing message:' },
      first,
      second,
    ])
  })
})

it('includes closing text alongside structured results and diagnostics', () => {
  expect(createSettlementMessage(childId, {
    stopReason: 'completed', output: [{ type: 'text', text: 'final answer' }],
    structured: { answer: 42 }, diagnostic: 'safe diagnostic',
  }).content).toEqual([
    summary,
    { type: 'text', text: 'Its closing message:' },
    { type: 'text', text: 'final answer' },
    { type: 'text', text: 'Structured result: {"answer":42}' },
    { type: 'text', text: 'safe diagnostic' },
  ])
})

it('omits the closing text after the child messaged its parent, keeping structured results and diagnostics', () => {
  expect(createSettlementMessage(childId, {
    stopReason: 'completed', output: [{ type: 'text', text: 'final answer, restated' }],
    structured: { answer: 42 }, diagnostic: 'safe diagnostic',
  }, true, true).content).toEqual([
    summary,
    { type: 'text', text: 'It sent you a message just before finishing, so its closing message is omitted.' },
    { type: 'text', text: 'Structured result: {"answer":42}' },
    { type: 'text', text: 'safe diagnostic' },
  ])
})

it('appends return guidance naming the parent after the task blocks', () => {
  const task: ContentBlock[] = [{ type: 'text', text: 'Review the diff.' }]

  expect(withContinuableReturnGuidance(SessionId('parent-session'), task)).toEqual([
    ...task,
    {
      type: 'text',
      text: 'Your parent agent id is "parent-session". Before you finish, send your result to that agent with '
        + 'send_message({ agent_id: "parent-session", message: "<self-contained result>" }). The parent shares '
        + 'your workspace but does not automatically receive your transcript, tool output, or reasoning. Send '
        + 'earlier messages as well when a finding changes what the parent should do next; sending a message '
        + 'does not end your turn. If your closing text follows your last message to the parent with no tool '
        + 'call or new input in between, the parent does not receive it, so end with one short line saying you sent '
        + 'the result, without repeating or summarizing it.',
    },
  ])
})
