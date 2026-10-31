// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RemoteError, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'
import type { DraftAttachmentId, InputState } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ScheduleCreateResult, ScheduleRecord } from '@deepseek-ai/dsh-schedule/client'
import { ScheduleId } from '@deepseek-ai/dsh-schedule'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { formatScheduleAbsolute, zoneLabel } from '../src/client/schedule-format.ts'
import { presetTarget } from '../src/client/send-later.ts'
import { SendLaterAction, type SendLaterActionProps } from '../src/client/SendLaterAction.tsx'
import { en } from '../src/client/task-manager-locales.ts'

const SESSION = 'send-later-session' as SessionId
const ZONE = 'Asia/Shanghai'
// 20:00 on October 31 in Shanghai; the custom choice starts at 20:00 on November 1.
const START = Date.parse('2026-10-31T12:00:00.000Z')
const DRAFT = 'Summarize the open pull requests\nand list the blockers'
const t = makeTranslate(en) as SendLaterActionProps['t']

const record: ScheduleRecord = {
  id: ScheduleId('schedule-sent-later'), kind: 'after', title: 'Summarize the open pull requests',
  prompt: DRAFT, afterSeconds: 18_000, scheduledAt: '2026-10-31T17:00:00.000Z',
}

/** The composer's draft writer, shared by every props object of one case. */
let setDraft = vi.fn<(text: string) => void>()

