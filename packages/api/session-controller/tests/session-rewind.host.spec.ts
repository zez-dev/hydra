/** Session Controller rewind: fork at the boundary before the turn holding an anchor. */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, MessageSource } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
// Type-only: declares the `session/title` event a rename logs.
import type {} from '@deepseek-ai/dsh-session-title'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { createSessionTestRemote, installSessionReadTestServices } from './test-remote.ts'

const sid = (id: string): SessionId => id as SessionId

async function composed(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { personaPrefix: '' })
  await ctx.plugin(AgentRegistry)
  installSessionReadTestServices(ctx)
  ctx.provide('workspaceRegistry', { list: () => [] } as never)
  ctx.agents.setFactory({
    createAgent: async (ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> => {
      const session = ctx.sessions.create(options.sessionId, {
        ...options.seed === undefined ? {} : { seed: [...options.seed] },
        ...options.meta === undefined ? {} : { meta: options.meta },
        ...options.inheritedEventCount === undefined ? {} : { inheritedEventCount: options.inheritedEventCount },
      })
      const agent = {} as Agent
      Object.assign(agent, { id: session.id, session, status: 'idle', ctx: ownerCtx })
      await options.setup?.(ownerCtx, agent)
      await ctx.agents.register(agent)
      return { agent, dispose: () => Promise.resolve() }
    },
    resume: () => Promise.reject(new Error('rewind test sources are live')),
  })
  return ctx
}

