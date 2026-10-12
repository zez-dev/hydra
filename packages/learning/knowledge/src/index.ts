/**
 * Document knowledge base. The plugin opens a SQLite full-text index over the
 * configured collection folders, publishes it as `ctx.knowledge`, brings it up
 * to date in the background at activation, and registers the human `/kb`
 * command; the model-facing search, read, and browse tools ship as the
 * `./tools` entry. Named exports preserve Loader injection metadata.
 * @module @deepseek-ai/dsh-knowledge
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
// Type-only: makes the optional LLM runtime available to `ctx.get()`; job.ts does the same for the job registry.
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { enrichFiles, rollupFolders, type EnrichOptions, type KnowledgeRollupReport } from './enrich.ts'
import { startKnowledgeJob } from './job.ts'
import { KnowledgeIndex } from './store.ts'
import type { KnowledgeCollection, KnowledgeEnrichReport, KnowledgeHit, KnowledgeIndexReport } from './types.ts'
import { assertCollections, mergeRanked, WorkspaceKnowledge, type WorkspaceKnowledgeEntry } from './workspace.ts'

export type * from './types.ts'
export { KnowledgeIndex, matchExpression, parseRef } from './store.ts'
export { chunkFile, kindOf } from './chunk.ts'
export { ENRICH_SYSTEM, enrichFiles, enrichPrompt, FOLDER_SYSTEM, folderPrompt, KNOWLEDGE_FILE_TYPES, parseSummary, rollupFolders } from './enrich.ts'
export type { KnowledgeRollupReport } from './enrich.ts'
export { embedTexts, fuse, nearest, quantize } from './embed.ts'
export type { EmbeddingConfig } from './embed.ts'
export { COLLECTION_NAME, mergeRanked, resolveRoot, WORKSPACE_KNOWLEDGE_FOLDER, WorkspaceKnowledge } from './workspace.ts'
export type { SummaryRoute, WorkspaceAddResult, WorkspaceKnowledgeEntry, WorkspaceKnowledgeHooks } from './workspace.ts'
export { startKnowledgeJob } from './job.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Document knowledge base over the configured collections; provided by `dsh-knowledge`. */
    knowledge: KnowledgeIndex
    /** Collections attached to each workspace and their indexes; provided by `dsh-knowledge`. */
    knowledgeWorkspaces: WorkspaceKnowledge
  }
}

export const name = 'knowledge'
export const inject = ['commands']

/** Knowledge base configuration. */
export interface Config {
  /** Index database file; `:memory:` keeps it for the process only. */
  path: string
  /** Folders to index, each under a short name used in citations and filters. */
  collections: KnowledgeCollection[]
  /** Folder names skipped anywhere under a root. */
  excludeDirs?: string[]
  /** Text files larger than this many bytes are skipped (default 4 MiB). */
  maxFileBytes?: number
  /** PDF, Word, and EPUB files larger than this many bytes are skipped (default 64 MiB). */
  maxDocumentBytes?: number
  /** Characters a passage grows to before a paragraph break may end it (default 2400). */
  targetChars?: number
  /** Characters at which a passage ends even without a break (default 4800). */
  maxChars?: number
  /** Characters of passage text one search hit carries (default 1500). */
  hitChars?: number
  /** Most lines one read returns (default 300). */
  maxReadLines?: number
  /** Bring the index up to date in the background when the plugin starts (default true). */
  indexOnStart?: boolean
  /** Seconds between background passes that pick up new and changed files; 0 runs only at start (default 900). */
  reindexIntervalSeconds?: number
  /** Provider of the route that writes file summaries; with `enrichModel`, or neither to use the invoking session's route. */
  enrichProvider?: string
  /** Model of the route that writes file summaries. */
  enrichModel?: string
  /** Summary requests in flight at once (default 2). */
  enrichConcurrency?: number
  /** Characters of file text one summary request shows (default 6000). */
  enrichMaxInputChars?: number
  /** Output cap of one summary request (default 1024). */
  enrichMaxTokens?: number
  /** Milliseconds one summary request may take (default 180000). */
  enrichTimeoutMs?: number
  /**
   * Summarize new and changed files and roll folders up after each background pass, when
   * `enrichProvider` and `enrichModel` are set (default true).
   */
  autoEnrich?: boolean
  /** An OpenAI-compatible embedding endpoint; set it to rank passages by meaning as well as by words. */
  embeddings?: {
    /** Base URL of the OpenAI-compatible API, such as `http://gpu-box:8000/v1`. */
    baseURL: string
    /** Embedding model id the endpoint serves. */
    model: string
    /** Environment variable holding the API key, when the endpoint needs one. */
    apiKeyEnv?: string
    /** Requested vector size, for models that can shorten their vectors. */
    dimensions?: number
    /** Passages sent per request (default 32). */
    batchSize?: number
    /** Milliseconds one request may take (default 60000). */
    timeoutMs?: number
  } | undefined
  /** Embed new passages after each background pass, when `embeddings` is set (default true). */
  autoEmbed?: boolean
  /**
   * After summarizing files, write a rollup for each folder with at least this many summarized
   * children; 0 turns rollups off (default 2).
   */
  folderRollupMinChildren?: number
}

