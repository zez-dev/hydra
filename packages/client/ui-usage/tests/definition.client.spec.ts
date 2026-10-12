// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { cleanup, render } from '@testing-library/react'
import { Context } from '@deepseek-ai/cordis'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { SidebarRightTabRegistry } from '@deepseek-ai/dsh-client-ui-sidebar-right/src/client/tab-registry.ts'
import { USAGE_ID, USAGE_KIND, usageDefinition } from '../src/client/definition.tsx'
import { zh } from '../src/client/locales.ts'

const t = makeTranslate(zh)

afterEach(cleanup)

describe('usageDefinition', () => {
  it('registers under its kind and id as a page that claims no address', () => {
    const registry = new SidebarRightTabRegistry(new Context())
    registry.register(usageDefinition(t))
    expect(registry.get(USAGE_KIND)?.id).toBe(USAGE_ID)
    expect(registry.get(USAGE_KIND)?.title('usage')).toBe(zh['type.label'])
    expect(registry.candidates('dsh-resource://file/session/s-1/work/a.ts')).toEqual([])
    expect(usageDefinition(t).patterns).toBeUndefined()
  })

  it('offers the guide page one entry at order 40 with a drawn icon', () => {
    const registry = new SidebarRightTabRegistry(new Context())
    registry.register(usageDefinition(t))
    const [entry, ...rest] = registry.guide()
    expect(rest).toEqual([])
    expect(entry?.order).toBe(40)
    expect(entry?.kind).toBe(USAGE_KIND)
    expect(entry?.title()).toBe(zh['guide.title'])
    expect(entry?.description?.()).toBe(zh['guide.description'])
    if (entry?.icon === undefined) throw new Error('expected the guide icon')
    const icon = render(createElement(entry.icon, { size: 26 }))
    expect(icon.container.querySelector('svg')?.getAttribute('width')).toBe('26')
  })
})
