// @vitest-environment jsdom
/** Running compaction rows: Stop on a running `/compact`, and the automatic compaction's running row. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'
import { bindSnapshotSelector, makeTranslate, sessionSnapshot } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { CommandNode } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ChatNode } from '../src/client/contract/chat-nodes.ts'
import { ManualCompactionNodeView } from '../src/client/chat/CommandNodeView.tsx'
import { CompactionRunningNodeView } from '../src/client/chat/MessageItem.tsx'
import { en } from '../src/client/locale.ts'

afterEach(cleanup)

const t = makeTranslate(en)
const allowAll = (): boolean => true

function manualCompaction(outcome: CommandNode['outcome']): ChatNode<'manual-compaction'> {
  return {
    key: 'command:cmd-compact',
    kind: 'manual-compaction',
    id: 'cmd-compact',
    target: 'chat',
    anchorSeq: 5,
    location: { kind: 'unresolved' },
    visibility: 'visible',
    data: {
      command: {
        kind: 'command',
        seq: 5,
        time: 5_000,
        commandId: 'cmd-compact' as CommandNode['commandId'],
        name: 'compact',
        args: '',
        outcome,
      },
      compaction: null,
    },
  }
}

describe('running /compact row', () => {
  it('offers Stop beside the running summary and calls the Session stop', () => {
    const stop = vi.fn<() => void>()
    render(<ManualCompactionNodeView node={manualCompaction(null)} stop={stop} useAccess={allowAll} t={t} />)

    expect(screen.getByText('Compacting context…')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    expect(stop).toHaveBeenCalledOnce()
  })

  it('withholds Stop when the page may not cancel the Session', () => {
    render(<ManualCompactionNodeView
      node={manualCompaction(null)}
      stop={vi.fn<() => void>()}
      useAccess={action => action !== 'session/cancel'}
      t={t}
    />)

    expect(screen.getByText('Compacting context…')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull()
  })

  it('drops Stop once the command settles', () => {
    render(<ManualCompactionNodeView
      node={manualCompaction({ kind: 'error', text: 'Compaction cancelled.' })}
      stop={vi.fn<() => void>()}
      useAccess={allowAll}
      t={t}
    />)

    expect(screen.getByText('Compaction cancelled.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull()
  })
})

describe('running automatic compaction row', () => {
  it('shows "Compacting context…" only while the Session runs', () => {
    const session = createSnapshotStore<SessionSnapshot>({
      ...sessionSnapshot('automatic-compaction' as SessionId),
      running: true,
    })
    const view = render(<CompactionRunningNodeView useSession={bindSnapshotSelector(session)} t={t} />)

    expect(view.getByText('Compacting context…')).toBeTruthy()
    expect(view.getByText('Running')).toBeTruthy()
    expect(view.container.querySelector('[data-state="running"]')).not.toBeNull()
    expect(view.queryByRole('button')).toBeNull()

    act(() => { session.set({ ...session.getSnapshot(), running: false }) })
    expect(view.container.childElementCount).toBe(0)
  })
})
