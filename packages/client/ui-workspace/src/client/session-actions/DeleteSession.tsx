/**
 * The delete action: a `sidebar.workspaces.session.menu.item` row and the
 * `shell.overlay` dialog that states what goes with the Session before it is
 * deleted. The pending request, its subagent and fork counts, and the Host
 * delete live in the injected callbacks, not here.
 */
import { useState } from 'react'
import { Button, Checkbox, IconTrashOutlineRegular, MenuItemButton, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  DeleteSessionInjected, SessionDeleteDialogInjected, SessionDeleteDialogProps, SessionDeleteRequest,
  SessionMenuItemProps,
} from '../contract/slots.ts'
import browserCss from '../rows/WorkspaceBrowser.module.css'

/**
 * Menu row (order 420): ask for the delete dialog for this row's Session.
 * Absent while the Session's access snapshot excludes `session/delete`.
 * @param props - owner share, menu open state, access Hook, and the delete share.
 * @returns the row, or nothing when the caller may not delete this Session.
 */
export function DeleteSessionMenuItem({
  sessionId, useMenuOpenState, useSessionAccess, requestSessionDelete, t,
}: SessionMenuItemProps<DeleteSessionInjected>) {
  const [, setMenuOpen] = useMenuOpenState()
  const deleteAllowed = useSessionAccess(sessionId, 'session/delete')
  if (!deleteAllowed) return null
  return (
    <MenuItemButton
      danger
      icon={<IconTrashOutlineRegular />}
      onSelect={() => {
        setMenuOpen(false)
        requestSessionDelete(sessionId)
      }}
    >
      {t('menu.deleteSession')}
    </MenuItemButton>
  )
}

/**
 * The `shell.overlay` entry: nothing while no delete is requested, otherwise
 * one dialog per request (keyed by the Session). The dialog says up front
 * what goes with the Session (its subagent Sessions) and what stays (its
 * forks, unless the person ticks the cascade).
 * @param props - the request hook, its settlement, the delete hop, and the locale seat.
 * @returns the open dialog, or null.
 */
export function SessionDeleteDialog({ useDeleteRequest, settleSessionDelete, deleteSession, t }: SessionDeleteDialogProps) {
  const request = useDeleteRequest(pending => pending)
  if (request === null) return null
  return (
    <DeleteForm
      key={request.sessionId}
      request={request}
      deleteSession={deleteSession}
      onSettle={settleSessionDelete}
      t={t}
    />
  )
}

/** One request's dialog: the cascade choice, in-flight and error state die with it. */
function DeleteForm({ request, deleteSession, onSettle, t }: {
  request: SessionDeleteRequest
  deleteSession: SessionDeleteDialogInjected['deleteSession']
  onSettle: () => void
  t: SessionDeleteDialogProps['t']
}) {
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [cascade, setCascade] = useState(false)
  const { subagents, forks } = request.scope
  const close = () => {
    if (deleting) return
    onSettle()
  }
  const confirm = () => {
    setDeleting(true)
    setError(null)
    deleteSession(request.sessionId, { cascade }).then((outcome) => {
      setDeleting(false)
      if (outcome.kind === 'deleted') onSettle()
      else setError(outcome.message)
    }).catch((reason: unknown) => {
      setDeleting(false)
      setError(reason instanceof Error ? reason.message : String(reason))
    })
  }
  return (
    <Modal
      open
      onClose={close}
      closeLabel={t('close')}
      title={t('delete.session.title')}
      description={t('delete.session.desc', { name: request.displayTitle })}
      footer={(
        <>
          <Button variant="outline" disabled={deleting} onClick={close}>{t('cancel')}</Button>
          <Button
            variant="outline"
            className={browserCss.deleteAction}
            disabled={deleting}
            onClick={confirm}
          >
            {t('delete.session.title')}
          </Button>
        </>
      )}
    >
      {subagents > 0 && (
        <div className={browserCss.deleteNotice}>{t('delete.session.subagents', { n: subagents })}</div>
      )}
      {forks > 0 && (
        <>
          <div className={browserCss.deleteNotice}>{t('delete.session.forksKept', { n: forks })}</div>
          <Checkbox
            checked={cascade}
            onChange={setCascade}
            disabled={deleting}
            label={t('delete.session.cascade', { n: forks })}
          />
        </>
      )}
      {deleting && <div className={browserCss.deleteStatus} role="status">{t('delete.session.pending')}</div>}
      {error !== null && <div className={browserCss.renameError} role="alert">{error}</div>}
    </Modal>
  )
}