/** Folder names skipped when `excludeDirs` is not configured. */
const DEFAULT_EXCLUDE_DIRS = ['.git', '.hg', '.svn', 'node_modules', '.venv', 'venv', '__pycache__', '.cache', '.idea', '.vscode', '.dsh']
const DEFAULT_MAX_FILE_BYTES = 4 * 1024 * 1024
const DEFAULT_MAX_DOCUMENT_BYTES = 64 * 1024 * 1024
const DEFAULT_TARGET_CHARS = 2400
const DEFAULT_MAX_CHARS = 4800
const DEFAULT_HIT_CHARS = 1500
const DEFAULT_MAX_READ_LINES = 300
const DEFAULT_REINDEX_INTERVAL_SECONDS = 900
const DEFAULT_ENRICH_CONCURRENCY = 2
const DEFAULT_ENRICH_MAX_INPUT_CHARS = 6000
const DEFAULT_ENRICH_MAX_TOKENS = 1024
const DEFAULT_ENRICH_TIMEOUT_MS = 180_000
const DEFAULT_FOLDER_ROLLUP_MIN_CHILDREN = 2
const DEFAULT_EMBED_BATCH_SIZE = 32
const DEFAULT_EMBED_TIMEOUT_MS = 60_000
/** Files one `/kb enrich` summarizes unless `--limit` says otherwise. */
const DEFAULT_ENRICH_LIMIT = 500

/** Schemastery configuration schema. */
export const Config: z<Config> = z.object({
  path: z.string().required(),
  collections: z.array(z.object({
    name: z.string().required(),
    root: z.string().required(),
  })).default([]),
  excludeDirs: z.array(z.string()).default([...DEFAULT_EXCLUDE_DIRS]),
  maxFileBytes: z.natural().min(1).default(DEFAULT_MAX_FILE_BYTES),
  maxDocumentBytes: z.natural().min(1).default(DEFAULT_MAX_DOCUMENT_BYTES),
  targetChars: z.natural().min(200).default(DEFAULT_TARGET_CHARS),
  maxChars: z.natural().min(400).default(DEFAULT_MAX_CHARS),
  hitChars: z.natural().min(100).default(DEFAULT_HIT_CHARS),
  maxReadLines: z.natural().min(1).default(DEFAULT_MAX_READ_LINES),
  indexOnStart: z.boolean().default(true),
  reindexIntervalSeconds: z.natural().default(DEFAULT_REINDEX_INTERVAL_SECONDS),
  enrichProvider: z.string(),
  enrichModel: z.string(),
  enrichConcurrency: z.natural().min(1).default(DEFAULT_ENRICH_CONCURRENCY),
  enrichMaxInputChars: z.natural().min(200).default(DEFAULT_ENRICH_MAX_INPUT_CHARS),
  enrichMaxTokens: z.natural().min(64).default(DEFAULT_ENRICH_MAX_TOKENS),
  enrichTimeoutMs: z.natural().min(1000).default(DEFAULT_ENRICH_TIMEOUT_MS),
  autoEnrich: z.boolean().default(true),
  folderRollupMinChildren: z.natural().default(DEFAULT_FOLDER_ROLLUP_MIN_CHILDREN),
  embeddings: z.union([z.object({
    baseURL: z.string().required(),
    model: z.string().required(),
    apiKeyEnv: z.string(),
    dimensions: z.natural().min(1),
    batchSize: z.natural().min(1).default(DEFAULT_EMBED_BATCH_SIZE),
    timeoutMs: z.natural().min(1000).default(DEFAULT_EMBED_TIMEOUT_MS),
  }), z.const(undefined)]),
  autoEmbed: z.boolean().default(true),
})

/**
 * Check that the enrichment route is named in full or not at all.
 * @param config - deployment configuration.
 * @throws on a half-named route.
 */
