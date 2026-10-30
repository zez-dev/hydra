import { imageOffloadProjection } from '@deepseek-ai/dsh-compaction-image-offload/projection'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId , createMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import {
  Session,
  SessionId,
  SessionSeq,
} from '@deepseek-ai/dsh-session'
import type { SurfaceEvent, ToolResultMessage } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import ToolResultPruner, {
  codePointLength,
  DEFAULTS,
  pruneMarker,
  resolveConfig,
} from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import type { ToolResultPruneConfig } from '@deepseek-ai/dsh-compaction-tool-result-pruner'

const MODEL = 'test-model'
/** The longest marker: an unread span of the largest countable size. */
const LONGEST = codePointLength(pruneMarker(Number.MAX_SAFE_INTEGER, false))
const SMALL: ToolResultPruneConfig = {
  thresholdChars: 200,
  headChars: 4,
  tailChars: 3,
}

function service(config: ToolResultPruneConfig = SMALL): ToolResultPruner {
  const ctx = new Context()
  // Service constructors self-register, so `ctx.tokenMeter` resolves for the
  // shadow-price pricing without a full plugin boot.
  new SessionProjectionRegistry(ctx)
  void new TokenMeter(ctx)
  return new ToolResultPruner(ctx, config)
}

/** Pricing oracle mirroring the service's estimator for expectations. */
const METER_CTX = new Context()
new SessionProjectionRegistry(METER_CTX)
const METER = new TokenMeter(METER_CTX)

