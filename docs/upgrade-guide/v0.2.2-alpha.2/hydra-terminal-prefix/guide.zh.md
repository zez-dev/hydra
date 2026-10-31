---
kind: upgrade-guide
description: "终端诊断和建议的命令以 hydra 代替 dsh 作为程序名，包括携带 Web 地址的 hydra web: 行。"
---
# 终端输出以 `hydra` 代替 `dsh`

[English](guide.md) | 中文

## 变更

启动器、Web 与 headless 应用、插件管理以及桌面壳在原本打印 `dsh` 作为程序名的地方改为打印 `hydra`：

| 输出 | 此前 | 现在 |
|---|---|---|
| stdout 上的 Web 地址与浏览器提示 | `dsh web: http://127.0.0.1:3080/?token=…` | `hydra web: http://127.0.0.1:3080/?token=…` |
| stderr 上的警告、错误与启动失败 | `dsh: warning: 1 entry did not activate` | `hydra: warning: 1 entry did not activate` |
| stderr 上的 headless 推理与轮次结束 | `dsh: reasoning:`、`dsh: aborted: <cause>` | `hydra: reasoning:`、`hydra: aborted: <cause>` |
| 建议的命令 | `run 'dsh plugin --profile web install'` | `run 'hydra plugin --profile web install'` |
| 桌面壳与 Host 故障 | `dsh desktop: …`、`dsh desktop host …` | `hydra desktop: …`、`hydra desktop host …` |

Web 应用的“会话已被占用”提示改为指出正在运行的 Hydra 实例和 `hydra web`。`dsh` 命令仍运行同一入口，因此每条建议的 `hydra` 命令也可以写成 `dsh`。运行时版本标识保留原名：`engines.dsh`、`--dsh-version`，以及 `incompatible with dsh 0.2.2-alpha.2` 这类消息。

## 迁移

1. 从 stdout 读取 Web 地址的脚本改为匹配 `hydra web: `，而不是 `dsh web: `；也可以直接匹配不变的地址本身（`http://127.0.0.1:<port>/?token=…`）。
2. 匹配诊断信息的脚本或日志过滤器把前缀 `dsh: ` 换成 `hydra: `；前缀之后的文字不变。
3. 确认迁移完成：在已配置模型时运行 `hydra --profile headless "say hello"`，或运行 `hydra web --no-open`，检查脚本能找到它读取的行。
