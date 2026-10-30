# Skills

English | [中文](skills.zh.md)

The [skill capability family](../../packages/skill) includes the Service Definition ([dsh-skill](../../packages/skill/skill), `ctx.skills`), the local Service Provider ([dsh-skill-filesystem](../../packages/skill/skill-filesystem)), optional packaged providers ([dsh-skill-badge](../../packages/experimental/skill-badge), [dsh-skill-office](../../packages/skill/skill-office), and the Windows ACL diagnosis provider in [dsh-sandbox-windows-acl](../../packages/sandbox/sandbox-windows-acl)), the content record ([dsh-skill-lock](../../packages/skill/skill-lock), `ctx.skillLock`), and the Consumer ([dsh-tool-skill](../../packages/skill/tool-skill)). The registry merges provider catalogs across its host and per-scope layers; providers contribute local or packaged skills; the Consumer owns the initial and replacement catalogs plus the model-facing `skill` tool. Skills are optional instructions, not session events, so their vocabulary lives here rather than in [core.md](core.md).

Source: [`packages/skill/skill/src/index.ts`](../../packages/skill/skill/src/index.ts), [`packages/skill/skill-filesystem/src/index.ts`](../../packages/skill/skill-filesystem/src/index.ts), [`packages/experimental/skill-badge/src/index.ts`](../../packages/experimental/skill-badge/src/index.ts), [`packages/skill/skill-office/src/index.ts`](../../packages/skill/skill-office/src/index.ts), [`packages/sandbox/sandbox-windows-acl/src/acl-skill.ts`](../../packages/sandbox/sandbox-windows-acl/src/acl-skill.ts), [`packages/skill/skill-lock/src/index.ts`](../../packages/skill/skill-lock/src/index.ts), and [`packages/skill/tool-skill/src/index.ts`](../../packages/skill/tool-skill/src/index.ts).

## Provider registry

`ctx.skills` combines local, embedded, remote, or other providers. Registration is synchronous; remote initialization and discovery belong in awaited `list()`. Provider objects, options, and candidates are borrowed readonly, while semantic fields are validated.

The registry is host+per-scope layered, the shape the [tools registry](tools.md) established over [dsh-scope](../../packages/core/scope): a registration files into the layer of its calling context's scope, so host rows and repository plugins land in the global layer while a plugin mounted by an agent preset's standing composition lands in that preset's layer, and provider names are unique per layer rather than process-wide. A read merges the global layer with the viewing scope's chain — the nearest layer's entry wins a duplicate skill name outright, and the rank order below decides duplicates only within one layer. Discovery caches are keyed by the resolved scope chain, so re-parenting a scope (a blank-session recompose) is visible to the next read without a registry mutation.

Within one layer, duplicate names resolve by rank, provider order, then local order; summaries sort by name. A rejected `list()` is logged and omitted from an incomplete observation, while an explicit incomplete observation contributes usable candidates without making the result cacheable; malformed candidates fail fast. Each provider factory receives a registration-scoped control whose `invalidate()` clears completed catalogs only while that exact registration remains active and whose signal aborts on failed registration or disposal. An in-flight discovery retries once when its provider generation changes; a second change returns the latest candidates incomplete and uncached. Provider and runtime mutations emit the unfiltered `skills/change` invalidation event; it carries no diff, so consumers refetch `snapshot()` with their own lookup options.

An array returned by `SkillProvider.list()` is complete-discovery shorthand. `SkillProviderObservation` lets a provider expose candidates that remain directly loadable while reporting that the observation is not authoritative.

```ts type-equiv
/** Provider candidates plus whether the current discovery is authoritative. */
interface SkillProviderObservation {
  /** Candidates available from the current provider discovery. */
  readonly candidates: readonly SkillCandidate[]
  /** Whether discovery completed and these candidates may be cached. */
  readonly complete: boolean
}
```

```ts type-equiv
/** Provider interface for one source of skills, such as local directories or a remote registry. */
interface SkillProvider {
  /** Unique provider name in the `ctx.skills` registry. */
  readonly name: string
  /**
   * List available skill candidates for the current lookup context. Provider
   * plugins register synchronously during `apply()`; remote initialization,
   * authentication, and discovery are awaited inside this method. Implementations
   * should settle promptly when `options.signal` aborts.
   * @param options - lookup options; `cwd` selects workspace-sensitive skills and `signal` cancels work.
   * @returns provider candidates as a complete-array shorthand, or an explicit
   *   observation when usable candidates came from incomplete discovery.
   */
  readonly list: (options: SkillLookupOptions) => Promise<readonly SkillCandidate[] | SkillProviderObservation>
  /**
   * Load a complete skill body for a previously listed candidate.
   * @param candidate - the winning candidate originally returned by this provider.
   * @param options - lookup options; `cwd` selects workspace-sensitive skills and `signal` cancels work.
   * @returns the full skill body, or `undefined` if it is no longer loadable.
   */
  readonly get: (candidate: SkillCandidate, options: SkillLookupOptions) => Promise<SkillDefinition | undefined>
}
```

```ts type-equiv
/** Registration-scoped lifecycle and invalidation capability borrowed by one provider. */
interface SkillProviderControl {
  /** Aborts if registration fails or when the exact provider registration is disposed. */
  readonly signal: AbortSignal
  /** Invalidate completed catalogs and notify consumers only while the exact registration remains active. */
  readonly invalidate: () => void
}
```

