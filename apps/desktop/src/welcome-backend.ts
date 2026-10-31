import type { ProductEvent } from '@deepseek-ai/dsh-client-product-analytics/types'
/** Native welcome operations using the shared Web authentication and RPC APIs. */

import { randomUUID } from 'node:crypto'
import { desktopAccountBackend, type DesktopAccountBackend } from './account-backend.ts'
import type { WelcomeProvider } from './welcome-api.ts'

/** Metadata needed before the native entry or workspace becomes visible. */
export interface WelcomeState {
  readonly loggedIn: boolean
  readonly hasApiKey: boolean
  readonly localePreference: string | null
}

/** Narrow operations available to the native welcome flow. */
export interface DesktopWelcomeBackend {
  /** @returns the current Host policy; every read observes live configuration. */
  analyticsEnabled(): Promise<boolean>
  readonly account: DesktopAccountBackend
  /** @param event - desktop-owned fields. @returns after local Host intake. */
  report(event: ProductEvent): Promise<void>
  /**
   * @returns Configured-key presence, account sign-in, and the shared language preference, without
   * credential values. A Host whose account state cannot be read reports no sign-in.
   */
  read(): Promise<WelcomeState>
  /** @returns The saved UI language without account or provider requests. */
  readLocalePreference(): Promise<string | null>
  /** @returns the providers an API key alone configures: Anthropic, DeepSeek, and OpenAI first, the rest in directory order. */
  providers(): Promise<readonly WelcomeProvider[]>
  /**
   * Store one provider's key, then make that provider's first model the default
   * while the available catalog does not list the saved default.
   * @param provider - route from {@link DesktopWelcomeBackend.providers}.
   * @param apiKey - User-entered provider key.
   * @returns A safe write outcome without provider diagnostics.
   */
  save(provider: string, apiKey: string): Promise<{ ok: boolean }>
}

/** Routes the provider choice lists first, in this order. */
const LEADING_PROVIDERS = ['anthropic', 'deepseek-official', 'openai']

/** One configurable-provider directory entry as the welcome reads it. */
interface DirectoryEntry {
  readonly provider: string
  readonly displayName: string
  readonly settingsNs: string
  readonly settingsPath: readonly string[]
  /** Whether the route is an installed catalog route at a fixed endpoint with key authentication, which a key alone configures. */
  readonly keyOnly: boolean
}

