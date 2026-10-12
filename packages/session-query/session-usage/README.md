---
description: "Cross-session token usage derived from the session logs: the /usage command, the usage tool, the report contract Web clients read, and the per-session fold cache."
kind: "package-reference"
---

# @deepseek-ai/dsh-session-usage

## Summary

`dsh-session-usage` answers "how many tokens has this installation spent, and on what". `ctx.sessionUsage.report()` folds the provider-reported usage on every `assistant/message` in every session the corpus knows about and returns overall totals, a day series, and a split by provider route and model. `/usage` prints that as totals, a per-model table, and the last twelve weeks as a day grid; the `usage` tool returns the same figures to the model. The session logs are the only source, so history written before this plugin was ever mounted counts, and no running counter can drift away from what the providers reported.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin beside `sessionQuery`, `commands`, and `storageDomain`. It has no settings. The model-facing tool is a separate `./tools` entry, so a composition can publish the service and `/usage` without putting the tool in every agent's tool layer.

No runtime invariant companion is published because every figure this package reports is folded from the session logs on demand; there is no second observation of spend that could diverge from them, and the cache is checked against the logs on every report.

```yaml
- name: '@deepseek-ai/dsh-session-usage'
- name: '@deepseek-ai/dsh-session-usage/tools'
```

### The report

`ctx.sessionUsage.report({ since?, until?, signal? })` resolves one `UsageReport`. `since` and `until` are inclusive `YYYY-MM-DD` local calendar days; either may be omitted for an unbounded end. Any other text throws, because a bound that merely compared as text would answer an empty slice and read as "no usage". `signal` cancels the scan between sessions and before each source read.

| Field | Meaning |
|---|---|
| `overall` | `UsageTotals` for the whole requested slice |
| `days` | One `UsageDay` per local calendar day with usage, ascending; days with none are omitted |
| `byModel` | One `UsageByModel` per provider route and model, descending by billable tokens |

`UsageTotals` carries `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `reasoningTokens`, `messages` (assistant messages that carried a usage record), and `sessions` (sessions contributing at least one counted message to that bucket). The buckets are disjoint the way [`TokenUsage`](../../llm/llm/README.md) defines them, so billable tokens are input plus both cache buckets plus output; `reasoningTokens` is part of `outputTokens` and is reported for visibility, never added again. `totalTokens(totals)` applies that sum.

### What counts

One `assistant/message` event contributes when it carried a `usage` record. Its bucket comes from the event's own recorded time, so a scan of old history lands on the days that history happened rather than on the day of the scan. Events a session inherited from its fork parent are the parent's spend and are skipped, so a fork and its parent never double-count the same message.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `ctx.sessionUsage`, the corpus scan, the cache read and write, and `/usage` |
| [`src/tools.ts`](src/tools.ts) | The `./tools` entry: the `usage` tool over `ctx.sessionUsage` |
| [`src/fold.ts`](src/fold.ts) | Pure fold from one raw event log to its `(day, provider, model)` cells, and `USAGE_FOLD_VERSION` |
| [`src/report.ts`](src/report.ts) | Pure aggregation from cells to a bounded `UsageReport`, and `totalTokens` |
| [`src/render.ts`](src/render.ts) | The plain text both `/usage` and the tool result show |
| [`src/cache.ts`](src/cache.ts) | The `session_usage_cache` domain and the row-reuse rule |
| [`src/types.ts`](src/types.ts) | The published report contract |

### Derived, never a ledger

A counter incremented as messages arrive would miss every session recorded before it was mounted and would drift from the logs the moment one write was lost. This package therefore keeps no running total: each report enumerates the corpus through `ctx.sessionQuery.listSessions`, reads each session through `ctx.sessionQuery.observeSession`, and folds. The logs remain the single authority for what was spent.

### The cache

Folding the whole corpus is O(all history), so each session's cells are cached in the `session_usage_cache` storage domain, one record per session id. The record carries the cells, the `USAGE_FOLD_VERSION` that produced them, and a freshness witness.

The witness is the `SessionPersistenceRevision` that `SessionPersistence.list` reports for the session. That token is the seam's own answer for this problem — its contract names derived read-model caches keyed off `stat`/`list` as its reason to exist — and `list` derives it from stored metadata without opening a log, which is what lets a scan learn which logs changed before reading any of them. The JSONL backend builds it from the log file's device, inode, size, and modification and change times, so an appended log always presents a new one. A revision promises only one direction: an equal value means an unchanged log, and anything else promises nothing. That is exactly what a cache needs, because every other outcome is a miss that folds the log again and produces the same answer. Revisions from different service instances are not comparable, so a witness written by another backend simply never matches.

A write that fails is logged and otherwise ignored: the figures being returned came from the logs and are already correct, so a storage fault costs speed on the next report and nothing else. A row is reused only when the witness is equal and the fold version is current. The row is written with the revision carried by the observation that was actually folded, not the one from the listing, so a log appended to between the listing and the read is never recorded as folded at a revision it never had. Live sessions have no durable revision and are still growing, so they are folded on every report and never cached. Rows for sessions that have left the corpus are deleted with them, so a removed session stops contributing. An absent, emptied, or unreadable cache changes only how long a report takes: invalid records are backed up and skipped by the domain, which makes them ordinary misses.

Changing which messages count, how days are bucketed, or how a cell is keyed must raise `USAGE_FOLD_VERSION` in the same commit. The witness proves the log is unchanged; it says nothing about the code that read it.

-----

<a id="model-experience"></a>
## Model Experience

### The `usage` tool

#### What the model sees

A read-only tool that returns the report as JSON and renders it as the same text `/usage` prints: overall totals, a table by provider route and model, and a twelve-week day grid. Optional `since` and `until` arguments bound the report to inclusive `YYYY-MM-DD` local days. The model calls it to see what its own work has cost. The tool ships as the `./tools` entry (`@deepseek-ai/dsh-session-usage/tools`), mounted separately from the service, so a surface that hides it leaves `/usage` working.

#### Token effect

Conditional: only the result of a call the model makes. The result is bounded by the number of distinct models and the fixed twelve-week grid, not by the size of the history scanned.

#### KV Cache effect

Append-only: the schema is fixed and results land as ordinary tool results.

## Known Limitations and Deferred Work

- **One unreadable log fails the whole report** — a session whose log cannot be read or replayed rejects `report()` rather than being dropped from the totals; the failure names the session and its log file. Silently omitting it would understate spend with nothing to show the reader that figures are missing, and the report contract has no field for a partial answer. A deployment that needs a report despite a damaged log has to repair or remove that session.
- **Sessions are read one at a time** — the scan folds sequentially and checks cancellation between sessions, so a first cold scan of a large corpus is bounded by serial log reads. Concurrency would need a tunable this package has no deployment evidence for.
- **Live sessions are folded on every report** — a live log has no durable revision to compare, so its events are re-folded each time. This costs nothing on disk but is linear in the live session's length.
- **Usage recorded only on the settled message counts** — the fold reads `assistant/message` usage records. Tokens billed for a retried attempt that never settled into a message, which `assistant/attempt` carries only in its stream, are not counted.
- **Without a persistence backend there is no cache** — no backend means no witness, so every report folds every live session from scratch. The figures are the same.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
