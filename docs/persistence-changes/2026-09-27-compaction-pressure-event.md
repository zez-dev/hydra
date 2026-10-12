---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-27-compaction-pressure-event

English | [中文](2026-09-27-compaction-pressure-event.zh.md)

## Summary

Adds the log-only compaction/pressure event: the request as the compaction backend priced it and the threshold the next step condenses at.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-27-compaction-pressure-event
baseline: false
changes:
  - root: "event:compaction/pressure"
    previous: null
    after: "efa8f4edcbd6d6eabf19eb27bb2593ccac14fa89842ccd43f499c52d31ce53f4"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing records remain valid; the event is ignorable, so a build that does not know it skips it. Nothing derives model input from it: the occupancy meter reads it so the figure a reader sees is the one the backend acted on.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/llm/token-meter/tests packages/client/ui-conversation/tests/context-meter.client.spec.tsx packages/compaction/compaction-basic/tests/window-fit.spec.ts: 154 tests passed.

<a id="dev-note"></a>
## Dev Note

None.
