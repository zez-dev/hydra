/** Remote creation binds a task to the Session it names and returns input failures as values. */
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { agentFor, harness } from './harness.ts'

const tests: Awaited<ReturnType<typeof harness>>[] = []
const sessionId = SessionId('remote-owner')
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-16T00:00:00.000Z')) })
afterEach(async () => {
  await Promise.all(tests.splice(0).map(test => test.ctx.fiber.dispose()))
  vi.useRealTimers()
})
async function setup() { const test = await harness(); tests.push(test); return test }

it('stores the task under the requested Session and announces the change', async () => {
  const { service, ctx } = await setup()
  const changed = vi.fn()
  ctx.on('schedule/changed', changed)

  const record = await service.remoteExportCreate({
    sessionId, prompt: 'Summarize the open pull requests', title: 'Summarize the open pull requests', after_seconds: 18_000,
  })

  expect(record).toMatchObject({
    kind: 'after', title: 'Summarize the open pull requests', prompt: 'Summarize the open pull requests',
    afterSeconds: 18_000, scheduledAt: '2026-09-16T05:00:00.000Z',
  })
  expect(await service.catalog()).toEqual([{ ...record, sessionId, status: 'active' }])
  expect(changed).toHaveBeenCalledOnce()
})

it('resolves a local date and time in the zone the request names', async () => {
  const { service } = await setup()

  const record = await service.remoteExportCreate({
    sessionId, prompt: 'Draft the weekly report', title: 'Draft the weekly report',
    at: { date: '2026-09-17', time: '09:30:00', time_zone: 'America/New_York' },
  })

  expect(record).toMatchObject({ kind: 'at', scheduledAt: '2026-09-17T13:30:00.000Z' })
})

it('returns input failures as values and stores nothing', async () => {
  const { service, ctx } = await setup()
  const child = agentFor(ctx, 'remote-child', { origin: 'subagent', delegationDepth: 1 })
  await ctx.agents.register(child)
  const changed = vi.fn()
  ctx.on('schedule/changed', changed)

  expect(await service.remoteExportCreate({ sessionId, prompt: 'Late', title: 'Late', at: '2026-09-15T00:00:00Z' }))
    .toEqual({ code: 'not_future', message: 'The scheduled time must be strictly in the future.' })
  expect(await service.remoteExportCreate({ sessionId, prompt: 'Untitled', title: ' ', after_seconds: 60 }))
    .toMatchObject({ code: 'invalid_prompt' })
  expect(await service.remoteExportCreate({
    sessionId, prompt: 'Skipped hour', title: 'Skipped hour',
    at: { date: '2027-03-14', time: '02:30:00', time_zone: 'America/New_York' },
  })).toEqual({ code: 'invalid_rule', message: 'The local at time does not exist in the selected time zone.' })
  expect(await service.remoteExportCreate({
    sessionId: child.session.id, prompt: 'Child', title: 'Child', after_seconds: 60,
  })).toMatchObject({ code: 'subagent_session' })

  expect(await service.catalog()).toEqual([])
  expect(changed).not.toHaveBeenCalled()
})

it('rejects a storage failure instead of returning it as an input error', async () => {
  const { service, pool } = await setup()
  pool.failNextWrites = 1

  await expect(service.remoteExportCreate({ sessionId, prompt: 'Keep', title: 'Keep', after_seconds: 60 }))
    .rejects.toThrow('injected write failure')
  expect(await service.catalog()).toEqual([])
})