## Local discovery priority

The shipped local provider scans roots in rank order:

| Rank | Source | Root |
|---|---|---|
| 100 | `project-dsh` | `<projectRoot>/.dsh/skills` |
| 200 | `project-agents` | `<projectRoot>/.agents/skills` |
| 300 | `custom` | `Config.customSkillDirs` |
| 400 | `user-dsh` | `<dshHome>/skills` |
| 500 | `user-agents` | `<agentsHome>/skills` |
| 600 | `bundled` | `Config.bundledSkillDir` when configured |

The project root is the nearest ancestor containing `.git`; without one, the current cwd is used. When `ctx.fs` is available, the git-root walk probes `.git` through the filesystem service so remote or sandboxed workspaces do not fall back to the host filesystem boundary. The user DSH root skips its `.system` child. The local provider does not synthesize built-in system skills; deployments supply packaged skills through configured bundled roots or dedicated providers. A failed root contributes no candidates, so a lower-priority same-name skill from another root may supply both the catalog description and loaded body until recovery.

`dsh-skill-badge` registers one immutable `bundled` candidate at `BUNDLED_SKILL_RANK` and exposes its packaged asset directory through `resourceBase`. The shipped CLI declares the plugin disabled, so enabling its composition row is an explicit opt-in.

Chokidar watches existing roots for direct bundle/flat-entry additions and removals plus direct skill-entry changes. A missing root is followed one absent path segment at a time from its nearest existing ancestor until Chokidar can attach. Resource files below a bundle are not catalog changes. Model-facing `write` and `edit` observations synchronously invalidate the provider when their target is catalog-relevant, while the host watcher covers IDE, Git, shell, and external-process mutations. Watcher failures make the current observation incomplete without hiding readable candidates from direct loads; project-scoped watchers use a configured bounded LRU.

## Skill identity

Skill names are kebab-case (`^[a-z0-9]+(?:-[a-z0-9]+)*$`). The local provider accepts directory bundles (`<name>/SKILL.md`) and flat Markdown files (`<name>.md`). Nested recursive `**/SKILL.md` discovery is not supported.

```ts type-equiv
/** Origin bucket for a skill contribution. The value is prompt-visible metadata, not precedence by itself. */
type SkillSource = 'project-dsh' | 'project-agents' | 'runtime' | 'user-dsh' | 'user-agents' | 'custom' | 'bundled' | (string & {})
```

## Summaries, candidates, and complete definitions

`SkillSummary` is the registry's invocation-neutral summary shape. Consumers choose which entries and fields to render; the model session catalog uses only model-invocable `name` and `description`, never the body or absolute file path. `SkillInvocationPolicy` normalizes the two independent invocation controls into positive booleans, and every resolved summary, candidate, and definition carries it without turning arbitrary frontmatter into the domain model.

```ts type-equiv
/** Invocation controls shared by skill discovery consumers. */
interface SkillInvocationPolicy {
  /** Whether model-facing catalogs and loaders include this skill. */
  readonly modelInvocable: boolean
  /** Whether human-facing command catalogs and loaders include this skill. */
  readonly userInvocable: boolean
}
```

```ts type-equiv
/** Invocation-neutral skill metadata returned by `ctx.skills.list()`. */
interface SkillSummary {
  /** Absolute instruction file path when supplied by the provider; absent for virtual skills. */
  readonly path?: string
  /** Kebab-case identifier used to address the skill. */
  readonly name: string
  /** Short routing description shown by discovery consumers. */
  readonly description: string
  /** Optional extra routing guidance. */
  readonly whenToUse?: string
  /** Resolved model and user invocation controls. */
  readonly invocation: SkillInvocationPolicy
  /** Discovery source that produced this winning skill. */
  readonly source: SkillSource
  /** Provider that owns this skill body. */
  readonly provider: string
  /** Provider-specific base for relative resources. */
  readonly resourceBase?: SkillResourceBase
}
```

`ctx.skills.list()` preserves all four policy combinations. `isModelInvocable(skill)` and `isUserInvocable(skill)` read the corresponding required field. A model-only skill sets `{ modelInvocable: true, userInvocable: false }`, a user-only skill sets `{ modelInvocable: false, userInvocable: true }`, and setting both fields to `false` keeps the skill available only through trusted `ctx.skills.get()` callers. The local provider reads the exact kebab-case frontmatter keys `disable-model-invocation` and `user-invocable`, defaults omitted fields to `true`, and projects every parsed skill into this normalized policy.

`SkillCatalogSnapshot` distinguishes authoritative absence from transient provider failure or a catalog that kept changing during discovery. `skills` contains the sorted invocation-neutral summaries collected in that observation; `complete` is true only when every registered provider completed without a concurrent catalog revision. Incomplete snapshots are not cached, so the next lookup retries discovery; each consumer decides how to present the partial result.

```ts type-equiv
/** One catalog observation plus whether discovery completed within a stable catalog revision. */
interface SkillCatalogSnapshot {
  /** Sorted invocation-neutral summaries collected in this observation. */
  readonly skills: SkillSummary[]
  /** Whether every registered provider completed without a concurrent catalog revision. */
  readonly complete: boolean
}
```

