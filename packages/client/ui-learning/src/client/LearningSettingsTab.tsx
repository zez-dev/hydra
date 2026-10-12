import { useEffect, useState, type ReactNode } from 'react'
import type {
  LearningAcceptSuggestionValue, LearningCurateValue, LearningEntryView, LearningSkillView, LearningSnapshot, LearningSuggestionView,
} from '@deepseek-ai/dsh-api-remotes/client'
import { Button, Input, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { LearningLocaleKey } from './locales.ts'
import css from './LearningSettingsTab.module.css'

/** Registration-side Remote face used by the tab. */
export interface LearningSettingsTabInjected {
  /** Read the candidates and the recalled entries. */
  list: () => Promise<LearningSnapshot>
  /** Approve or reject one candidate. */
  review: (id: string, decision: 'approve' | 'reject') => Promise<void>
  /** Delete one entry. */
  forget: (id: string) => Promise<void>
  /** Rewrite one entry's text, and optionally its tags. */
  update: (id: string, text: string, tags?: string[]) => Promise<void>
  /** List the skills the learning plugin wrote. */
  skills: () => Promise<LearningSkillView[]>
  /** Read one skill file; `null` when it does not exist. */
  readSkill: (name: string) => Promise<string | null>
  /** Replace one skill file. */
  writeSkill: (name: string, content: string) => Promise<void>
  /** Delete one skill. */
  deleteSkill: (name: string) => Promise<void>
  /** Write one entry as a skill under the given name. */
  promote: (id: string, name: string) => Promise<void>
  /** Run the curator once and report what changed. */
  curate: () => Promise<LearningCurateValue>
  /** Read the skill suggestions awaiting a decision. */
  suggestions: () => Promise<LearningSuggestionView[]>
  /** Promote a suggestion's entries as one skill under the given name. */
  acceptSuggestion: (id: string, name: string) => Promise<LearningAcceptSuggestionValue>
  /** Hide a suggestion for good. */
  dismissSuggestion: (id: string) => Promise<void>
}

/** Full component props assembled by the Settings slot renderer. */
export type LearningSettingsTabProps =
  PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'settings.learning'>
  & InjectFace<LearningSettingsTabInjected>

type Translate = LearningSettingsTabProps['t']

type ViewState =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly snapshot: LearningSnapshot; readonly suggestions: LearningSuggestionView[]; readonly skills: LearningSkillView[] }

const KIND_KEYS = {
  fact: 'kindFact',
  shortcut: 'kindShortcut',
  preference: 'kindPreference',
} satisfies Record<LearningEntryView['kind'], LearningLocaleKey>

/** The message a failed Remote action shows beside the entry. */
function failureText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** One entry row with the actions its list allows. */
function EntryRow({ entry, t, actions, busy, notice, children }: {
  readonly entry: LearningEntryView
  readonly t: Translate
  readonly actions: ReactNode
  readonly busy: boolean
  readonly notice: string | undefined
  readonly children?: ReactNode
}): ReactNode {
  return (
    <li className={css.entry} data-entry-id={entry.id} data-busy={busy ? 'true' : undefined}>
      <div className={css.entryMain}>
        <p className={css.entryText}>{entry.text}</p>
        <span className={css.entryMeta}>
          <Tag tone="info">{t(KIND_KEYS[entry.kind])}</Tag>
          {entry.status === 'promoted' ? <Tag tone="success">{t('statusPromoted')}</Tag> : null}
          {entry.status === 'stale' ? <Tag tone="neutral">{t('statusStale')}</Tag> : null}
          {entry.status === 'archived' ? <Tag tone="quiet">{t('statusArchived')}</Tag> : null}
          {entry.tags.map(tag => <Tag key={tag}>{tag}</Tag>)}
        </span>
        {notice === undefined ? null : <p className={css.notice} role="status">{notice}</p>}
        {children}
      </div>
      <div className={css.entryActions}>{actions}</div>
    </li>
  )
}

/** Inline editor for one entry's text; tags stay as they are. */
function EditForm({ t, busy, initial, onSave, onCancel }: {
  readonly t: Translate
  readonly busy: boolean
  readonly initial: string
  readonly onSave: (text: string) => void
  readonly onCancel: () => void
}): ReactNode {
  const [text, setText] = useState(initial)
  return (
    <form
      className={css.promoteForm}
      onSubmit={(event) => {
        event.preventDefault()
        onSave(text.trim())
      }}
    >
      <textarea className={css.editor} aria-label={t('edit')} value={text} rows={3} onChange={(event) => { setText(event.target.value) }} />
      <Button type="submit" variant="primary" size="sm" disabled={busy || text.trim().length === 0}>{t('editSave')}</Button>
      <Button size="sm" onClick={onCancel} disabled={busy}>{t('editCancel')}</Button>
    </form>
  )
}

