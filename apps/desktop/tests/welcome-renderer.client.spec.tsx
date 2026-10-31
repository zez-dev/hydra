// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Welcome } from '../src/client/WelcomePage.tsx'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveDesktopLocale } from '../src/locale.ts'
import type { WelcomeNotice, WelcomeProvider, WelcomeSaveResult } from '../src/welcome-api.ts'

const html = readFileSync(join(import.meta.dirname, '../renderer/welcome.html'), 'utf8')
afterEach(cleanup)

const PROVIDERS: readonly WelcomeProvider[] = [
  { provider: 'anthropic', displayName: 'Anthropic' },
  { provider: 'deepseek-official', displayName: 'DeepSeek' },
  { provider: 'openai', displayName: 'openai' },
]

function mount(
  language = 'zh-CN',
  takeNotice = vi.fn<() => Promise<WelcomeNotice | undefined>>().mockResolvedValue(undefined),
  providers = vi.fn<() => Promise<readonly WelcomeProvider[]>>().mockResolvedValue(PROVIDERS),
) {
  cleanup()
  const stopNotice = vi.fn()
  const api = {
    takeNotice,
    providers,
    analytics: vi.fn(async (_event: string, _attributes: object) => {}),
    analyticsEnabled: async () => true,
    onNotice: vi.fn((_listener: () => void) => stopNotice),
    ...resolveDesktopLocale(language),
    saveApiKey: vi.fn<(provider: string, value: string) => Promise<WelcomeSaveResult>>().mockResolvedValue({ ok: true }),
    skip: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  }
  const mounted = render(<Welcome api={api} />)
  const input = document.querySelector('input')!
  const select = document.querySelector('select')!
  const button = (id: string) => document.querySelector<HTMLButtonElement>(id)!
  const enterKey = (value: string) => {
    fireEvent.change(input, { target: { value } })
  }
  const choose = (provider: string) => {
    fireEvent.change(select, { target: { value: provider } })
  }
  const submit = () => fireEvent.submit(document.querySelector('form')!)
  const copy = () => {
    const heading = document.querySelector('main')!.getAttribute('aria-labelledby')!
    return [
      document.title, document.querySelector('img')!.alt, document.getElementById(heading)!.textContent,
      ...heading === 'welcome-heading' ? [document.querySelector('#welcome-description')!.textContent] : [],
      ...heading === 'key-title' ? [
        document.querySelector('#key-description')!.textContent,
        `${document.querySelector('label[for="provider-select"]')!.textContent} [select]${select.options.length === 0 ? ' [empty]'
          : `: ${[...select.options].map(option => `${option.textContent}${option.selected ? ' [selected]' : ''}`).join(', ')}`}`,
        `${input.placeholder} [password]`,
      ] : [],
      ...[...document.querySelectorAll('[role="alert"]')].filter(item => item.closest('[hidden]') === null)
        .map(item => `[alert] ${item.textContent}`),
      ...[...document.querySelectorAll('button')].filter(item => item.closest('[hidden]') === null)
        .map(item => `${item.textContent || item.getAttribute('aria-label')}${item.disabled ? ' [disabled]' : ''}`),
      ...[...document.querySelectorAll('#disclaimer')].filter(item => item.closest('[hidden]') === null)
        .map(item => `${item.textContent ?? ''} [${item.querySelector('a')!.getAttribute('href') ?? ''}]`),
      '',
    ].join('\n')
  }
  return { document, api, input, select, button, enterKey, choose, submit, copy, unmount: mounted.unmount, stopNotice }
}

/** Mount and wait until the provider choice has loaded. */
async function mounted(...args: Parameters<typeof mount>) {
  const view = mount(...args)
  await act(async () => {})
  return view
}

