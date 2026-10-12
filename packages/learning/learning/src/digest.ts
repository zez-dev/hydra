/**
 * `/digest` for one document: read it whole, or every part of a long one,
 * keep its durable items, and decide once for the whole document whether it
 * is a skill. A skill is written by the model and saved as a draft beside a
 * copy of the document; it goes live only when a person publishes it.
 * @module
 */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { DIGEST_DOCUMENT_SYSTEM_PROMPT, DIGEST_PART_SYSTEM_PROMPT, parseDigestDocument, parseDigestPart } from './extract.ts'
import { chunkText } from './ingest.ts'
import type { LearningCandidate } from './types.ts'

/**
 * One model request of a digest: the system prompt, the prompt, and which part it reads.
 * `chunk` is the 1-based part, or 0 for the verdict over the whole document.
 */
export type DigestAsk = (system: string, prompt: string, part: { readonly chunk: number; readonly chunks: number }) => Promise<string>

/** What a digest does with the model's answers. */
export interface DigestHooks {
  /** Sends one request. */
  readonly ask: DigestAsk
  /** Files the entries of one answer; called after each answer, so a cancelled digest keeps what it read. */
  readonly keep: (candidates: readonly LearningCandidate[]) => Promise<void>
}

/** What digesting one document produced beside the entries it kept. */
export interface DigestedDocument {
  /** Valid entries the model returned beyond the per-request cap. */
  readonly dropped: number
  /** The skill the model wrote, and whether it saw only an excerpt of the document (always, for a document read in parts). */
  readonly draft?: { readonly description: string; readonly body: string; readonly excerpt: boolean }
  /** Requests that failed; the digest went on without them. */
  readonly failed: { readonly chunk: number; readonly message: string }[]
}

/**
 * Digest one document. An empty document makes no request. A document that
 * fits one request is read whole in one request that returns its entries,
 * its verdict, and its skill. A longer one is read part by part for entries
 * and a note on each part, then one more request decides from every part's
 * note and the parts that fit, steps first. A failed request is recorded and
 * the digest goes on.
 * @param relative - the document's path within the import, shown to the model.
 * @param text - the document's text.
 * @param maxBytes - most document bytes one request carries.
 * @param maxEntries - cap on entries kept from one request.
 * @param hooks - sends each request and files each answer's entries.
 * @param signal - cancellation; a cancelled request is rethrown, not recorded.
 * @returns the dropped count, the draft when there is one, and the failures.
 */
export async function digestDocument(
  relative: string,
  text: string,
  maxBytes: number,
  maxEntries: number,
  hooks: DigestHooks,
  signal: AbortSignal,
): Promise<DigestedDocument> {
  const { ask, keep } = hooks
  const parts = chunkText(text, maxBytes)
  const failed: { chunk: number; message: string }[] = []
  const attempt = async <T>(chunk: number, run: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await run()
    } catch (error) {
      if (signal.aborted) throw error
      failed.push({ chunk, message: error instanceof Error ? error.message : String(error) })
      return undefined
    }
  }
  if (parts.length === 0) return { dropped: 0, failed }
  if (parts.length === 1) {
    const prompt = `Source file: ${relative}\n\nThe whole document follows.\n\n${text}`
    const answer = await attempt(1, async () =>
      parseDigestDocument(await ask(DIGEST_DOCUMENT_SYSTEM_PROMPT, prompt, { chunk: 1, chunks: 1 }), maxEntries))
    await keep(answer?.candidates ?? [])
    return {
      dropped: answer?.dropped ?? 0,
      ...answer?.draft === undefined ? {} : { draft: { ...answer.draft, excerpt: false } },
      failed,
    }
  }
  let dropped = 0
  const read: ReadPart[] = []
  for (const [index, part] of parts.entries()) {
    signal.throwIfAborted()
    const prompt = `Source file: ${relative} (part ${index + 1} of ${parts.length})\n\n${part}`
    const answer = await attempt(index + 1, async () =>
      parseDigestPart(await ask(DIGEST_PART_SYSTEM_PROMPT, prompt, { chunk: index + 1, chunks: parts.length }), maxEntries))
    await keep(answer?.candidates ?? [])
    dropped += answer?.dropped ?? 0
    read.push({ index, part, note: answer?.note ?? '', procedural: answer?.procedural ?? false })
  }
  signal.throwIfAborted()
  const prompt = verdictPrompt(relative, read, maxBytes)
  const verdict = await attempt(0, async () =>
    parseDigestDocument(await ask(DIGEST_DOCUMENT_SYSTEM_PROMPT, prompt, { chunk: 0, chunks: parts.length }), 0))
  return {
    dropped,
    ...verdict?.draft === undefined ? {} : { draft: { ...verdict.draft, excerpt: true } },
    failed,
  }
}