/** One skill row: name, description, and an editor that opens on request. */
function SkillRow({ skill, t, busy, notice, opened, content, onOpen, onClose, onSave, onDelete }: {
  readonly skill: LearningSkillView
  readonly t: Translate
  readonly busy: boolean
  readonly notice: string | undefined
  readonly opened: boolean
  readonly content: string
  readonly onOpen: () => void
  readonly onClose: () => void
  readonly onSave: (content: string) => void
  readonly onDelete: () => void
}): ReactNode {
  const [draft, setDraft] = useState(content)
  useEffect(() => { setDraft(content) }, [content])
  return (
    <li className={css.entry} data-skill-name={skill.name} data-busy={busy ? 'true' : undefined}>
      <div className={css.entryMain}>
        <p className={css.entryText}><strong>{skill.name}</strong> — {skill.description}</p>
        {notice === undefined ? null : <p className={css.notice} role="status">{notice}</p>}
        {opened
          ? (
            <form className={css.promoteForm} onSubmit={(event) => { event.preventDefault(); onSave(draft) }}>
              <textarea
                className={css.editor}
                aria-label={skill.name}
                value={draft}
                rows={12}
                onChange={(event) => { setDraft(event.target.value) }}
              />
              <Button type="submit" variant="primary" size="sm" disabled={busy || draft.trim().length === 0}>{t('skillSave')}</Button>
              <Button size="sm" onClick={onClose} disabled={busy}>{t('skillClose')}</Button>
            </form>
          )
          : null}
      </div>
      <div className={css.entryActions}>
        {opened ? null : <Button size="sm" disabled={busy} onClick={onOpen}>{t('skillOpen')}</Button>}
        <Button size="sm" disabled={busy} onClick={onDelete}>{t('skillDelete')}</Button>
      </div>
    </li>
  )
}

/** Inline form that names the skill an entry is promoted to. */
function PromoteForm({ t, busy, onConfirm, onCancel }: {
  readonly t: Translate
  readonly busy: boolean
  readonly onConfirm: (name: string) => void
  readonly onCancel: () => void
}): ReactNode {
  const [name, setName] = useState('')
  return (
    <form
      className={css.promoteForm}
      onSubmit={(event) => {
        event.preventDefault()
        onConfirm(name.trim())
      }}
    >
      <label className={css.promoteLabel}>
        <span>{t('promoteNameLabel')}</span>
        <Input
          value={name}
          placeholder={t('promoteNamePlaceholder')}
          onChange={(event) => { setName(event.currentTarget.value) }}
          disabled={busy}
        />
      </label>
      <Button type="submit" variant="primary" size="sm" disabled={busy || name.trim().length === 0}>{t('promoteConfirm')}</Button>
      <Button size="sm" onClick={onCancel} disabled={busy}>{t('promoteCancel')}</Button>
    </form>
  )
}

/** One suggested cluster with an editable skill name and accept or dismiss actions. */
function SuggestionRow({ suggestion, t, busy, notice, onAccept, onDismiss }: {
  readonly suggestion: LearningSuggestionView
  readonly t: Translate
  readonly busy: boolean
  readonly notice: string | undefined
  readonly onAccept: (name: string) => void
  readonly onDismiss: () => void
}): ReactNode {
  const [name, setName] = useState(suggestion.name)
  return (
    <li className={css.entry} data-suggestion-id={suggestion.id} data-busy={busy ? 'true' : undefined}>
      <div className={css.entryMain}>
        <ul className={css.list}>
          {suggestion.entries.map(entry => <li key={entry.id} className={css.entryText}>{entry.text}</li>)}
        </ul>
        <form
          className={css.promoteForm}
          onSubmit={(event) => {
            event.preventDefault()
            onAccept(name.trim())
          }}
        >
          <label className={css.promoteLabel}>
            <span>{t('suggestionNameLabel')}</span>
            <Input value={name} onChange={(event) => { setName(event.currentTarget.value) }} disabled={busy} />
          </label>
          <Button type="submit" variant="primary" size="sm" disabled={busy || name.trim().length === 0}>{t('suggestionAccept')}</Button>
          <Button size="sm" onClick={onDismiss} disabled={busy}>{t('suggestionDismiss')}</Button>
        </form>
        {notice === undefined ? null : <p className={css.notice} role="status">{notice}</p>}
      </div>
    </li>
  )
}

