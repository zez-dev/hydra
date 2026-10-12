/**
 * Outbound notifications. Goal blocks and completions, exhausted transient
 * retries, and agent errors are posted to
 * configured webhook, Telegram, and Discord channels. Every send is
 * fire-and-forget: a failure is logged and never reaches the turn. Secrets are
 * credential references resolved per send. Named exports preserve Loader
 * injection metadata.
 * @module @deepseek-ai/dsh-notify
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { TRANSIENT_RETRIES_EXHAUSTED } from '@deepseek-ai/dsh-goal-round-driver'
// Type-only: resolves the `goal/changed` and `agent/error` event declarations and the credentials service.
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-goal'
import { buildRequest } from './channels.ts'
import type { Notification, NotificationPayload, NotifyChannel, NotifyConfig, NotifyService } from './types.ts'

export type * from './types.ts'
export { buildRequest, renderNotification, TELEGRAM_API } from './channels.ts'

export const name = 'notify'
export const inject = ['commands']

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Outbound notifications; provided by `dsh-notify`. */
    notify: NotifyService
  }
}

/** Plugin configuration; see {@link NotifyConfig}. */
export type Config = NotifyConfig

const channelSchema = z.union([
  z.object({
    name: z.string().required(),
    kind: z.const('webhook').required(),
    url: z.string().required(),
    headers: z.dict(z.string()),
  }),
  z.object({
    name: z.string().required(),
    kind: z.const('telegram').required(),
    botTokenEnv: z.string().role('credential-ref').required(),
    chatId: z.string().required(),
    apiBaseUrl: z.string(),
  }),
  z.object({
    name: z.string().required(),
    kind: z.const('discord').required(),
    url: z.string().required(),
  }),
])

/** Schemastery configuration schema. */
export const Config: z<Config> = z.object({
  channels: z.array(channelSchema).required(),
  events: z.object({
    goalBlocked: z.boolean().required(),
    goalCompleted: z.boolean().required(),
    transientRetriesExhausted: z.boolean().required(),
    sessionError: z.boolean().required(),
    cronRun: z.boolean().required(),
    spendBudgetReached: z.boolean().required(),
    researchBreakthrough: z.boolean().required(),
    dailyDigest: z.boolean().required(),
    weeklyDigest: z.boolean().required(),
    offPeakDrained: z.boolean().required(),
  }).required(),
  minIntervalMs: z.natural().required(),
  timeoutMs: z.natural().min(1).required(),
})

/**
 * Install the listeners, the `ctx.notify` service, and `/notify test <channel>`.
 * @param ctx - plugin context carrying `commands`; `credentials`, `goals`, and `agents` are used when mounted.
 * @param config - deployment configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const lastSent = new Map<string, number>()

  async function secretFor(channel: NotifyChannel): Promise<string | undefined> {
    if (channel.kind !== 'telegram') return undefined
    const credentials = ctx.get('credentials')
    if (credentials === undefined) return process.env[channel.botTokenEnv]
    return (await credentials.resolve(credentialRef(channel.botTokenEnv)))?.value
  }

  async function deliver(channel: NotifyChannel, payload: NotificationPayload): Promise<void> {
    const now = Date.now()
    const previous = lastSent.get(channel.name)
    if (previous !== undefined && now - previous < config.minIntervalMs) {
      ctx.logger.warn(`notify: dropped "${payload.event}" for channel "${channel.name}": inside the minimum interval`)
      return
    }
    lastSent.set(channel.name, now)
    const request = buildRequest(channel, payload, await secretFor(channel))
    if (request === undefined) {
      ctx.logger.warn(`notify: channel "${channel.name}" has no resolvable credential; skipped "${payload.event}"`)
      return
    }
    const response = await fetch(request.url, {
      method: 'POST',
      headers: request.headers,
      body: request.body,
      signal: AbortSignal.timeout(config.timeoutMs),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
  }

  async function send(notification: Notification): Promise<void> {
    const payload: NotificationPayload = { ...notification, at: new Date().toISOString() }
    await Promise.all(config.channels.map(channel => deliver(channel, payload).catch((error: unknown) => {
      ctx.logger.warn(`notify: send to "${channel.name}" failed: ${error instanceof Error ? error.message : String(error)}`)
    })))
  }

  const service: NotifyService = {
    send,
    channels: () => config.channels.map(channel => channel.name),
  }
  ctx.provide('notify', service)

  function announce(notification: Notification): void {
    void send(notification)
  }

  ctx.on('goal/changed', ({ agent, change }) => {
    const goal = change.goal
    if (goal === undefined) return
    if (change.operation === 'block') {
      const reason = goal.blockedReason
      if (reason?.code === TRANSIENT_RETRIES_EXHAUSTED) {
        if (config.events.transientRetriesExhausted) announce({ event: 'transientRetriesExhausted', title: 'Goal paused after repeated failures', text: `${goal.objective}\n${reason.message}\nType /goal resume to continue.`, sessionId: agent.id })
        return
      }
      if (config.events.goalBlocked) announce({ event: 'goalBlocked', title: 'Goal blocked', text: `${goal.objective}\n${reason === undefined ? '' : `${reason.code}: ${reason.message}`}`, sessionId: agent.id })
      return
    }
    if (change.operation === 'complete' && config.events.goalCompleted) {
      announce({ event: 'goalCompleted', title: 'Goal completed', text: goal.objective, sessionId: agent.id })
    }
  })

  ctx.on('agent/error', ({ agent, turn, step, error }) => {
    if (!config.events.sessionError) return
    announce({ event: 'sessionError', title: 'Session error', text: `turn ${turn} step ${step}: ${error instanceof Error ? error.message : String(error)}`, sessionId: agent.id })
  })

  async function executeNotify(invocation: CommandInvocation): Promise<CommandResult> {
    const words = invocation.rawInput.trim().split(/\s+/u).filter(word => word.length > 0)
    if (words[0] !== 'test' || words[1] === undefined) return { kind: 'error', text: 'Usage: /notify test <channel>' }
    const channel = config.channels.find(entry => entry.name === words[1])
    if (channel === undefined) return { kind: 'error', text: `Unknown channel "${words[1]}". Channels: ${config.channels.map(entry => entry.name).join(', ') || 'none'}` }
    const payload: NotificationPayload = { event: 'test', title: 'Hydra test notification', text: `channel ${channel.name} works`, sessionId: invocation.agent.id, at: new Date().toISOString() }
    try {
      await deliver(channel, payload)
      return { kind: 'success', text: `Sent a test notification to "${channel.name}".` }
    } catch (error) {
      return { kind: 'error', text: `Send to "${channel.name}" failed: ${error instanceof Error ? error.message : String(error)}` }
    }
  }

  ctx.effect(() => ctx.commands.register({
    name: 'notify',
    description: 'Send a test notification to a configured channel',
    input: { hint: 'test <channel>' },
    handler: executeNotify,
  }))
}