function assertEnrichRoute(config: Config): void {
  if ((config.enrichProvider === undefined) !== (config.enrichModel === undefined)) {
    throw new Error('knowledge: set enrichProvider and enrichModel together, or neither')
  }
}

/**
 * The limits of an enrichment run over one route.
 * @param config - deployment configuration.
 * @param route - the route.
 * @param limit - most files to summarize.
 * @param collection - only this collection.
 * @returns the run options.
 */
function enrichOptions(config: Config, route: { provider: string; model: string }, limit: number, collection?: string): EnrichOptions {
  return {
    provider: route.provider,
    model: route.model,
    limit,
    ...collection === undefined ? {} : { collection },
    concurrency: config.enrichConcurrency ?? DEFAULT_ENRICH_CONCURRENCY,
    maxInputChars: config.enrichMaxInputChars ?? DEFAULT_ENRICH_MAX_INPUT_CHARS,
    maxTokens: config.enrichMaxTokens ?? DEFAULT_ENRICH_MAX_TOKENS,
    timeoutMs: config.enrichTimeoutMs ?? DEFAULT_ENRICH_TIMEOUT_MS,
  }
}

/**
 * Render an enrichment report for a person.
 * @param report - the run totals.
 * @param rollups - the folder rollup totals, when rollups ran.
 * @returns one or more lines.
 */
function renderEnrichReport(report: KnowledgeEnrichReport, rollups?: KnowledgeRollupReport): string {
  const folders = rollups === undefined ? '' : `; ${rollups.folders} folder rollup(s) written${rollups.failed === 0 ? '' : `, ${rollups.failed} failed`}`
  return [
    `summarized ${report.summarized}, failed ${report.failed}, ${report.remaining} still waiting, in ${(report.durationMs / 1000).toFixed(1)} s${folders}`,
    ...report.failures.map(failure => `  ${failure.path}: ${failure.message}`),
  ].join('\n')
}

/**
 * Summarize waiting files, then roll folders up when rollups are on.
 * @param llm - the LLM runtime.
 * @param index - the knowledge index.
 * @param config - deployment configuration.
 * @param options - the route and limits.
 * @param signal - stops the run.
 * @returns the rendered report.
 */
async function enrichAndRollUp(
  llm: LlmRuntime,
  index: KnowledgeIndex,
  config: Config,
  options: EnrichOptions,
  signal: AbortSignal,
): Promise<{ report: KnowledgeEnrichReport; text: string }> {
  const report = await enrichFiles(llm, index, options, signal)
  const minChildren = config.folderRollupMinChildren ?? DEFAULT_FOLDER_ROLLUP_MIN_CHILDREN
  const rollups = minChildren === 0 ? undefined : await rollupFolders(llm, index, options, minChildren, signal)
  return { report, text: renderEnrichReport(report, rollups) }
}

/**
 * Render an indexing report for a person.
 * @param report - the pass counts.
 * @returns one line.
 */
function renderReport(report: KnowledgeIndexReport): string {
  return `indexed ${report.indexed}, unchanged ${report.unchanged}, removed ${report.removed}, skipped ${report.skipped} in ${(report.durationMs / 1000).toFixed(1)} s`
}

/**
 * The message of a thrown value.
 * @param error - the thrown value.
 * @returns its text.
 */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const USAGE = 'Usage: /kb [list | add <folder> [--name <name>] | remove <name> | reindex [collection] | enrich [collection] [--limit N] | embed [collection] [--limit N] | search <words>]'

/** The indexes one `/kb` invocation reaches: the configured collections and those of its session's workspace. */
interface CommandScope {
  /** The index over the configured collections. */
  readonly configured: KnowledgeIndex
  /** The session's workspace folder, when it has one. */
  readonly cwd: string | undefined
  /** The workspace's collections and index, when a folder is attached to it. */
  readonly workspace: WorkspaceKnowledgeEntry | undefined
}

/**
 * Every index in reach that holds collections, the configured one first.
 * @param scope - the invocation's indexes.
 * @returns the indexes.
 */
function indexesOf(scope: CommandScope): KnowledgeIndex[] {
  return [scope.configured, scope.workspace?.index]
    .filter((index): index is KnowledgeIndex => index !== undefined && index.configured.length > 0)
}

/**
 * The index that holds a collection.
 * @param scope - the invocation's indexes.
 * @param name - the collection name.
 * @returns the index, or `undefined` when no collection in reach has that name.
 */
