/**
 * Pure types of the knowledge base: configured collections, indexed passages,
 * search hits, and index statistics.
 * @module @deepseek-ai/dsh-knowledge/types
 */

/** One configured folder of documents indexed under a name. */
export interface KnowledgeCollection {
  /** Short name used in citations and filters, such as `policies`. */
  readonly name: string
  /** Absolute folder whose files are indexed, recursively. */
  readonly root: string
}

/** What a passage holds, decided from the file extension at indexing time. */
export type KnowledgePassageKind = 'text' | 'code'

/** One indexed passage: a slice of one file's lines. */
export interface KnowledgePassage {
  /** Collection the file belongs to. */
  readonly collection: string
  /** File path relative to the collection root, with `/` separators. */
  readonly path: string
  /** Heading path or definition line the passage sits under; empty when none. */
  readonly heading: string
  /** First line of the passage, 1-based. */
  readonly startLine: number
  /** Last line of the passage, 1-based and inclusive. */
  readonly endLine: number
  /** Whether the passage comes from a code file or a text document. */
  readonly kind: KnowledgePassageKind
  /** The passage text. */
  readonly text: string
}

/** One search result: a passage and its rank. */
export interface KnowledgeHit extends KnowledgePassage {
  /** Citation of the form `collection:path#Lstart-Lend`. */
  readonly ref: string
  /** Relevance score, higher is better. */
  readonly score: number
}

/** Search request. */
export interface KnowledgeSearchRequest {
  /** Free text; words are matched with prefix matching and ranked by BM25. */
  readonly query: string
  /** Restrict to one collection. */
  readonly collection?: string
  /** Restrict to passages of one kind. */
  readonly kind?: KnowledgePassageKind
  /** Most hits to return. */
  readonly limit: number
}

/** A bounded slice of one indexed file, read from disk. */
export interface KnowledgeRead {
  readonly collection: string
  readonly path: string
  readonly startLine: number
  readonly endLine: number
  /** Total lines in the file. */
  readonly totalLines: number
  readonly text: string
}

/** Counts for one collection. */
export interface KnowledgeCollectionStats {
  readonly name: string
  readonly root: string
  readonly files: number
  readonly passages: number
  /** Files with a current summary. */
  readonly summarized: number
}

/** Outcome of one indexing pass. */
export interface KnowledgeIndexReport {
  /** Files read and (re)indexed because they are new or changed. */
  readonly indexed: number
  /** Files left as they were because size and modification time match. */
  readonly unchanged: number
  /** Files removed from the index because they no longer exist. */
  readonly removed: number
  /** Files skipped: too large, binary, or an unsupported extension. */
  readonly skipped: number
  /** Milliseconds the pass took. */
  readonly durationMs: number
}

/** One entry of a folder listing inside a collection. */
export interface KnowledgeBrowseEntry {
  /** Folder or file path relative to the collection root. */
  readonly path: string
  /** `folder` groups files below it; `file` is one indexed file. */
  readonly type: 'folder' | 'file'
  /** Files under a folder, or 1 for a file. */
  readonly files: number
  /** A file's enrichment, or a folder's rollup, when it has one. */
  readonly summary?: KnowledgeFileSummary
}

/** What a file is, as the enrichment model classifies it. */
export type KnowledgeFileType =
  | 'code' | 'script' | 'tool' | 'tip' | 'cheatsheet' | 'automation' | 'guide' | 'reference' | 'book' | 'note' | 'config' | 'data' | 'other'

/** The enrichment of one file: its type, topic tags, and summary. */
export interface KnowledgeFileSummary {
  /** What the file is. */
  readonly type: KnowledgeFileType
  /** Short lowercase topic tags. */
  readonly tags: readonly string[]
  /** What the file is for and what someone can learn or do with it. */
  readonly summary: string
}

/** A file whose summary matched a search. */
export interface KnowledgeSummaryHit extends KnowledgeFileSummary {
  readonly collection: string
  readonly path: string
  /** Citation of the form `collection:path`. */
  readonly ref: string
  /** Relevance score, higher is better. */
  readonly score: number
}

/** A file waiting for its summary. */
export interface KnowledgePendingFile {
  readonly fileId: number
  readonly collection: string
  readonly path: string
  readonly kind: KnowledgePassageKind
}

/** Outcome of one enrichment run. */
export interface KnowledgeEnrichReport {
  /** Files summarized in this run. */
  readonly summarized: number
  /** Files whose request or answer failed; they stay pending. */
  readonly failed: number
  /** Files still waiting for a summary after the run. */
  readonly remaining: number
  /** Milliseconds the run took. */
  readonly durationMs: number
  /** The first failures, with their messages. */
  readonly failures: readonly { readonly path: string; readonly message: string }[]
}

/** A folder waiting for its rollup: its direct children's summaries. */
export interface KnowledgeFolderInput {
  readonly collection: string
  /** Folder path relative to the collection root; empty for the root. */
  readonly folder: string
  /** Fingerprint of the children's summaries; a changed fingerprint means the rollup is stale. */
  readonly fingerprint: string
  /** Direct children with a summary, as `name (type; tags): summary` lines. */
  readonly lines: readonly string[]
}

/** A folder whose rollup matched a search. */
export interface KnowledgeFolderHit {
  readonly collection: string
  readonly folder: string
  /** Citation of the form `collection:folder/`. */
  readonly ref: string
  readonly tags: readonly string[]
  readonly summary: string
  readonly score: number
}
