import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { SessionAlreadyOwnedError } from '@deepseek-ai/dsh-session-persistence'
import { createSessionTestRemote, testSessionPersistence } from './test-remote.ts'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'

const sid = (id: string): SessionId => id as SessionId

function header(id: string, extra: Partial<SessionHeader> = {}): SessionHeader {
  return { version: SESSION_FORMAT_VERSION, id: sid(id), createdAt: 100, isSeeded: false, cwd: '/proj', ...extra }
}

interface Harness {
  ctx: Context
  remote: ReturnType<typeof createSessionTestRemote>
  deleted: SessionId[]
  detached: SessionId[]
  unarchived: SessionId[]
  forgotten: SessionId[]
  removed: SessionId[]
  /** Add a persisted header after setup, for a live session whose header must match exactly. */
  persist: (meta: SessionHeader) => void
}

interface HarnessOptions {
  /** Sessions whose stored log another writer holds. */
  owned?: SessionId[]
  /** Sessions whose stored log fails to delete for another reason. */
  undeletable?: SessionId[]
  /** A failure every listing of stored sessions reports. */
  listFailure?: Error
  workspaceSessions?: SessionId[]
}

async function harness(metas: SessionHeader[], options: HarnessOptions = {}): Promise<Harness> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  const remaining = new Map(metas.map(meta => [meta.id, meta]))
  const deleted: SessionId[] = []
  const detached: SessionId[] = []
  const unarchived: SessionId[] = []
  const forgotten: SessionId[] = []
  const removed: SessionId[] = []
  ctx.provide('sessionPersistence', testSessionPersistence(ctx, {
    list: () => options.listFailure === undefined
      ? Promise.resolve([...remaining.values()])
      : Promise.reject(options.listFailure),
    inspect: (id: SessionId) => Promise.resolve(remaining.has(id) ? { meta: remaining.get(id)!, events: [] } : undefined),
    delete: (id: SessionId) => {
      if (options.owned?.includes(id)) return Promise.reject(new SessionAlreadyOwnedError(id))
      if (options.undeletable?.includes(id)) return Promise.reject(new Error('read-only file system'))
      deleted.push(id)
      return Promise.resolve({ deleted: remaining.delete(id) })
    },
  }) as never)
  ctx.provide('sessionProjectionCache', {
    cachedSnapshot: () => undefined,
    cachedPredecessorTitle: () => undefined,
    forget: (id: SessionId) => { forgotten.push(id); return Promise.resolve() },
  } as never)
  const workspaceSessions = new Set(options.workspaceSessions ?? [])
  ctx.provide('workspaceRegistry', {
    list: () => [{
      id: 'ws-1',
      get sessionIds() { return [...workspaceSessions] },
      detachSession: (id: SessionId) => { workspaceSessions.delete(id); detached.push(id); return Promise.resolve() },
    }],
    unarchiveSession: (id: SessionId) => { unarchived.push(id); return Promise.resolve() },
  } as never)
  ctx.on('api-session/removed', (id) => { removed.push(id) })
  const remote = createSessionTestRemote(ctx, {
    defaultModelSelection: () => ({ provider: 'p', model: 'm' }),
    cwd: '/tmp',
  })
  return { ctx, remote, deleted, detached, unarchived, forgotten, removed, persist: (meta) => { remaining.set(meta.id, meta) } }
}

