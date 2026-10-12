---
description: "Document knowledge base for DeepSeek Harness: a SQLite full-text index over configured folders, model-facing search, read, and browse tools with citations, and the /kb command."
kind: "package-reference"
---

# @deepseek-ai/dsh-knowledge

English | [中文](README.zh.md)

## Summary

`dsh-knowledge` makes folders of documents, notes, code, scripts, and books searchable by the agent. It splits every text file into passages along its structure (headings, top-level definitions, paragraphs) and keeps them in a SQLite full-text index updated in the background. A model route can summarize and tag every file in the background, so files can be found before they are read. The model searches with `knowledge_search`, opens exact lines with `knowledge_read`, and lists a collection or a tag with `knowledge_browse`, citing passages as `collection:path#Lstart-Lend`. A person manages the index with `/kb`.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The base bundle mounts the service with no collections and the `./tools` entry beside it, and the Web profile's standard, ptc, and cordis presets mount the `./tools` entry for their agents instead. Until a session reaches a collection, the model sees only `knowledge_add`. Add folders for every workspace in your profile's `cordis.patch.yml` (for the web profile, `~/.dsh/profiles/web/cordis.patch.yml`):

```yaml
- id: knowledge
  config:
    path: !!js dshHomePath('knowledge/index.sqlite')
    collections:
      - name: notes
        root: /home/me/notes
      - name: scripts
        root: /home/me/scripts
```

| Field | Default | Meaning |
|---|---|---|
| `path` | required | Index database file; `:memory:` keeps the index for the process only |
| `collections` | `[]` | Folders to index, each `{ name, root }`; names use letters, digits, `-`, and `_`, roots are absolute |
| `excludeDirs` | `.git`, `node_modules`, virtualenv, editor folders, and `.dsh` | Folder names skipped anywhere under a root |
| `maxFileBytes` | `4194304` | Text files larger than this are skipped |
| `maxDocumentBytes` | `67108864` | PDF, Word, and EPUB files larger than this are skipped |
| `targetChars` | `2400` | Size a passage grows to before a paragraph break may end it |
| `maxChars` | `4800` | Size at which a passage ends even without a break |
| `hitChars` | `1500` | Passage text one search hit carries |
| `maxReadLines` | `300` | Most lines one `knowledge_read` returns |
| `indexOnStart` | `true` | Run a background pass when the plugin starts |
| `reindexIntervalSeconds` | `900` | Seconds between background passes that pick up new and changed files; `0` runs only at start |
| `enrichProvider`, `enrichModel` | absent | Route that writes file summaries; set both, or neither to use the invoking session's route |
| `enrichConcurrency` | `2` | Summary requests in flight at once |
| `enrichMaxInputChars` | `6000` | File text one summary request shows |
| `enrichMaxTokens` | `1024` | Output cap of one summary request |
| `enrichTimeoutMs` | `180000` | Milliseconds one summary request may take |
| `autoEnrich` | `true` | Summarize new and changed files and roll folders up in each background pass, once `enrichProvider` and `enrichModel` are set |
| `embeddings` | absent | `{ baseURL, model, apiKeyEnv?, dimensions?, batchSize (32), timeoutMs (60000) }` of an OpenAI-compatible `/embeddings` endpoint; set it to rank passages by meaning as well as by words |
| `autoEmbed` | `true` | Embed new passages in each background pass, once `embeddings` is set |
| `folderRollupMinChildren` | `2` | After summarizing files, write a rollup for each folder with at least this many summarized children; `0` turns rollups off |

Indexing reads Markdown, text, reStructuredText, AsciiDoc, HTML, JSON, YAML, TOML, logs, CSV, and common source and script files, and extracts the text of PDF (one `## Page N` section per page), Word (`Heading N` styles become headings), and EPUB (chapters in reading order) files; the extracted text is kept in the index, so `knowledge_read` returns the same lines the refs cite. A file with a NUL byte, an unknown extension, no extractable text (a scanned PDF), or more than its size limit is skipped. Nothing needs a command once a profile names its collections: a background pass at start and every `reindexIntervalSeconds` indexes new and changed files, then embeds new passages when `embeddings` is set, then summarizes new files and rolls folders up when an enrichment route is set; a pass never overlaps the previous one. A pass reads only files whose size or modification time changed and removes files that disappeared, including every file of a collection that is no longer configured. `/kb` lists the collections with their file, passage, and summarized counts, `/kb reindex [collection]` runs a pass now, `/kb enrich [collection] [--limit N]` summarizes waiting files (500 by default) as a background job owned by the session, stopped with `job_kill`, and `/kb embed [collection] [--limit N]` embeds waiting passages the same way, and `/kb search <words>` lists matching refs.