function appendToolStep(
  session: Session,
  turn: number,
  call: string,
  content: ContentBlock[],
  extra: Record<string, unknown> = {},
): number {
  const callId = ToolCallId(call)
  session.append('turn/start', {
    turn,
  })
  session.append('step/start', { turn, step: 1 })
  session.append('assistant/message', {
    stream: [],
    turn,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'tool-call', id: callId, name: 'bash', arguments: '{}' }],
      source: {
        kind: 'model',
        ...{ provider: MODEL, model: MODEL },
      },
    }),
  }, { surfaceOp: 'append' })
  session.append('tool/call', { turn, step: 1, callId, name: 'bash', arguments: '{}' })
  const result = session.append('tool/result', {
    turn,
    step: 1,
    message: createToolResultMessage({ callId, content, isError: extra['error'] !== undefined }),
    ...extra,
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
  return result.seq
}

describe('tool-result pruning configuration', () => {
  it('preserves a logged image offload when pruning the same result later', () => {
    const session = Session.create(SessionId('prune-offloaded'), undefined, undefined, undefined, [imageOffloadProjection])
    const seq = appendToolStep(session, 1, 'shot', [
      { type: 'text', text: 'x'.repeat(300) },
      { type: 'image', attachment: {
        attachmentId: `sha256:${'a'.repeat(64)}` as never, mediaType: 'image/png', bytes: 1, width: 1, height: 1,
      } },
    ])
    session.append('image/offload', { targets: [{ seq: SessionSeq(seq), imageIndexes: [0] }] })
    const pruned = service().pruneSession(session, 'all')
    expect(pruned.pruned).toHaveLength(1)
    const replacement = session.snapshotEvents().at(-1)!
    expect(replacement.type).toBe('tool/result')
    expect(JSON.stringify(session.deriveEventMessage(replacement))).toContain('"offloaded":true')
    expect(JSON.stringify(Session.create(SessionId('restored-offloaded'), session.snapshotEvents(), undefined, undefined, [imageOffloadProjection]).deriveMessages())).toContain('"offloaded":true')
    expect(JSON.stringify(session.eventAt(SessionSeq(seq)))).not.toContain('offloaded')
  })

  it('resolves detached immutable defaults and partial overrides', () => {
    const raw = { thresholdChars: 200, headChars: 20, tailChars: 10 }
    const resolved = resolveConfig(raw)
    raw.headChars = 1
    expect(resolved).toEqual({ thresholdChars: 200, headChars: 20, tailChars: 10 })
    expect(Object.isFrozen(resolved)).toBe(true)
    expect(DEFAULTS).toEqual({ thresholdChars: 8192, headChars: 4096, tailChars: 1024 })
    expect(Object.isFrozen(DEFAULTS)).toBe(true)
  })

  it('rejects stale keys, invalid scalars, and an output budget above threshold', () => {
    const bad = [
      [{ thresholdChars: 0 }, /thresholdChars .* positive integer/],
      [{ headChars: -1 }, /headChars .* non-negative integer/],
      [{ tailChars: 1.5 }, /tailChars .* non-negative integer/],
      [{ thresholdChars: 50, headChars: 20, tailChars: 20 }, /headChars \+ marker \+ tailChars/],
      [{ threshold: 10 }, /unknown key "threshold"/],
    ] as Array<[unknown, RegExp]>
    for (const [config, pattern] of bad) {
      expect(() => resolveConfig(config as ToolResultPruneConfig)).toThrow(pattern)
    }
  })

  it('leaves room for the longest marker, which names an unread span', () => {
    expect(resolveConfig({ thresholdChars: 7 + LONGEST, headChars: 4, tailChars: 3 }).thresholdChars).toBe(7 + LONGEST)
    expect(() => resolveConfig({ thresholdChars: 6 + LONGEST, headChars: 4, tailChars: 3 }))
      .toThrow(/headChars \+ marker \+ tailChars/)
  })

  it('names the removed amount and, for a span the model has not read, how to see it', () => {
    expect(pruneMarker(25, true)).toBe('\n\n[... 25 characters cut from the middle to save context ...]\n\n')
    expect(pruneMarker(25, false)).toBe('\n\n[... 25 characters cut from the middle before you read them; '
      + 'repeat the call with a narrower range to see them ...]\n\n')
  })
})

describe('ToolResultPruner content transform', () => {
  it('measures text code points only and skips content within threshold', () => {
    const prune = service()
    const blocks = [
      { type: 'text', text: 'a😀b' },
      { type: 'reasoning', text: 'not measured' },
    ] satisfies ContentBlock[]
    expect(prune.measureContent(blocks)).toBe(3)
    expect(prune.pruneContent(blocks, true)).toBeNull()
    expect(codePointLength('a😀b')).toBe(3)
    // 150 emoji are 300 UTF-16 code units but 150 code points: within the threshold of 200.
    expect(prune.pruneContent([{ type: 'text', text: '😀'.repeat(150) }], true)).toBeNull()
  })

  it('keeps configured head and tail without splitting surrogate pairs', () => {
    const prune = service()
    const result = prune.pruneContent([{ type: 'text', text: '😀'.repeat(300) }], true)
    expect(result).toEqual([{
      type: 'text',
      text: `${'😀'.repeat(4)}${pruneMarker(293, true)}${'😀'.repeat(3)}`,
    }])
    expect(prune.measureContent(result!)).toBeLessThanOrEqual(200)
    expect(result![0]).toMatchObject({ type: 'text' })
    expect((result![0] as { text: string }).text).not.toContain('\uFFFD')
  })

  it('preserves non-text blocks and their relative ordering across removed text', () => {
    const prune = service()
    const reasoning: ContentBlock = { type: 'reasoning', text: 'private-rich-block' }
    const call: ContentBlock = {
      type: 'tool-call',
      id: ToolCallId('nested'),
      name: 'nested',
      arguments: '{}',
    }
    const result = prune.pruneContent([
      { type: 'text', text: 'A'.repeat(100) },
      reasoning,
      { type: 'text', text: 'B'.repeat(100) },
      call,
      { type: 'text', text: 'C'.repeat(100) },
    ], true)
    expect(result).toEqual([
      { type: 'text', text: `AAAA${pruneMarker(293, true)}` },
      reasoning,
      call,
      { type: 'text', text: 'CCC' },
    ])
    expect(prune.measureContent(result!)).toBeLessThanOrEqual(200)
  })

  it('supports zero-sized head and tail while still shrinking', () => {
    const prune = service({
      thresholdChars: LONGEST,
      headChars: 0,
      tailChars: 0,
    })
    const result = prune.pruneContent([{ type: 'text', text: 'x'.repeat(300) }], false)
    expect(result).toEqual([{ type: 'text', text: pruneMarker(300, false) }])
    expect(prune.measureContent(result!)).toBeLessThanOrEqual(prune.config.thresholdChars)
  })
})

describe('ToolResultPruner session transaction', () => {
  it('prunes a stable snapshot, preserves all data, and cites the replaced result', () => {
    const session = Session.create(SessionId('preserve'))
    const originalSeq = appendToolStep(session, 1, 'one', [{
      type: 'text',
      text: 'x'.repeat(300),
    }], {
      isError: true,
      error: { name: 'ExitError', code: 'EXIT_1' },
      meta: { diff: ['a', 'b'] },
      futureField: { nested: true },
    })
    session.append('turn/start', {
      turn: 2,
    })

    const result = service().pruneSession(session, 'all')
    expect(result.pruned).toHaveLength(1)
    expect(result.charsRemoved).toBeGreaterThan(0)
    const entry = result.pruned[0]!
    expect(entry).toMatchObject({ originalSeq, callId: ToolCallId('one'), charsBefore: 300 })
    expect(entry.charsAfter).toBeLessThanOrEqual(200)

    const original = session.snapshotEvents()[originalSeq]!
    const replacement = session.snapshotEvents()[entry.replacementSeq]! as SurfaceEvent
    expect(original).toMatchObject({
      type: 'tool/result',
      data: {
        message: {
          content: [{ type: 'text', text: 'x'.repeat(300) }],
        },
      },
    })
    expect(replacement).toMatchObject({
      type: 'tool/result',
      data: {
        turn: 1,
        step: 1,
        isError: true,
        message: {
          source: { kind: 'tool', callId: ToolCallId('one') },
          role: 'tool',
          toolCallId: ToolCallId('one'),
          isError: true,
        },
        error: { name: 'ExitError', code: 'EXIT_1' },
        meta: { diff: ['a', 'b'] },
        futureField: { nested: true },
      },
      surfaceOp: { op: 'replace', startSeq: originalSeq, endSeq: originalSeq },
      sourceEventSeqs: [originalSeq],
    })
    expect(session.surface.nodes).not.toContain(originalSeq)

    // Shadow-price protocol: the metering event sits directly before the
    // replacement and prices the shadowed node with the shared estimator.
    if (original.type !== 'tool/result') throw new Error('original is not a tool/result')
    expect(session.snapshotEvents()[entry.replacementSeq - 1]).toMatchObject({
      type: 'compaction/prune',
      data: {
        shadowedRange: { start: originalSeq, end: originalSeq },
        shadowedSeqs: [originalSeq],
        shadowedTokenCount: METER.estimateMessage(original.data.message),
      },
    })
  })

  it('prunes multiple results, skips short ones, and converges in one pass', () => {
    const session = Session.create(SessionId('multiple'))
    appendToolStep(session, 1, 'a', [{ type: 'text', text: 'A'.repeat(300) }])
    appendToolStep(session, 2, 'b', [{ type: 'text', text: 'short' }])
    appendToolStep(session, 3, 'c', [{ type: 'text', text: 'C'.repeat(250) }])
    session.append('turn/start', {
      turn: 4,
    })
    const prune = service()
    const first = prune.pruneSession(session, 'all')
    const second = prune.pruneSession(session, 'all')
    expect(first.pruned.map(entry => entry.callId)).toEqual([ToolCallId('a'), ToolCallId('c')])
    expect(first.charsRemoved).toBe(
      first.pruned.reduce((sum, entry) => sum + entry.charsBefore - entry.charsAfter, 0),
    )
    expect(second).toEqual({ pruned: [], charsRemoved: 0 })
  })

  it('replays to the identical pruned model messages', () => {
    const session = Session.create(SessionId('replay'))
    appendToolStep(session, 1, 'a', [{ type: 'text', text: 'A'.repeat(300) }])
    session.append('turn/start', {
      turn: 2,
    })
    service().pruneSession(session, 'all')
    const replay = Session.create(session.id, session.snapshotEvents())
    expect(replay.deriveMessages()).toEqual(session.deriveMessages())
    expect(replay.surface.replaceGeneration).toBe(session.surface.replaceGeneration)
  })

  it('cuts only results a later model answer follows when the scope is read', () => {
    const session = Session.create(SessionId('read-scope'))
    const read = appendToolStep(session, 1, 'read', [{ type: 'text', text: 'R'.repeat(300) }])
    const unread = appendToolStep(session, 2, 'unread', [{ type: 'text', text: 'U'.repeat(300) }])
    const result = service().pruneSession(session, 'read')
    expect(result.pruned.map(entry => entry.originalSeq)).toEqual([read])
    expect(session.surface.nodes).toContain(unread)
    expect(prunedText(session, result.pruned[0]!.replacementSeq)).toBe(`RRRR${pruneMarker(293, true)}RRR`)
  })

  it('marks a result the model has not read when the scope is all', () => {
    const session = Session.create(SessionId('all-scope'))
    const read = appendToolStep(session, 1, 'read', [{ type: 'text', text: 'R'.repeat(300) }])
    const unread = appendToolStep(session, 2, 'unread', [{ type: 'text', text: 'U'.repeat(300) }])
    const result = service().pruneSession(session, 'all')
    expect(result.pruned.map(entry => entry.originalSeq)).toEqual([read, unread])
    expect(prunedText(session, result.pruned[0]!.replacementSeq)).toBe(`RRRR${pruneMarker(293, true)}RRR`)
    expect(prunedText(session, result.pruned[1]!.replacementSeq)).toBe(`UUUU${pruneMarker(293, false)}UUU`)
  })

  it('judges a replaced result by its surface position, not its sequence number', () => {
    const session = Session.create(SessionId('replaced-read'))
    const first = appendToolStep(session, 1, 'first', [{ type: 'text', text: 'F'.repeat(300) }])
    appendToolStep(session, 2, 'second', [{ type: 'text', text: 'short' }])
    const original = session.snapshotEvents()[first]!
    if (original.type !== 'tool/result') throw new Error('original is not a tool/result')
    // Appended after the second answer, the replacement keeps the first result's place on the surface.
    const message = session.deriveEventMessage(original) as ToolResultMessage
    const replaced = session.append('tool/result', {
      ...original.data,
      message: { ...message, content: [{ type: 'text', text: 'G'.repeat(300) }] },
    }, {
      surfaceOp: { op: 'replace', startSeq: SessionSeq(first), endSeq: SessionSeq(first) },
      sourceEventSeqs: [SessionSeq(first)],
    })
    const result = service().pruneSession(session, 'read')
    expect(result.pruned.map(entry => entry.originalSeq)).toEqual([replaced.seq])
    expect(prunedText(session, result.pruned[0]!.replacementSeq)).toBe(`GGGG${pruneMarker(293, true)}GGG`)
  })
})

function prunedText(session: Session, seq: number): string {
  const block = session.deriveEventMessage(session.snapshotEvents()[seq]!)!.content[0]!
  if (block.type !== 'text') throw new Error('the pruned result does not start with text')
  return block.text
}