beforeEach(() => {
  setDraft = vi.fn<(text: string) => void>()
  // The device zone is pinned before fake timers install their `Intl` wrapper,
  // whose own prototype the component's zone lookup does not read.
  vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({
    ...new Intl.DateTimeFormat().resolvedOptions(), timeZone: ZONE,
  })
  vi.useFakeTimers()
  vi.setSystemTime(START)
  // jsdom has no `scrollIntoView`, which an open clock panel calls on its selected options.
  Element.prototype.scrollIntoView = vi.fn()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

interface Options {
  readonly draft?: string
  readonly phase?: InputState['phase']
  readonly attachments?: number
  readonly references?: number
  readonly session?: Partial<SessionSnapshot>
  readonly allowed?: boolean
  readonly createTask?: SendLaterActionProps['createTask']
}

function props(options: Options = {}): SendLaterActionProps {
  const snapshot: SessionSnapshot = {
    sessionId: SESSION, pendingSubmissions: [], running: false, subagent: null, removed: false, openState: 'open',
    openError: null, hasMore: false, loadingOlder: false, promptError: null, blank: false, lastAgentError: null,
    promptAttempted: false, awaitingFirstTurn: false, ...options.session,
  }
  const input: InputState = {
    draft: options.draft ?? DRAFT,
    attachmentIds: Array.from({ length: options.attachments ?? 0 }, (_value, index) =>
      `attachment-${String(index)}` as DraftAttachmentId),
    draftRev: 1,
    phase: options.phase ?? 'plain',
    occurrences: Array.from({ length: options.references ?? 0 }, (_value, index) => ({
      occurrenceId: index, source: 'files', ref: 'src/a.ts', offset: 0, length: 9, label: 'a.ts', clipboardText: '@src/a.ts',
    })),
    queue: [],
  }
  return {
    sessionId: SESSION,
    useSession: <T,>(select: (value: SessionSnapshot) => T): T => select(snapshot),
    useInput: <T,>(select: (value: InputState) => T): T => select(input),
    inputActions: { setDraft },
    useAccess: vi.fn((_action: string) => options.allowed ?? true),
    createTask: options.createTask ?? vi.fn(async () => ({ ok: true as const, value: record })),
    openTaskDetail: vi.fn(),
    t,
  } as SendLaterActionProps
}

function trigger(): HTMLButtonElement {
  return screen.getByRole('button', { name: en['sendLater.action'] }) as HTMLButtonElement
}

/** Hover the trigger's tooltip anchor and return the bubble's text. */
function tooltipText(): string | null {
  fireEvent.pointerEnter(trigger().parentElement!)
  act(() => { vi.advanceTimersByTime(500) })
  return screen.getByRole('tooltip').textContent
}

async function settle(): Promise<void> {
  await act(async () => { await Promise.resolve() })
}

function deferred(): {
  readonly promise: Promise<RemoteResult<ScheduleCreateResult>>
  readonly resolve: (value: RemoteResult<ScheduleCreateResult>) => void
} {
  const { promise, resolve } = Promise.withResolvers<RemoteResult<ScheduleCreateResult>>()
  return { promise, resolve }
}

describe('SendLaterAction visibility', () => {
  it('renders nothing without create access, for a subagent Session, or for a removed Session', () => {
    const refused = props({ allowed: false })
    const view = render(<SendLaterAction {...refused} />)
    expect(view.container.innerHTML).toBe('')
    expect(refused.useAccess).toHaveBeenCalledWith('schedule/create')

    const subagent: SessionSnapshot['subagent'] = {
      address: { parentSessionId: 'parent' as SessionId, childSessionId: SESSION, mode: 'continuable' }, parentAvailable: true,
    }
    view.rerender(<SendLaterAction {...props({ session: { subagent } })} />)
    expect(view.container.innerHTML).toBe('')
    view.rerender(<SendLaterAction {...props({ session: { removed: true } })} />)
    expect(view.container.innerHTML).toBe('')
  })

  it('shows the trigger only while the draft holds text', () => {
    const view = render(<SendLaterAction {...props({ draft: '  \n ' })} />)
    expect(screen.queryByRole('button', { name: en['sendLater.action'] })).toBeNull()
    view.rerender(<SendLaterAction {...props()} />)
    expect(trigger().disabled).toBe(false)
    expect(tooltipText()).toBe(en['sendLater.action'])
  })

  it('enables the trigger in a Session that has not started a turn', () => {
    render(<SendLaterAction {...props({ session: { blank: true } })} />)
    expect(trigger().disabled).toBe(false)
    expect(tooltipText()).toBe(en['sendLater.action'])
  })

  it.each([
    ['a command', { draft: '/compact now' }, en['sendLater.command']],
    ['a claimed command', { phase: 'claimed', draft: '/goal ship it' }, en['sendLater.command']],
    ['attachments', { attachments: 1 }, en['sendLater.attachments']],
    ['reference chips', { references: 1 }, en['sendLater.references']],
  ] satisfies readonly [string, Options, string][])('disables the trigger for %s and names the reason', (_name, options, reason) => {
    render(<SendLaterAction {...props(options)} />)
    expect(trigger().disabled).toBe(true)
    expect(tooltipText()).toBe(reason)
  })

  it('disables the trigger without a reason while a submission is in flight', () => {
    render(<SendLaterAction {...props({ phase: 'sending' })} />)
    expect(trigger().disabled).toBe(true)
    expect(tooltipText()).toBe(en['sendLater.action'])
  })
})

describe('SendLaterAction presets', () => {
  it('offers the presets with the times they name, and closes the menu on a second press', () => {
    render(<SendLaterAction {...props()} />)
    fireEvent.click(trigger())
    const menu = screen.getByRole('menu')
    expect(within(menu).getByText(en['sendLater.action'])).toBeDefined()
    const rows = within(menu).getAllByRole('menuitem').map(row => row.textContent)
    const stamp = (preset: Parameters<typeof presetTarget>[0]): string =>
      formatScheduleAbsolute(new Date(presetTarget(preset, START, ZONE).at).toISOString(), 'en')
    expect(rows).toEqual([
      `${en['sendLater.preset.hours5']} ${stamp('hours5')}`,
      `${en['sendLater.preset.tomorrow']} ${stamp('tomorrow')}`,
      `${en['sendLater.preset.days2']} ${stamp('days2')}`,
      en['sendLater.custom'],
    ])
    fireEvent.click(trigger())
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.click(trigger())
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('schedules the draft, takes it out of the composer, and confirms with a link to the task', async () => {
    const input = props()
    render(<SendLaterAction {...input} />)
    fireEvent.click(trigger())
    fireEvent.click(screen.getByRole('menuitem', { name: new RegExp(`^${en['sendLater.preset.hours5']}`) }))
    await settle()

    expect(input.createTask).toHaveBeenCalledWith({
      prompt: DRAFT, title: 'Summarize the open pull requests', after_seconds: 18_000,
    })
    expect(setDraft).toHaveBeenCalledWith('')
    expect(screen.queryByRole('menu')).toBeNull()
    const notice = en['sendLater.scheduled'].replace('{time}', formatScheduleAbsolute(record.scheduledAt, 'en'))
    expect(screen.getByRole('alert').textContent).toBe(`${notice}${en['sendLater.view']}`)
    fireEvent.click(screen.getByRole('button', { name: en['sendLater.view'] }))
    expect(input.openTaskDetail).toHaveBeenCalledWith(record.id)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('sends "Tomorrow" as the instant of the same wall-clock minute in the device zone', async () => {
    const input = props()
    render(<SendLaterAction {...input} />)
    fireEvent.click(trigger())
    fireEvent.click(screen.getByRole('menuitem', { name: new RegExp(`^${en['sendLater.preset.tomorrow']}`) }))
    await settle()
    expect(input.createTask).toHaveBeenCalledWith({
      prompt: DRAFT, title: 'Summarize the open pull requests', at: '2026-11-01T12:00:00.000Z',
    })
  })

  it('keeps a draft edited while the request ran, and lets the confirmation fade', async () => {
    const pending = deferred()
    const first = props({ createTask: vi.fn(() => pending.promise) })
    const view = render(<SendLaterAction {...first} />)
    fireEvent.click(trigger())
    fireEvent.click(screen.getByRole('menuitem', { name: new RegExp(`^${en['sendLater.preset.days2']}`) }))
    expect(trigger().disabled).toBe(true)
    view.rerender(<SendLaterAction {...first} {...{ useInput: props({ draft: `${DRAFT} too` }).useInput }} />)
    pending.resolve({ ok: true, value: record })
    await settle()

    expect(setDraft).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toContain(formatScheduleAbsolute(record.scheduledAt, 'en'))
    act(() => { vi.advanceTimersByTime(6_000) })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it.each([
    ['a Host refusal', async () => ({ ok: true as const, value: { code: 'subagent_session' as const, message: 'child' } }),
      en['timing.subagentSession']],
    ['a failed call', async () => ({ ok: false as const, error: new RemoteError('gateway/internal', 'Unavailable', {}) }),
      en['sendLater.failed']],
    ['a rejected call', async () => { throw new Error('unmounted method') }, en['sendLater.failed']],
  ] satisfies readonly [string, SendLaterActionProps['createTask'], string][])(
    'keeps the draft and explains %s', async (_name, createTask, copy) => {
      const input = props({ createTask: vi.fn(createTask) })
      render(<SendLaterAction {...input} />)
      fireEvent.click(trigger())
      fireEvent.click(screen.getByRole('menuitem', { name: new RegExp(`^${en['sendLater.preset.hours5']}`) }))
      await settle()

      expect(setDraft).not.toHaveBeenCalled()
      expect(screen.getByRole('alert').textContent).toBe(copy)
      act(() => { vi.advanceTimersByTime(4_000) })
      expect(screen.queryByRole('alert')).toBeNull()
    },
  )
})

describe('SendLaterAction custom date and time', () => {
  function openCustom(input: SendLaterActionProps): void {
    render(<SendLaterAction {...input} />)
    fireEvent.click(trigger())
    fireEvent.click(screen.getByRole('menuitem', { name: en['sendLater.custom'] }))
  }

  function dialog(): HTMLElement {
    return screen.getByRole('dialog', { name: en['sendLater.action'] })
  }

  function schedule(): HTMLButtonElement {
    return within(dialog()).getByRole('button', { name: en['sendLater.schedule'] }) as HTMLButtonElement
  }

  it('starts from tomorrow at the current minute in the device zone and sends local fields', async () => {
    const input = props()
    openCustom(input)
    expect(within(dialog()).getByRole('button', { name: en['timing.date'] }).textContent).toBe('2026/11/01')
    expect(within(dialog()).getByRole('button', { name: en['timing.time'] }).textContent).toBe('20:00:00')
    expect(within(dialog()).getByText(zoneLabel(ZONE, t))).toBeDefined()
    expect(within(dialog()).queryByRole('alert')).toBeNull()

    fireEvent.click(schedule())
    await settle()
    expect(input.createTask).toHaveBeenCalledWith({
      prompt: DRAFT, title: 'Summarize the open pull requests',
      at: { date: '2026-11-01', time: '20:00:00', time_zone: ZONE },
    })
    expect(setDraft).toHaveBeenCalledWith('')
    expect(screen.queryByRole('dialog', { name: en['sendLater.action'] })).toBeNull()
  })

  it('refuses a past date and time until a future one is picked', () => {
    openCustom(props())
    fireEvent.click(within(dialog()).getByRole('button', { name: en['timing.date'] }))
    fireEvent.click(screen.getByRole('button', { name: en['timing.prevMonth'] }))
    fireEvent.click(screen.getAllByRole('gridcell').find(cell => cell.textContent === '31')!)
    expect(within(dialog()).getByRole('alert').textContent).toBe(en['timing.notFuture'])
    expect(schedule().disabled).toBe(true)

    fireEvent.click(within(dialog()).getByRole('button', { name: en['timing.time'] }))
    fireEvent.click(within(screen.getByRole('listbox', { name: en['timing.hour'] })).getByText('21'))
    expect(within(dialog()).getByRole('button', { name: en['timing.time'] }).textContent).toBe('21:00:00')
    expect(within(dialog()).queryByRole('alert')).toBeNull()
    expect(schedule().disabled).toBe(false)
  })

  it('shows a Host refusal in the dialog and keeps it open', async () => {
    const input = props({ createTask: vi.fn(async () => ({
      ok: true as const, value: { code: 'invalid_rule' as const, message: 'The local at time does not exist.' },
    })) })
    openCustom(input)
    fireEvent.click(schedule())
    await settle()
    expect(within(dialog()).getByRole('alert').textContent).toBe(en['timing.invalid'])
    expect(setDraft).not.toHaveBeenCalled()
  })

  it('holds the dialog while a request runs and closes it on Cancel afterwards', async () => {
    const pending = deferred()
    openCustom(props({ createTask: vi.fn(() => pending.promise) }))
    fireEvent.click(schedule())
    const running = within(dialog()).getByRole('button', { name: en['sendLater.pending'] }) as HTMLButtonElement
    expect(running.disabled).toBe(true)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(dialog()).toBeDefined()

    pending.resolve({ ok: true, value: { code: 'not_future', message: 'past' } })
    await settle()
    expect(within(dialog()).getByRole('alert').textContent).toBe(en['timing.notFuture'])
    fireEvent.click(within(dialog()).getByRole('button', { name: en['sendLater.cancel'] }))
    expect(screen.queryByRole('dialog', { name: en['sendLater.action'] })).toBeNull()
  })

  it('closes an open picker on an outside press without closing the dialog', () => {
    openCustom(props())
    fireEvent.click(within(dialog()).getByRole('button', { name: en['timing.date'] }))
    expect(screen.getByRole('grid')).toBeDefined()
    fireEvent.pointerDown(dialog())
    expect(screen.queryByRole('grid')).toBeNull()

    fireEvent.click(within(dialog()).getByRole('button', { name: en['timing.time'] }))
    expect(screen.getByRole('listbox', { name: en['timing.hour'] })).toBeDefined()
    fireEvent.pointerDown(dialog())
    expect(screen.queryByRole('listbox', { name: en['timing.hour'] })).toBeNull()
    expect(dialog()).toBeDefined()
  })

  it('closes an open picker on Escape without closing the dialog', () => {
    openCustom(props())
    fireEvent.click(within(dialog()).getByRole('button', { name: en['timing.date'] }))
    fireEvent.keyDown(screen.getAllByRole('gridcell').find(cell => cell.textContent === '1')!, { key: 'Escape' })
    expect(screen.queryByRole('grid')).toBeNull()
    expect(dialog()).toBeDefined()

    fireEvent.click(within(dialog()).getByRole('button', { name: en['timing.time'] }))
    fireEvent.keyDown(within(screen.getByRole('listbox', { name: en['timing.minute'] })).getByText('00'), { key: 'Escape' })
    expect(screen.queryByRole('listbox', { name: en['timing.minute'] })).toBeNull()
    expect(dialog()).toBeDefined()
  })
})
