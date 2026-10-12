/** The usage type's chip title: the dashboard glyph before the tab's label. */
import type { ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { UsageGlyph } from './definition.tsx'
import css from './UsageBody.module.css'

/**
 * The title as the chip and a floating panel's header show it.
 * @param props - the tab information hook.
 * @returns the glyph followed by the tab's title text.
 */
export function UsageTitle({ useTabInfo }: PropsRuntime<'sidebar.right.pane.tab.title'>): ReactNode {
  const { tab } = useTabInfo()
  return (
    <>
      <UsageGlyph size={16} className={css.titleIcon} />
      {tab.title}
    </>
  )
}
