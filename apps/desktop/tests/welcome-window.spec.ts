import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveDesktopLocale } from '../src/locale.ts'
import { needsWelcome, WELCOME_IPC } from '../src/welcome-api.ts'

const electron = vi.hoisted(() => ({
  create: vi.fn<(options: unknown) => ReturnType<typeof createWindow>>(),
  root: '/desktop-app',
  openExternal: vi.fn<(url: string) => Promise<void>>(async () => {}),
  handlers: new Map<string, (event: unknown, value?: unknown, attributes?: unknown) => Promise<unknown>>(),
}))
vi.mock('electron', () => ({
  app: { getAppPath: () => electron.root },
  BrowserWindow: vi.fn(function (options: unknown) { return electron.create(options) }),
  ipcMain: {
    handle: (name: string, handler: (event: unknown, value?: unknown, attributes?: unknown) => Promise<unknown>) => {
      if (electron.handlers.has(name)) throw new Error(`duplicate IPC handler: ${name}`)
      electron.handlers.set(name, handler)
    },
    removeHandler: (name: string) => electron.handlers.delete(name),
  },
  shell: { openExternal: (url: string) => electron.openExternal(url) },
}))

const { openWelcomeWindow, welcomeWindowOptions } = await import('../src/welcome-window.ts')

function createWindow() {
  return {
    webContents: {
      mainFrame: {},
      setWindowOpenHandler: vi.fn<(handler: (details: { url: string }) => { action: string }) => void>(),
      on: vi.fn<(name: string, handler: (event: { preventDefault(): void }) => void) => void>(),
    },
    loadFile: vi.fn<(path: string) => Promise<undefined>>().mockResolvedValue(undefined),
    isDestroyed: vi.fn().mockReturnValue(false),
    destroy: vi.fn(),
    show: vi.fn(),
    once: vi.fn<(name: string, callback: () => void) => void>(),
  }
}

beforeEach(() => { electron.create.mockReset(); electron.openExternal.mockClear(); electron.handlers.clear() })

const operations = {
  analyticsEnabled: async () => true,
  takeNotice: async () => undefined,
  providers: async () => [{ provider: 'anthropic', displayName: 'Anthropic' }],
  saveApiKey: (_provider: string, _value: string) => Promise.resolve({ ok: true as const }),
  skip: () => Promise.resolve(),
}