describe('desktop welcome presentation', () => {
  it.each(['zh-CN', 'en'])('renders the %s entry and API-key step', async (language) => {
    const view = await mounted(language)
    expect(view.document.documentElement.lang).toBe(language)
    expect(view.document.querySelector('img')!.getAttribute('src')).toBe('assets/welcome-brand.svg')
    // The disclaimer link opens through the window-open handler, which hands only this URL to the default browser.
    expect(view.document.querySelector('#disclaimer a')!.getAttribute('target')).toBe('_blank')
    await expect(view.copy()).toMatchFileSnapshot(`./expected/welcome/${language}.expected.txt`)
    fireEvent.click(view.button('#api-key'))
    expect(view.document.activeElement).toBe(view.input)
    expect(view.input.type).toBe('password')
    await expect(view.copy()).toMatchFileSnapshot(`./expected/welcome/${language}-api-key.expected.txt`)
  })

  it('offers no account sign-in on any page', async () => {
    const view = await mounted('en')
    const signIn = /sign in|log in/iu
    expect([...view.document.querySelectorAll('button')].map(item => item.textContent)).not.toContainEqual(expect.stringMatching(signIn))
    expect(view.document.querySelector('#sign-in, #auth-page, #auth-actions')).toBeNull()
    fireEvent.click(view.button('#api-key'))
    expect([...view.document.querySelectorAll('button')].map(item => item.textContent)).not.toContainEqual(expect.stringMatching(signIn))
    expect(view.api.messages).not.toHaveProperty('welcomeSignIn')
  })

  it('lists the providers in the shell order and preselects the first', async () => {
    const view = await mounted('en')
    fireEvent.click(view.button('#api-key'))
    expect([...view.select.options].map(option => [option.value, option.textContent])).toEqual([
      ['anthropic', 'Anthropic'], ['deepseek-official', 'DeepSeek'], ['openai', 'openai'],
    ])
    expect(view.select.value).toBe('anthropic')
    expect(view.select.disabled).toBe(false)
    expect(view.api.providers).toHaveBeenCalledOnce()
  })

  it('sends one trimmed key for the selected provider, prevents competing actions, and clears it after saving', async () => {
    const view = await mounted()
    const saved = Promise.withResolvers<WelcomeSaveResult>()
    view.api.saveApiKey.mockReturnValue(saved.promise)
    fireEvent.click(view.button('#api-key'))
    view.choose('deepseek-official')
    view.enterKey('  sk-desktop-example  ')
    view.submit()
    view.submit()
    fireEvent.click(view.button('#skip-key'))
    fireEvent.click(view.button('#back-to-entry'))
    expect(view.api.saveApiKey).toHaveBeenCalledExactlyOnceWith('deepseek-official', 'sk-desktop-example')
    expect(view.api.skip).not.toHaveBeenCalled()
    expect(view.button('#save-key').disabled).toBe(true)
    expect(view.button('#save-key').textContent).toBe(view.api.messages.welcomeKeySave)
    expect(view.button('#back-to-entry').disabled).toBe(true)
    expect(view.select.disabled).toBe(true)
    expect(view.document.querySelector<HTMLElement>('#key-form')!.hidden).toBe(false)
    saved.resolve({ ok: true })
    await vi.waitFor(() => { expect(view.input.value).toBe('') })
    expect(view.document.body.textContent).not.toContain('sk-desktop-example')
  })

  it('reports a failed provider read, keeps Set up later available, and reads again on the next key step', async () => {
    const providers = vi.fn<() => Promise<readonly WelcomeProvider[]>>().mockRejectedValueOnce(new Error('host unavailable'))
      .mockResolvedValue(PROVIDERS)
    const view = await mounted('en', undefined, providers)
    fireEvent.click(view.button('#api-key'))
    await act(async () => {})
    view.enterKey('sk-not-sent')
    await vi.waitFor(() => { expect(view.select.value).toBe('anthropic') })
    expect(providers).toHaveBeenCalledTimes(2)
    fireEvent.click(view.button('#back-to-entry'))

    providers.mockRejectedValue(new Error('host unavailable'))
    const failing = await mounted('en', undefined, providers)
    fireEvent.click(failing.button('#api-key'))
    await act(async () => {})
    await expect(failing.copy()).toMatchFileSnapshot('./expected/welcome/en-providers-failed.expected.txt')
    expect(failing.select.disabled).toBe(true)
    failing.enterKey('sk-not-sent')
    expect(failing.button('#save-key').disabled).toBe(true)
    failing.submit()
    expect(failing.api.saveApiKey).not.toHaveBeenCalled()
    fireEvent.click(failing.button('#skip-key'))
    expect(failing.api.skip).toHaveBeenCalledOnce()
  })

  it.each(['', 'bad key', '密钥', 'DEEPSEEK_API_KEY=sk-example', '"sk-example"', '`sk-example`'])(
    'rejects invalid input before sending it: %s', async (value) => {
      const view = await mounted()
      fireEvent.click(view.button('#api-key'))
      view.enterKey(value)
      view.submit()
      expect(view.api.saveApiKey).not.toHaveBeenCalled()
      expect(view.document.querySelector<HTMLElement>('#key-error')!.hidden).toBe(false)
      expect(view.input.getAttribute('aria-invalid')).toBe('true')
    },
  )

  it('retains an unsaved draft and allows retry after a refused save', async () => {
    const view = await mounted()
    view.api.saveApiKey.mockResolvedValue({ ok: false })
    fireEvent.click(view.button('#api-key'))
    view.enterKey('sk-retry')
    view.submit()
    await vi.waitFor(() => { expect(view.button('#save-key').disabled).toBe(false) })
    expect(view.input.value).toBe('sk-retry')
    expect(view.document.querySelector('#key-error')!.textContent).toBe(view.api.messages.welcomeKeyFailed)
    view.api.saveApiKey.mockResolvedValue({ ok: true })
    view.submit()
    await vi.waitFor(() => { expect(view.input.value).toBe('') })
  })

  it('skips without saving and starts a fresh renderer at the entry again', async () => {
    const view = await mounted()
    const skipped = Promise.withResolvers<undefined>()
    view.api.skip.mockReturnValue(skipped.promise)
    fireEvent.click(view.button('#api-key'))
    view.enterKey('sk-not-saved')
    fireEvent.click(view.button('#skip-key'))
    try {
      expect(view.button('#save-key').textContent).toBe(view.api.messages.welcomeKeySave)
      expect(view.button('#skip-key').textContent).toBe(view.api.messages.welcomeKeyLater)
      expect(view.button('#save-key').disabled).toBe(true)
      expect(view.button('#skip-key').disabled).toBe(true)
      expect(view.button('#back-to-entry').disabled).toBe(true)
      fireEvent.click(view.button('#skip-key'))
      view.submit()
      expect(view.api.skip).toHaveBeenCalledOnce()
      expect(view.api.saveApiKey).not.toHaveBeenCalled()
    } finally {
      skipped.resolve(undefined)
    }
    await vi.waitFor(() => { expect(view.input.value).toBe('') })
    expect(view.api.skip).toHaveBeenCalledOnce()
    expect(view.api.saveApiKey).not.toHaveBeenCalled()
    expect(mount().document.querySelector<HTMLElement>('#key-form')!.hidden).toBe(true)
  })

  it('sets up later from the entry and reports a failed workspace opening there', async () => {
    const view = await mounted('en')
    view.api.skip.mockRejectedValueOnce(new Error('workspace failed'))
    fireEvent.click(view.button('#skip-entry'))
    expect(view.button('#skip-entry').disabled).toBe(true)
    await vi.waitFor(() => { expect(view.button('#skip-entry').disabled).toBe(false) })
    expect(view.api.skip).toHaveBeenCalledOnce()
    expect(view.document.querySelector('#entry-error')!.textContent).toBe(view.api.messages.welcomeContinueFailed)
    expect(view.document.querySelector<HTMLElement>('#entry-error')!.hidden).toBe(false)
    fireEvent.click(view.button('#api-key'))
    expect(view.document.querySelector<HTMLElement>('#key-error')!.hidden).toBe(true)
    fireEvent.click(view.button('#back-to-entry'))
    fireEvent.click(view.button('#skip-entry'))
    await vi.waitFor(() => { expect(view.api.skip).toHaveBeenCalledTimes(2) })
    expect(view.api.saveApiKey).not.toHaveBeenCalled()
  })

  it('returns to the entry without saving and clears the draft and validation error', async () => {
    const view = await mounted()
    fireEvent.click(view.button('#api-key'))
    view.enterKey('invalid key')
    view.submit()
    fireEvent.click(view.button('#back-to-entry'))
    expect(view.document.querySelector<HTMLElement>('#key-form')!.hidden).toBe(true)
    expect(view.document.activeElement).toBe(view.button('#api-key'))
    expect(view.input.value).toBe('')
    expect(view.api.saveApiKey).not.toHaveBeenCalled()
    expect(view.api.skip).not.toHaveBeenCalled()
    fireEvent.click(view.button('#api-key'))
    expect(view.input.value).toBe('')
    expect(view.document.querySelector<HTMLElement>('#key-error')!.hidden).toBe(true)
    expect(view.button('#save-key').disabled).toBe(true)
  })

  it('keeps visible copy in the shell dictionaries and denies network access', () => {
    expect([...html.matchAll(/>([^<]*\p{L}[^<]*)</gu)]).toEqual([])
    expect(html).toContain("default-src 'none'")
    expect(html).toContain("form-action 'none'")
  })
})

