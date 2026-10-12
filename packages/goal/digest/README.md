---
description: "Daily reports for Hydra: /report and a scheduled writer that summarize goals, tickets, checkpoints, memory, spend, cron runs, and research breakthroughs into the workspace."
kind: "package-reference"
---

# @deepseek-ai/dsh-digest

## Summary

`dsh-digest` writes one Markdown report per day into the workspace, `<cwd>/.dsh/reports/<YYYY-MM-DD>.md`, summarizing what Hydra did: live goals and their phases, ticket counts and the tickets that changed, checkpoint commits, memory candidates and approvals, tokens spent, scheduled runs, and research breakthroughs journaled that day. `/report` writes it on demand; `dailyAt` writes it on a timer for every live workspace and announces the path through `dsh-notify` when mounted. Goals and tickets are required; every other section reads its seam only when that plugin is mounted and says so otherwise.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The `dsh-base` bundle mounts the row `digest` with no timer. Type `/report` in any session with a workspace to write today's report; the command's reply carries the path and the report text.

| Field | Default | Meaning |
|---|---|---|
| `weeklyOn` | absent (`/report week` only) | Local `<weekday> HH:MM` (for example `mon 07:00`) at which the weekly review is written for every live workspace; the write also sends `weeklyDigest` through `dsh-notify` when mounted |
| `dailyAt` | absent (`/report` only) | Local `HH:MM` at which the report is written for every live workspace; the write also sends `dailyDigest` through `dsh-notify` when mounted |

A malformed `dailyAt` fails activation. The timer fires once per day at the configured minute; a firing writes each distinct workspace of the live agents and schedules the next day.

### The weekly review

`/report week` writes `<workspace>/.dsh/reports/week-<YYYY-Www>.md` (ISO week) over the last seven local days. Every daily report ends with an HTML comment `<!-- hydra-digest {...} -->` carrying the day's totals as JSON; the weekly review reads those footers rather than re-deriving the days, fills a day without a report with zeros, and derives today's totals from the live seams when today's report does not exist yet. The Trends table shows a sparkline and per-day numbers for tickets opened and closed (`verified`, `closed`, `wontfix` count as closed), checkpoints, research breakthroughs, memory approvals, spend tokens, and cron runs, plus "spend per outcome" (tokens divided by closed tickets plus breakthroughs) when both are known. "What moved" lists tickets created or changed in the week, breakthroughs journaled in the week, and goals that completed or blocked; "Still open" lists `needs-human` tickets and the open hypotheses per research journal. Spend history comes only from the daily footers because the spend guard keeps one day total; the report names its spend source.

### Extension points

- `ctx.digest.collect(cwd, at?)` returns the gathered facts as a `DigestInput`; `ctx.digest.write(cwd, at?)` renders and writes the file and returns the `DigestReport`.
- Optional seams are read structurally by service key: `tickets` (`storeFor(cwd)`; the Tickets section reports absence without it), `tickets` (`storeFor(cwd)`; the Tickets section reports absence without it), `checkpoints` (`list(sessionId)`), `memory` (`list()`), `spendGuard` (`dayTokens()`), `cronSessions` (`list()`), and `notify` (`send`). Research breakthroughs and open hypotheses come from `<dir>/*/journal.md`, where `<dir>` is the mounted `research` service's configured directory (`ctx.research.dir`, resolved against the workspace when relative); without that service the research sections report absence. Breakthroughs are bullets under `## Breakthroughs` that start with `[YYYY-MM-DD]`.
- `parseDailyAt`, `msUntil`, `isOnDate`, `breakthroughsOn`, and `renderDigest` are exported for reuse; the local calendar day comes from `localDateKey` in `@deepseek-ai/dsh-util-time`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: seam reads, the `digest` service, `/report`, the daily timer |
| [`src/report.ts`](src/report.ts) | Time-of-day parsing, local calendar math, journal scanning, the Markdown renderer |
| [`src/types.ts`](src/types.ts) | `DigestInput`, `DigestReport`, `DigestService` |

"Today" is the local calendar date of the moment the report is written; ticket, checkpoint, memory, and cron rows are included when their ISO timestamps fall on that date. Goals are read from live agents whose session `cwd` is the workspace, so a stored session that is not open contributes no goal line.

No invariant companion is published because each report is rendered at write time from records other plugins own, and the plugin keeps nothing between reports except the written file.

-----

<a id="model-experience"></a>
## Model Experience

None, as this package registers no tool or prompt text; the report is a file the model may read like any other workspace file.

#### KV Cache effect

Independent: nothing here changes a model request.

## Known Limitations and Deferred Work

- **Weekly spend needs daily reports** — the spend guard exposes today's total only, so a day without a daily report contributes no spend to the weekly review and the report says so.
- **Live agents only** — goals and checkpoints come from open sessions; a workspace with no live agent at the timer's firing gets no report.
- **Session spend is process-local** — the spend line is `dsh-spend-guard`'s daily total, which survives restarts; per-session totals do not and are not reported.
- **No retention** — reports accumulate under `.dsh/reports`; nothing prunes them.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
