---
description: "The auto-continue guard: steer a continuation when a step stops at the output-token limit, for users and maintainers sizing or debugging truncated answers."
kind: "package-reference"
---

# @deepseek-ai/dsh-auto-continue

## Summary

`dsh-auto-continue` keeps a turn going when the model's answer was cut off by its output-token limit. At the turn-stopping boundary it steers one continuation message, so the loop runs another step instead of ending the turn with a truncated answer and waiting for a human to type "continue". A completed, cancelled, or errored step is never continued, a truncated message with no visible content is left alone, and a required per-turn cap bounds how many continuations one answer may cost.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The shipped `dsh-base` bundle mounts the guard with `maxContinuationsPerTurn: 8`. Mount it beside `dsh-agent`:

```yaml
- name: '@deepseek-ai/dsh-auto-continue'
  config:
    maxContinuationsPerTurn: 8
```

| Field | Default | Meaning |
|---|---|---|
| `maxContinuationsPerTurn` | required (`8` in `dsh-base`) | Continuations steered within one turn; each is a full model request over the whole context |
| `minVisibleChars` | `80` | A cut answer whose visible text is shorter than this was cut before its answer, usually because a reasoning model's thinking spent the cap; it is continued only within `maxReasoningContinuationsPerTurn`. |
| `maxReasoningContinuationsPerTurn` | `1` | Continuations per turn for an answer cut before its visible text. Such a continuation asks the model to answer now (`REASONING_CONTINUATION_TEXT`), and its request asks the route for its lowest selectable reasoning effort (`off`, `none`, `minimal`, or `low`, whichever the route offers first), which the logged request header records. The loop and the Web model selection seed later requests from that header, so the agent's next request puts back the effort the lowered one replaced, or the route's default, unless that request already proposes a different effort, which counts as a newer choice. They count toward `maxContinuationsPerTurn`. `0` stops such a turn at once. |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

The guard observes `session/event`: every `assistant/message` records whether its embedded stream ended with a `max-tokens` finish and whether the message carries non-blank content; `turn/start` clears both the record and the turn's continuation count. On the serial `agent/turn-stopping` event it steers `CONTINUATION_TEXT` through `agent.steer()` when the latest settlement of that turn was truncated with content and the cap is not reached. Steering makes the loop observe pending input and run another step; the turn's durable `turn/end` reason stays `max-tokens` because the loop keeps that outcome sticky. A user cancellation aborts the signal before the listener runs, and an errored step settles as `assistant/attempt`, which the guard ignores.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: settlement tracking, the turn-stopping listener, config |

No invariant companion is published because the per-session settlement records, continuation counts, and the effort each lowered request replaced are private to the guard's own `agent/turn-stopping` and `agent/request` listeners; the first two reset at each `turn/start`, and the third is consumed by the agent's next request.

-----

<a id="model-experience"></a>
## Model Experience

### Continuation message

#### What the model sees

One user message after a truncated assistant message, logged as `user/message` with source `{ kind: 'plugin', plugin: 'dsh-auto-continue' }`:

##### Verbatim continuation text

```markdown
Continue exactly where you stopped; do not repeat earlier output. Your previous message was cut off by the output-token limit.
```

#### Token effect

Conditional: one short user message per continuation, at most `maxContinuationsPerTurn` per turn, plus the full request each continuation triggers.

#### KV Cache effect

Append-only: the continuation appends after the truncated assistant message, so the provider's cached prefix stays reusable.

## Known Limitations and Deferred Work

- **No stitching** — the two assistant messages stay separate in history and in the UI; nothing joins the truncated text with its continuation.
- **Cap is per turn, not per session** — a task that truncates on every turn keeps continuing every turn; the cap only bounds one answer.
- **The effort to put back lives in memory** — a Host restart between a reasoning continuation and the agent's next request leaves the lowered effort in the logged header, and later requests keep it until a new choice is made.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