`SkillCandidate` is the provider-to-registry shape. `locator` is opaque provider state; the registry only stores it and gives it back to the winning provider's `get()`.

```ts type-equiv
/** Provider catalog entry used by the registry to merge and later load skills. */
interface SkillCandidate extends SkillSummary {
  /** Lower ranks win duplicate skill names before provider registration order is considered. */
  readonly rank: number
  /** Opaque provider-owned handle passed back to `provider.get()`. */
  readonly locator: unknown
  /** Parsed optional metadata object from provider-specific skill frontmatter. */
  readonly metadata?: Readonly<Record<string, unknown>>
}
```

`SkillDefinition` is the complete parsed result returned by `ctx.skills.get()` and used by the `skill` tool. `resourceBase` tells the tool how to render relative-resource guidance for local, URL, or provider-managed skills.

```ts type-equiv
/** Optional provider-specific base used by loaded skill bodies to resolve relative resources. */
type SkillResourceBase =
  | { readonly kind: 'directory'; readonly path: string }
  | { readonly kind: 'url'; readonly url: string }
  | { readonly kind: 'opaque'; readonly description: string }
```

```ts type-equiv
/** Complete parsed skill definition, including the body loaded by `ctx.skills.get()`. */
interface SkillDefinition extends SkillSummary {
  /** Markdown instruction body after any provider-specific metadata removal. */
  readonly content: string
  /** Parsed optional metadata object from frontmatter. */
  readonly metadata?: Readonly<Record<string, unknown>>
}
```

Runtime skill inputs may omit invocation controls and the provider label. The registry resolves both defaults once, then uses the same complete definition shape and first-wins collection order as providers. The returned disposer removes the contribution and invalidates discovery caches.

```ts type-equiv
/** Runtime skill contribution accepted by `ctx.skills.register()`. */
type SkillRegistration = Omit<SkillDefinition, 'invocation' | 'provider'> & {
  /** Invocation controls; omission permits both model and user surfaces. */
  readonly invocation?: SkillInvocationPolicy
  /** Provider label; omission uses the registry-owned runtime provider. */
  readonly provider?: string
}
```

## Lookup and configuration

Skill lookup is cwd-sensitive because providers may expose workspace-local skills, and its optional signal cancels provider work for the caller. Registry reads additionally take the viewing scope — consumers pass the calling agent, which is its own scope key — through `SkillViewOptions`; the registry consumes `scope` for layer selection, and providers read only their `SkillLookupOptions` contract from the same borrowed options object. Cancellation is checked before and after catalog selection, including cache hits, and races both discovery and full-definition loading. If no git root is found, the local provider treats the supplied cwd itself as the project root.

Full definitions are not cached by the registry. Each `get()` calls the winning provider with the selected candidate, so the local provider rereads the current body. A definition whose name no longer matches that candidate is rejected and invalidates the exact provider for rediscovery.

```ts type-equiv
/** Caller context used for cwd-sensitive and abortable provider work. */
interface SkillLookupOptions {
  /** Workspace selector for the current lookup. */
  readonly cwd?: string | undefined
  /** Abort discovery or loading work for the current caller. */
  readonly signal?: AbortSignal | undefined
}
```

```ts type-equiv
/**
 * Registry read options: provider lookup context plus the viewing scope.
 * The registry consumes `scope` to select layers; providers receive the same
 * borrowed options object and read only their {@link SkillLookupOptions}
 * contract from it.
 */
interface SkillViewOptions extends SkillLookupOptions {
  /** Viewing scope (the calling agent); omitted reads the global layer alone. */
  readonly scope?: ScopeKey | undefined
}
```

The registry owns only its discovery-cache bound. The local provider owns filesystem roots (`dshHome`, `agentsHome`, `customSkillDirs`, and optional `bundledSkillDir`/`DSH_BUNDLED_SKILL_DIR`) plus watcher enablement, polling, stability, symlink, and project-capacity controls. The consumer owns its catalog description bound. Exact defaults and validation are in the generated [config catalog](../config-catalog.md).

```ts type-equiv
/** Skill registry configuration. */
interface Config {
  /** Maximum number of completed cwd/provider catalogs kept in memory. */
  readonly collectCacheMaxEntries?: number
}
```

## Session catalog and tool contract

`dsh-tool-skill` injects the initial durable user-role `<system-reminder>` at the first `agent/pre-step` of a live session that observes available skills or incomplete discovery. The catalog contains sorted skill `name` and normalized, XML-escaped `description` only; it omits bodies, paths, sources, providers, and routing hints. Discovery forwards the step's abort signal through `SkillLookupOptions`. `catalogDescriptionMaxLength` is the consumer config for the description bound, with default `500` and integer minimum `3`.

Before each later model step, the consumer applies exact tool visibility and compares the entries and completeness with the newest recognizable visible catalog message in the session log. A changed observation contributes a durable replacement to the pre-step decision; deleting every skill appends an explicit empty replacement. Incomplete discovery publishes the available subset with a warning and optional `incomplete: true` source metadata; absence of that flag means complete. Recovery republishes the catalog even when its entries are unchanged. If compaction hides every historical catalog message, the next observation re-establishes the current catalog; a complete empty view with no prior catalog emits nothing. These catalog messages are session history, not World State.

