/**
 * Composer control that schedules the draft as a one-time task of the
 * composer's Session.
 *
 * The trigger renders beside the submit action while the draft holds text. A
 * draft that cannot be scheduled keeps the trigger disabled, and its tooltip
 * names the reason. The menu offers three presets and a custom date and time;
 * a scheduled draft leaves the composer and its task appears in Automation
 * tasks, where it can be cancelled. The outcome notice is rendered here rather
 * than beside the trigger, so it survives the trigger leaving with the draft.
 */
import { useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  Button, IconClockOutlineRegular, IconWarningOutlineRegular, Menu, Modal, Toast, Tooltip,
  type MenuEntry,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ScheduleCreateRequest, ScheduleCreateResult, ScheduleId } from '@deepseek-ai/dsh-schedule/client'
import { IconCalendarOutlineRegular } from './CalendarIcon.tsx'
import { ClockPicker } from './ClockPicker.tsx'
import { DatePicker } from './DatePicker.tsx'
import { formatScheduleAbsolute, zoneLabel } from './schedule-format.ts'
import {
  SEND_LATER_PRESETS, customDefaults, customTiming, presetTarget, sendLaterBlock, sendLaterOutcome, sendLaterRequest,
  zonedInstant, type LocalDateTime, type SendLaterBlock, type SendLaterPreset, type SendLaterTiming,
} from './send-later.ts'
import { guardMenuEscape } from './TaskDetail.tsx'
import { deviceZone, secondPrecision, slashDate } from './task-timing.ts'
import type { TaskManagerKey } from './task-manager-locales.ts'
import page from './TaskManagerPage.module.css'
import css from './SendLaterAction.module.css'

/** Task creation and navigation bound to the composer's Session. */
export interface SendLaterInjected {
  /**
   * Create one task bound to this entry's Session.
   * @param request - prompt, title, and timing selector.
   * @returns the Remote result of `schedule.create`.
   */
  readonly createTask: (request: ScheduleCreateRequest) => Promise<RemoteResult<ScheduleCreateResult>>
  /**
   * Show one task's detail in the right Sidebar for this entry's Session.
   * @param id - task the confirmation names.
   */
  readonly openTaskDetail: (id: ScheduleId) => void
}

/** Full props of the `conversation.input.right` Send later entry. */
export type SendLaterActionProps =
  PropsRuntime<'conversation.input.right'> & PropsLocale<'schedule.manager'> & InjectFace<SendLaterInjected>

/** Tooltip copy of each reason a draft cannot be scheduled; a busy composer shows no reason. */
const BLOCK_COPY: Readonly<Record<Exclude<SendLaterBlock, 'busy'>, TaskManagerKey>> = {
  command: 'sendLater.command',
  attachments: 'sendLater.attachments',
  references: 'sendLater.references',
}

/** Menu id of the custom date and time row. */
const CUSTOM_ID = 'custom'

/** Full-opacity hold of the confirmation, long enough to reach its action. */
const CONFIRMATION_HOLD_MS = 5_000

/** One settled outcome the notice reports. */
type NoticeBody =
  | { readonly kind: 'scheduled'; readonly id: ScheduleId; readonly scheduledAt: string }
  | { readonly kind: 'failed'; readonly error: TaskManagerKey }

/** The shown outcome; `seq` keys the banner so a repeat restarts it. */
type Notice = NoticeBody & { readonly seq: number }

/**
 * Render the Send later control while the current Peer may create tasks for
 * this Session. A subagent's or removed Session never takes a task, so the
 * control stays out of its composer.
 * @param props - the Session seats, the injected creation and navigation, and localized copy.
 * @returns the control, or nothing.
 */
export function SendLaterAction(props: SendLaterActionProps): ReactNode {
  const allowed = props.useAccess('schedule/create')
  const eligible = props.useSession(snapshot => snapshot.subagent === null && !snapshot.removed)
  return allowed && eligible ? <SendLaterControl {...props} /> : null
}

