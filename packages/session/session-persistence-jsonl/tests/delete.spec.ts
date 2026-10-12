import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import { SessionAlreadyOwnedError } from '@deepseek-ai/dsh-session-persistence'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { sessionDir } from '../src/format.ts'

const dirs: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

function meta(id: string, cwd = '/work'): SessionHeader {
  return { version: SESSION_FORMAT_VERSION, id: SessionId(id), createdAt: 1_000, cwd, isSeeded: false }
}

async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-jsonl-delete-'))
  dirs.push(root)
  return root
}

async function mount(root: string): Promise<SessionPersistence> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  return ctx.sessionPersistence
}

const EVENTS = [
  { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
  { type: 'turn/end', seq: SessionSeq(1), time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
] as const

describe('JsonlSessionPersistence.delete', () => {
  it('removes a closed session directory and its listing entry', async () => {
    const root = await freshRoot()
    const persistence = await mount(root)
    const handle = await persistence.create(meta('gone'))
    await handle.append([...EVENTS])
    await handle.close()
    const dir = sessionDir(root, '/work', SessionId('gone'))
    expect(existsSync(dir)).toBe(true)

    await expect(persistence.delete(SessionId('gone'))).resolves.toEqual({ deleted: true })

    expect(existsSync(dir)).toBe(false)
    expect(await persistence.stat(SessionId('gone'))).toBeUndefined()
    expect((await persistence.list()).map(entry => entry.header.id)).toEqual([])
  })

  it('is idempotent for a session that does not exist', async () => {
    const persistence = await mount(await freshRoot())
    await expect(persistence.delete(SessionId('missing'))).resolves.toEqual({ deleted: false })
  })

  it('refuses while this process holds the write handle', async () => {
    const persistence = await mount(await freshRoot())
    const handle = await persistence.create(meta('busy'))
    await handle.append([...EVENTS])
    await expect(persistence.delete(SessionId('busy'))).rejects.toBeInstanceOf(SessionAlreadyOwnedError)
    await handle.close()
    await expect(persistence.delete(SessionId('busy'))).resolves.toEqual({ deleted: true })
  })

  it('refuses while another instance holds the cross-process lease', async () => {
    const root = await freshRoot()
    const first = await mount(root)
    const second = await mount(root)
    const holder = await first.create(meta('leased'))
    await holder.append([...EVENTS])
    await expect(second.delete(SessionId('leased'))).rejects.toBeInstanceOf(SessionAlreadyOwnedError)
    await holder.close()
    await expect(second.delete(SessionId('leased'))).resolves.toEqual({ deleted: true })
    expect(await first.stat(SessionId('leased'))).toBeUndefined()
  })

  it('refuses a created-but-unmaterialized session still owned by its creator', async () => {
    const persistence = await mount(await freshRoot())
    const handle = await persistence.create(meta('pending'))
    await expect(persistence.delete(SessionId('pending'))).rejects.toBeInstanceOf(SessionAlreadyOwnedError)
    await handle.close()
  })
})