The model-facing `skill({ name })` tool validates the kebab-case name, finds the summary in the invocation-neutral catalog, rejects it before loading unless `isModelInvocable` permits access, then rereads the complete definition for the calling agent cwd and rechecks the policy before returning content. It reports an unresolved skill as unknown or no longer available and returns a tool result containing `<skill_content name="...">`, `<skill_resources>`, and `<skill_instructions>`. `resourceBase` resolves explicitly referenced scripts, references, and assets only as needed; the loaded result does not enumerate a skill directory. Body-only edits therefore change later tool calls without producing catalog messages or rewriting earlier tool results.

## Browser Session catalog

`SkillListRequest` addresses one Session by `sessionId`; `SkillListValue` returns the user-invocable entries with name, description, optional usage guidance, and model-invocation availability. `SessionSkillCatalog` reads the Session cwd and recorded preset without activating an Agent. A live Agent may supply its scoped registry, while a cold Session uses the preset's standing scope.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxknowledge--knowledgeindex"></a>

### `ctx.knowledge` — `KnowledgeIndex`

The knowledge index over the configured collections.

```ts cordis-catalog
/**
 * Replace the collections this index keeps. A pass already running
 * finishes over the previous list; the next pass indexes the new list and
 * removes the files of a collection no longer in it.
 * @param collections - the new list.
 * @throws when the index was opened without collections, so without a database.
 */
setCollections(collections: readonly KnowledgeCollection[]): void

/**
 * Wait for the pass in progress, when there is one.
 * @returns resolution once no pass runs; a failed pass resolves it too.
 */
idle(): Promise<void>

/** Close the database. */
close(): void

/**
 * Bring the index up to date with the files on disk. Concurrent calls share one pass.
 * @param signal - stops the pass between files.
 * @param only - index just this collection.
 * @returns counts for the pass.
 */
update(signal?: AbortSignal, only?: string): Promise<KnowledgeIndexReport>

/**
 * Files that have no summary yet, oldest first.
 * @param limit - most files to return.
 * @param collection - only this collection.
 * @returns the waiting files.
 */
pendingSummaries(limit: number, collection?: string): KnowledgePendingFile[]

/**
 * Count files that have no summary yet.
 * @param collection - only this collection.
 * @returns the count.
 */
pendingCount(collection?: string): number

/**
 * The text an enrichment request shows for one file: its section headings and its opening passages.
 * @param fileId - the file.
 * @param maxChars - most characters of passage text.
 * @returns the heading outline and the text, both empty for an unknown file.
 */
summaryInput(fileId: number, maxChars: number): { headings: string[]; text: string }

/**
 * Store a file's summary, replacing any earlier one. A file that no longer exists is ignored.
 * @param fileId - the file.
 * @param summary - its type, tags, and summary.
 * @param model - the `provider/model` that wrote it.
 * @returns whether the summary was stored.
 */
saveSummary(fileId: number, summary: KnowledgeFileSummary, model: string): boolean

/**
 * Rank file summaries against free text.
 * @param request - the query, optional collection, and limit.
 * @returns matching files, best first.
 */
searchSummaries(request: { query: string; collection?: string; limit: number }): KnowledgeSummaryHit[]

/**
 * Files of a collection that carry a topic tag, with their summaries.
 * @param collection - the collection.
 * @param tag - the tag.
 * @param limit - most files to return.
 * @returns the files, in path order.
 */
filesWithTag(collection: string, tag: string, limit: number): KnowledgeBrowseEntry[]

/**
 * Rank passages against free text.
 * @param request - the query, optional filters, and limit.
 * @returns hits, best first; empty when the query has no meaningful word.
 */
search(request: KnowledgeSearchRequest): KnowledgeHit[]

/**
 * Rank passages by words and, when embeddings are configured and stored, by meaning, merged by
 * reciprocal rank fusion. A failed embedding request falls back to the word ranking.
 * @param request - the query, optional filters, and limit.
 * @param signal - cancellation of the query embedding.
 * @returns hits, best first, and whether the ranking used meaning.
 */
async searchHybrid(request: KnowledgeSearchRequest, signal: AbortSignal): Promise<{ hits: KnowledgeHit[]; semantic: boolean }>

/**
 * Count stored passage vectors.
 * @returns the count; 0 without a database.
 */
vectorCount(): number

/**
 * Count passages that have no vector yet.
 * @param collection - only this collection.
 * @returns the count.
 */
pendingVectorCount(collection?: string): number

/**
 * Embed up to `limit` passages that have no vector, `batchSize` per request.
 * @param limit - most passages to embed.
 * @param signal - stops the run between batches.
 * @param collection - only this collection.
 * @returns passages embedded, batches that failed, and passages still waiting.
 * @throws when no embedding endpoint is configured.
 */
async embedPassages( limit: number, signal: AbortSignal, collection?: string, ): Promise<{ embedded: number; failed: number; remaining: number }>

/**
 * Read a slice of one file under a collection, from disk.
 * @param collection - the collection name.
 * @param path - the file path relative to the collection root.
 * @param startLine - first line, 1-based (default 1).
 * @param endLine - last line, inclusive; bounded by `maxReadLines`.
 * @returns the slice and the file's line count.
 * @throws for an unknown collection, a path outside the root, or a missing file.
 */
async read(collection: string, path: string, startLine: number = 1, endLine?: number): Promise<KnowledgeRead>

/**
 * List the folders and files directly under a folder of a collection.
 * @param collection - the collection name.
 * @param prefix - folder path relative to the root; empty for the root.
 * @returns folders first, then files, each with its file count.
 */
browse(collection: string, prefix: string = ''): KnowledgeBrowseEntry[]

/**
 * Folders whose rollup is missing or stale, deepest first: every folder (the root included)
 * with at least `minChildren` direct children that have a summary or a rollup.
 * @param minChildren - fewest summarized children a folder needs.
 * @param collection - only this collection.
 * @returns the folders with their children's summary lines.
 */
staleFolders(minChildren: number, collection?: string): KnowledgeFolderInput[]

/**
 * Store a folder's rollup, replacing any earlier one.
 * @param input - the folder and the fingerprint its rollup was written from.
 * @param rollup - its tags and summary.
 * @param model - the `provider/model` that wrote it.
 */
saveFolder(input: Pick<KnowledgeFolderInput, 'collection' | 'folder' | 'fingerprint'>, rollup: { tags: readonly string[]; summary: string }, model: string): void

/**
 * Rank folder rollups against free text.
 * @param request - the query, optional collection, and limit.
 * @returns matching folders, best first.
 */
searchFolders(request: { query: string; collection?: string; limit: number }): KnowledgeFolderHit[]

/**
 * A folder's rollup, when it has one.
 * @param collection - the collection.
 * @param folder - folder path relative to the root; empty for the root.
 * @returns its tags and summary.
 */
folderSummary(collection: string, folder: string): { tags: readonly string[]; summary: string } | undefined

/**
 * Counts per configured collection.
 * @returns one entry per configured collection, in configuration order.
 */
stats(): KnowledgeCollectionStats[]
```

