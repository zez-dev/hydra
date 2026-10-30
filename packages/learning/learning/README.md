---
description: "Learning growth for DeepSeek Harness: extract reusable knowledge from finished turns and imported folders straight into recalled memory, list it with /learn, and write skills from it."
kind: "package-reference"
---

# @deepseek-ai/dsh-learning

## Summary

`dsh-learning` turns what an agent discovered into durable knowledge without letting the model write to its own memory unreviewed. After every finished turn with at least `minToolCalls` tool calls, it runs one auxiliary model request over that turn's transcript and stores the returned facts, shortcuts, and preferences as `candidate` entries in [`dsh-memory`](../memory/README.md). A person reviews them with `/learn`: approve (recalled from then on), reject (never proposed again), or promote to a skill, which writes `<name>/SKILL.md` under the skills root so the filesystem skill provider and `/name` pick it up.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount it after `dsh-memory`, `dsh-llm`, `dsh-commands`, `dsh-agent`, and `dsh-session`; the base bundle (`packages/bundle/base/cordis.patch.yml`) shows both rows.

```yaml
- id: learning
  name: '@deepseek-ai/dsh-learning'
  config:
    minToolCalls: 3
    maxCandidatesPerTurn: 5
    maxTranscriptBytes: 24000
    maxOutputTokens: 512
    timeoutMs: 60000
```

