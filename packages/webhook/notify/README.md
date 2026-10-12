---
description: "Outbound notifications: goal blocks and completions, exhausted transient retries, and agent errors posted to webhook, Telegram, and Discord channels."
kind: "package-reference"
---

# @deepseek-ai/dsh-notify

## Summary

`dsh-notify` tells you what happened while you were away. It posts a short message to each configured channel when a goal blocks or completes, the round driver gives up after repeated transient failures, or an agent turn errors. Channels are generic webhooks, Telegram bot chats, and Discord webhooks. Sends never affect the turn: a failed send is a logged warning. Secrets are credential references, so configuration carries an environment variable name and never a token.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The `dsh-base` bundle ships the row `notify` disabled because channels are user data. Enable it in `$DSH_HOME/cordis.patch.yml`:

```yaml
- id: notify
  disabled: false
  config:
    channels:
      - { name: phone, kind: telegram, botTokenEnv: TELEGRAM_BOT_TOKEN, chatId: '123456' }
      - { name: team, kind: discord, url: https://discord.com/api/webhooks/... }
      - { name: hook, kind: webhook, url: https://example.test/hydra, headers: { x-token: abc } }
    events: { goalBlocked: true, goalCompleted: true, transientRetriesExhausted: true, sessionError: false, cronRun: true, spendBudgetReached: true, researchBreakthrough: true, dailyDigest: true, weeklyDigest: true, offPeakDrained: true }
    minIntervalMs: 5000
    timeoutMs: 10000
```

Put `TELEGRAM_BOT_TOKEN=...` in `$DSH_HOME/.env`. `/notify test <channel>` sends a test message.

| Field | Default | Meaning |
|---|---|---|
| `channels[].kind` | required | `webhook` (`url`, optional `headers`), `telegram` (`botTokenEnv`, `chatId`, optional `apiBaseUrl`), or `discord` (`url`) |
| `events.*` | required | Per-event switches: `goalBlocked`, `goalCompleted`, `transientRetriesExhausted`, `sessionError`, `cronRun` (a `dsh-cron-sessions` run finished), `spendBudgetReached` (`dsh-spend-guard` crossed a budget), `researchBreakthrough`, `dailyDigest`, `weeklyDigest`, `offPeakDrained` (`dsh-off-peak` drained a window) (`dsh-goal-iteration` gave a ticket up to a person) |
| `minIntervalMs` | required | Minimum time between two sends to one channel; a send inside it is dropped with a warning |
| `timeoutMs` | required | HTTP timeout per send |

Webhook channels receive `{ event, title, text, sessionId?, at }` as JSON. Telegram and Discord receive the title, text, and session on separate lines.

### Extension points

- `ctx.notify.send({ event, title, text, sessionId? })` delivers to every channel regardless of the event switches; `ctx.notify.channels()` lists names.
- `buildRequest` and `renderNotification` are exported for other transports.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: listeners on `goal/changed` and `agent/error`; rate limiting; credential resolution; `/notify` |
| [`src/channels.ts`](src/channels.ts) | Request construction per channel kind |
| [`src/types.ts`](src/types.ts) | Config, notification, and service types |

`goal/changed` with operation `block` sends `transientRetriesExhausted` when the reason code is the round driver's, else `goalBlocked`; operation `complete` sends `qaIdle` for `[qa]` objectives, else `goalCompleted`. `tickets/change` seeds the known ids of a folder on its first event and announces later ids whose file is an `open` ticket created within the last minute. `agent/error` sends `sessionError`.

No invariant companion is published because each notification is sent from one observed event, and the only state is the last send time the rate limit reads.

-----

<a id="model-experience"></a>
## Model Experience

None, as this package contributes no model-visible text.

#### KV Cache effect

Independent: nothing here changes a model request.

## Known Limitations and Deferred Work

- **Dropped, not queued** — a send inside `minIntervalMs` is dropped; bursts lose all but the first message.
- **No delivery record** — sends are not logged to the session; a failed send leaves only a process warning.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
