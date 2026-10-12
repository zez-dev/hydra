---
description: "Cron schedules that start fresh sessions on a timer: durable schedules, a local-time five-field matcher, /cron management, boot-time catch-up, and run outcomes."
kind: "package-reference"
---

# @deepseek-ai/dsh-cron-sessions

## Summary

`dsh-cron-sessions` runs prompts unattended on a schedule. Each schedule is a durable record with a five-field cron expression, a workspace directory, and a prompt. When the expression matches the current local minute and no run for that schedule is live, the plugin creates a fresh session in the workspace the way the Web session controller does, submits the prompt as the user, waits for the session to go idle, records the outcome, and disposes the agent. `/cron` adds, lists, enables, disables, runs, and removes schedules from any session. A nightly test pass is one `/cron add` away.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The `dsh-base` bundle mounts the row `cron-sessions`. Add a schedule from any session; the workspace defaults to that session's directory:

```
/cron add nightly "0 2 * * *" run the full test suite and file a ticket for every failure
/cron list
/cron run <id>
/cron disable <id>
```

| Field | Default | Meaning |
|---|---|---|
| `tickMs` | required (`30000` in `dsh-base`) | Milliseconds between schedule evaluations; keep it under a minute so no matching minute is skipped |
| `maxConcurrent` | required (`1` in `dsh-base`) | Schedules running at once; further due schedules wait for a later tick |
| `catchUp` | required (`false` in `dsh-base`) | Run a schedule once at activation when a matching minute passed while the process was down (bounded to the last 24 hours) |

Expressions are `minute hour day-of-month month day-of-week` in local time with `*`, lists (`1,15`), ranges (`9-17`), and steps (`*/15`); day-of-week is 0-6 with 0 as Sunday, and when both day fields are restricted a date matches when either does. A schedule runs at most once per matching minute. Each run uses the deployment's current default model and, when agent presets are mounted, the schedule's `agentPreset` or the default preset.

### Extension points

- `ctx.cronSessions`: `list()`, `add(input)`, `setEnabled(id, enabled)`, `remove(id)`, `runNow(id)`, `isRunning(id)`.
- `cron-sessions/change` fires with `added`, `updated`, `removed`, `run-started`, or `run-finished`.
- With `dsh-notify` mounted, every finished run announces a `cronRun` notification carrying the schedule name and outcome.
- `parseCron`, `cronMatches`, `isDue`, `missedSince`, and `parseAddInput` are exported for reuse.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: the `cron_sessions` storage domain, the ticker, session runs, `/cron` |
| [`src/cron.ts`](src/cron.ts) | Five-field parsing and matching |
| [`src/types.ts`](src/types.ts) | `CronSchedule`, `CronSessionsService`, `ParsedCron`, the change payload |

A run creates the agent through `ctx.agents.create` with a fresh session id and the schedule's `cwd` as session metadata, so the session is a normal stored session that lists in the sidebar. The outcome is `error` when an `agent/error` fired for the session during the run or the run itself threw, else `completed`. A run clears the previous outcome when it starts, so a run that an unload or a crash cut short records none, and `/cron list` shows it as `interrupted`. Records live in the `cron_sessions` domain; a hand-edited record with an unparsable expression stays listed and never runs. Unloading the plugin closes the domain after its queued writes land, so a reload of the row reopens the same schedules. Removing a schedule while it runs lets the run finish: `run-finished` and the notification still fire, and `runNow` resolves with the outcome, which no record keeps.

No invariant companion is published; the `run-started` and `run-finished` pair of `cron-sessions/change` events and the stored run outcome can diverge, and that check is listed under Known Limitations.

-----

<a id="model-experience"></a>
## Model Experience

### Scheduled prompt

#### What the model sees

The schedule's `prompt` as an ordinary first `user/message` in a fresh session; nothing marks the session as scheduled.

#### Token effect

Fixed: the prompt's own tokens once per run.

#### KV Cache effect

Independent: every run is a new session with its own prefix.

## Known Limitations and Deferred Work

- **Minute granularity** — a tick longer than a minute can skip a matching minute; the shipped 30 seconds cannot.
- **Catch-up runs once** — several missed matches during an outage collapse into one run.
- **No overlap control across processes** — two dsh processes sharing a Harness home may both run the same schedule.
- **Outcome is coarse** — `completed` or `error`; the run's session log holds the detail.
- **No invariant companion yet** — nothing checks that every `run-started` change is followed by one `run-finished` change for the same run and that the stored outcome matches it.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
