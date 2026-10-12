---
description: "The learning Remote for Web GUI host clients: list, edit, and delete learned entries, manage the skills the learning plugin wrote, review candidates, and promote entries over the same store the /learn command uses."
kind: "package-reference"
---

# @deepseek-ai/dsh-api-learning-controller

## Summary

Clients call `learning/list` to show the extractor's candidates and the entries the model recalls, `learning/review` to approve or reject a candidate, `learning/forget` to delete an entry, and `learning/promote` to write one as a skill. Every method acts on `ctx.memory` and the `ctx.learning` promotion path, so the Web tab and the `/learn` command cannot disagree. The service has no configuration and no push stream: a client reloads after its own actions.

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

Mount the row beside the other Remote owners; it requires `memory` and `learning`:

```yaml
- name: '@deepseek-ai/dsh-api-learning-controller'
```

| Method | Request | Result |
|---|---|---|
| `list` | — | `{ candidates, recalled }`, each a list of entries oldest first |
| `review` | `{ id, decision: 'approve' \| 'reject' }` | the updated entry |
| `forget` | `{ id }` | `{ removed }` |
| `update` | `{ id, text?, tags? }` | the updated entry; omitted fields keep their value |
| `skills` | none | `{ skills }`: name, description, path, and size of every skill under the learning skills root |
| `readSkill` | `{ name }` | `{ content }`, `null` when no such skill exists |
| `writeSkill` | `{ name, content }` | `{ path }`; the skill is re-registered live when a registry is mounted |
| `deleteSkill` | `{ name }` | `{ removed }` |
| `promote` | `{ id, name }` | `{ path }` of the written `SKILL.md` |
| `suggestions` | — | `{ suggestions }`: proposed skill clusters with their entries, oldest first |
| `acceptSuggestion` | `{ id, name? }` | `{ path, name }` of the bundled `SKILL.md`; the suggestion becomes `accepted` and its entries `promoted` |
| `dismissSuggestion` | `{ id }` | the suggestion, now `dismissed` |

An unknown id or an invalid skill name fails the call with the store's or the learning service's message.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`LearningController` extends `TypertRemoteService` under the `learning` namespace and projects `MemoryEntry` values into plain JSON views (`learningEntryView`). `review` maps the decision onto `setStatus`; `promote` delegates to `ctx.learning.promote`, which validates the name, writes the file, registers the skill live when a registry is mounted, and marks the entry `promoted`.

</details>

No invariant companion is published because every remote answer is projected from `ctx.learning` at call time and the controller keeps no state of its own.

-----

<a id="further-exploration"></a>
## Further Exploration

- [`dsh-client-ui-learning`](../../client/ui-learning/README.md) — the Settings tab consuming this namespace.
- [`dsh-learning`](../../learning/learning/README.md) — the extractor, `/learn`, and `ctx.learning`.
- [`dsh-memory`](../../learning/memory/README.md) — the store.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-memory`: a review, forget, or promote changes the recall message of the next session step.

#### KV Cache effect

None of its own; `dsh-memory` owns the recall replacement.

## Known Limitations and Deferred Work

- **No change stream** — the namespace has no `follow`; a client that wants candidates to appear as they are extracted must poll `list`.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
