// Only a structured checkpoint uses the compaction marker; all other outcomes
// retain the command's complete settlement text.

import { useMemo } from 'react'
import type { ChatViewSlotProps, CommandRowOwnerProps } from '../contract/slots.ts'
import { CompactionItem } from './CompactionItem.tsx'
import { GenericCommandCard } from './GenericCommandCard.tsx'
import css from './CompactionCommandCard.module.css'

interface CompactionCommandCardProps extends CommandRowOwnerProps {
  t: ChatViewSlotProps['t']
  /** Cancel the Session's active work; absent leaves the running row without Stop. */
  stop?: (() => void) | undefined
}

/** Render one manual compaction lifecycle without duplicating its checkpoint marker. */
export function CompactionCommandCard({ node, compaction, stop, t }: CompactionCommandCardProps) {
  const stopControl = useMemo(() => stop === undefined ? undefined : (
    <button type="button" className={css.stop} onClick={stop}>
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
        <rect x="3" y="3" width="10" height="10" rx="3" fill="currentColor" />
      </svg>
      {t('message.compaction.stop')}
    </button>
  ), [stop, t])
  if (compaction !== undefined) {
    return (
      <CompactionItem
        node={compaction}
        title={t('message.compaction.commandTitle')}
        fallbackSummary={node.outcome?.text ?? null}
        t={t}
      />
    )
  }
  if (node.outcome !== null) return <GenericCommandCard node={node} t={t} />
  return (
    <GenericCommandCard
      node={node}
      t={t}
      runningSummary={t('message.compaction.running')}
      headerAccessory={stopControl}
    />
  )
}
