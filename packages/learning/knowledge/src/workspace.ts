/**
 * Folders attached to one workspace's knowledge base. A workspace keeps its
 * list in `<workspace>/.dsh/knowledge/collections.json` and its index beside
 * it, so only sessions whose folder is that workspace reach its collections.
 * A person attaches a folder with `/kb add`, or the agent does after the
 * person approves; the list file is validated whenever it is read.
 * @module
 */

import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, parse, resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { fuse } from './embed.ts'
import { countIndexableFiles, KnowledgeIndex, type KnowledgeIndexOptions } from './store.ts'
import type { KnowledgeCollection, KnowledgeIndexReport } from './types.ts'

/** A collection name: letters, digits, `-`, and `_`, starting with a letter or digit. */
export const COLLECTION_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u

/** The folder, relative to a workspace, that holds its collection list and index. */
export const WORKSPACE_KNOWLEDGE_FOLDER = join('.dsh', 'knowledge')

/** Version of the collection list file this build reads and writes. */
const LIST_VERSION = 1

/** The collection list file as stored. */
interface StoredList {
  version: number
  collections: KnowledgeCollection[]
}

const StoredList: z<StoredList> = z.object({
  version: z.natural().required(),
  collections: z.array(z.object({
    name: z.string().required(),
    root: z.string().required(),
  })).required(),
})

/**
 * Validate collections: unique names of the allowed form, absolute roots, and
 * no name a configured collection already uses.
 * @param collections - the collections to check.
 * @param reserved - names that belong to other collections the same sessions reach.
 * @param source - where the list came from, named in the message; omitted for the plugin configuration.
 * @throws on a misconfigured collection, naming it.
 */
export function assertCollections(
  collections: readonly KnowledgeCollection[],
  reserved: readonly string[] = [],
  source?: string,
): void {
  const where = source === undefined ? '' : ` in ${source}`
  const names = new Set<string>()
  for (const collection of collections) {
    if (!COLLECTION_NAME.test(collection.name)) {
      throw new Error(`knowledge: collection name ${JSON.stringify(collection.name)}${where} must use letters, digits, - and _`)
    }
    if (names.has(collection.name)) throw new Error(`knowledge: collection ${JSON.stringify(collection.name)} is configured twice${where}`)
    if (reserved.includes(collection.name)) {
      throw new Error(`knowledge: collection ${JSON.stringify(collection.name)}${where} has the name of a configured collection; rename one of them`)
    }
    names.add(collection.name)
    if (!isAbsolute(collection.root)) {
      throw new Error(`knowledge: collection ${JSON.stringify(collection.name)} root ${JSON.stringify(collection.root)}${where} must be an absolute path`)
    }
  }
}

/**
 * Resolve the folder a person or the agent named: `~` is the home folder, a
 * relative path is taken from the workspace, and the result must be an
 * existing folder other than a disk's root.
 * @param cwd - the workspace folder.
 * @param path - the folder as written.
 * @returns the absolute folder.
 * @throws when the folder is missing, is a file, or is a disk's root.
 */
export async function resolveRoot(cwd: string, path: string): Promise<string> {
  const written = path.trim()
  if (written.length === 0) throw new Error('knowledge: name the folder to index')
  const expanded = written === '~' ? homedir() : written.startsWith('~/') ? join(homedir(), written.slice(2)) : written
  const root = isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded)
  if (parse(root).root === root) throw new Error(`knowledge: ${root} is a whole disk; name a documents folder`)
  let isFolder: boolean
  try {
    isFolder = (await stat(root)).isDirectory()
  } catch (error) {
    throw new Error(`knowledge: ${root} does not exist`, { cause: error })
  }
  if (!isFolder) throw new Error(`knowledge: ${root} is not a folder`)
  return root
}

/**
 * A free collection name from a folder's name: characters outside the
 * allowed set become `-`, and a taken name gets `-2`, `-3`, and so on.
 * @param folder - the folder's base name.
 * @param taken - names already in use.
 * @returns the name.
 */