function SendLaterControl({
  useInput, inputActions, createTask, openTaskDetail, t,
}: SendLaterActionProps): ReactNode {
  const draft = useInput(state => state.draft)
  const phase = useInput(state => state.phase)
  const attachments = useInput(state => state.attachmentIds.length)
  const references = useInput(state => state.occurrences.length)
  const block = sendLaterBlock({ draft, phase, attachments, references })
  const [menuOpen, setMenuOpen] = useState(false)
  const [clock, setClock] = useState(() => ({ now: Date.now(), zone: deviceZone() }))
  const [custom, setCustom] = useState<LocalDateTime | null>(null)
  const [dateOpen, setDateOpen] = useState(false)
  const [timeOpen, setTimeOpen] = useState(false)
  const [customError, setCustomError] = useState<TaskManagerKey | undefined>(undefined)
  const [pending, setPending] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const noticeSeq = useRef(0)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const cardRef = useRef<HTMLElement | null>(null)
  const dateRef = useRef<HTMLButtonElement>(null)
  const timeRef = useRef<HTMLButtonElement>(null)
  // The settled request reads the draft as it is then, not as it was sent.
  const draftRef = useRef(draft)
  draftRef.current = draft

  const locale = t('time.locale')
  const reason = block === undefined || block === 'busy' ? undefined : t(BLOCK_COPY[block])

  const show = (next: NoticeBody): void => {
    noticeSeq.current += 1
    setNotice({ ...next, seq: noticeSeq.current })
  }

  /**
   * Create the task, then take the draft out of the composer when it still
   * holds the scheduled text; a draft edited while the request ran is kept.
   * @param timing - preset or custom selector.
   * @param inDialog - whether a refusal shows in the open custom dialog rather than as a notice.
   */
  const schedule = async (timing: SendLaterTiming, inDialog: boolean): Promise<void> => {
    const request = sendLaterRequest(draft, timing)
    cardRef.current = triggerRef.current?.closest<HTMLElement>('[data-composer-card]') ?? null
    setPending(true)
    setCustomError(undefined)
    let outcome: ReturnType<typeof sendLaterOutcome>
    try {
      outcome = sendLaterOutcome(await createTask(request))
    } catch (_error: unknown) {
      // A rejected request cannot establish whether the Host stored the task.
      outcome = { error: 'sendLater.failed' }
    }
    setPending(false)
    if ('record' in outcome) {
      if (draftRef.current.trim() === request.prompt) inputActions.setDraft('')
      setCustom(null)
      show({ kind: 'scheduled', id: outcome.record.id, scheduledAt: outcome.record.scheduledAt })
      return
    }
    if (inDialog) setCustomError(outcome.error)
    else show({ kind: 'failed', error: outcome.error })
  }

  const openMenu = (): void => {
    setClock({ now: Date.now(), zone: deviceZone() })
    setMenuOpen(open => !open)
  }

  const select = (id: string): void => {
    setMenuOpen(false)
    if (id === CUSTOM_ID) {
      const now = Date.now()
      const zone = deviceZone()
      setClock({ now, zone })
      setCustomError(undefined)
      setCustom(customDefaults(now, zone))
      return
    }
    void schedule(presetTarget(id as SendLaterPreset, clock.now, clock.zone).timing, false)
  }

  const closeCustom = (): void => {
    if (pending) return
    setCustom(null)
    setDateOpen(false)
    setTimeOpen(false)
  }

  const items: MenuEntry[] = [
    { type: 'label', id: 'heading', text: t('sendLater.action') },
    ...SEND_LATER_PRESETS.map((preset) => {
      const target = presetTarget(preset, clock.now, clock.zone)
      return {
        id: preset,
        disabled: pending,
        label: <span className={css.preset}>
          {t(`sendLater.preset.${preset}`)}{' '}
          <time className={css.when} dateTime={new Date(target.at).toISOString()}>
            {formatScheduleAbsolute(new Date(target.at).toISOString(), locale)}
          </time>
        </span>,
      }
    }),
    { type: 'separator', id: 'custom-separator' },
    { id: CUSTOM_ID, label: t('sendLater.custom'), disabled: pending },
  ]

  // The custom fields are read in the zone they were opened in; the Host decides
  // past and skipped times, and this check only keeps an obvious past time unsent.
  const future = custom !== null && zonedInstant(custom.date, custom.time, clock.zone) > Date.now()
  const customHint = customError ?? (future ? undefined : 'timing.notFuture')

  return <>
    {draft.trim() !== '' && <Menu
      open={menuOpen}
      onClose={() => { setMenuOpen(false) }}
      onSelect={select}
      items={items}
      side="top"
      align="end"
      portal
      listClassName={css.menu}
      anchor={<Tooltip label={reason ?? t('sendLater.action')} side="top" delayMs={500} portal disabled={menuOpen}>
        <span className={css.anchor}>
          <Button
            ref={triggerRef}
            className={css.trigger}
            size="sm"
            aria-label={t('sendLater.action')}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            data-send-later=""
            disabled={block !== undefined || pending}
            onClick={openMenu}
          >
            <IconClockOutlineRegular size={18} />
          </Button>
        </span>
      </Tooltip>}
    />}
    <Modal
      className={page.confirmDialog as string}
      contentClassName={page.confirmContent as string}
      open={custom !== null}
      title={t('sendLater.action')}
      description={t('sendLater.description')}
      closeLabel={t('sendLater.close')}
      onClose={closeCustom}
      footer={custom !== null && <div className={page.confirmActions}>
        <Button variant="outline" disabled={pending} onClick={closeCustom}>{t('sendLater.cancel')}</Button>
        <Button
          variant="primary"
          disabled={pending || !future || block !== undefined}
          onClick={() => { void schedule(customTiming(custom, clock.zone), true) }}
        >
          {t(pending ? 'sendLater.pending' : 'sendLater.schedule')}
        </Button>
      </div>}
    >
      {custom !== null && <>
        <div className={page.ruleRows}>
          <div className={page.ruleRow}>
            <span className={page.ruleLabel}>{t('timing.date')}</span>
            <span className={page.menuGuard} onKeyDown={(event) => {
              guardMenuEscape(event, dateOpen, () => {
                setDateOpen(false)
                dateRef.current?.focus()
              })
            }}>
              <button
                ref={dateRef}
                type="button"
                className={clsx(page.ruleInput, page.ruleControl, page.pickerTrigger)}
                disabled={pending}
                aria-label={t('timing.date')}
                aria-haspopup="dialog"
                aria-expanded={dateOpen}
                onClick={() => { setDateOpen(open => !open) }}
              >
                <span>{slashDate(custom.date)}</span>
                <IconCalendarOutlineRegular className={page.pickerIcon} />
              </button>
              <DatePicker
                open={dateOpen}
                anchorRef={dateRef}
                value={custom.date}
                onPick={(date) => { setCustomError(undefined); setCustom({ ...custom, date }) }}
                onClose={() => { setDateOpen(false) }}
                t={t}
              />
            </span>
          </div>
          <div className={page.ruleRow}>
            <span className={page.ruleLabel}>{t('timing.time')}</span>
            <span className={page.menuGuard} onKeyDown={(event) => {
              guardMenuEscape(event, timeOpen, () => {
                setTimeOpen(false)
                timeRef.current?.focus()
              })
            }}>
              <button
                ref={timeRef}
                type="button"
                className={clsx(page.ruleInput, page.ruleControl, page.pickerTrigger)}
                disabled={pending}
                aria-label={t('timing.time')}
                aria-haspopup="dialog"
                aria-expanded={timeOpen}
                onClick={() => { setTimeOpen(open => !open) }}
              >
                <span>{secondPrecision(custom.time)}</span>
                <IconClockOutlineRegular className={page.pickerIcon} size={14} />
              </button>
              <ClockPicker
                open={timeOpen}
                anchorRef={timeRef}
                value={custom.time}
                onPick={(time) => { setCustomError(undefined); setCustom({ ...custom, time }) }}
                onClose={() => { setTimeOpen(false) }}
                t={t}
              />
            </span>
          </div>
          <div className={page.ruleRow}>
            <span className={page.ruleLabel}>{t('timing.zone')}</span>
            <span className={css.zone}>{zoneLabel(clock.zone, t)}</span>
          </div>
        </div>
        {customHint !== undefined && <p className={clsx(page.ruleHint, page.ruleHintError)} role="alert">
          {t(customHint)}
        </p>}
      </>}
    </Modal>
    {notice?.kind === 'scheduled' && <Toast
      key={notice.seq}
      text={t('sendLater.scheduled', { time: formatScheduleAbsolute(notice.scheduledAt, locale) })}
      tone="success"
      anchor={cardRef.current}
      holdMs={CONFIRMATION_HOLD_MS}
      actions={[{ label: t('sendLater.view'), onClick: () => { setNotice(null); openTaskDetail(notice.id) } }]}
      onDone={() => { setNotice(null) }}
    />}
    {notice?.kind === 'failed' && <Toast
      key={notice.seq}
      text={t(notice.error)}
      icon={<IconWarningOutlineRegular />}
      anchor={cardRef.current}
      onDone={() => { setNotice(null) }}
    />}
  </>
}
