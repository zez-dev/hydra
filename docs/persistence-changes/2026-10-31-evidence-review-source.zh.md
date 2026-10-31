---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-31-evidence-review-source

[English](2026-10-31-evidence-review-source.md) | 中文

## 概述

新增 `plugin:dsh-evidence-guard`，即 `@deepseek-ai/dsh-evidence-guard/review` 引导的复核请求所用的消息来源类型。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

没有任何已有字段变化，已有记录仍然有效。该类型以 `@persistenceAttribution` 声明，因此未安装 dsh-evidence-guard 的读取方会原样保留这条消息、其类型与元数据，且该类型不附加任何校验、回放或权限要求。只有启用复核行的会话才会写入它。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/guard/evidence-guard/tests：34 个测试通过，其中包括通过 Loader 组合记录的复核请求。

<a id="dev-note"></a>
## 开发备注

无。
