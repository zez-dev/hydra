---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-27-learning-request-reasoning-effort

English | [中文](2026-09-27-learning-request-reasoning-effort.zh.md)

## Summary

Adds the optional reasoningEffort field to session/learning-request: the route's lowest selectable reasoning effort the review asked for.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-27-learning-request-reasoning-effort
baseline: false
changes:
  - root: "event:session/learning-request"
    previous: "2026-09-22-hydra-plugin-events"
    after: "db9f9ca81a3be6939994155219e07266c4dd0be6e6f58706856189508da68b50"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing records remain valid; the field is absent on them and on routes that offer no lower effort. Readers reconstruct the auxiliary request exactly as before plus the effort when present.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/learning/learning/tests: 61 tests passed.

<a id="dev-note"></a>
## Dev Note

None.
