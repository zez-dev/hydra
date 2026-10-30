---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-30-hydra-plugin-persistence

English | [中文](2026-10-30-hydra-plugin-persistence.zh.md)

## Summary

Records the Session persistence types Hydra adds on top of DeepSeek Harness 0.2.2-alpha.2: seven ignorable log-only events, an optional reasoningEffort on compaction/summary, and seven producer-owned attribution kinds for the messages Hydra plugins inject.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-30-hydra-plugin-persistence
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "9d3e15994447d49f33ba71fc154281991c878e9650657d5e841d1b7e694bff3c"
    decision: same-version
  - root: "event:command-gate/blocked"
    previous: null
    after: "aedd6720afa4baf4ccd24bce64ad9900c8b4cf06216e8acbe76e635e5d5d8942"
    decision: same-version
  - root: "event:compaction/pressure"
    previous: null
    after: "efa8f4edcbd6d6eabf19eb27bb2593ccac14fa89842ccd43f499c52d31ce53f4"
    decision: same-version
  - root: "event:compaction/summary"
    previous: "2026-09-16-session-format-v4"
    after: "8cd2f19c03f77ae26dcd90dd62951c19d425a1a88f6695ff51372b7e9c117747"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "7fd6c59c1c7f95782a4006f31ce479c74f6d92494fbacce51e14d9ce1937e12a"
    decision: same-version
  - root: "event:session/checkpoint-critic"
    previous: null
    after: "43d7f814a545653c32a98194debefcfde498bd51c6d9c9189a9d48e5987f75ca"
    decision: same-version
  - root: "event:session/goal-evaluation"
    previous: null
    after: "ca21147b007a857494b8febaecf8be66ababdf55169bf77225bc2fa9a47f638d"
    decision: same-version
  - root: "event:session/learning-request"
    previous: null
    after: "459000197e80c20a986f9751ccc6b54ed1888c5e422523d4a05775530de7e87a"
    decision: same-version
  - root: "event:session/learning-review"
    previous: null
    after: "cd7cb3eb137116b2b88b684cd64592ea4dbf3374a5ab717f7ef8cb0c60cf17fa"
    decision: same-version
  - root: "event:session/research-score"
    previous: null
    after: "3ca068db4c6e57b2a2d6550a0fa378cdae36b63658ee33675853480e029837a6"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "c62c89f7847e5be4349f2efa1194282e03e20eb58af33281adf635a7da36cae0"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "cc555ab032a139532d7168460cb3179f7e6b2d5727baf95d3906e5d0a1686418"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

The seven events are new roots written with the envelope's ignorable marker: command-gate/blocked, compaction/pressure, session/checkpoint-critic, session/goal-evaluation, session/learning-request, session/learning-review, and session/research-score. A build that does not declare them skips the records and still reconstructs the Session; nothing derives model input from them, while the occupancy meter reads compaction/pressure and the chat renders session/learning-review. The reasoningEffort field on compaction/summary is optional: earlier records lack it, and readers reconstruct the summarize call as before plus the effort when present. The source kinds plugin:dsh-memory, plugin:dsh-research, plugin:dsh-goal-evaluator, plugin:dsh-spend-guard, plugin:dsh-auto-continue, plugin:dsh-learning, and plugin:tool-todo are qualified attribution-only: a reader without the producer keeps the message content and every source field, and each producer uses its kind only to recognize its own messages. They are the names the V3-to-V4 migration gives these plugins' released plugin-wrapper sources, so migrated Hydra logs and new rows carry the same kinds. This record replaces Hydra's five earlier records, whose schema snapshots predate the node-table inventory and the V4 history.

<a id="verification"></a>
## Verification

pnpm run typecheck: 5 gates passed. vitest run packages/learning packages/goal packages/guard packages/todo/tool-todo packages/compaction/compaction-basic packages/llm/token-meter: 1,120 of 1,121 tests passed; the one failure is a file-watcher timing test in packages/goal/research/tests/journal.spec.ts that this change does not touch, and it passes on rerun.

<a id="dev-note"></a>
## Dev Note

None.
