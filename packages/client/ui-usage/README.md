---
description: "The token-usage dashboard tab in the Web right sidebar: overall totals, a 12-month day heatmap, and a per-model table."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-usage

## Summary

`ui-usage` registers a `usage` tab type in the right sidebar. The dashboard shows the billable total across every recorded session with its input, output, cache-read, cache-write and reasoning breakdown and the message and session counts; then a contribution heatmap of the last 12 months, one column per week and one row per weekday, shaded by tokens that day and naming the date and exact count on hover; then a table of every provider route and model with its total, input, output and messages. One `usage` Remote call fills all three.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The `dsh-web-app` bundle mounts the row `ui-usage` beside `usage-controller`. Open the dashboard from the right sidebar's guide page ("Token usage"). There is no configuration; copy lives in the `sidebarUsage` dictionary.

Two figures are the Host's, never re-derived here:

- The headline total is `totals.totalTokens`, which the Host summed as input plus both cache buckets plus output.
- Reasoning is drawn indented under output and labelled as counted inside it, because it is a part of `outputTokens` rather than a bucket of its own.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

| File | Role |
|---|---|
| [`src/client/index.ts`](src/client/index.ts) | Registers the type, the dictionaries, the dashboard body, and the chip title |
| [`src/client/definition.tsx`](src/client/definition.tsx) | The tab type (page, builtin band, guide entry at order 40) and the dashboard glyph |
| [`src/client/face.ts`](src/client/face.ts) | The Remote face: the single `report` read over the `usage` namespace |
| [`src/client/grid.ts`](src/client/grid.ts) | The heatmap's calendar model: window, columns, filled-in idle days, intensity |
| [`src/client/UsageHeatmap.tsx`](src/client/UsageHeatmap.tsx) | The squares, the weekday and month labels, the legend |
| [`src/client/UsageBody.tsx`](src/client/UsageBody.tsx) | Totals, the model table, loading, failure and refresh |
| [`src/client/UsageTitle.tsx`](src/client/UsageTitle.tsx) | The chip title |
| [`src/client/locales.ts`](src/client/locales.ts) | zh and en dictionaries |

### The heatmap's calendar is a mirror, kept honest by a test

`dsh-session-usage` already renders a day grid for the text `/usage`, and its `addDays` advances through the date field — `new Date(y, m, d + n)` — precisely so a daylight-saving transition cannot shift a column. That renderer is a Host module: the client bundle-purity gate admits a runtime import only from the default client externals, an inline-safe wire layer, or a generated `/remote` contribution, and `dsh-session-usage` is none of the three, so its arithmetic cannot be imported and is restated in [`src/client/grid.ts`](src/client/grid.ts).

[`tests/grid.client.spec.ts`](tests/grid.client.spec.ts) is what keeps the two restatements one calendar. It builds the dashboard grid over a window sized to exactly cover the text grid's 12 weeks, renders the text grid from the same day series through `renderUsageReport`, and asserts square for square that the two place the same days in the same rows and columns and pick the same intensity — at both daylight-saving Sundays, either side of a year boundary, on a leap day, and on a window that opens on a Sunday or closes on a Saturday. A change to either calendar that the other does not follow fails that test.

### Idle days and partial weeks

The report omits days with no usage, so the grid fills them back in: every day in the window is a square, and an idle one is an ordinary square at level 0 rather than a hole. Columns run from the Sunday on or before the window's first day to the Saturday on or after today, so the first and last columns carry blank padding squares for the days outside the window — distinct in the DOM from a day that simply recorded nothing.

-----

<a id="model-experience"></a>
## Model Experience

None, as this package contributes browser presentation only.

#### KV Cache effect

Independent: nothing here reaches a model request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Refresh is manual** — the `usage` Remote namespace carries no change feed, because `ctx.sessionUsage` emits no event when a session log grows. The dashboard reads once when the tab opens and again on Refresh.
- **The heatmap window is fixed at one year** — the dashboard asks for an unbounded report and clips its own 12 months out of the day series. `report` accepts `since` and `until`, but no control offers them yet.
- **Intensity is relative to the window's busiest day** — an all-time figure would make a quiet year look empty, so the five steps are quarters of the busiest day in view, and the legend names that day's count.
- **The intensity ramp is mixed from one accent token** — `ui-theme` publishes no sequential `--dsw-*` scale, so the five steps are `color-mix` shares of `--dsw-alias-brand-primary`. A published scale should replace them.
- **Grouped digits are `en-US`** — figures are formatted with a fixed `Intl.NumberFormat('en-US')`, matching the text `/usage`, rather than following the viewer's locale.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

No runtime invariant companion is published. The dashboard derives everything it draws from one Remote value, so it owns no relation that could diverge from another observation.

</details>