Source: [`packages/learning/knowledge/src/store.ts`](../../packages/learning/knowledge/src/store.ts)

<a id="ctxknowledgeworkspaces--workspaceknowledge"></a>

### `ctx.knowledgeWorkspaces` — `WorkspaceKnowledge`

The collections attached to each workspace, and their indexes.

```ts cordis-catalog
/**
 * Watch every workspace's collection list.
 * @param listener - called with the workspace folder after a folder is attached or detached; it must not throw.
 * @returns the disposer that ends the watch.
 */
watch(listener: (cwd: string) => void): () => void

/**
 * Count the files a pass over a folder would read, before it is attached.
 * @param root - the absolute folder.
 * @param signal - stops the walk.
 * @returns an upper bound, since file sizes are not checked.
 */
countFiles(root: string, signal?: AbortSignal): Promise<number>

/**
 * The route that would summarize a workspace collection: the deployment's route when it names one, else the session's.
 * @param session - the session's current route, when it has one.
 * @returns the route, or `undefined` when neither exists.
 */
summaryRoute(session: SummaryRoute | undefined): SummaryRoute | undefined

/**
 * Summarize a workspace collection's waiting files and roll its folders up.
 * @param cwd - the workspace folder.
 * @param name - the collection name.
 * @param route - the route that writes the summaries.
 * @param signal - stops the run after the requests in flight.
 * @returns how many files were summarized, and the run's report.
 * @throws when the workspace has no collection of that name.
 */
async summarize(cwd: string, name: string, route: SummaryRoute, signal: AbortSignal): Promise<{ summarized: number; text: string }>

/**
 * The workspaces opened so far.
 * @returns their entries.
 */
list(): WorkspaceKnowledgeEntry[]

/**
 * Open a workspace's index when it has collections; later calls return the same entry.
 * @param cwd - the workspace folder.
 * @returns the entry, or `undefined` when no folder is attached.
 * @throws when the collection list file is invalid.
 */
open(cwd: string): Promise<WorkspaceKnowledgeEntry | undefined>

/**
 * Attach a folder to a workspace and index it.
 * @param cwd - the workspace folder.
 * @param path - the folder as written: absolute, relative to the workspace, or under `~`.
 * @param name - the collection name; derived from the folder's name when omitted.
 * @param signal - stops the first pass.
 * @returns the new collection, the first pass's counts, and the files and passages the collection holds after it.
 * @throws when the folder is invalid or already attached, or the name is invalid or taken.
 */
add(cwd: string, path: string, name: string | undefined, signal?: AbortSignal): Promise<WorkspaceAddResult>

/**
 * Detach a folder from a workspace and drop its files from the index.
 * @param cwd - the workspace folder.
 * @param name - the collection name.
 * @returns the counts of the pass that dropped the files.
 * @throws when the workspace has no collection of that name.
 */
remove(cwd: string, name: string): Promise<KnowledgeIndexReport>

/**
 * Close every workspace index once its pass in progress ends.
 * @returns resolution after the indexes close.
 */
async close(): Promise<void>
```

Source: [`packages/learning/knowledge/src/workspace.ts`](../../packages/learning/knowledge/src/workspace.ts)

<a id="ctxlearning--learningservice"></a>

### `ctx.learning` — `LearningService`

The `ctx.learning` service: the promotion path `/learn skill` and the Web card share.

