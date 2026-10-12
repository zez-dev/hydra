// @vitest-environment jsdom
import { Context, Service } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { apply, inject, NS } from '../src/client/index.ts'
import { LearningSettingsTab } from '../src/client/LearningSettingsTab.tsx'
import type { LearningSettingsTabInjected } from '../src/client/LearningSettingsTab.tsx'
import { apply as hostApply } from '../src/index.ts'

usePinnedBrowserLanguages('zh-CN')
afterEach(cleanup)

const EMPTY = { candidates: [], recalled: [], curated: [] }
type Ok<T> = { readonly ok: true; readonly value: T }
type Failed = { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  class RemoteService extends Service {
    constructor(serviceCtx: Context) {
      super(serviceCtx, 'remote')
    }
  }
  new RemoteService(ctx)
  const list = vi.fn<() => Promise<Ok<typeof EMPTY> | Failed>>().mockResolvedValue({ ok: true, value: EMPTY })
  const review = vi.fn<() => Promise<Ok<unknown> | Failed>>().mockResolvedValue({ ok: true, value: {} })
  const forget = vi.fn<() => Promise<Ok<unknown> | Failed>>().mockResolvedValue({ ok: true, value: { removed: true } })
  const promote = vi.fn<() => Promise<Ok<unknown> | Failed>>().mockResolvedValue({ ok: false, error: { code: 'INVALID', message: 'bad name' } })
  const curate = vi.fn<() => Promise<Ok<unknown> | Failed>>().mockResolvedValue({ ok: true, value: { stale: 0, archived: 0, merged: 0 } })
  ctx.provide('remote.learning', { list, review, forget, promote, curate })
  return { ctx, slots: ctx.get('slots') as SlotRegistry, locale, list, review, forget, promote, curate }
}

function declare(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: { 'settings.plugins.tab': { kind: 'list', scope: 'root' } },
  } as never, () => null)
}

describe('ui-learning browser plugin', () => {
  it('keeps the host Loader entry inert', () => {
    expect(hostApply).not.toThrow()
  })

  it('declares only the services used by the Settings Remote contribution', () => {
    expect(inject).toEqual(['slots', 'locale', 'remote', 'remote.learning'])
  })

  it('registers a localized tab whose face wraps the learning Remote', async () => {
    const b = await bench()
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()

    const entry = b.slots.entries('settings.plugins.tab')[0]!
    expect(entry.component).toBe(LearningSettingsTab)
    expect(entry.options).toMatchObject({ id: 'learning', order: 20 })
    expect(entry.locale).toBe(NS)
    expect(resolveSlotLabel(entry.options.label)).toBe('学习记忆')
    expect(b.list).not.toHaveBeenCalled()

    const face = (entry.inject as unknown as () => LearningSettingsTabInjected)()
    await expect(face.list()).resolves.toEqual(EMPTY)
    await face.review('c1', 'approve')
    expect(b.review).toHaveBeenCalledWith({ id: 'c1', decision: 'approve' })
    await face.forget('a1')
    expect(b.forget).toHaveBeenCalledWith({ id: 'a1' })
    await expect(face.promote('a1', 'Bad')).rejects.toThrow('learning.promote failed: INVALID: bad name')
    await expect(face.curate()).resolves.toEqual({ stale: 0, archived: 0, merged: 0 })
    expect(b.curate).toHaveBeenCalledTimes(1)
    b.list.mockResolvedValueOnce({ ok: false, error: { code: 'REMOTE_ERROR', message: 'unavailable' } })
    await expect(face.list()).rejects.toThrow('learning.list failed: REMOTE_ERROR: unavailable')
    await b.ctx.fiber.dispose()
  })

  it('follows locale and recovers across late declaration', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(b.slots.entries('settings.plugins.tab')).toHaveLength(0)
    declare(b.slots)
    await vi.waitFor(() => { expect(b.slots.entries('settings.plugins.tab')).toHaveLength(1) })
    b.locale.setLocale('en')
    expect(resolveSlotLabel(b.slots.entries('settings.plugins.tab')[0]!.options.label)).toBe('Learning')
    await b.ctx.fiber.dispose()
  })
})
