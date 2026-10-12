---
description: "The market-data service (ctx.marketData): quotes, daily history, issuer profiles and regulatory filings through interchangeable providers, with a keyless Stooq and SEC EDGAR provider built in."
kind: "package-reference"
---

# @deepseek-ai/dsh-market-data

## Summary

`dsh-market-data` publishes `ctx.marketData`, the seam a consumer asks for market records through without naming a source: `quote`, `history`, `profile` and `filings`. It ships one provider that needs no vendor key, reading daily price series from [Stooq](https://stooq.com/) and issuer profiles and filings from [SEC EDGAR](https://data.sec.gov/). A keyed vendor registers on the same registry later and every consumer keeps working. The model-facing half lives in [`tool-market`](../tool-market/README.md).

Prices are the last settled daily session, not a live tick, and everything this package returns is historical information for research, not investment advice.

## Table of Contents

- [Use this package](#use-this-package)
- [Data sources and their terms](#data-sources-and-their-terms)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The `dsh-base` bundle carries the row disabled, because `secUserAgent` has no usable default. Enable it in a profile patch that names a real contact.

| Field | Default | Meaning |
|---|---|---|
| `secUserAgent` | required | Sent as `User-Agent` to `sec.gov`; SEC requires a declaring name and email. An empty value throws at activation |
| `timeoutMs` | `15000` | Deadline for one source request |
| `cacheTtlMs` | `300000` | How long one URL's response stays reusable in memory |
| `minRequestGapMs` | `120` | Minimum gap between two requests to the same host |
| `maxBodyBytes` | `8388608` | Cap on one response body |
| `provider` | unset | Provider id to use; unset auto-selects when exactly one is usable |
| `builtinProvider` | `true` | Register the keyless Stooq and EDGAR provider |

Failures carry a `MarketDataError` with a stable `code`: `MARKET_SYMBOL_UNKNOWN` (the source carries no such symbol), `MARKET_SOURCE_TIMEOUT`, `MARKET_SOURCE_REFUSED` (a non-2xx answer, including rate limiting), `MARKET_SOURCE_UNREADABLE` (an answer that did not parse or exceeded `maxBodyBytes`), `MARKET_PROVIDER_UNAVAILABLE`, `MARKET_PROVIDER_AMBIGUOUS` and `MARKET_UNSUPPORTED`. Route on the code; the message is for people.

### Extension points

- `ctx.marketData.register(provider)` adds a `MarketDataProvider` under its own `id` and returns a disposer. A duplicate id throws.
- Provider selection resolves per call: a configured `provider` that is registered and reports `available()` wins; otherwise exactly one usable provider is required, so selection never depends on registration order.

-----

<a id="data-sources-and-their-terms"></a>
## Data sources and their terms

| Source | What it answers | Terms |
|---|---|---|
| `stooq.com` | Daily open, high, low, close and volume, as CSV | Free for personal use; no redistribution licence is granted here |
| `data.sec.gov`, `www.sec.gov` | Issuer name, CIK, industry description, and the filing index | Public-domain US government records, subject to SEC's fair-access policy |

SEC asks automated clients to declare who they are and to stay under ten requests a second. `secUserAgent` is the declaration and `minRequestGapMs` is the pace; both are your responsibility to set honestly. Stooq publishes no formal API terms, so treat its data as personal-use only and check the site before redistributing, embedding in a product, or driving trades with it. Neither source is a licensed market-data feed: quotes lag the tape by at least one session, coverage and corporate-action handling are not guaranteed, and nothing here is investment advice. A deployment with a vendor agreement should register its own provider rather than lean on these.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `MarketDataRuntime`: the service, its config, the provider registry and selection |
| [`src/provider.ts`](src/provider.ts) | `StooqEdgarProvider`: the four operations over the two keyless sources |
| [`src/transport.ts`](src/transport.ts) | `Transport`: host allowlist, per-request deadline, pacing, cache, status mapping |
| [`src/parse.ts`](src/parse.ts) | Pure readers for Stooq CSV and the three EDGAR documents |
| [`src/types.ts`](src/types.ts) | `Quote`, `Bar`, `History`, `Profile`, `Filing`, `MarketDataProvider`, `MarketDataError` |
| — | No runtime invariant companion is published; the provider map is private and the cache, pacing and body caps are enforced inside one transport per mount, so no second observation of them exists to diverge. |

The transport is the only place this package reaches the network. It accepts `https` to `stooq.com`, `data.sec.gov` and `www.sec.gov` and nothing else, refuses redirects outright rather than following one to an unlisted host, aborts each request on its own deadline, and stops reading a body that passes the byte cap. Responses are cached by URL for `cacheTtlMs`, so a `/market` summary that reads prices and filings for one symbol twice in a minute makes one request each. Errors name the host, never the full URL, so a query string never reaches a log.

`internals` holds a replaceable `fetch` and clock. The Loader passes only config, so a test assigns `ctx.marketData.internals` after mounting and before the first call; the built-in provider is constructed on that first call, which is why assignment after mounting still takes effect. No test in this package opens a socket.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through [`dsh-tool-market`](../tool-market/README.md), which owns every schema, cap and rendering the model sees.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

- **No live prices** — Stooq publishes settled daily sessions, so a quote taken during market hours is the previous close. Intraday needs a keyed vendor and a new provider.
- **No corporate-action model** — splits and dividends arrive however Stooq already applied them; this package neither adjusts a series nor reports what was adjusted.
- **US filers only for profiles** — EDGAR lists SEC registrants, so a foreign or delisted symbol usually has prices but no profile and no filings.
- **No fundamentals** — EDGAR's company-facts and XBRL frames are not read, so revenue, margins and balance-sheet lines are unavailable; `filings` gives a document URL for a consumer to fetch instead.
- **No persistent cache** — the response cache is per process and per mount, so a restart re-reads every symbol.
- **No session events** — market reads are visible to the model only as tool results recorded by the tool runtime; the seam writes nothing to the session log of its own.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Fixtures under [`tests/fixtures.ts`](tests/fixtures.ts) were written by hand to each source's published format, not captured from a live call: three Stooq sessions, a two-entry ticker map, and a three-filing submissions document. No request has been made from this fork, so the parsers are unverified against what the sources serve today. Capture a real body and compare before trusting a first run; the parsers reject an unexpected header rather than guessing at it.

</details>
