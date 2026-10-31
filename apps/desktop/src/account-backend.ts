/** Native account state read and Gateway state stream; no renderer receives credentials. */
import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import { parseRemoteStreamServerMessage, REMOTE_STREAM_MUX_PATH } from '@deepseek-ai/dsh-api-gateway/stream-protocol'
import type { AccountView } from '@deepseek-ai/dsh-deepseek-account/types'

/** Authenticated unary caller shared with native onboarding. */
export type AccountInvoke = (request: { namespace: string; method: string; args: Record<string, unknown> }) => Promise<unknown>

/** Decode the UI-safe state received across HTTP or WebSocket. @param value - wire value. @returns account projection. */
export function accountView(value: unknown): AccountView {
  if (typeof value !== 'object' || value === null || !('status' in value)
    || !['signed-out', 'credential-stored'].includes(String(value.status)) || !('attempt' in value)) {
    throw new Error('desktop account: invalid state')
  }
  if (!('links' in value) || typeof value.links !== 'object' || value.links === null
    || !('usageUrl' in value.links) || typeof value.links.usageUrl !== 'string'
    || !('topUpUrl' in value.links) || typeof value.links.topUpUrl !== 'string') {
    throw new Error('desktop account: invalid platform links')
  }
  validateBrowserDestination(value.links.usageUrl)
  validateBrowserDestination(value.links.topUpUrl)
  const attempt = value.attempt
  if (attempt !== null && (typeof attempt !== 'object' || !('id' in attempt) || typeof attempt.id !== 'string'
    || !('phase' in attempt) || !['initializing', 'waiting-browser', 'exchanging', 'committing', 'succeeded', 'cancelled', 'expired', 'failed'].includes(String(attempt.phase))
    || ('authorizeUrl' in attempt && typeof attempt.authorizeUrl !== 'string')
    || ('expiresAt' in attempt && (typeof attempt.expiresAt !== 'number' || !Number.isFinite(attempt.expiresAt)))
    || ('errorCode' in attempt && !['no-response', 'network', 'protocol', 'expired', 'storage'].includes(String(attempt.errorCode))))) {
    throw new Error('desktop account: invalid attempt')
  }
  if (attempt !== null && 'authorizeUrl' in attempt) {
    validateBrowserDestination(String(attempt.authorizeUrl))
  }
  const parsed = value as AccountView
  return {
    status: parsed.status,
    links: { usageUrl: parsed.links.usageUrl, topUpUrl: parsed.links.topUpUrl },
    attempt: parsed.attempt === null ? null : {
      id: parsed.attempt.id, phase: parsed.attempt.phase,
      ...parsed.attempt.authorizeUrl === undefined ? {} : { authorizeUrl: parsed.attempt.authorizeUrl },
      ...parsed.attempt.expiresAt === undefined ? {} : { expiresAt: parsed.attempt.expiresAt },
      ...parsed.attempt.errorCode === undefined ? {} : { errorCode: parsed.attempt.errorCode },
    },
  }
}

/** Only HTTP loopback or HTTPS destinations can leave the native app. */
function validateBrowserDestination(value: string): void {
  const url = new URL(value)
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.username || url.password || !(url.protocol === 'https:' || (loopback && url.protocol === 'http:'))) {
    throw new Error('desktop account: invalid browser destination')
  }
}

/**
 * Gateway refusals of a stream endpoint no mounted Remote serves. A Host composed
 * without the DeepSeek account Remote answers the account streams with one of these,
 * and reopening them cannot succeed.
 */
const ABSENT_REMOTE_CODES: ReadonlySet<string> = new Set([
  'gateway/invocation-unavailable', 'gateway/service-unavailable',
  'gateway/definition-unavailable', 'gateway/method-unavailable',
])

