---
description: "The learning group map: durable knowledge that outlives one session, from reviewed cross-session memory to per-role notes for delegated rounds."
kind: "package-group"
---

# learning/ — Durable knowledge

## Summary

The learning group keeps what an agent discovered so a later session does not rediscover it. A turn-end extractor proposes candidates, a person approves them, and approved entries are recalled into each request as one block. A separate store holds per-role notes for delegated QA rounds, where the reader is not the next session but the next child agent taking the same role. Nothing in this group is recalled to a model without review or without the role it belongs to: candidates stay invisible until approved, and role notes reach only the child that shares their role and workspace.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`memory/`](memory/README.md) | Reviewed cross-session memory: the `learning_memory` domain, digest-stable recall into each request, the `memory` tool, `/memory`, and the curator that ages and merges entries | `ctx.memory` |
| [`learning/`](learning/README.md) | Turn-end extraction into memory candidates, error-pattern shortcuts, and `/learn` review including promotion to a skill | `ctx.learning` |
| [`knowledge/`](knowledge/README.md) | Document knowledge base: a SQLite full-text index over configured folders, `knowledge_search`, `knowledge_read`, and `knowledge_browse` with citations, and `/kb` | `ctx.knowledge` |

-----

<a id="related-documentation"></a>
## Related documentation

- [Skills and learning subsystem](../../docs/subsystems/skills.md) — the generated service catalog for `ctx.memory`, `ctx.learning`, and `ctx.roleMemory`.
- [Generated config catalog](../../docs/config-catalog.md) — each package's validated configuration fields.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

`memory` and `learning` read and write the same entries and are split because review and extraction evolve separately. `role-memory` shares neither store nor review path: its reader is a child agent, and its notes are bounded by eviction rather than by a person.

</details>
