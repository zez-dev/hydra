/**
 * Pure extraction helpers: render one finished turn into a compact transcript,
 * and parse the extraction model's JSON answer into memory candidates.
 * @module
 */

import { createHash } from 'node:crypto'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ErrorPair, LearningCandidate, TurnTranscript } from './types.ts'

const KINDS = new Set(['fact', 'shortcut', 'preference'])
const LINE_CAP = 600

/** Stable system instruction for the extraction request. */
export const EXTRACTION_SYSTEM_PROMPT = [
  'You review one finished turn of an AI coding-assistant session and decide whether it taught anything worth keeping for later work on this machine and project.'
    + ' Most turns teach nothing new; then answer [].',
  'Keep an item only when a capable engineer new to this project would otherwise waste time or make a mistake: a non-obvious environment or project fact that took effort to find'
    + ' (a required setting, a build or test quirk, a tool version that matters), a workaround for an error likely to recur, an explicit user preference or decision,'
    + ' or a lesson: the established root cause of a problem, an approach that failed and why, or a wrong assumption that was corrected.',
  'Never keep general programming knowledge (how a language, library, or standard command works), a restatement of the task or of the change that was made,'
    + ' what a file contains when reading it shows that, one-off steps of this task, plans or progress reports, errors that were never explained, or anything the repository already documents.',
  'Write every item so it can be checked against a later task: name its situation (the file, command, component, or problem it is about) so it is never applied to a different case that only shares a word.',
  'Answer with the JSON array alone, with no explanation before or after it, and never two items that say the same thing. Each item is {"text": string, "kind": "fact" | "shortcut" | "preference", "tags": string[]}; a lesson is a "fact" tagged "lesson". Text is one or two sentences.',
].join('\n')

/** Stable system instruction for the research-mode extraction request. */
export const RESEARCH_SYSTEM_PROMPT = [
  'You review one finished turn of an AI research session and extract what the research journal must not lose.',
  'Keep only: breakthroughs (a confirmed step toward the objective), experiment results (what was tried and what happened), and dead ends (what must not be retried and why).',
  'Do not keep plans, opinions, or anything already phrased as a journal entry in the transcript.',
  'Answer with a JSON array only. Each item is {"kind": "breakthrough" | "result" | "dead_end", "text": string, "result"?: string}; for "result", "text" is what was tried and "result" what happened. Text is one or two sentences. Return [] when nothing qualifies.',
].join('\n')

/**
 * Stable head of the system instruction for `/research-ingest`; the journal's
 * objective and criteria are appended per request.
 */
export const RESEARCH_INGEST_SYSTEM_PROMPT = [
  'You read one chunk of a document (a paper, notes, or code) on behalf of a research journal and extract what advances the stated objective.',
  'Keep only: hypotheses worth testing (as `hypothesis`), reported experiments with their outcome (as `result`, where `text` is what was tried and `result` what happened), and approaches the document shows to be dead ends (as `dead_end`, with why).',
  'Do not restate the objective, summarize the document, or invent results the text does not report.',
  'Answer with a JSON array only. Each item is {"kind": "hypothesis" | "result" | "dead_end", "text": string, "result"?: string}. Text is one or two sentences. Return [] when nothing qualifies.',
].join('\n')

/**
 * The complete `/research-ingest` system instruction for one journal.
 * @param objective - the journal objective.
 * @param criteria - the journal's done criteria.
 * @returns the head plus the objective and criteria lines.
 */
export function renderResearchIngestSystem(objective: string, criteria: readonly string[]): string {
  const lines = [RESEARCH_INGEST_SYSTEM_PROMPT, `Objective: ${objective}`]
  if (criteria.length > 0) lines.push(`Done when: ${criteria.join('; ')}`)
  return lines.join('\n')
}

/**
 * Parse a model's JSON answer, which may sit inside a fenced block.
 * @param text - the model's text output.
 * @returns the parsed value, or `undefined` when the answer is not JSON.
 */
function parseJsonAnswer(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/u.exec(text)
  const body = (fenced?.[1] ?? text).trim()
  try {
    return JSON.parse(body) as unknown
  } catch {
    // Not JSON: the model ignored the format.
    return undefined
  }
}