function freeName(folder: string, taken: ReadonlySet<string>): string {
  const cleaned = folder.replace(/[^A-Za-z0-9_-]+/gu, '-').replace(/^[_-]+/u, '')
  const base = cleaned.length === 0 ? 'docs' : cleaned
  let candidate = base
  for (let suffix = 2; taken.has(candidate); suffix += 1) candidate = `${base}-${suffix}`
  return candidate
}

/**
 * Merge ranked lists from several indexes by reciprocal rank fusion. Scores
 * from different indexes are not comparable, so rank is all that counts.
 * @param lists - each index's items, best first.
 * @param limit - most items to return.
 * @returns the merged items, best first.
 */
export function mergeRanked<T>(lists: readonly (readonly T[])[], limit: number): T[] {
  const items: T[] = []
  const rankings = lists.map(list => list.map(item => items.push(item) - 1))
  // oxlint-disable-next-line typescript/no-non-null-assertion -- every fused id is a position in items
  return fuse(rankings).slice(0, limit).map(id => items[id]!)
}

/** One opened workspace: its collections and the index over them. */
export interface WorkspaceKnowledgeEntry {
  /** The workspace folder. */
  readonly cwd: string
  /** The collections attached to it. */
  collections: readonly KnowledgeCollection[]
  /** The index over them. */
  readonly index: KnowledgeIndex
}

/** What attaching a folder produced. */
export interface WorkspaceAddResult {
  /** The new collection. */
  readonly collection: KnowledgeCollection
  /** The counts of the pass that indexed it. */
  readonly report: KnowledgeIndexReport
  /** Files the collection holds after that pass. */
  readonly files: number
  /** Passages the collection holds after that pass. */
  readonly passages: number
}

/** A provider and model that write summaries. */
export interface SummaryRoute {
  /** The provider id. */
  readonly provider: string
  /** The model id. */
  readonly model: string
}

/** What the knowledge plugin supplies to the workspace manager. */
export interface WorkspaceKnowledgeHooks {
  /** Called once for each workspace index the manager opens from a stored list. */
  readonly opened: (entry: WorkspaceKnowledgeEntry) => void
  /** The route the deployment names for summaries, when it names one. */
  readonly configuredRoute: SummaryRoute | undefined
  /** Summarize a collection's waiting files and roll its folders up. */
  readonly summarize: (
    index: KnowledgeIndex,
    collection: string,
    route: SummaryRoute,
    signal: AbortSignal,
  ) => Promise<{ summarized: number; text: string }>
}

/** The collections attached to each workspace, and their indexes. */
export class WorkspaceKnowledge {
  private readonly entries = new Map<string, WorkspaceKnowledgeEntry>()
  private readonly loading = new Map<string, Promise<WorkspaceKnowledgeEntry | undefined>>()
  private readonly queues = new Map<string, Promise<unknown>>()
  private readonly listeners = new Set<(cwd: string) => void>()

  /**
   * @param options - the index limits every workspace index shares; each index lives in its workspace.
   * @param reserved - names of the configured collections, which a workspace collection may not reuse.
   * @param hooks - the plugin's refresh on open and its summary route and run.
   */
  constructor(
    private readonly options: Omit<KnowledgeIndexOptions, 'path'>,
    private readonly reserved: readonly string[],
    private readonly hooks: WorkspaceKnowledgeHooks,
  ) {}

