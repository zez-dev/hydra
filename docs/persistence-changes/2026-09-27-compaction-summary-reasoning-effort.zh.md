---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-27-compaction-summary-reasoning-effort

[English](2026-09-27-compaction-summary-reasoning-effort.md) | 中文

## 概述

为 compaction/summary 新增可选字段 reasoningEffort：摘要请求向路由申请的最低可选推理强度。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

已有记录仍然有效；该字段在旧记录以及不提供更低推理强度的路由上缺失。读者按原样重建摘要请求，存在该字段时附带推理强度。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/llm/llm/tests/reasoning.spec.ts packages/compaction/compaction-basic/tests packages/learning/learning/tests packages/guard/auto-continue/tests：238 个测试通过。

<a id="dev-note"></a>
## 开发备注

无。
