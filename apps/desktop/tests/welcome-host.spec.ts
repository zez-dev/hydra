/** Native onboarding reuses authenticated Web RPC and never reads credential values. */
import { describe, expect, it, vi } from 'vitest'
import { connectDesktopWelcome } from '../src/welcome-backend.ts'

type Account = 'signed-out' | 'credential-stored' | 'absent'

function transport(preference?: string, account: Account = 'signed-out') {
  const keys = new Map<string, string>()
  const namespaces = [
    { ns: 'llm-deepseek', value: { apiKeyEnv: 'CUSTOM_DEEPSEEK_KEY' } },
    { ns: 'llm-pi-ai', value: { providers: {
      anthropic: { apiKeyEnv: 'ANTHROPIC_API_KEY' },
      acme: { apiKeyEnv: 'ACME_GATEWAY_KEY' },
      local: { baseURL: 'http://127.0.0.1:8000/v1' },
    } } },
    { ns: 'locale', value: preference === undefined ? {} : { preference } },
  ]
  const catalog = (provider: string, env: string[], endpoint: Record<string, unknown>) => ({
    provider, displayName: provider, settingsNs: 'llm-pi-ai', settingsPath: ['providers', provider],
    declared: false, ...endpoint, nativeAuth: { env, oauth: false },
  })
  const directory = [
    catalog('amazon-bedrock', ['AWS_PROFILE'], { baseURLEnv: ['AWS_REGION'] }),
    catalog('groq', ['GROQ_API_KEY'], { defaultBaseURL: 'https://api.groq.com/openai/v1' }),
    catalog('openai', ['OPENAI_API_KEY'], { defaultBaseURL: 'https://api.openai.com/v1' }),
    catalog('openai-codex', [], { defaultBaseURL: 'https://chatgpt.com/backend-api' }),
    { provider: 'acme', displayName: 'Acme Gateway', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'acme'], declared: true },
    { provider: 'local', displayName: 'Local', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'local'], declared: true },
    { ...catalog('anthropic', ['ANTHROPIC_API_KEY'], { defaultBaseURL: 'https://api.anthropic.com' }), displayName: 'Anthropic' },
    { provider: 'deepseek-account', displayName: 'DeepSeek Account', settingsNs: 'llm-deepseek-account', settingsPath: [] },
    { provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: [] },
  ]
  const calls: { method: string; args: Record<string, unknown> }[] = []
  let initializeFailure = false
  const send = vi.fn<Parameters<typeof connectDesktopWelcome>[1]>(async (_input, init) => {
    if (init?.method !== 'POST') return new Response('index')
    const { rpcId, method, payload } = JSON.parse(init.body as string) as {
      rpcId: string
      method: string
      payload: { args: { ref: string; value: string; refs: string[] } }
    }
    calls.push({ method, args: payload.args })
    let value: unknown
    if (method === 'account/getState') {
      // A Host composed without the account Remote refuses the request.
      if (account === 'absent') return new Response(null, { status: 404 })
      value = { links: { usageUrl: 'http://localhost/usage', topUpUrl: 'http://localhost/top_up' }, status: account, attempt: null }
    } else if (method === 'settings/describe') value = { namespaces }
    else if (method === 'llm/listConfigurableProviders') value = directory
    else if (method === 'productAnalytics/enabled') value = true
    else if (method === 'productAnalytics/report') value = undefined
    else if (method === 'credentials/set') keys.set(payload.args.ref, payload.args.value)
    else if (method === 'settings/mutate' || method === 'session/initializeDefaultModel') {
      if (method === 'session/initializeDefaultModel' && initializeFailure) {
        return Response.json({ type: 'server-response', rpcId, result: { ok: false, error: { code: 'session/provider-models-unavailable' } } })
      }
      value = undefined
    } else value = Object.fromEntries(payload.args.refs.map(ref => [ref, { configured: keys.has(ref), writable: true }]))
    return Response.json({ type: 'server-response', rpcId, result: { ok: true, value } })
  })
  return { send, keys, namespaces, calls, failInitialization: () => { initializeFailure = true } }
}

const url = 'http://127.0.0.1:19387/?token=fixture'