Whatever `excludeDirs` says, the index never reads credential folders (`.ssh`, `.gnupg`, `.aws`, `.kube`, `.docker`, `.password-store`) or secret files: environment files (`.env`, `.env.*`, `*.env`), SSH private keys (`id_rsa`, `id_ed25519`, and the other `id_*` key names), key and certificate stores (`.pem`, `.key`, `.p12`, `.pfx`, `.kdbx`, `.ppk`, `.jks`, `.keystore`), `.netrc`, `.pgpass`, `.npmrc`, `.pypirc`, `.git-credentials`, and any file whose name contains `credentials` or `secret`. Search results reach the model and its session log, so this rule is fixed rather than configurable, and a file of these kinds that an earlier version indexed is removed by the next pass. The `.dsh` folder Hydra keeps in a workspace is excluded by default.

With `embeddings` set and passages embedded, `knowledge_search` also embeds the query and ranks every stored vector by cosine similarity; the word ranking and the meaning ranking are merged by reciprocal rank fusion, so a passage can be found with words it does not contain. Vectors are stored normalized as 8-bit values and held in memory after the first search; a changed file loses its vectors with its passages. When the endpoint fails, the search falls back to the word ranking.

Enrichment sends one request per file with the route's lowest reasoning effort: the file's path, its section headings, and its opening `enrichMaxInputChars` characters, asking for a JSON object with a type (`code`, `script`, `tool`, `tip`, `cheatsheet`, `automation`, `guide`, `reference`, `book`, `note`, `config`, `data`, or `other`), up to six topic tags, and a two-to-four-sentence summary. A file whose request fails or whose answer has no summary stays waiting for the next run; a changed file loses its summary and waits again. After the files, the same run writes a rollup (tags and a summary) for each folder whose summarized children changed, one depth level at a time from the deepest, so a folder's rollup is written once from its files' summaries and its subfolders' fresh rollups.

A workspace can carry its own collections without a profile edit. `/kb add <folder> [--name <name>]` attaches a folder to the session's workspace: `~` is the home folder, a relative path is taken from the workspace, a disk's root is refused, and the name defaults to the folder's name, made unique against every collection the session reaches. The workspace keeps the list in `<workspace>/.dsh/knowledge/collections.json` and the index beside it in `index.sqlite`, so only sessions whose folder is that workspace reach these collections; a list file this build cannot read fails the command with the file named. `/kb remove <name>` detaches a workspace collection and drops its files, while a collection the profile configures is removed only in the profile. Attaching a folder indexes it at once but never summarizes it; `/kb enrich <name>` does, with one model request per file, and `autoEnrich` summarizes only the configured collections. A workspace index is refreshed when a process first opens it and on every background pass after that, embeddings included when `embeddings` is set. `/kb` (or `/kb list`), `/kb reindex`, `/kb enrich`, `/kb embed`, and `/kb search` cover the configured collections and the session's workspace collections together.

`ctx.knowledge` is the `KnowledgeIndex`: `update(signal?, collection?)`, `search({ query, collection?, kind?, limit })`, `searchSummaries({ query, collection?, limit })`, `read(collection, path, startLine?, endLine?)`, `browse(collection, folder?)`, `filesWithTag(collection, tag, limit)`, `pendingSummaries(limit, collection?)`, `saveSummary(fileId, summary, model)`, and `stats()`. `ctx.knowledgeWorkspaces` is the `WorkspaceKnowledge`: `open(cwd)` returns the workspace's collections and index, or `undefined` when no folder is attached; `add(cwd, path, name?, signal?)` attaches and indexes a folder and returns the collection with its file and passage counts; `remove(cwd, name)` detaches one; `list()` returns the workspaces opened so far; `watch(listener)` reports each workspace whose list changed; `countFiles(root, signal?)` counts the files a pass would read; and `summaryRoute(session)` and `summarize(cwd, name, route, signal)` pick the summary route and run it for one workspace collection.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: configuration checks, `ctx.knowledge` and `ctx.knowledgeWorkspaces`, the background passes, `/kb` |
| [`src/workspace.ts`](src/workspace.ts) | Workspace collections: the list file, folder resolution and naming, one index per workspace, and rank merging across indexes |
| [`src/secret.ts`](src/secret.ts) | The secret file and credential folder rule the walk and the pass apply |
| [`src/tools.ts`](src/tools.ts) | The `./tools` entry: `knowledge_add` with its approvals, the search, read, and browse tools registered for the sessions that reach a collection, and the per-session prompt section |
| [`src/job.ts`](src/job.ts) | The `knowledge-enrich` background job that `/kb enrich`, `/kb embed`, and approved summaries run as |
| [`src/store.ts`](src/store.ts) | The SQLite index: schema, incremental pass, ranked search, bounded reads, browsing |
| [`src/chunk.ts`](src/chunk.ts) | Passage splitting by headings, definitions, and paragraph breaks |
| [`src/extract.ts`](src/extract.ts) | PDF, Word, and EPUB text extraction to Markdown |
| [`src/embed.ts`](src/embed.ts) | Embedding requests, 8-bit vectors, cosine ranking, and reciprocal rank fusion |
| [`src/enrich.ts`](src/enrich.ts) | Per-file summary requests, answer parsing, and the concurrent enrichment run |
| [`src/types.ts`](src/types.ts) | Collection, passage, hit, and report types |