function ownerOf(scope: CommandScope, name: string): KnowledgeIndex | undefined {
  return indexesOf(scope).find(index => index.configured.some(collection => collection.name === name))
}

/** The `/kb` reply when no collection is in reach. */
const NO_COLLECTIONS = 'No knowledge collections. Attach a folder to this workspace with /kb add <folder>, '
  + 'or add `collections` to the knowledge plugin in your profile\'s cordis.patch.yml.'

/**
 * Handle `/kb`: list (bare or `list`), attach, or detach collections, reindex, summarize, or embed them, or search passages.
 * @param ctx - plugin context.
 * @param config - deployment configuration.
 * @param index - the index over the configured collections.
 * @param workspaces - the workspace collections.
 * @param invocation - the command input.
 * @returns the command result.
 */
async function executeKnowledgeCommand(
  ctx: Context,
  config: Config,
  index: KnowledgeIndex,
  workspaces: WorkspaceKnowledge,
  invocation: CommandInvocation,
): Promise<CommandResult> {
  const input = invocation.rawInput.trim()
  const [verb, ...rest] = input.split(/\s+/u).filter(word => word.length > 0)
  const cwd = invocation.agent.session.header.cwd
  let workspace: WorkspaceKnowledgeEntry | undefined
  try {
    workspace = cwd === undefined ? undefined : await workspaces.open(cwd)
  } catch (error) {
    return { kind: 'error', text: errorText(error) }
  }
  const scope: CommandScope = { configured: index, cwd, workspace }
  if (verb === undefined || verb === 'list') return listCollections(config, scope)
  if (verb === 'add') return addFolder(workspaces, scope, input.slice('add'.length).trim(), invocation.signal)
  if (verb === 'remove') return removeFolder(workspaces, scope, rest)
  if (verb === 'reindex') {
    const only = rest[0]
    if (only === undefined) {
      const targets = indexesOf(scope)
      if (targets.length === 0) return { kind: 'success', text: NO_COLLECTIONS }
      const reports: string[] = []
      for (const target of targets) reports.push(renderReport(await target.update()))
      return { kind: 'success', text: `Knowledge index: ${reports.join('; ')}.` }
    }
    const owner = ownerOf(scope, only)
    if (owner === undefined) return { kind: 'error', text: `No knowledge collection ${only}.` }
    return { kind: 'success', text: `Knowledge index: ${renderReport(await owner.update(undefined, only))}.` }
  }
  if (verb === 'enrich') return startEnrichment(ctx, config, scope, invocation, rest)
  if (verb === 'embed') return startEmbedding(ctx, config, scope, invocation, rest)
  if (verb === 'search' && rest.length > 0) {
    const query = rest.join(' ')
    const hits: KnowledgeHit[] = mergeRanked(indexesOf(scope).map(target => target.search({ query, limit: 10 })), 10)
    if (hits.length === 0) return { kind: 'success', text: 'No matching passages.' }
    return { kind: 'success', text: hits.map(hit => `${hit.ref}${hit.heading.length > 0 ? ` — ${hit.heading}` : ''}`).join('\n') }
  }
  return { kind: 'error', text: USAGE }
}

/**
 * Handle bare `/kb`: the collections in reach with their counts.
 * @param config - deployment configuration.
 * @param scope - the invocation's indexes.
 * @returns the command result.
 */
function listCollections(config: Config, scope: CommandScope): CommandResult {
  const line = (entry: ReturnType<KnowledgeIndex['stats']>[number], where: string): string =>
    `${entry.name}: ${entry.files} files, ${entry.passages} passages, ${entry.summarized} summarized (${entry.root})${where}`
  const lines = [
    ...scope.configured.stats().map(entry => line(entry, '')),
    ...(scope.workspace?.index.stats() ?? []).map(entry => line(entry, ', this workspace')),
  ]
  if (lines.length === 0) return { kind: 'success', text: NO_COLLECTIONS }
  if (config.embeddings !== undefined) {
    const targets = indexesOf(scope)
    const embedded = targets.reduce((sum, target) => sum + target.vectorCount(), 0)
    const waiting = targets.reduce((sum, target) => sum + target.pendingVectorCount(), 0)
    lines.push(`embeddings: ${embedded} passages embedded, ${waiting} waiting`)
  }
  return { kind: 'success', text: lines.join('\n') }
}

/**
 * Handle `/kb add <folder> [--name <name>]`: attach a folder to the session's workspace and index it.
 * The person typed the command, so no approval is asked; summaries wait for `/kb enrich`.
 * @param workspaces - the workspace collections.
 * @param scope - the invocation's indexes.
 * @param words - the text after `add`.
 * @param signal - stops the first pass.
 * @returns the command result.
 */
