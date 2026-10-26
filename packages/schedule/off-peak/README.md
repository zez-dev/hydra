---
description: "Deferral of goal rounds into cheaper local-time windows: a durable queue, a window drainer with a concurrency cap, /offpeak, and an off_peak tool."
kind: "package-reference"
---

# @deepseek-ai/dsh-off-peak

## Summary

`dsh-off-peak` moves unattended work into the hours a provider charges less for. While the plugin is enabled and the local clock sits outside every configured window, a goal round about to start never reaches the model: the step is rejected, the goal pauses, and a durable entry records the deferral. When a window opens the drainer resumes queued sessions in order, up to `maxConcurrent`; when it closes, a resumed round still running pauses and queues again unless `finishRoundInFlight` lets it end. `/offpeak` and the `off_peak` tool park one-off tasks in the same queue.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The `dsh-base` bundle mounts the row `off-peak` disabled, because discount hours differ per provider and per account. A profile patch turns it on and names the windows; the row carries DeepSeek's own discount hours as a commented example:

```yaml
- id: off-peak
  config:
    enabled: true
    windows:
      - { start: '00:30', end: '08:30' }
    maxConcurrent: 2
    finishRoundInFlight: false
```

From any session:

```
/offpeak list
/offpeak queue rerun the dependency audit and file a ticket per finding
/offpeak drain
/offpeak cancel <id>
```

| Field | Default | Meaning |
|---|---|---|
| `enabled` | required (`false` in `dsh-base`) | Whether deferral, draining, and the `off_peak` tool exist at all; `false` leaves every round alone and keeps `/offpeak` available for inspection |
| `windows` | `[]` | Local wall-clock `HH:MM` pairs in which deferred work runs; a `start` later than its `end` wraps past midnight |
| `maxConcurrent` | required (`2` in `dsh-base`) | Sessions resumed at once when a window opens; the rest wait for the next drain |
| `finishRoundInFlight` | `false` | Whether a round already running when the window closes may run to its end instead of pausing |

Times are zero-padded 24-hour local times. A window whose `start` equals its `end` covers no time and is rejected at load, as is an enabled row with no window at all. `/offpeak drain` runs the queue by hand at any hour, which is also how a deployment that never enables windows still uses the queue.

### Extension points

- `ctx.offPeak`: `isOpen()`, `list()`, `queue(input)`, `cancel(id)`, `drain()`.
- `off-peak/change` fires with `queued`, `started`, `finished`, or `cancelled`.
- With `dsh-notify` mounted, a drain that started at least one entry announces an `offPeakDrained` notification carrying how many finished and how many are still queued.
- `parseWindows`, `inWindow`, `nextOpen`, `nextClose`, `hasGoalRound`, `hasHumanMessage`, and `offPeakDomainSpec` are exported for reuse.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: the `off_peak` storage domain, the deferral listener, the window timer, `/offpeak` |
| [`src/tools.ts`](src/tools.ts) | The `./tools` entry: the `off_peak` tool over `ctx.offPeak` |
| [`src/window.ts`](src/window.ts) | Local-time window parsing, membership, and the next open and close instants |
| [`src/types.ts`](src/types.ts) | `OffPeakEntry`, `OffPeakService`, `OffPeakWindow`, `ParsedWindow`, the drain summary, the change payload |

Deferral happens on the `agent/pre-step` waterfall. The listener delegates first, then rejects the step only when the admitted batch carries a goal round driver continuation and no user message, so a person typing into a paused-hours session is never made to wait. Rejecting closes the turn without a request, which is what keeps the round off the peak-rate bill.

The pause is synchronous inside that listener. The round driver admits its next round as soon as the step settles, so a pause deferred to a later tick would let a goal spend its whole round budget against a closed window.

A session the drainer resumed is exempt from deferral until its turn ends, which is what lets `/offpeak drain` run the queue outside a window. The exemption is bounded by `turn/end`, so it covers exactly one round and a manual drain never exempts a session for good. When the window closes during that round, the session is deferred the way a round is at `agent/pre-step`: the goal pauses and one entry queues it for the next window.

Only sessions with a queue entry are resumed. A goal a person paused has no entry, so the drainer leaves it alone and `/goal resume` stays the only way to re-arm it.

Entries live in the `off_peak` domain, one record per entry: `id`, `sessionId`, `kind` (`goal-round` or `manual`), the optional objective and workspace, `queuedAt`, and the state (`queued`, `running`, `done`, `failed`). A goal-round deferral records once per session, so a retried round does not stack entries; a manual task already waiting for the same session does not count, because it never resumes the goal. A manual entry whose record carries no objective has no task to send, so draining marks it `failed` instead of sending the model an empty message. A goal-round entry whose goal someone already resumed by hand is marked `done` without a second resume. Unloading the plugin closes the domain after its queued writes land, so a reload of the row reopens the same queue.

No invariant companion is published; a queue entry's stored state and its `off-peak/change` lifecycle events can diverge, and that check is listed under Known Limitations.

-----

<a id="model-experience"></a>
## Model Experience

### Postponed goal round

#### What the model sees

Nothing. The step is rejected before assembly, so no request is made and no message is appended; the next thing the model sees is the resumed round when the window opens.

#### Token effect

Removes: the deferred round's request is not made at all.

#### KV Cache effect

Independent: the session's prefix is unchanged, but a queue that waits hours crosses provider cache lifetimes, so the resumed round usually pays a cold prefix.

### `off_peak` tool

#### What the model sees

Two actions, `queue` and `list`, and a result carrying whether a window is open and the queued entries' id, state, and task. The tool ships as the `./tools` entry (`@deepseek-ai/dsh-off-peak/tools`), mounted separately from the service, so a surface that hides it keeps deferral, draining, and `/offpeak`. It is registered only while the service row's `enabled` is on: a disabled row opens no window and drains nothing on its own, so a task the model parked would wait for a person's `/offpeak drain`.

#### Token effect

Fixed while the row is enabled: the tool schema once per request, plus a result proportional to the queue length. None while it is disabled.

#### KV Cache effect

Shared: the schema sits in the stable tool prefix; results append like any other tool result.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No cheaper route while draining** — a `route` option that switched provider and model for drained work was cut before shipping: `model/selection` has no agent-loop consumer, so the switch would have logged intent without changing a request. A deployment that wants a cheaper drain route configures it per profile.
- **`/goal resume` outside a window is deferred** — the driver's continuation carries no user message, so the round is queued and the goal pauses again within seconds; `/offpeak drain` runs it now.
- **Live sessions only** — the drainer resumes sessions still live in this process; an entry whose session is gone is marked `failed` with the reason. After a restart no session is live until a client reopens it, so the drain at activation inside a window fails every queued entry.
- **One process per queue** — two dsh processes sharing a Harness home both drain the same entries.
- **Manual entries stay with their session** — `/offpeak queue` and the tool park the task on the session that queued it, which must be live when the window opens.
- **Whole-minute windows** — bounds are `HH:MM` local time; there is no finer precision and no per-day or per-weekday variation.
- **No invariant companion yet** — nothing checks that a queue entry's stored state follows its `off-peak/change` lifecycle (`queued`, `started`, `finished`, `cancelled`).

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The specs fake only `Date`, `setTimeout`, and `clearTimeout`. The agent loop drives rounds through promises, and faking every timer stalls it.

</details>
