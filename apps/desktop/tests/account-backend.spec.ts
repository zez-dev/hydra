import { once } from 'node:events'
import { WebSocketServer } from 'ws'
import { expect, it, onTestFinished, vi } from 'vitest'
import { accountView, desktopAccountBackend } from '../src/account-backend.ts'

it('projects only safe account fields and refuses non-browser authorization schemes', () => {
  const state = { links: { usageUrl: 'http://localhost/usage', topUpUrl: 'http://localhost/top_up' }, status: 'signed-out', token: 'not-for-the-renderer',
    attempt: { id: 'test', phase: 'waiting-browser', authorizeUrl: 'https://platform.deepseek.com/dsh/authorize', codeVerifier: 'private' } }
  expect(accountView(state)).toEqual({ links: { usageUrl: 'http://localhost/usage', topUpUrl: 'http://localhost/top_up' }, status: 'signed-out', attempt: {
    id: 'test', phase: 'waiting-browser', authorizeUrl: 'https://platform.deepseek.com/dsh/authorize',
  } })
  for (const authorizeUrl of ['file:///tmp/example', 'javascript:alert(1)', 'http://example.com/login']) {
    expect(() => accountView({ ...state, attempt: { ...state.attempt, authorizeUrl } })).toThrow()
  }
  expect(() => accountView({ ...state, links: { usageUrl: 'file:///tmp/example', topUpUrl: 'https://example.com/top_up' } })).toThrow()
  expect(() => accountView({ ...state, attempt: { ...state.attempt, expiresAt: 'tomorrow' } })).toThrow()
  expect(() => accountView({ ...state, attempt: { ...state.attempt, errorCode: 'raw-server-message' } })).toThrow()
})

it('accepts a no-response login failure without discarding the account projection', () => {
  const state = { status: 'signed-out', attempt: { id: 'test', phase: 'failed', errorCode: 'no-response' },
    links: { usageUrl: 'https://platform.deepseek.com/usage', topUpUrl: 'https://platform.deepseek.com/top_up' } }
  expect(accountView(state)).toEqual(state)
})

it('reads account state without returning additional wire fields', async () => {
  const requests: unknown[] = []
  const backend = desktopAccountBackend('http://127.0.0.1:1234', (request) => {
    requests.push(request)
    return Promise.resolve({ links: { usageUrl: 'http://localhost/usage', topUpUrl: 'http://localhost/top_up' }, status: 'credential-stored', attempt: null, token: 'private' })
  }, () => Promise.resolve(''))
  expect(await backend.state()).toEqual({ links: { usageUrl: 'http://localhost/usage', topUpUrl: 'http://localhost/top_up' }, status: 'credential-stored', attempt: null })
  expect(requests).toEqual([{ namespace: 'account', method: 'getState', args: {} }])
})

it('does not replay an expiry reason from an account snapshot', () => {
  const state = { status: 'signed-out', attempt: null,
    links: { usageUrl: 'https://platform.deepseek.com/usage', topUpUrl: 'https://platform.deepseek.com/top_up' } }
  expect(accountView({ ...state, signOutReason: 'expired' })).toEqual(state)
})

it('receives live expiry separately from account snapshots', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await once(server, 'listening')
  onTestFinished(async () => {
    for (const client of server.clients) client.terminate()
    await new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve() }) })
  })
  const address = server.address()
  if (typeof address === 'string' || address === null) throw new Error('missing server address')
  const connected = once(server, 'connection')
  const expired = vi.fn()
  const onAnalyticsEnabledChanged = vi.fn()
  const snapshot = { status: 'signed-out', attempt: null,
    links: { usageUrl: 'https://platform.deepseek.com/usage', topUpUrl: 'https://platform.deepseek.com/top_up' } }
  const received = Promise.withResolvers<undefined>()
  const backend = desktopAccountBackend(`http://127.0.0.1:${address.port}`, () => Promise.resolve(snapshot), () => Promise.resolve(''))
  const stop = backend.watch(
    (value) => { expect(value).toEqual(snapshot); received.resolve(undefined) }, vi.fn(), expired, onAnalyticsEnabledChanged,
  )
  onTestFinished(stop)
  await connected
  // Logical streams share the socket; observe their opening frames before sending data.
  const streams = new Map<string, string>()
  const opened = Promise.withResolvers<undefined>()
  const socket = [...server.clients][0]!
  socket.on('message', (data) => {
    if (!Buffer.isBuffer(data)) throw new Error('expected a Buffer WebSocket frame')
    const frame = JSON.parse(data.toString('utf8')) as { endpoint: string; streamId: string }
    streams.set(frame.endpoint, frame.streamId)
    if (streams.size === 3) opened.resolve(undefined)
  })
  await opened.promise
  socket.send(JSON.stringify({ type: 'item', streamId: streams.get('account/watch'), value: snapshot }))
  await received.promise
  socket.send(JSON.stringify({ type: 'item', streamId: streams.get('productAnalytics/watchPolicy'), value: true }))
  await vi.waitFor(() => { expect(onAnalyticsEnabledChanged).toHaveBeenLastCalledWith(true) })
  socket.send(JSON.stringify({ type: 'item', streamId: streams.get('productAnalytics/watchPolicy'), value: false }))
  await vi.waitFor(() => { expect(onAnalyticsEnabledChanged).toHaveBeenLastCalledWith(false) })
  socket.send(JSON.stringify({ type: 'item', streamId: streams.get('productAnalytics/watchPolicy'), value: true }))
  await vi.waitFor(() => { expect(onAnalyticsEnabledChanged).toHaveBeenLastCalledWith(true) })
  socket.send(JSON.stringify({ type: 'item', streamId: streams.get('productAnalytics/watchPolicy'), value: 'invalid policy' }))
  await vi.waitFor(() => { expect(onAnalyticsEnabledChanged).toHaveBeenLastCalledWith(false) })
  expect(expired).not.toHaveBeenCalled()
  socket.send(JSON.stringify({ type: 'item', streamId: streams.get('account/watchExpiry'), value: 'session-expired' }))
  await vi.waitFor(() => { expect(expired).toHaveBeenCalledOnce() })
  stop()
})

