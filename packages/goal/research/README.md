---
description: "Research goals with a discovery journal for users running open-ended research: the /research goal, the journal file and tool, compaction-proof recall, and how findings survive sessions."
kind: "package-reference"
---

# @deepseek-ai/dsh-research

## Summary

`dsh-research` gives a long-running research goal a durable memory. `/research <objective>` creates or resumes a journal file under the workspace (`.dsh/research/<slug>/journal.md`) and a durable goal whose rounds follow a research loop: read the journal, pick the next hypothesis or step, run the experiment, record the result. The model records breakthroughs, hypotheses, experiments, and dead ends with the `journal` tool the moment they happen; the learning extractor files what it missed; and the journal digest is re-injected into every request as one digest-stable `user/message`, so a compacted context or a new session continues from the current state.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

`/research Find the scaling law --criteria "error below 1%; reproducible twice" --slug scaling` creates the journal and the goal. Without `--slug` the slug derives from the objective. In any later session in the same workspace, `/research continue scaling` (or `/research resume scaling`, or `/research --slug scaling`) resumes the journal, attaches the session, and continues from its next steps; `/research continue` alone continues the workspace's only journal, `/research list` lists the workspace's journals newest first with their counts, and a name the workspace does not hold is refused with the names it does. Journals live in the session's workspace folder, so a session opened in another folder does not see them. `/research status` shows counts and the next step, `/research pause` and `/research resume` stop and continue the rounds, and `/goal resume` re-arms the goal after a process restart (opening a session never re-arms it by itself). `/goal clear` removes the goal; the journal file stays.

The journal is a Markdown file with YAML frontmatter (`slug`, `objective`, `criteria`, `status`, `createdAt`, `updatedAt`, `sessions`) and the sections `Breakthroughs`, `Hypotheses` (each line carries `open`, `supported`, or `refuted`), `Experiments` (`what => result`), `Dead ends`, and `Next steps`. Edit it by hand to prune or correct; the folder is watched and the next request sees the change.

Each `journal` breakthrough is announced through `dsh-notify` as `researchBreakthrough` when that plugin is mounted with a channel.

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `dir` | required (`.dsh/research` in `dsh-base`) | Research directory; a relative path resolves against each session's workspace directory |
| `maxRecallBytes` | required (`8000` in `dsh-base`) | Byte cap on the `<research_journal>` block; within it next steps, dead ends, criteria, open hypotheses, and recent experiments are kept first, then the newest breakthroughs |
| `recentExperiments` | required (`10` in `dsh-base`) | How many most-recent experiments the block lists |
| `relatedBreakthroughs` | `5` (schema default; `5` in `dsh-base`) | How many breakthroughs mirrored from other journals the block lists under "Related breakthroughs from other research"; `0` omits the section; read from `ctx.memory` when `dsh-memory` is mounted |
| `scoring.enabled` | required (`true` in `dsh-base`) | Whether one auxiliary request re-scores the open hypotheses after each recorded experiment |
| `scoring.maxOutputTokens` | required (`512` in `dsh-base`) | Output cap of one scoring request |
| `scoring.timeoutMs` | required (`60000` in `dsh-base`) | Deadline of one scoring request; a late answer is logged and ignored |
| `scoring.provider`, `scoring.model` | optional | Route of the scoring request; both or neither, absent reuses the session's own route |
| `maxExperimentMs` | required (`600000` in `dsh-base`) | Upper bound on a `run_experiment` time budget; a larger `timeoutMs` argument is capped |
| `maxOutputBytes` | required (`20000` in `dsh-base`) | Byte cap on the output a `run_experiment` call records in the journal and returns |

`run_experiment` runs one shell command through the mounted `ctx.shell` executor (so sandboxing applies) in the session's workspace, reads metrics out of its output with the caller's regular expressions, computes deltas against the previous experiment with the same `title`, and records command, exit code, metrics, deltas, and an output excerpt as one journal experiment. After every recorded experiment, from either tool, a logged `session/research-score` request asks the scoring route for `[{ hypothesisId, score, reason }]` over every open hypothesis; scores are written onto the hypothesis lines (`~ score: 0.7 (reason)`), the round instruction lists open hypotheses by support and tells the model to test the highest-scored one first, and an unreadable answer is logged and leaves scores untouched.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `ctx.research`, `/research`, recall injection and the round instruction on `agent/pre-step`, `research/change` |
| [`src/tools.ts`](src/tools.ts) | The `./tools` entry: the `run_experiment` and `journal` tools over `ctx.research` |
| [`src/journal.ts`](src/journal.ts) | `FolderJournalStore`: file rendering and parsing, atomic writes, the watcher |
| [`src/recall.ts`](src/recall.ts) | The `<research_journal>` block, its digest, and the recall message identity |
| [`src/instruction.ts`](src/instruction.ts) | `/research` input parsing, the objective prefix, and the round instruction |
| [`src/types.ts`](src/types.ts) | Journal, entry, store, and service types |

A research goal is an ordinary goal whose objective starts with `[research:<slug>] `, so the round driver, the transient retry, the supervisor, and the evaluator apply unchanged; `activeFor(sessionId)` derives the slug from the live goal, so nothing beyond the goal and the file is persisted. The recall message is added, kept, or replaced exactly like `dsh-memory`'s: it is re-sent only when the digest changed or the previous copy left the model-visible surface, which is what carries the journal across compaction. Auto-capture lives in `dsh-learning`: when a session has an active research goal, its turn-end extraction uses a research prompt and files findings into the journal with source `auto` instead of proposing memories.

Extension points: `ctx.research.dir`, the configured journal directory, for a plugin that only reads journal files; `ctx.research.storeFor(cwd)` for other plugins that read or write journals, `ctx.research.record()` for automated findings, and the `research/change` event.

