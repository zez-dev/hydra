/**
 * The knowledge index: a SQLite database with an FTS5 table of passages from
 * every file under the configured collection roots. Indexing is incremental
 * (a file whose size and modification time are unchanged is skipped), yields
 * to the event loop between files, and never follows symbolic links.
 * @module
 */

import { mkdir, open, readdir, readFile, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { DatabaseSync, StatementSync } from 'node:sqlite'
import { chunkFile, kindOf, usesMarkdownHeadings, type ChunkBounds } from './chunk.ts'
import { isSecretFile, SECRET_DIRS } from './secret.ts'
import { documentExtension, extractDocument } from './extract.ts'
import { embedTexts, fuse, nearest, quantize, type EmbeddingConfig } from './embed.ts'
import type {
  KnowledgeBrowseEntry,
  KnowledgeCollection,
  KnowledgeCollectionStats,
  KnowledgeFileSummary,
  KnowledgeFileType,
  KnowledgeFolderHit,
  KnowledgeFolderInput,
  KnowledgeHit,
  KnowledgePendingFile,
  KnowledgeSummaryHit,
  KnowledgeIndexReport,
  KnowledgePassageKind,
  KnowledgeRead,
  KnowledgeSearchRequest,
} from './types.ts'

/** Current index schema version; an index written by another version is rebuilt from the files. */
export const KNOWLEDGE_SCHEMA_VERSION = 6

/** SQLite application id marking a database as a knowledge index (`DSKB`). */
export const KNOWLEDGE_APPLICATION_ID = 0x44534b42

/** Words too common to indicate what a query is about. */
const STOP_WORDS: ReadonlySet<string> = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'can', 'do', 'does', 'for', 'from', 'has', 'have', 'how', 'i',
  'if', 'in', 'into', 'is', 'it', 'its', 'me', 'my', 'no', 'not', 'of', 'on', 'or', 'our', 'so', 'that', 'the', 'their',
  'them', 'then', 'there', 'these', 'this', 'to', 'up', 'was', 'we', 'what', 'when', 'where', 'which', 'who', 'why', 'will',
  'with', 'would', 'you', 'your',
])

/** Indexing and reading limits. */
export interface KnowledgeIndexOptions {
  /** Database file, or `:memory:`. */
  readonly path: string
  /** Folder names skipped anywhere under a root, such as `.git`. */
  readonly excludeDirs: readonly string[]
  /** Text files larger than this many bytes are skipped. */
  readonly maxFileBytes: number
  /** PDF, Word, and EPUB files larger than this many bytes are skipped. */
  readonly maxDocumentBytes: number
  /** Passage size bounds. */
  readonly bounds: ChunkBounds
  /** Characters of passage text a search hit carries. */
  readonly hitChars: number
  /** Most lines one read returns. */
  readonly maxReadLines: number
  /** The embedding endpoint, when search by meaning is configured. */
  readonly embeddings?: EmbeddingConfig
}

/** Candidates each ranking contributes before reciprocal rank fusion. */
const FUSION_DEPTH = 50
/** Characters of a passage sent to the embedding endpoint. */
const EMBED_CHARS = 2000

/**
 * Build an FTS5 match expression from free text: each meaningful word as a
 * quoted term (the last one also as a prefix, for a word still being typed),
 * any of which may match; BM25 ranks passages that match more and rarer words
 * first, and the stemming tokenizer matches word forms.
 * @param query - free text.
 * @returns the match expression, or `undefined` when the text has no meaningful word.
 */
export function matchExpression(query: string): string | undefined {
  const words = [...new Set((query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [])
    .filter(word => word.length > 1 && !STOP_WORDS.has(word)))]
  if (words.length === 0) return undefined
  return words.map((word, index) => `"${word.replaceAll('"', '""')}"${index === words.length - 1 ? '*' : ''}`).join(' OR ')
}

/**
 * Resolve a path inside a collection root, refusing anything outside it.
 * @param root - the collection root.
 * @param path - a path relative to the root.
 * @returns the absolute path.
 * @throws when the path leaves the root.
 */
export function insideRoot(root: string, path: string): string {
  const absolute = resolve(root, path)
  const rel = relative(root, absolute)
  if (rel.length === 0 || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`knowledge: ${JSON.stringify(path)} is outside the collection`)
  }
  return absolute
}

/**
 * Split a citation `collection:path#Lstart-Lend` (the line range optional).
 * @param ref - the citation or a `collection:path` pair.
 * @returns its parts; lines are absent when the citation carries none.
 * @throws when the collection prefix is missing.
 */
export function parseRef(ref: string): { collection: string; path: string; startLine?: number; endLine?: number } {
  const colon = ref.indexOf(':')
  if (colon <= 0) throw new Error(`knowledge: expected "collection:path", got ${JSON.stringify(ref)}`)
  const collection = ref.slice(0, colon)
  const rest = ref.slice(colon + 1)
  const lines = /#L(\d+)(?:-L?(\d+))?$/u.exec(rest)
  if (lines === null) return { collection, path: rest }
  const startLine = Number(lines[1])
  return { collection, path: rest.slice(0, lines.index), startLine, endLine: lines[2] === undefined ? startLine : Number(lines[2]) }
}

/** Yield to the event loop so indexing never starves the agent. */
function yieldTurn(): Promise<void> {
  return new Promise(resolveTurn => setImmediate(resolveTurn))
}

/**
 * The files under `root`, in name order, skipping excluded and credential folders.
 * @param root - the collection folder.
 * @param prefix - the folder below `root` to list, `''` for the root itself.
 * @param excludeDirs - folder names skipped anywhere below `root`.
 * @yields each file's path relative to `root`, with `/` separators.
 */
async function* walkFiles(root: string, prefix: string, excludeDirs: readonly string[]): AsyncGenerator<string> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await readdir(join(root, prefix), { withFileTypes: true })
  } catch (_unreadable) {
    // An unreadable or missing folder contributes no files; its indexed files are removed.
    return
  }
  entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
  for (const entry of entries) {
    const path = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) {
      if (excludeDirs.includes(entry.name) || SECRET_DIRS.has(entry.name.toLowerCase())) continue
      yield* walkFiles(root, path, excludeDirs)
    } else if (entry.isFile()) {
      yield path
    }
  }
}

