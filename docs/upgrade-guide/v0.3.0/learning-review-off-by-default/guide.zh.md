---
kind: upgrade-guide
description: "基础组合包现在把 learning 插件的 `reviewTurns` 设为 `false`，因此会话在轮次结束后不再写入记忆条目、错误模式捷径和研究日志发现，除非 profile 补丁重新开启该回顾。"
---
# 基础组合包关闭轮次结束后的学习回顾

[English](guide.md) | 中文

## 变更

基础组合包（`@deepseek-ai/dsh-base`）的 `learning` 条目现在设置 `reviewTurns: false`，此前为 `true`。

此前，每个至少有 `minToolCalls` 次工具调用（组合包中为 3）的已结束轮次（subagent 的轮次除外）之后，都会在会话自己的模型路由上追加一次针对该轮次 transcript（文本记录）的模型请求。回顾写入的内容取决于会话：

| 会话 | 回顾写入的内容 |
|---|---|
| 有进行中的 `/research` 目标 | 研究日志中的发现，来源为 `auto` |
| 其他会话 | 作为记忆条目的事实、捷径和偏好；某次工具调用失败后重试同一工具成功时，还会再发一次请求，为它写入一条捷径 |

现在回顾不再运行：不发送请求，也不写入上述任何内容。`/learn from`、`/digest` 和 `/research-ingest` 仍可按需学习，模型的 `journal` 工具仍会在研究结果产生时记录它们。已有的记忆条目、skill（技能）和日志不受影响。

关闭回顾是因为它的提示词在每次请求中都是新的。前缀缓存容量有限的本地服务器可能为了容纳该提示词而淘汰对话已缓存的前缀，下一轮次就要重新读取整个对话。

所有组合了基础组合包的 profile 都受影响；随产品提供的 profile 中，只有 `sdk-minimal` 不组合它。如果 profile 自己的补丁层已经替换了 `learning` 条目，那么当该条目设置 `reviewTurns: true` 或未写这个键时，回顾仍然开启：插件自身的默认值仍是 `true`。

## 迁移

1. 如需保留轮次结束后的回顾，把以下条目加入 `$DSH_HOME/profiles/<profile>/cordis.patch.yml`（`$DSH_HOME` 默认为 `~/.dsh`）的顶层列表，替换未编辑文件中的 `[]`。如需覆盖本机的所有 profile，改为写入 `$DSH_HOME/cordis.patch.yml`，该文件不存在时创建它：

   ```yaml
   - id: learning
     config:
       reviewTurns: true
       fileAs: approved
       minToolCalls: 3
       maxCandidatesPerTurn: 5
       maxTranscriptBytes: 24000
       maxOutputTokens: 512
       timeoutMs: 60000
       errorPatterns:
         enabled: true
         maxPairsPerTurn: 5
   ```

2. 保留条目中的每一项设置。补丁条目会替换目标的整个配置，因此只写 `reviewTurns` 的条目会让必填设置缺失：从 CLI 启动时会打印 `hydra: warning: 1 entry did not activate`，会话在没有 learning 插件的情况下运行。
3. 确认迁移成功：`hydra --profile <profile> --dump-config` 打印的 `learning` 条目包含 `reviewTurns: true`，其上方的注释行在 `patched by` 之后写明补丁文件的路径。
