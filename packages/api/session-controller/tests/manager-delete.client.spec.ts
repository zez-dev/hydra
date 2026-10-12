import { describe, expect } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { ok, type RemoteMock } from '@deepseek-ai/dsh-remote-mock'
import {
  createClientTest, type ClientTestFixtures, webApp,
} from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import type {} from '@deepseek-ai/dsh-session-title/client'
import { SessionManager } from '../src/client/sessions/manager.ts'
import type { SessionRemotes } from '../src/client/sessions/remotes.ts'
import { err, sessionWorld } from './remote/session.client.ts'

const S1 = 'fk-d1' as SessionId
const S2 = 'fk-d2' as SessionId
const API_ROSTER = webApp.closure(['@deepseek-ai/dsh-api-gateway'])
const it = createClientTest({ roster: API_ROSTER })

function summary(sessionId: SessionId, over: Partial<{ parentSessionId: SessionId; origin: 'subagent' }> = {}) {
  return { sessionId, updatedAt: 100, running: false, blank: false, ...over }
}

function makeManager(mock: RemoteMock, remote: ClientTestFixtures['remote']): SessionManager {
  mock.load(sessionWorld)
  return new SessionManager(remote as unknown as SessionRemotes)
}

describe('SessionManager.delete', () => {
  it('drops every removed row from the list on success', async ({ mock, remote }) => {
    remote.session.delete.mockResolvedValue(ok({ sessionIds: [S2, S1] }))
    const manager = makeManager(mock, remote)
    manager.handleSessionAdded(summary(S1))
    manager.handleSessionAdded(summary(S2, { parentSessionId: S1 }))
    const result = await manager.delete({ sessionId: S1, cascade: true })
    expect(result).toEqual({ ok: true, value: { sessionIds: [S2, S1] } })
    expect(remote.session.delete).toHaveBeenCalledWith({ sessionId: S1, cascade: true })
    expect(manager.getListSnapshot().items).toEqual([])
  })

  it('drops a deleted sub-agent row too, which a live sub-agent ending would only mark idle', async ({ mock, remote }) => {
    remote.session.delete.mockResolvedValue(ok({ sessionIds: [S2, S1] }))
    const manager = makeManager(mock, remote)
    manager.handleSessionAdded(summary(S1))
    manager.handleSessionAdded(summary(S2, { parentSessionId: S1, origin: 'subagent' }))
    await manager.delete({ sessionId: S1 })
    expect(manager.getListSnapshot().items).toEqual([])
  })

  it('keeps the rows when the host refuses', async ({ mock, remote }) => {
    const refusal = new RemoteError('session/live', 'running a turn', { sessionId: S1 })
    remote.session.delete.mockResolvedValue(err(refusal))
    const manager = makeManager(mock, remote)
    manager.handleSessionAdded(summary(S1))
    const result = await manager.delete({ sessionId: S1 })
    expect(result).toMatchObject({ ok: false, error: { code: 'session/live' } })
    expect(manager.getListSnapshot().items).toHaveLength(1)
  })
})
