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
| `temporaryRoots` | `[]` | Absolute paths where destroying files is expected, such as a scratch root; `/tmp` and the operating system's temporary directory always count as well |

A round counts as unattended when no approval service is composed or the session's approval policy already rejects every ask.

The sandbox's `workspace-write` mode lets every command write `/tmp` and the operating system's temporary directory (`os.tmpdir()`), so the gate treats both as temporary roots beside the configured ones; `/commands-gate` lists only the configured ones. Paths are compared as text, so the workspace and every temporary root also count under the path the filesystem resolves them to, such as `/private/tmp` for `/tmp` on macOS. A temporary root that encloses the workspace, as `/tmp` does for a workspace created under it, leaves the workspace protected; one at or inside the workspace marks scratch space there.

-----

<a id="the-rules"></a>
## The rules

Severity follows what can be recovered afterwards. `confirm` covers commands a person may well want that destroy work no commit holds; `deny` covers commands that reach outside the workspace or change the machine, which no agent round needs and which a sandbox set to `danger-full-access` would not stop.

| Rule id | Verdict | Matches |
|---|---|---|
| `rm-destructive` | confirm inside the workspace, deny outside | `rm` with `-r`, `-R`, or `-f`; any `rm` that `xargs` runs, whose paths come from its input; `find` with `-delete`, or with `-exec`, `-execdir`, `-ok`, or `-okdir` running `rm`, placed by its starting paths |
| `git-reset-hard` | confirm | `git reset --hard` |
| `git-discard-worktree` | confirm | `git checkout` with `-f` or `--force`, or given a path: an operand naming an existing file or directory, one no branch name can spell (`.`, a glob, a leading `/`, `.`, or `:`, a trailing `/`), anything after `--`, or `--pathspec-from-file`; `git switch` with `-f`, `--force`, or `--discard-changes`; `git restore` unless it is `--staged` without `--worktree`. `-b`, `-B`, `--orphan`, and a branch switch pass |
| `git-stash-drop` | confirm | `git stash drop`, `git stash clear` |
| `git-clean` | confirm | `git clean` with `-f`, `-d`, or `-x`; `-n` passes |
| `git-force-push` | confirm | `git push` with `--force`, `-f`, `--force-with-lease`, or a `+refspec` |
| `git-history-rewrite` | confirm | `git rebase` (not `--abort`, `--continue`, `--skip`, `--quit`), `git filter-branch`, `git reflog expire` |
| `chmod-recursive`, `chown-recursive` | confirm | `-R` or `--recursive` |
| `inplace-edit-many` | confirm | `sed -i` or `perl -i` across a glob or several files; one named file passes |
| `write-outside-workspace` | deny | `mv`, `cp`, `rsync`, `tee`, `truncate`, `install`, `ln`, `touch`, `mkdir`, or a truncating or appending redirect (`>`, `>>`, `>\|`, `&>`, `&>>`, `>&`) whose destination leaves the workspace |
| `remote-script-execution` | deny | `curl` or `wget` piped into a shell or interpreter |
| `global-package-install` | deny | a package manager's global or system install |
| `disk-write` | deny | `dd`, `mkfs*` |
| `machine-power` | deny | `shutdown`, `reboot`, `halt`, `poweroff` |
| `deny-extra` | deny | a prefix from `denyExtra` |

A line is judged by the worst verdict among the commands it would run, and each command by the worst verdict any rule gives it, so `rm -rf build >> /outside/log` is refused for its redirect. A chain, a pipeline, a subshell, a compound command such as `if`, `for`, `while`, or `{ }`, a `$( )` or backtick substitution, bare or inside double quotes, a `sh -c` or `eval` payload, and the command a wrapper program runs are all classified; as in the shell, a backslash-escaped operator stays part of a word and a backslash before a newline joins the two lines. The wrappers looked through are `sudo`, `doas`, `env` (including an `env -S` command line), `nice`, `nohup`, `timeout`, `time`, `stdbuf`, `xargs`, `command`, and `exec`: their own options, option values, positional words such as `timeout`'s duration, and leading `NAME=value` words are skipped, and a pipe into a wrapped shell such as `curl … | sudo bash` counts as a pipe into that shell.

