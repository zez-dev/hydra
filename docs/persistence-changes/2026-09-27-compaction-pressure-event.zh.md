---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-27-compaction-pressure-event

[English](2026-09-27-compaction-pressure-event.md) | 中文

## 概述

新增仅记录日志的 compaction/pressure 事件：压缩后端为即将发出的请求计价的结果，以及下一步触发压缩的阈值。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

已有记录仍然有效；该事件可忽略，不认识它的构建会跳过它。没有任何模型输入由它派生：上下文占用表读取它，使读者看到的数字与后端据以决策的数字一致。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/llm/token-meter/tests packages/client/ui-conversation/tests/context-meter.client.spec.tsx packages/compaction/compaction-basic/tests/window-fit.spec.ts：154 个测试通过。

<a id="dev-note"></a>
## 开发备注

无。
