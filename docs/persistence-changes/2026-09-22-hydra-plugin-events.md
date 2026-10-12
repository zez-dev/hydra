---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-22-hydra-plugin-events

English | [中文](2026-09-22-hydra-plugin-events.zh.md)

## Summary

Adds five log-only Session event types written by the Hydra plugins.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-22-hydra-plugin-events
baseline: false
changes:
  - root: "event:command-gate/blocked"
    previous: null
    after: "aedd6720afa4baf4ccd24bce64ad9900c8b4cf06216e8acbe76e635e5d5d8942"
    decision: same-version
  - root: "event:session/checkpoint-critic"
    previous: null
    after: "8f5e84f4a8f5dcfa4c4db0db018711a6dd256c02b21f0e9ee17cdb473e084335"
    decision: same-version
  - root: "event:session/goal-evaluation"
    previous: null
    after: "2e37920d9d2ca9317cca405e53eada0595d2f187bef109d7ac375f4dfd9efa6c"
    decision: same-version
  - root: "event:session/learning-request"
    previous: null
    after: "bc37a08b341f0a9d5f4e7b0a85254c584a8fb9db06b279564a957aa55055f1b0"
    decision: same-version
  - root: "event:session/research-score"
    previous: null
    after: "0bf0b07d8b6015ac5b1bd9fec1ddd1906fe11fb7cf1da77f6b649e474f406228"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

All five are new roots, so records written before them stay valid and no existing event changed. Each is written with the envelope's ignorable marker, so a build that does not declare these types skips the records and still reconstructs the session; only the audit trail of those auxiliary model requests is lost. Each has one producer and no reader, and none contributes to the message surface.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/core/session/tests/session.spec.ts: 78 tests passed, including one asserting an appended log-only event carries the marker only when the writer asks. pnpm run typecheck: exit 0.

<a id="dev-note"></a>
## Dev Note

None.