it.each(['zh-CN', 'en'])('keeps the expiry notice visible after returning to Welcome: %s', async (language) => {
  vi.useFakeTimers()
  try {
    const takeNotice = vi.fn<() => Promise<WelcomeNotice | undefined>>().mockResolvedValue(undefined).mockResolvedValueOnce('session-expired')
    const view = mount(language, takeNotice)
    await act(async () => {})
    const notified = view.api.onNotice.mock.calls[0]![0]
    const notice = screen.getByRole('alert')
    expect(notice.textContent).toBe(view.api.messages.welcomeSessionExpired)
    await expect(`${notice.textContent}\n`).toMatchFileSnapshot(`./expected/welcome/${language}-expired.expected.txt`)
    expect(view.button('#api-key').closest('[hidden]')).toBeNull()
    await act(async () => { await vi.advanceTimersByTimeAsync(4000) })
    expect(screen.queryByRole('alert')).toBeNull()
    await act(async () => { notified() })
    expect(screen.queryByRole('alert')).toBeNull()
    view.unmount()
    expect(view.stopNotice).toHaveBeenCalledOnce()
    mount(language, takeNotice)
    await act(async () => {})
    expect(screen.queryByRole('alert')).toBeNull()
  } finally { cleanup(); vi.useRealTimers() }
})

