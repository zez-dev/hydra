---
description: "Durable learned memory for DeepSeek Harness: the learning_memory storage domain, relevance-ranked retrieval into each user request, the model-facing memory tool, and the /memory command."
kind: "package-reference"
---

# @deepseek-ai/dsh-memory

## Summary

`dsh-memory` keeps knowledge across sessions. Each step that starts work, and the first step after a compaction, retrieves the approved entries related to the work, this project's first, plus approved preferences, as one `<retrieved_memory>` block telling the model to use a note only in the same situation and to check it before acting. The model can `remember`, `search`, and `forget` through the `memory` tool; a person manages entries with `/memory`. Candidates proposed by [`dsh-learning`](../learning/README.md) stay invisible until approved. A curator ages unused entries to `stale`, then `archived`, and merges near duplicates.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount it after the storage stack (`dsh-storage`, a backend, `dsh-storage-domain`), `dsh-tools`, `dsh-commands`, and `dsh-agent`. The base bundle (`packages/bundle/base/cordis.patch.yml`) shows the rows.

```yaml
- id: memory
  name: '@deepseek-ai/dsh-memory'
  config:
    maxRecallBytes: 6000
    staleAfterDays: 30
    archiveAfterDays: 90
    duplicateThreshold: 0.7
    skillSuggestThreshold: 0.6
    skillSuggestMinEntries: 3
```