/** Render candidates awaiting review above the remembered entries, with their actions. */
export function LearningSettingsTab({
  list, review, forget, update, skills, readSkill, writeSkill, deleteSkill, promote, curate, suggestions,
  acceptSuggestion, dismissSuggestion, t,
}: LearningSettingsTabProps): ReactNode {
  const [request, setRequest] = useState(0)
  const [state, setState] = useState<ViewState>({ status: 'loading' })
  const [busy, setBusy] = useState<string | null>(null)
  const [promoting, setPromoting] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [openSkill, setOpenSkill] = useState<{ readonly name: string; readonly content: string } | null>(null)
  const [notices, setNotices] = useState<Record<string, string>>({})
  const [curation, setCuration] = useState<string | undefined>(undefined)

  useEffect(() => {
    let current = true
    void Promise.resolve().then(() => Promise.all([list(), suggestions(), skills()])).then(
      ([snapshot, proposed, written]) => { if (current) setState({ status: 'ready', snapshot, suggestions: proposed, skills: written }) },
      () => { if (current) setState({ status: 'error' }) },
    )
    return () => { current = false }
  }, [list, suggestions, skills, request])

  const reload = (): void => { setRequest(value => value + 1) }
  const retry = (): void => {
    setState({ status: 'loading' })
    reload()
  }
  const notify = (id: string, text: string | undefined): void => {
    setNotices((current) => {
      const next = Object.fromEntries(Object.entries(current).filter(([key]) => key !== id))
      if (text !== undefined) next[id] = text
      return next
    })
  }
  const run = (id: string, action: () => Promise<void>, done?: string): void => {
    setBusy(id)
    notify(id, undefined)
    void action().then(
      () => {
        setBusy(null)
        setPromoting(null)
        setEditing(null)
        if (done !== undefined) notify(id, done)
        reload()
      },
      (error: unknown) => {
        setBusy(null)
        notify(id, t('actionFailed', { message: failureText(error) }))
      },
    )
  }

  if (state.status === 'loading') return <p className={css.status}>{t('loading')}</p>
  if (state.status === 'error') {
    return (
      <div className={css.failure}>
        <p>{t('error')}</p>
        <Button size="sm" onClick={retry}>{t('retry')}</Button>
      </div>
    )
  }
  const { candidates, recalled, curated } = state.snapshot
  const proposed = state.suggestions
  const written = state.skills
  const openSkillEditor = (name: string): void => {
    setBusy(name)
    notify(name, undefined)
    void readSkill(name).then(
      (content) => {
        setBusy(null)
        setOpenSkill({ name, content: content ?? '' })
      },
      (error: unknown) => {
        setBusy(null)
        notify(name, t('actionFailed', { message: failureText(error) }))
      },
    )
  }
  const runCuration = (): void => {
    setBusy('curate')
    setCuration(undefined)
    void curate().then(
      (report) => {
        setBusy(null)
        setCuration(t('curated', { stale: String(report.stale), archived: String(report.archived), merged: String(report.merged) }))
        reload()
      },
      (error: unknown) => {
        setBusy(null)
        setCuration(t('actionFailed', { message: failureText(error) }))
      },
    )
  }
  return (
    <div className={css.section}>
      {candidates.length === 0 ? null : (
        <section>
          <header className={css.heading}>
            <h3>{t('candidatesTitle')} ({candidates.length}{t('countUnit')})</h3>
            <p>{t('candidatesSubtitle')}</p>
          </header>
          {candidates.length === 0
            ? <p className={css.status}>{t('candidatesEmpty')}</p>
            : (
              <ul className={css.list}>
                {candidates.map(entry => (
                  <EntryRow
                    key={entry.id}
                    entry={entry}
                    t={t}
                    busy={busy === entry.id}
                    notice={notices[entry.id]}
                    actions={(
                      <>
                        <Button variant="primary" size="sm" disabled={busy !== null} onClick={() => { run(entry.id, () => review(entry.id, 'approve')) }}>{t('approve')}</Button>
                        <Button size="sm" disabled={busy !== null} onClick={() => { run(entry.id, () => review(entry.id, 'reject')) }}>{t('reject')}</Button>
                      </>
                    )}
                  />
                ))}
              </ul>
            )}
        </section>
      )}
      <section>
        <header className={css.heading}>
          <h3>{t('learnedTitle')} ({recalled.length}{t('countUnit')})</h3>
          <p>{t('learnedSubtitle')}</p>
        </header>
        {recalled.length === 0
          ? <p className={css.status}>{t('learnedEmpty')}</p>
          : (
            <ul className={css.list}>
              {recalled.map(entry => (
                <EntryRow
                  key={entry.id}
                  entry={entry}
                  t={t}
                  busy={busy === entry.id}
                  notice={notices[entry.id]}
                  actions={(
                    <>
                      {editing === entry.id ? null : <Button size="sm" disabled={busy !== null} onClick={() => { setEditing(entry.id) }}>{t('edit')}</Button>}
                      {entry.status === 'promoted' || promoting === entry.id
                        ? null
                        : <Button size="sm" disabled={busy !== null} onClick={() => { setPromoting(entry.id) }}>{t('promote')}</Button>}
                      <Button size="sm" disabled={busy !== null} onClick={() => { run(entry.id, () => forget(entry.id)) }}>{t('forget')}</Button>
                    </>
                  )}
                >
                  {editing === entry.id
                    ? (
                      <EditForm
                        t={t}
                        busy={busy === entry.id}
                        initial={entry.text}
                        onSave={(text) => { run(entry.id, () => update(entry.id, text), t('edited')) }}
                        onCancel={() => { setEditing(null) }}
                      />
                    )
                    : null}
                  {promoting === entry.id
                    ? (
                      <PromoteForm
                        t={t}
                        busy={busy === entry.id}
                        onConfirm={(name) => { run(entry.id, () => promote(entry.id, name), t('promoted', { name })) }}
                        onCancel={() => { setPromoting(null) }}
                      />
                    )
                    : null}
                </EntryRow>
              ))}
            </ul>
          )}
      </section>
      <section>
        <header className={css.heading}>
          <h3>{t('skillsTitle')} ({written.length}{t('countUnit')})</h3>
          <p>{t('skillsSubtitle')}</p>
        </header>
        {written.length === 0
          ? <p className={css.status}>{t('skillsEmpty')}</p>
          : (
            <ul className={css.list}>
              {written.map(skill => (
                <SkillRow
                  key={skill.name}
                  skill={skill}
                  t={t}
                  busy={busy === skill.name}
                  notice={notices[skill.name]}
                  opened={openSkill?.name === skill.name}
                  content={openSkill?.name === skill.name ? openSkill.content : ''}
                  onOpen={() => { openSkillEditor(skill.name) }}
                  onClose={() => { setOpenSkill(null) }}
                  onSave={(content) => { run(skill.name, async () => { await writeSkill(skill.name, content); setOpenSkill(null) }, t('skillSaved', { name: skill.name })) }}
                  onDelete={() => { run(skill.name, async () => { await deleteSkill(skill.name); setOpenSkill(null) }, t('skillDeleted', { name: skill.name })) }}
                />
              ))}
            </ul>
          )}
      </section>
      <section>
        <header className={css.heading}>
          <h3>{t('suggestionsTitle')} ({proposed.length}{t('countUnit')})</h3>
          <p>{t('suggestionsSubtitle')}</p>
        </header>
        {proposed.length === 0
          ? <p className={css.status}>{t('suggestionsEmpty')}</p>
          : (
            <ul className={css.list}>
              {proposed.map(suggestion => (
                <SuggestionRow
                  key={suggestion.id}
                  suggestion={suggestion}
                  t={t}
                  busy={busy === suggestion.id}
                  notice={notices[suggestion.id]}
                  onAccept={(name) => {
                    run(suggestion.id, async () => { await acceptSuggestion(suggestion.id, name) }, t('suggestionAccepted', { name }))
                  }}
                  onDismiss={() => { run(suggestion.id, () => dismissSuggestion(suggestion.id)) }}
                />
              ))}
            </ul>
          )}
      </section>
      <section>
        <header className={css.heading}>
          <h3>{t('curatedTitle')} ({curated.length}{t('countUnit')})</h3>
          <p>{t('curatedSubtitle')}</p>
          <Button size="sm" disabled={busy !== null} onClick={runCuration}>{t('curate')}</Button>
          {curation === undefined ? null : <p className={css.notice} role="status">{curation}</p>}
        </header>
        {curated.length === 0
          ? <p className={css.status}>{t('curatedEmpty')}</p>
          : (
            <ul className={css.list}>
              {curated.map(entry => (
                <EntryRow
                  key={entry.id}
                  entry={entry}
                  t={t}
                  busy={busy === entry.id}
                  notice={notices[entry.id]}
                  actions={<Button size="sm" disabled={busy !== null} onClick={() => { run(entry.id, () => forget(entry.id)) }}>{t('forget')}</Button>}
                />
              ))}
            </ul>
          )}
      </section>
    </div>
  )
}