/** One finding parsed from a `/research-ingest` answer. */
export interface IngestFindingCandidate {
  readonly kind: 'hypothesis' | 'result' | 'dead_end'
  readonly text: string
  readonly result?: string
}

/**
 * Parse the `/research-ingest` answer: a JSON array, optionally fenced.
 * Items without non-empty `text` or with an unknown kind are dropped; at most
 * `max` items are returned.
 * @param text - the model's text output.
 * @param max - cap on returned findings.
 * @returns the parsed findings; empty for invalid or non-array output.
 */
export function parseIngestFindings(text: string, max: number): IngestFindingCandidate[] {
  const parsed = parseJsonAnswer(text)
  if (!Array.isArray(parsed)) return []
  const findings: IngestFindingCandidate[] = []
  for (const item of parsed) {
    if (findings.length >= max) break
    if (typeof item !== 'object' || item === null) continue
    const record = item as { kind?: unknown; text?: unknown; result?: unknown }
    if (record.kind !== 'hypothesis' && record.kind !== 'result' && record.kind !== 'dead_end') continue
    if (typeof record.text !== 'string' || record.text.trim().length === 0) continue
    const result = typeof record.result === 'string' && record.result.trim().length > 0 ? record.result.trim() : undefined
    findings.push({ kind: record.kind, text: record.text.trim(), ...result === undefined ? {} : { result } })
  }
  return findings
}

/** Stable system instruction for the error-pattern pass over failure-then-success pairs. */
export const ERROR_PATTERN_SYSTEM_PROMPT = [
  'You review pairs of tool calls from one AI coding-assistant turn: a call that failed, followed by a later call of the same tool that succeeded.',
  'For each pair, write one reusable shortcut of the form "When X fails with Y, do Z" that a future session could apply without rediscovering it.',
  'Skip pairs where the recovery was task-specific luck, a retry of the same thing, or already obvious from the error text.',
  'Answer with a JSON array only. Each item is {"text": string, "tags": string[]}. Text is one or two sentences. Return [] when nothing qualifies.',
].join('\n')

const FINDING_KINDS = new Set(['breakthrough', 'result', 'dead_end'])

/** One research finding parsed from the research-mode extraction answer. */
export interface ResearchFindingCandidate {
  readonly kind: 'breakthrough' | 'result' | 'dead_end'
  readonly text: string
  readonly result?: string
}

/**
 * Parse the research-mode extraction answer: a JSON array, optionally fenced.
 * Items without non-empty `text` or with an unknown kind are dropped; at most
 * `max` items are returned.
 * @param text - the model's text output.
 * @param max - cap on returned findings.
 * @returns the parsed findings; empty for invalid or non-array output.
 */
