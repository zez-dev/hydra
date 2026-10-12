---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-27-compaction-summary-reasoning-effort

English | [中文](2026-09-27-compaction-summary-reasoning-effort.zh.md)

## Summary

Adds the optional reasoningEffort field to compaction/summary: the route's lowest selectable reasoning effort the summarize call asked for.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-27-compaction-summary-reasoning-effort
baseline: false
changes:
  - root: "event:compaction/summary"
    previous: "2026-09-14-image-offload"
    after: "639f7da4c5c73748e367c4648d303f51885e7c10685674e362c5a506de0935b1"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing records remain valid; the field is absent on them and on routes that offer no lower effort. Readers reconstruct the summarize call exactly as before plus the effort when present.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/llm/llm/tests/reasoning.spec.ts packages/compaction/compaction-basic/tests packages/learning/learning/tests packages/guard/auto-continue/tests: 238 tests passed.

<a id="dev-note"></a>
## Dev Note

None.
