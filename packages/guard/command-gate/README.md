---
description: "The command gate: an argv classifier on tools/pre-execute that refuses shell commands destroying what no checkpoint can restore."
kind: "package-reference"
---

# @deepseek-ai/dsh-command-gate

## Summary

`dsh-command-gate` reads the shell command a tool is about to run and stops the destructive ones. Hydra runs unattended for days, and only a commit can restore what a command destroys, so a `git reset --hard`, a force push, an `rm -rf`, or a write outside the workspace leaves nothing to restore to undo. The gate classifies the parsed argv, asks a human before anything that destroys uncommitted work, and refuses outright anything that reaches past the workspace or reprograms the machine. With nobody to ask, an unattended round denies rather than waiting.

## Table of Contents

- [Use this package](#use-this-package)
- [The rules](#the-rules)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The `dsh-base` bundle mounts the gate in `confirm` mode. Every tool call an agent makes whose arguments carry a `command` string is classified, which covers `bash` and `pwsh`; a tool without that argument passes through untouched. `/commands-gate` prints the active policy and what this session has blocked.

| Field | Default | Meaning |
|---|---|---|
| `mode` | `confirm` (`confirm` in `dsh-base`) | `off` disables the gate; `confirm` asks about commands that destroy uncommitted work and denies the rest; `deny` refuses both without asking |
| `unattendedMode` | `deny` (`deny` in `dsh-base`) | What a `confirm` verdict becomes when no human can answer. `deny` refuses with the gate's explanation; `confirm` still raises the approval, which a machine answerer may grant |
| `allow` | `[]` | Rule ids downgraded to `allow`, for a deployment that accepts one risk |
| `denyExtra` | `[]` | Extra command prefixes to deny, each written as it would be typed, such as `terraform destroy` |
| `temporaryRoots` | `[]` | Absolute paths where destroying files is expected, such as a scratch root |

A round counts as unattended when no approval service is composed or the session's approval policy already rejects every ask.

-----

<a id="the-rules"></a>
## The rules

Severity follows what can be recovered afterwards. `confirm` covers commands a person may well want that destroy work no commit holds; `deny` covers commands that reach outside the workspace or change the machine, which no agent round needs and which a sandbox set to `danger-full-access` would not stop.

| Rule id | Verdict | Matches |
|---|---|---|
| `rm-destructive` | confirm inside the workspace, deny outside | `rm` with `-r`, `-R`, or `-f` |
| `git-reset-hard` | confirm | `git reset --hard` |
| `git-discard-worktree` | confirm | `git checkout` or `git restore` on a path; `-b`, a bare branch switch, and `--staged` pass |
| `git-clean` | confirm | `git clean` with `-f`, `-d`, or `-x`; `-n` passes |
| `git-force-push` | confirm | `git push` with `--force`, `-f`, `--force-with-lease`, or a `+refspec` |
| `git-history-rewrite` | confirm | `git rebase` (not `--abort`, `--continue`, `--skip`, `--quit`), `git filter-branch`, `git reflog expire` |
| `chmod-recursive`, `chown-recursive` | confirm | `-R` or `--recursive` |
| `inplace-edit-many` | confirm | `sed -i` or `perl -i` across a glob or several files; one named file passes |
| `write-outside-workspace` | deny | `mv`, `cp`, `rsync`, `tee`, `truncate`, `install`, `ln`, or a truncating redirect (`>`, `>\|`, `&>`, `>&`) whose destination leaves the workspace |
| `remote-script-execution` | deny | `curl` or `wget` piped into a shell or interpreter |
| `global-package-install` | deny | a package manager's global or system install |
| `disk-write` | deny | `dd`, `mkfs*` |
| `machine-power` | deny | `shutdown`, `reboot`, `halt`, `poweroff` |
| `deny-extra` | deny | a prefix from `denyExtra` |

A line is judged by the worst verdict among the commands it would run, so a chain, a pipeline, a subshell, a `$( )` or backtick substitution, bare or inside double quotes, a `sh -c` payload, and the command a wrapper program runs are all classified. The wrappers looked through are `sudo`, `doas`, `env` (including an `env -S` command line), `nice`, `nohup`, `timeout`, `time`, `stdbuf`, `xargs`, `command`, and `exec`: their own options, option values, positional words such as `timeout`'s duration, and leading `NAME=value` words are skipped, and a pipe into a wrapped shell such as `curl … | sudo bash` counts as a pipe into that shell.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

| File | Role |
|---|---|
| [`src/parse.ts`](src/parse.ts) | Quote-aware tokenizer flattening a line into simple commands with their redirections and pipe targets |
| [`src/classify.ts`](src/classify.ts) | The ordered rule table, path placement against the workspace and temporary roots, and the worst-verdict fold |
| [`src/index.ts`](src/index.ts) | The `tools/pre-execute` listener, the unattended check, the `/commands-gate` command, and the block record |
| [`src/types.ts`](src/types.ts) | Parsed shapes, verdicts, and the `command-gate/blocked` event declaration |

The decision is returned from the `tools/pre-execute` waterfall, which the registry consults inside the operation that dispatches the call, so a caller that never went through the model still meets it. A `confirm` verdict becomes `{ kind: 'ask' }` and the approval stack writes its own asked and decided pair; the gate logs `command-gate/blocked` only for refusals it makes itself.

No invariant companion is published because each verdict is computed from the command text inside `tools/pre-execute`, and the `dsh-user-approval` companion already checks the asked and decided pair a `confirm` verdict produces.

-----

<a id="model-experience"></a>
## Model Experience

### A refused command

#### What the model sees

The tool result carries `Error:` followed by the rule's sentence, which names what was blocked and the way forward: commit or stash before discarding changes, keep a destination inside the workspace, read a downloaded script before running it. No configuration or plugin vocabulary appears.

#### Token effect

Conditional: one sentence in place of the command's output, only when a rule matches.

#### KV Cache effect

Append-only: the refusal is an ordinary tool result and no prompt section changes.

## Known Limitations and Deferred Work

- **The parser does not expand variables or globs** — a path that arrives as `$TARGET` reaches a rule unexpanded, so a destructive command assembled entirely from variables is not recognised. The sandbox remains the boundary that does not depend on reading the command.
- **A `>` redirect inside the workspace is allowed** — creating and overwriting files is ordinary work, and a truncation of a tracked file cannot be told from writing a new one without reading the disk, so flagging every redirect would stop far more real work than it saves.
- **Rules match programs by name** — a destructive command run through a wrapper program outside the list above (such as `chrt`, `ionice`, or `taskset`), an alias, a wrapper script, or an interpreter that is not in the known list, is not classified. `xargs` is classified with the words written after it; the arguments it reads from its input are not known. Leading `NAME=value` assignments are skipped, so they do not hide the program.
- **Only tools with a `command` argument are read** — a terminal tool that sends keystrokes to a live shell bypasses the gate.
- **A call without a session workspace is not classified** — a tool call that names no agent, or whose session records no working directory, has nothing to judge paths against, so the gate passes it to the tool. The agent loop always names the agent; a direct `ctx.tools.execute()` caller that omits it is not gated.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