export function parseFindings(text: string, max: number): ResearchFindingCandidate[] {
  const parsed = parseJsonAnswer(text)
  if (!Array.isArray(parsed)) return []
  const findings: ResearchFindingCandidate[] = []
  for (const item of parsed) {
    if (findings.length >= max) break
    if (item === null || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    if (typeof record.text !== 'string' || record.text.trim().length === 0) continue
    if (typeof record.kind !== 'string' || !FINDING_KINDS.has(record.kind)) continue
    const result = typeof record.result === 'string' && record.result.trim().length > 0 ? record.result.trim() : undefined
    findings.push({ kind: record.kind as ResearchFindingCandidate['kind'], text: record.text.trim(), ...result === undefined ? {} : { result } })
  }
  return findings
}

function truncate(text: string, max: number): string {
  const normalized = text.replaceAll(/\s+/g, ' ').trim()
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 3)}...`
}

function blocksText(content: readonly { type: string; text?: string }[]): string {
  return content.filter(block => block.type === 'text').map(block => block.text ?? '').join('')
}

/**
 * The events of one turn: those after its `turn/start` and before its
 * `turn/end`, skipping the `turn/end` of any other turn in between.
 * @param events - the session's events in log order.
 * @param turn - the turn number.
 * @returns the turn's events in log order.
 */
function* turnEvents(events: readonly SessionEvent[], turn: number): Generator<SessionEvent> {
  let inTurn = false
  for (const event of events) {
    if (event.type === 'turn/start') {
      inTurn = event.data.turn === turn
      continue
    }
    if (!inTurn) continue
    if (event.type === 'turn/end') {
      if (event.data.turn === turn) return
      continue
    }
    yield event
  }
}

/**
 * Render the events of one turn into a compact transcript and count its tool calls.
 * @param events - the session's events in log order.
 * @param turn - the turn number to render.
 * @param maxBytes - UTF-8 byte cap on the rendered text; later lines are dropped.
 * @returns the transcript and its tool-call count.
 */
export function collectTurnTranscript(events: readonly SessionEvent[], turn: number, maxBytes: number): TurnTranscript {
  const lines: string[] = []
  let toolCalls = 0
  for (const event of turnEvents(events, turn)) {
    switch (event.type) {
      case 'user/message':
        lines.push(`${event.data.source.kind === 'user' ? 'user' : 'context'}: ${truncate(blocksText(event.data.content), LINE_CAP)}`)
        break
      case 'assistant/message':
        lines.push(`assistant: ${truncate(blocksText(event.data.message.content), LINE_CAP)}`)
        break
      case 'tool/call':
        toolCalls += 1
        lines.push(`tool ${event.data.name}: ${truncate(event.data.arguments, LINE_CAP)}`)
        break
      case 'tool/result':
        lines.push(`result${event.data.error === undefined ? '' : ` (${event.data.error.code})`}: ${truncate(blocksText(event.data.message.content), LINE_CAP)}`)
        break
      default:
        break
    }
  }
  const kept: string[] = []
  let bytes = 0
  for (const line of lines) {
    const size = Buffer.byteLength(line) + 1
    if (bytes + size > maxBytes) break
    bytes += size
    kept.push(line)
  }
  return { toolCalls, text: kept.join('\n') }
}

/** The durable items `/digest` keeps from a document, the same four kinds every import extracts. */
const DIGEST_ITEMS = 'facts (names, paths, URLs, versions, architecture), procedures (commands and steps that work), conventions (rules the project follows), and explicit preferences'

/** The JSON shape of one kept item. */
const DIGEST_ENTRY_SHAPE = '{"text": string, "kind": "fact" | "shortcut" | "preference", "tags": string[]}'

/**
 * The instruction `/digest` sends with each part of a document too long to
 * read in one request: the part's entries, one line on what it covers, and
 * whether it is mostly steps. The document's skill verdict waits for every part.
 */
export const DIGEST_PART_SYSTEM_PROMPT = [
  'You read one part of a longer document from the user\'s knowledge base. The other parts are read separately, and a later step decides about the whole document.',
  `Keep the durable items in this part that deserve a memory entry on their own: ${DIGEST_ITEMS}. Do not keep prose summaries, task-local state, or anything already obvious from the file name.`,
  'Also write one line on what this part covers, and say whether this part is mostly steps, commands, or a checklist.',
  `Answer with a JSON object only: {"note": string, "procedural": boolean, "entries": [${DIGEST_ENTRY_SHAPE}]}. Use "shortcut" for procedures and "preference" for conventions. Each text is one or two sentences. Use an empty entries array when nothing qualifies.`,
].join('\n')

/**
 * The instruction `/digest` sends once per document: whether it is a skill,
 * the skill written for an assistant when it is, and, when the request holds
 * the whole document, the entries worth keeping.
 */
export const DIGEST_DOCUMENT_SYSTEM_PROMPT = [
  'You read a document from the user\'s knowledge base and decide whether it is a skill: a reusable procedure, playbook, or checklist that a future coding-assistant session would load whole to carry out a task.',
  'Answer skill true only when most of the document is such a procedure. Reference material, background, notes, API documentation, and source code are not skills; answer false for them, and answer false when unsure.',
  'When skill is true, write the skill in Markdown for an assistant that has not read the document: when to use it, what must be in place first, the numbered steps with the exact commands and paths the document gives, and the pitfalls it warns about. Use only what the document says.',
  `When the request holds the whole document, also keep its durable items: ${DIGEST_ITEMS}, each in one or two sentences. Keep none when the request holds notes and an excerpt of a longer document.`,
  `Answer with a JSON object only: {"skill": boolean, "description": string, "body": string, "entries": [${DIGEST_ENTRY_SHAPE}]}. The description is one sentence saying when to use the skill; leave description and body empty when skill is false. Use "shortcut" for procedures and "preference" for conventions.`,
].join('\n')

/** A `/digest` answer for one part of a long document. */
export interface DigestPart {
  /** One line on what the part covers; empty when the model gave none. */
  readonly note: string
  /** Whether the part is mostly steps, commands, or a checklist. */
  readonly procedural: boolean
  /** Entries worth keeping on their own. */
  readonly candidates: LearningCandidate[]
  /** Valid entries the model returned beyond the cap. */
  readonly dropped: number
}

/** A `/digest` answer for a whole document. */
export interface DigestDocument {
  /** The skill the model wrote; present only when it judged the document a skill and wrote a body. */
  readonly draft?: { readonly description: string; readonly body: string }
  /** Entries worth keeping on their own. */
  readonly candidates: LearningCandidate[]
  /** Valid entries the model returned beyond the cap. */
  readonly dropped: number
}

/**
 * The entries of a `/digest` answer, capped, with the count the cap dropped.
 * @param entries - the answer's entries value.
 * @param max - cap on entries kept.
 * @returns the kept candidates and the number dropped.
 */
function cappedEntries(entries: unknown, max: number): { candidates: LearningCandidate[]; dropped: number } {
  const all = parseCandidates(JSON.stringify(Array.isArray(entries) ? entries : []), Number.MAX_SAFE_INTEGER)
  return { candidates: all.slice(0, max), dropped: Math.max(0, all.length - max) }
}

/**
 * The record of a `/digest` answer: a JSON object, or a bare array read as its
 * entries; anything else is empty, since the model ignored the format.
 * @param text - the model's text output.
 * @returns the answer's fields.
 */
function digestRecord(text: string): Record<string, unknown> {
  const parsed = parseJsonAnswer(text)
  if (Array.isArray(parsed)) return { entries: parsed }
  return parsed !== null && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
}

/**
 * Parse a `/digest` part answer.
 * @param text - the model's text output.
 * @param max - cap on entries kept.
 * @returns the note, the steps flag, and the entries.
 */
export function parseDigestPart(text: string, max: number): DigestPart {
  const record = digestRecord(text)
  return {
    note: typeof record.note === 'string' ? record.note.trim() : '',
    procedural: record.procedural === true,
    ...cappedEntries(record.entries, max),
  }
}

/**
 * Parse a `/digest` document answer. A skill verdict without a written body
 * yields no draft: the document is never copied in its place.
 * @param text - the model's text output.
 * @param max - cap on entries kept.
 * @returns the draft, when there is one, and the entries.
 */
export function parseDigestDocument(text: string, max: number): DigestDocument {
  const record = digestRecord(text)
  const body = record.skill === true && typeof record.body === 'string' ? record.body.trim() : ''
  const description = typeof record.description === 'string' ? record.description.trim() : ''
  return { ...body.length === 0 ? {} : { draft: { description, body } }, ...cappedEntries(record.entries, max) }
}

/**
 * Parse the extraction answer: a JSON array, optionally inside a fenced block.
 * Items without non-empty `text` are dropped, unknown kinds become `fact`, and
 * at most `max` items are returned.
 * @param text - the model's text output.
 * @param max - cap on returned candidates.
 * @returns the parsed candidates; empty for invalid or non-array output.
 */
export function parseCandidates(text: string, max: number): LearningCandidate[] {
  const parsed = parseJsonAnswer(text)
  if (!Array.isArray(parsed)) return []
  const candidates: LearningCandidate[] = []
  for (const item of parsed) {
    if (candidates.length >= max) break
    if (item === null || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    if (typeof record.text !== 'string' || record.text.trim().length === 0) continue
    const kind = typeof record.kind === 'string' && KINDS.has(record.kind) ? record.kind as LearningCandidate['kind'] : 'fact'
    const tags = Array.isArray(record.tags) ? record.tags.filter((tag): tag is string => typeof tag === 'string') : []
    candidates.push({ text: record.text.trim(), kind, tags })
  }
  return candidates
}

/** Cap on the error and result text kept per pair. */
const PAIR_TEXT_CAP = 400

/**
 * Fingerprint an error message: the first line, lowercased, with digits,
 * paths, and punctuation removed, hashed to ten hex characters. Equal
 * failures across turns share a fingerprint, so a shortcut filed for one is
 * recognized for the next.
 * @param text - the failed tool result's text.
 * @returns a ten-character hex fingerprint.
 */
export function errorFingerprint(text: string): string {
  const firstLine = text.split('\n').find(line => line.trim().length > 0) ?? ''
  const normalized = firstLine
    .toLowerCase()
    .replaceAll(/(?:\/[^\s/]+)+\/?/gu, ' ')
    .replaceAll(/\d+/gu, ' ')
    .replaceAll(/[^a-z\s]+/gu, ' ')
    .replaceAll(/\s+/gu, ' ')
    .trim()
  return createHash('sha1').update(normalized).digest('hex').slice(0, 10)
}

/**
 * Find failure-then-recovery pairs in one turn: a `tool/result` marked as an
 * error, followed later in the same turn by a successful result of the same
 * tool. Each failure pairs with the first later unused success at most once.
 * @param events - the session's events in log order.
 * @param turn - the turn to scan.
 * @param max - cap on returned pairs.
 * @returns the pairs in failure order.
 */
export function collectErrorPairs(events: readonly SessionEvent[], turn: number, max: number): ErrorPair[] {
  interface Outcome { readonly tool: string; readonly arguments: string; readonly text: string; readonly failed: boolean }
  const calls = new Map<string, { name: string; arguments: string }>()
  const outcomes: Outcome[] = []
  for (const event of turnEvents(events, turn)) {
    if (event.type === 'tool/call') {
      calls.set(String(event.data.callId), { name: event.data.name, arguments: event.data.arguments })
      continue
    }
    if (event.type !== 'tool/result') continue
    for (const block of event.data.message.content) {
      const call = calls.get(String(block.toolCallId))
      if (call === undefined) continue
      outcomes.push({
        tool: call.name,
        arguments: call.arguments,
        text: blocksText(block.content),
        failed: event.data.error !== undefined || block.isError === true,
      })
    }
  }
  const pairs: ErrorPair[] = []
  const used = new Set<number>()
  for (const [index, failure] of outcomes.entries()) {
    if (pairs.length >= max) break
    if (!failure.failed) continue
    const recoveryIndex = outcomes.findIndex((candidate, position) =>
      position > index && !used.has(position) && !candidate.failed && candidate.tool === failure.tool)
    if (recoveryIndex === -1) continue
    const recovery = outcomes[recoveryIndex]
    if (recovery === undefined) continue
    used.add(recoveryIndex)
    pairs.push({
      tool: failure.tool,
      failedArguments: failure.arguments,
      error: truncate(failure.text, PAIR_TEXT_CAP),
      recoveredArguments: recovery.arguments,
      recoveredResult: truncate(recovery.text, PAIR_TEXT_CAP),
    })
  }
  return pairs
}

/**
 * Render failure-then-recovery pairs for the error-pattern request.
 * @param pairs - the pairs to render.
 * @returns one numbered block per pair.
 */
export function renderErrorPairs(pairs: readonly ErrorPair[]): string {
  return pairs.map((pair, index) => [
    `Pair ${index + 1} (tool ${pair.tool}):`,
    `  failed call: ${truncate(pair.failedArguments, LINE_CAP)}`,
    `  error: ${pair.error}`,
    `  working call: ${truncate(pair.recoveredArguments, LINE_CAP)}`,
    `  result: ${pair.recoveredResult}`,
  ].join('\n')).join('\n')
}
