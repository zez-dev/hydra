/**
 * Stage one of this package's registration: what the `usage` tab type IS. A
 * page type that claims no address; the guide page offers it as an entry.
 */
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import type {} from './locales.ts'
import type { IconProps } from '@deepseek-ai/dsh-client-ui-primitives'

/** The tab kind this package owns. */
export const USAGE_KIND = 'usage'

/** This implementation's identity in the tab system, and the key its body registers under. */
export const USAGE_ID = '@deepseek-ai/dsh-client-ui-usage'

/**
 * The dashboard glyph: four calendar squares rising in height, drawn in the current color.
 * @param props - requested square edge and host class.
 * @returns the SVG glyph.
 */
export function UsageGlyph({ size = 16, className }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
      <rect x="1.75" y="9.25" width="2.5" height="4" rx="0.6" />
      <rect x="5.75" y="6.75" width="2.5" height="6.5" rx="0.6" />
      <rect x="9.75" y="2.75" width="2.5" height="10.5" rx="0.6" />
      <path d="M1.75 2.75h4" strokeLinecap="round" />
    </svg>
  )
}

/**
 * The usage type's registry definition.
 * @param t - namespace-bound translate, read fresh on every label call.
 * @returns the definition to register.
 */
export function usageDefinition(t: TranslateNS<'sidebarUsage'>): SidebarRightTabDefinition {
  return {
    id: USAGE_ID,
    kind: USAGE_KIND,
    priority: 'builtin',
    title: () => t('type.label'),
    guide: [{
      id: 'usage',
      order: 40,
      title: () => t('guide.title'),
      description: () => t('guide.description'),
      icon: UsageGlyph,
    }],
  }
}