describe('session.delete', () => {
  it('removes a cold session from persistence, caches, the workspace, and the client list', async () => {
    const h = await harness([header('gone')], { workspaceSessions: [sid('gone')] })
    const result = await h.remote.delete({ sessionId: sid('gone') })
    expect(result).toEqual({ ok: true, value: { sessionIds: [sid('gone')] } })
    expect(h.deleted).toEqual([sid('gone')])
    expect(h.forgotten).toEqual([sid('gone')])
    expect(h.detached).toEqual([sid('gone')])
    expect(h.unarchived).toEqual([sid('gone')])
    expect(h.removed).toEqual([sid('gone')])
  })

  it('refuses a live session opened by another owner and leaves everything in place', async () => {
    // Registered directly, so this controller never held its disposal handle.
    const h = await harness([header('live')])
    const session = h.ctx.sessions.create(sid('live'), { meta: { cwd: '/proj' } })
    const agent = { id: session.id, session, status: 'idle', ctx: h.ctx.plugin(() => {}).ctx } as unknown as Agent
    await h.ctx.agents.register(agent)
    const result = await h.remote.delete({ sessionId: sid('live') })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error.code).toBe('session/live')
    expect(result.error.message).toMatch(/another owner/)
    expect(h.deleted).toEqual([])
    expect(h.ctx.agents.get(sid('live'))).toBe(agent)
  })

  it('releases an idle sub-agent child through its live parent, then deletes it', async () => {
    const h = await harness([])
    const parentSession = h.ctx.sessions.create(sid('parent'), { meta: { cwd: '/proj' } })
    const parent = { id: parentSession.id, session: parentSession, status: 'idle', ctx: h.ctx.plugin(() => {}).ctx } as unknown as Agent
    await h.ctx.agents.register(parent)
    const childSession = h.ctx.sessions.create(sid('child'), { meta: { cwd: '/proj', parentSession: sid('parent'), origin: 'subagent' } })
    h.persist(childSession.header)
    const child = { id: childSession.id, session: childSession, status: 'idle', ctx: h.ctx.plugin(() => {}).ctx } as unknown as Agent
    const detach = h.ctx.agents.enter(child, parent)
    const drained: [SessionId, readonly SessionId[]][] = []
    h.ctx.provide('subagents', {
      drainContinuableChildren: (owner: Agent, ids: readonly SessionId[]) => {
        drained.push([owner.id, ids])
        detach()
        return Promise.resolve()
      },
    } as never)
    const result = await h.remote.delete({ sessionId: sid('child') })
    expect(result).toMatchObject({ ok: true })
    expect(drained).toEqual([[sid('parent'), [sid('child')]]])
    expect(h.deleted).toEqual([sid('child')])
    expect(h.ctx.agents.get(sid('child'))).toBeUndefined()
  })

  it('names the parent when a sub-agent child cannot be released', async () => {
    const h = await harness([])
    const parentSession = h.ctx.sessions.create(sid('parent2'), { meta: { cwd: '/proj' } })
    const parent = { id: parentSession.id, session: parentSession, status: 'idle', ctx: h.ctx.plugin(() => {}).ctx } as unknown as Agent
    await h.ctx.agents.register(parent)
    const childSession = h.ctx.sessions.create(sid('child2'), { meta: { cwd: '/proj', parentSession: sid('parent2'), origin: 'subagent' } })
    h.persist(childSession.header)
    const child = { id: childSession.id, session: childSession, status: 'idle', ctx: h.ctx.plugin(() => {}).ctx } as unknown as Agent
    h.ctx.agents.enter(child, parent)
    // No sub-agent service composed: nothing can release the child.
    const result = await h.remote.delete({ sessionId: sid('child2') })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error.code).toBe('session/live')
    expect(result.error.message).toMatch(/sub-agent of session "parent2"/)
    expect(h.deleted).toEqual([])
  })

  it('refuses a live sub-agent child whose parent session is not live, naming the parent', async () => {
    const h = await harness([])
    const childSession = h.ctx.sessions.create(sid('orphan'), { meta: { cwd: '/proj', parentSession: sid('closed-parent'), origin: 'subagent' } })
    h.persist(childSession.header)
    const child = { id: childSession.id, session: childSession, status: 'idle', ctx: h.ctx.plugin(() => {}).ctx } as unknown as Agent
    await h.ctx.agents.register(child)
    const result = await h.remote.delete({ sessionId: sid('orphan') })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error.code).toBe('session/live')
    expect(result.error.message).toMatch(/sub-agent of session "closed-parent"/)
    expect(h.deleted).toEqual([])
    expect(h.ctx.agents.get(sid('orphan'))).toBe(child)
  })

  it('refuses a session whose turn is running, before anything is closed', async () => {
    const h = await harness([header('busy')])
    const session = h.ctx.sessions.create(sid('busy'), { meta: { cwd: '/proj' } })
    const agent = { id: session.id, session, status: 'running', ctx: h.ctx.plugin(() => {}).ctx } as unknown as Agent
    await h.ctx.agents.register(agent)
    const result = await h.remote.delete({ sessionId: sid('busy') })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error.code).toBe('session/live')
    expect(result.error.message).toMatch(/running a turn/)
    expect(h.deleted).toEqual([])
  })

  it('reports an unknown session', async () => {
    const h = await harness([])
    const result = await h.remote.delete({ sessionId: sid('nope') })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error.code).toBe('session/not-found')
  })

  it('maps a persistence ownership refusal to session/owned', async () => {
    const h = await harness([header('leased')], { owned: [sid('leased')] })
    const result = await h.remote.delete({ sessionId: sid('leased') })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error.code).toBe('session/owned')
    expect(h.removed).toEqual([])
  })

  it('reports any other persistence failure as internal and announces no removal', async () => {
    const h = await harness([header('stuck')], { undeletable: [sid('stuck')] })
    const result = await h.remote.delete({ sessionId: sid('stuck') })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error.code).toBe('gateway/internal')
    expect(result.error.message).toMatch(/failed to delete session "stuck": Error: read-only file system/)
    expect(h.forgotten).toEqual([])
    expect(h.removed).toEqual([])
  })

  it('reports a failed lineage lookup as internal before deleting anything', async () => {
    const h = await harness([header('unlisted')], { listFailure: new Error('session directory unreadable') })
    const result = await h.remote.delete({ sessionId: sid('unlisted') })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error.code).toBe('gateway/internal')
    expect(result.error.message).toMatch(/session directory unreadable/)
    expect(h.deleted).toEqual([])
    expect(h.removed).toEqual([])
  })

  it('deletes the sub-agent sessions a session started with it and keeps its forks; cascade deletes every descendant', async () => {
    const metas = [
      header('root'),
      header('fork', { parentSession: sid('root'), isSeeded: true }),
      header('fork-of-fork', { parentSession: sid('fork'), isSeeded: true }),
      header('fork-subagent', { parentSession: sid('fork'), origin: 'subagent', delegationDepth: 1 }),
      header('subagent', { parentSession: sid('root'), origin: 'subagent', delegationDepth: 1 }),
      header('nested-subagent', { parentSession: sid('subagent'), origin: 'subagent', delegationDepth: 2 }),
      header('fork-of-subagent', { parentSession: sid('subagent'), isSeeded: true }),
    ]
    const kept = await harness(metas)
    const deleted = await kept.remote.delete({ sessionId: sid('root') })
    expect(deleted).toEqual({ ok: true, value: { sessionIds: [sid('nested-subagent'), sid('subagent'), sid('root')] } })
    expect(kept.deleted).toEqual([sid('nested-subagent'), sid('subagent'), sid('root')])
    expect(kept.removed).toEqual([sid('nested-subagent'), sid('subagent'), sid('root')])

    const all = await harness(metas)
    const cascaded = await all.remote.delete({ sessionId: sid('root'), cascade: true })
    const everything = [sid('fork-of-fork'), sid('fork-subagent'), sid('fork'), sid('fork-of-subagent'), sid('nested-subagent'), sid('subagent'), sid('root')]
    expect(cascaded).toEqual({ ok: true, value: { sessionIds: everything } })
    expect(all.removed).toEqual(everything)
  })
})