describe('desktop welcome window', () => {
  it.each(['darwin', 'win32', 'linux'] as const)('keeps the %s preview fixed-size and sandboxed', (platform) => {
    const options = welcomeWindowOptions(platform, resolveDesktopLocale('zh-CN'))
    expect(options).toMatchObject({
      width: 600, height: 700, useContentSize: true, center: true, show: false,
      resizable: false, maximizable: false, fullscreenable: false,
      webPreferences: {
        nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true,
        additionalArguments: ['--dsh-welcome-locale=zh-CN'],
      },
    })
    expect(options.webPreferences?.preload).toMatch(/preload-welcome\.cjs$/u)
    if (platform === 'darwin') {
      expect(options.vibrancy).toBe('menu')
      expect(options.visualEffectState).toBe('active')
      expect(options.trafficLightPosition).toEqual({ x: 21, y: 21 })
    } else if (platform === 'win32') {
      expect(options.backgroundMaterial).toBe('acrylic')
      expect(options.titleBarOverlay).toMatchObject({ height: 42 })
    } else {
      expect(options.backgroundColor).toBe('#FFFFFF')
      expect(options.vibrancy).toBeUndefined()
      expect(options.backgroundMaterial).toBeUndefined()
    }
  })

  it('waits for its local document and blocks renderer navigation', async () => {
    const window = createWindow()
    const loaded = Promise.withResolvers<undefined>()
    window.loadFile.mockReturnValue(loaded.promise)
    electron.create.mockReturnValue(window)
    const opening = openWelcomeWindow(resolveDesktopLocale('en'), operations)
    expect(window.show).not.toHaveBeenCalled()
    expect(window.loadFile).toHaveBeenCalledWith(join(electron.root, 'renderer', 'welcome.html'))
    const openWindow = window.webContents.setWindowOpenHandler.mock.calls[0]![0]
    expect(openWindow({ url: 'https://example.com/' })).toEqual({ action: 'deny' })
    expect(electron.openExternal).not.toHaveBeenCalled()
    // Only the disclaimer link leaves the welcome window, through the default browser.
    expect(openWindow({ url: 'https://github.com/zez-dev/hydra#disclaimer' })).toEqual({ action: 'deny' })
    expect(electron.openExternal).toHaveBeenCalledExactlyOnceWith('https://github.com/zez-dev/hydra#disclaimer')
    const event = { preventDefault: vi.fn() }
    window.webContents.on.mock.calls[0]![1](event)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    loaded.resolve(undefined)
    expect(await opening).toBe(window)
    expect(window.show).toHaveBeenCalledOnce()
  })

  it('destroys a window whose document fails to load', async () => {
    const window = createWindow()
    window.loadFile.mockRejectedValue(new Error('missing welcome document'))
    electron.create.mockReturnValue(window)
    await expect(openWelcomeWindow(resolveDesktopLocale('en'), operations)).rejects.toThrow('missing welcome document')
    expect(window.destroy).toHaveBeenCalledOnce()
    expect(electron.handlers.size).toBe(0)
    expect(window.show).not.toHaveBeenCalled()
  })

  it('does not show a window closed while its document was loading', async () => {
    const window = createWindow()
    window.isDestroyed.mockReturnValue(true)
    electron.create.mockReturnValue(window)
    await openWelcomeWindow(resolveDesktopLocale('en'), operations)
    expect(window.show).not.toHaveBeenCalled()
    expect(window.destroy).not.toHaveBeenCalled()
  })

  it('accepts actions only from its own top frame and removes handlers on close', async () => {
    const window = createWindow()
    electron.create.mockReturnValue(window)
    const saveApiKey = vi.fn(operations.saveApiKey)
    const skip = vi.fn(operations.skip)
    const providers = vi.fn(operations.providers)
    const takeNotice = vi.fn(async () => 'session-expired' as const)
    await openWelcomeWindow(resolveDesktopLocale('en'), { ...operations, saveApiKey, skip, providers, takeNotice })
    const own = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
    const take = electron.handlers.get(WELCOME_IPC.takeNotice)!
    await expect(take({ ...own, senderFrame: {} })).rejects.toThrow('unowned frame')
    expect(takeNotice).not.toHaveBeenCalled()
    expect(await take(own)).toBe('session-expired')
    expect(takeNotice).toHaveBeenCalledOnce()
    const list = electron.handlers.get(WELCOME_IPC.providers)!
    await expect(list({ ...own, senderFrame: {} })).rejects.toThrow('unowned frame')
    expect(providers).not.toHaveBeenCalled()
    expect(await list(own)).toEqual([{ provider: 'anthropic', displayName: 'Anthropic' }])
    const save = electron.handlers.get(WELCOME_IPC.saveApiKey)!
    await expect(save({ sender: {}, senderFrame: {} }, 'anthropic', 'sk-test')).rejects.toThrow('unowned frame')
    await expect(save({ ...own, senderFrame: {} }, 'anthropic', 'sk-test')).rejects.toThrow('unowned frame')
    expect(await save(own, 'anthropic', 'bad key')).toEqual({ ok: false })
    expect(await save(own, 42, 'sk-test')).toEqual({ ok: false })
    expect(await save(own, 'sk-test')).toEqual({ ok: false })
    expect(saveApiKey).not.toHaveBeenCalled()
    expect(await save(own, 'anthropic', 'sk-test')).toEqual({ ok: true })
    expect(saveApiKey).toHaveBeenCalledExactlyOnceWith('anthropic', 'sk-test')
    await electron.handlers.get(WELCOME_IPC.skip)!(own)
    expect(skip).toHaveBeenCalledOnce()
    window.once.mock.calls[0]![1]()
    expect(electron.handlers.size).toBe(0)
  })

  it('does not show a superseded window when its delayed document finishes loading', async () => {
    const previous = createWindow()
    const current = createWindow()
    const loaded = Promise.withResolvers<undefined>()
    previous.loadFile.mockReturnValue(loaded.promise)
    electron.create.mockReturnValueOnce(previous).mockReturnValueOnce(current)
    const opening = openWelcomeWindow(resolveDesktopLocale('en'), operations)
    await openWelcomeWindow(resolveDesktopLocale('en'), operations)
    loaded.resolve(undefined)
    await opening
    expect(previous.show).not.toHaveBeenCalled()
    expect(current.show).toHaveBeenCalledOnce()
    previous.once.mock.calls[0]![1]()
    current.once.mock.calls[0]![1]()
  })

  it('replaces handlers before the previous native window emits closed', async () => {
    const previous = createWindow()
    const current = createWindow()
    electron.create.mockReturnValueOnce(previous).mockReturnValueOnce(current)
    const previousProviders = vi.fn(operations.providers)
    const currentProviders = vi.fn(operations.providers)
    await openWelcomeWindow(resolveDesktopLocale('en'), { ...operations, providers: previousProviders })
    const previousHandler = electron.handlers.get(WELCOME_IPC.providers)!
    const previousSender = { sender: previous.webContents, senderFrame: previous.webContents.mainFrame }
    await openWelcomeWindow(resolveDesktopLocale('en'), { ...operations, providers: currentProviders })
    const currentHandler = electron.handlers.get(WELCOME_IPC.providers)!
    await expect(previousHandler(previousSender)).rejects.toThrow('unowned frame')
    await expect(currentHandler(previousSender)).rejects.toThrow('unowned frame')
    previous.once.mock.calls[0]![1]()
    expect(electron.handlers.get(WELCOME_IPC.providers)).toBe(currentHandler)
    await currentHandler({ sender: current.webContents, senderFrame: current.webContents.mainFrame })
    expect(currentProviders).toHaveBeenCalledOnce()
    expect(previousProviders).not.toHaveBeenCalled()
    current.once.mock.calls[0]![1]()
    expect(electron.handlers.size).toBe(0)
  })

  it('shows the entry after logout only without a separately configured API key', () => {
    expect(needsWelcome({ loggedIn: true, hasApiKey: false })).toBe(false)
    expect(needsWelcome({ loggedIn: false, hasApiKey: false })).toBe(true)
    expect(needsWelcome({ loggedIn: false, hasApiKey: true })).toBe(false)
    expect(needsWelcome({ loggedIn: true, hasApiKey: true })).toBe(false)
  })
})