```ts cordis-catalog
/**
 * Write one memory entry as `<skillsRoot>/<name>/SKILL.md`, register it live when a skill
 * registry is mounted, and mark the entry `promoted`.
 * @param id - the memory entry to promote.
 * @param name - the skill name: lowercase letters, digits, and single hyphens.
 * @returns the written skill file path.
 * @throws when the entry is unknown or the name is invalid.
 */
promote(id: MemoryEntryId, name: string): Promise<string>

/**
 * Write several entries as one `<skillsRoot>/<name>/SKILL.md`, register it live when a skill
 * registry is mounted, and mark every entry `promoted`.
 * @param ids - the memory entries to promote together, in the order they appear in the skill.
 * @param name - the skill name: lowercase letters, digits, and single hyphens.
 * @returns the written skill file path.
 * @throws when an entry is unknown, the list is empty, or the name is invalid.
 */
promoteMany(ids: readonly MemoryEntryId[], name: string): Promise<string>

/**
 * List the skills under the skills root, the ones `/learn` wrote from memory or documents.
 * @returns skills sorted by name.
 */
skills(): Promise<LearningSkillView[]>

/**
 * Read one skill's `SKILL.md`.
 * @param name - the skill name.
 * @returns the file contents, or `undefined` when no such skill exists.
 */
readSkill(name: string): Promise<string | undefined>

/**
 * Replace one skill's `SKILL.md` and re-register it live when a skill registry is mounted.
 * @param name - the skill name.
 * @param content - the complete file contents.
 * @returns the written path.
 * @throws when the name is invalid or the content is blank.
 */
writeSkill(name: string, content: string): Promise<string>

/**
 * Delete one skill directory and drop its live registration.
 * @param name - the skill name.
 * @returns whether a skill existed.
 */
deleteSkill(name: string): Promise<boolean>
```

Source: [`packages/learning/learning/src/types.ts`](../../packages/learning/learning/src/types.ts)

<a id="ctxlearningcontroller--learningcontroller"></a>

### `ctx.learningController` — `LearningController`

Host service backing the generated `ctx.remote.learning` namespace.

```ts cordis-catalog
/**
 * Read the candidates awaiting review and the entries the model recalls.
 * @returns both lists, oldest first.
 */
@Remote('list') list(): Promise<LearningSnapshot>

/**
 * Run the configured curation once.
 * @returns what changed.
 */
@Remote('curate') curate(): Promise<LearningCurateValue>

/**
 * Approve or reject one candidate.
 * @param request - the entry and the decision.
 * @returns the updated entry.
 */
@Remote('review') async review(request: LearningReviewRequest): Promise<LearningEntryView>

/**
 * Edit one entry's text or tags in place.
 * @param request - the entry and the fields to replace.
 * @returns the updated entry.
 */
@Remote('update') async update(request: LearningUpdateRequest): Promise<LearningEntryView>

/**
 * Delete one entry.
 * @param request - the entry to delete.
 * @returns whether an entry existed.
 */
@Remote('forget') async forget(request: LearningForgetRequest): Promise<LearningForgetValue>

/**
 * List the skills the learning plugin wrote.
 * @returns skills sorted by name.
 */
@Remote('skills') async skills(): Promise<LearningSkillsValue>

/**
 * Read one skill file.
 * @param request - the skill name.
 * @returns the contents, or `null` when the skill does not exist.
 */
@Remote('readSkill') async readSkill(request: LearningReadSkillRequest): Promise<LearningReadSkillValue>

/**
 * Replace one skill file and re-register it live.
 * @param request - the skill name and its complete contents.
 * @returns the written path.
 */
@Remote('writeSkill') async writeSkill(request: LearningWriteSkillRequest): Promise<LearningWriteSkillValue>

/**
 * Delete one skill.
 * @param request - the skill name.
 * @returns whether a skill existed.
 */
@Remote('deleteSkill') async deleteSkill(request: LearningDeleteSkillRequest): Promise<LearningDeleteSkillValue>

/**
 * Read the skill suggestions awaiting a decision.
 * @returns proposed suggestions with their entries, oldest first.
 */
@Remote('suggestions') suggestions(): Promise<LearningSuggestionsValue>

/**
 * Promote a suggestion's entries together as one skill and mark it accepted.
 * @param request - the suggestion and an optional skill name.
 * @returns the written skill file path and the name used.
 */
@Remote('acceptSuggestion') async acceptSuggestion(request: LearningAcceptSuggestionRequest): Promise<LearningAcceptSuggestionValue>

/**
 * Dismiss a suggestion so the curator does not propose that cluster again.
 * @param request - the suggestion to dismiss.
 * @returns the dismissed suggestion.
 */
@Remote('dismissSuggestion') async dismissSuggestion(request: LearningDismissSuggestionRequest): Promise<LearningSuggestionView>

/**
 * Write one entry as a skill and mark it promoted.
 * @param request - the entry and the skill name.
 * @returns the written skill file path.
 */
@Remote('promote') async promote(request: LearningPromoteRequest): Promise<LearningPromoteValue>
```

Source: [`packages/api/learning-controller/src/index.ts`](../../packages/api/learning-controller/src/index.ts)

<a id="ctxmemory--memorystore"></a>

