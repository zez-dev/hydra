---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-31-evidence-review-source

English | [中文](2026-10-31-evidence-review-source.zh.md)

## Summary

Adds `plugin:dsh-evidence-guard`, the message source kind of the review requests `@deepseek-ai/dsh-evidence-guard/review` steers.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-31-evidence-review-source
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-30-hydra-plugin-persistence"
    after: "9b0676ae66f4164f5eddd64cab4edd5032b4fffbd42b38b9608375d345994840"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-30-hydra-plugin-persistence"
    after: "f0dad0b052d726e54e2c6b3cb567ef2d0504f8e6bebeec0ca89e37b4eb959f86"
    decision: same-version
  - root: "event:session/checkpoint-critic"
    previous: "2026-10-30-hydra-plugin-persistence"
    after: "bca2b449d1203511dc387a5fa386c119619189212541ca9dc23e8bf03a1848f7"
    decision: same-version
  - root: "event:session/goal-evaluation"
    previous: "2026-10-30-hydra-plugin-persistence"
    after: "49506a88cb8ecac695457c25c97225740e7852b160661a62484ae114e1ac403c"
    decision: same-version
  - root: "event:session/learning-request"
    previous: "2026-10-30-hydra-plugin-persistence"
    after: "20842a8dcf33601b1b207a84789e3d55fa0f22e37e65206498eceed202bf99e2"
    decision: same-version
  - root: "event:session/research-score"
    previous: "2026-10-30-hydra-plugin-persistence"
    after: "e6a0c0def77dc1887f0cfd82b07aa77c4e939cfb69fd1b00923c1de0681c7744"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-30-hydra-plugin-persistence"
    after: "dd3a1e0b3d861aad7d442d1d7073f3169a4ff38425bcff428953f2d3f5738e67"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-30-hydra-plugin-persistence"
    after: "7b643e033c9636a9e4eebdec83e1d4320122b5d0916614dc5dd956f18231f022"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

No existing field changes, and existing records remain valid. The kind is declared with `@persistenceAttribution`, so a reader without dsh-evidence-guard keeps the message, its kind, and its metadata unchanged, and the kind imposes no validation, replay, or authority requirement. Only sessions that enable the review row write it.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/guard/evidence-guard/tests: 34 tests passed, including a review request logged through the Loader composition.

<a id="dev-note"></a>
## Dev Note

None.
