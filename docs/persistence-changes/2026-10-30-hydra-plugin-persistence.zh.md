---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-30-hydra-plugin-persistence

[English](2026-10-30-hydra-plugin-persistence.md) | 中文

## 概述

记录 Hydra 在 DeepSeek Harness 0.2.2-alpha.2 之上新增的会话持久化类型：七个可忽略的仅日志事件、compaction/summary 上可选的 reasoningEffort，以及 Hydra 插件注入消息所用的七个由生产方拥有的归属类型。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
    after: "9eb73c60b1f557075b1a2a943616ac09fafd06e73e7b7763aab794e4deebee0a"
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
    after: "993a2ada1bc3a942e38b09f182fdb72da315626aaf3fd5ef3f3b8b64623310c8"
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
## 兼容性

七个事件均为新的根，写入时带有信封的 ignorable 标记：command-gate/blocked、compaction/pressure、session/checkpoint-critic、session/goal-evaluation、session/learning-request、session/learning-review 和 session/research-score。未声明它们的构建会跳过这些记录，仍能重建会话；模型输入不由它们派生，占用量表读取 compaction/pressure，聊天界面渲染 session/learning-review。compaction/summary 上的 reasoningEffort 字段是可选的：较早的记录没有该字段，读取方照旧重建摘要调用，存在时再加上该推理强度。来源类型 plugin:dsh-memory、plugin:dsh-research、plugin:dsh-goal-evaluator、plugin:dsh-spend-guard、plugin:dsh-auto-continue、plugin:dsh-learning 和 plugin:tool-todo 已限定为仅归属：没有该生产方的读取方保留消息内容和全部来源字段，每个生产方只用自己的类型识别自己的消息。它们正是 V3 到 V4 迁移为这些插件已发布的 plugin 包装来源所赋予的名称，因此迁移后的 Hydra 日志与新写入的行携带相同的类型。本记录取代 Hydra 先前的五条记录，那些记录的模式快照早于节点表清单和 V4 历史。

<a id="verification"></a>
## 验证

pnpm run typecheck：5 个门禁通过。vitest run packages/learning packages/goal packages/guard packages/todo/tool-todo packages/compaction/compaction-basic packages/llm/token-meter：1,121 个测试中 1,120 个通过；唯一的失败是 packages/goal/research/tests/journal.spec.ts 中的一个文件监视时序测试，本变更未涉及它，重新运行即通过。

<a id="dev-note"></a>
## 开发备注

无。
