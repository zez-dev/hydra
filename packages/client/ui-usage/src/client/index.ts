/**
 * Browser half: register `usage` as a right-Sidebar tab type. The type goes
 * into `ctx.sidebarRightTabs`, the dashboard into the keyed `sidebar.right.pane.tab`
 * seat, and the chip title into `sidebar.right.pane.tab.title`, under the type's id.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { USAGE_ID, usageDefinition } from './definition.tsx'
import { usageFace } from './face.ts'
import { UsageBody } from './UsageBody.tsx'
import { UsageTitle } from './UsageTitle.tsx'
import { en, zh, type SidebarUsageKey } from './locales.ts'

export type { SidebarUsageKey } from './locales.ts'
export type { UsageInjected } from './face.ts'
export type { UsageBodyProps } from './UsageBody.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The token-usage dashboard copy. */
    sidebarUsage: SidebarUsageKey
  }
}

/** This package's copy namespace. */
export const NS = 'sidebarUsage'

/** Required browser services: the slot registry, copy, the tab registry, the Remote carrier and its namespace. */
export const inject = ['slots', 'locale', 'sidebarRightTabs', 'remote', 'remote.usage']

/**
 * Client plugin body: register the type, its dictionaries, the dashboard, and the chip title.
 * @param ctx - client root context carrying the registry, the slots, and the Remote face.
 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.sidebarRightTabs.register(usageDefinition(t)), 'ui-usage: usage type')
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-usage: dictionaries')
  const face = usageFace(ctx.remote)
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab', key: USAGE_ID, locale: NS, inject: () => face },
    UsageBody,
  )), 'ui-usage: dashboard body')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab.title', key: USAGE_ID },
    UsageTitle,
  )), 'ui-usage: dashboard title')
}