it('takes a notice the main process signals after the window opened', async () => {
  const takeNotice = vi.fn<() => Promise<WelcomeNotice | undefined>>().mockResolvedValue(undefined)
  const view = await mounted('en', takeNotice)
  expect(screen.queryByRole('alert')).toBeNull()
  takeNotice.mockResolvedValueOnce('session-expired')
  await act(async () => { view.api.onNotice.mock.calls[0]![0]() })
  expect(screen.getByRole('alert').textContent).toBe(view.api.messages.welcomeSessionExpired)
})

it('keeps the entry usable when notification IPC fails', async () => {
  const view = mount('en', vi.fn<() => Promise<WelcomeNotice | undefined>>().mockRejectedValue(new Error('closed')))
  await act(async () => {})
  expect(screen.queryByRole('alert')).toBeNull()
  fireEvent.click(view.button('#api-key'))
  expect(view.input.closest('[hidden]')).toBeNull()
})

it('ignores a notification or provider list received after its renderer unmounts', async () => {
  const pending = Promise.withResolvers<WelcomeNotice | undefined>()
  const listed = Promise.withResolvers<readonly WelcomeProvider[]>()
  const view = mount('en', vi.fn<() => Promise<WelcomeNotice | undefined>>().mockReturnValue(pending.promise),
    vi.fn<() => Promise<readonly WelcomeProvider[]>>().mockReturnValue(listed.promise))
  view.unmount()
  mount('en')
  await act(async () => { pending.resolve('session-expired'); listed.resolve([{ provider: 'late', displayName: 'Late' }]) })
  expect(screen.queryByRole('alert')).toBeNull()
  expect(document.querySelector('option[value="late"]')).toBeNull()
})

it('reports each return to the welcome entry once', async () => {
  const view = await mounted()
  expect(view.api.analytics).not.toHaveBeenCalled()
  fireEvent.click(view.button('#api-key'))
  fireEvent.click(view.button('#back-to-entry'))
  expect(view.api.analytics.mock.calls).toEqual([
    ['auth_page_click', { button_name: 'api-key' }], ['auth_page_view', {}],
  ])
  view.enterKey('sk-counted')
  fireEvent.click(view.button('#api-key'))
  view.enterKey('sk-counted')
  view.submit()
  await vi.waitFor(() => { expect(view.api.saveApiKey).toHaveBeenCalledOnce() })
  expect(view.api.analytics.mock.calls.map(([action]) => action)).toEqual([
    'auth_page_click', 'auth_page_view', 'auth_page_click', 'api_key_save_click',
  ])
})
