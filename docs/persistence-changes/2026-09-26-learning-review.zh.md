---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-26-learning-review

[English](2026-09-26-learning-review.md) | 中文

## 概述

新增仅记录日志的 session/learning-review 事件，记录一次自动学习回顾提交了什么，或为何失败。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

已有记录仍然有效：该事件是新增的，并以 ignorable 追加，未装载 dsh-learning 的构建会跳过它。写入方在每个被回顾的轮次存储完所有候选或发现后追加一次，或在失败时追加带失败码和消息的 failed 结果；缺失表示该轮次没有运行回顾。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/learning/learning/tests：39 个测试通过，含超时中断与输出上限截断的回顾；packages/client/ui-chat/tests：learning-review 行渲染已提交、无新内容和失败三种结果。

<a id="dev-note"></a>
## 开发备注

无。