describe('desktop welcome Web operations', () => {
  it('authenticates through Web and stores only through the configured credential reference', async () => {
    const host = transport()
    const backend = await connectDesktopWelcome(url, host.send)
    expect(host.send).toHaveBeenCalledExactlyOnceWith(url, { credentials: 'include' })
    expect(await backend.analyticsEnabled()).toBe(true)
    expect(await backend.save('deepseek-official', 'sk-example')).toEqual({ ok: true })
    expect(host.keys.get('CUSTOM_DEEPSEEK_KEY')).toBe('sk-example')
    expect(host.calls.map(call => call.method)).not.toContain('settings/mutate')
    expect(host.calls.at(-1)).toEqual({ method: 'session/initializeDefaultModel', args: { provider: 'deepseek-official' } })
    expect(await backend.read()).toEqual({ loggedIn: false, hasApiKey: true, localePreference: null })
    for (const [input, init] of host.send.mock.calls.slice(1)) {
      expect(input).toMatch(/^http:\/\/127\.0\.0\.1:19387\/api\//u)
      expect(init).toMatchObject({ credentials: 'include', redirect: 'error' })
    }
  })

  it('offers Anthropic, DeepSeek, and OpenAI first, then the other providers a key alone configures', async () => {
    const host = transport()
    const backend = await connectDesktopWelcome(url, host.send)
    expect(await backend.providers()).toEqual([
      { provider: 'anthropic', displayName: 'Anthropic' },
      { provider: 'deepseek-official', displayName: 'DeepSeek' },
      { provider: 'openai', displayName: 'openai' },
      { provider: 'groq', displayName: 'groq' },
      { provider: 'acme', displayName: 'Acme Gateway' },
    ])
    expect(host.calls.map(call => call.method).filter(method => method.startsWith('credentials/'))).toEqual([])
  })

  it('names the derived reference in a catalog profile before storing its key', async () => {
    const host = transport()
    const backend = await connectDesktopWelcome(url, host.send)
    expect(await backend.save('openai', 'sk-openai')).toEqual({ ok: true })
    expect(host.calls.slice(-3)).toEqual([
      { method: 'settings/mutate', args: {
        ns: 'llm-pi-ai', ops: [{ op: 'set', path: ['providers', 'openai', 'apiKeyEnv'], value: 'OPENAI_API_KEY' }],
      } },
      { method: 'credentials/set', args: { ref: 'OPENAI_API_KEY', value: 'sk-openai' } },
      { method: 'session/initializeDefaultModel', args: { provider: 'openai' } },
    ])
    expect(await backend.save('anthropic', 'sk-ant')).toEqual({ ok: true })
    expect(host.keys.get('ANTHROPIC_API_KEY')).toBe('sk-ant')
    expect(host.calls.filter(call => call.method === 'settings/mutate')).toHaveLength(1)
  })

  it('keeps a stored key when the Host cannot move the default model', async () => {
    const host = transport()
    host.failInitialization()
    const backend = await connectDesktopWelcome(url, host.send)
    expect(await backend.save('anthropic', 'sk-ant')).toEqual({ ok: true })
    expect(host.keys.get('ANTHROPIC_API_KEY')).toBe('sk-ant')
  })

  it.each(['deepseek-account', 'amazon-bedrock', 'openai-codex', 'local', 'unknown'])(
    'refuses a provider a key alone does not configure: %s', async (provider) => {
      const host = transport()
      const backend = await connectDesktopWelcome(url, host.send)
      expect(await backend.save(provider, 'sk-example')).toEqual({ ok: false })
      expect(host.keys.size).toBe(0)
      expect(host.calls.map(call => call.method)).not.toContain('settings/mutate')
    },
  )

  it('reads the explicit language preference and recognizes another provider key', async () => {
    const host = transport('zh')
    host.keys.set('ACME_GATEWAY_KEY', 'sk-other')
    const backend = await connectDesktopWelcome(url, host.send)
    expect(await backend.read()).toMatchObject({ localePreference: 'zh', hasApiKey: true })
    host.keys.clear()
    expect(await backend.read()).toMatchObject({ hasApiKey: false })
    expect(host.send.mock.calls.every(([, init]) => !(init?.body as string | undefined)?.includes('credentials/set'))).toBe(true)
  })

  it.each([
    ['a stored account sign-in', 'credential-stored', true],
    ['a signed-out account', 'signed-out', false],
    ['a Host without the account Remote', 'absent', false],
  ] as const)('reads %s without failing the welcome', async (_case, account, loggedIn) => {
    const host = transport(undefined, account)
    const backend = await connectDesktopWelcome(url, host.send)
    expect(await backend.read()).toEqual({ loggedIn, hasApiKey: false, localePreference: null })
  })

  it('reads language without querying account or model providers', async () => {
    const host = transport('zh')
    const backend = await connectDesktopWelcome(url, host.send)
    host.send.mockClear()
    expect(await backend.readLocalePreference()).toBe('zh')
    expect(host.send).toHaveBeenCalledOnce()
    expect(host.send.mock.calls[0]![0]).toContain('/api/settings/describe')
  })

  it('allows profiles without the official provider and retains custom key detection', async () => {
    const host = transport()
    host.namespaces.splice(0, 1)
    const backend = await connectDesktopWelcome(url, host.send)
    expect(await backend.read()).toMatchObject({ hasApiKey: false })
    host.keys.set('ACME_GATEWAY_KEY', 'custom-key')
    expect(await backend.read()).toMatchObject({ hasApiKey: true })
    expect((await backend.providers()).map(choice => choice.provider)).not.toContain('deepseek-official')
    expect(await backend.save('deepseek-official', 'official-key')).toEqual({ ok: false })
    expect(host.keys.has('undefined')).toBe(false)
  })

  it.each(['', 'bad key', 'key\n'])('rejects malformed keys without contacting a provider: %s', async (value) => {
    const host = transport()
    const backend = await connectDesktopWelcome(url, host.send)
    host.send.mockClear()
    expect(await backend.save('anthropic', value)).toEqual({ ok: false })
    expect(host.send).not.toHaveBeenCalled()
  })

  it('keeps provider diagnostics out of failures and rejects unmatched RPC envelopes', async () => {
    const host = transport()
    const backend = await connectDesktopWelcome(url, host.send)
    host.send.mockRejectedValueOnce(new Error('private credential sk-must-not-leak'))
    expect(await backend.save('anthropic', 'sk-example')).toEqual({ ok: false })
    host.send.mockResolvedValueOnce(Response.json({ type: 'server-response', rpcId: 'other', result: { ok: true } }))
    await expect(backend.read()).rejects.toThrow('Web RPC failed')
  })

  it.each([
    [{ provider: 'broken', displayName: 'Broken', settingsNs: 'llm-pi-ai' }, 'invalid provider settings address'],
    [{ provider: 'broken', displayName: 'Broken', settingsNs: 'llm-pi-ai', settingsPath: [1] }, 'invalid provider settings path'],
  ])('refuses a malformed provider directory entry', async (entry, message) => {
    const host = transport()
    const backend = await connectDesktopWelcome(url, host.send)
    host.send.mockImplementationOnce(async (_input, init) => {
      const { rpcId } = JSON.parse(init!.body as string) as { rpcId: string }
      return Response.json({ type: 'server-response', rpcId, result: { ok: true, value: { namespaces: host.namespaces } } })
    }).mockImplementationOnce(async (_input, init) => {
      const { rpcId } = JSON.parse(init!.body as string) as { rpcId: string }
      return Response.json({ type: 'server-response', rpcId, result: { ok: true, value: [entry] } })
    })
    await expect(backend.providers()).rejects.toThrow(message)
  })

  it('submits native analytics through authenticated RPC with a bounded request', async () => {
    const host = transport()
    const backend = await connectDesktopWelcome(url, host.send)
    const event = { eventName: 'desktop_app_launch' as const, timestamp: 100, attributes: {} }
    await backend.report(event)
    const [input, init] = host.send.mock.calls.at(-1)!
    expect(input).toBe('http://127.0.0.1:19387/api/productAnalytics/report')
    expect(init?.credentials).toBe('include')
    expect(init?.signal).toBeInstanceOf(AbortSignal)
    expect(JSON.parse(init!.body as string)).toMatchObject({ payload: { args: { event } } })
  })

  it('refuses an unauthenticated Web launch', async () => {
    const send = vi.fn<Parameters<typeof connectDesktopWelcome>[1]>(async () => new Response(null, { status: 401 }))
    await expect(connectDesktopWelcome(url, send)).rejects.toThrow('Web authentication failed')
  })
})
