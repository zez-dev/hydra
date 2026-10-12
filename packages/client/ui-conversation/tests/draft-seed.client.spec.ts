import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { UiConversation } from '../src/client/conversation/assembly.ts'

const sid = (id: string): SessionId => id as SessionId

describe('seeded composer drafts', () => {
  it('hands a seeded draft to the next taker once and prefers a live writer when one is bound', () => {
    const ctx = new Context()
    onTestFinished(async () => { await ctx.fiber.dispose() })
    const uiConversation = new UiConversation(ctx, { binding: () => undefined } as never)
    uiConversation.seedDraft(sid('a'), 'resend me')
    expect(uiConversation.takeSeededDraft(sid('a'))).toBe('resend me')
    expect(uiConversation.takeSeededDraft(sid('a'))).toBeUndefined()

    const written: [SessionId, string][] = []
    uiConversation.bindDraftWriter((id, text) => { written.push([id, text]); return true })
    uiConversation.seedDraft(sid('b'), 'live')
    expect(written).toEqual([[sid('b'), 'live']])
    expect(uiConversation.takeSeededDraft(sid('b'))).toBeUndefined()
  })
})
