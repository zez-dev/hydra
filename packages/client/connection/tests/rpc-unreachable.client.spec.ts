import { describe, expect, it } from 'vitest'
import { CONNECTION_UNREACHABLE_CODE, createWebConnectionRpc, type RpcFetch } from '../src/client/rpc.ts'

/** A carrier over a fetch stand-in, so each failure mode is produced on purpose. */
function carrier(fetchImpl: RpcFetch) {
  return createWebConnectionRpc(fetchImpl)
}

function codeOf(error: unknown): unknown {
  return (error as { code?: unknown } | null)?.code
}

describe('createWebConnectionRpc transport failures', () => {
  it('tags a request that never reached a server, keeping the fetch rejection as cause', async () => {
    const network = new TypeError('Failed to fetch')
    const rpc = carrier(async () => { throw network })
    const failure = await rpc.call('/api', 'settings/mutate', { args: [] }).then(() => undefined, (error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    expect(codeOf(failure)).toBe(CONNECTION_UNREACHABLE_CODE)
    expect((failure as Error).cause).toBe(network)
    expect((failure as Error).message).toContain('never reached a server')
  })

  it('leaves a TypeError from response parsing untagged, because the Host did answer', async () => {
    const rpc = carrier(async () => new Response(JSON.stringify({ garbage: true }), { status: 200 }))
    const failure = await rpc.call('/api', 'settings/mutate', { args: [] }).then(() => undefined, (error: unknown) => error)
    expect(failure).toBeInstanceOf(TypeError)
    expect(codeOf(failure)).toBeUndefined()
  })

  it('rethrows an abort untouched so cancellation keeps its identity', async () => {
    const abort = new DOMException('The operation was aborted.', 'AbortError')
    const rpc = carrier(async () => { throw abort })
    const failure = await rpc.call('/api', 'settings/mutate', { args: [] }).then(() => undefined, (error: unknown) => error)
    // Same object, not a wrapper: a DOMException carries its own numeric
    // `code` (20 for AbortError), and that is exactly what must survive.
    expect(failure).toBe(abort)
    expect(codeOf(failure)).not.toBe(CONNECTION_UNREACHABLE_CODE)
  })
})
