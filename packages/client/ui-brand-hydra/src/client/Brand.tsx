import { HydraLogo } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HeroBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SidebarBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import type { BrandHydraKey } from './locales.ts'

/** The mark is drawn in the brand primary (red) in both appearances, not in the text color. */
const MARK_STYLE = { color: 'var(--dsw-alias-brand-primary)' } as const

/**
 * Render the Hydra mark at the size the sidebar requests.
 * @param props - Host-supplied mark presentation.
 * @returns the Hydra mark.
 */
export function HydraBrandMark({ size }: SidebarBrandMarkOwnerProps) {
  return <span style={MARK_STYLE}><HydraLogo size={size} /></span>
}

/**
 * Render the Hydra mark before the blank-session headline.
 * @param props - Host-supplied mark presentation and geometry class.
 * @returns the Hydra mark.
 */
export function HydraHeroMark({ size, className }: HeroBrandMarkOwnerProps) {
  return <span style={MARK_STYLE}><HydraLogo size={size} className={className} /></span>
}

/**
 * Render the product name beside the expanded mark.
 * @param props - The locale-bound translator for this plugin's dictionary.
 * @returns the Hydra wordmark.
 */
export function HydraBrandName({ t }: { t: TranslateNS<'brand-hydra'> }) {
  return <span style={{ fontWeight: 600, letterSpacing: '0.04em' }}>{t('name' satisfies BrandHydraKey)}</span>
}
