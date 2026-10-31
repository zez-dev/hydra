---
kind: upgrade-guide
description: "工具结果剪枝器的预算必须为 133 个码点的标记留出空间，且 pruneSession 需要传入范围。"
---
# 工具结果剪枝器预算需为更长的标记留出空间

[English](guide.md) | 中文

## 变更

`dsh-compaction-tool-result-pruner` 的标记现在会注明删去了多少字符；对于模型尚未读过的结果，还会提示模型以更窄的范围重新调用。只有当 `headChars` 加最长标记（133 个码点）加 `tailChars` 不超过 `thresholdChars` 时，插件才接受该配置；旧标记占 39 个码点。默认值（`8192`、`4096`、`1024`）及所有随附 profile 不受影响。

`ToolResultPruner.pruneSession(session)` 现在必须传入范围：`'read'` 只删减模型已读过的结果，`'all'` 删减每个超出预算的结果。`pruneContent(blocks)` 接受一个用于选择标记的 `read` 标志。导出的 `PRUNE_MARKER` 由 `pruneMarker(removedChars, read)` 取代。

## 迁移

1. 在 `@deepseek-ai/dsh-compaction-tool-result-pruner` 的 `cordis.yml` 条目中，使 `thresholdChars` 至少为 `headChars + tailChars + 133`，或调低 `headChars` 或 `tailChars`。预算满足之前，插件会在加载时报错 `headChars + marker + tailChars (…) must be at most thresholdChars (…)`。
2. 调用剪枝器的代码传入 `'all'` 以保持原有行为，或传入 `'read'` 以保留模型尚未读过的完整结果：`pruner.pruneSession(session, 'all')`。
3. 用 `pruneMarker(removedChars, read)` 替换 `PRUNE_MARKER`；匹配旧文本 `tool result middle pruned` 的代码改为匹配 `characters cut from the middle`。
4. 启动应用以确认迁移成功：剪枝器条目加载时不再报配置错误。
