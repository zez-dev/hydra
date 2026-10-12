---
description: "Durable workflow-run journal for Hydra: records every agent() call that completed so an interrupted run resumes without repeating answered work, and lists runs through /workflows."
kind: "package-reference"
---

# @deepseek-ai/dsh-workflow-journal

## Summary

`dsh-workflow-journal` is the Service Provider for `ctx.workflowJournal`, the durable record of workflow runs defined by `dsh-workflow`. A workflow engine opens a record when a run starts, appends every `agent()` call as it settles, and closes it with the run's terminal result. A run whose process died is marked `interrupted` the next time the journal opens. `/workflows` lists recent runs and details what resuming one would replay. The records are what `resumeRunId` reads: a resumed run reuses the answers of calls that completed at the same position with the same inputs, and runs everything else for real.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The `dsh-base` bundle mounts the row `workflow-journal` ahead of the engine, so every workflow run is recorded with no further wiring. It needs `storageDomain` and `commands`.

| Field | Default | Meaning |
|---|---|---|
| `retainRuns` | `200` | Runs kept before the oldest settled ones are pruned; a `running` run is never pruned |
| `listLimit` | `20` | Rows `/workflows` prints when the caller names no run |

Type `/workflows` to list recent runs, newest first, each with its state, workflow name, settled-call count, and how many calls are not replayable. Type `/workflows <run-id>` to see one run's script hash, the run it resumed, and every settled call with its position, replay status and label.

To resume, call the `workflow` tool again with the same script and args plus `resumeRunId` set to the earlier run's id. Resuming is a new run that records `resumedFrom`; the run it resumed is never rewritten.

### Reading the journal directly

`ctx.workflowJournal.list(limit?)` returns records newest first, `get(id)` one record, and `plan(id, scriptHash)` what a resume would replay without running anything. `open`, `record` and `close` are the engine's writes. Writes are ordered per run id, so a caller may start them without awaiting the previous one.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: the `workflow_runs` storage domain, the `workflowJournal` service, activation reconciliation, pruning, and `/workflows` |

The vocabulary — `WorkflowRunRecord`, `JournalCall`, `ResumePlan`, `WorkflowJournalService` — is defined by [`@deepseek-ai/dsh-workflow`](../workflow/README.md), the seam's Service Definition, and the replay itself happens in [`@deepseek-ai/dsh-workflow-ptc`](../workflow-ptc/README.md), the Consumer.

**Runtime invariant:** No companion is published. The stored record is the only account of a run, so nothing independent exists to compare it against; the engine's own specs assert what a recorded run replays.

One record per run holds the run and its calls together, so a call is appended by rewriting its run. Activation reconciles first: a record still marked `running` belongs to a process that is gone, because nothing else could have read it back, so it becomes `interrupted` with a finish time. A record that fails its stored validation is backed up and skipped rather than failing activation.

Unloading the plugin lets every queued run write land, then closes the `workflow_runs` domain, so the journal can be mounted again in the same process.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the `workflow` tool's `resumeRunId` parameter, which [`@deepseek-ai/dsh-tool-workflow`](../tool-workflow/README.md) owns.

#### KV Cache effect

Independent: nothing here changes a model request.

## Known Limitations and Deferred Work

- **No repair or editing** — a journaled run can be read and resumed, not edited. Changing a recorded answer, dropping a call, or splicing two runs together is not supported.
- **Resume is not a hold** — a script that stopped waiting on a person does not resume where it paused; it re-executes from the top and replays the calls that already answered.
- **Retention is a count, not an age** — `retainRuns` prunes the oldest settled runs regardless of how recent they are, and prunes only when a new run opens.
- **One writer per storage root** — two processes journaling to the same storage root order their writes only within a process, so the last full record written wins.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
