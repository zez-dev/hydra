---
description: "A lockfile recording what each discovered skill's files looked like when they were trusted: the ctx.skillLock service, the /skills-lock command, and a drift row in /doctor."
kind: "package-reference"
---

# @deepseek-ai/dsh-skill-lock

## Summary

`dsh-skill-lock` records the content of every skill the catalog discovers, so an edited or replaced skill is visible instead of silently changing how the agent behaves. Skills arrive from ranked directories a project or a user controls, and Hydra writes skills itself through `/learn skill` and the memory curator. Nothing else records what a skill looked like when it was trusted. This plugin digests each skill's files, stores one record per skill in a workspace lockfile, and reports every skill as `locked`, `drifted`, `new`, or `missing`. It never edits, blocks, or reorders a skill.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The `dsh-base` bundle mounts the row `skill-lock` enabled. It needs `ctx.skills` and `ctx.commands`, and does nothing until a status or a lock runs.

```yaml
- id: skill-lock
  config:
    path: .dsh/skills.lock.json
    warnOnDrift: false
```

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Whether `ctx.skillLock` and `/skills-lock` are registered at all |
| `path` | `.dsh/skills.lock.json` | Lockfile location, resolved against the session workspace when relative |
| `warnOnDrift` | `false` | Log one warning per drifted skill on every status; off by default because a goal loop calling status each round would repeat the same warning forever |

`/skills-lock` takes three verbs. `status`, the default, prints one row per skill with its state and, for a drifted skill, the recorded and current digest prefixes. `lock [<name>…]` records the current content of every discovered skill, or only the named ones. `unlock <name>` drops one record.

### Extension points

- `ctx.skillLock`: `path(cwd)`, `status(cwd, signal?)`, `lock(cwd, names?, signal?)`, `unlock(cwd, name)`.
- `digestFiles`, `digestMetadata`, `parseLockFile`, `renderLockFile`, and `SkillLockFileError` are exported for reuse.
- `dsh-doctor` reads the service through `ctx.get('skillLock')` and adds a `skills` row counting locked, drifted, and new skills. The row is absent when this package is not mounted.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: walks a skill's files, publishes `ctx.skillLock`, registers `/skills-lock` |
| [`src/digest.ts`](src/digest.ts) | Content digest, metadata digest, and the lockfile document's parser and renderer |
| [`src/types.ts`](src/types.ts) | `SkillLockRecord`, `SkillLockFile`, `SkillLockStatusEntry`, `SkillLockResult`, `SkillLockService` |

A digest hashes each file's bytes, then hashes the relative path and that hash of every file in sorted path order. The result does not depend on the order the files were read, and it changes when a body changes, when a file is added, and when a file is renamed without its bytes changing. A record carries the digest with the file count, total bytes, the discovering root, and the time it was locked.

A skill the catalog exposes as a directory digests every file in that directory. A single-file skill digests that file. A skill the catalog exposes without a path has no files to read, so it digests its `name`, `description`, and `whenToUse` instead and is recorded with a file count of zero; `status` marks that row `metadata only`. The catalog is a snapshot, so a skill whose directory disappeared between discovery and the read is reported `missing` rather than raising.

The lockfile is written through `writeFileAtomic`, with records sorted by name and a trailing newline, so re-locking unchanged skills produces no diff. An unparsable lockfile raises `SkillLockFileError` naming the path and the reason; nothing is recorded and no record is discarded until it parses. Removing the last record leaves an empty lockfile rather than deleting it, because a missing file means "never locked" and an empty one means "locked nothing".

**Runtime invariant:** No companion is published. The lockfile is the only record of trusted content, so no second observation of it exists to diverge from; the package specs own the digest, the states, and the document format.

-----

<a id="model-experience"></a>
## Model Experience

### Human `/skills-lock` control

#### What the model sees

Nothing. The command's input and its table are user-visible output, no session event carries them, and the plugin registers no tool and injects no prompt text. A model reaches the same counts only when it calls the `doctor` tool, whose report gains one `skills` row.

#### Token effect

None by itself. Through the `doctor` tool, one row of roughly fifteen tokens joins that tool's result.

#### KV Cache effect

None. No registration, no prompt segment, and no tool set changes with the lockfile's contents.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Recording, not enforcement** — a drifted skill still loads and still reaches the model. Refusing to load one, or asking the user first, needs a decision point in `dsh-skill` that does not exist yet.
- **A skill without files is tracked by its routing text only** — a provider that builds its instructions at runtime exposes no path, so a change to those instructions goes unnoticed unless the name, description, or `whenToUse` changes with it.
- **Five hundred files per skill** — a larger bundle digests the first five hundred the directory walk reaches, and that subset depends on the filesystem's own listing order, so a change past the cap can be missed. Raising it belongs with a decision about what a skill bundle may contain.
- **Records are keyed by skill name** — a skill that moves to another root keeps its record and stays `locked`; the recorded root is reported, never compared.
- **One writer at a time** — two processes locking the same workspace write the file last-write-wins.
- **Symbolic links are read through** — a link inside a skill contributes its target's bytes under the link's own path, so retargeting a link drifts the skill while replacing the target's contents drifts it too.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

`tests/loader-composition.spec.ts` boots a `cordis.yml` through the real Loader over a temporary workspace with one seeded skill, and drives `/skills-lock` from `new` to `locked`. The doctor row is covered from `dsh-doctor`, whose spec stubs the service to check the counts, the absent section, and the unreadable-lockfile warning.

</details>
