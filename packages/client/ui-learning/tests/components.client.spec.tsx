// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LearningSettingsTab } from '../src/client/LearningSettingsTab.tsx'
import type { LearningSettingsTabInjected, LearningSettingsTabProps } from '../src/client/LearningSettingsTab.tsx'
import { en, type LearningLocaleKey } from '../src/client/locales.ts'

afterEach(cleanup)

type Snapshot = Awaited<ReturnType<LearningSettingsTabInjected['list']>>

const t = ((key: LearningLocaleKey, params?: Record<string, string>): string =>
  Object.entries(params ?? {}).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, value),
    en[key],
  )) as LearningSettingsTabProps['t']

const SNAPSHOT: Snapshot = {
  candidates: [
    { id: 'c1', text: 'pnpm lives in ~/.local/bin', tags: ['pnpm'], kind: 'fact', status: 'candidate', createdAt: '2026-09-20T00:00:00Z', updatedAt: '2026-09-20T00:00:00Z' },
  ],
  recalled: [
    { id: 'a1', text: 'Run one package at a time.', tags: [], kind: 'shortcut', status: 'approved', createdAt: '2026-09-20T00:00:00Z', updatedAt: '2026-09-20T00:00:00Z' },
    { id: 'p1', text: 'Already a skill.', tags: [], kind: 'shortcut', status: 'promoted', createdAt: '2026-09-20T00:00:00Z', updatedAt: '2026-09-20T00:00:00Z' },
  ],
  curated: [
    { id: 's1', text: 'Idle habit.', tags: [], kind: 'fact', status: 'stale', createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-09-20T00:00:00Z' },
    { id: 'x1', text: 'Merged away.', tags: [], kind: 'fact', status: 'archived', createdAt: '2026-05-01T00:00:00Z', updatedAt: '2026-09-20T00:00:00Z' },
  ],
}

const SUGGESTIONS: Awaited<ReturnType<LearningSettingsTabInjected['suggestions']>> = [
  {
    id: 'sg1',
    name: 'vitest',
    status: 'proposed',
    createdAt: '2026-09-20T00:00:00Z',
    entries: [
      { id: 'v1', text: 'Run vitest one package at a time.', tags: ['vitest'], kind: 'shortcut', status: 'approved', createdAt: '2026-09-20T00:00:00Z', updatedAt: '2026-09-20T00:00:00Z' },
      { id: 'v2', text: 'Build the host addon first.', tags: ['vitest'], kind: 'shortcut', status: 'approved', createdAt: '2026-09-20T00:00:00Z', updatedAt: '2026-09-20T00:00:00Z' },
      { id: 'v3', text: 'Filter with -t.', tags: ['vitest'], kind: 'shortcut', status: 'approved', createdAt: '2026-09-20T00:00:00Z', updatedAt: '2026-09-20T00:00:00Z' },
    ],
  },
]

const SKILLS: Awaited<ReturnType<LearningSettingsTabInjected['skills']>> = [
  { name: 'release-checklist', description: 'Steps before a release', path: '/skills/release-checklist/SKILL.md', bytes: 40 },
]

function props(overrides: Partial<LearningSettingsTabInjected> = {}): LearningSettingsTabProps & { injected: LearningSettingsTabInjected } {
  const injected: LearningSettingsTabInjected = {
    list: vi.fn(async () => SNAPSHOT),
    review: vi.fn(async () => {}),
    forget: vi.fn(async () => {}),
    update: vi.fn(async () => {}),
    skills: vi.fn(async () => SKILLS),
    readSkill: vi.fn(async (name: string) => name === 'release-checklist' ? '# Release\n1. tag\n' : null),
    writeSkill: vi.fn(async () => {}),
    deleteSkill: vi.fn(async () => {}),
    promote: vi.fn(async () => {}),
    curate: vi.fn(async () => ({ stale: 1, archived: 2, merged: 3, suggested: 0 })),
    suggestions: vi.fn(async () => SUGGESTIONS),
    acceptSuggestion: vi.fn(async (_id: string, name: string) => ({ path: `/skills/${name}/SKILL.md`, name })),
    dismissSuggestion: vi.fn(async () => {}),
    ...overrides,
  }
  return { t, ...injected, injected } as LearningSettingsTabProps & { injected: LearningSettingsTabInjected }
}

describe('LearningSettingsTab', () => {
  it('lists candidates with review actions and remembered entries with forget', async () => {
    const p = props()
    render(<LearningSettingsTab {...p} />)
    expect(screen.getByText(en.loading)).toBeTruthy()
    await waitFor(() => { expect(screen.getByText('pnpm lives in ~/.local/bin')).toBeTruthy() })
    expect(screen.getAllByRole('button', { name: en.approve })).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: en.reject })).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: en.forget })).toHaveLength(4)
    // A promoted entry offers no second promotion.
    expect(screen.getAllByRole('button', { name: en.promote })).toHaveLength(1)
    expect(screen.getByText(en.statusPromoted)).toBeTruthy()
  })

  it('approves a candidate through the injected callback and reloads', async () => {
    const p = props()
    render(<LearningSettingsTab {...p} />)
    await waitFor(() => { expect(screen.getByRole('button', { name: en.approve })).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: en.approve }))
    await waitFor(() => { expect(p.injected.review).toHaveBeenCalledWith('c1', 'approve') })
    await waitFor(() => { expect(p.injected.list).toHaveBeenCalledTimes(2) })
  })

  it('promotes a remembered entry under the typed skill name and reports the write', async () => {
    const p = props()
    render(<LearningSettingsTab {...p} />)
    await waitFor(() => { expect(screen.getByRole('button', { name: en.promote })).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: en.promote }))
    const confirm = screen.getByRole('button', { name: en.promoteConfirm }) as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    fireEvent.change(screen.getByPlaceholderText(en.promoteNamePlaceholder), { target: { value: 'one-package-tests' } })
    fireEvent.click(screen.getByRole('button', { name: en.promoteConfirm }))
    await waitFor(() => { expect(p.injected.promote).toHaveBeenCalledWith('a1', 'one-package-tests') })
    await waitFor(() => { expect(screen.getByRole('status').textContent).toBe('Written as skill one-package-tests') })
  })

  it('shows the Host failure beside the entry when an action rejects', async () => {
    const p = props({ forget: vi.fn(async () => { throw new Error('learning.forget failed: STORE: read-only') }) })
    render(<LearningSettingsTab {...p} />)
    await waitFor(() => { expect(screen.getAllByRole('button', { name: en.forget })).toHaveLength(4) })
    fireEvent.click(screen.getAllByRole('button', { name: en.forget })[0]!)
    await waitFor(() => { expect(screen.getByRole('status').textContent).toContain('read-only') })
  })

  it('shows curated entries with their status chips and runs the curator on request', async () => {
    const p = props()
    render(<LearningSettingsTab {...p} />)
    await waitFor(() => { expect(screen.getByText('Idle habit.')).toBeTruthy() })
    expect(screen.getByText(en.statusStale)).toBeTruthy()
    expect(screen.getByText(en.statusArchived)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.curate }))
    await waitFor(() => { expect(p.injected.curate).toHaveBeenCalledTimes(1) })
    await waitFor(() => { expect(screen.getByRole('status').textContent).toBe('Curated: 1 stale, 2 archived, 3 merged') })
    await waitFor(() => { expect(p.injected.list).toHaveBeenCalledTimes(2) })
  })

  it('shows suggested skills with an editable name, accepts one, and dismisses one', async () => {
    const p = props()
    render(<LearningSettingsTab {...p} />)
    await waitFor(() => { expect(screen.getByText('Build the host addon first.')).toBeTruthy() })
    const nameInput = screen.getByDisplayValue('vitest') as HTMLInputElement
    fireEvent.change(nameInput, { target: { value: 'vitest-habits' } })
    fireEvent.click(screen.getByRole('button', { name: en.suggestionAccept }))
    await waitFor(() => { expect(p.injected.acceptSuggestion).toHaveBeenCalledWith('sg1', 'vitest-habits') })
    await waitFor(() => { expect(screen.getByRole('status').textContent).toBe('Written as skill vitest-habits') })
    await waitFor(() => { expect(p.injected.suggestions).toHaveBeenCalledTimes(2) })
    fireEvent.click(screen.getByRole('button', { name: en.suggestionDismiss }))
    await waitFor(() => { expect(p.injected.dismissSuggestion).toHaveBeenCalledWith('sg1') })
  })

  it('edits a learned entry inline through the update callback and reloads', async () => {
    const p = props()
    render(<LearningSettingsTab {...p} />)
    await waitFor(() => { expect(screen.getByText('Run one package at a time.')).toBeTruthy() })
    fireEvent.click(screen.getAllByRole('button', { name: en.edit })[0]!)
    const editor = screen.getByRole('textbox', { name: en.edit })
    fireEvent.change(editor, { target: { value: 'Run one package at a time, with -t to filter.' } })
    fireEvent.click(screen.getByRole('button', { name: en.editSave }))
    await waitFor(() => { expect(p.injected.update).toHaveBeenCalledWith('a1', 'Run one package at a time, with -t to filter.') })
    await waitFor(() => { expect(p.injected.list).toHaveBeenCalledTimes(2) })
    expect(screen.getByText(en.edited)).toBeTruthy()
  })

  it('lists skills, opens one for editing, saves it, and deletes it', async () => {
    const p = props()
    render(<LearningSettingsTab {...p} />)
    await waitFor(() => { expect(screen.getByText('release-checklist')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: en.skillOpen }))
    await waitFor(() => { expect(p.injected.readSkill).toHaveBeenCalledWith('release-checklist') })
    const editor = await screen.findByRole('textbox', { name: 'release-checklist' })
    fireEvent.change(editor, { target: { value: '# Release\n1. tag\n2. push\n' } })
    fireEvent.click(screen.getByRole('button', { name: en.skillSave }))
    await waitFor(() => { expect(p.injected.writeSkill).toHaveBeenCalledWith('release-checklist', '# Release\n1. tag\n2. push\n') })
    fireEvent.click(screen.getByRole('button', { name: en.skillDelete }))
    await waitFor(() => { expect(p.injected.deleteSkill).toHaveBeenCalledWith('release-checklist') })
  })

  it('offers a retry when the first read fails', async () => {
    const list = vi.fn<() => Promise<Snapshot>>().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(SNAPSHOT)
    const p = props({ list })
    render(<LearningSettingsTab {...p} />)
    await waitFor(() => { expect(screen.getByText(en.error)).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: en.retry }))
    await waitFor(() => { expect(screen.getByText('Run one package at a time.')).toBeTruthy() })
  })
})
