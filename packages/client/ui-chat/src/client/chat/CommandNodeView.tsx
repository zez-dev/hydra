import { memo, useMemo } from 'react'
import type { InjectFace, PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  ChatNodeViewProps, CommandRowOwnerProps, CompactionStopInjected,
} from '../contract/slots.ts'
import { CompactionCommandCard } from './CompactionCommandCard.tsx'
import { GenericCommandCard } from './GenericCommandCard.tsx'
import css from './ChatView.module.css'

type CommandNodeViewProps = ChatNodeViewProps<'command'> & PropsRenderSlots<'conversation.chat.commandview'>

/** Ordinary command lifecycle renderer with command-name keyed specialization. */
export const CommandNodeView = memo(function CommandNodeView({ node, renderSlot, t }: CommandNodeViewProps) {
  const command = node.data
  const owner = useMemo<CommandRowOwnerProps>(() => ({ node: command }), [command])
  return (
    <div className={css.callRow}>
      {renderSlot('conversation.chat.commandview', owner, {
        entryKey: command.name ?? '',
        fallback: <GenericCommandCard {...owner} t={t} />,
      })}
    </div>
  )
})

type ManualCompactionNodeViewProps = Pick<ChatNodeViewProps<'manual-compaction'>, 'node' | 't' | 'useAccess'>
  & InjectFace<CompactionStopInjected>

/**
 * One integrated `/compact` command and compaction transaction renderer. The
 * running row offers Stop unless this page may not cancel the Session, as
 * the composer withholds its Stop.
 */
export const ManualCompactionNodeView = memo(function ManualCompactionNodeView({
  node, stop, useAccess, t,
}: ManualCompactionNodeViewProps) {
  const data = node.data
  const cancelAllowed = useAccess('session/cancel')
  return (
    <div className={css.callRow}>
      <CompactionCommandCard
        node={data.command}
        {...data.compaction === null ? {} : { compaction: data.compaction }}
        {...cancelAllowed ? { stop } : {}}
        t={t}
      />
    </div>
  )
})
