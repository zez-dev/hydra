---
kind: upgrade-guide
description: "The base bundle now sets the learning plugin's `reviewTurns` to `false`, so a session stops filing memory entries, error-pattern shortcuts, and research journal findings after a turn unless a profile patch turns the review back on."
---
# The base bundle leaves the after-turn learning review off

English | [中文](guide.zh.md)

## Change

The `learning` row of the base bundle (`@deepseek-ai/dsh-base`) now sets `reviewTurns: false`. It set `true` before.

Before, each finished turn with at least `minToolCalls` tool calls (3 in the bundle), except a subagent's, was followed by an extra model request over that turn's transcript, on the session's own model route. What the review filed depended on the session:

| Session | Filed by the review |
|---|---|
| With an active `/research` goal | Findings in the research journal, with source `auto` |
| Any other session | Facts, shortcuts, and preferences as memory entries; after a failed tool call that a retry of the same tool fixed, a second request filed a shortcut for it |

Now the review does not run: no request is sent and none of the above is filed. `/learn from`, `/digest`, and `/research-ingest` still learn on request, and the model's `journal` tool still records research results as they happen. Memory entries, skills, and journals that already exist are not touched.

The review is off because its prompt is new on every request. A local server with a bounded prefix cache can evict the conversation's cached prefix to hold that prompt, and the next turn then reads the whole conversation again.

Every profile that composes the base bundle is affected; of the shipped profiles, only `sdk-minimal` does not compose it. A profile whose own patch layer already replaces the `learning` row keeps the review when that row sets `reviewTurns: true` or does not name the key: the plugin's own default stays `true`.

## Migration

1. To keep the after-turn review, add this row to the top-level list in `$DSH_HOME/profiles/<profile>/cordis.patch.yml` (`$DSH_HOME` is `~/.dsh` by default), replacing the `[]` of an unedited file. To cover every profile on the machine, put it in `$DSH_HOME/cordis.patch.yml` instead, creating that file if it does not exist:

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

2. Keep every setting in the row. A patch row replaces the whole config of its target, so a row that names only `reviewTurns` leaves the required settings unset: a CLI launch prints `hydra: warning: 1 entry did not activate`, and the session runs without the learning plugin.
3. Confirm the migration: `hydra --profile <profile> --dump-config` prints the `learning` row with `reviewTurns: true`, below a comment line that names the patch file after `patched by`.
