---
description: "The Hydra environment self-check: /doctor and the doctor tool report credentials, tool-calling settings, sandbox, native addon, Harness home, workspace folders, plugin activation, skill drift, and git in one table."
kind: "package-reference"
---

# @deepseek-ai/dsh-doctor

## Summary

`dsh-doctor` answers "is this machine set up correctly" in one command. `/doctor` prints a table of checks with a status and a one-line fix for anything wrong; the `doctor` tool returns the same report as JSON so the model can diagnose its own environment. Every failure this fork hit while moving between machines has a row here: a missing key reference, tool-calling settings that make GLM and Qwen fail, a blocked bubblewrap sandbox, an unbuilt native addon, an uninitialized Harness home, and a plugin that did not activate. Run it first on a new machine.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

`/doctor` runs every check and prints the table. `/doctor --probe` adds one tiny live model request to the default route, or to the `provider/model` route the command names, and reports its latency or the classified failure (authentication, context, network). `/doctor --fix` creates the workspace folders the Hydra plugins expect; it changes nothing else, and no flag ever writes configuration.

A check that throws does not stop the report: it becomes one `fail` row, named `could not run` (or `probe` for the probe), whose detail names the error and whose fix points at the full error in the log under `$DSH_HOME/logs`. Every other check still runs.

| Field | Default | Meaning |
|---|---|---|
| `probeTimeoutMs` | `20000` | Deadline of one `--probe` request in milliseconds |

The report has ten sections; `skills` appears only when `dsh-skill-lock` is mounted:

| Section | Checks |
|---|---|
| `about` | Always first: the Hydra release (the version every Hydra package manifest carries), the DeepSeek Harness release it is based on (`DEEPSEEK_HARNESS_VERSION`), the Node.js version, and the platform, so a pasted report identifies the build |
| `credentials` | `DEEPSEEK_API_KEY` and the `apiKeyEnv` reference of each provider on every enabled `dsh-llm-pi-ai` Loader row resolve, through `ctx.credentials` when mounted and the process environment otherwise; with `--probe`, one live request. The key itself is never read into the report |
| `tools` | `argumentCoercion: lenient` and `nullableParameters: flat` on the tools row, and `requireDescription: false` on the shell tools |
| `sandbox` | On Linux, the bubblewrap probe and `kernel.apparmor_restrict_unprivileged_userns`, plus whether the Landlock runner binary is present |
| `native` | Whether this platform's `system.node` addon loads |
| `home` | `DSH_HOME` set, writable, `.env` present, profile initialized |
| `workspace` | `.dsh/research`, `.dsh/reports`, the skills roots, and `AGENTS.md` or `CLAUDE.md` |
| `plugins` | Each Loader row that did not activate (a pending row names the services it waits for, a failed row points at the startup log), then each Hydra service present: memory, learning, research, notify, spendGuard, cronSessions, digest, goals, commands, tools, llm |
| `git` | The workspace is a git repository with a commit identity, so the harness can commit and diff its changes |
| `skills` | How many discovered skills are locked, drifted, or new against the skill lockfile, read from `ctx.skillLock` |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `ctx.doctor`, the `/doctor` command, Loader row and service reads, per-check failure containment, the probe |
| [`src/tools.ts`](src/tools.ts) | The `./tools` entry: the `doctor` tool over `ctx.doctor` |
| [`src/checks.ts`](src/checks.ts) | Pure checks over an injected environment, the probe-error classifier, the summary, and the table renderer |
| [`src/host.ts`](src/host.ts) | The production environment over Node, the Landlock runner, and the addon path computed from injected platform facts |
| [`src/types.ts`](src/types.ts) | `DoctorRow`, `DoctorReport`, `DoctorEnvironment`, and the injected-internals seam the tests replace |

Every host fact reads through `DoctorEnvironment`, so the tests supply fake filesystem and spawn answers instead of touching the host. Services and Loader rows are read through their real types, and [`tests/loader-composition.spec.ts`](tests/loader-composition.spec.ts) boots them through the Loader, including a dsh profile with the settings service that the web Models page writes provider profiles through.

No invariant companion is published because each report is computed from the environment when it is requested, and nothing is kept between reports.

-----

<a id="model-experience"></a>
## Model Experience

### The `doctor` tool

#### What the model sees

A read-only tool that returns the report as JSON: rows of section, check, status, detail, and fix, plus counts by status. The model calls it to explain why its own tools or sandbox are failing. The tool ships as the `./tools` entry (`@deepseek-ai/dsh-doctor/tools`), mounted separately from the service, so a surface that hides it leaves `/doctor` working.

#### Token effect

Conditional: only the result of a call the model makes, bounded by the number of checks.

#### KV Cache effect

Append-only: the schema is fixed and results land as ordinary tool results.

## Known Limitations and Deferred Work

- **Configuration rows read the loader config** — the tools and shell settings and each pi-ai provider's key reference come from the composed row configuration, so a plugin constructed directly in a test, outside the Loader, reports the tools rows as unknown and lists no pi-ai provider rather than reading the live instances.
- **`--probe` spends tokens** — one small request to the probed route, which is why probing is opt-in.
- **Plugin rows report state, not the Loader's reason** — a failed row points at the startup log instead of carrying the activation error, and a service whose plugin failed shows as absent.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