| Field | Default | Meaning |
|---|---|---|
| `maxRecallBytes` | required | UTF-8 byte cap on the recalled block; trailing entries are dropped |
| `recallLimit` | `5` | The most entries retrieved for one request by relevance to its text |
| `alwaysRecallKinds` | `['preference']` | Entry kinds recalled whatever the request's text, ahead of the retrieved entries, while no recall block in view carries them |
| `recallMinMatchedTerms` | `2` | Distinct words of the current work a retrieved entry must share (capped at the work's own word count) |
| `recallNoteCoverage` | `0.3` | Fraction of an entry's own words that, once matched, retrieves it with fewer shared words: a short note about the word stays, a long note that mentions it in passing does not |
| `recallScoreFloor` | `0.5` | Fraction of the best retrieved entry's score below which an entry is left out |
| `staleAfterDays` | absent | Days without recall or use before an approved or promoted entry turns `stale`; absent never ages |
| `archiveAfterDays` | absent | Days without recall or use before an entry turns `archived`; absent never archives |
| `duplicateThreshold` | `0.7` | Note similarity in [0, 1] at or above which two entries are the same note: storing one updates the stored entry, and curation merges a group into its newest entry |
| `skillSuggestThreshold` | absent | Similarity in [0, 1] at or above which two recalled entries join one skill cluster; entries sharing a topic tag join regardless; absent never suggests |
| `skillSuggestMinEntries` | `3` | Smallest cluster that becomes a skill suggestion |

`ctx.memory` is the `MemoryStore`: `add(input, status, sourceSessionId?)`, `get(id)`, `list({ status? })`, `search(query)`, `setStatus(id, status)`, `forget(id)`, `recalled()`, `touch(id, { lastRecalledAt?, lastUsedAt? })`, and `curate()`. Statuses are `candidate`, `approved`, `promoted`, `rejected`, `stale`, and `archived`; kinds are `fact`, `shortcut`, and `preference`. Each entry carries `recallCount`, `lastRecalledAt`, and `lastUsedAt`: the recall listener stamps every entry that enters a request's block, and the tool's `search` stamps every entry it returns.

`/memory` lists every unarchived entry grouped by status; `/memory forget <id>` deletes one; `/memory restore <id>` makes an archived entry approved again; `/memory curate` runs the curator now and reports counts; `/memory archived` lists archived entries with their notes; `/memory suggestions` lists the skill clusters awaiting a decision, which `/learn accept <id> [name]` promotes and `/learn dismiss <id>` hides.

### Skill suggestions

When `skillSuggestThreshold` is set, every curation run clusters approved and promoted entries: two entries join one cluster when they share a topic tag (tags prefixed `source:` or `error:` record where an entry came from and never cluster) or when their texts reach the threshold similarity. A cluster of at least `skillSuggestMinEntries` entries becomes a `proposed` suggestion named after its most frequent topic tag, else after the first significant words of its oldest entry, unless a suggestion in any state already covers every member. Suggestions live in the `suggestions` table of the same domain with `suggestions(filter?)`, `getSuggestion(id)`, and `setSuggestionStatus(id, status)` on `ctx.memory`; accepting is the learning package's job (it writes one bundled `SKILL.md`), so `dsh-memory` only records the decision.

### Curation rule

When `staleAfterDays` or `archiveAfterDays` is set, the curator runs at activation and once per process day (the timer is disposed with the plugin). The idle clock starts at the latest recall or use, or at the last change for an entry never recalled or used. An `approved` or `promoted` entry idle for `staleAfterDays` turns `stale`: it leaves the recall block but the model's `search` still finds it. Any aging entry idle for `archiveAfterDays` turns `archived`: it leaves search too and appears only under `/memory archived` and the Web card's Curated list. Two notes are compared by their meaningful words (lowercased, punctuation and stop words dropped, simple endings such as `-ing` and `-s` stripped): their similarity is the overlap of the two word sets (Jaccard), or 1 when a longer note holds every word of a shorter one with at least four. They are the same note when the similarity reaches `duplicateThreshold` and no word one has and the other lacks carries a digit, because notes that differ in a port, a version, or an id state different facts or a changed value. Storing an entry that is the same note as a stored one, from any path (turn review, import, `/digest`, the `memory` tool, the research bridge), updates that entry instead: it takes the new wording and the joined tags, a `stale` one turns `approved` again when the new entry is approved, a `rejected` one is left unchanged, and `archived` entries are not compared. The curator groups `approved` and `promoted` entries that are the same note, directly or through a chain, and merges each group into its newest entry, which keeps the union of the group's tags; the others are archived with the note `merged into <id>`. Each entry is compared only with the entries sharing one of its two rarest words, so curation of tens of thousands of entries takes seconds; two duplicates that share only common words are found from the side of whichever holds the rarer ones.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: domain open, `ctx.memory`, recall listener, `/memory` command |
| [`src/tools.ts`](src/tools.ts) | The `./tools` entry: the `memory` tool over `ctx.memory` |
| [`src/store.ts`](src/store.ts) | `learning_memory` domain spec and the `DomainMemoryStore` |
| [`src/recall.ts`](src/recall.ts) | `<retrieved_memory>` rendering, digest, recall-message identity |
| [`src/rank.ts`](src/rank.ts) | Full-text relevance ranking (MiniSearch, fuzzy and prefix matching) shared by retrieval and `search` |
| [`src/types.ts`](src/types.ts) | Entry, status, kind, and `MemoryStore` types |

Recall runs on `agent/pre-step` after the loop's own decision. A step that admits a message that starts work (from the user, a goal round, a webhook, or a scheduled follow-up) ranks entries against that message's text; any other step recalls only while no recall block is on the model-visible surface, as after a compaction condensed it, and ranks against the latest user request and the latest reply on the surface. Ranking is full-text matching over each entry's text and visible tags; a match must share `recallMinMatchedTerms` words with the work or cover `recallNoteCoverage` of the entry's own words, and score within `recallScoreFloor` of the best match; an entry tagged with the session's workspace scores double and one tagged with another workspace scores half. The top `recallLimit` matches follow every entry of an `alwaysRecallKinds` kind, and every entry a recall block in view already carries is dropped: it is still before the model. When nothing remains, the step adds nothing (and drops a stale pending recall); otherwise the remaining entries are rendered, the block appends a new recall message or replaces a pending one with a different digest. Only a block added while no recall block is in view opens with the rules for using notes; a later block opens with a one-line pointer to them. The workspace tag (`workspace:<directory>`, from `workspaceTag`) is added by the `memory` tool and by `dsh-learning`; it is never matched and never shown in the block, `/memory`, or tool results. The message carries `source: { kind: 'plugin:dsh-memory', form: 'recall' }`, so the loop logs it as an ordinary `user/message` and replay reconstructs it.

No invariant companion is published because entries have one writer, the storage domain the plugin opens, and the recall message is an ordinary logged `user/message` that replay reconstructs without a second source.

-----

<a id="model-experience"></a>
## Model Experience

### Recalled memory

#### What the model sees

One user-role message whose text is the `<retrieved_memory>` block: the fixed header below, then one line per retrieved entry in the form `- (<kind>, id <id>) [tags] <text>` (workspace tags omitted). A block added while an earlier one is still in view opens instead with `More notes from earlier work, retrieved for the latest request; the rules of the earlier <retrieved_memory> block apply.`

##### Verbatim header

```markdown
Notes from earlier work, retrieved because they share words with the current task; notes from this project come first. Use a note only when its situation matches the current one: the same file, command, component, or problem. A note about a different case that merely shares a word or a concept says nothing about this one, and never changes what the user asked for: answer the request as stated. When a note does match, check it before acting: do not repeat an approach it records as failed, and do not re-investigate a cause it records as settled. What you observe now takes precedence over any note; when the evidence shows a note is wrong or outdated, say so and correct or remove it with the `memory` tool.
```

#### Token effect

Conditional: present on a step that starts work and relates to at least one approved entry that no block in view carries (or when an approved preference is not in view), and on the first step after the blocks left the surface; bounded by `recallLimit` entries and `maxRecallBytes`. Each entry and the header are sent once per view: until a compaction condenses the blocks, a later block carries only new entries under the one-line head.

#### KV Cache effect

Append-only: a request that retrieves entries not yet in view appends a new recall message after the existing history; earlier request prefixes stay reusable.

### `memory` tool schema

#### What the model sees

The generated [`memory` schema](../../../docs/tool-catalog.md#deepseek-aidsh-memory): `action` (`remember` | `search` | `forget`) with `text`, `kind`, `tags`, `query`, and `id`. The tool ships as the `./tools` entry (`@deepseek-ai/dsh-memory/tools`), mounted separately from the service, so a surface that hides it keeps recall and `/memory`.

#### Token effect

Fixed schema cost per request while the tool is visible.

#### KV Cache effect

Prefix-stable; the schema does not change between requests.

## Known Limitations and Deferred Work

- **Retrieval is lexical** — entries rank by shared words (with fuzzy and prefix matching), not embeddings, so a request phrased with different words than the entry misses it; the model can still find it with `memory search`.
- **Curation uses process time** — the daily timer counts from activation, so a harness restarted every few hours curates at every activation and never on a fixed wall-clock day.
- **Stale entries never revive on their own** — a `stale` entry the model finds through `search` is stamped used but stays `stale`; approve it again through the Web card or `/learn` to recall it.
- **Suggestions are not re-planned when a cluster grows** — a suggestion covers the members it was created with; entries approved later form a new suggestion only when they cluster with each other, and a dismissed cluster keeps its members from being proposed together again.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
