---
kind: upgrade-guide
description: "Terminal diagnostics and suggested commands name hydra instead of dsh, including the hydra web: line that carries the Web URL."
---
# Terminal output names `hydra` instead of `dsh`

English | [中文](guide.zh.md)

## Change

The launcher, the Web and headless apps, plugin management, and the desktop shell print `hydra` where they printed `dsh` as the program name:

| Output | Before | Now |
|---|---|---|
| Web URL and browser notices on stdout | `dsh web: http://127.0.0.1:3080/?token=…` | `hydra web: http://127.0.0.1:3080/?token=…` |
| Warnings, errors, and startup failures on stderr | `dsh: warning: 1 entry did not activate` | `hydra: warning: 1 entry did not activate` |
| Headless reasoning and turn endings on stderr | `dsh: reasoning:`, `dsh: aborted: <cause>` | `hydra: reasoning:`, `hydra: aborted: <cause>` |
| Suggested commands | `run 'dsh plugin --profile web install'` | `run 'hydra plugin --profile web install'` |
| Desktop shell and Host failures | `dsh desktop: …`, `dsh desktop host …` | `hydra desktop: …`, `hydra desktop host …` |

The Web app's "session in use" message names a running Hydra instance and `hydra web`. The `dsh` command still runs the same entry, so every suggested `hydra` command also works as `dsh`. Runtime version identifiers keep their names: `engines.dsh`, `--dsh-version`, and messages such as `incompatible with dsh 0.2.2-alpha.2`.

## Migration

1. In scripts that read the Web URL from stdout, match `hydra web: ` instead of `dsh web: `, or match the URL itself (`http://127.0.0.1:<port>/?token=…`), which is unchanged.
2. In scripts or log filters that match diagnostics, replace the `dsh: ` prefix with `hydra: `; the text after the prefix is unchanged.
3. Confirm the migration: run `hydra --profile headless "say hello"` with a model configured, or `hydra web --no-open`, and check that your script finds the lines it reads.
