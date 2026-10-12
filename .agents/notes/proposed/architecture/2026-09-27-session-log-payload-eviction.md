# Agent Note: Evict shadowed Session event payloads from memory

Status: proposed

English only on this fork; the Chinese twin follows the fork's translation decision.

## Problem

`Session` keeps every accepted event in one in-memory array (`packages/core/session/src/index.ts`, `private log`). Compaction replaces surface ranges, and the model-visible surface deliberately shadows the replaced nodes, but the log keeps their payloads: the human transcript, session export, titles, telemetry, and 87 production call sites of the deprecated synchronous readers still read them from that array. On the long-session harness (`packages/compaction/compaction-basic/tests/long-session-harness.ts`, tool-result pruner composed, reads of 48K characters) the host heap reached 225 MB at 31K events, about 7 KB per event. The shipped composition inlines tool results up to 50,000 bytes (`maxInlineBytes` in `packages/bundle/base/cordis.patch.yml`), so a read of that size stays inline in the product as well; the harness figure is a product figure for a session that reads large files. A session that runs for days grows without bound, and the [deprecation decision](../../implemented/architecture/2026-09-09-deprecate-synchronous-session-event-reads.md) fixed the direction (stop retaining the complete sequence in memory) while deferring every existing caller.

## Proposal

### The missing seam: a persistence range read

There is nothing to evict to yet. `SessionPersistence` (`packages/session/session-persistence`) creates, opens, stats, lists, and deletes sessions, and restores a whole log; it has no read of an event range. The seam has three roles:

- **Service Definition** in `dsh-session-persistence`: `readEvents(id, fromSeq, toSeqExclusive, signal): Promise<readonly SessionEvent[]>`, bounded by the requested window, failing loud on a seq the store does not hold.
- **Service Provider** in `dsh-session-persistence-jsonl`: a per-generation row index (byte offset per seq, built while writing and rebuilt on open by the same row parser `MigratingJsonlRows` uses) so a range read decodes only its rows. Zstandard-framed generations index frame starts and decode one frame per read.
- **First Consumer**: `dsh-api-session-controller` history pages (`history.ts`), which already page by seq window and which the deprecation note names as the intended on-demand transcript path.

### Eviction rule

Only a payload nobody derives model input from leaves memory: a surface node shadowed by a landed replacement whose checkpoint is older than the newest `retainCheckpoints` (a validated `Config` field of `dsh-session`, off by default until every reader below is migrated). The event stays in the log as a stub (`seq`, `type`, `surfaceOp`, byte size, `evicted: true`); `eventAt` and `snapshotEvents` throw a typed `SessionEventEvictedError` naming the seq, so an unmigrated synchronous reader fails loud instead of reading a stub as content. The surface, the request-header fold, the request-context fold, and the derived-message cache never read shadowed payloads, so the model request is unchanged by construction; the invariant package asserts that a request built before and after eviction is identical.

### Reader inventory (exact production call sites of `eventAt`, `snapshotEvents`, `ownEvents`, 2026-09-27)

87 sites in 41 packages: schedule 6, core/session 6, session-title 4, session-log-deepseek 4, agent-loop 4, compaction-basic 4, session-controller 4, session-projection 3, session-query 3, llm-retry 3, user-approval 3, agent-team 3, time-context 3, agent-instructions 3, tool-skill 2, commands 2, goal-round-driver 2, message-feedback 2, compaction 2, bundle/headless 2, and one each in tool-workflow, tool-todo, tool-subagent, subagent-in-process-driver, subagent-fork-in-process, subagent, session-telemetry-otel, session-telemetry, session-query-sqlite, sandbox-policy, plan-mode, token-meter, memory, permission-presets, hook-protocol, tool-goal, research, goal, auto-review, core/tools, compaction-tool-result-pruner, compaction-image-offload.

Most of these read the tail (the current turn, the latest header) and are unaffected by evicting old shadowed payloads; each must be classified as tail-only, projection-replaceable, or genuine full-history (fork, export) before eviction is enabled, and the classification recorded per package.

### Order of work

1. The seam and the jsonl index, with a range-read benchmark on a 31K-event log.
2. History pages through the seam; the web history lane and the paged-history browser tests are the acceptance.
3. Session-query export and the title and telemetry readers.
4. The remaining readers, package by package, each removing its `no-deprecated` waiver.
5. Eviction behind `retainCheckpoints`, with the long-session harness reporting heap per 1,000 events (`DSH_STRESS_REPORT`) before and after as the number this note is judged by.

## Alternatives considered

**Lower the shipped inline threshold so large results spill to files.** Bounds per-event size cheaply, but changes what the model sees (a locator and a head-and-tail excerpt instead of the content) for every result between the new and the old threshold; that is a model-visible decision with its own snapshots, not a memory fix, and it leaves the unbounded growth in place.

**Keep the complete sequence resident.** The current state; every consumer stays simple and the ceiling stays where the harness measured it.

**Evict without a range read, re-restoring the whole log on demand.** Turns one transcript page into a full restore; the deprecation note names this as the dependency to remove.

## Acceptance criteria

- A range read of 1,000 events from a 31K-event jsonl log decodes only its rows and returns in under 50 ms on the benchmark host, with a test that reads a window straddling a Zstandard frame boundary.
- With `retainCheckpoints` set, the long-session harness reports host heap per 1,000 events flat after the first checkpoint lands, and the model request assembled before and after eviction is byte-identical (an invariant check).
- An unmigrated synchronous read of an evicted seq throws `SessionEventEvictedError` naming the seq; no reader receives a stub as content.
- The web history lane, the paged-history browser tests, session export, titles, and telemetry pass unchanged with eviction on.
- Every `no-deprecated` waiver on the three readers is either removed or classified in its package README under Known Limitations.

## Risks

- A reader classified as tail-only that reads an old seq on a rare path (a resumed goal, a late tool result) fails loud in production; the classification must be tested per package, not inferred.
- The jsonl index adds a write per event; a crash between the row and its index entry needs the rebuild-on-open path, which is the same parser restore already runs.
- Eviction interacts with fork: a child inherits a prefix whose payloads may be evicted in the parent; fork must read through the seam, and its cost becomes a storage read.
- The migration spans 41 packages of a pre-stable API; partial delivery leaves the ceiling where it is, so steps 1 to 4 must land before step 5 has any effect.

## Consequences

Until step 5 lands nothing changes for users; steps 1 to 4 are each independently shippable and reduce the migration debt the deprecation note left. The change touches a pre-stable public API across many packages and is a scope decision for the fork's owner, not a follow-up of the window work.
