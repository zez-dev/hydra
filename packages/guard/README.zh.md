---
description: "循环卫生 guard 家族的包映射：建议性重复工具提醒与单次工具调用超时策略，供选择或组合 guard 的用户与维护者阅读。"
kind: "package-group"
---

# guard/：循环卫生 guard 家族

[English](README.md) | 中文

## 概述

`guard/` 组通过监视两种常见失败模式来保持 agent loop（智能体循环）高效。`repeat-tool-reminder` 会在模型重复完全相同的工具调用时提醒它改变方法或结束任务，让卡住的循环不再浪费时间和 token。`timeout-policy` 为声明了限时的工具调用设置时间上限，让挂起的调用向模型返回清晰的超时错误，而不是拖住整个会话。两者都在 `dsh` 基础组合包中默认启用；组合可以调优或移除它们。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

下文每个 README 都说明何时保留、调优或移除其插件。

| 包 | 提供什么 |
|---|---|
| [`repeat-tool-reminder/`](repeat-tool-reminder/README.zh.md) | 在模型重复完全相同的工具调用时提醒它，使其改变方法或结束任务 |
| [`auto-continue/`](auto-continue/README.md) | 在某一步因输出 token 上限而停止时引导模型继续，使被截断的回答无需人工输入 continue 即可完成 |
| [`spend-guard/`](spend-guard/README.md) | 在超过会话或每日 token 预算时暂停目标或停止本轮，并提供 `/spend` 统计 |
| [`timeout-policy/`](timeout-policy/README.zh.md) | 为声明了限时的工具调用设置超时，让模型得到清晰错误而不是无限等待 |
| [`command-gate/`](command-gate/README.md) | 对 shell argv 分类，拒绝会破坏任何检查点都无法恢复之内容的命令，并提供 `/commands-gate` 历史 |
| [`evidence-guard/`](evidence-guard/README.md) | 在每个系统提示词中加入证据标准，并在本轮结束前复核部分读取、未检查的修改与各项结论；默认禁用 |

-----

<a id="related-documentation"></a>
## 相关文档

先从工具子系统参考了解工具调用流水线，再看重复提醒的配置与策略背后的超时库决策。

- [工具子系统参考](../../docs/subsystems/tools.zh.md)——两个 guard 都依赖的工具调用流水线与决策。
- [生成配置目录](../../docs/config-catalog.zh.md#deepseek-aidsh-repeat-tool-reminder)——重复调用提醒的每个受支持字段。
- [生成配置目录](../../docs/config-catalog.zh.md#deepseek-aidsh-auto-continue)——auto-continue guard 的每个受支持字段。
- [超时截止时间库 Agent Note](../../.agents/notes/implemented/architecture/2026-07-06-timeout-deadline-library.zh.md)——`timeout-policy` 所执行的时序／终止拆分。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
