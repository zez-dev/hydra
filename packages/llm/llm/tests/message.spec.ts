import { describe, expect, it } from 'vitest'
import {
  ToolCallId,
  createAssistantMessage,
  createPluginRecallMessage,
  createToolResultMessage,
  createUserMessage,
  freezeMessage,
  isPluginRecallMessage,
  MessageId,
  messageText,
} from '@deepseek-ai/dsh-llm'

describe('message construction', () => {
  it('assigns identity immediately and returns a detached deep-frozen message', () => {
    const input = {
      content: [{ type: 'text' as const, text: 'original' }],
      source: { kind: 'plugin' as const, plugin: 'test' },
    }

    const message = createUserMessage(input)

    expect(message.id).toEqual(expect.any(String))
    expect(message.role).toBe('user')
    expect(message.id).not.toHaveLength(0)
    expect(message).not.toBe(input)
    expect(Object.isFrozen(message)).toBe(true)
    expect(Object.isFrozen(message.content)).toBe(true)
    expect(Object.isFrozen(message.content[0])).toBe(true)
    expect(Object.isFrozen(message.source)).toBe(true)

    input.content[0]!.text = 'caller mutation'
    expect(message.content).toEqual([{ type: 'text', text: 'original' }])
    expect(() => {
      (message.content[0] as { text: string }).text = 'observer mutation'
    }).toThrow()
  })

  it('freezes an existing identity without minting a replacement', () => {
    const id = MessageId('existing')
    const input = {
      id,
      role: 'assistant' as const,
      content: [{ type: 'text' as const, text: 'answer' }],
      source: { kind: 'model' as const, provider: 'test', model: 'test' },
    }

    const message = freezeMessage(input)

    expect(message).not.toBe(input)
    expect(message.id).toBe(id)
    expect(Object.isFrozen(message)).toBe(true)
    expect(Object.isFrozen(message.content[0])).toBe(true)
  })

  it('fixes the assistant role and model source kind at creation', () => {
    const message = createAssistantMessage({
      content: [{ type: 'text', text: 'answer' }],
      source: {
        provider: 'test-provider',
        model: 'test-model',
        replayState: { request: 1 },
      },
    })

    expect(message).toMatchObject({
      role: 'assistant',
      source: {
        kind: 'model',
        provider: 'test-provider',
        model: 'test-model',
        replayState: { request: 1 },
      },
    })
    expect(message.id).not.toHaveLength(0)
    expect(Object.isFrozen(message)).toBe(true)
    expect(Object.isFrozen(message.source)).toBe(true)
  })

  it('couples tool-result content and its cited call seq to one call identity', () => {
    const callId = ToolCallId('call-1')
    const message = createToolResultMessage({
      callId,
      content: [{ type: 'text', text: 'result' }],
      isError: false,
    })

    expect(message).toMatchObject({
      role: 'user',
      source: { kind: 'tool', callId },
      content: [{
        type: 'tool-result',
        toolCallId: callId,
        content: [{ type: 'text', text: 'result' }],
        isError: false,
      }],
    })
    expect(message.id).not.toHaveLength(0)
    expect(Object.isFrozen(message)).toBe(true)
    expect(Object.isFrozen(message.content[0])).toBe(true)
  })
})

describe('plugin recall messages', () => {
  it('creates a frozen user message holding the text, sourced to the plugin in recall form', () => {
    const message = createPluginRecallMessage('dsh-memory', '<retrieved_memory>note</retrieved_memory>')
    expect(message).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: '<retrieved_memory>note</retrieved_memory>' }],
      source: { kind: 'plugin', plugin: 'dsh-memory', form: 'recall' },
    })
    expect(message.id).toEqual(expect.any(String))
    expect(Object.isFrozen(message)).toBe(true)
  })

  it('recognizes only the named plugin\'s recall form', () => {
    const content = [{ type: 'text' as const, text: 'note' }]
    expect(isPluginRecallMessage(createPluginRecallMessage('dsh-memory', 'note'), 'dsh-memory')).toBe(true)
    expect(isPluginRecallMessage(createPluginRecallMessage('dsh-memory', 'note'), 'dsh-research')).toBe(false)
    expect(isPluginRecallMessage(createUserMessage({ content, source: { kind: 'plugin', plugin: 'dsh-memory' } }), 'dsh-memory')).toBe(false)
    expect(isPluginRecallMessage(createUserMessage({ content, source: { kind: 'user' } }), 'dsh-memory')).toBe(false)
  })

  it('reads the text blocks of a message, concatenated, and nothing else', () => {
    const mixed = createUserMessage({
      content: [{ type: 'text', text: 'Hello' }, { type: 'reasoning', text: 'hidden' }, { type: 'text', text: ' world' }],
      source: { kind: 'user' },
    })
    expect(messageText(mixed)).toBe('Hello world')
    expect(messageText(createUserMessage({ content: [{ type: 'reasoning', text: 'hidden' }], source: { kind: 'user' } }))).toBe('')
  })
})