| Field | Default | Meaning |
|---|---|---|
| `fileAs` | `approved` | Review state of everything the extractor files: `approved` recalls it from the next step on and the Learning tab edits or deletes it; `candidate` holds it for `/learn approve` |
| `reviewTurns` | `true` | Review each finished turn that reaches `minToolCalls` with one extraction request, as a `learning-review` background job owned by the agent when a job registry is composed (the next turn is not held behind it, the plugin waits on the job so no completion notice reaches the model, the agent's disposal cancels it) and inside the agent's idle maintenance otherwise; `false` leaves only `/learn from` and `/research-ingest`, which matters on a slow or single-stream local route where the review request queues ahead of the next turn. A review running as a job yields to the next turn: one still in flight when that turn starts ends `killed`, and one whose next turn started before it could begin never starts; nothing is recorded either way, so it never holds a single-slot local route ahead of the conversation; the request asks the route for its lowest selectable reasoning effort (`off`, `minimal`, or `low`, whichever it offers first) so a thinking model spends the output cap on the answer. |
| `reviewTimeoutFactor` | `4` | The review's deadline is the larger of `timeoutMs` and this factor times the longest model request of the turn it reviews, so a slow local route gets the time it demonstrably needs while a fast API keeps `timeoutMs`. Each attempt also gets at least the turn's longest request plus its own output cap at the route's slowest observed milliseconds per output token, so a raised cap on a slow route is not cut by a deadline sized for the smaller one. |
| `minToolCalls` | required | Turns with fewer logged tool calls are not reviewed and start no `learning-review` job |
| `maxCandidatesPerTurn` | required | Cap on candidates stored from one turn |
| `maxTranscriptBytes` | required | UTF-8 byte cap on the transcript sent to the model |
| `maxOutputTokens` | required | Output-token cap for the extraction request; an answer cut at the cap is retried with `outputRetryFactor` times the cap, up to three raises and never above the route's own configured cap, and the raised cap is kept for that route for the life of the plugin |
| `outputRetryFactor` | `4` | Multiplier for the output cap after a truncated answer, applied up to three times; `1` disables the retry |
| `timeoutMs` | required | Deadline for one extraction request |
| `provider`, `model` | session route | Explicit extraction route; both or neither, else the session's logged request route |
| `skillsRoot` | `$DSH_HOME/skills` | Directory receiving promoted `<name>/SKILL.md` bundles |
| `skillDraftsRoot` | `$DSH_HOME/skill-drafts` | `/digest`: directory receiving skill drafts, `<name>/SKILL.md` beside `source/` and `draft.json`; the skill loader never reads it, so a draft is not live until `/learn publish` |
| `digestMaxEntriesPerPart` | `20` | `/digest`: entries kept from one model answer; the rest are counted and reported as not filed |
| `consolidateRelatedThreshold` | `0.4` | `/learn consolidate`: note similarity at or above which a note joins a group's first note |
| `consolidateMaxGroupSize` | `20` | `/learn consolidate`: most notes sent to the model in one group |
| `consolidateMaxGroups` | `25` | `/learn consolidate`: most groups one run sends, largest first; the rest wait for the next run |
| `maxFileBytes` | `262144` | `/learn from`: files larger than this many bytes are skipped (`--as-skills` writes files up to the same size) |
| `maxFilesPerImport` | `200` | `/learn from`: files beyond this count in one import are skipped and reported |
| `errorPatterns.enabled` | `true` | Second extraction pass over tool failures followed by a working retry of the same tool |
| `errorPatterns.maxPairsPerTurn` | `5` | Cap on failure-then-recovery pairs reviewed per turn |
| `extensions` | `[]` | `/learn from`: extra accepted file extensions without the dot, beside the built-in text list (md, txt, rst, adoc, json, yaml, toml, ts, js, py, go, rs, java, sh, and files without an extension) |

`/learn` (or `/learn list`) shows pending candidates when `fileAs` is `candidate`, otherwise the newest learned entries; `/learn approve <id>`, `/learn reject <id>`, and `/learn skill <id> <name>` settle one. `/learn accept <suggestion> [name]` promotes a curator-proposed cluster (see `/memory suggestions`) as one bundled skill, one bullet per entry, and marks every member `promoted`; `/learn dismiss <suggestion>` hides the cluster for good. `ctx.learning.promoteMany(ids, name)` is the same path for the Web card. `/learn drafts` lists the `/digest` skill drafts with their paths, where a person reads or edits them; `/learn publish <draft> [as <name>]` moves one into the skills root (without `draft.json`, keeping `source/`), names it in its frontmatter, and registers it live, refusing a name a live skill already uses; `/learn discard <draft>` deletes one.

`/learn consolidate [--all]` tidies memory with the model. It groups the approved and promoted entries of the session's workspace, plus entries saved before entries carried a workspace tag (`--all` takes every workspace): each group is a first entry and up to `consolidateMaxGroupSize - 1` entries whose note similarity to it reaches `consolidateRelatedThreshold`, found through the entries sharing one of its four rarest words. Up to `consolidateMaxGroups` groups are sent per run, largest first, each as one request whose output cap is the larger of `maxOutputTokens` and 120 tokens per note. The answer lists, for every note it writes, the ids of the entries that note replaces; only those entries are archived (note `consolidated into <ids>`), each written note is approved with the workspace tags of the entries it replaces and the note `consolidated from <ids>`, a note returned unchanged with its own id replaces nothing, and an entry the answer does not name stays as it was. A failed request leaves its group unchanged and the run goes on. The summary counts the notes replaced, written, and kept, the grouped entries without a workspace tag, the failed groups, and the groups left for the next run; `/memory archived` lists what was replaced and `/memory restore <id>` brings an entry back. With a job registry composed, the run is a `learning-consolidate` background job owned by the agent, like an import.

### Error patterns

After the ordinary extraction, the plugin scans the turn for a tool result marked as an error followed later by a successful result of the same tool, renders each such pair (failed arguments, error text, working arguments, result), and asks the model for one "when X fails with Y, do Z" shortcut per pair. Each answer is filed as a `shortcut` candidate tagged `fix:<tool>` and `error:<fingerprint>`, where the fingerprint hashes the error's first line with digits, paths, and punctuation removed. A candidate whose normalized text already exists, or whose fingerprint tag an entry in any state already carries, is not filed again, so the same recovery does not pile up turn after turn. A promoted skill is also registered live on `ctx.skills` when that service is mounted, so it is visible before the filesystem watcher fires.

`/learn from <path> [--tags a,b]` imports a file or folder of knowledge: the path resolves against the session workspace (absolute paths are accepted), a folder is walked recursively without entering `node_modules`, `.git`, `dist`, `lib`, `build`, `coverage`, or `.dsh`, and files that are binary, larger than `maxFileBytes`, or of an unlisted extension are skipped and reported. Each file is split into chunks of `maxTranscriptBytes`, and every chunk is one extraction request with a document-oriented instruction (facts, procedures, conventions, preferences), logged as `session/learning-request` with `turn: 0` and a `source` field naming the file and chunk. Candidates are filed for `/learn` review with the requested tags plus `source:<relative path>`, at most `maxCandidatesPerTurn` per chunk. The import uses the same extraction route as turn review, so a fresh session without a logged request route needs `provider` and `model` configured or one message sent first. The command result reports files, chunks, candidates, the skipped entries, and every chunk whose extraction request failed (a timeout, a cut answer): a failed chunk is skipped and the import goes on with the next one, so one slow file does not lose the rest of the folder. With a job registry composed (`dsh-jobs-local` plus `dsh-tool-jobs`, as in dsh-base), a model-backed import runs as a `learning-import` background job owned by the agent: the command returns at once with the job id, the extraction continues after the request that sent it ends, so closing or reloading the page no longer cancels it, the summary is the job's result and arrives in the job's completion notice, and `job_kill <id>` or the agent's disposal stops it after the current chunk and keeps what was already filed. Without a registry the import runs inside the command request, and cancelling that request stops it the same way. `--as-skills` always runs inline because it makes no model request. An extraction the memory store already holds as the same note (its `duplicateThreshold`) is not filed again: the stored entry takes the newest wording and is counted as already known, so re-importing a folder adds only what is new and a rephrased fact is not filed twice. `/digest <path> [--tags a,b]` reads the same files and lets the model decide once per document whether it is a skill. A document that fits `maxTranscriptBytes` is read whole in one request that returns its entries, the verdict, and, for a skill, a skill the model writes from the document (when to use it, prerequisites, numbered steps with the exact commands and paths, pitfalls). A longer document is read part by part, each request returning that part's entries, a one-line note, and whether the part is mostly steps; one more request, logged with `chunk: 0`, then decides from every part's note and as many parts as fit `maxTranscriptBytes`, steps first, and writes the skill from that excerpt. A skill is never live at once: it is saved as a draft under `skillDraftsRoot` with the document copied to its `source/` folder, a verdict without a written skill makes no draft, and a document digested again replaces its own draft. Facts and rules become memory entries, at most `digestMaxEntriesPerPart` per answer; the summary names the drafts, the entries filed, the entries past the cap, and every failed request, and the digest runs as the same background job as an import. `--as-skills` makes no model request at all: every text file becomes one skill under the skills root, named from its file name, with its frontmatter `description` or first heading as the routing description and the whole document as the body, so a folder of written procedures is loadable by name at once and costs no tokens on a slow route.


`/research-ingest <path> [--slug name]` reads a file or folder the same way, but on behalf of a research journal: the slug defaults to the session's active research goal, the system instruction carries the journal's objective and done criteria, and every chunk's answer is filed straight into the journal through `dsh-research`, never into memory candidates: `hypothesis` items become open hypotheses, `result` items experiments with their outcome, and `dead_end` items dead ends, each recorded as `auto` with ` (source: <path relative to the workspace>)` appended. Each request is logged as `session/learning-request` with `source.kind: 'research-import'`. The command lives on its own name because the command registry accepts one owner per name and `/research` belongs to `dsh-research`; it fails with a clear message when `dsh-research` is not mounted, the journal is unknown, or no extraction route exists.

Every breakthrough recorded in a journal of a live session's workspace is mirrored into memory as an approved `fact` tagged `research:<slug>` and `breakthrough` (deduplicated by normalized text), so other research goals list it under "Related breakthroughs from other research" and ordinary sessions recall it.
-----

<a id="understand-the-implementation"></a>
## Understand the implementation

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: turn buffering, maintenance-phase extraction, `/learn` registration |
| [`src/extract.ts`](src/extract.ts) | Transcript rendering, the extraction system prompt, candidate JSON parsing |
| [`src/command.ts`](src/command.ts) | `/learn` handler, SKILL.md rendering, and draft publishing |
| [`src/digest.ts`](src/digest.ts) | `/digest` of one document: the part and verdict requests, and the draft writer |
| [`src/types.ts`](src/types.ts) | Candidate, transcript, and the `session/learning-request` and `session/learning-review` event types |

Events are observed live on `session/event` from `turn/start` to `turn/end`, so the review never reads Session history synchronously. On `turn/end` the plugin waits for the agent to go idle, claims the maintenance phase with `agent.runMaintenance()`, appends the log-only `session/learning-request` event with the exact route, system prompt, messages, and token cap, then streams the request through `ctx.llm` with `purpose: 'learning-extract'`. A turn is reviewed at most once per process; a malformed answer stores nothing and is logged as a warning. An answer with no text at all is not "nothing found": asked at the route's lowest effort, the request is sent once more at the route's default effort, and when that answer has text the route keeps its default effort for the life of the plugin (some servers file a reply asked not to think entirely as reasoning); an answer still without text fails with `LEARNING_EMPTY_ANSWER`, which the review records as failed and `/learn from` and `/digest` report as a failed request. Once every candidate or finding a review produced is stored, the session gets one log-only `session/learning-review` event with the reviewed turn and what was filed; the Web transcript renders it as a row after that turn ("Learning review filed 2 candidates · Review with /learn"), so a review is never silent; a review whose request failed records the failure code and message instead ("Learning review failed: LEARNING_EXTRACT_TIMEOUT after 60000ms"), which is what a route slower than `timeoutMs` produces on every turn. A turn below `minToolCalls`, or one whose transcript has no text, starts no job, claims no maintenance, and gets no event.

Every entry a turn review, an error-pattern review, or an import files carries the session's workspace as a hidden `workspace:<directory>` tag (`workspaceTag` from `dsh-memory`), so recall ranks the project's own entries first. A research session's review files into its journal, so its lessons reach the journal's dead ends and results, not memory.

No invariant companion is published; the candidate count a `session/learning-review` event reports and the entries the review filed in the memory store can diverge, and that check is listed under Known Limitations.

-----

<a id="model-experience"></a>
## Model Experience

### Extraction request

#### What the model sees

An auxiliary request, separate from the conversation: the fixed system prompt below and one user message `Review this turn transcript:` followed by the rendered turn (user, context, assistant, tool call, and tool result lines, each truncated to 600 characters, capped at `maxTranscriptBytes`).

##### Verbatim system prompt

```markdown
You review one finished turn of an AI coding-assistant session and decide whether it taught anything worth keeping for later work on this machine and project. Most turns teach nothing new; then answer [].
Keep an item only when a capable engineer new to this project would otherwise waste time or make a mistake: a non-obvious environment or project fact that took effort to find (a required setting, a build or test quirk, a tool version that matters), a workaround for an error likely to recur, an explicit user preference or decision, or a lesson: the established root cause of a problem, an approach that failed and why, or a wrong assumption that was corrected.
Never keep general programming knowledge (how a language, library, or standard command works), a restatement of the task or of the change that was made, what a file contains when reading it shows that, one-off steps of this task, plans or progress reports, errors that were never explained, or anything the repository already documents.
Write every item so it can be checked against a later task: name its situation (the file, command, component, or problem it is about) so it is never applied to a different case that only shares a word.
Answer with the JSON array alone, with no explanation before or after it, and never two items that say the same thing. Each item is {"text": string, "kind": "fact" | "shortcut" | "preference", "tags": string[]}; a lesson is a "fact" tagged "lesson". Text is one or two sentences.
```

#### Token effect

Auxiliary: one request per reviewed turn, bounded by `maxTranscriptBytes` in and `maxOutputTokens` out; the conversation itself gains nothing.

#### KV Cache effect

Independent request; it neither reuses nor invalidates the conversation's prefix.

### Digest requests

#### What the model sees

Auxiliary requests, separate from the conversation, one user message each. A document that fits one request gets the document system prompt and `Source file: <path>`, `The whole document follows.`, and the document. A longer document gets the part system prompt once per part, with `Source file: <path> (part <n> of <N>)` and the part, then the document system prompt with every part's note (`(not read: its request failed)` for a failed part, ` [steps]` for a part marked as steps) and `An excerpt follows: parts <list> of <N>, steps first.` with those parts.

##### Verbatim part system prompt

```markdown
You read one part of a longer document from the user's knowledge base. The other parts are read separately, and a later step decides about the whole document.
Keep the durable items in this part that deserve a memory entry on their own: facts (names, paths, URLs, versions, architecture), procedures (commands and steps that work), conventions (rules the project follows), and explicit preferences. Do not keep prose summaries, task-local state, or anything already obvious from the file name.
Also write one line on what this part covers, and say whether this part is mostly steps, commands, or a checklist.
Answer with a JSON object only: {"note": string, "procedural": boolean, "entries": [{"text": string, "kind": "fact" | "shortcut" | "preference", "tags": string[]}]}. Use "shortcut" for procedures and "preference" for conventions. Each text is one or two sentences. Use an empty entries array when nothing qualifies.
```

##### Verbatim document system prompt

```markdown
You read a document from the user's knowledge base and decide whether it is a skill: a reusable procedure, playbook, or checklist that a future coding-assistant session would load whole to carry out a task.
Answer skill true only when most of the document is such a procedure. Reference material, background, notes, API documentation, and source code are not skills; answer false for them, and answer false when unsure.
When skill is true, write the skill in Markdown for an assistant that has not read the document: when to use it, what must be in place first, the numbered steps with the exact commands and paths the document gives, and the pitfalls it warns about. Use only what the document says.
When the request holds the whole document, also keep its durable items: facts (names, paths, URLs, versions, architecture), procedures (commands and steps that work), conventions (rules the project follows), and explicit preferences, each in one or two sentences. Keep none when the request holds notes and an excerpt of a longer document.
Answer with a JSON object only: {"skill": boolean, "description": string, "body": string, "entries": [{"text": string, "kind": "fact" | "shortcut" | "preference", "tags": string[]}]}. The description is one sentence saying when to use the skill; leave description and body empty when skill is false. Use "shortcut" for procedures and "preference" for conventions.
```

#### Token effect

Auxiliary: one request per document that fits `maxTranscriptBytes`, and one per part plus one verdict for a longer document; each carries at most `maxTranscriptBytes` of document text and `maxOutputTokens` out (raised on a cut answer as for extraction). The conversation gains only the command's summary.

#### KV Cache effect

Independent requests; they neither reuse nor invalidate the conversation's prefix.

### Consolidation requests

#### What the model sees

One auxiliary request per group, logged as `session/learning-request` with `turn: 0` and no `source` (the source union admits no new variant without a session format version bump; the system prompt identifies the request). The fixed system prompt below and one user message: `Tidy these notes:` followed by one line per entry, `- [<id>] (<date last stated>, <kind>; <visible tags>) <text>`.

##### Verbatim system prompt

```markdown
You tidy one group of related notes from an AI coding assistant's long-term memory into the fewest notes that keep every distinct fact.
Each input note has an id, the date it was last stated, its kind, and its tags.
Notes that say the same thing become one note in the clearest wording. When notes disagree, the note with the later date is current: keep what it says and drop the older statement.
Every other fact in the input must appear in the output, and each note must still name its situation (the file, command, component, or problem it is about). Use only what the notes say; never add a fact.
A note unrelated to the rest of the group is returned unchanged, with its own id in "from".
Answer with a JSON array only. Each item is {"text": string, "kind": "fact" | "shortcut" | "preference", "tags": string[], "from": string[]}, where "from" lists the ids of every input note the item replaces. Text is one or two sentences.
```

#### Token effect

Auxiliary and manual: one request per group, at most `consolidateMaxGroups` per run, each carrying at most `consolidateMaxGroupSize` notes in and the larger of `maxOutputTokens` and 120 tokens per note out. The conversation gains only the command's summary.

#### KV Cache effect

Independent requests; they neither reuse nor invalidate the conversation's prefix.

## Known Limitations and Deferred Work

- **No automatic quality judgement** — with `fileAs: approved` everything the extractor returns is recalled until a person edits or deletes it in the Learning tab; a wrong extraction reaches the model until then.
- **Promoted skills are flat** — one SKILL.md with the entry text as body; resources and multi-file bundles are edited by hand afterwards.
- **Once per process** — the reviewed-turn set is process-local, so a restart mid-turn can review that turn again.
- **Error pairs match by tool name only** — a failure of `bash` pairs with the next `bash` success even when the command differs; the model is asked to skip unrelated pairs, and the fingerprint tag keeps repeats out.
- **Deduplication is by normalized text only** — a rephrased fact is filed again; the curator's similarity merge catches most of these later. Source tags are lowercased by the memory store, so a path with uppercase letters loses its case in the tag.
- **A long document's skill is written from an excerpt** — the verdict request carries every part's note but only the parts that fit `maxTranscriptBytes`, steps first; the summary marks such a draft `(written from an excerpt)` so a person reads it against `source/` before publishing.
- **Imports read whole files into memory** — `maxFileBytes` bounds each file; a very large tree is bounded only by `maxFilesPerImport`.
- **No invariant companion yet** — nothing checks that the count in each `session/learning-review` matches the entries that review filed in the memory store.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
