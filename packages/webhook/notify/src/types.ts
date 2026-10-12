import type { SessionId } from '@deepseek-ai/dsh-session'

/** Events the plugin can announce. */
export type NotifyEvent =
  | 'goalBlocked'
  | 'goalCompleted'
  | 'transientRetriesExhausted'
  | 'sessionError'
  | 'cronRun'
  | 'spendBudgetReached'
  | 'researchBreakthrough'
  | 'dailyDigest'
  | 'weeklyDigest'
  | 'offPeakDrained'
  | 'test'

/** Per-event switches. */
export interface NotifyEvents {
  /** A goal entered `blocked` for any reason other than exhausted transient retries. */
  goalBlocked: boolean
  /** A goal completed. */
  goalCompleted: boolean
  /** The round driver blocked a goal with `transient-retries-exhausted`. */
  transientRetriesExhausted: boolean
  /** An agent turn or step errored. */
  sessionError: boolean
  /** A `dsh-cron-sessions` run finished, with its outcome. */
  cronRun: boolean
  /** `dsh-spend-guard` crossed a session or daily token budget. */
  spendBudgetReached: boolean
  /** `dsh-research` recorded a breakthrough in a journal. */
  researchBreakthrough: boolean
  /** `dsh-digest` wrote the day's report on its timer. */
  dailyDigest: boolean
  /** `dsh-digest` wrote the weekly review on its timer. */
  weeklyDigest: boolean
  /** `dsh-off-peak` finished draining a window's queue. */
  offPeakDrained: boolean
}

/** A generic HTTP endpoint receiving the JSON payload. */
export interface WebhookChannel {
  /** Channel name used by `/notify test` and in warnings. */
  name: string
  /** Transport discriminator. */
  kind: 'webhook'
  /** Destination URL. */
  url: string
  /** Extra request headers. */
  headers?: Record<string, string>
}

/** A Telegram bot chat. */
export interface TelegramChannel {
  /** Channel name used by `/notify test` and in warnings. */
  name: string
  /** Transport discriminator. */
  kind: 'telegram'
  /** Credential reference (environment variable name) holding the bot token; never the token itself. */
  botTokenEnv: string
  /** Target chat id. */
  chatId: string
  /** Bot API base; defaults to `https://api.telegram.org`. */
  apiBaseUrl?: string
}

/** A Discord channel webhook. */
export interface DiscordChannel {
  /** Channel name used by `/notify test` and in warnings. */
  name: string
  /** Transport discriminator. */
  kind: 'discord'
  /** The channel's webhook URL. */
  url: string
}

/** One configured destination. */
export type NotifyChannel = WebhookChannel | TelegramChannel | DiscordChannel

/** Plugin configuration. */
export interface NotifyConfig {
  /** Destinations, each addressed by `name`. */
  channels: NotifyChannel[]
  /** Which events are announced. */
  events: NotifyEvents
  /** Minimum time between two sends to the same channel, in milliseconds; a send inside it is dropped. */
  minIntervalMs: number
  /** HTTP timeout per send, in milliseconds. */
  timeoutMs: number
}

/** One notification to deliver. */
export interface Notification {
  readonly event: NotifyEvent
  readonly title: string
  readonly text: string
  readonly sessionId?: SessionId
}

/** The JSON body a webhook channel receives. */
export interface NotificationPayload extends Notification {
  /** ISO-8601 send time. */
  readonly at: string
}

/** Service published as `ctx.notify`. */
export interface NotifyService {
  /**
   * Deliver one notification to every channel, regardless of the event switches.
   * Failures are logged, never thrown.
   * @param notification - what to announce.
   */
  send(notification: Notification): Promise<void>
  /**
   * Configured channel names.
   * @returns the names in configuration order.
   */
  channels(): string[]
}
