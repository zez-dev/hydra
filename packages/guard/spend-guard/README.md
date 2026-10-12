---
description: "Per-session and per-day token budgets: provider usage accounting, pause-goal or stop when a budget is crossed, /spend totals, and optional notifications."
kind: "package-reference"
---

# @deepseek-ai/dsh-spend-guard

## Summary

`dsh-spend-guard` puts a ceiling on unattended spend. It sums the provider usage every `assistant/message` carries, per session in memory and per local day in the `spend_guard` storage domain, and acts once when a budget is crossed: `pause-goal` pauses the session's active goal and hands the model a one-line notice to finish the current step and stop; `stop` pauses the goal and cancels the turn. `/spend` shows this session's and today's totals against the budgets. Both budgets are optional; the shipped composition sets none, so nothing changes until you name a number.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The `dsh-base` bundle mounts the row `spend-guard` with `action: pause-goal` and no budgets. Set budgets in a profile patch:

```yaml
- id: spend-guard
  config:
    perSessionTokens: 2000000
    perDayTokens: 10000000
    action: pause-goal
```

| Field | Default | Meaning |
|---|---|---|
| `perSessionTokens` | absent (unlimited) | Tokens one session may consume in this process before the action fires |
| `perDayTokens` | absent (unlimited) | Tokens all sessions may consume per local day before the action fires; persisted across restarts |
| `action` | required (`pause-goal` in `dsh-base`) | `pause-goal`: pause an active goal and inject the notice; `stop`: pause the goal and cancel the turn |

Tokens are input plus cache reads and writes plus output as the provider reports them; a step whose adapter reports no usage counts nothing. Each budget fires once: a session budget once per session, a daily budget once per day.

### Extension points

- `ctx.spendGuard`: `sessionTokens(sessionId)`, `dayTokens()`, `status(sessionId)`, `settled()`.
- With `dsh-notify` mounted, a crossed budget announces a `spendBudgetReached` notification with the totals and the action.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: usage listener, budgets, enforcement, the `spend_guard` domain, `/spend` |
| [`src/types.ts`](src/types.ts) | `SpendStatus`, `SpendGuardService`, `SpendAction` |

Totals update synchronously on the `session/event` that carries the usage, so the message that crosses a budget is the one that triggers enforcement; the day record is written behind that. Enforcement itself runs one timer tick later because pausing a goal appends to the same session log that is still publishing the crossing message. Disposing the guard writes the day totals still pending, then closes the `spend_guard` domain, so a reloaded guard reopens it with the latest total.

No invariant companion is published because the stored day record is written from the same in-memory totals it later restores, so the two observations share one writer.

-----

<a id="model-experience"></a>
## Model Experience

### Budget notice

#### What the model sees

Under `pause-goal`, one user-role message from this plugin, admitted with the next request:

##### Verbatim text for this field

```markdown
The token budget for this work is reached. Finish the current step with what you have, state what remains, and stop; do not start new work.
```

#### Token effect

Conditional: about thirty tokens, once per crossed budget.

#### KV Cache effect

Append-only: the notice joins the history after the cached prefix.

## Known Limitations and Deferred Work

- **Session totals are process-local** — a resumed session starts at zero; only the daily total survives a restart.
- **Estimated usage is not counted** — steps whose adapter reports no usage are free to the guard; `dsh-token-meter` estimates could fill the gap.
- **`stop` cancels mid-step** — tool calls in flight are aborted the same way a user cancel would.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
