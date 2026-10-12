---
description: "The finance group map: the market-data capability seam, its keyless price and filing provider, and the model-facing market tools, for users and maintainers navigating the group."
kind: "package-group"
---

# packages/finance

## Summary

The finance group lets an agent research a listed company from public records: daily prices, the issuer as its regulator lists it, and the filings it has made. One service, `ctx.marketData`, answers the four questions; one provider answers them today from sources that need no vendor key; one consumer turns them into model tools and a `/market` command. A deployment with a market-data contract registers its own provider and changes nothing above it.

Everything this group returns is historical information for research. It is not investment advice, and no source here is a licensed real-time feed.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`market-data`](market-data/README.md) | Quotes, daily history, issuer profiles and filings through a provider registry, with a keyless Stooq and SEC EDGAR provider built in | `ctx.marketData` |
| [`tool-market`](tool-market/README.md) | Model tools `market_quote`, `market_history`, `market_profile`, `market_filings`, and the `/market` summary | registers on `ctx.tools` |

Both rows ship disabled in `dsh-base`: SEC EDGAR refuses a request that does not declare who is making it, so there is no honest default for the required contact field.

-----

<a id="related-documentation"></a>
## Related documentation

- [Web Access subsystem](../../docs/subsystems/web.md) — the generated `ctx.marketData` service API, beside the other outbound-network seam.
- [Generated tool catalog](../../docs/tool-catalog.md#deepseek-aidsh-tool-market) — the four market-tool schemas the model receives.
- [Generated configuration catalog](../../docs/config-catalog.md#deepseek-aidsh-market-data) — every accepted config field of the market-data service.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

`ctx.marketData` is documented on the Web Access page rather than a finance page of its own, because a subsystems page must exist in both languages before the catalog generator can write into it and this fork has not written its Chinese twins.

</details>
