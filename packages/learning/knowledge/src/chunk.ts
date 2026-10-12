/**
 * Split one file's text into passages along its structure: Markdown and other
 * documents at headings and paragraph breaks, code at top-level definitions,
 * each bounded by a target size so a passage is a useful unit to retrieve.
 * @module
 */

import type { KnowledgePassageKind } from './types.ts'

/** Extensions indexed as code; every other accepted extension is text. */
export const CODE_EXTENSIONS: ReadonlySet<string> = new Set([
  'bash', 'c', 'cc', 'cpp', 'cs', 'css', 'go', 'h', 'hpp', 'java', 'js', 'jsx', 'kt', 'lua', 'mjs', 'cjs', 'php', 'pl',
  'ps1', 'py', 'rb', 'rs', 'scala', 'sh', 'sql', 'swift', 'ts', 'tsx', 'vue', 'zsh', 'bat', 'cmd', 'r', 'dart', 'ex', 'exs',
  'groovy', 'gradle', 'make', 'mk', 'dockerfile', 'tf', 'hcl', 'nix', 'awk', 'sed', 'vim', 'fish',
])

/** Extensions indexed as text documents. */
export const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  'md', 'markdown', 'mdx', 'txt', 'rst', 'adoc', 'asciidoc', 'org', 'tex', 'html', 'htm', 'xml', 'json', 'jsonc', 'yaml',
  'yml', 'toml', 'ini', 'cfg', 'conf', 'csv', 'tsv', 'log', 'env', 'properties', 'ipynb', 'textile', 'wiki', 'nfo',
])

/** Extensions whose `#` lines are Markdown headings; in YAML, TOML, and similar text they are comments. */
const MARKDOWN_EXTENSIONS: ReadonlySet<string> = new Set(['md', 'markdown', 'mdx'])

/**
 * Whether a file's `#` lines are Markdown headings.
 * @param path - file path.
 * @returns true for Markdown files.
 */
export function usesMarkdownHeadings(path: string): boolean {
  const base = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
  return MARKDOWN_EXTENSIONS.has(base.slice(base.lastIndexOf('.') + 1))
}

/** One passage before it is attached to a file. */
export interface Chunk {
  readonly heading: string
  readonly startLine: number
  readonly endLine: number
  readonly text: string
}

/** Chunking bounds, in characters. */
export interface ChunkBounds {
  /** Size a passage grows to before a paragraph break may end it. */
  readonly targetChars: number
  /** Size at which a passage ends even without a break. */
  readonly maxChars: number
}

/**
 * The indexing kind of a file from its name, or `undefined` for a file that is not indexed.
 * @param path - file path.
 * @returns `code`, `text`, or `undefined`.
 */
export function kindOf(path: string): KnowledgePassageKind | undefined {
  const base = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
  if (base === 'dockerfile' || base === 'makefile') return 'code'
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return 'text'
  const extension = base.slice(dot + 1)
  if (CODE_EXTENSIONS.has(extension)) return 'code'
  if (TEXT_EXTENSIONS.has(extension)) return 'text'
  return undefined
}

/** A Markdown ATX heading: `#`..`######` then text. */
const MARKDOWN_HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/u

/** A top-level definition in common languages: a line at column 0 that opens a function, class, or similar. */
const CODE_DEFINITION = new RegExp([
  '^(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?',
  '(?:public\\s+|private\\s+|protected\\s+|static\\s+|abstract\\s+|final\\s+)*',
  '(?:function\\*?|class|def|fn|func|interface|type|struct|enum|trait|impl|module|namespace|sub|proc',
  '|const\\s+\\w+\\s*=\\s*(?:async\\s*)?\\(|let\\s+\\w+\\s*=\\s*(?:async\\s*)?\\(|[A-Za-z_][\\w.]*\\s*\\(\\)\\s*\\{)',
].join(''), 'u')

/**
 * Split a file into passages.
 * @param text - the file's text.
 * @param kind - whether the file is code or a text document.
 * @param bounds - passage size bounds.
 * @param markdownHeadings - whether `#` lines start sections (Markdown files only).
 * @returns passages in file order, covering every non-blank line once.
 */
export function chunkFile(text: string, kind: KnowledgePassageKind, bounds: ChunkBounds, markdownHeadings: boolean = kind === 'text'): Chunk[] {
  const lines = text.replace(/\r\n?/gu, '\n').split('\n')
  const chunks: Chunk[] = []
  const headings: string[] = ['', '', '', '', '', '']
  let heading = ''
  let start = 0
  let size = 0

  const flush = (end: number): void => {
    if (end <= start) return
    let last = end
    while (last > start && (lines[last - 1] ?? '').trim().length === 0) last -= 1
    let first = start
    while (first < last && (lines[first] ?? '').trim().length === 0) first += 1
    if (last > first) {
      chunks.push({ heading, startLine: first + 1, endLine: last, text: lines.slice(first, last).join('\n') })
    }
    start = end
    size = 0
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const markdown = markdownHeadings ? MARKDOWN_HEADING.exec(line) : null
    const definition = kind === 'code' && CODE_DEFINITION.test(line)
    if (markdown !== null) {
      flush(index)
      const level = markdown[1]?.length ?? 1
      headings[level - 1] = markdown[2] ?? ''
      headings.fill('', level)
      heading = headings.slice(0, level).filter(part => part.length > 0).join(' › ')
    } else if (definition) {
      flush(index)
      heading = line.trim().slice(0, 160)
    } else if (size >= bounds.maxChars || (size >= bounds.targetChars && line.trim().length === 0)) {
      flush(index + (line.trim().length === 0 ? 1 : 0))
      if (line.trim().length === 0) continue
    }
    size += line.length + 1
  }
  flush(lines.length)
  return chunks
}
