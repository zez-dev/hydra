---
description: "Model tools market_quote, market_history, market_profile and market_filings over the market-data seam, plus the /market one-screen symbol summary."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-market

## Summary

`dsh-tool-market` is the model-facing half of the market-data capability. It registers four tools on `ctx.tools` — `market_quote`, `market_history`, `market_profile` and `market_filings` — and the `/market <symbol>` command for people. It owns the schemas, the caps that bound one call, and the compact text a result renders to; it never names a source, so swapping the provider under [`dsh-market-data`](../market-data/README.md) changes nothing here.

Every tool description ends by telling the model the data is historical research material and not investment advice.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The `dsh-base` bundle carries the row disabled alongside the seam it needs; enable both in the same profile patch.

| Field | Default | Meaning |
|---|---|---|
| `maxSymbols` | `10` | Symbols one `market_quote` call may name; extras are dropped |
| `maxBars` | `60` | Sessions one `market_history` call may return |
| `maxFilings` | `10` | Filings one `market_filings` call may return |
| `summaryBars` | `30` | Sessions `/market` reads for its range line |

`/market AAPL` prints one screen: the issuer as EDGAR lists it, the latest close with its change, the recent close range, the three most recent filings, and the disclaimer. A symbol EDGAR does not list still gets its prices and range; the issuer and filing lines are simply absent.

A `/market` summary is also filed into the session's research journal when [`dsh-research`](../../goal/research/README.md) is mounted and the agent has an active research goal, so the reading survives compaction and the session. The hand-off reads through `ctx.get('research')`, so this package never requires that plugin; without it, or without an active goal, nothing is recorded and the summary still prints.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | The four tool registrations, the `/market` command, and the research hand-off |
| [`src/render.ts`](src/render.ts) | Pure renderers: quote lines, the history table, profile lines, filing lines, the summary |
| — | No runtime invariant companion is published; this model-facing adapter has no independent lifecycle stream, and every market relation is owned by the seam it calls. |

Caps are applied before the seam is asked, not after it answers, so a `limit` of 500 costs one request for `maxBars` sessions rather than a truncated large one. Every cap tells the model when it bit: a capped series and a capped filing list say `older ones omitted` in a header, and a quote call that named more symbols than it may says how many were left unquoted.

-----

<a id="model-experience"></a>
## Model Experience

### The four market tools

#### What the model sees

Four schemas. `market_quote` takes `symbols` and explains that a symbol is a ticker such as `AAPL`, or `TICKER.EXCHANGE` for a non-US listing, and that the close is the last completed session rather than a live price. `market_history` takes `symbol` with optional `from`, `to` and `limit`, and returns a fixed-width table of daily open, high, low, close and volume, oldest session first. `market_profile` takes `symbol` and returns the issuer as the securities regulator lists it. `market_filings` takes `symbol` with optional `forms` and `limit`, returns one line per filing with a document URL, and points the model at the web fetch tool to read a filing's contents. Every description ends with `Historical market data for research; not investment advice.`

#### Token effect

Fixed: four tool schemas in every request of a session that has them visible. Results are bounded by the caps above — a quote is one line per symbol, a history is at most `maxBars` short rows, and filings are at most `maxFilings` single lines.

#### KV Cache effect

Prefix-stable: the schemas embed the configured caps but do not change across requests, so they do not invalidate a cached prefix.

## Known Limitations and Deferred Work

- **No Web card** — results reach the model and the terminal as text; a chart or a sidebar panel is deferred.
- **No comparison tool** — ranking or correlating several symbols is left to the model over separate calls, which costs one request per symbol.
- **Only `/market` files a finding** — a tool call the model makes on its own is not journalled, because the model can already write what it concluded with the journal tool.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

[`tests/loader-composition.spec.ts`](tests/loader-composition.spec.ts) boots a real `cordis.yml` through the Loader with the transport stubbed from the seam's recorded fixtures; it is the test to extend when a tool's model-visible text changes.

</details>