The index keeps files, passages, and an FTS5 table whose rows share the passage ids, so replacing one file's passages never scans the others. The FTS5 tokenizer stems English words (`porter unicode61`) and keeps `_` inside identifiers. A query keeps its meaningful words as prefix terms joined by OR, and BM25 ranks passages that match more and rarer words first, weighting a match in the heading and path above one in the text. The pass yields to the event loop every 25 files and never follows symbolic links; a read resolves the path inside the collection root and refuses anything outside it. An index database written by another schema version is emptied and rebuilt from the files, and a database that belongs to another application is refused.

No invariant companion is published because the index is a rebuildable cache of the collection files: a pass replaces a file's passages from its current text, and an index written by another schema version is rebuilt from the files.

-----

<a id="model-experience"></a>
## Model Experience

### Prompt section

#### What the model sees

When the session reaches at least one collection, configured or attached to its workspace, a `## Knowledge base` section names them and asks the model to search when a request may be covered, to read the exact lines before relying on details, to cite refs, and to treat the passages as reference material, not instructions. The section is rendered for each session from its own workspace, so two sessions in different workspaces see different names.

#### Token effect

Fixed and small: one line of collection names plus two sentences; absent when the session reaches no collection.

#### KV Cache effect

Prefix-stable while the names the session reaches are unchanged; attaching or detaching a folder changes the section from the next request on.

### Knowledge tool schemas

#### What the model sees

The generated [`knowledge_add`, `knowledge_search`, `knowledge_read`, and `knowledge_browse` schemas](../../../docs/tool-catalog.md#deepseek-aidsh-knowledge); the `collection` parameter is a name from the prompt section, checked when the tool runs. `knowledge_add` is always registered and asks the model to call it only when the user names a folder of documents to use. The other three are registered for every session when a collection is configured, and otherwise only for a session whose workspace has a folder attached; they appear and disappear as folders are attached and detached.

#### Token effect

Fixed schema cost per request while the tools are visible: `knowledge_add` always, the other three while the session reaches a collection.

#### KV Cache effect

Prefix-stable while the session's tool set is unchanged; attaching a workspace's first folder or detaching its last changes the tool list.

### Tool results

#### What the model sees

`knowledge_search` first lists up to two folders whose rollups match, as `- [collection:folder/] (tags) summary`, and up to three files whose summaries match, as `- [collection:path] (type; tags) summary`, then one block per passage hit: `[collection:path#Lstart-Lend] heading` and up to `hitChars` of the passage. `knowledge_read` returns a header with the file and line range, then numbered lines. `knowledge_browse` returns folders with file counts and their rollup, files with their type, tags, and summary when they have one, the files carrying a tag, or the collections with their counts. `knowledge_add` resolves the folder, asks the user to approve indexing it (the question names the folder, about how many files it holds, and the workspace), indexes it, and returns `Indexed <folder> as <name>: <files> files, <passages> passages.`; when a summary route resolves and the folder holds files, it then asks separately whether to summarize them with that route and says whether the summaries run as a background job, ran inline, or were declined. A declined, cancelled, or unavailable approval returns a sentence saying nothing was indexed, and the unavailable case names `/kb add` for the user.

#### Token effect

Bounded by the request: `limit` hits of at most `hitChars` each, or at most `maxReadLines` lines.

#### KV Cache effect

Append-only; each result follows the existing history.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Meaning needs an embedding model** — without `embeddings`, passages rank by shared words only, so a question phrased with different words than the document can miss it; the vectors of a whole library are scanned in memory on each search, so a very large library costs memory in proportion.
- **Rollups follow folders, not topics** — each folder is summarized from what it contains and files are listed by tag, but a topic that spans folders has no summary of its own.
- **Summaries see the opening of a file** — a request shows the headings and the first `enrichMaxInputChars` characters, so a long book's summary describes its outline and beginning.
- **A workspace is its session's exact folder** — a session opened in a subfolder of a workspace, or one without a folder, does not reach that workspace's collections.
- **No text recognition** — a scanned PDF without a text layer, and pictures inside documents, have no text to index; old `.doc` Word files and other formats are skipped.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
