---
description: "webhook 包组导览：从 Hydra 的目标和智能体向 webhook、Telegram 和 Discord 渠道发送出站通知，供浏览本组的用户和维护者使用。"
kind: "package-group"
---

# packages/webhook

[English](README.md) | 中文

## 概述

webhook 包组承载 Hydra 的出站通知。当目标阻塞或完成、目标轮次驱动在多次瞬时失败后放弃，或智能体轮次出错时，`dsh-notify` 向每个已配置的渠道发送一条简短消息。它在 `dsh-base` 中以禁用状态挂载；部署方启用它并指定渠道。入站提供方事件和程序化规则属于实验性 webhook 包，由 [Webhook 子系统参考](../../docs/subsystems/webhook.zh.md) 描述。

## 目录

- [包](#packages)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`notify/`](notify/README.md) | 向 webhook、Telegram 和 Discord 渠道发送目标、重试和智能体错误的出站通知 | `ctx.notify` |

<a id="dev-note"></a>
## 开发备注

无。
