---
description: "面向在协议边界接收调用方所报时区、或按天归集时刻的维护者，说明 IANA 时区校验与规范化以及本地日历日键。"
kind: "package-library"
---

# dsh-util-time

[English](README.md) | 中文

## 概述

零依赖的时间词汇，做两件事。`canonicalClientTimeZone` 只接受 `UTC` 或 IANA `Area/Location` 名称，并回答该名称在当前平台上的规范拼写，因此别名不会进入持久记录：时区标识会存储在消息中，并由另一个进程稍后重新推导；别名在该进程中无法与规范名称比较为相等。`localDateKey` 把一个时刻落到它所在的本地日历日，形式为 `YYYY-MM-DD`——按天归集或按天设界的消费方都比较并排序这一个键。本库不持有失败词汇，因为每个边界抛自己的域码。

## 目录

- [使用本包](#use-this-package)
- [API](#api)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

它是**库，不是服务也不是插件**：无 `ctx`、不注册任何东西、不持有状态。

不发布运行时不变量伴生入口；这个纯工具不拥有事件流或可变运行时数据，时区规范化与落日由单元测试验证。

在接收时区的那个边界上调用它，让值在进入任何持久物之前先过一遍。不可用的名称回答 `undefined`，由调用方抛出自己的拒绝——Session 提示词用 `session/invalid-time-zone`，subagent 续话用 `subagent/invalid-time-zone`。

-----

<a id="api"></a>
## API

```ts
import { canonicalClientTimeZone, localDateKey } from '@deepseek-ai/dsh-util-time'
```

| 导出 | 职责 |
|---|---|
| `canonicalClientTimeZone(value)` | 对接受的时区回答规范的 `UTC` 或 IANA `Area/Location` 名称；空串、带空白、缩写、单段或平台不支持的名称回答 `undefined`。 |
| `localDateKey(date)` | 该时刻所在的本地日历日，形式为补零的 `YYYY-MM-DD`，因此可按字典序比较与排序。 |

<a id="model-experience"></a>
## 模型体验

间接影响，取决于把规范时区记到持久消息上的那个消费方——`dsh-time-context` 据此渲染该轮模型可见的时区指令与时间戳。

#### KV Cache 影响

自身没有。把时区派生文本注入请求的那个消费方，对该请求的缓存行为负责。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **别名解析取决于运行时的 ICU 数据**——一个别名组规范化成哪个名称由平台回答，因此两个跑在不同 Node 构建上的进程可能给出不同答案。
- **不做偏移运算**——除日键外不做格式化，不推导 DST，也不做时刻换算；需要这些的消费方直接用 `Intl`。
- **`localDateKey` 读进程本地时区**——它用进程自己的本地时间，而不是调用方给的时区，因此需要按其他时区归集的消费方要先自行换算。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