describe('session.delete on a session this Host opened', () => {
  const scratch: string[] = []
  afterEach(async () => {
    for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true })
  })

  /**
   * The production loop and the real JSONL backend behind the controller, so
   * create() yields a real Agent whose handle the controller keeps and delete()
   * removes a real stored log.
   */
  async function liveHarness(): Promise<{ ctx: Context; remote: ReturnType<typeof createSessionTestRemote>; cwd: string }> {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-delete-live-'))
    scratch.push(cwd)
    await ctx.plugin(JsonlSessionPersistence, { root: join(cwd, 'sessions'), compression: 'none' })
    await mountAgentLoopTestHarness(ctx)
    ctx.provide('sessionProjectionCache', {
      cachedSnapshot: () => undefined,
      cachedPredecessorTitle: () => undefined,
      forget: () => Promise.resolve(),
    } as never)
    ctx.provide('workspaceRegistry', {
      list: () => [],
      unarchiveSession: () => Promise.resolve(),
    } as never)
    const remote = createSessionTestRemote(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd })
    return { ctx, remote, cwd }
  }

  async function storedIds(ctx: Context): Promise<SessionId[]> {
    const persistence = ctx.get('sessionPersistence') as { list(): Promise<readonly { header: { id: SessionId } }[]> }
    return (await persistence.list()).map(entry => entry.header.id)
  }

  it('closes an idle session it opened whose log was written, then deletes the log', async () => {
    const h = await liveHarness()
    const created = await h.remote.create({ cwd: h.cwd })
    if (!created.ok) throw new Error(`create failed: ${created.error.code}: ${created.error.message}`)
    const id = created.value.sessionId
    const agent = h.ctx.agents.get(id)
    if (agent === undefined) throw new Error('expected a live Agent after create')
    // The first append materializes the log and takes the write lease; delete
    // must therefore also prove the closed Agent released that lease.
    agent.session.append('turn/start', { turn: 1 })
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(await storedIds(h.ctx)).toContain(id)

    const result = await h.remote.delete({ sessionId: id })
    if (!result.ok) throw new Error(`delete failed: ${result.error.code}: ${result.error.message}`)
    expect(result.value).toEqual({ sessionIds: [id] })
    expect(h.ctx.agents.get(id)).toBeUndefined()
    expect(await storedIds(h.ctx)).not.toContain(id)
  })

  it('treats a closed session that never wrote a log as removed rather than missing', async () => {
    const h = await liveHarness()
    const created = await h.remote.create({ cwd: h.cwd })
    if (!created.ok) throw new Error(`create failed: ${created.error.code}: ${created.error.message}`)
    const id = created.value.sessionId

    const result = await h.remote.delete({ sessionId: id })
    if (!result.ok) throw new Error(`delete failed: ${result.error.code}: ${result.error.message}`)
    expect(result.value).toEqual({ sessionIds: [id] })
    expect(h.ctx.agents.get(id)).toBeUndefined()
    // Whatever the backend materialized for a session that never wrote an
    // event, none of it may survive the delete.
    expect(await storedIds(h.ctx)).not.toContain(id)
  })
})
