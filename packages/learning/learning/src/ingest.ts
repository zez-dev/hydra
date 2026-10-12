/**
 * Pure helpers for `/learn from <path>`: argument parsing, path resolution, the
 * text-file walk with its skip rules, byte-bounded chunking, and the
 * document-oriented extraction prompt.
 * @module
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path'

/** Directory names never entered during an import walk. */
const IGNORED_DIRECTORIES = new Set(['node_modules', '.git', 'dist', 'lib', 'build', 'coverage', '.dsh'])

/** Extensions (without the dot) accepted without configuration; an empty extension is accepted too. */
export const DEFAULT_TEXT_EXTENSIONS: readonly string[] = [
  'md', 'txt', 'rst', 'adoc', 'json', 'yaml', 'yml', 'toml',
  'ts', 'tsx', 'js', 'mjs', 'cjs', 'py', 'go', 'rs', 'java', 'sh',
]

/** Stable system instruction for extraction over documents rather than a session turn. */
export const DOCUMENT_SYSTEM_PROMPT = [
  'You read one excerpt of a document from the user\'s knowledge base and extract what a future coding-assistant session on this machine and project should know.',
  'Keep only durable, reusable items: facts (names, paths, URLs, versions, architecture), procedures (commands and steps that work), conventions (rules the project follows), and explicit preferences.',
  'Do not keep prose summaries, task-local state, or anything already obvious from the excerpt\'s file name.',
  'Answer with a JSON array only. Each item is {"text": string, "kind": "fact" | "shortcut" | "preference", "tags": string[]}. Use "shortcut" for procedures and "preference" for conventions. Text is one or two sentences. Return [] when nothing qualifies.',
].join('\n')

/** What an import makes of each file. */
export type ImportMode =
  /** Extract facts, procedures, and conventions into memory entries. */
  | 'facts'
  /** `--as-skills`: write each file as one skill with no model request; its heading or frontmatter is the description. */
  | 'skills'
  /** `/digest`: the model decides per document whether it is a skill, memory entries, or both. */
  | 'auto'

/** Parsed `/learn from` or `/digest` arguments. */
export interface LearnFromRequest {
  /** The path as typed, relative or absolute. */
  readonly path: string
  /** Extra tags applied to every candidate. */
  readonly tags: readonly string[]
  /** What to make of each file. */
  readonly mode: ImportMode
}

/**
 * Parse the input following `/learn`: `from <path> [--tags a,b] [--as-skills]`.
 * @param rawInput - the command input after the command name.
 * @returns the request, or `undefined` when the verb is not `from` or the path is missing.
 */
export function parseLearnFromInput(rawInput: string): LearnFromRequest | undefined {
  const words = rawInput.trim().split(/\s+/u).filter(word => word.length > 0)
  if (words[0] !== 'from') return undefined
  const read = readImportArguments(words.slice(1), true)
  return read === undefined ? undefined : { path: read.path, tags: read.tags, mode: read.asSkills ? 'skills' : 'facts' }
}

/**
 * Parse `/digest <path> [--tags a,b]`.
 * @param rawInput - the command's raw input.
 * @returns the request, or `undefined` when no path was given.
 */
export function parseDigestInput(rawInput: string): LearnFromRequest | undefined {
  const words = rawInput.trim().split(/\s+/u).filter(word => word.length > 0)
  const read = readImportArguments(words, false)
  return read === undefined ? undefined : { path: read.path, tags: read.tags, mode: 'auto' }
}

/** The path, tags, and `--as-skills` flag read from import arguments. */
interface ImportArguments {
  readonly path: string
  readonly tags: string[]
  readonly asSkills: boolean
}

/**
 * Read `<path> [--tags a,b]` import arguments. The words that are not options
 * form the path, joined by single spaces.
 * @param words - the words after the command and its verb.
 * @param acceptAsSkills - whether `--as-skills` is a flag; otherwise it is a path word.
 * @returns the arguments, or `undefined` when no path word remains.
 */
function readImportArguments(words: readonly string[], acceptAsSkills: boolean): ImportArguments | undefined {
  const tags: string[] = []
  const paths: string[] = []
  let asSkills = false
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]
    if (word === undefined) continue
    if (acceptAsSkills && word === '--as-skills') {
      asSkills = true
      continue
    }
    if (word === '--tags') {
      const value = words[index + 1]
      if (value !== undefined) {
        tags.push(...value.split(',').map(tag => tag.trim()).filter(tag => tag.length > 0))
        index += 1
      }
      continue
    }
    paths.push(word)
  }
  if (paths.length === 0) return undefined
  return { path: paths.join(' '), tags, asSkills }
}

