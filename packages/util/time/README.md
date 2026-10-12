---
description: "IANA time-zone validation and canonicalization and the local calendar-day key, for maintainers accepting a caller-reported zone or bucketing instants by day."
kind: "package-library"
---

# dsh-util-time

English | [中文](README.zh.md)

## Summary

Zero-dependency time vocabulary for two jobs. `canonicalClientTimeZone` admits `UTC` or an IANA `Area/Location` name and answers the platform-canonical spelling of it, so an alias never reaches a durable record: a zone identity is stored on messages and re-derived later by another process, where an alias would not compare equal. `localDateKey` places an instant on its local calendar day as `YYYY-MM-DD`, the one key every consumer that groups or bounds work by day compares and sorts on. The library owns no failure vocabulary, because each boundary throws its own domain code.

## Table of Contents

- [Use this package](#use-this-package)
- [API](#api)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

It is a **library, not a service or plugin**: no `ctx`, registers nothing, holds no state.

No runtime invariant companion is published because this pure utility owns no event stream or mutable runtime data; unit tests verify zone canonicalization and day placement.

Call it at the boundary that receives the zone, before the value reaches anything durable. An unusable name answers `undefined`, and the caller raises its own refusal — `session/invalid-time-zone` for the Session prompt, `subagent/invalid-time-zone` for a subagent continuation.

-----

<a id="api"></a>
## API

```ts
import { canonicalClientTimeZone, localDateKey } from '@deepseek-ai/dsh-util-time'
```

| Export | Role |
|---|---|
| `canonicalClientTimeZone(value)` | Canonical `UTC` or IANA `Area/Location` name for an accepted zone, `undefined` for a blank, padded, abbreviated, single-segment, or platform-unsupported one. |
| `localDateKey(date)` | The instant's local calendar day as zero-padded `YYYY-MM-DD`, which therefore compares and sorts lexicographically. |

<a id="model-experience"></a>
## Model Experience

Indirectly, through the consumer that records a canonical zone on a durable message, from which `dsh-time-context` renders the turn's model-visible zone instruction and timestamp.

#### KV Cache effect

None of its own. The consumer that injects a zone-derived line into a request owns that request's cache behavior.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Alias resolution follows the runtime's ICU data** — which name an alias group canonicalizes to is the platform's answer, so two processes on different Node builds can disagree about it.
- **No offset arithmetic** — no formatting beyond the day key, no DST reasoning, and no instant conversion; consumers needing those use `Intl` directly.
- **`localDateKey` reads the host zone** — it uses the process's own local time, not a caller-supplied zone, so a consumer that must bucket in another zone converts first.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
