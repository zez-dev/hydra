---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-26-learning-review

English | [中文](2026-09-26-learning-review.zh.md)

## Summary

Adds the log-only session/learning-review event that records what one automatic learning review filed, or why it failed.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-26-learning-review
baseline: false
changes:
  - root: "event:session/learning-review"
    previous: null
    after: "cd7cb3eb137116b2b88b684cd64592ea4dbf3374a5ab717f7ef8cb0c60cf17fa"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing records remain valid: the event is new and appended with ignorable set, so a build without dsh-learning skips it. Producers append it once per reviewed turn after every candidate or finding is stored, or with a failed outcome carrying the failure code and message; its absence means no review ran for that turn.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/learning/learning/tests: 39 tests passed, including the deadline-cut and cap-cut reviews; packages/client/ui-chat/tests: the learning-review row renders filed, empty, and failed outcomes.

<a id="dev-note"></a>
## Dev Note

None.