/** The parsed `/research-ingest` arguments. */
export interface ResearchIngestRequest {
  /** The path as typed; resolved against the session workspace. */
  readonly path: string
  /** Journal slug; absent means the session's active research journal. */
  readonly slug?: string
}

/**
 * Parse `/research-ingest <path> [--slug name]`.
 * @param rawInput - the text after the command name.
 * @returns the request, or `undefined` when no path was given.
 */
export function parseResearchIngestInput(rawInput: string): ResearchIngestRequest | undefined {
  const words = rawInput.trim().split(/\s+/).filter(word => word.length > 0)
  const paths: string[] = []
  let slug: string | undefined
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]
    if (word === undefined) break
    if (word === '--slug') {
      slug = words[index + 1]
      index += 1
      continue
    }
    if (word.startsWith('--slug=')) {
      slug = word.slice('--slug='.length)
      continue
    }
    paths.push(word)
  }
  if (paths.length === 0) return undefined
  return { path: paths.join(' '), ...slug === undefined || slug.length === 0 ? {} : { slug } }
}

/**
 * Resolve the typed path against the session workspace.
 * @param cwd - the session workspace directory.
 * @param raw - the typed path.
 * @returns an absolute path.
 */
export function resolveImportPath(cwd: string, raw: string): string {
  return isAbsolute(raw) ? resolve(raw) : resolve(cwd, raw)
}

/** One file selected for import. */
export interface ImportFile {
  /** Absolute path. */
  readonly path: string
  /** Path relative to the import root (the file name for a single-file import). */
  readonly relative: string
}

/** Why one entry was left out of an import. */
export type ImportSkipReason = 'extension' | 'binary' | 'too-large' | 'file-cap' | 'unreadable' | 'no-skill-name'

/** One entry left out of an import. */
export interface ImportSkip {
  readonly relative: string
  readonly reason: ImportSkipReason
}

/** Walk options. */
export interface WalkImportOptions {
  /** Extra accepted extensions without the dot, beside {@link DEFAULT_TEXT_EXTENSIONS}. */
  readonly extensions: readonly string[]
  /** Files larger than this many bytes are skipped. */
  readonly maxFileBytes: number
  /** Files beyond this count are reported as `file-cap` skips. */
  readonly maxFiles: number
  /** Cancellation; the walk stops early when aborted. */
  readonly signal?: AbortSignal
}

/** Result of {@link walkImportFiles}. */
export interface WalkImportResult {
  readonly files: ImportFile[]
  readonly skipped: ImportSkip[]
}

/**
 * Whether a buffer looks like text: valid UTF-8 with no NUL bytes in its head.
 * @param bytes - the file head.
 * @returns true for text.
 */
function looksLikeText(bytes: Buffer): boolean {
  const head = bytes.subarray(0, 8192)
  if (head.includes(0)) return false
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(head)
    return true
  } catch {
    // Invalid UTF-8 in the head: treat as binary.
    return false
  }
}

/**
 * Whether a file name is accepted by extension.
 * @param name - the file's base name.
 * @param extra - configured extra extensions.
 * @returns true when accepted.
 */
function acceptedExtension(name: string, extra: readonly string[]): boolean {
  const ext = extname(name)
  if (ext === '') return true
  const bare = ext.slice(1).toLowerCase()
  return DEFAULT_TEXT_EXTENSIONS.includes(bare) || extra.some(candidate => candidate.replace(/^\./u, '').toLowerCase() === bare)
}

/**
 * Select the text files under a path. A file path yields that file; a directory
 * is walked recursively in sorted order, never entering ignored directories.
 * @param target - absolute file or directory path.
 * @param options - extension, size, count, and cancellation limits.
 * @returns the selected files in walk order plus every skipped entry with its reason.
 * @throws when the path does not exist.
 */