async function addFolder(workspaces: WorkspaceKnowledge, scope: CommandScope, words: string, signal: AbortSignal): Promise<CommandResult> {
  if (scope.cwd === undefined) return { kind: 'error', text: 'This session has no workspace folder to attach a collection to.' }
  const [, folder = words, name] = /^(.*?)\s+--name\s+(\S+)$/u.exec(words) ?? []
  if (folder.length === 0) return { kind: 'error', text: USAGE }
  try {
    const { collection, report, files, passages } = await workspaces.add(scope.cwd, folder, name, signal)
    const skipped = report.skipped === 0 ? '' : `, ${report.skipped} skipped`
    return {
      kind: 'success',
      text: [
        `Indexed ${collection.root} as ${collection.name} for this workspace: ${files} files, ${passages} passages${skipped}.`,
        `Its files are not summarized yet; /kb enrich ${collection.name} summarizes them with one model request per file.`,
      ].join('\n'),
    }
  } catch (error) {
    return { kind: 'error', text: errorText(error) }
  }
}

/**
 * Handle `/kb remove <name>`: detach a workspace collection and drop its files from the index.
 * @param workspaces - the workspace collections.
 * @param scope - the invocation's indexes.
 * @param words - the words after `remove`.
 * @returns the command result.
 */
async function removeFolder(workspaces: WorkspaceKnowledge, scope: CommandScope, words: readonly string[]): Promise<CommandResult> {
  const [name] = words
  if (name === undefined || words.length > 1) return { kind: 'error', text: USAGE }
  if (scope.configured.configured.some(collection => collection.name === name)) {
    return { kind: 'error', text: `${name} is configured in the profile's cordis.patch.yml; remove it there.` }
  }
  if (scope.cwd === undefined || scope.workspace?.collections.some(collection => collection.name === name) !== true) {
    return { kind: 'error', text: `This workspace has no collection ${name}.` }
  }
  const report = await workspaces.remove(scope.cwd, name)
  return { kind: 'success', text: `Removed ${name} from this workspace; ${report.removed} file(s) dropped from its index.` }
}

/**
 * Handle `/kb enrich [collection] [--limit N]`: summarize waiting files over the configured route or
 * the session's own, as a background job owned by the invoking agent when a job registry is composed.
 * @param ctx - plugin context.
 * @param config - deployment configuration.
 * @param scope - the invocation's indexes.
 * @param invocation - the command input.
 * @param words - the words after `enrich`.
 * @returns the command result.
 */
async function startEnrichment(
  ctx: Context,
  config: Config,
  scope: CommandScope,
  invocation: CommandInvocation,
  words: readonly string[],
): Promise<CommandResult> {
  const llm = ctx.get('llm')
  if (llm === undefined) return { kind: 'error', text: 'Enrichment needs the LLM runtime, which this composition does not mount.' }
  const parsed = parseRunArguments(scope, words, DEFAULT_ENRICH_LIMIT)
  if ('error' in parsed) return { kind: 'error', text: parsed.error }
  const { limit, collection, targets } = parsed
  const header = invocation.agent.session.requestHeader()?.config
  const route = config.enrichProvider !== undefined && config.enrichModel !== undefined
    ? { provider: config.enrichProvider, model: config.enrichModel }
    : header !== undefined
      ? { provider: header.provider, model: header.model }
      : invocation.agent.options.provider !== undefined && invocation.agent.options.model !== undefined
        ? { provider: invocation.agent.options.provider, model: invocation.agent.options.model }
        : undefined
  if (route === undefined) {
    return { kind: 'error', text: 'No model route for enrichment: send a message first, or set enrichProvider and enrichModel.' }
  }
  const minChildren = config.folderRollupMinChildren ?? DEFAULT_FOLDER_ROLLUP_MIN_CHILDREN
  const waiting = targets.reduce((sum, target) => sum + target.pendingCount(collection), 0)
  const staleFolders = minChildren === 0 ? 0 : targets.reduce((sum, target) => sum + target.staleFolders(minChildren, collection).length, 0)
  if (waiting === 0 && staleFolders === 0) return { kind: 'success', text: 'Every indexed file already has a summary, and every folder rollup is current.' }
  const options = enrichOptions(config, route, limit, collection)
  const run = async (signal: AbortSignal): Promise<{ summarized: number; text: string }> => {
    let summarized = 0
    const texts: string[] = []
    for (const target of targets) {
      const result = await enrichAndRollUp(llm, target, config, options, signal)
      summarized += result.report.summarized
      texts.push(result.text)
    }
    return { summarized, text: texts.join('; ') }
  }
  const jobs = ctx.get('jobs')
  if (jobs === undefined) {
    return { kind: 'success', text: `Knowledge enrichment: ${(await run(invocation.signal)).text}.` }
  }
  const id = startKnowledgeJob(
    jobs,
    invocation.agent,
    `/kb enrich ${collection ?? 'all collections'} (${Math.min(limit, waiting)} files)`,
    'knowledge enrichment cancelled',
    run,
    ({ summarized, text }) => ({ detail: `${summarized} summarized`, output: text }),
  )
  return {
    kind: 'success',
    text: `Summarizing up to ${Math.min(limit, waiting)} of ${waiting} waiting file(s) with ${route.provider}/${route.model} as background job ${id}; `
      + `/kb shows progress, and job_kill ${id} stops it after the files in flight.`,
  }
}