/**
 * Count the files a pass over `root` would read: outside excluded and credential folders, not a
 * secret, and of a kind the index reads. Sizes are not checked, so the count is an upper bound.
 * @param root - the folder.
 * @param excludeDirs - folder names skipped anywhere below `root`.
 * @param signal - stops the walk.
 * @returns the count.
 */
export async function countIndexableFiles(root: string, excludeDirs: readonly string[], signal?: AbortSignal): Promise<number> {
  let count = 0
  for await (const path of walkFiles(root, '', excludeDirs)) {
    signal?.throwIfAborted()
    if (isSecretFile(path.slice(path.lastIndexOf('/') + 1))) continue
    if (documentExtension(path) !== undefined || kindOf(path) !== undefined) count += 1
  }
  return count
}

/** The knowledge index over the configured collections. */
export class KnowledgeIndex {
  private readonly statements: undefined | {
    fileByPath: StatementSync
    insertFile: StatementSync
    updateFile: StatementSync
    passagesOfFile: StatementSync
    deleteFts: StatementSync
    deletePassages: StatementSync
    deleteFile: StatementSync
    insertPassage: StatementSync
    insertFts: StatementSync
    summaryOf: StatementSync
    deleteSummaryFts: StatementSync
    deleteSummary: StatementSync
    insertSummary: StatementSync
    insertSummaryFts: StatementSync
  }

  private running: Promise<KnowledgeIndexReport> | undefined

  /** Every stored vector, loaded on the first search by meaning and dropped on any change. */
  private vectorCache: { ids: number[]; data: Int8Array; dims: number } | undefined