it('accepts only permitted event fields and reads the current policy over IPC', async () => {
  const window = createWindow()
  electron.create.mockReturnValue(window)
  const analytics = vi.fn(async () => {})
  let enabled = true
  await openWelcomeWindow(resolveDesktopLocale('en'), { ...operations, analytics, analyticsEnabled: async () => enabled })
  const own = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
  const policy = electron.handlers.get(WELCOME_IPC.analyticsEnabled)!
  expect(await policy(own)).toBe(true)
  enabled = false
  expect(await policy(own)).toBe(false)
  const report = electron.handlers.get(WELCOME_IPC.analytics)!
  await report(own, 'auth_page_click', { button_name: 'api-key' })
  expect(analytics).toHaveBeenLastCalledWith('auth_page_click', { button_name: 'api-key' })
  await expect(report(own, 'auth_page_click', { button_name: 'api-key', token: 'private' })).rejects.toThrow('invalid analytics')
  // The welcome offers no account sign-in, so its click is not an event it reports.
  await expect(report(own, 'auth_page_click', { button_name: 'sign_in' })).rejects.toThrow('invalid analytics')
  await expect(report(own, 'desktop_app_launch', {})).rejects.toThrow('invalid analytics')
  await expect(report(own, 'auth_page_view', null)).rejects.toThrow('invalid analytics')
  await report(own, 'api_key_save_click', {})
  expect(analytics).toHaveBeenLastCalledWith('api_key_save_click', {})
})