No invariant companion is published because the journal file is the only durable state: the store rereads it on each watcher change, and `research/change` is emitted from that reread.

-----

<a id="model-experience"></a>
## Model Experience

### Journal recall

#### What the model sees

One `user/message` per research session, sourced `{ kind: 'plugin', plugin: 'dsh-research', form: 'recall' }`, wrapping the journal digest in `<research_journal>` and `</research_journal>`: the objective and slug, one instruction line, the criteria under `Done when:`, the breakthroughs, the open hypotheses, the most recent experiments, the dead ends, and the next steps, each as one `- ` line with the entry id where one exists. When the block would exceed `maxRecallBytes`, sections are kept in priority order (next steps, dead ends, criteria, open hypotheses, recent experiments, breakthroughs, related breakthroughs), a section cut short keeps its newest lines, and one line such as `- (12 older in the journal file)` stands for the rest. After the journal's own breakthroughs, a "Related breakthroughs from other research" list carries up to `relatedBreakthroughs` approved memory entries tagged `breakthrough` whose `research:<slug>` tag names another journal, newest first, each as `[<slug>] <text>`. Those entries exist because `dsh-learning` mirrors every recorded breakthrough into `dsh-memory` as an approved `fact` (tags `research:<slug>` and `breakthrough`, deduplicated by normalized text), so ordinary sessions recall them through the memory block too.

#### Token effect

Capped by `maxRecallBytes`; re-sent on a step that starts work (the user's message, a goal round) when the journal or a related breakthrough changed, and on any step once the previous copy left the surface. A step within a turn never re-sends it: the model sees the changes it made in the results of the `journal` and `run_experiment` calls that made them.

#### KV Cache effect

Append-only: a changed journal appends a new recall message at the next step that starts work, after the existing history; earlier request prefixes stay reusable.

### Round instruction

#### What the model sees

On each goal round, one `user/message` sourced `{ kind: 'plugin', plugin: 'dsh-research' }` after the driver's round message: `Role: researcher`, the objective, the criteria, the six-step loop (read the journal, take the next step or form a hypothesis, run the experiment, record the outcome and dead ends, record a breakthrough at once, replace the next steps), and the rule that `update_goal` `complete` needs every criterion to hold.

#### Token effect

Fixed size per round plus the criteria and the first next step.

#### KV Cache effect

Append-only within a turn; each round adds one message after the history.

### `run_experiment` tool

#### What the model sees

The `run_experiment` schema in the [tool catalog](../../../docs/tool-catalog.md): `title` and `command` (required), `hypothesisId`, `timeoutMs`, and `metrics` (`{ name, regex }` list); the result names the experiment id and its summary line. Both tools ship as the `./tools` entry (`@deepseek-ai/dsh-research/tools`), mounted separately from the service, so a surface that hides them keeps recall, the round instruction, and `/research`.

#### Token effect

One schema in every request of a composition that mounts the plugin; the result carries at most `maxOutputBytes` of output.

#### KV Cache effect

Prefix-stable: the schema does not change between requests.

### Hypothesis scoring request

#### What the model sees

An auxiliary request (`purpose: 'research-score'`), logged as `session/research-score` before it is sent: the system prompt below and one user message with the objective, criteria, open hypotheses with current scores, every experiment, and the dead ends.

##### Verbatim system prompt

```markdown
You rank the open hypotheses of a research journal by how well the recorded experiments support them.
Answer with a JSON array only. Each item is {"hypothesisId": string, "score": number, "reason": string}: score is 0 (refuted by the evidence) to 1 (strongly supported); reason is one sentence citing the experiments.
Include every open hypothesis exactly once. Do not invent hypotheses or experiments.
```

#### Token effect

One independent request per recorded experiment while any hypothesis is open; nothing enters the session's own model history.

#### KV Cache effect

Independent: a separate request that does not touch the session's prefix.

### `journal` tool

#### What the model sees

The `journal` schema in the [tool catalog](../../../docs/tool-catalog.md): `action` (`breakthrough`, `hypothesis`, `experiment`, `dead_end`, `next`, `read`) with `slug`, `text`, `id`, `status`, `what`, `result`, and `steps`. Results are `Recorded <id>.`, `Next steps replaced.`, or the journal file for `read`.

#### Token effect

One schema in every request of a composition that mounts the plugin.

#### KV Cache effect

Prefix-stable: the schema does not change between requests.

## Known Limitations and Deferred Work

- **Done is still the model's call, gated by the evaluator** — `dsh-goal-evaluator` judges `update_goal complete` from recent tool results and workspace changes; the journal reaches it only through the `journal read` result the model fetches. A direct evidence hook is deferred.
- **Scores reach the model through the round instruction, not the recall block** — the `<research_journal>` block lists open hypotheses without scores; the ranked list with scores and reasons is in the round instruction of each goal round.
- **One research goal per session** — a session runs one research slug at a time; several journals in one workspace need separate sessions.
- **The bridge sees live workspaces only** — a breakthrough is mirrored into memory when a live session's workspace owns the journal that changed; edits to a journal file of a workspace with no live session are mirrored the next time a session records in it.
- **An outside edit that restores a recent own write is ignored** — the store skips any of the last 16 texts it wrote to a file, because the watcher can report a write after a later one landed and re-reading it would roll the journal back; an editor's undo to exactly one of those texts is skipped until the next change.
- **Entries never merge or age** — the journal grows until a human prunes the file; within the recall byte cap the `<research_journal>` block keeps next steps, dead ends, criteria, open hypotheses, and recent experiments first, then the newest breakthroughs, and a section cut short says how many more the journal file holds.
- **Auto-capture depends on the extractor's route** — `dsh-learning` reuses the session's model route unless configured otherwise; a session that never made a request has nothing to extract with.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