  private constructor(
    private readonly db: DatabaseSync | undefined,
    private readonly options: KnowledgeIndexOptions,
    private collections: readonly KnowledgeCollection[],
  ) {
    this.statements = db === undefined ? undefined : {
      fileByPath: db.prepare('SELECT id, size, mtime_ms FROM files WHERE collection = ? AND path = ?'),
      insertFile: db.prepare('INSERT INTO files (collection, path, size, mtime_ms, kind) VALUES (?, ?, ?, ?, ?) RETURNING id'),
      updateFile: db.prepare('UPDATE files SET size = ?, mtime_ms = ?, kind = ? WHERE id = ?'),
      passagesOfFile: db.prepare('SELECT id, text, heading, path, collection, kind FROM passages WHERE file_id = ?'),
      deleteFts: db.prepare("INSERT INTO passages_fts (passages_fts, rowid, text, heading, path, collection, kind) VALUES ('delete', ?, ?, ?, ?, ?, ?)"),
      deletePassages: db.prepare('DELETE FROM passages WHERE file_id = ?'),
      deleteFile: db.prepare('DELETE FROM files WHERE id = ?'),
      insertPassage: db.prepare(
        'INSERT INTO passages (file_id, heading, start_line, end_line, kind, text, path, collection) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id',
      ),
      insertFts: db.prepare('INSERT INTO passages_fts (rowid, text, heading, path, collection, kind) VALUES (?, ?, ?, ?, ?, ?)'),
      summaryOf: db.prepare('SELECT summary, tags, path, collection, type FROM summaries WHERE file_id = ?'),
      deleteSummaryFts: db.prepare("INSERT INTO summaries_fts (summaries_fts, rowid, summary, tags, path, collection, type) VALUES ('delete', ?, ?, ?, ?, ?, ?)"),
      deleteSummary: db.prepare('DELETE FROM summaries WHERE file_id = ?'),
      insertSummary: db.prepare(
        'INSERT INTO summaries (file_id, collection, path, type, tags, summary, model, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ),
      insertSummaryFts: db.prepare('INSERT INTO summaries_fts (rowid, summary, tags, path, collection, type) VALUES (?, ?, ?, ?, ?, ?)'),
    }
  }

  /**
   * Open or create the index database; an index written by another schema version is emptied.
   * @param options - database path and limits.
   * @param collections - the configured collections.
   * @returns the open index.
   */
  static async open(options: KnowledgeIndexOptions, collections: readonly KnowledgeCollection[]): Promise<KnowledgeIndex> {
    // Without a collection there is nothing to index: SQLite is never loaded and no file is created.
    if (collections.length === 0) return new KnowledgeIndex(undefined, options, collections)
    const path = options.path === ':memory:' ? options.path : resolve(options.path)
    if (path !== ':memory:') {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      try {
        const handle = await open(path, 'wx', 0o600)
        await handle.close()
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
    }
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(path)
    try {
      const { application_id: applicationId } = db.prepare('PRAGMA application_id').get() as { application_id: number }
      const { user_version: version } = db.prepare('PRAGMA user_version').get() as { user_version: number }
      const tables = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").get() as { n: number }
      if (applicationId !== 0 && applicationId !== KNOWLEDGE_APPLICATION_ID) {
        throw new Error(`knowledge: database at "${path}" belongs to another application`)
      }
      if (applicationId === 0 && tables.n > 0) {
        throw new Error(`knowledge: database at "${path}" is not a knowledge index`)
      }
      if (version !== KNOWLEDGE_SCHEMA_VERSION) {
        db.exec([
          'DROP TABLE IF EXISTS vectors; DROP TABLE IF EXISTS folders_fts; DROP TABLE IF EXISTS folders;',
          'DROP TABLE IF EXISTS documents; DROP TABLE IF EXISTS summaries_fts; DROP TABLE IF EXISTS summaries;',
          'DROP TABLE IF EXISTS passages_fts; DROP TABLE IF EXISTS passages; DROP TABLE IF EXISTS files;',
        ].join(' '))
      }
      db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA application_id = ${KNOWLEDGE_APPLICATION_ID};
        PRAGMA user_version = ${KNOWLEDGE_SCHEMA_VERSION};
        CREATE TABLE IF NOT EXISTS files (
          id INTEGER PRIMARY KEY, collection TEXT NOT NULL, path TEXT NOT NULL,
          size INTEGER NOT NULL, mtime_ms INTEGER NOT NULL, kind TEXT NOT NULL,
          UNIQUE (collection, path)
        );
        CREATE TABLE IF NOT EXISTS passages (
          id INTEGER PRIMARY KEY, file_id INTEGER NOT NULL, heading TEXT NOT NULL,
          start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL,
          path TEXT NOT NULL, collection TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS passages_file ON passages (file_id);
        CREATE VIRTUAL TABLE IF NOT EXISTS passages_fts USING fts5(
          text, heading, path, collection UNINDEXED, kind UNINDEXED,
          content = 'passages', content_rowid = 'id',
          tokenize = "porter unicode61 tokenchars '_'"
        );
        INSERT INTO passages_fts (passages_fts, rank) VALUES ('rank', 'bm25(1.0, 3.0, 2.0)');
        CREATE TABLE IF NOT EXISTS summaries (
          file_id INTEGER PRIMARY KEY, collection TEXT NOT NULL, path TEXT NOT NULL, type TEXT NOT NULL,
          tags TEXT NOT NULL, summary TEXT NOT NULL, model TEXT NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS summaries_fts USING fts5(
          summary, tags, path, collection UNINDEXED, type UNINDEXED,
          content = 'summaries', content_rowid = 'file_id',
          tokenize = "porter unicode61 tokenchars '_'"
        );
        INSERT INTO summaries_fts (summaries_fts, rank) VALUES ('rank', 'bm25(1.0, 2.0, 2.0)');
        CREATE TABLE IF NOT EXISTS documents (file_id INTEGER PRIMARY KEY, text TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS vectors (passage_id INTEGER PRIMARY KEY, vec BLOB NOT NULL);
        CREATE TABLE IF NOT EXISTS folders (
          id INTEGER PRIMARY KEY, collection TEXT NOT NULL, folder TEXT NOT NULL, tags TEXT NOT NULL,
          summary TEXT NOT NULL, fingerprint TEXT NOT NULL, model TEXT NOT NULL, updated_at INTEGER NOT NULL,
          UNIQUE (collection, folder)
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS folders_fts USING fts5(
          summary, tags, folder, collection UNINDEXED,
          content = 'folders', content_rowid = 'id',
          tokenize = "porter unicode61 tokenchars '_'"
        );
      `)
    } catch (error) {
      db.close()
      throw error
    }
    return new KnowledgeIndex(db, options, collections)
  }

  /** The configured collections. */
  get configured(): readonly KnowledgeCollection[] {
    return this.collections
  }

  /**
   * Replace the collections this index keeps. A pass already running
   * finishes over the previous list; the next pass indexes the new list and
   * removes the files of a collection no longer in it.
   * @param collections - the new list.
   * @throws when the index was opened without collections, so without a database.
   */
  setCollections(collections: readonly KnowledgeCollection[]): void {
    if (this.db === undefined) throw new Error('knowledge: an index opened without collections has no database; open it with them instead')
    this.collections = collections
  }

  /**
   * Wait for the pass in progress, when there is one.
   * @returns resolution once no pass runs; a failed pass resolves it too.
   */
  idle(): Promise<void> {
    return this.running === undefined ? Promise.resolve() : this.running.then(() => undefined, () => undefined)
  }

  /** Close the database. */
  close(): void {
    this.db?.close()
  }

  /** The open database and its statements; only reached with at least one collection configured. */
  private get open(): { db: DatabaseSync; statements: NonNullable<KnowledgeIndex['statements']> } {
    if (this.db === undefined || this.statements === undefined) throw new Error('knowledge: no collection is configured')
    return { db: this.db, statements: this.statements }
  }

  /**
   * Bring the index up to date with the files on disk. Concurrent calls share one pass.
   * @param signal - stops the pass between files.
   * @param only - index just this collection.
   * @returns counts for the pass.
   */
  update(signal?: AbortSignal, only?: string): Promise<KnowledgeIndexReport> {
    if (this.db === undefined) return Promise.resolve({ indexed: 0, unchanged: 0, removed: 0, skipped: 0, durationMs: 0 })
    this.running ??= this.pass(signal, only).finally(() => {
      this.running = undefined
    })
    return this.running
  }

  private async pass(signal: AbortSignal | undefined, only: string | undefined): Promise<KnowledgeIndexReport> {
    const { db, statements } = this.open
    const started = Date.now()
    const counts = { indexed: 0, unchanged: 0, removed: 0, skipped: 0 }
    const names = new Set(this.collections.map(collection => collection.name))
    for (const row of db.prepare('SELECT DISTINCT collection FROM files').all() as { collection: string }[]) {
      if (!names.has(row.collection)) counts.removed += this.dropCollection(row.collection)
    }
    for (const collection of this.collections) {
      if (only !== undefined && collection.name !== only) continue
      const seen = new Set<string>()
      let sinceYield = 0
      for await (const path of this.walk(collection.root, '')) {
        signal?.throwIfAborted()
        if (++sinceYield >= 25) {
          sinceYield = 0
          await yieldTurn()
        }
        if (isSecretFile(path.slice(path.lastIndexOf('/') + 1))) {
          counts.skipped += 1
          continue
        }
        const document = documentExtension(path)
        const kind = document === undefined ? kindOf(path) : 'text'
        if (kind === undefined) {
          counts.skipped += 1
          continue
        }
        const absolute = join(collection.root, path)
        let info: Awaited<ReturnType<typeof stat>>
        try {
          info = await stat(absolute)
        } catch (_vanished) {
          // The file disappeared between listing and reading; the next pass sees its absence.
          continue
        }
        if (info.size > (document === undefined ? this.options.maxFileBytes : this.options.maxDocumentBytes)) {
          counts.skipped += 1
          continue
        }
        seen.add(path)
        const mtime = Math.trunc(info.mtimeMs)
        const existing = statements.fileByPath.get(collection.name, path) as { id: number; size: number; mtime_ms: number } | undefined
        if (existing !== undefined && existing.size === info.size && existing.mtime_ms === mtime) {
          counts.unchanged += 1
          continue
        }
        let text: string
        try {
          text = document === undefined ? await readFile(absolute, 'utf8') : await extractDocument(document, await readFile(absolute))
        } catch (_unreadable) {
          // A corrupt or password-protected document has no text to index; it is counted as skipped.
          text = ''
        }
        if (text.includes('\u0000') || text.trim().length === 0) {
          counts.skipped += 1
          seen.delete(path)
          if (existing !== undefined) this.dropFile(existing.id)
          continue
        }
        this.replaceFile(collection.name, path, info.size, mtime, kind, text, existing?.id, document !== undefined)
        counts.indexed += 1
      }
      const stored = db.prepare('SELECT id, path FROM files WHERE collection = ?').all(collection.name) as { id: number; path: string }[]
      for (const row of stored) {
        if (seen.has(row.path)) continue
        this.dropFile(row.id)
        counts.removed += 1
      }
    }
    return { ...counts, durationMs: Date.now() - started }
  }

  private walk(root: string, prefix: string): AsyncGenerator<string> {
    return walkFiles(root, prefix, this.options.excludeDirs)
  }

  private replaceFile(
    collection: string,
    path: string,
    size: number,
    mtime: number,
    kind: KnowledgePassageKind,
    text: string,
    existingId: number | undefined,
    extracted: boolean = false,
  ): void {
    const chunks = chunkFile(text, kind, this.options.bounds, extracted || usesMarkdownHeadings(path))
    const { db, statements } = this.open
    db.exec('BEGIN')
    try {
      let fileId = existingId
      if (fileId === undefined) {
        fileId = (statements.insertFile.get(collection, path, size, mtime, kind) as { id: number }).id
      } else {
        this.clearPassages(fileId)
        statements.updateFile.run(size, mtime, kind, fileId)
      }
      for (const chunk of chunks) {
        const { id } = statements.insertPassage.get(
          fileId, chunk.heading, chunk.startLine, chunk.endLine, kind, chunk.text, path, collection,
        ) as { id: number }
        statements.insertFts.run(id, chunk.text, chunk.heading, path, collection, kind)
      }
      if (extracted) db.prepare('INSERT INTO documents (file_id, text) VALUES (?, ?)').run(fileId, text)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  private clearPassages(fileId: number): void {
    // External-content FTS5 removes a row only when given the values it indexed.
    type Row = { id: number; text: string; heading: string; path: string; collection: string; kind: string }
    const { statements } = this.open
    for (const row of statements.passagesOfFile.all(fileId) as Row[]) {
      statements.deleteFts.run(row.id, row.text, row.heading, row.path, row.collection, row.kind)
    }
    this.open.db.prepare('DELETE FROM vectors WHERE passage_id IN (SELECT id FROM passages WHERE file_id = ?)').run(fileId)
    this.vectorCache = undefined
    statements.deletePassages.run(fileId)
    this.open.db.prepare('DELETE FROM documents WHERE file_id = ?').run(fileId)
    this.clearSummary(fileId)
  }

  private clearSummary(fileId: number): void {
    const { statements } = this.open
    type Row = { summary: string; tags: string; path: string; collection: string; type: string }
    const row = statements.summaryOf.get(fileId) as Row | undefined
    if (row === undefined) return
    statements.deleteSummaryFts.run(fileId, row.summary, row.tags, row.path, row.collection, row.type)
    statements.deleteSummary.run(fileId)
  }

  /**
   * Files that have no summary yet, oldest first.
   * @param limit - most files to return.
   * @param collection - only this collection.
   * @returns the waiting files.
   */
  pendingSummaries(limit: number, collection?: string): KnowledgePendingFile[] {
    if (this.db === undefined) return []
    const filter = collection === undefined ? '' : ' AND f.collection = ?'
    const rows = this.db.prepare(`
      SELECT f.id AS fileId, f.collection AS collection, f.path AS path, f.kind AS kind
      FROM files f LEFT JOIN summaries s ON s.file_id = f.id
      WHERE s.file_id IS NULL${filter} ORDER BY f.id LIMIT ?
    `).all(...collection === undefined ? [limit] : [collection, limit]) as unknown as KnowledgePendingFile[]
    return rows.map(row => ({ ...row }))
  }

  /**
   * Count files that have no summary yet.
   * @param collection - only this collection.
   * @returns the count.
   */
  pendingCount(collection?: string): number {
    if (this.db === undefined) return 0
    const filter = collection === undefined ? '' : ' WHERE f.collection = ?'
    const row = this.db.prepare(`
      SELECT count(*) AS n FROM files f LEFT JOIN summaries s ON s.file_id = f.id
      ${filter.length === 0 ? 'WHERE' : `${filter} AND`} s.file_id IS NULL
    `).get(...collection === undefined ? [] : [collection]) as { n: number }
    return row.n
  }

  /**
   * The text an enrichment request shows for one file: its section headings and its opening passages.
   * @param fileId - the file.
   * @param maxChars - most characters of passage text.
   * @returns the heading outline and the text, both empty for an unknown file.
   */
  summaryInput(fileId: number, maxChars: number): { headings: string[]; text: string } {
    const rows = this.open.db.prepare('SELECT heading, text FROM passages WHERE file_id = ? ORDER BY start_line')
      .all(fileId) as { heading: string; text: string }[]
    const headings = [...new Set(rows.map(row => row.heading).filter(heading => heading.length > 0))].slice(0, 40)
    let text = ''
    for (const row of rows) {
      if (text.length >= maxChars) break
      text += `${text.length === 0 ? '' : '\n\n'}${row.text}`
    }
    return { headings, text: text.slice(0, maxChars) }
  }

  /**
   * Store a file's summary, replacing any earlier one. A file that no longer exists is ignored.
   * @param fileId - the file.
   * @param summary - its type, tags, and summary.
   * @param model - the `provider/model` that wrote it.
   * @returns whether the summary was stored.
   */
  saveSummary(fileId: number, summary: KnowledgeFileSummary, model: string): boolean {
    const { db, statements } = this.open
    const file = db.prepare('SELECT collection, path FROM files WHERE id = ?').get(fileId) as { collection: string; path: string } | undefined
    if (file === undefined) return false
    const tags = summary.tags.join(' ')
    db.exec('BEGIN')
    try {
      this.clearSummary(fileId)
      statements.insertSummary.run(fileId, file.collection, file.path, summary.type, tags, summary.summary, model, Date.now())
      statements.insertSummaryFts.run(fileId, summary.summary, tags, file.path, file.collection, summary.type)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    return true
  }

  /**
   * Rank file summaries against free text.
   * @param request - the query, optional collection, and limit.
   * @returns matching files, best first.
   */
  searchSummaries(request: { query: string; collection?: string; limit: number }): KnowledgeSummaryHit[] {
    const match = matchExpression(request.query)
    if (match === undefined || this.db === undefined) return []
    const filter = request.collection === undefined ? '' : ' AND f.collection = ?'
    const rows = this.db.prepare(`
      SELECT s.collection AS collection, s.path AS path, s.type AS type, s.tags AS tags, s.summary AS summary, top.rank AS rank
      FROM (
        SELECT f.rowid AS id, f.rank AS rank FROM summaries_fts f
        WHERE summaries_fts MATCH ?${filter} ORDER BY f.rank LIMIT ?
      ) AS top JOIN summaries s ON s.file_id = top.id
      ORDER BY top.rank
    `).all(...request.collection === undefined ? [match, request.limit] : [match, request.collection, request.limit]) as {
      collection: string
      path: string
      type: KnowledgeFileType
      tags: string
      summary: string
      rank: number
    }[]
    return rows.map(row => ({
      collection: row.collection,
      path: row.path,
      ref: `${row.collection}:${row.path}`,
      type: row.type,
      tags: row.tags.length === 0 ? [] : row.tags.split(' '),
      summary: row.summary,
      score: Math.round(-row.rank * 1000) / 1000,
    }))
  }

  /**
   * Files of a collection that carry a topic tag, with their summaries.
   * @param collection - the collection.
   * @param tag - the tag.
   * @param limit - most files to return.
   * @returns the files, in path order.
   */
  filesWithTag(collection: string, tag: string, limit: number): KnowledgeBrowseEntry[] {
    if (this.db === undefined) return []
    const rows = this.db.prepare(`
      SELECT path, type, tags, summary FROM summaries
      WHERE collection = ? AND (' ' || tags || ' ') LIKE ? ORDER BY path LIMIT ?
    `).all(collection, `% ${tag.toLowerCase()} %`, limit) as { path: string; type: KnowledgeFileType; tags: string; summary: string }[]
    return rows.map(row => ({
      path: row.path,
      type: 'file' as const,
      files: 1,
      summary: { type: row.type, tags: row.tags.split(' '), summary: row.summary },
    }))
  }

  private dropFile(fileId: number): void {
    const { db, statements } = this.open
    db.exec('BEGIN')
    try {
      this.clearPassages(fileId)
      statements.deleteFile.run(fileId)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  private dropCollection(name: string): number {
    const { db } = this.open
    const rows = db.prepare('SELECT id FROM files WHERE collection = ?').all(name) as { id: number }[]
    for (const row of rows) this.dropFile(row.id)
    for (const folder of db.prepare('SELECT id, summary, tags, folder, collection FROM folders WHERE collection = ?').all(name) as {
      id: number
      summary: string
      tags: string
      folder: string
      collection: string
    }[]) {
      db.prepare("INSERT INTO folders_fts (folders_fts, rowid, summary, tags, folder, collection) VALUES ('delete', ?, ?, ?, ?, ?)")
        .run(folder.id, folder.summary, folder.tags, folder.folder, folder.collection)
      db.prepare('DELETE FROM folders WHERE id = ?').run(folder.id)
    }
    return rows.length
  }

  /**
   * Rank passages against free text.
   * @param request - the query, optional filters, and limit.
   * @returns hits, best first; empty when the query has no meaningful word.
   */
  search(request: KnowledgeSearchRequest): KnowledgeHit[] {
    return this.lexical(request).map(({ id: _id, ...hit }) => hit)
  }

  /**
   * Rank passages by words and, when embeddings are configured and stored, by meaning, merged by
   * reciprocal rank fusion. A failed embedding request falls back to the word ranking.
   * @param request - the query, optional filters, and limit.
   * @param signal - cancellation of the query embedding.
   * @returns hits, best first, and whether the ranking used meaning.
   */
  async searchHybrid(request: KnowledgeSearchRequest, signal: AbortSignal): Promise<{ hits: KnowledgeHit[]; semantic: boolean }> {
    const embeddings = this.options.embeddings
    if (embeddings === undefined || this.db === undefined || this.vectorCount() === 0) {
      return { hits: this.search(request), semantic: false }
    }
    let queryVector: Int8Array
    try {
      const [vector] = await embedTexts(embeddings, [request.query], signal)
      if (vector === undefined) return { hits: this.search(request), semantic: false }
      queryVector = quantize(vector)
    } catch (error) {
      if (signal.aborted) throw error
      return { hits: this.search(request), semantic: false }
    }
    const cache = this.loadVectors()
    if (cache.dims !== queryVector.length) return { hits: this.search(request), semantic: false }
    const lexicalIds = this.lexical({ ...request, limit: FUSION_DEPTH }).map(hit => hit.id)
    const allowed = (id: number): boolean => {
      const row = this.db?.prepare('SELECT collection, kind FROM passages WHERE id = ?').get(id) as { collection: string; kind: string } | undefined
      return row !== undefined
        && (request.collection === undefined || row.collection === request.collection)
        && (request.kind === undefined || row.kind === request.kind)
    }
    const semanticIds = nearest(queryVector, cache.ids, cache.data, FUSION_DEPTH * 4).filter(allowed).slice(0, FUSION_DEPTH)
    const ids = fuse([lexicalIds, semanticIds]).slice(0, request.limit)
    return { hits: this.hitsFor(ids), semantic: true }
  }

  /** Passages ranked by BM25 over the words of the query, each carrying its passage id. */
  private lexical(request: KnowledgeSearchRequest): (KnowledgeHit & { id: number })[] {
    const match = matchExpression(request.query)
    if (match === undefined || this.db === undefined) return []
    const filters: string[] = []
    const params: (string | number)[] = [match]
    if (request.collection !== undefined) {
      filters.push('f.collection = ?')
      params.push(request.collection)
    }
    if (request.kind !== undefined) {
      filters.push('f.kind = ?')
      params.push(request.kind)
    }
    params.push(request.limit)
    // Rank and cut inside FTS5 first, then join only the kept rows.
    const rows = this.open.db.prepare(`
      SELECT p.id AS id, p.collection AS collection, p.path AS path, p.heading AS heading, p.start_line AS startLine,
             p.end_line AS endLine, p.kind AS kind, p.text AS text, top.rank AS rank
      FROM (
        SELECT f.rowid AS id, f.rank AS rank FROM passages_fts f
        WHERE passages_fts MATCH ?${filters.map(filter => ` AND ${filter}`).join('')}
        ORDER BY f.rank LIMIT ?
      ) AS top JOIN passages p ON p.id = top.id
      ORDER BY top.rank
    `).all(...params) as {
      id: number
      collection: string
      path: string
      heading: string
      startLine: number
      endLine: number
      kind: KnowledgePassageKind
      text: string
      rank: number
    }[]
    return rows.map(row => ({
      id: row.id,
      collection: row.collection,
      path: row.path,
      heading: row.heading,
      startLine: row.startLine,
      endLine: row.endLine,
      kind: row.kind,
      text: row.text.length > this.options.hitChars ? `${row.text.slice(0, this.options.hitChars)}…` : row.text,
      ref: `${row.collection}:${row.path}#L${row.startLine}-L${row.endLine}`,
      score: Math.round(-row.rank * 1000) / 1000,
    }))
  }

  /** Hits for passage ids, in the given order; the score is the position's reciprocal. */
  private hitsFor(ids: readonly number[]): KnowledgeHit[] {
    const db = this.open.db
    const hits: KnowledgeHit[] = []
    ids.forEach((id, position) => {
      const row = db.prepare('SELECT collection, path, heading, start_line AS startLine, end_line AS endLine, kind, text FROM passages WHERE id = ?').get(id) as {
        collection: string
        path: string
        heading: string
        startLine: number
        endLine: number
        kind: KnowledgePassageKind
        text: string
      } | undefined
      if (row === undefined) return
      hits.push({
        ...row,
        text: row.text.length > this.options.hitChars ? `${row.text.slice(0, this.options.hitChars)}…` : row.text,
        ref: `${row.collection}:${row.path}#L${row.startLine}-L${row.endLine}`,
        score: Math.round(1000 / (position + 1)) / 1000,
      })
    })
    return hits
  }

  /**
   * Count stored passage vectors.
   * @returns the count; 0 without a database.
   */
  vectorCount(): number {
    return this.db === undefined ? 0 : (this.db.prepare('SELECT count(*) AS n FROM vectors').get() as { n: number }).n
  }

  /**
   * Count passages that have no vector yet.
   * @param collection - only this collection.
   * @returns the count.
   */
  pendingVectorCount(collection?: string): number {
    if (this.db === undefined) return 0
    const filter = collection === undefined ? '' : ' AND p.collection = ?'
    return (this.db.prepare(`SELECT count(*) AS n FROM passages p LEFT JOIN vectors v ON v.passage_id = p.id WHERE v.passage_id IS NULL${filter}`)
      .get(...collection === undefined ? [] : [collection]) as { n: number }).n
  }

  /**
   * Embed up to `limit` passages that have no vector, `batchSize` per request.
   * @param limit - most passages to embed.
   * @param signal - stops the run between batches.
   * @param collection - only this collection.
   * @returns passages embedded, batches that failed, and passages still waiting.
   * @throws when no embedding endpoint is configured.
   */
  async embedPassages(
    limit: number,
    signal: AbortSignal,
    collection?: string,
  ): Promise<{ embedded: number; failed: number; remaining: number }> {
    const embeddings = this.options.embeddings
    if (embeddings === undefined) throw new Error('knowledge: no embedding endpoint is configured')
    const db = this.open.db
    const filter = collection === undefined ? '' : ' AND p.collection = ?'
    const rows = db.prepare(`
      SELECT p.id AS id, p.heading AS heading, p.text AS text FROM passages p LEFT JOIN vectors v ON v.passage_id = p.id
      WHERE v.passage_id IS NULL${filter} ORDER BY p.id LIMIT ?
    `).all(...collection === undefined ? [limit] : [collection, limit]) as { id: number; heading: string; text: string }[]
    let embedded = 0
    let failed = 0
    const insert = db.prepare('INSERT OR REPLACE INTO vectors (passage_id, vec) VALUES (?, ?)')
    for (let start = 0; start < rows.length; start += embeddings.batchSize) {
      signal.throwIfAborted()
      const batch = rows.slice(start, start + embeddings.batchSize)
      try {
        const vectors = await embedTexts(embeddings, batch.map(row => `${row.heading}\n${row.text}`.trim().slice(0, EMBED_CHARS)), signal)
        db.exec('BEGIN')
        try {
          batch.forEach((row, index) => {
            const vector = vectors[index]
            if (vector !== undefined) insert.run(row.id, quantize(vector))
          })
          db.exec('COMMIT')
        } catch (error) {
          db.exec('ROLLBACK')
          throw error
        }
        embedded += batch.length
        this.vectorCache = undefined
      } catch (error) {
        if (signal.aborted) throw error
        failed += 1
      }
    }
    return { embedded, failed, remaining: this.pendingVectorCount(collection) }
  }

  private loadVectors(): { ids: number[]; data: Int8Array; dims: number } {
    if (this.vectorCache !== undefined) return this.vectorCache
    const rows = this.open.db.prepare('SELECT passage_id AS id, vec FROM vectors ORDER BY passage_id').all() as { id: number; vec: Uint8Array }[]
    const dims = rows[0]?.vec.byteLength ?? 0
    const data = new Int8Array(rows.length * dims)
    const ids: number[] = []
    for (const row of rows) {
      if (row.vec.byteLength !== dims) continue
      data.set(new Int8Array(row.vec.buffer, row.vec.byteOffset, dims), ids.length * dims)
      ids.push(row.id)
    }
    this.vectorCache = { ids, data: data.subarray(0, ids.length * dims), dims }
    return this.vectorCache
  }

  /**
   * Read a slice of one file under a collection, from disk.
   * @param collection - the collection name.
   * @param path - the file path relative to the collection root.
   * @param startLine - first line, 1-based (default 1).
   * @param endLine - last line, inclusive; bounded by `maxReadLines`.
   * @returns the slice and the file's line count.
   * @throws for an unknown collection, a path outside the root, or a missing file.
   */
  async read(collection: string, path: string, startLine: number = 1, endLine?: number): Promise<KnowledgeRead> {
    const configured = this.collections.find(entry => entry.name === collection)
    if (configured === undefined) throw new Error(`knowledge: unknown collection ${JSON.stringify(collection)}`)
    const absolute = insideRoot(configured.root, path)
    // A PDF, Word, or EPUB file is read as the text its indexing extracted, so line numbers match the refs.
    const stored = this.db?.prepare('SELECT d.text AS text FROM documents d JOIN files f ON f.id = d.file_id WHERE f.collection = ? AND f.path = ?')
      .get(collection, path) as { text: string } | undefined
    const text = stored?.text ?? await readFile(absolute, 'utf8')
    const lines = text.replace(/\r\n?/gu, '\n').split('\n')
    const first = Math.max(1, Math.min(startLine, lines.length))
    const last = Math.min(lines.length, endLine ?? first + this.options.maxReadLines - 1, first + this.options.maxReadLines - 1)
    return {
      collection,
      path,
      startLine: first,
      endLine: last,
      totalLines: lines.length,
      text: lines.slice(first - 1, last).map((line, index) => `${first + index}: ${line}`).join('\n'),
    }
  }

  /**
   * List the folders and files directly under a folder of a collection.
   * @param collection - the collection name.
   * @param prefix - folder path relative to the root; empty for the root.
   * @returns folders first, then files, each with its file count.
   */
  browse(collection: string, prefix: string = ''): KnowledgeBrowseEntry[] {
    const folder = prefix.replace(/^\/+|\/+$/gu, '')
    const like = folder.length === 0 ? '%' : `${folder.replaceAll('%', '\\%').replaceAll('_', '\\_')}/%`
    if (this.db === undefined) return []
    const rows = this.db.prepare("SELECT path FROM files WHERE collection = ? AND path LIKE ? ESCAPE '\\'").all(collection, like) as { path: string }[]
    const folders = new Map<string, number>()
    const files: KnowledgeBrowseEntry[] = []
    for (const { path } of rows) {
      const rest = folder.length === 0 ? path : path.slice(folder.length + 1)
      const slash = rest.indexOf('/')
      if (slash === -1) files.push({ path, type: 'file', files: 1, ...this.summaryFor(collection, path) })
      else {
        const child = folder.length === 0 ? rest.slice(0, slash) : `${folder}/${rest.slice(0, slash)}`
        folders.set(child, (folders.get(child) ?? 0) + 1)
      }
    }
    return [
      ...[...folders].sort(([left], [right]) => left.localeCompare(right)).map(([path, count]) => {
        const rollup = this.folderSummary(collection, path)
        return {
          path,
          type: 'folder' as const,
          files: count,
          ...rollup === undefined ? {} : { summary: { type: 'other' as const, tags: rollup.tags, summary: rollup.summary } },
        }
      }),
      ...files.sort((left, right) => left.path.localeCompare(right.path)),
    ]
  }

  /**
   * Folders whose rollup is missing or stale, deepest first: every folder (the root included)
   * with at least `minChildren` direct children that have a summary or a rollup.
   * @param minChildren - fewest summarized children a folder needs.
   * @param collection - only this collection.
   * @returns the folders with their children's summary lines.
   */
  staleFolders(minChildren: number, collection?: string): KnowledgeFolderInput[] {
    const db = this.db
    if (db === undefined) return []
    type FileRow = { collection: string; path: string; type: string; tags: string; summary: string; updated_at: number }
    const files = db.prepare(`SELECT collection, path, type, tags, summary, updated_at FROM summaries${collection === undefined ? '' : ' WHERE collection = ?'}`)
      .all(...collection === undefined ? [] : [collection]) as FileRow[]
    const rollups = new Map((db.prepare('SELECT collection, folder, tags, summary, fingerprint, updated_at FROM folders').all() as {
      collection: string
      folder: string
      tags: string
      summary: string
      fingerprint: string
      updated_at: number
    }[]).map(row => [`${row.collection}\u0000${row.folder}`, row]))
    const parentOf = (path: string): string => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')
    const children = new Map<string, { name: string; line: string; stamp: string }[]>()
    const add = (collectionName: string, folder: string, entry: { name: string; line: string; stamp: string }): void => {
      const key = `${collectionName}\u0000${folder}`
      const list = children.get(key) ?? []
      list.push(entry)
      children.set(key, list)
    }
    for (const file of files) {
      const name = file.path.slice(file.path.lastIndexOf('/') + 1)
      add(file.collection, parentOf(file.path), {
        name,
        line: `${name} (${file.type}; ${file.tags.split(' ').join(', ')}): ${file.summary}`,
        stamp: `${name}:${file.updated_at}`,
      })
    }
    // Every folder that holds summarized files, and every ancestor of one, deepest first.
    const folders = new Set<string>()
    for (const key of children.keys()) {
      const [collectionName, folder] = key.split('\u0000') as [string, string]
      let current = folder
      folders.add(`${collectionName}\u0000${current}`)
      while (current.length > 0) {
        current = parentOf(current)
        folders.add(`${collectionName}\u0000${current}`)
      }
    }
    const ordered = [...folders].sort((left, right) => right.split('/').length - left.split('/').length || left.localeCompare(right))
    // A subfolder's existing rollup counts as a child line of its parent.
    for (const key of ordered) {
      const [collectionName, folder] = key.split('\u0000') as [string, string]
      if (folder.length === 0) continue
      const rollup = rollups.get(key)
      if (rollup === undefined) continue
      const name = folder.slice(folder.lastIndexOf('/') + 1)
      add(collectionName, parentOf(folder), {
        name: `${name}/`,
        line: `${name}/ (folder; ${rollup.tags.split(' ').join(', ')}): ${rollup.summary}`,
        stamp: `${name}/:${rollup.updated_at}`,
      })
    }
    const stale: KnowledgeFolderInput[] = []
    for (const key of ordered) {
      const entries = (children.get(key) ?? []).sort((left, right) => left.name.localeCompare(right.name))
      if (entries.length < minChildren) continue
      const fingerprint = entries.map(entry => entry.stamp).join('|')
      if (rollups.get(key)?.fingerprint === fingerprint) continue
      const [collectionName, folder] = key.split('\u0000') as [string, string]
      stale.push({ collection: collectionName, folder, fingerprint, lines: entries.map(entry => entry.line) })
    }
    return stale
  }

  /**
   * Store a folder's rollup, replacing any earlier one.
   * @param input - the folder and the fingerprint its rollup was written from.
   * @param rollup - its tags and summary.
   * @param model - the `provider/model` that wrote it.
   */
  saveFolder(input: Pick<KnowledgeFolderInput, 'collection' | 'folder' | 'fingerprint'>, rollup: { tags: readonly string[]; summary: string }, model: string): void {
    const { db } = this.open
    const tags = rollup.tags.join(' ')
    db.exec('BEGIN')
    try {
      const old = db.prepare('SELECT id, summary, tags, folder, collection FROM folders WHERE collection = ? AND folder = ?')
        .get(input.collection, input.folder) as { id: number; summary: string; tags: string; folder: string; collection: string }
          | undefined
      if (old !== undefined) {
        db.prepare("INSERT INTO folders_fts (folders_fts, rowid, summary, tags, folder, collection) VALUES ('delete', ?, ?, ?, ?, ?)")
          .run(old.id, old.summary, old.tags, old.folder, old.collection)
        db.prepare('DELETE FROM folders WHERE id = ?').run(old.id)
      }
      const { id } = db.prepare('INSERT INTO folders (collection, folder, tags, summary, fingerprint, model, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id')
        .get(input.collection, input.folder, tags, rollup.summary, input.fingerprint, model, Date.now()) as { id: number }
      db.prepare('INSERT INTO folders_fts (rowid, summary, tags, folder, collection) VALUES (?, ?, ?, ?, ?)')
        .run(id, rollup.summary, tags, input.folder, input.collection)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  /**
   * Rank folder rollups against free text.
   * @param request - the query, optional collection, and limit.
   * @returns matching folders, best first.
   */
  searchFolders(request: { query: string; collection?: string; limit: number }): KnowledgeFolderHit[] {
    const match = matchExpression(request.query)
    if (match === undefined || this.db === undefined) return []
    const filter = request.collection === undefined ? '' : ' AND folders_fts.collection = ?'
    const rows = this.db.prepare(`
      SELECT f.collection AS collection, f.folder AS folder, f.tags AS tags, f.summary AS summary, bm25(folders_fts) AS rank
      FROM folders_fts JOIN folders f ON f.id = folders_fts.rowid
      WHERE folders_fts MATCH ?${filter} ORDER BY rank LIMIT ?
    `).all(...request.collection === undefined ? [match, request.limit] : [match, request.collection, request.limit]) as {
      collection: string
      folder: string
      tags: string
      summary: string
      rank: number
    }[]
    return rows.map(row => ({
      collection: row.collection,
      folder: row.folder,
      ref: `${row.collection}:${row.folder.length === 0 ? '' : `${row.folder}/`}`,
      tags: row.tags.length === 0 ? [] : row.tags.split(' '),
      summary: row.summary,
      score: Math.round(-row.rank * 1000) / 1000,
    }))
  }

  /**
   * A folder's rollup, when it has one.
   * @param collection - the collection.
   * @param folder - folder path relative to the root; empty for the root.
   * @returns its tags and summary.
   */
  folderSummary(collection: string, folder: string): { tags: readonly string[]; summary: string } | undefined {
    const row = this.db?.prepare('SELECT tags, summary FROM folders WHERE collection = ? AND folder = ?').get(collection, folder) as
      { tags: string; summary: string } | undefined
    return row === undefined ? undefined : { tags: row.tags.length === 0 ? [] : row.tags.split(' '), summary: row.summary }
  }

  private summaryFor(collection: string, path: string): { summary?: KnowledgeFileSummary } {
    const row = this.db?.prepare('SELECT type, tags, summary FROM summaries WHERE collection = ? AND path = ?')
      .get(collection, path) as { type: KnowledgeFileType; tags: string; summary: string } | undefined
    if (row === undefined) return {}
    return { summary: { type: row.type, tags: row.tags.length === 0 ? [] : row.tags.split(' '), summary: row.summary } }
  }

  /**
   * Counts per configured collection.
   * @returns one entry per configured collection, in configuration order.
   */
  stats(): KnowledgeCollectionStats[] {
    const db = this.db
    if (db === undefined) return []
    return this.collections.map((collection) => {
      const files = db.prepare('SELECT count(*) AS n FROM files WHERE collection = ?').get(collection.name) as { n: number }
      const passages = db.prepare('SELECT count(*) AS n FROM passages p JOIN files f ON f.id = p.file_id WHERE f.collection = ?').get(collection.name) as { n: number }
      const summarized = db.prepare('SELECT count(*) AS n FROM summaries WHERE collection = ?').get(collection.name) as { n: number }
      return { name: collection.name, root: collection.root, files: files.n, passages: passages.n, summarized: summarized.n }
    })
  }
}