/**
 * Read `[collection] [--limit N]` after a `/kb` verb.
 * @param scope - the invocation's indexes.
 * @param words - the words after the verb.
 * @param defaultLimit - the limit when `--limit` is absent.
 * @returns the collection, the indexes it covers, and the limit, or an error message.
 */
function parseRunArguments(
  scope: CommandScope,
  words: readonly string[],
  defaultLimit: number,
): { collection?: string; targets: KnowledgeIndex[]; limit: number } | { error: string } {
  let limit = defaultLimit
  let collection: string | undefined
  let owner: KnowledgeIndex | undefined
  for (let position = 0; position < words.length; position += 1) {
    const word = words[position]
    if (word === '--limit') {
      limit = Number(words[position + 1])
      position += 1
      if (!Number.isInteger(limit) || limit < 1) return { error: '--limit needs a positive whole number.' }
    } else if (word !== undefined) {
      owner = ownerOf(scope, word)
      if (owner === undefined) return { error: `No knowledge collection ${word}.` }
      collection = word
    }
  }
  return { limit, targets: owner === undefined ? indexesOf(scope) : [owner], ...collection === undefined ? {} : { collection } }
}

/**
 * Handle `/kb embed [collection] [--limit N]`: embed waiting passages, as a background job owned by
 * the invoking agent when a job registry is composed.
 * @param ctx - plugin context.
 * @param config - deployment configuration.
 * @param scope - the invocation's indexes.
 * @param invocation - the command input.
 * @param words - the words after `embed`.
 * @returns the command result.
 */
async function startEmbedding(
  ctx: Context,
  config: Config,
  scope: CommandScope,
  invocation: CommandInvocation,
  words: readonly string[],
): Promise<CommandResult> {
  if (config.embeddings === undefined) return { kind: 'error', text: 'No embedding endpoint is configured: set `embeddings` on the knowledge plugin.' }
  const parsed = parseRunArguments(scope, words, Number.MAX_SAFE_INTEGER)
  if ('error' in parsed) return { kind: 'error', text: parsed.error }
  const { limit, collection, targets } = parsed
  const waiting = targets.reduce((sum, target) => sum + target.pendingVectorCount(collection), 0)
  if (waiting === 0) return { kind: 'success', text: 'Every passage already has a vector.' }
  const run = async (signal: AbortSignal): Promise<{ embedded: number; failed: number; remaining: number }> => {
    const total = { embedded: 0, failed: 0, remaining: 0 }
    for (const target of targets) {
      const report = await target.embedPassages(limit, signal, collection)
      total.embedded += report.embedded
      total.failed += report.failed
      total.remaining += report.remaining
    }
    return total
  }
  const render = (report: { embedded: number; failed: number; remaining: number }): string =>
    `embedded ${report.embedded} passages, ${report.failed} batch(es) failed, ${report.remaining} still waiting`
  const jobs = ctx.get('jobs')
  if (jobs === undefined) {
    return { kind: 'success', text: `Knowledge embeddings: ${render(await run(invocation.signal))}.` }
  }
  const id = startKnowledgeJob(
    jobs,
    invocation.agent,
    `/kb embed ${collection ?? 'all collections'} (${Math.min(limit, waiting)} passages)`,
    'knowledge embedding cancelled',
    run,
    report => ({ detail: `${report.embedded} embedded`, output: render(report) }),
  )
  return { kind: 'success', text: `Embedding up to ${Math.min(limit, waiting)} of ${waiting} waiting passage(s) as background job ${id}; job_kill ${id} stops it.` }
}

