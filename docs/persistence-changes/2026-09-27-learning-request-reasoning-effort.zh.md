---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-27-learning-request-reasoning-effort

[English](2026-09-27-learning-request-reasoning-effort.md) | 中文

## 概述

为 session/learning-request 新增可选字段 reasoningEffort：回顾请求向路由申请的最低可选推理强度。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

已有记录仍然有效；该字段在旧记录以及不提供更低推理强度的路由上缺失。读者按原样重建辅助请求，存在该字段时附带推理强度。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/learning/learning/tests：61 个测试通过。

<a id="dev-note"></a>
## 开发备注

无。
