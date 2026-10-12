---
description: "Resumes stored sessions with active goals at boot under a concurrency cap and a daily round budget, pauses live goals that exceed the budget, and lists goals with /goals."
kind: "package-reference"
---

# @deepseek-ai/dsh-goal-supervisor

## Summary

At activation the supervisor lists stored sessions, folds each log for an active goal, and resumes up to `maxConcurrent` of them through the agent registry, so a mounted `dsh-goal-resume-on-open` can re-arm them under its policy. An optional `dailyRoundBudget` bounds spend per goal per local day: a stored goal that already ran that many rounds today waits until midnight, and a live goal that exceeds it is paused with a logged reason and resumed at the next midnight. Without a budget nothing is paused. `/goals` lists every live goal with its phase and its rounds against the budget and its cap.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

```yaml
- name: '@deepseek-ai/dsh-goal-supervisor'
  config:
    maxConcurrent: 4
```

| Field | Default | Meaning |
|---|---|---|
| `maxConcurrent` | required | Maximum stored sessions with active goals resumed at activation |
| `dailyRoundBudget` | absent (the shipped `dsh-base` row is disabled; enable it in a profile patch to opt in) | Goal rounds one goal may run per local day; reaching it defers boot-time resume to midnight, exceeding it pauses a live goal until midnight. Absent means unlimited (the shipped `dsh-base` bundle sets none) |

Both limits are required so a deployment names the spend it accepts. Mount `dsh-goal-resume-on-open` beside it; without a re-arm policy the resumed sessions stay disarmed and only appear in the sidebar.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

`activeGoalOf()` folds a stored log with `dsh-goal`'s own `foldGoal`; `roundsSince()` counts `user/message` events whose source kind is `goal` from local midnight; `planSupervision()` splits candidates into `resume`, `overBudget`, and `deferred`. Resume follows the Web session controller's path: `ctx.agents.resume()` with the deployment's current default model when `dsh-agent-default-model` is mounted and the session's recorded agent preset when `dsh-agent-presets` is mounted, so supervised sessions appear as ordinary sessions. Live enforcement keeps a per-session ledger of round admission times observed on `session/event`, seeded from the stored log when a session is resumed, and pauses on the next timer tick, because the round's own append is still publishing when the event arrives. A goal log that fails `dsh-goal`'s replay rules affects only its own session: the boot and midnight passes skip that session with a warning, and enforcement and the midnight re-arm log the failure instead of throwing from their timers.

No invariant companion is published because the round ledger is a fold of the same `session/event` stream the log stores, seeded from that log on resume, so comparing the two would repeat the ledger's own fold.

-----

<a id="model-experience"></a>
## Model Experience

### Supervised goal rounds

#### What the model sees

Nothing of its own: this plugin adds no prompt text or tool schema; a paused goal stops receiving rounds and the `/goals` listing is shown to the human only.

#### Token effect

Zero direct token effect.

#### KV Cache effect

Independent: resumed sessions continue their own request series.

## Known Limitations and Deferred Work

- **Midnight resume is process-local** — the timer that resumes budget-paused goals and re-runs boot-time supervision exists only while the process runs, and the list of goals it resumes is kept in memory. A goal paused for its budget is stored as `paused`, and the boot-time pass only resumes active goals, so after a restart a budget-paused goal stays paused until someone runs `/goal resume`.
- **Boot-time only** — sessions stored after activation are not picked up until the next activation; there is no periodic rescan.
- **Model selection** — a resumed session takes the deployment default model rather than the selection the Web client last installed for it.
- **Budget window** — the daily window is the host's local midnight; rounds are counted from the session log, so a goal round admitted but never logged is not counted.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
