/** Hydra occupants for the browser-brand slots: sidebar mark, sidebar name, and the blank-session hero mark. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { HydraBrandMark, HydraBrandName, HydraHeroMark } from './Brand.tsx'
import { en, zh, type BrandHydraKey } from './locales.ts'

export type { BrandHydraKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The Hydra brand copy. */
    'brand-hydra': BrandHydraKey
  }
}

/** Dictionary namespace this plugin registers. */
const NS = 'brand-hydra'

/** Required services: the UI slot registry and the locale registry. */
export const inject = ['slots', 'locale']

/**
 * Register the Hydra dictionary and fill the three brand slots. The sidebar
 * slots are declared by `ui-sidebar` and the hero slot by `ui-conversation`;
 * each registration waits for its hole through `slots.inject`.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-brand-hydra: dictionaries')
  ctx.slots.inject('sidebar.brand.mark', () =>
    ctx.slots.inject('sidebar.brand.name', function* () {
      yield ctx.slots.register({ name: 'sidebar.brand.mark' }, HydraBrandMark)
      yield ctx.slots.register({ name: 'sidebar.brand.name', locale: NS }, HydraBrandName)
    }))
  ctx.slots.inject('conversation.hero.brand.mark', () =>
    ctx.slots.register({ name: 'conversation.hero.brand.mark' }, HydraHeroMark))
}