/** What the background passes share: the plugin's lifetime and how a failure is logged. */
interface PassContext {
  /** Aborted when the plugin is disposed. */
  readonly signal: AbortSignal
  /** Log a failed step unless the plugin is being disposed. */
  readonly warn: (what: string, error: unknown) => void
}

/**
 * Index the configured collections' new and changed files, embed new passages when `embeddings`
 * is set, then summarize new files and roll folders up when an enrichment route is set.
 * @param ctx - plugin context.
 * @param config - deployment configuration.
 * @param index - the index over the configured collections.
 * @param passes - the plugin's lifetime and failure log.
 */
async function refreshConfigured(ctx: Context, config: Config, index: KnowledgeIndex, passes: PassContext): Promise<void> {
  const report = await index.update(passes.signal)
  if (report.indexed + report.removed > 0) ctx.logger.info(`knowledge index: ${renderReport(report)}`)
  if (config.autoEmbed !== false && config.embeddings !== undefined && index.pendingVectorCount() > 0) {
    try {
      const embedded = await index.embedPassages(Number.MAX_SAFE_INTEGER, passes.signal)
      ctx.logger.info(`knowledge embeddings: ${embedded.embedded} embedded, ${embedded.failed} batch(es) failed, ${embedded.remaining} waiting`)
    } catch (error) {
      passes.warn('embedding', error)
    }
  }
  const llm = ctx.get('llm')
  if (config.autoEnrich !== false && llm !== undefined && config.enrichProvider !== undefined && config.enrichModel !== undefined) {
    const minChildren = config.folderRollupMinChildren ?? DEFAULT_FOLDER_ROLLUP_MIN_CHILDREN
    const stale = minChildren === 0 ? 0 : index.staleFolders(minChildren).length
    if (index.pendingCount() > 0 || stale > 0) {
      try {
        const route = { provider: config.enrichProvider, model: config.enrichModel }
        const enriched = await enrichAndRollUp(llm, index, config, enrichOptions(config, route, Number.MAX_SAFE_INTEGER), passes.signal)
        ctx.logger.info(`knowledge enrichment: ${enriched.text}`)
      } catch (error) {
        passes.warn('enrichment', error)
      }
    }
  }
}

/**
 * Index one workspace's new and changed files, then embed new passages when `embeddings` is set.
 * Workspace files are summarized only when a person asks, so no enrichment runs here.
 * @param ctx - plugin context.
 * @param config - deployment configuration.
 * @param entry - the workspace and its index.
 * @param passes - the plugin's lifetime and failure log.
 */
async function refreshWorkspace(ctx: Context, config: Config, entry: WorkspaceKnowledgeEntry, passes: PassContext): Promise<void> {
  const report = await entry.index.update(passes.signal)
  if (report.indexed + report.removed > 0) ctx.logger.info(`knowledge index for ${entry.cwd}: ${renderReport(report)}`)
  if (config.autoEmbed !== false && config.embeddings !== undefined && entry.index.pendingVectorCount() > 0) {
    const embedded = await entry.index.embedPassages(Number.MAX_SAFE_INTEGER, passes.signal)
    ctx.logger.info(`knowledge embeddings for ${entry.cwd}: ${embedded.embedded} embedded, ${embedded.failed} batch(es) failed, ${embedded.remaining} waiting`)
  }
}

/**
 * Keep the indexes current without anyone asking: a pass over the configured collections at start
 * (unless `indexOnStart` is false), and every `reindexIntervalSeconds` a pass over the configured
 * collections and every opened workspace. A pass never overlaps the previous one; disposal stops
 * the timer and aborts the running pass.
 * @param ctx - plugin context.
 * @param config - deployment configuration.
 * @param index - the index over the configured collections.
 * @param workspaces - the workspace collections.
 * @param passes - the plugin's lifetime and failure log.
 * @param refresh - refreshes one workspace and logs its failure.
 */
function installBackgroundPasses(
  ctx: Context,
  config: Config,
  index: KnowledgeIndex,
  workspaces: WorkspaceKnowledge,
  passes: PassContext,
  refresh: (entry: WorkspaceKnowledgeEntry) => Promise<void>,
): void {
  let running = false
  const pass = async (): Promise<void> => {
    if (running || passes.signal.aborted) return
    running = true
    if (index.configured.length > 0) {
      await refreshConfigured(ctx, config, index, passes).catch((error: unknown) => {
        passes.warn('index update', error)
      })
    }
    for (const entry of workspaces.list()) await refresh(entry)
    running = false
  }
  if (config.indexOnStart !== false && index.configured.length > 0) void pass()
  const seconds = config.reindexIntervalSeconds ?? DEFAULT_REINDEX_INTERVAL_SECONDS
  if (seconds > 0) {
    ctx.effect(() => {
      const timer = setInterval(() => { void pass() }, seconds * 1000)
      timer.unref()
      return () => { clearInterval(timer) }
    }, 'knowledge.reindexTimer')
  }
}