/** One part of a document read in parts: its 0-based index, its text, and what the model said of it. */
interface ReadPart {
  readonly index: number
  readonly part: string
  /** Empty when the part's request failed. */
  readonly note: string
  readonly procedural: boolean
}

/**
 * The verdict request for a document read in parts: every part's note, then
 * the parts that fit `maxBytes`, the ones marked as steps first, in document
 * order. The whole document never fits, since it was split for exceeding `maxBytes`.
 * @param relative - the document's path.
 * @param read - the parts with their notes.
 * @param maxBytes - most document bytes the request carries.
 * @returns the prompt.
 */
function verdictPrompt(relative: string, read: readonly ReadPart[], maxBytes: number): string {
  const chosen: ReadPart[] = []
  let bytes = 0
  for (const entry of [...read].sort((left, right) => Number(right.procedural) - Number(left.procedural) || left.index - right.index)) {
    const size = (chosen.length === 0 ? 0 : 1) + Buffer.byteLength(entry.part)
    if (bytes + size > maxBytes) continue
    bytes += size
    chosen.push(entry)
  }
  chosen.sort((left, right) => left.index - right.index)
  return [
    `Source file: ${relative}`,
    `The document was read in ${read.length} parts. What each part covers:`,
    ...read.map(entry => `${entry.index + 1}. ${entry.note.length === 0 ? '(not read: its request failed)' : entry.note}${entry.procedural ? ' [steps]' : ''}`),
    '',
    `An excerpt follows: part${chosen.length === 1 ? '' : 's'} ${chosen.map(entry => entry.index + 1).join(', ')} of ${read.length}, steps first.`,
    '',
    chosen.map(entry => entry.part).join('\n'),
  ].join('\n')
}

/**
 * The child folder names of a folder.
 * @param root - the folder.
 * @returns the names; a missing folder has none.
 */
async function folderNames(root: string): Promise<string[]> {
  try {
    return (await readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
  } catch (_missing) {
    // A folder that does not exist yet holds no names.
    return []
  }
}

/**
 * The first name, among `preferred`, `preferred-2`, `preferred-3`, and so on,
 * that no folder in any of the roots uses.
 * @param preferred - the name wanted.
 * @param roots - folders whose child folder names are taken.
 * @returns the free name.
 */
export async function freeSkillName(preferred: string, roots: readonly string[]): Promise<string> {
  const taken = new Set<string>()
  for (const root of roots) for (const name of await folderNames(root)) taken.add(name)
  let name = preferred
  for (let suffix = 2; taken.has(name); suffix += 1) name = `${preferred}-${suffix}`
  return name
}

/**
 * The draft already made from a document, named by its `draft.json`.
 * @param draftsRoot - the drafts folder.
 * @param sourcePath - the document's path.
 * @returns the draft's name, or `undefined` when no draft came from it.
 */
async function draftFrom(draftsRoot: string, sourcePath: string): Promise<string | undefined> {
  for (const name of await folderNames(draftsRoot)) {
    let recorded: unknown
    try {
      recorded = JSON.parse(await readFile(join(draftsRoot, name, 'draft.json'), 'utf8'))
    } catch (_unreadable) {
      // A folder without a readable draft.json was not written by a digest.
      continue
    }
    if (typeof recorded === 'object' && recorded !== null && 'source' in recorded && recorded.source === sourcePath) return name
  }
  return undefined
}

/**
 * Save a skill the model wrote as a draft: `<draftsRoot>/<name>/SKILL.md`, the
 * document copied to `source/` beside it, and `draft.json` naming where the
 * document came from. A document digested again replaces its own draft;
 * otherwise the name is free among drafts and live skills.
 * @param draftsRoot - the drafts folder.
 * @param skillsRoot - the live skills folder.
 * @param preferred - the name wanted.
 * @param draft - the skill's description and body.
 * @param source - the document's path and text.
 * @returns the draft's name.
 */
export async function writeSkillDraft(
  draftsRoot: string,
  skillsRoot: string,
  preferred: string,
  draft: { readonly description: string; readonly body: string },
  source: { readonly path: string; readonly text: string },
): Promise<string> {
  const name = await draftFrom(draftsRoot, source.path) ?? await freeSkillName(preferred, [draftsRoot, skillsRoot])
  const directory = join(draftsRoot, name)
  const file = basename(source.path)
  await mkdir(join(directory, 'source'), { recursive: true })
  await writeFile(join(directory, 'source', file), source.text, 'utf8')
  await writeFile(
    join(directory, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${JSON.stringify(draft.description)}\n---\n\n${draft.body}\n\nSource: \`source/${file}\` in this skill's folder.\n`,
    'utf8',
  )
  await writeFile(join(directory, 'draft.json'), `${JSON.stringify({ source: source.path, createdAt: new Date().toISOString() }, null, 2)}\n`, 'utf8')
  return name
}