/** A loopback Gateway stand-in that records each socket's opened streams. */
async function streamHost() {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await once(server, 'listening')
  onTestFinished(async () => {
    for (const client of server.clients) client.terminate()
    await new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve() }) })
  })
  const address = server.address()
  if (typeof address === 'string' || address === null) throw new Error('missing server address')
  const connections: { socket: import('ws').WebSocket; streams: Map<string, string> }[] = []
  server.on('connection', (socket) => {
    const streams = new Map<string, string>()
    connections.push({ socket, streams })
    socket.on('message', (data) => {
      if (!Buffer.isBuffer(data)) throw new Error('expected a Buffer WebSocket frame')
      const frame = JSON.parse(data.toString('utf8')) as { endpoint: string; streamId: string }
      streams.set(frame.endpoint, frame.streamId)
    })
  })
  return { origin: `http://127.0.0.1:${String(address.port)}`, connections }
}

it('keeps the policy stream and stops reopening account streams a Host does not serve', async () => {
  const host = await streamHost()
  const listener = vi.fn()
  const failed = vi.fn()
  const onAnalyticsEnabledChanged = vi.fn()
  const backend = desktopAccountBackend(host.origin, () => Promise.reject(new Error('unused')), () => Promise.resolve(''))
  const stop = backend.watch(listener, failed, vi.fn(), onAnalyticsEnabledChanged)
  onTestFinished(stop)
  await vi.waitFor(() => { expect(host.connections[0]?.streams.size).toBe(3) })
  const first = host.connections[0]!
  for (const endpoint of ['account/watchExpiry', 'account/watch']) {
    first.socket.send(JSON.stringify({ type: 'error', streamId: first.streams.get(endpoint),
      error: { code: 'gateway/invocation-unavailable', message: 'no active Remote method exports this endpoint', details: {} } }))
  }
  first.socket.send(JSON.stringify({ type: 'item', streamId: first.streams.get('productAnalytics/watchPolicy'), value: true }))
  await vi.waitFor(() => { expect(onAnalyticsEnabledChanged).toHaveBeenLastCalledWith(true) })
  expect(failed).not.toHaveBeenCalled()
  expect(host.connections).toHaveLength(1)
  // A transport failure reconnects with the policy stream alone.
  first.socket.terminate()
  await vi.waitFor(() => { expect(host.connections[1]?.streams.size).toBe(1) }, { timeout: 5000 })
  expect([...host.connections[1]!.streams.keys()]).toEqual(['productAnalytics/watchPolicy'])
  expect(failed).toHaveBeenCalledOnce()
  expect(listener).not.toHaveBeenCalled()
})

it('closes without reconnecting when nothing but the absent account streams was requested', async () => {
  const host = await streamHost()
  const failed = vi.fn()
  const backend = desktopAccountBackend(host.origin, () => Promise.reject(new Error('unused')), () => Promise.resolve(''))
  const stop = backend.watch(vi.fn(), failed, vi.fn())
  onTestFinished(stop)
  await vi.waitFor(() => { expect(host.connections[0]?.streams.size).toBe(2) })
  const first = host.connections[0]!
  const closed = once(first.socket, 'close')
  first.socket.send(JSON.stringify({ type: 'error', streamId: first.streams.get('account/watch'),
    error: { code: 'gateway/service-unavailable', message: 'active Service "account" is unavailable', details: {} } }))
  await closed
  await new Promise(resolve => setTimeout(resolve, 1200))
  expect(host.connections).toHaveLength(1)
  expect(failed).not.toHaveBeenCalled()
})

it('reconnects after an account stream failure the Host may recover from', async () => {
  const host = await streamHost()
  const backend = desktopAccountBackend(host.origin, () => Promise.reject(new Error('unused')), () => Promise.resolve(''))
  const stop = backend.watch(vi.fn(), vi.fn(), vi.fn(), vi.fn())
  onTestFinished(stop)
  await vi.waitFor(() => { expect(host.connections[0]?.streams.size).toBe(3) })
  const first = host.connections[0]!
  first.socket.send(JSON.stringify({ type: 'error', streamId: first.streams.get('account/watch'),
    error: { code: 'gateway/internal', message: 'account store failed', details: {} } }))
  await vi.waitFor(() => { expect(host.connections[1]?.streams.size).toBe(3) }, { timeout: 5000 })
})
