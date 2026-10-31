/** Desktop welcome presentation; provider and credential operations stay in the preload. */
import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Toast } from '@deepseek-ai/dsh-client-ui-primitives/src/Toast.tsx'
import type { WelcomeApi, WelcomeProvider } from '../welcome-api.ts'
import { HYDRA_DISCLAIMER_URL } from '../disclaimer.ts'

type Page = 'entry' | 'key'

/** The provider choices: undefined while they load, null after a failed read. */
type ProviderChoices = readonly WelcomeProvider[] | undefined | null

/**
 * Render the standalone welcome flow using shell-owned operations and localized copy.
 * The key step lists the providers the shell reports, preselecting the first.
 * @param props.api - isolated preload API; the typed key is the only credential the renderer holds.
 * @returns welcome pages with fixed bottom actions.
 */
export function Welcome({ api }: { api: WelcomeApi }) {
  const { messages: m } = api
  const [expiryNotice, setExpiryNotice] = useState(false)
  const [page, setPage] = useState<Page>('entry')
  const visiblePage = useRef<Page>('entry')
  const [providers, setProviders] = useState<ProviderChoices>(undefined)
  const [provider, setProvider] = useState('')
  const [draft, setDraft] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const mounted = useRef(true)
  const input = useRef<HTMLInputElement>(null)
  const keyButton = useRef<HTMLButtonElement>(null)
  const focusEntry = useRef(false)

  function loadProviders(): void {
    setProviders(undefined)
    void api.providers().then((choices) => {
      if (!mounted.current) return
      setProviders(choices)
      setProvider(current => choices.some(choice => choice.provider === current) ? current : choices[0]?.provider ?? '')
    }, (_unavailable: unknown) => {
      // The key step reports the failure; Set up later stays available.
      if (mounted.current) setProviders(null)
    })
  }

  useEffect(() => {
    mounted.current = true
    document.documentElement.lang = api.id
    document.title = m.welcomeTitle
    const takeNotice = (): void => {
      void api.takeNotice().then((notice) => {
        if (mounted.current && notice === 'session-expired') setExpiryNotice(true)
      }).catch((_closedChannel: unknown) => {
        // A closed Welcome IPC channel must not interrupt the welcome page.
      })
    }
    takeNotice()
    loadProviders()
    const stop = api.onNotice(takeNotice)
    return () => { mounted.current = false; stop() }
  }, [api, m.welcomeTitle])

  useEffect(() => {
    if (page === 'entry' && visiblePage.current !== 'entry') void api.analytics?.('auth_page_view', {})
    visiblePage.current = page
    if (page === 'key') input.current?.focus()
    else if (focusEntry.current) {
      focusEntry.current = false
      keyButton.current?.focus()
    }
  }, [page, api])

  function openKey(): void {
    void api.analytics?.('auth_page_click', { button_name: 'api-key' })
    if (providers === null) loadProviders()
    setError('')
    setPage('key')
  }
  async function saveKey(event: FormEvent) {
    event.preventDefault()
    if (busyRef.current || provider === '') return
    void api.analytics?.('api_key_save_click', {})
    const value = draft.trim()
    if (!/^[\x21-\x7e]+$/.test(value) || /^[A-Z][A-Z0-9_]*=[^=]/.test(value)
      || ((value.startsWith('"') || value.startsWith("'") || value.charCodeAt(0) === 96) && value.at(-1) === value[0])) {
      setError(value === '' ? m.welcomeKeyBlank : m.welcomeKeyInvalid)
      input.current?.focus()
      return
    }
    busyRef.current = true
    setBusy(true)
    setError('')
    try {
      const result = await api.saveApiKey(provider, value)
      if (!mounted.current) return
      if (result.ok) setDraft('')
      else setError(m.welcomeKeyFailed)
    } catch {
      if (mounted.current) setError(m.welcomeKeyFailed)
    } finally {
      busyRef.current = false
      if (mounted.current) setBusy(false)
    }
  }
  async function skip() {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    try {
      await api.skip()
      if (mounted.current) setDraft('')
    } catch {
      if (mounted.current) setError(m.welcomeContinueFailed)
    } finally {
      busyRef.current = false
      if (mounted.current) setBusy(false)
    }
  }

  const unavailable = providers === null || providers?.length === 0
  const shownError = error !== '' ? error : unavailable ? m.welcomeProvidersFailed : ''
  const heading = page === 'entry' ? 'welcome-heading' : 'key-title'

  return <>
    {expiryNotice && <Toast text={m.welcomeSessionExpired} onDone={() => { setExpiryNotice(false) }} />}
    <div className="titlebar" aria-hidden="true" />
    <main className="welcome" aria-labelledby={heading}>
      <img className="brand" src="assets/welcome-brand.svg" alt={m.welcomeBrand} width="472" height="40" />
      <div id="tagline" className="tagline" hidden={page !== 'entry'}>
        <h1 id="welcome-heading"><span>{m.welcomeTaglineBefore}</span><em>{m.welcomeTaglineBrand}</em><span>{m.welcomeTaglineAfter}</span></h1>
        <p id="welcome-description">{m.welcomeDescription}</p>
      </div>
      <form id="key-form" className="key-form" hidden={page !== 'key'} noValidate onSubmit={(event) => { void saveKey(event) }} aria-busy={busy}>
        <header className="key-heading"><h1 id="key-title">{m.welcomeKeyTitle}</h1><p id="key-description">{m.welcomeKeyDescription}</p></header>
        <div className="key-field">
          <label className="visually-hidden" htmlFor="provider-select">{m.welcomeProviderLabel}</label>
          <div className="provider-field">
            <select id="provider-select" value={provider} disabled={busy || providers === undefined || unavailable}
              onChange={(event) => { setProvider(event.target.value); setError('') }}>
              {(providers ?? []).map(choice => <option key={choice.provider} value={choice.provider}>{choice.displayName}</option>)}
            </select>
          </div>
          <label className="visually-hidden" htmlFor="key-input">{m.welcomeKeyPlaceholder}</label>
          <input ref={input} id="key-input" type="password" autoComplete="new-password" autoCapitalize="off" spellCheck={false} required
            aria-describedby="key-description key-error" aria-invalid={error !== ''} placeholder={m.welcomeKeyPlaceholder}
            value={draft} disabled={busy} onChange={(event) => { setDraft(event.target.value); setError('') }} />
          <p id="key-error" className="key-error" role="alert" hidden={shownError === ''}>{shownError}</p>
        </div>
      </form>
      <div id="entry-actions" className="actions" hidden={page !== 'entry'}>
        <button ref={keyButton} id="api-key" className="primary" type="button" onClick={openKey}>{m.welcomeApiKey}</button>
        <button id="skip-entry" className="secondary" type="button" disabled={busy} onClick={() => { void skip() }}>{m.welcomeKeyLater}</button>
        <p id="entry-error" className="actions-error" role="alert" hidden={page !== 'entry' || error === ''}>{error}</p>
        <p id="disclaimer" className="disclaimer">
          {m.disclaimer} <a href={HYDRA_DISCLAIMER_URL} target="_blank" rel="noreferrer">{m.disclaimerLink}</a>
        </p>
      </div>
      <div id="key-actions" className="actions" hidden={page !== 'key'}>
        <button id="save-key" className="primary" type="submit" form="key-form" disabled={busy || provider === '' || draft.trim() === ''}>{m.welcomeKeySave}</button>
        <button id="skip-key" className="secondary" type="button" disabled={busy} onClick={() => { void skip() }}>{m.welcomeKeyLater}</button>
        <button id="back-to-entry" className="back" type="button" disabled={busy} onClick={() => {
          if (busyRef.current) return
          setDraft(''); setError(''); focusEntry.current = true; setPage('entry')
        }}>{m.welcomeKeyBack}</button>
      </div>
    </main>
  </>
}
