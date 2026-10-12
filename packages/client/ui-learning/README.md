---
description: "Learning tab in the Web Plugins settings section: list, edit, and delete what the harness learned, manage the skills it wrote, and still review candidates when a deployment holds them."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-learning

## Summary

The Learning tab shows what the harness learned and what it wrote as skills. **Learned** lists every recalled entry with its kind and tags; **Edit** rewrites its text in place, **Delete** removes it, and **Promote to skill** names a skill file for it. **Skills** lists the skills the learning plugin wrote from memory or an imported folder; **Open** loads the file into an editor, **Save** replaces it and re-registers it live, **Delete skill** removes it. A deployment that files extractions as candidates (`fileAs: candidate`) also gets **Candidates awaiting review** with Approve and Reject; the shipped `approved` default hides that list.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Open Settings, Plugins, then the **Learning** tab. Learned entries list oldest first with their kind and tags; edit one inline, delete it, or promote it to a skill by naming the skill. Skills list by name with their routing description; open one to edit the whole `SKILL.md`, save, or delete it. Curated entries and suggested skills keep their earlier controls.

A **Suggested skills** section lists the clusters the curator proposed, each with its entries and an editable name prefilled from the proposal; **Accept** writes them as one skill and **Dismiss** hides the cluster.

The tab has no configuration. It needs the `learning` Remote mounted by [`dsh-api-learning-controller`](../../api/learning-controller/README.md) and reads it lazily when the tab is opened.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Registration

`apply` registers the `settings.learning` dictionaries and one `settings.plugins.tab` entry (`id: learning`, order 20) whose inject face wraps `ctx.remote.learning` into plain callbacks: `list`, `update`, `skills`, `readSkill`, `writeSkill`, `deleteSkill`, `review`, `forget`, and `promote`. Components never see `ctx`.

### Rendering

`LearningSettingsTab` loads the snapshot on mount and after each action, tracks one busy entry at a time, and keeps per-entry notices for failures and the written skill name. The promote form is inline under the entry.

</details>

No invariant companion is published because the tab keeps only view state and rereads the entries from `ctx.remote.learning` after each action.

-----

<a id="further-exploration"></a>
## Further Exploration

- [`dsh-api-learning-controller`](../../api/learning-controller/README.md) — the Remote this tab calls.
- [`dsh-learning`](../../learning/learning/README.md) — the extractor and the `/learn` command.
- [`dsh-memory`](../../learning/memory/README.md) — the store and the recall message.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-memory` and `dsh-skill`: editing or deleting an entry here changes the recall message of the next step, and saving or deleting a skill changes what the model can load by name.

#### KV Cache effect

None of its own; the recall message replacement that follows an approval or a forget is owned by `dsh-memory`.

## Known Limitations and Deferred Work

- **No live updates** — the tab reads the Remote on open and after its own actions; candidates extracted while the tab is open appear on the next reload.
- **No edit** — an entry's text and tags cannot be edited here; forget and re-remember through the `memory` tool instead.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