/**
 * Open the index, publish `ctx.knowledge` and `ctx.knowledgeWorkspaces`, start the background
 * passes, and register `/kb`.
 * @param ctx - plugin context carrying `commands`.
 * @param config - deployment configuration.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  assertCollections(config.collections)
  assertEnrichRoute(config)
  const shared = {
    excludeDirs: config.excludeDirs ?? DEFAULT_EXCLUDE_DIRS,
    maxFileBytes: config.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
    maxDocumentBytes: config.maxDocumentBytes ?? DEFAULT_MAX_DOCUMENT_BYTES,
    bounds: { targetChars: config.targetChars ?? DEFAULT_TARGET_CHARS, maxChars: config.maxChars ?? DEFAULT_MAX_CHARS },
    hitChars: config.hitChars ?? DEFAULT_HIT_CHARS,
    maxReadLines: config.maxReadLines ?? DEFAULT_MAX_READ_LINES,
    ...config.embeddings === undefined
      ? {}
      : {
        embeddings: {
          baseURL: config.embeddings.baseURL,
          model: config.embeddings.model,
          ...config.embeddings.apiKeyEnv === undefined ? {} : { apiKeyEnv: config.embeddings.apiKeyEnv },
          ...config.embeddings.dimensions === undefined ? {} : { dimensions: config.embeddings.dimensions },
          batchSize: config.embeddings.batchSize ?? DEFAULT_EMBED_BATCH_SIZE,
          timeoutMs: config.embeddings.timeoutMs ?? DEFAULT_EMBED_TIMEOUT_MS,
        },
      },
  }
  const abort = new AbortController()
  const passes: PassContext = {
    signal: abort.signal,
    warn: (what, error) => {
      if (!abort.signal.aborted) ctx.logger.warn(`knowledge ${what} failed: ${errorText(error)}`)
    },
  }
  const index = await KnowledgeIndex.open({ ...shared, path: config.path }, config.collections)
  ctx.effect(() => () => {
    index.close()
  }, 'knowledge.close')
  const refresh = (entry: WorkspaceKnowledgeEntry): Promise<void> =>
    refreshWorkspace(ctx, config, entry, passes).catch((error: unknown) => {
      passes.warn(`index update for ${entry.cwd}`, error)
    })
  const workspaces = new WorkspaceKnowledge(shared, config.collections.map(collection => collection.name), {
    opened: (entry) => {
      void refresh(entry)
    },
    configuredRoute: config.enrichProvider !== undefined && config.enrichModel !== undefined
      ? { provider: config.enrichProvider, model: config.enrichModel }
      : undefined,
    summarize: async (target, collection, route, signal) => {
      const llm = ctx.get('llm')
      if (llm === undefined) throw new Error('knowledge: summaries need the LLM runtime, which this composition does not mount')
      const options = enrichOptions(config, route, Number.MAX_SAFE_INTEGER, collection)
      const { report, text } = await enrichAndRollUp(llm, target, config, options, signal)
      return { summarized: report.summarized, text }
    },
  })
  ctx.effect(() => () => workspaces.close(), 'knowledge.workspacesClose')
  // Registered after both closes, so disposal aborts the passes before any index closes.
  ctx.effect(() => () => {
    abort.abort(new Error('knowledge plugin disposed'))
  }, 'knowledge.passAbort')
  ctx.provide('knowledge', index)
  ctx.provide('knowledgeWorkspaces', workspaces)
  installBackgroundPasses(ctx, config, index, workspaces, passes, refresh)
  ctx.effect(() => ctx.commands.register({
    name: 'kb',
    description: 'Show knowledge base collections, attach or detach workspace folders, reindex, summarize, or embed them, or search passages',
    input: { hint: '[add <folder> [--name <name>] | remove <name> | reindex [collection] | enrich [collection] [--limit N] | embed [collection] [--limit N] | search <words>]' },
    handler: invocation => executeKnowledgeCommand(ctx, config, index, workspaces, invocation),
  }))
}
