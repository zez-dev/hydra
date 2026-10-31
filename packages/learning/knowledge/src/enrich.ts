/**
 * AI enrichment: one model request per file classifies it, tags its topics,
 * and summarizes what it is for, so the model can find and choose files
 * before it reads them. Runs in the background over the files that have no
 * summary yet; a failed file stays pending for the next run.
 * @module
 */

import { BlockAssembler, lowestReasoningEffort } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { KnowledgeIndex } from './store.ts'
import type { KnowledgeEnrichReport, KnowledgeFileSummary, KnowledgeFileType, KnowledgeFolderInput, KnowledgePendingFile } from './types.ts'

/** The file types the enrichment model chooses from. */
export const KNOWLEDGE_FILE_TYPES: readonly KnowledgeFileType[] = [
  'code', 'script', 'tool', 'tip', 'cheatsheet', 'automation', 'guide', 'reference', 'book', 'note', 'config', 'data', 'other',
]

/** Most tags kept per file. */
const MAX_TAGS = 6
/** Most characters of summary kept per file. */
const MAX_SUMMARY_CHARS = 700
/** Failures kept in a report. */
const REPORTED_FAILURES = 10

/** The route and limits of one enrichment run. */
export interface EnrichOptions {
  /** The model route every request uses. */
  readonly provider: string
  readonly model: string
  /** Most files summarized in this run. */
  readonly limit: number
  /** Only this collection. */
  readonly collection?: string
  /** Requests in flight at once. */
  readonly concurrency: number
  /** Most characters of file text one request shows. */
  readonly maxInputChars: number
  /** Output cap of one request. */
  readonly maxTokens: number
  /** Milliseconds one request may take. */
  readonly timeoutMs: number
}

/** The system prompt of every enrichment request. */
export const ENRICH_SYSTEM = [
  'You catalogue files for a searchable knowledge base.',
  'Reply with one JSON object and nothing else:',
  `{"type": one of ${KNOWLEDGE_FILE_TYPES.map(type => `"${type}"`).join(', ')},`,
  ` "tags": 3 to ${MAX_TAGS} short lowercase topic tags,`,
  ' "summary": 2 to 4 sentences saying what the file is for and what someone can learn or do with it}.',
  'Describe only what the file shows; do not invent details.',
].join('\n')

/**
 * The user message of one enrichment request.
 * @param file - the file.
 * @param input - its heading outline and opening text.
 * @returns the prompt text.
 */
export function enrichPrompt(file: Pick<KnowledgePendingFile, 'collection' | 'path' | 'kind'>, input: { headings: readonly string[]; text: string }): string {
  return [
    `Path: ${file.collection}/${file.path} (${file.kind})`,
    ...input.headings.length === 0 ? [] : [`Sections: ${input.headings.join(' | ')}`],
    '',
    input.text,
  ].join('\n')
}

/**
 * Read the model's answer into a summary, keeping only valid fields.
 * @param answer - the model's text.
 * @returns the summary.
 * @throws when the answer has no JSON object or no summary.
 */
export function parseSummary(answer: string): KnowledgeFileSummary {
  const start = answer.indexOf('{')
  const end = answer.lastIndexOf('}')
  if (start === -1 || end <= start) throw new Error('the answer has no JSON object')
  const value = JSON.parse(answer.slice(start, end + 1)) as { type?: unknown; tags?: unknown; summary?: unknown }
  const summary = typeof value.summary === 'string' ? value.summary.trim().replace(/\s+/gu, ' ') : ''
  if (summary.length === 0) throw new Error('the answer has no summary')
  const type = typeof value.type === 'string' && (KNOWLEDGE_FILE_TYPES as readonly string[]).includes(value.type.toLowerCase())
    ? value.type.toLowerCase() as KnowledgeFileType
    : 'other'
  const tags = Array.isArray(value.tags)
    ? [...new Set(value.tags
      .filter((tag): tag is string => typeof tag === 'string')
      .map(tag => tag.toLowerCase().trim().replace(/\s+/gu, '-').replace(/[^\p{L}\p{N}_-]/gu, ''))
      .filter(tag => tag.length > 0))].slice(0, MAX_TAGS)
    : []
  return { type, tags, summary: summary.length > MAX_SUMMARY_CHARS ? `${summary.slice(0, MAX_SUMMARY_CHARS)}…` : summary }
}

/**
 * Ask the route for one file's summary.
 * @param llm - the LLM runtime.
 * @param options - the route and limits.
 * @param prompt - the file or folder prompt.
 * @param signal - cancellation of the run.
 * @param system - the system prompt.
 * @returns the model's text answer.
 */
async function requestSummary(
  llm: LlmRuntime,
  options: EnrichOptions,
  prompt: string,
  signal: AbortSignal,
  system: string = ENRICH_SYSTEM,
): Promise<string> {
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(options.timeoutMs)])
  let effort: ReturnType<typeof lowestReasoningEffort>
  try {
    effort = lowestReasoningEffort(await llm.resolveModelInfo(options.provider, options.model, requestSignal))
  } catch (_unresolvedRoute) {
    // The request itself fails loud on a route that cannot be resolved; the effort is a preference.
    effort = undefined
  }
  const request: GenerateOptions = {
    provider: options.provider,
    model: options.model,
    system,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    maxTokens: options.maxTokens,
    purpose: 'knowledge-enrich',
    signal: requestSignal,
    ...effort === undefined ? {} : { reasoningEffort: effort },
  }
  const assembler = new BlockAssembler()
  for await (const chunk of llm.stream(request)) assembler.push(chunk)
  const finish = assembler.finish
  if (finish.kind === 'error') throw new Error(finish.failure.message)
  if (finish.kind === 'max-tokens') throw new Error(`the answer was cut at ${options.maxTokens} output tokens`)
  return assembler.blocks().map(block => (block.type === 'text' ? block.text : '')).join('')
}