### `ctx.memory` — `MemoryStore`

The `ctx.memory` service: durable entries plus the operations every consumer shares.

```ts cordis-catalog
/**
 * Store a new entry, unless {@link findDuplicate} finds the same note: then
 * that entry takes the new wording and the joined tags (a stale one turns
 * approved again when `status` is `approved`), and a rejected one is
 * returned unchanged.
 * @param input - text, kind, and tags.
 * @param status - initial review state of a new entry.
 * @param sourceSessionId - session whose work produced the entry.
 * @returns the stored entry, new or restated.
 */
add(input: MemoryEntryInput, status: MemoryEntryStatus, sourceSessionId?: SessionId): Promise<MemoryEntry>

/**
 * The stored entry that is the same note as a text: the most similar entry
 * that is not archived whose note similarity reaches the duplicate threshold.
 * @param text - the note text.
 * @returns the entry, or `undefined` when no stored entry is the same note.
 */
findDuplicate(text: string): MemoryEntry | undefined

/**
 * Read one entry.
 * @param id - the entry id.
 * @returns the entry, or `undefined` when unknown.
 */
get(id: MemoryEntryId): MemoryEntry | undefined

/**
 * List entries, oldest first.
 * @param filter - optional status filter.
 * @returns the matching entries.
 */
list(filter?: MemoryListFilter): MemoryEntry[]

/**
 * Case-insensitive substring search over text and tags of searchable entries.
 * @param query - the search text.
 * @returns approved, promoted, and stale entries whose text or a tag contains the query.
 */
search(query: string): MemoryEntry[]

/**
 * Change an entry's review state.
 * @param id - the entry id.
 * @param status - the new state.
 * @returns the updated entry.
 * @throws when the id is unknown.
 */
setStatus(id: MemoryEntryId, status: MemoryEntryStatus): Promise<MemoryEntry>

/**
 * Rewrite an entry's text or tags in place; identity, kind, status, and source tags stay.
 * @param id - the entry id.
 * @param patch - the fields to replace; an omitted field keeps its value.
 * @returns the updated entry.
 * @throws when the id is unknown or the new text is blank.
 */
update(id: MemoryEntryId, patch: MemoryEntryPatch): Promise<MemoryEntry>

/**
 * Delete an entry.
 * @param id - the entry id.
 * @returns whether an entry was deleted.
 */
forget(id: MemoryEntryId): Promise<boolean>

/**
 * The entries the model is shown, oldest first.
 * @returns approved and promoted entries.
 */
recalled(): MemoryEntry[]

/**
 * Stamp usage on one entry; `lastRecalledAt` also increments `recallCount`.
 * @param id - the entry id.
 * @param touch - the usage fields to set.
 * @returns the updated entry, or `undefined` when unknown.
 */
touch(id: MemoryEntryId, touch: MemoryTouch): Promise<MemoryEntry | undefined>

/**
 * Run the configured aging and duplicate policy once, then propose skills for clusters of recalled entries.
 * @returns what changed.
 * @throws when no policy is configured.
 */
curate(): Promise<MemoryCurationReport>

/**
 * List skill suggestions, oldest first.
 * @param filter - optional status filter.
 * @returns the matching suggestions.
 */
suggestions(filter?: MemorySuggestionFilter): MemorySuggestion[]

/**
 * Read one suggestion.
 * @param id - the suggestion id.
 * @returns the suggestion, or `undefined` when unknown.
 */
getSuggestion(id: MemorySuggestionId): MemorySuggestion | undefined

/**
 * Change a suggestion's review state.
 * @param id - the suggestion id.
 * @param status - the new state.
 * @returns the updated suggestion.
 * @throws when the id is unknown.
 */
setSuggestionStatus(id: MemorySuggestionId, status: MemorySuggestionStatus): Promise<MemorySuggestion>
```

Types: [SessionId](core.md)

Source: [`packages/learning/memory/src/types.ts`](../../packages/learning/memory/src/types.ts)

<a id="ctxsessionskillcatalog--sessionskillcatalog"></a>

### `ctx.sessionSkillCatalog` — `SessionSkillCatalog`

Host service backing `ctx.remote.skills` without activating a cold Agent.

```ts cordis-catalog
/**
 * List the user-invocable skills visible to one Session composition.
 * @param request - Session identity whose cwd and preset select the catalog view.
 * @param signal - caller lifetime carried by the Remote transport; admitted catalog reads retain their existing completion semantics.
 * @returns user-invocable skill metadata without loading skill bodies.
 * @throws RemoteError when the Session cannot be inspected or no registry can serve it.
 */
@Remote async list(request: SkillListRequest, signal: AbortSignal): Promise<SkillListValue>
```

Source: [`packages/api/session-controller/src/skill-catalog.ts`](../../packages/api/session-controller/src/skill-catalog.ts)

<a id="ctxskilllock--skilllockservice"></a>

### `ctx.skillLock` — `SkillLockService`

The `ctx.skillLock` service: records what a skill looked like, and reports drift.

