/** Learning tab in Web Settings: list, edit, and delete learned memory and the skills written from it. */

import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { LearningSettingsTab, type LearningSettingsTabInjected } from './LearningSettingsTab.tsx'
import { en, zh, type LearningLocaleKey } from './locales.ts'

export type { LearningSettingsTabInjected, LearningSettingsTabProps } from './LearningSettingsTab.tsx'
export type { LearningLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Learning tab copy. */
    'settings.learning': LearningLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.learning'

/** Services required by the Settings registration and generated Remote face. */
export const inject = ['slots', 'locale', 'remote', 'remote.learning']

/** Unwrap one Remote result, throwing the Host business error. */
function unwrap<T>(name: string, result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T {
  if (!result.ok) throw new Error(`learning.${name} failed: ${result.error.code}: ${result.error.message}`)
  return result.value
}

/** Contribute the lazy learning tab to the Plugins settings section. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-learning: dictionaries')

  const t = ctx.locale.bind(NS)
  const injected = (): LearningSettingsTabInjected => ({
    list: async () => unwrap('list', await ctx.remote.learning.list()),
    review: async (id, decision) => { unwrap('review', await ctx.remote.learning.review({ id, decision })) },
    forget: async (id) => { unwrap('forget', await ctx.remote.learning.forget({ id })) },
    update: async (id, text, tags) => { unwrap('update', await ctx.remote.learning.update({ id, text, ...tags === undefined ? {} : { tags } })) },
    skills: async () => unwrap('skills', await ctx.remote.learning.skills()).skills,
    readSkill: async name => unwrap('readSkill', await ctx.remote.learning.readSkill({ name })).content,
    writeSkill: async (name, content) => { unwrap('writeSkill', await ctx.remote.learning.writeSkill({ name, content })) },
    deleteSkill: async (name) => { unwrap('deleteSkill', await ctx.remote.learning.deleteSkill({ name })) },
    promote: async (id, name) => { unwrap('promote', await ctx.remote.learning.promote({ id, name })) },
    curate: async () => unwrap('curate', await ctx.remote.learning.curate()),
    suggestions: async () => unwrap('suggestions', await ctx.remote.learning.suggestions()).suggestions,
    acceptSuggestion: async (id, name) => unwrap('acceptSuggestion', await ctx.remote.learning.acceptSuggestion({ id, name })),
    dismissSuggestion: async (id) => { unwrap('dismissSuggestion', await ctx.remote.learning.dismissSuggestion({ id })) },
  })

  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'learning',
    order: 20,
    label: () => t('tab'),
    locale: NS,
    inject: injected,
  }, LearningSettingsTab))
}
