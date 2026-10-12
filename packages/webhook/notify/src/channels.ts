/**
 * Channel transports: how one {@link NotificationPayload} becomes an HTTP request.
 * @module
 */

import type { NotificationPayload, NotifyChannel } from './types.ts'

/** Default Telegram Bot API base. */
export const TELEGRAM_API = 'https://api.telegram.org'

/**
 * Render a notification as one plain-text block for chat channels.
 * @param payload - the notification.
 * @returns title, text, and session on separate lines.
 */
export function renderNotification(payload: NotificationPayload): string {
  const lines = [payload.title]
  if (payload.text.length > 0) lines.push(payload.text)
  if (payload.sessionId !== undefined) lines.push(`session: ${payload.sessionId}`)
  return lines.join('\n')
}

/** A prepared HTTP request. */
export interface ChannelRequest {
  readonly url: string
  readonly headers: Record<string, string>
  readonly body: string
}

/**
 * Build the request for one channel.
 * @param channel - the destination.
 * @param payload - the notification.
 * @param secret - the resolved credential for channels that need one.
 * @returns the request, or `undefined` when the channel needs a secret that is missing.
 */
export function buildRequest(channel: NotifyChannel, payload: NotificationPayload, secret: string | undefined): ChannelRequest | undefined {
  switch (channel.kind) {
    case 'webhook':
      return {
        url: channel.url,
        headers: { 'content-type': 'application/json', ...channel.headers ?? {} },
        body: JSON.stringify(payload),
      }
    case 'telegram': {
      if (secret === undefined || secret.length === 0) return undefined
      const base = (channel.apiBaseUrl ?? TELEGRAM_API).replace(/\/+$/u, '')
      return {
        url: `${base}/bot${secret}/sendMessage`,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: channel.chatId, text: renderNotification(payload) }),
      }
    }
    case 'discord':
      return {
        url: channel.url,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: renderNotification(payload) }),
      }
    default:
      return channel satisfies never
  }
}