/**
 * Summarize up to `limit` files that have none, `concurrency` at a time.
 * @param llm - the LLM runtime.
 * @param index - the knowledge index.
 * @param options - the route and limits.
 * @param signal - stops the run between files.
 * @param onProgress - called after each file with the running totals.
 * @returns the run's totals.
 */
export async function enrichFiles(
  llm: LlmRuntime,
  index: KnowledgeIndex,
  options: EnrichOptions,
  signal: AbortSignal,
  onProgress?: (done: number, total: number) => void,
): Promise<KnowledgeEnrichReport> {
  const started = Date.now()
  const queue = index.pendingSummaries(options.limit, options.collection)
  const failures: { path: string; message: string }[] = []
  let summarized = 0
  let failed = 0
  let next = 0
  const model = `${options.provider}/${options.model}`
  const worker = async (): Promise<void> => {
    while (next < queue.length) {
      signal.throwIfAborted()
      const file = queue[next++]
      if (file === undefined) return
      try {
        const prompt = enrichPrompt(file, index.summaryInput(file.fileId, options.maxInputChars))
        const answer = await requestSummary(llm, options, prompt, signal)
        if (index.saveSummary(file.fileId, parseSummary(answer), model)) summarized += 1
      } catch (error) {
        if (signal.aborted) throw error
        failed += 1
        if (failures.length < REPORTED_FAILURES) {
          failures.push({ path: `${file.collection}:${file.path}`, message: error instanceof Error ? error.message : String(error) })
        }
      }
      onProgress?.(summarized + failed, queue.length)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(options.concurrency, queue.length)) }, worker))
  return { summarized, failed, remaining: index.pendingCount(options.collection), durationMs: Date.now() - started, failures }
}

/** The system prompt of every folder rollup request. */
export const FOLDER_SYSTEM = [
  'You summarize one folder of a knowledge base from the summaries of what it contains.',
  'Reply with one JSON object and nothing else:',
  `{"tags": 3 to ${MAX_TAGS} short lowercase topic tags,`,
  ' "summary": 2 to 4 sentences saying what the folder covers and what someone would find there}.',
  'Describe only what the contents show; do not invent details.',
].join('\n')

/** Outcome of one folder rollup run. */
export interface KnowledgeRollupReport {
  /** Folders whose rollup was written. */
  readonly folders: number
  /** Folders whose request or answer failed. */
  readonly failed: number
}

/**
 * The user message of one folder rollup request.
 * @param folder - the folder and its children's summary lines.
 * @param maxChars - most characters of child lines shown.
 * @returns the prompt text.
 */
export function folderPrompt(folder: KnowledgeFolderInput, maxChars: number): string {
  const lines: string[] = []
  let size = 0
  for (const line of folder.lines) {
    if (size + line.length > maxChars) {
      lines.push(`… and ${folder.lines.length - lines.length} more`)
      break
    }
    lines.push(`- ${line}`)
    size += line.length + 3
  }
  return [`Folder: ${folder.collection}/${folder.folder}`, 'Contents:', ...lines].join('\n')
}

/**
 * Write rollups for stale folders one depth level per pass, deepest level
 * first, so a parent is written once from its subfolders' fresh rollups;
 * repeats until nothing is stale or `maxPasses` passes ran.
 * @param llm - the LLM runtime.
 * @param index - the knowledge index.
 * @param options - the route and limits.
 * @param minChildren - fewest summarized children a folder needs.
 * @param signal - stops the run between folders.
 * @param maxPasses - most passes over the stale folders.
 * @returns the run's totals.
 */
export async function rollupFolders(
  llm: LlmRuntime,
  index: KnowledgeIndex,
  options: EnrichOptions,
  minChildren: number,
  signal: AbortSignal,
  maxPasses: number = 64,
): Promise<KnowledgeRollupReport> {
  const model = `${options.provider}/${options.model}`
  let folders = 0
  let failed = 0
  const failedKeys = new Set<string>()
  for (let pass = 0; pass < maxPasses; pass += 1) {
    const depthOf = (folder: string): number => (folder.length === 0 ? 0 : folder.split('/').length)
    const candidates = index.staleFolders(minChildren, options.collection)
      .filter(folder => !failedKeys.has(`${folder.collection}:${folder.folder}`))
    if (candidates.length === 0) break
    const deepest = Math.max(...candidates.map(folder => depthOf(folder.folder)))
    for (const folder of candidates.filter(entry => depthOf(entry.folder) === deepest)) {
      signal.throwIfAborted()
      try {
        const answer = await requestSummary(llm, options, folderPrompt(folder, options.maxInputChars), signal, FOLDER_SYSTEM)
        const parsed = parseSummary(answer)
        index.saveFolder(folder, { tags: parsed.tags, summary: parsed.summary }, model)
        folders += 1
      } catch (error) {
        if (signal.aborted) throw error
        failed += 1
        failedKeys.add(`${folder.collection}:${folder.folder}`)
      }
    }
  }
  return { folders, failed }
}
