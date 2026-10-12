---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-22-hydra-plugin-events

[English](2026-09-22-hydra-plugin-events.md) | 中文

## 概述

新增五个由 Hydra 插件写入的仅日志 Session 事件类型。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

五者均为新根，此前写入的记录仍然有效，且未更改任何已有事件。每条记录都带有信封的 ignorable 标记，因此未声明这些类型的构建会跳过它们并仍能重建会话，仅丢失这些辅助模型请求的审计记录。每个类型只有一个写入方且无读取方，均不参与消息表面。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/core/session/tests/session.spec.ts：78 个测试通过，其中一个断言仅在写入方要求时追加的仅日志事件才带有该标记。pnpm run typecheck：退出码 0。

<a id="dev-note"></a>
## 开发备注

无。
