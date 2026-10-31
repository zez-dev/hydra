import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'

const streamSimple = vi.hoisted(() => vi.fn())
/** Collections the adapter asked pi-ai for, and whether this host refuses them. */
const factory = vi.hoisted(() => ({ calls: 0, unavailable: false }))

vi.mock('@earendil-works/pi-ai/api/openai-completions.lazy', () => ({
  openAICompletionsApi: () => ({ stream: streamSimple, streamSimple }),
}))

// The collection factory is the pi-ai entry a host without pi-ai's runtime
// refuses: the browser Worker deployment's stub throws Node's
// ERR_FEATURE_UNAVAILABLE_ON_PLATFORM from it.
vi.mock('@earendil-works/pi-ai/providers/all', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@earendil-works/pi-ai/providers/all')>()
  return {
    ...actual,
    builtinModels: (...args: Parameters<typeof actual.builtinModels>) => {
      factory.calls += 1
      if (factory.unavailable) {
        throw Object.assign(new Error('pi-ai collections are unavailable on this platform'), {
          code: 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM',
        })
      }
      return actual.builtinModels(...args)
    },
  }
})

import { PiAiAdapter } from '../src/adapter.ts'
import { resolveProfiles } from '../src/config.ts'
import type { ResolvedPiAiProviderProfile } from '../src/config.ts'
import { memoryAuth } from './auth-double.ts'

afterEach(() => {
  streamSimple.mockReset()
  factory.calls = 0
  factory.unavailable = false
})

/** A hand-declared OpenAI-compatible route with one fully described model. */
const GATEWAY_ROUTE = {
  'local-gateway': {
    api: 'openai-completions',
    baseURL: 'http://127.0.0.1:9/v1',
    models: [{ id: 'local-model', contextWindow: 8192, maxTokens: 1024 }],
  },
}

function gatewayProfiles(): Map<string, ResolvedPiAiProviderProfile> {
  return resolveProfiles(structuredClone(GATEWAY_ROUTE))
}

function adapterOver(profiles: () => ReadonlyMap<string, ResolvedPiAiProviderProfile>): PiAiAdapter {
  return new PiAiAdapter({ profiles, resolveApiKey: () => Promise.resolve('test-key'), auth: memoryAuth() })
}

async function drain(adapter: PiAiAdapter): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of adapter.stream({
    provider: 'local-gateway',
    model: 'local-model',
    messages: [],
  })) chunks.push(chunk)
  return chunks
}

describe('pi-ai request collection', () => {
  it('answers provider and model reads from the profiles without building a collection', async () => {
    factory.unavailable = true
    const profiles = gatewayProfiles()
    const adapter = adapterOver(() => profiles)

    expect(adapter.providerInfo('local-gateway')).toEqual({ id: 'local-gateway', name: 'local-gateway' })
    expect(adapter.providerRetryPolicy('local-gateway')).toBe(profiles.get('local-gateway')?.retryPolicy)
    await expect(adapter.listModels('local-gateway')).resolves.toEqual([
      { provider: 'local-gateway', id: 'local-model', name: 'local-model', inputModalities: ['text'] },
    ])
    await expect(adapter.resolveModel('local-gateway', 'local-model')).resolves.toMatchObject({
      provider: 'local-gateway',
      id: 'local-model',
      context: { contextWindow: 8192 },
      defaultMaxTokens: 1024,
    })
    expect(factory.calls).toBe(0)
  })

  it('fails a request with the platform refusal when the host cannot build a collection', async () => {
    factory.unavailable = true
    const profiles = gatewayProfiles()

    await expect(drain(adapterOver(() => profiles))).rejects.toThrow('pi-ai collections are unavailable on this platform')
    expect(factory.calls).toBe(1)
    expect(streamSimple).not.toHaveBeenCalled()
  })

  it('lists no models for a route whose catalog failed and still serves the other routes', async () => {
    streamSimple.mockImplementation(() => { throw new Error('mock SDK boundary') })
    // A declared route without models resolves none, which a stored configuration keeps as a diagnostic.
    const profiles = resolveProfiles({
      ...structuredClone(GATEWAY_ROUTE),
      'undescribed-route': { api: 'openai-completions', baseURL: 'http://127.0.0.1:9/v1' },
    }, 'deferred')
    expect(profiles.get('undescribed-route')?.catalogError).toContain('resolves no models')
    const adapter = adapterOver(() => profiles)

    await expect(adapter.listModels('undescribed-route')).resolves.toEqual([])
    await drain(adapter)
    expect(streamSimple).toHaveBeenCalledOnce()
    expect(factory.calls).toBe(1)
  })

  it('builds one collection per configuration and a new one after a change', async () => {
    streamSimple.mockImplementation(() => { throw new Error('mock SDK boundary') })
    let profiles = gatewayProfiles()
    const adapter = adapterOver(() => profiles)

    await drain(adapter)
    await drain(adapter)
    expect(factory.calls).toBe(1)

    profiles = gatewayProfiles()
    await drain(adapter)
    expect(factory.calls).toBe(2)
    expect(streamSimple).toHaveBeenCalledTimes(3)
  })
})
