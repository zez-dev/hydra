// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { apply, inject } from '../src/client/index.ts'
import { HydraBrandMark, HydraBrandName, HydraHeroMark } from '../src/client/Brand.tsx'
import { apply as hostApply } from '../src/index.ts'
import { de, en, es, fr, ja, pt, ru, zh, type BrandHydraKey } from '../src/client/locales.ts'

afterEach(() => { cleanup() })

const HOLES = ['sidebar.brand.mark', 'sidebar.brand.name', 'conversation.hero.brand.mark'] as const

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const slots = ctx.get('slots') as SlotRegistry
  const registered = new Map<string, { zh: Record<string, string>; en: Record<string, string> }>()
  ctx.provide('locale', {
    register(ns: string, dicts: { zh: Record<string, string>; en: Record<string, string> }) {
      registered.set(ns, dicts)
      return () => { registered.delete(ns) }
    },
  } as never)
  const disposeHoles = slots.register({
    name: 'root',
    children: Object.fromEntries(HOLES.map(name => [name, { kind: 'single', scope: 'root' }])),
  } as never, () => null)
  return { ctx, slots, registered, disposeHoles }
}

describe('Hydra browser-brand plugin', () => {
  it('keeps the host Loader entry inert', () => {
    expect(hostApply).not.toThrow()
  })

  it('declares the slot and locale services it uses', () => {
    expect(inject).toEqual(['slots', 'locale'])
  })

  it('ships complete zh and en dictionaries', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
    expect(en.name).toBe('Hydra')
  })

  it('keeps the product name untranslated in every other shipped language', () => {
    for (const dictionary of [ja, es, fr, de, ru, pt]) expect(dictionary).toEqual(en)
  })

  it('fills all three brand slots once their holes are declared and removes them on teardown', async () => {
    const { ctx, slots, registered, disposeHoles } = await bench()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(Object.keys(registered.get('brand-hydra') ?? {})).toEqual(['zh', 'en', 'ja', 'es', 'fr', 'de', 'ru', 'pt'])
    for (const hole of HOLES) expect(slots.entries(hole)).toHaveLength(1)
    disposeHoles()
    for (const hole of HOLES) expect(slots.entries(hole)).toHaveLength(0)
    await fiber.dispose()
    expect(registered.get('brand-hydra')).toBeUndefined()
  })

  it('renders the mark at the requested size and the name from the dictionary', () => {
    const mark = render(<HydraBrandMark size={24} />)
    expect(mark.container.querySelector('svg')?.getAttribute('width')).toBe('24')
    const hero = render(<HydraHeroMark size={40} className="hero" />)
    expect(hero.container.querySelector('svg.hero')).not.toBeNull()
    const name = render(<HydraBrandName t={((key: BrandHydraKey) => en[key]) as never} />)
    expect(name.getByText('Hydra')).toBeTruthy()
  })

  it('marks the two pupils so the hero can light the eyes', () => {
    const hero = render(<HydraHeroMark size={56} className="hero" />)
    expect(hero.container.querySelectorAll('svg.hero [data-part="pupil"]')).toHaveLength(2)
  })
})
