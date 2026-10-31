import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SidebarRightTabRegistry } from '@deepseek-ai/dsh-client-ui-sidebar-right/src/client/tab-registry.ts'
import { USAGE_ID, USAGE_KIND } from '../src/client/definition.tsx'
import { apply, inject, NS } from '../src/client/index.ts'
import { apply as hostApply } from '../src/index.ts'
import { UsageBody } from '../src/client/UsageBody.tsx'
import { UsageTitle } from '../src/client/UsageTitle.tsx'
import { de, en, es, fr, ja, pt, ru, zh } from '../src/client/locales.ts'

interface Recorded {
  name: string
  key: string
  locale: string
  inject: unknown
  component: unknown
}

async function boot() {
  const ctx = new Context()
  const tabs = new SidebarRightTabRegistry(ctx)
  const registered: Recorded[] = []
  const slots = {
    inject: vi.fn((_name: string, register: () => () => void) => register()),
    register: vi.fn((options: Omit<Recorded, 'component'>, component: unknown) => {
      const entry: Recorded = { ...options, component }
      registered.push(entry)
      return () => { registered.splice(registered.indexOf(entry), 1) }
    }),
  }
  const dictionaries = new Map<string, unknown>()
  const locale = {
    bind: vi.fn(() => (key: string) => key),
    register: vi.fn((ns: string, dicts: unknown) => {
      dictionaries.set(ns, dicts)
      return () => { dictionaries.delete(ns) }
    }),
  }
  const usage = { report: vi.fn() }
  ctx.provide('sidebarRightTabs', tabs as never)
  ctx.provide('slots', slots as never)
  ctx.provide('locale', locale as never)
  ctx.provide('remote', { usage, $stream: vi.fn() } as never)
  ctx.provide('remote.usage', usage as never)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return { tabs, registered, dictionaries, fiber }
}

describe('ui-usage apply', () => {
  it('keeps the host Loader entry inert', () => {
    expect(hostApply).not.toThrow()
  })

  it('declares the tab registry, slots, copy, and the usage Remote', () => {
    expect(inject).toEqual(['slots', 'locale', 'sidebarRightTabs', 'remote', 'remote.usage'])
  })

  it('registers the type, its dictionaries, and the body and title seats under the type\'s id', async () => {
    const { tabs, registered, dictionaries } = await boot()
    const definition = tabs.get(USAGE_KIND)
    expect(definition?.id).toBe(USAGE_ID)
    expect(definition?.priority).toBe('builtin')
    expect(dictionaries.get(NS)).toEqual({ zh, en, ja, es, fr, de, ru, pt })
    expect(registered.map(entry => [entry.name, entry.key, entry.locale, entry.component])).toEqual([
      ['sidebar.right.pane.tab', USAGE_ID, NS, UsageBody],
      ['sidebar.right.pane.tab.title', USAGE_ID, undefined, UsageTitle],
    ])
    const face = registered[0]?.inject as (() => Record<string, unknown>) | undefined
    expect(Object.keys(face?.() ?? {})).toEqual(['report'])
  })

  it('removes every registration when the plugin unloads', async () => {
    const { tabs, registered, dictionaries, fiber } = await boot()
    await fiber.dispose()
    expect(tabs.get(USAGE_KIND)).toBeUndefined()
    expect(registered).toEqual([])
    expect(dictionaries.size).toBe(0)
  })
})

describe('the dictionaries', () => {
  it('translate the same keys in both languages', () => {
    expect(Object.keys(en)).toEqual(Object.keys(zh))
  })
})
