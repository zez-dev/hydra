---
description: "The usage Remote: the cross-session token-usage report — overall totals, the per-day series, and the per-model split — for the Web dashboard."
kind: "package-reference"
---

# @deepseek-ai/dsh-api-usage-controller

## Summary

`dsh-api-usage-controller` publishes the `usage` Remote namespace over `ctx.sessionUsage`, the same fold the model reads through the `usage` tool. The Web dashboard asks for one report and receives overall totals, the per-day series that fills its heatmap, and the per-model table. The Host sums the billable figure with the owning service's own `totalTokens`, so the browser renders a total it never derived.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The `dsh-web-app` bundle mounts the row `usage-controller`; `dsh-api-remotes` mounts its generated client contribution as `ctx.remote.usage`. There is no configuration; the corpus and the fold cache come from `dsh-session-usage`.

| Remote | Request | Value |
|---|---|---|
| `report` | `{ since?, until? }`, each an inclusive `YYYY-MM-DD` local day | `{ overall, days[], byModel[] }`; a bound that is not a calendar day fails rather than answering an empty slice |

Every totals record carries the five token buckets, `messages`, `sessions`, and `totalTokens`.

- `totalTokens` is `inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens`.
- `reasoningTokens` is a part of `outputTokens` that has already been counted, reported separately only as a breakdown of it. Adding it to `totalTokens` would double-count.
- `days` ascends and omits every day with no usage. A consumer drawing a calendar fills its own gaps.
- `byModel` descends by billable tokens.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `UsageController` (`ctx.usageController`) and the `usageReportValue` projection |
| [`src/types.ts`](src/types.ts) | Remote request and value types |

`report` forwards the bounds it was given and projects the answer. Bound validation stays in `ctx.sessionUsage.report`, the operation that compares them, so the Remote caller and the `usage` tool are refused by the same rule.

-----

<a id="model-experience"></a>
## Model Experience

None, as this package serves the Web client only.

#### KV Cache effect

Independent: nothing here reaches a model request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No change feed** — `ctx.sessionUsage` emits no event when a session log grows, so this namespace has no `follow` stream and the dashboard re-reads on demand. A stream here would have to poll the corpus, which is the scan the fold cache exists to avoid.
- **One report per call** — a dashboard wanting both an all-time total and a bounded slice makes two calls; the service folds once and the cache absorbs the second scan.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

No runtime invariant companion is published. The Remote holds no state of its own: every figure is projected from one `ctx.sessionUsage.report` answer, so there is no second observation to compare it against.

</details>
