---
description: "The evidence guard: an evidence standard in every system prompt and an end-of-turn review of partial reads, unchecked changes, and unverified claims, for users and maintainers tuning answer accuracy."
kind: "package-reference"
---

# @deepseek-ai/dsh-evidence-guard

## Summary

`dsh-evidence-guard` holds two plugins that make an answer rest on what the model read and ran. `evidence-guard` adds a system-prompt section asking the model to read files in full, cite what it read or ran, write findings in replies or a notes file, say what it has not verified, and re-check its claims. `evidence-review` steers one review request into a completed turn that left a file mostly unread, changed files without a later check command, or made many tool calls, so the model checks its work and answers again. Subagent sessions and turns a tool concluded are not reviewed.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The shipped `dsh-base` bundle mounts both rows disabled. Enable them in a profile patch:

```yaml
- id: evidence-guard
  disabled: false
- id: evidence-review
  disabled: false
```

`evidence-guard` takes no configuration. `evidence-review` accepts:

| Field | Default | Meaning |
|---|---|---|
| `minUnreadLines` | `20` | A partly read file is a finding only when at least this many of its lines went unread |
| `reviewAfterToolCalls` | `6` | A turn with at least this many tool calls, PTC sub-calls included, is reviewed even without other findings |
| `checkCommandPatterns` | test, build, lint, and type-check command words | Case-insensitive JavaScript regular expressions a `bash` or `pwsh` command must match to count as a check after a change; an invalid expression fails at load |
| `maxReviewsPerTurn` | `1` | Reviews steered within one turn; `0` turns the review off |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

`evidence-review` observes `session/event`. `turn/start` starts an empty evidence record for the session, and each `tool/call` counts one call and keeps its parsed arguments. A successful `tool/result` folds its call: a `read` result adds its line window from the result meta, an `edit` or `write` result marks its path changed, and a `bash` or `pwsh` command that matches a check pattern records a check. A `write` meta carries `operation`, which marks the whole file as written by the model, so that file is never reported as partly read. `tool/ptc-dispatch` sub-calls count and fold the same way. A `tools/result` that concludes the turn marks the turn as ending on purpose.

On the serial `agent/turn-stopping` event, the listener skips an aborted stop, a subagent or delegated session, a concluded turn, a turn at its review cap, and a stop another listener already continued. Otherwise it computes the findings and steers the review text through `agent.steer()`, which runs one more step in the same turn.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `evidence-guard`: the system-prompt section |
| [`src/review.ts`](src/review.ts) | `evidence-review`: event folding, the turn-stopping listener, config |
| [`src/findings.ts`](src/findings.ts) | Pure evidence record, thresholds, review text, and meta validation |

-----

<a id="model-experience"></a>
## Model Experience

### Evidence standard

#### What the model sees

One system-prompt section named `evidence-standard`, ordered after the deployment persona prefix and before the plan policy:

##### Verbatim section text

```markdown
Read a file in full before you describe or change it, or say which lines you read. Base each claim about files, code, or results on what you read or ran in this session, and cite the file and line or the command output. On long tasks, write each finding in your reply or in a notes file as soon as you find it, not only in your reasoning, because older tool output may be cut later to save context; findings you wrote down from your own reads and commands count as that evidence, so rely on them and re-read only what you need to check again. If you have not verified something, say so instead of guessing. Before your final answer, re-check your claims against that evidence and correct anything wrong.
```

#### Token effect

Constant: about 130 tokens in every request's system prompt.

#### KV Cache effect

Stable: the text never changes, so it stays inside the cached system-prompt prefix.

### Review request

#### What the model sees

One user message after the final assistant message of a turn with findings, logged as `user/message` with source `{ kind: 'plugin:dsh-evidence-guard', form: 'notice', summary: 'Evidence check before the final answer' }`. The second line appears only with partly read files and the third only with unchecked changes; each names at most five files, then `, and <n> more`.

##### Verbatim review template

```markdown
Before you finish, check your work:
- You read only part of these files: <path> (lines <first>-<last> and <line> of <count>). Read the parts your answer depends on, or say which lines it covers.
- You changed <path> and ran no test, build, or lint command after the last change. Run the relevant check and fix any failure, or say why none applies.
- Check every claim in your answer against what you read or ran, and correct anything wrong or unverified.
Then give your complete final answer again.
```

#### Token effect

Conditional: one short message per reviewed turn, at most `maxReviewsPerTurn`, plus the full model request it triggers over the whole context.

#### KV Cache effect

Append-only: the review appends after the final assistant message, so the cached prefix stays reusable.

## Known Limitations and Deferred Work

- **Coverage, not attention** — the review knows which lines each read returned, not which ones the answer used; a file read in full can still be misread.
- **Checks match command words** — a test command under another name is not counted as a check, and a command that only prints the word `test` is.
- **Evidence comes from tools named `read`, `edit`, `write`, `bash`, and `pwsh`** — other tools add only to the call count.
- **Notes are trusted, not verified** — the standard counts the model's own notes as evidence, so a wrong note stays wrong until the model re-reads its source.
- **One review per turn by default** — mistakes made after the review are not reviewed again unless `maxReviewsPerTurn` allows it, and each review costs a full request over the whole context.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