/** Native account operations and explicitly owned stream lifetime. */
export interface DesktopAccountBackend {
  /** @returns current account snapshot. */
  state(): Promise<AccountView>
  /**
   * Watch account state, credential expiry, and the optional collection policy over one socket.
   * When the Host refuses the account streams as absent, the watch keeps only the policy stream.
   * @param listener - state recipient.
   * @param failed - stream failure recipient.
   * @param expired - live credential-expiry recipient.
   * @param onAnalyticsEnabledChanged - optional Desktop collection-policy recipient; disconnected streams publish false.
   * @returns stream disposer.
   */
  watch(
    listener: (state: AccountView) => void, failed: () => void, expired: () => void,
    onAnalyticsEnabledChanged?: (enabled: boolean) => void,
  ): () => void
}

/**
 * Connect native account reads to the standard authenticated Web backend.
 * @param origin - Host Web origin.
 * @param invoke - validated unary RPC caller.
 * @param cookies - Electron session cookie reader.
 * @returns account reads; watch callers own their subscriptions.
 */
export function desktopAccountBackend(origin: string, invoke: AccountInvoke, cookies: () => Promise<string>): DesktopAccountBackend {
  return {
    state: async () => accountView(await invoke({ namespace: 'account', method: 'getState', args: {} })),
    watch(listener, failed, expired, onAnalyticsEnabledChanged) {
      let closed = false
      let socket: WebSocket | undefined
      let retry: ReturnType<typeof setTimeout> | undefined
      // Set once the Host refuses the account streams as absent; later connections skip them.
      let accountAbsent = false
      const connect = (): void => {
        const streamId = randomUUID()
        const expiryStreamId = randomUUID()
        const analyticsPolicyStreamId = randomUUID()
        void cookies().then((cookie) => {
          if (closed) return
          const url = new URL(REMOTE_STREAM_MUX_PATH, origin)
          url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
          socket = new WebSocket(url, { headers: { cookie, origin }, maxPayload: 65_536 })
          socket.on('open', () => {
            if (onAnalyticsEnabledChanged !== undefined) socket?.send(JSON.stringify({ type: 'open', streamId: analyticsPolicyStreamId, endpoint: 'productAnalytics/watchPolicy', payload: { args: {} } }))
            if (accountAbsent) return
            socket?.send(JSON.stringify({ type: 'open', streamId: expiryStreamId, endpoint: 'account/watchExpiry', payload: { args: {} } }))
            socket?.send(JSON.stringify({ type: 'open', streamId, endpoint: 'account/watch', payload: { args: {} } }))
          })
          socket.on('message', (data) => {
            try {
              const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data)
              const frame = parseRemoteStreamServerMessage(bytes.toString('utf8'))
              if (frame.streamId === analyticsPolicyStreamId) {
                if (frame.type === 'item' && typeof frame.value === 'boolean') onAnalyticsEnabledChanged?.(frame.value)
                else onAnalyticsEnabledChanged?.(false)
                return
              }
              if ((frame.streamId === streamId || frame.streamId === expiryStreamId)
                && frame.type === 'error' && ABSENT_REMOTE_CODES.has(frame.error.code)) {
                accountAbsent = true
                // Without a policy recipient nothing is left to watch on this Host.
                if (onAnalyticsEnabledChanged === undefined) { closed = true; socket?.close() }
                return
              }
              if (frame.streamId === expiryStreamId && frame.type === 'item' && frame.value === 'session-expired') { expired(); return }
              if (frame.streamId !== streamId) throw new Error('desktop account: unexpected stream')
              if (frame.type === 'item') listener(accountView(frame.value))
              else socket?.close()
            } catch { socket?.close() }
          })
          socket.on('error', () => { socket?.close() })
          socket.on('close', () => { if (!closed) { onAnalyticsEnabledChanged?.(false); failed(); retry = setTimeout(connect, 1000) } })
        }).catch(() => { if (!closed) { onAnalyticsEnabledChanged?.(false); failed(); retry = setTimeout(connect, 1000) } })
      }
      connect()
      return () => { closed = true; onAnalyticsEnabledChanged?.(false); clearTimeout(retry); socket?.close() }
    },
  }
}
