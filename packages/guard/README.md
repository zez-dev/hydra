---
description: "Package map for the loop-hygiene guard family: the advisory repeat-tool reminder and the per-tool-call timeout policy, for users and maintainers choosing or composing the guards."
kind: "package-group"
---

# guard/ — loop-hygiene guard family

English | [中文](README.zh.md)

## Summary

The `guard/` group keeps the agent loop productive by watching for two common failure patterns. `repeat-tool-reminder` notices when the model repeats the exact same tool call and reminds it to change approach or finish, so a stuck loop stops burning time and tokens. `timeout-policy` puts a time limit on tool calls that declare one, so a hung call returns a clear timed-out error to the model instead of stalling the session. Both ship enabled in the `dsh` base bundle; a composition can tune or remove them.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

Each README below explains when to keep, tune, or remove its plugin.

| Package | What it provides |
|---|---|
| [`repeat-tool-reminder/`](repeat-tool-reminder/README.md) | Reminds the model when it repeats the same tool call, so it changes approach or finishes |
| [`auto-continue/`](auto-continue/README.md) | Steers a continuation when a step stops at the output-token limit, so a truncated answer finishes without a human typing continue |
| [`spend-guard/`](spend-guard/README.md) | Pauses the goal or stops the turn when a session or daily token budget is crossed, with `/spend` totals |
| [`timeout-policy/`](timeout-policy/README.md) | Times out tool calls that declare a limit, so the model gets a clear error instead of waiting forever |
| [`command-gate/`](command-gate/README.md) | Classifies shell argv and refuses commands that destroy what no checkpoint can restore, with `/commands-gate` history |
| [`evidence-guard/`](evidence-guard/README.md) | Adds an evidence standard to every system prompt and reviews a turn's partial reads, unchecked changes, and claims before it ends; ships disabled |

-----

<a id="related-documentation"></a>
## Related documentation

Start with the tools subsystem reference for the tool-call pipeline, then the reminder's configuration and the timeout-library decision behind the policy.

- [Tools subsystem reference](../../docs/subsystems/tools.md) — the tool-call pipeline and decisions both guards build on.
- [Generated configuration catalog](../../docs/config-catalog.md#deepseek-aidsh-repeat-tool-reminder) — every accepted field of the repeat-call reminder.
- [Generated configuration catalog](../../docs/config-catalog.md#deepseek-aidsh-auto-continue) — every accepted field of the auto-continue guard.
- [Timeout deadline library Agent Note](../../.agents/notes/implemented/architecture/2026-07-06-timeout-deadline-library.md) — the timing/termination split `timeout-policy` enforces.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