/** A provider the welcome configures, with the reference its key is stored under. */
interface KeyedProvider extends WelcomeProvider {
  readonly settingsNs: string
  readonly settingsPath: readonly string[]
  readonly ref: string
  /** Whether the profile already names {@link KeyedProvider.ref}; otherwise saving names it first. */
  readonly named: boolean
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function strings(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

/**
 * Decode one `llm/listConfigurableProviders` entry.
 * @param value - wire entry.
 * @returns the fields the welcome reads.
 */
function directoryEntry(value: unknown): DirectoryEntry {
  if (!record(value) || typeof value.provider !== 'string' || typeof value.displayName !== 'string'
    || typeof value.settingsNs !== 'string' || !Array.isArray(value.settingsPath)) {
    throw new Error('desktop welcome: invalid provider settings address')
  }
  if (!strings(value.settingsPath)) throw new Error('desktop welcome: invalid provider settings path')
  const nativeAuth = value.nativeAuth
  const nativeKeys = record(nativeAuth) && strings(nativeAuth.env) ? nativeAuth.env.length : 0
  return {
    provider: value.provider,
    displayName: value.displayName,
    settingsNs: value.settingsNs,
    settingsPath: value.settingsPath,
    keyOnly: value.declared === false && typeof value.defaultBaseURL === 'string'
      && value.baseURLEnv === undefined && nativeKeys > 0,
  }
}

/**
 * The reference a typed key is stored under when the profile names none; the
 * Models page derives the same name, so both surfaces store one provider's key once.
 * @param provider - provider route id.
 * @returns the derived reference name, e.g. `OPENAI_API_KEY`.
 */
function derivedKeyRef(provider: string): string {
  return `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
}

/**
 * Authenticate the native HTTP client through the Web application's launch URL.
 * @param authenticatedUrl - URL supplied by the running Desktop Host.
 * @param send - Electron session fetch, retaining the Web authentication cookie.
 * @returns metadata reads and write-only credential operations over standard RPC.
 */
export async function connectDesktopWelcome(
  authenticatedUrl: string,
  send: (input: string, init?: RequestInit) => Promise<Response>,
  cookies: () => Promise<string> = () => Promise.resolve(''),
): Promise<DesktopWelcomeBackend> {
  const origin = new URL(authenticatedUrl).origin
  const authenticated = await send(authenticatedUrl, { credentials: 'include' })
  await authenticated.body?.cancel()
  if (!authenticated.ok) throw new Error('desktop welcome: Web authentication failed')
  const invoke = async (
    request: { namespace: string; method: string; args: Record<string, unknown> },
    signal?: AbortSignal,
  ): Promise<unknown> => {
    const rpcId = randomUUID()
    const method = `${request.namespace}/${request.method}`
    const response = await send(new URL(`/api/${method}`, origin).href, {
      method: 'POST', credentials: 'include', redirect: 'error', ...(signal === undefined ? {} : { signal }),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args: request.args } }),
    })
    if (!response.ok) throw new Error('desktop welcome: Web request failed')
    const envelope: unknown = await response.json()
    if (!record(envelope) || envelope.type !== 'server-response' || envelope.rpcId !== rpcId
      || !record(envelope.result) || envelope.result.ok !== true) {
      throw new Error('desktop welcome: Web RPC failed')
    }
    return envelope.result.value
  }
  const account = desktopAccountBackend(origin, invoke, cookies)
  const namespaces = async (): Promise<unknown[]> => {
    const settings = await invoke({ namespace: 'settings', method: 'describe', args: {} })
    const views: unknown = record(settings) ? settings.namespaces : undefined
    if (!Array.isArray(views)) throw new Error('desktop welcome: missing settings namespaces')
    const list: unknown[] = views
    return list
  }
  const directory = async (): Promise<DirectoryEntry[]> => {
    const providers = await invoke({ namespace: 'llm', method: 'listConfigurableProviders', args: {} })
    if (!Array.isArray(providers)) throw new Error('desktop welcome: invalid provider directory')
    return providers.map(directoryEntry)
  }
  /** The credential reference a provider's resolved profile names, when it names one. */
  const namedRef = (views: unknown[], entry: DirectoryEntry): string | undefined => {
    const namespace: unknown = views.find((item: unknown) => record(item) && item.ns === entry.settingsNs)
    let value: unknown = record(namespace) ? namespace.value : undefined
    for (const key of entry.settingsPath) value = record(value) ? value[key] : undefined
    return record(value) && typeof value.apiKeyEnv === 'string' && value.apiKeyEnv.length > 0 ? value.apiKeyEnv : undefined
  }
  const localePreference = (views: unknown[]): string | null => {
    const locale: unknown = views.find((item: unknown) => record(item) && item.ns === 'locale')
    if (!record(locale) || !record(locale.value)
      || (locale.value.preference !== undefined && typeof locale.value.preference !== 'string')) {
      throw new Error('desktop welcome: invalid locale preference')
    }
    return locale.value.preference ?? null
  }
  const keyedProviders = async (): Promise<KeyedProvider[]> => {
    const [views, entries] = await Promise.all([namespaces(), directory()])
    const keyed = entries.flatMap((entry): KeyedProvider[] => {
      if (entry.provider === 'deepseek-account') return []
      const named = namedRef(views, entry)
      if (named === undefined && !entry.keyOnly) return []
      return [{
        provider: entry.provider, displayName: entry.displayName,
        settingsNs: entry.settingsNs, settingsPath: entry.settingsPath,
        ref: named ?? derivedKeyRef(entry.provider), named: named !== undefined,
      }]
    })
    const rank = (provider: string): number => {
      const index = LEADING_PROVIDERS.indexOf(provider)
      return index === -1 ? LEADING_PROVIDERS.length : index
    }
    return keyed.toSorted((left, right) => rank(left.provider) - rank(right.provider))
  }
  const signedIn = async (): Promise<boolean> => {
    try {
      return (await account.state()).status === 'credential-stored'
    } catch (_accountUnavailable: unknown) {
      // A Host composed without the DeepSeek account Remote, or one that cannot read it, holds no sign-in.
      return false
    }
  }
  const read = async (): Promise<WelcomeState> => {
    const [views, entries] = await Promise.all([namespaces(), directory()])
    const unique = [...new Set(entries.flatMap((entry) => {
      const ref = namedRef(views, entry)
      return ref === undefined ? [] : [ref]
    }))]
    const states: Record<string, unknown> = {}
    // credentials.describe accepts at most 64 references per request.
    for (let offset = 0; offset < unique.length; offset += 64) {
      const batch = await invoke({ namespace: 'credentials', method: 'describe', args: { refs: unique.slice(offset, offset + 64) } })
      if (!record(batch)) throw new Error('desktop welcome: invalid credential metadata')
      Object.assign(states, batch)
    }
    return {
      loggedIn: await signedIn(),
      hasApiKey: Object.values(states).some(value => record(value) && value.configured === true),
      localePreference: localePreference(views),
    }
  }
  return {
    account,
    read,
    async analyticsEnabled() {
      const enabled = await invoke({ namespace: 'productAnalytics', method: 'enabled', args: {} }, AbortSignal.timeout(1000))
      if (typeof enabled !== 'boolean') throw new Error('desktop analytics: invalid collection policy')
      return enabled
    },
    async report(event) { await invoke({ namespace: 'productAnalytics', method: 'report', args: { event } }, AbortSignal.timeout(1000)) },
    async readLocalePreference() {
      return localePreference(await namespaces())
    },
    async providers() {
      return (await keyedProviders()).map(({ provider, displayName }) => ({ provider, displayName }))
    },
    async save(provider, apiKey) {
      if (!/^[\x21-\x7e]+$/.test(apiKey)) return { ok: false }
      try {
        const target = (await keyedProviders()).find(entry => entry.provider === provider)
        if (target === undefined) return { ok: false }
        // The Models page writes the same reference into a profile that names none.
        if (!target.named) {
          await invoke({ namespace: 'settings', method: 'mutate', args: {
            ns: target.settingsNs, ops: [{ op: 'set', path: [...target.settingsPath, 'apiKeyEnv'], value: target.ref }],
          } })
        }
        await invoke({ namespace: 'credentials', method: 'set', args: { ref: target.ref, value: apiKey } })
      } catch {
        // Provider diagnostics may contain credentials; the native form owns failure copy.
        return { ok: false }
      }
      try {
        await invoke({ namespace: 'session', method: 'initializeDefaultModel', args: { provider } })
      } catch (_defaultUnchanged: unknown) {
        // The key is stored. A saved default the Host could not move stays, and the composer reports it unavailable.
      }
      return { ok: true }
    },
  }
}