/** A live session with `turns` completed turns and optionally one open tail turn. */
async function liveAgent(ctx: Context, id: string, turns: number, openTail = false): Promise<Session> {
  const session = ctx.sessions.create(sid(id), { meta: { cwd: '/proj' } })
  for (let turn = 1; turn <= turns; turn++) {
    session.append('turn/start', { turn })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `prompt ${String(turn)}` }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  if (openTail) {
    session.append('turn/start', { turn: turns + 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'open prompt' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
  }
  await ctx.agents.register({ id: session.id, session, status: 'idle', ctx } as Agent)
  return session
}

/** The user messages one completed turn of a hand-built log admits. */
type TurnMessages = readonly { readonly content: ContentBlock[]; readonly source: MessageSource }[]

/** A live session of completed turns carrying the given user messages, registered as an idle Agent. */
async function liveTurns(ctx: Context, id: string, turns: readonly TurnMessages[]): Promise<Session> {
  const session = ctx.sessions.create(sid(id), { meta: { cwd: '/proj' } })
  for (const [index, messages] of turns.entries()) {
    const turn = index + 1
    session.append('turn/start', { turn })
    for (const message of messages) {
      session.append('user/message', createUserMessage(message), { surfaceOp: 'append' })
    }
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  await ctx.agents.register({ id: session.id, session, status: 'idle', ctx } as Agent)
  return session
}

const human = (text: string) => ({ content: [{ type: 'text' as const, text }], source: { kind: 'user' as const } })

const scheduled = (text: string) => ({
  content: [{ type: 'text' as const, text }],
  source: { kind: 'plugin' as const, plugin: 'schedule' },
})

const image: ContentBlock = {
  type: 'image',
  attachment: { attachmentId: AttachmentId(`sha256:${'d'.repeat(64)}`), mediaType: 'image/png', bytes: 68, width: 1, height: 1 },
}

/** The seq of the `turn/start` of turn `turn`. */
function turnStartSeq(session: Session, turn: number): number {
  return session.snapshotEvents().find(event => event.type === 'turn/start' && event.data.turn === turn)!.seq
}

const remote = (ctx: Context) => createSessionTestRemote(ctx, {
  defaultModelSelection: () => ({ provider: 'default-provider', model: 'default-model' }),
  cwd: '/tmp',
})

function userSeq(session: Session, turn: number): number {
  const events = session.snapshotEvents()
  const start = events.find(event => event.type === 'turn/start' && event.data.turn === turn)!
  return events.find(event => event.seq > start.seq && event.type === 'user/message')!.seq
}

describe('sessions.rewind', () => {
  it('forks at the boundary before the anchored turn and returns that turn\'s prompt', async () => {
    const ctx = await composed()
    const source = await liveAgent(ctx, 'session-source', 3)
    const response = await remote(ctx).rewind({ sessionId: source.id, atSeq: userSeq(source, 3) })
    expect(response.ok ? null : response.error).toBeNull()
    if (!response.ok) return
    expect(response.value.prompt).toBe('prompt 3')
    const child = ctx.sessions.get(response.value.sessionId)
    expect(child?.snapshotEvents().map(event => event.type)).toEqual([
      'turn/start', 'user/message', 'turn/end',
      'turn/start', 'user/message', 'turn/end',
      'session/end-seed',
    ])
    expect(child?.header.parentSession).toBe(source.id)
    expect(child?.header.cwd).toBe('/proj')
    await ctx.fiber.dispose()
  })

  it('rewinds to before an open tail turn, since the cut stays at a completed boundary', async () => {
    const ctx = await composed()
    const source = await liveAgent(ctx, 'session-open', 2, true)
    const response = await remote(ctx).rewind({ sessionId: source.id, atSeq: userSeq(source, 3) })
    expect(response.ok ? null : response.error).toBeNull()
    if (!response.ok) return
    expect(response.value.prompt).toBe('open prompt')
    const child = ctx.sessions.get(response.value.sessionId)
    expect(child?.snapshotEvents().filter(event => event.type === 'turn/end')).toHaveLength(2)
    await ctx.fiber.dispose()
  })

  it('refuses the first turn, which has no completed boundary before it', async () => {
    const ctx = await composed()
    const source = await liveAgent(ctx, 'session-first', 2)
    const response = await remote(ctx).rewind({ sessionId: source.id, atSeq: userSeq(source, 1) })
    expect(response.ok).toBe(false)
    if (response.ok) return
    expect(response.error.code).toBe('session/rewind-unavailable')
    await ctx.fiber.dispose()
  })

  it('refuses an anchor outside the log and a malformed anchor', async () => {
    const ctx = await composed()
    const source = await liveAgent(ctx, 'session-range', 1)
    const past = await remote(ctx).rewind({ sessionId: source.id, atSeq: source.seq + 10 })
    expect(past.ok ? null : past.error.code).toBe('session/rewind-unavailable')
    const malformed = await remote(ctx).rewind({ sessionId: source.id, atSeq: -1 })
    expect(malformed.ok ? null : malformed.error.code).toBe('gateway/bad-request')
    await ctx.fiber.dispose()
  })

  it('refuses a session that has logged nothing yet, and an anchor before its first turn', async () => {
    const ctx = await composed()
    const empty = await liveTurns(ctx, 'session-empty', [])
    const nothing = await remote(ctx).rewind({ sessionId: empty.id, atSeq: 0 })
    expect(nothing.ok ? null : nothing.error).toMatchObject({
      code: 'session/rewind-unavailable',
      message: expect.stringContaining('event 0 is past the end of the log') as string,
    })

    // A rename before the first prompt is logged outside every turn.
    const session = ctx.sessions.create(sid('session-named-early'), { meta: { cwd: '/proj' } })
    session.append('session/title', { title: 'Named early', messageSeqs: [], source: { kind: 'user' } })
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage(human('prompt 1')), { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await ctx.agents.register({ id: session.id, session, status: 'idle', ctx } as Agent)
    const early = await remote(ctx).rewind({ sessionId: session.id, atSeq: 0 })
    expect(early.ok ? null : early.error).toMatchObject({
      code: 'session/rewind-unavailable',
      message: expect.stringContaining('event 0 belongs to no turn') as string,
    })
    await ctx.fiber.dispose()
  })

  it('returns no prompt for a turn a plugin message started, whether or not a later turn follows', async () => {
    const ctx = await composed()
    const source = await liveTurns(ctx, 'session-scheduled', [
      [human('prompt 1')],
      [scheduled('scheduled check-in')],
      [human('prompt 3')],
      [scheduled('scheduled wrap-up')],
    ])
    for (const turn of [2, 4]) {
      const response = await remote(ctx).rewind({ sessionId: source.id, atSeq: turnStartSeq(source, turn) })
      if (!response.ok) throw response.error
      expect(response.value).not.toHaveProperty('prompt')
      const child = ctx.sessions.get(response.value.sessionId)
      expect(child?.snapshotEvents().filter(event => event.type === 'turn/end')).toHaveLength(turn - 1)
    }
    await ctx.fiber.dispose()
  })

  it('returns only the text of a prompt that carried an image, and no prompt for an image alone', async () => {
    const ctx = await composed()
    const source = await liveTurns(ctx, 'session-images', [
      [human('prompt 1')],
      [{ content: [image, { type: 'text', text: 'what is in this picture?' }], source: { kind: 'user' } }],
      [{ content: [image], source: { kind: 'user' } }],
    ])
    const captioned = await remote(ctx).rewind({ sessionId: source.id, atSeq: turnStartSeq(source, 2) })
    if (!captioned.ok) throw captioned.error
    expect(captioned.value.prompt).toBe('what is in this picture?')
    const bare = await remote(ctx).rewind({ sessionId: source.id, atSeq: turnStartSeq(source, 3) })
    if (!bare.ok) throw bare.error
    expect(bare.value).not.toHaveProperty('prompt')
    await ctx.fiber.dispose()
  })
})
