---
kind: upgrade-guide
description: "Tool-result pruner budgets must leave room for a 133-code-point marker, and pruneSession takes a scope."
---
# Tool-result pruner budgets leave room for a longer marker

English | [中文](guide.zh.md)

## Change

The `dsh-compaction-tool-result-pruner` marker now names how many characters were cut and, for a result the model has not read, tells the model to repeat the call with a narrower range. The plugin rejects a configuration unless `headChars` plus the longest marker (133 code points) plus `tailChars` is at most `thresholdChars`; the previous marker took 39. The defaults (`8192`, `4096`, `1024`) and every shipped profile are unaffected.

`ToolResultPruner.pruneSession(session)` now requires a scope: `'read'` cuts only results the model has read, and `'all'` cuts every over-budget result. `pruneContent(blocks)` takes a `read` flag that selects the marker. The `PRUNE_MARKER` export is replaced by `pruneMarker(removedChars, read)`.

## Migration

1. In a `cordis.yml` row for `@deepseek-ai/dsh-compaction-tool-result-pruner`, make `thresholdChars` at least `headChars + tailChars + 133`, or lower `headChars` or `tailChars`. Until the budgets fit, the plugin fails at load with `headChars + marker + tailChars (…) must be at most thresholdChars (…)`.
2. Code that calls the pruner passes `'all'` to keep the previous behavior, or `'read'` to leave results the model has not read whole: `pruner.pruneSession(session, 'all')`.
3. Replace `PRUNE_MARKER` with `pruneMarker(removedChars, read)`; code that matched the old `tool result middle pruned` text matches `characters cut from the middle` instead.
4. Start the application to confirm the migration: the pruner row loads without a configuration error.