A literal `cd` moves the commands after it on the same line. After `cd dir &&` they are judged in `dir`; after `cd dir;` or `cd dir ||`, which go on when the `cd` fails, they are judged in both directories and the worse verdict holds. A `cd` inside a subshell, a pipeline stage, or a background job moves nothing after it, and a `$( )`, `sh -c`, or `eval` payload starts in the directory of the command around it. `git -C dir` moves the paths `git checkout` names.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

| File | Role |
|---|---|
| [`src/parse.ts`](src/parse.ts) | Quote-aware tokenizer flattening a line into simple commands with their redirections, pipe targets, possible working directories, and `xargs` input marks |
| [`src/classify.ts`](src/classify.ts) | The rule table, path placement against the workspace and temporary roots, and the worst-verdict fold over rules, directories, and commands |
| [`src/index.ts`](src/index.ts) | The `tools/pre-execute` listener, the filesystem check and path spellings it hands the classifier, the unattended check, the `/commands-gate` command, and the block record |
| [`src/types.ts`](src/types.ts) | Parsed shapes, verdicts, and the `command-gate/blocked` event declaration |

The decision is returned from the `tools/pre-execute` waterfall, which the registry consults inside the operation that dispatches the call, so a caller that never went through the model still meets it. A `confirm` verdict becomes `{ kind: 'ask' }` and the approval stack writes its own asked and decided pair; the gate logs `command-gate/blocked` only for refusals it makes itself.

No invariant companion is published because each verdict is computed from the command text inside `tools/pre-execute`, and the `dsh-user-approval` companion already checks the asked and decided pair a `confirm` verdict produces.

-----

<a id="model-experience"></a>
## Model Experience

### A refused command

#### What the model sees

The tool result carries `Error:` followed by `Command gate:` and the rule's sentence, which states what the command would do and the way forward: commit or stash before discarding changes, write inside the workspace or a temporary directory such as `/tmp`, read a downloaded script before running it. Naming the gate keeps the model from attributing the refusal to the sandbox, and the sentence asserts nothing the gate did not check, such as whether the files are committed. No configuration vocabulary appears.

#### Token effect

Conditional: one sentence in place of the command's output, only when a rule matches.

#### KV Cache effect

Append-only: the refusal is an ordinary tool result and no prompt section changes.

## Known Limitations and Deferred Work

- **The parser does not expand variables or globs** — a path that arrives as `$TARGET` reaches a rule unexpanded, so a destructive command assembled entirely from variables is not recognised. A `cd` to such a word, to `~`, or to `-` is not followed, nor is `pushd`, `popd`, a wrapper's directory option such as `env -C`, or any `cd` after a line already has 16 possible directories, so the commands after them are judged where the line started. The sandbox remains the boundary that does not depend on reading the command.
- **A `>` or `>>` redirect inside the workspace is allowed** — creating and overwriting files is ordinary work, and a truncation of a tracked file cannot be told from writing a new one without reading the disk, so flagging every redirect would stop far more real work than it saves.
- **Rules match programs by name** — a destructive command run through a wrapper program outside the list above (such as `chrt`, `ionice`, or `taskset`), an alias, a wrapper script, or an interpreter that is not in the known list, is not classified. `xargs` is classified with the words written after it; the arguments it reads from its input are not known, so any `rm` it runs is asked about. Leading `NAME=value` assignments are skipped, so they do not hide the program.
- **The path check reads the gate's own filesystem** — `git checkout` tells a path from a branch name by asking whether the operand exists on the machine running the gate. For a shell that runs elsewhere, such as over SSH, a bare file name that does not also exist locally passes as a branch; `.`, globs, `--`, and operands starting with `/` or `.` count as paths without the check.
- **Only tools with a `command` argument are read** — a terminal tool that sends keystrokes to a live shell bypasses the gate.
- **A call without a session workspace is not classified** — a tool call that names no agent, or whose session records no working directory, has nothing to judge paths against, so the gate passes it to the tool. The agent loop always names the agent; a direct `ctx.tools.execute()` caller that omits it is not gated.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