export async function walkImportFiles(target: string, options: WalkImportOptions): Promise<WalkImportResult> {
  const info = await stat(target)
  const files: ImportFile[] = []
  const skipped: ImportSkip[] = []
  const root = info.isDirectory() ? target : resolve(target, '..')
  const candidates: string[] = []
  if (info.isDirectory()) {
    const pending = [target]
    while (pending.length > 0) {
      options.signal?.throwIfAborted()
      const directory = pending.shift()
      if (directory === undefined) break
      const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))
      for (const entry of entries) {
        const path = join(directory, entry.name)
        if (entry.isDirectory()) {
          if (!IGNORED_DIRECTORIES.has(entry.name)) pending.push(path)
          continue
        }
        if (entry.isFile()) candidates.push(path)
      }
    }
  } else {
    candidates.push(target)
  }
  for (const path of candidates) {
    options.signal?.throwIfAborted()
    const rel = relative(root, path)
    if (!acceptedExtension(basename(path), options.extensions)) {
      skipped.push({ relative: rel, reason: 'extension' })
      continue
    }
    if (files.length >= options.maxFiles) {
      skipped.push({ relative: rel, reason: 'file-cap' })
      continue
    }
    let size: number
    let head: Buffer
    try {
      size = (await stat(path)).size
      head = size === 0 ? Buffer.alloc(0) : await readHead(path)
    } catch {
      // Unreadable (permissions, vanished mid-walk): report and move on.
      skipped.push({ relative: rel, reason: 'unreadable' })
      continue
    }
    if (size > options.maxFileBytes) {
      skipped.push({ relative: rel, reason: 'too-large' })
      continue
    }
    if (!looksLikeText(head)) {
      skipped.push({ relative: rel, reason: 'binary' })
      continue
    }
    files.push({ path, relative: rel })
  }
  return { files, skipped }
}

/**
 * Read the first bytes of a file for the text check.
 * @param path - the file.
 * @returns up to 8 KiB.
 */
async function readHead(path: string): Promise<Buffer> {
  const whole = await readFile(path)
  return whole.subarray(0, 8192)
}

/**
 * Split text into chunks of at most `maxBytes` UTF-8 bytes, breaking on line
 * boundaries; a single line longer than the cap is split by characters.
 * @param text - the document text.
 * @param maxBytes - byte cap per chunk (at least 1).
 * @returns the chunks in order; joined with newlines they reproduce the text.
 */
export function chunkText(text: string, maxBytes: number): string[] {
  if (text.length === 0) return []
  const chunks: string[] = []
  let current: string[] = []
  let currentBytes = 0
  const flush = (): void => {
    if (current.length > 0) chunks.push(current.join('\n'))
    current = []
    currentBytes = 0
  }
  for (const line of text.split('\n')) {
    const lineBytes = Buffer.byteLength(line)
    if (lineBytes > maxBytes) {
      flush()
      for (const piece of splitLongLine(line, maxBytes)) chunks.push(piece)
      continue
    }
    const separator = current.length === 0 ? 0 : 1
    if (currentBytes + separator + lineBytes > maxBytes) flush()
    current.push(line)
    currentBytes += (current.length === 1 ? 0 : 1) + lineBytes
  }
  flush()
  return chunks
}

/**
 * Split one over-long line into byte-bounded pieces without cutting a character.
 * @param line - the line.
 * @param maxBytes - byte cap per piece.
 * @returns the pieces.
 */
function splitLongLine(line: string, maxBytes: number): string[] {
  const pieces: string[] = []
  let piece = ''
  let bytes = 0
  for (const char of line) {
    const size = Buffer.byteLength(char)
    if (bytes + size > maxBytes && piece.length > 0) {
      pieces.push(piece)
      piece = ''
      bytes = 0
    }
    piece += char
    bytes += size
  }
  if (piece.length > 0) pieces.push(piece)
  return pieces
}

/** What one imported document becomes as a skill: its routing name, its one-line description, and where the two came from. */
export interface DocumentSkill {
  readonly name: string
  readonly description: string
}

/**
 * Derive a skill name and description from a document: the name from the file
 * name (lowercased, non-alphanumerics folded to single hyphens), the
 * description from a frontmatter `description:` line, else the first Markdown
 * heading, else the first non-empty line, cut to 200 characters.
 * @param relative - the file's path relative to the import root.
 * @param text - the file contents.
 * @returns the skill name and description, or undefined when the file name yields no letters or digits.
 */
export function documentSkill(relative: string, text: string): DocumentSkill | undefined {
  const base = relative.split('/').pop() ?? relative
  const stem = base.replace(/\.[^.]+$/u, '')
  const name = stem.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '')
  if (name.length === 0) return undefined
  const lines = text.split('\n')
  let description: string | undefined
  if (lines[0]?.trim() === '---') {
    const end = lines.indexOf('---', 1)
    for (const line of lines.slice(1, end === -1 ? lines.length : end)) {
      const match = /^description:\s*(.+)$/u.exec(line)
      if (match?.[1] !== undefined) {
        description = match[1].trim().replace(/^["']|["']$/gu, '')
        break
      }
    }
  }
  description ??= lines.find(line => /^#+\s+\S/u.test(line))?.replace(/^#+\s+/u, '').trim()
  description ??= lines.find(line => line.trim().length > 0 && line.trim() !== '---')?.trim()
  if (description === undefined || description.length === 0) description = name
  if (description.length > 200) description = `${description.slice(0, 197)}...`
  return { name, description }
}