```ts cordis-catalog
/**
 * Absolute path of the lockfile for one workspace.
 * @param cwd - workspace directory the lockfile belongs to.
 * @returns the resolved lockfile path.
 */
path(cwd: string): string

/**
 * Compare every discoverable skill, and every record, against the lockfile.
 * @param cwd - workspace directory selecting project skill roots.
 * @param signal - cancels discovery and file reads.
 * @returns one entry per skill or orphaned record, sorted by name.
 */
status(cwd: string, signal?: AbortSignal): Promise<SkillLockStatusEntry[]>

/**
 * Record the current state of every discoverable skill, or of the named ones.
 * @param cwd - workspace directory selecting project skill roots.
 * @param names - skills to record; omitted records every discoverable skill.
 * @param signal - cancels discovery and file reads.
 * @returns the names recorded and the requested names that matched nothing.
 */
lock(cwd: string, names?: readonly string[], signal?: AbortSignal): Promise<SkillLockResult>

/**
 * Remove one skill's record.
 * @param cwd - workspace directory selecting the lockfile.
 * @param name - skill to forget.
 * @returns whether a record was removed.
 */
unlock(cwd: string, name: string): Promise<boolean>
```

Source: [`packages/skill/skill-lock/src/types.ts`](../../packages/skill/skill-lock/src/types.ts)

<a id="ctxskills--skillregistry"></a>

### `ctx.skills` — `SkillRegistry`

Layered registry of skill providers, the host+per-scope shape the tools registry established. A registration files into the layer of its calling context's scope (scopeOf): host rows and repository plugins land in the global layer, while a plugin mounted by an agent preset's standing composition lands in that preset's layer. A read merges the global layer with the viewing scope's chain — the nearest layer's entry wins a duplicate name outright, and the rank order decides duplicates only within one layer. It exposes sorted invocation-neutral summaries and loads full skill bodies on demand.

```ts cordis-catalog
/**
 * Register a borrowed same-process provider synchronously during plugin
 * apply, into the calling context's layer: a scoped context (an agent
 * preset's standing mount) registers for that scope alone, an unscoped
 * context registers globally. Duplicate names within one layer and reserved
 * names throw; remote initialization belongs in `list()`. Fiber disposal
 * unregisters the provider and invalidates catalog caches.
 * @param create - synchronous factory receiving this registration's lifecycle and invalidation control.
 * @returns the exact Cordis effect disposer that unregisters this provider;
 *   composite effects may yield it directly to preserve teardown ordering.
 */
registerProvider(create: (control: SkillProviderControl) => SkillProvider): () => void

/**
 * Register a borrowed readonly runtime skill into the calling context's
 * layer. Project entries outrank runtime entries, which outrank user
 * entries, within one layer. Same-name runtime entries in one layer are
 * first-wins; a duplicate logs a warning and receives a no-op disposer so
 * it cannot remove the winner.
 * @param skill - the skill definition input; omitted invocation and provider fields receive defaults.
 * @returns the exact Cordis effect disposer, preserving composite teardown order and invalidating caches.
 */
register(skill: SkillRegistration): () => void

/**
 * List invocation-neutral skill summaries for a workspace. Consumers apply
 * model or user invocation policy at their operational boundary. Lookup
 * options and provider candidates are readonly same-process values borrowed
 * throughout discovery.
 * @param options - view options; `scope` selects the viewing agent's layers, `cwd` selects project roots, and `signal` cancels discovery.
 * @returns all sorted winning summaries.
 */
async list(options: SkillViewOptions = {}): Promise<SkillSummary[]>

/**
 * Observe the current invocation-neutral catalog and whether discovery completed within a stable revision.
 * Incomplete observations are never cached, allowing consumers to retain last-good state and
 * retry on their next request boundary.
 * @param options - view options; `scope` selects the viewing agent's layers, `cwd` selects project roots, and `signal` cancels discovery.
 * @returns sorted summaries plus discovery-completeness state.
 */
async snapshot(options: SkillViewOptions = {}): Promise<SkillCatalogSnapshot>

/**
 * Load and validate the winning candidate, passing its opaque discovery locator back to the
 * provider. Cancellation is rechecked after selection, including cache hits, and raced against
 * loading so an uncooperative provider cannot hang the caller.
 * @param name - kebab-case skill name.
 * @param options - view options; `scope` selects the viewing agent's layers,
 *   `cwd` selects workspace-sensitive skills, and `signal` cancels work.
 * @returns the full skill, including body content, or `undefined`.
 */
async get(name: string, options: SkillViewOptions = {}): Promise<SkillDefinition | undefined>
```

Source: [`packages/skill/skill/src/index.ts`](../../packages/skill/skill/src/index.ts)

<a id="skills-events"></a>

### `skills/*` events

<a id="skillschange--emit"></a>

#### `skills/change` — emit

A skill provider, runtime contribution, or provider-backed catalog may have changed. This is an unfiltered invalidation notification; consumers refetch the catalog for their own lookup options. Listener failures are contained and cannot veto the registry mutation.

```ts cordis-catalog
/**
 * A skill provider, runtime contribution, or provider-backed catalog may
 * have changed. This is an unfiltered invalidation notification; consumers
 * refetch the catalog for their own lookup options. Listener failures are
 * contained and cannot veto the registry mutation.
 * @mode emit
 */
'skills/change'(): void
```

Source: [`packages/skill/skill/src/index.ts`](../../packages/skill/skill/src/index.ts)
<!-- END GENERATED cordis-surface -->