  /**
   * Watch every workspace's collection list.
   * @param listener - called with the workspace folder after a folder is attached or detached; it must not throw.
   * @returns the disposer that ends the watch.
   */
  watch(listener: (cwd: string) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * Count the files a pass over a folder would read, before it is attached.
   * @param root - the absolute folder.
   * @param signal - stops the walk.
   * @returns an upper bound, since file sizes are not checked.
   */
  countFiles(root: string, signal?: AbortSignal): Promise<number> {
    return countIndexableFiles(root, this.options.excludeDirs, signal)
  }

  /**
   * The route that would summarize a workspace collection: the deployment's route when it names one, else the session's.
   * @param session - the session's current route, when it has one.
   * @returns the route, or `undefined` when neither exists.
   */
  summaryRoute(session: SummaryRoute | undefined): SummaryRoute | undefined {
    return this.hooks.configuredRoute ?? session
  }

  /**
   * Summarize a workspace collection's waiting files and roll its folders up.
   * @param cwd - the workspace folder.
   * @param name - the collection name.
   * @param route - the route that writes the summaries.
   * @param signal - stops the run after the requests in flight.
   * @returns how many files were summarized, and the run's report.
   * @throws when the workspace has no collection of that name.
   */
  async summarize(cwd: string, name: string, route: SummaryRoute, signal: AbortSignal): Promise<{ summarized: number; text: string }> {
    const entry = await this.open(cwd)
    if (entry?.collections.some(collection => collection.name === name) !== true) {
      throw new Error(`knowledge: this workspace has no collection ${name}`)
    }
    return this.hooks.summarize(entry.index, name, route, signal)
  }

  /**
   * The workspaces opened so far.
   * @returns their entries.
   */
  list(): WorkspaceKnowledgeEntry[] {
    return [...this.entries.values()]
  }

  /**
   * Open a workspace's index when it has collections; later calls return the same entry.
   * @param cwd - the workspace folder.
   * @returns the entry, or `undefined` when no folder is attached.
   * @throws when the collection list file is invalid.
   */
  open(cwd: string): Promise<WorkspaceKnowledgeEntry | undefined> {
    const known = this.entries.get(cwd)
    if (known !== undefined) return Promise.resolve(known)
    let pending = this.loading.get(cwd)
    if (pending === undefined) {
      pending = this.load(cwd).finally(() => {
        this.loading.delete(cwd)
      })
      this.loading.set(cwd, pending)
    }
    return pending
  }

  /**
   * Attach a folder to a workspace and index it.
   * @param cwd - the workspace folder.
   * @param path - the folder as written: absolute, relative to the workspace, or under `~`.
   * @param name - the collection name; derived from the folder's name when omitted.
   * @param signal - stops the first pass.
   * @returns the new collection, the first pass's counts, and the files and passages the collection holds after it.
   * @throws when the folder is invalid or already attached, or the name is invalid or taken.
   */
  add(cwd: string, path: string, name: string | undefined, signal?: AbortSignal): Promise<WorkspaceAddResult> {
    return this.serialize(cwd, async () => {
      const root = await resolveRoot(cwd, path)
      const current = await this.read(cwd)
      const same = current.find(collection => collection.root === root)
      if (same !== undefined) throw new Error(`knowledge: ${root} is already indexed as ${same.name}`)
      const taken = new Set([...this.reserved, ...current.map(collection => collection.name)])
      if (name !== undefined && !COLLECTION_NAME.test(name)) throw new Error(`knowledge: collection name ${JSON.stringify(name)} must use letters, digits, - and _`)
      if (name !== undefined && taken.has(name)) throw new Error(`knowledge: a collection named ${name} already exists`)
      const collection = { name: name ?? freeName(basename(root), taken), root }
      const next = [...current, collection]
      await this.write(cwd, next)
      // This change indexes the folder itself, so opening the index here starts no refresh.
      const entry = await this.attach(cwd, next, false)
      await entry.index.idle()
      const report = await entry.index.update(signal, collection.name)
      // oxlint-disable-next-line typescript/no-non-null-assertion -- stats() lists every collection the index keeps
      const counted = entry.index.stats().find(candidate => candidate.name === collection.name)!
      this.changed(cwd)
      return { collection, report, files: counted.files, passages: counted.passages }
    })
  }

  /**
   * Detach a folder from a workspace and drop its files from the index.
   * @param cwd - the workspace folder.
   * @param name - the collection name.
   * @returns the counts of the pass that dropped the files.
   * @throws when the workspace has no collection of that name.
   */
  remove(cwd: string, name: string): Promise<KnowledgeIndexReport> {
    return this.serialize(cwd, async () => {
      const entry = await this.open(cwd)
      if (entry?.collections.some(collection => collection.name === name) !== true) {
        throw new Error(`knowledge: this workspace has no collection ${name}`)
      }
      const next = entry.collections.filter(collection => collection.name !== name)
      await this.write(cwd, next)
      entry.index.setCollections(next)
      entry.collections = next
      await entry.index.idle()
      const report = await entry.index.update()
      if (next.length === 0) {
        this.entries.delete(cwd)
        entry.index.close()
      }
      this.changed(cwd)
      return report
    })
  }

  /**
   * Close every workspace index once its pass in progress ends.
   * @returns resolution after the indexes close.
   */
  async close(): Promise<void> {
    const entries = this.list()
    this.entries.clear()
    for (const entry of entries) {
      await entry.index.idle()
      entry.index.close()
    }
  }

  /** Tell every watcher that a workspace's collection list changed. */
  private changed(cwd: string): void {
    for (const listener of this.listeners) listener(cwd)
  }

  private async load(cwd: string): Promise<WorkspaceKnowledgeEntry | undefined> {
    const collections = await this.read(cwd)
    if (collections.length === 0) return undefined
    return this.attach(cwd, collections, true)
  }

  /**
   * Point the workspace's entry at `collections`, opening its index on first use.
   * @param announce - whether a newly opened index is reported to the `opened` callback.
   */
  private async attach(cwd: string, collections: readonly KnowledgeCollection[], announce: boolean): Promise<WorkspaceKnowledgeEntry> {
    const known = this.entries.get(cwd)
    if (known !== undefined) {
      known.index.setCollections(collections)
      known.collections = collections
      return known
    }
    const index = await KnowledgeIndex.open({ ...this.options, path: join(cwd, WORKSPACE_KNOWLEDGE_FOLDER, 'index.sqlite') }, collections)
    const entry: WorkspaceKnowledgeEntry = { cwd, collections, index }
    this.entries.set(cwd, entry)
    if (announce) this.hooks.opened(entry)
    return entry
  }

  /** Read and validate the workspace's collection list; a missing file lists none. */
  private async read(cwd: string): Promise<KnowledgeCollection[]> {
    const file = join(cwd, WORKSPACE_KNOWLEDGE_FOLDER, 'collections.json')
    let text: string
    try {
      text = await readFile(file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    let stored: StoredList
    try {
      // The schema checks the parsed value; the cast only meets its call signature.
      stored = StoredList(JSON.parse(text) as StoredList)
    } catch (error) {
      // JSON.parse and the schema throw Error instances.
      throw new Error(`knowledge: ${file} is not a workspace collection list: ${(error as Error).message}`, { cause: error })
    }
    if (stored.version !== LIST_VERSION) {
      throw new Error(`knowledge: ${file} has version ${stored.version}; this build reads version ${LIST_VERSION}`)
    }
    assertCollections(stored.collections, this.reserved, file)
    return stored.collections
  }

  /** Replace the workspace's collection list file in one rename. */
  private async write(cwd: string, collections: readonly KnowledgeCollection[]): Promise<void> {
    const folder = join(cwd, WORKSPACE_KNOWLEDGE_FOLDER)
    await mkdir(folder, { recursive: true, mode: 0o700 })
    const file = join(folder, 'collections.json')
    const staged = `${file}.${process.pid}.tmp`
    await writeFile(staged, `${JSON.stringify({ version: LIST_VERSION, collections }, null, 2)}\n`, { mode: 0o600 })
    await rename(staged, file)
  }

  /** Run one change to a workspace after the changes queued before it settle. */
  private serialize<T>(cwd: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(cwd) ?? Promise.resolve()
    const next = previous.then(work)
    // The queue moves on after a failed change too; the change's own caller receives the failure.
    this.queues.set(cwd, next.catch(() => undefined))
    return next
  }
}
