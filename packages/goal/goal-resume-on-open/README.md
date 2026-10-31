---
description: "Re-arms an active goal when its session is resumed, either after asking the approval channel or unconditionally, for deployments that want goals to keep running across restarts."
kind: "package-reference"
---

# @deepseek-ai/dsh-goal-resume-on-open

## Summary

A goal's objective, phase, and round count are durable session data, but the permission to run rounds is process-local: every restart disarms every goal, and nothing re-arms it until a human resumes it. This plugin re-arms an active goal when its session is resumed, under one required policy. `ask` puts the question to the approval service and re-arms only on an allow; `always` re-arms unconditionally. It never acts on fresh, cleared, compacted, forked, or subagent sessions, which announce themselves with sources other than `resume`.

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
- name: '@deepseek-ai/dsh-goal-resume-on-open'
  config:
    policy: always
```

| Field | Default | Meaning |
|---|---|---|
| `policy` | required (the shipped `dsh-base` row is disabled; enable it in a profile patch to opt in) | `ask`: re-arm after the approval service answers `allowed-once`; `always`: re-arm every active goal on resume |

`always` reverses the decision recorded in [`2026-07-16-harness-level-loop.md`](../../../.agents/notes/archived/feature/2026-07-16-harness-level-loop.md), that opening a session is observation and not authority to spend model rounds. Choose it only for a deployment whose owner accepts that a resumed session may start spending immediately. The base bundle (`packages/bundle/base/cordis.patch.yml`) pairs it with `dsh-goal-supervisor`, which resumes stored sessions at boot and bounds the daily spend.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

The plugin listens to `agent/created`. For `source: 'resume'` it reads `ctx.goals.get(agent)`; an active, disarmed goal is re-armed one timer tick later, after the announcement completes and the agent is published, so an approval question can be routed to the agent's own session. `rearmOnOpen()` is the exported decision: it returns `resumed`, `skipped`, `declined`, `unavailable` (policy `ask` with no approval service mounted), or `failed` (the goal service rejected the resume, for example an exhausted round cap). The approval request is recorded under the tool name `goal_resume` with the objective in its reason.

No invariant companion is published because each decision is made once per resumed agent from the goal service's current state; the only state is the pending re-arm timers, which disposal clears.

-----

<a id="model-experience"></a>
## Model Experience

### Re-armed goal rounds

#### What the model sees

Nothing of its own: this plugin adds no prompt text or tool schema; the rounds it re-arms are the ordinary goal rounds `dsh-goal-round-driver` admits.

#### Token effect

Zero direct token effect.

#### KV Cache effect

Independent: a re-armed goal continues the session's own request series without changing its prefix.

## Known Limitations and Deferred Work

- **No actor on goal changes** — `goal/change` records no actor, so a goal the model created through `create_goal` is indistinguishable from one a human set with `/goal`; under `always` both are re-armed. Use `ask` where that matters.
- **Approval channel required for `ask`** — headless and SDK compositions without an approval answerer leave the goal disarmed and log `unavailable`.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
