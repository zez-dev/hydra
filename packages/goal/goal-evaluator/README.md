---
description: "Independent model evaluation of a model-declared goal completion: denies update_goal complete with reasons when the objective and recent tool results do not show the goal achieved."
kind: "package-reference"
---

# @deepseek-ai/dsh-goal-evaluator

## Summary

Goal completion is otherwise a self-report: the model calls `update_goal` with `action: complete` and the goal is done. This plugin gates that call on `tools/pre-execute` with a logged auxiliary model request over the objective, the round count, the last `evidenceEvents` tool results, and, when `dsh-workspace-changes` is mounted, the recorded file changes of earlier turns. A `not-yet` verdict denies the completion with the evaluator's reasons, so the goal stays active and the model reads what is missing; `achieved` lets the call through. A failed evaluation fails closed. Human `/goal` completion is never evaluated.

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
- name: '@deepseek-ai/dsh-goal-evaluator'
  config:
    evidenceEvents: 12
    maxWorkspaceChangeEntries: 12
    maxOutputTokens: 512
    timeoutMs: 60000
```

| Field | Default | Meaning |
|---|---|---|
| `evidenceEvents` | required | How many most-recent tool results are sent as evidence |
| `maxWorkspaceChangeEntries` | required | Files named per recorded turn of workspace changes; the rest are counted. Applies only when `workspaceChanges` is mounted |
| `maxOutputTokens` | required | Output-token cap of each evaluation request; a route that cannot turn thinking off spends part of it on reasoning |
| `timeoutMs` | required | Deadline for one evaluation request |
| `provider`, `model` | session route | Explicit evaluator route; configure both or neither |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

Tool calls and results are observed live per session on `session/event` (never read back from history) and `collectEvidence()` pairs `tool/result` events with their `tool/call` names and truncates each result; `parseVerdict()` accepts only `{"verdict": "achieved" | "not-yet", "reasons": [...]}`, optionally fenced. `evaluateGoal()` asks the route for its lowest selectable reasoning effort (`lowestReasoningEffort()` from `dsh-llm`; none when the route offers none or its model lookup fails), so a thinking route spends the output cap on the verdict, and appends the log-only `session/goal-evaluation` event with the exact route, system prompt, messages, token cap, and effort before streaming the request with `purpose: 'goal-evaluate'`. An answer with no text at a lowered effort, as from a server that files the whole reply as reasoning, is asked once more at the route's default effort and logged the same way; an answer cut at `maxOutputTokens` fails closed without a retry. The gate returns a typed `deny` decision whose reason carries the evaluator's sentences.

No invariant companion is published because the per-session evidence buffers are read only by the evaluation they feed, and the one event the plugin writes, `session/goal-evaluation`, has no second observation to compare against.

-----

<a id="model-experience"></a>
## Model Experience

### Denied completion

#### What the model sees

The denied `update_goal` call's error result: `independent evaluation says the goal is not yet achieved: <reasons joined by "; ">. Continue working on it or report a concrete blocker with action blocked.` A failed or unreadable evaluation reads `goal completion was not accepted: the independent evaluation was unreadable; the goal stays active — retry later or ask the user to complete it` or the failure message in the same form.

#### Token effect

Conditional: one tool-result error per denied completion. The evaluation request itself is an independent auxiliary request whose size is the objective plus up to `evidenceEvents` truncated tool results; a second request at the route's default effort follows only an answer with no text at the lowered effort.

#### KV Cache effect

Independent: the auxiliary request has its own prefix; the denied tool result is appended to the session's own series without changing earlier tokens.

## Known Limitations and Deferred Work

- **The current turn's file changes are not yet recorded** when the completion is evaluated; the deliverables seam summarizes a turn at its end, so only earlier turns' changes reach the evaluator.
- **Same-route evaluation by default** — without an explicit `provider`/`model`, the evaluator uses the session's own model, which shares its blind spots.
- **A route that cannot turn thinking off reasons within the cap** — its lowest selectable effort still reasons before the verdict, so `maxOutputTokens` must cover that reasoning and the verdict; an answer cut at the cap denies the completion and names the cap.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
